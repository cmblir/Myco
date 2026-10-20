//! Native-issued update custody, not restored role, review or completion grants.
//! App-data is trusted against application paths, not malicious same-UID rollback.

use super::{NativeCompilation, NativeSectionAuthority, PreservedPriorImage, SectionOwnership};
use crate::importers::wikify::source_revision;
use crate::session_compile::{SessionCompileContext, SourceBinding};
use crate::vault::{CompilerPinDirectory, CompilerPriorFilePin, RecordedWriteReceipt};
use serde::{Deserialize, Serialize};
use std::fs::{File, Metadata, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

#[path = "compiled_custody_retirement.rs"]
mod retirement;
pub(in crate::session_compile) use retirement::RetirementDiagnostic;
use retirement::{RetirementDescriptor, RetirementReason, RetirementState};
#[cfg(test)]
pub(super) use retirement::{ACTION_BUDGET, AFTER_HEAD_PERSIST, AFTER_UNLINK};

pub(super) struct PublishedCustody {
    pub(super) receipt: RecordedWriteReceipt,
    pub(super) retirement: RetirementDiagnostic,
}

static STORE_LOCK: Mutex<()> = Mutex::new(());
#[cfg(test)]
#[allow(clippy::type_complexity)]
pub(super) static AFTER_ANCHORED_WRITE: Mutex<
    Option<Box<dyn FnOnce(&Path) -> Result<(), String> + Send>>,
> = Mutex::new(None);

const MAX_RECORD_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Scope {
    vault: String,
    device: u64,
    inode: u64,
    session_key: String,
    path: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Head {
    version: u8,
    generation: String,
    record_sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    retirement_step: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    retirement_state: Option<RetirementState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    retirement_reason: Option<RetirementReason>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IssuedIdentity {
    device: u64,
    inode: u64,
    changed_seconds: i64,
    changed_nanoseconds: i64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    version: u8,
    scope: Scope,
    generation: String,
    predecessor: Option<String>,
    source: SourceBinding,
    artifact_revision: String,
    anchor_leaf: String,
    baseline_sha256: String,
    issued_identity: IssuedIdentity,
    ownership: SectionOwnership,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    retirement: Option<RetirementDescriptor>,
}

/// Reopened old data grants only the right to replace this exact owned section.
/// It is never converted to NativeSectionAuthority or RecordedWriteReceipt.
pub(super) struct PriorSectionUpdatePermit {
    pub(super) ownership: SectionOwnership,
    pub(super) pin: CompilerPriorFilePin,
}

pub(super) struct Store {
    _lock: MutexGuard<'static, ()>,
    directory: CompilerPinDirectory,
    scope: Scope,
    source: SourceBinding,
    key: String,
    head_sha256: Option<String>,
    record_sha256: Option<String>,
    active: Option<Record>,
    head: Option<Head>,
}

fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn generation(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(unix)]
fn object(metadata: &Metadata) -> (u64, u64) {
    use std::os::unix::fs::MetadataExt;
    (metadata.dev(), metadata.ino())
}
#[cfg(not(unix))]
fn object(_metadata: &Metadata) -> (u64, u64) {
    (0, 0)
}

fn private_record(metadata: &Metadata) -> Result<(), String> {
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_RECORD_BYTES
    {
        return Err("compiler custody record is not a bounded regular file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o777 != 0o600
            || metadata.nlink() != 1
        {
            return Err("compiler custody record ownership, mode or link count is unsafe".into());
        }
    }
    Ok(())
}

fn same_snapshot(left: &Metadata, right: &Metadata) -> bool {
    object(left) == object(right)
        && left.len() == right.len()
        && left.modified().ok() == right.modified().ok()
        && {
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                left.ctime() == right.ctime() && left.ctime_nsec() == right.ctime_nsec()
            }
            #[cfg(not(unix))]
            {
                true
            }
        }
}

fn validate_read_file(metadata: &Metadata, private: bool) -> Result<(), String> {
    if private {
        return private_record(metadata);
    }
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_RECORD_BYTES
    {
        return Err("compiler initial page is not a bounded regular file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() != 1 {
            return Err("compiler initial page has unexpected links".into());
        }
    }
    Ok(())
}

// Bounded physical read only: initial_content still rejects any existing native
// marker, and no section permit is issued by reading a human page.
pub(super) fn read_initial(path: &Path) -> Result<Option<String>, String> {
    read_file(path, false)
}

fn read_file(path: &Path, private: bool) -> Result<Option<String>, String> {
    let named = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("inspect compiler custody record: {error}")),
    };
    validate_read_file(&named, private)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options
        .open(path)
        .map_err(|error| format!("open compiler custody record: {error}"))?;
    let before = file.metadata().map_err(|error| error.to_string())?;
    validate_read_file(&before, private)?;
    if !same_snapshot(&named, &before) {
        return Err("compiler custody record changed while opening".into());
    }
    let mut text = String::new();
    (&file)
        .take(MAX_RECORD_BYTES + 1)
        .read_to_string(&mut text)
        .map_err(|error| format!("read compiler custody record: {error}"))?;
    let after = file.metadata().map_err(|error| error.to_string())?;
    let current = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    validate_read_file(&after, private)?;
    validate_read_file(&current, private)?;
    if text.len() as u64 > MAX_RECORD_BYTES
        || text.contains('\0')
        || !same_snapshot(&before, &after)
        || !same_snapshot(&after, &current)
    {
        return Err("compiler custody record changed while reading".into());
    }
    Ok(Some(text))
}

fn read_record(directory: &CompilerPinDirectory, leaf: &str) -> Result<Option<String>, String> {
    directory.verify()?;
    let text = read_file(&directory.path().join(leaf), true)?;
    directory.verify()?;
    Ok(text)
}

fn create_record(directory: &CompilerPinDirectory, leaf: &str, text: &str) -> Result<(), String> {
    if text.len() as u64 > MAX_RECORD_BYTES || text.contains('\0') {
        return Err("compiler custody record exceeds its bound".into());
    }
    directory.verify()?;
    let path = directory.path().join(leaf);
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(&path)
        .map_err(|error| format!("create immutable compiler custody record: {error}"))?;
    file.write_all(text.as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(|error| format!("retain compiler custody record: {error}"))?;
    directory.sync()?;
    if read_record(directory, leaf)?.as_deref() != Some(text) {
        return Err("compiler custody record readback differs".into());
    }
    Ok(())
}

impl Store {
    pub(super) fn open(root: &Path, context: &SessionCompileContext) -> Result<Self, String> {
        #[cfg(not(unix))]
        return Err(
            "durable compiler custody is unsupported on this platform; preserve source and draft"
                .into(),
        );
        let lock = STORE_LOCK
            .lock()
            .map_err(|_| "compiler custody store lock poisoned")?;
        let vault = root.canonicalize().map_err(|error| error.to_string())?;
        let root_metadata = std::fs::symlink_metadata(&vault).map_err(|error| error.to_string())?;
        let (device, inode) = object(&root_metadata);
        let scope = Scope {
            vault: vault
                .to_str()
                .ok_or("compiler vault path is not UTF-8")?
                .into(),
            device,
            inode,
            session_key: context.source.key.clone(),
            path: context.summary_path.clone(),
        };
        let base = crate::settings::settings_dir()?
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let path = base.join("session-compile-custody");
        if path.starts_with(&vault) {
            return Err("compiler custody app-data cannot be inside the vault".into());
        }
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        match builder.create(&path) {
            Ok(()) => {
                File::open(&base)
                    .and_then(|file| file.sync_all())
                    .map_err(|error| format!("sync compiler custody parent: {error}"))?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(error) => return Err(format!("create compiler custody directory: {error}")),
        }
        let directory = crate::vault::open_compiler_pin_directory(&path)?;
        let key =
            source_revision(&serde_json::to_string(&scope).map_err(|error| error.to_string())?);
        let head_text = read_record(&directory, &format!("{key}.head.json"))?;
        let mut active_record_sha256 = None;
        let mut active_head = None;
        let active = match &head_text {
            Some(text) => {
                let head: Head = serde_json::from_str(text)
                    .map_err(|error| format!("decode compiler custody head: {error}"))?;
                retirement::validate_head(&head)?;
                let record_text = read_record(
                    &directory,
                    &format!("{key}.{}.record.json", head.generation),
                )?
                .ok_or("compiler custody head record is missing")?;
                if source_revision(&record_text) != head.record_sha256 {
                    return Err("compiler custody head record digest changed".into());
                }
                let record: Record = serde_json::from_str(&record_text)
                    .map_err(|error| format!("decode compiler custody record: {error}"))?;
                if !matches!(record.version, 1 | 2)
                    || record.scope != scope
                    || record.generation != head.generation
                    || record.anchor_leaf != format!("{key}.{}.anchor", head.generation)
                    || record.source.key != context.source.key
                    || !hash(&record.source.source_revision)
                    || !hash(&record.artifact_revision)
                    || !hash(&record.baseline_sha256)
                    || record
                        .predecessor
                        .as_ref()
                        .is_some_and(|value| !hash(value))
                    || record.ownership.session_key != context.source.key
                    || record.ownership.path != context.summary_path
                    || record.issued_identity.changed_nanoseconds < 0
                    || record.issued_identity.changed_nanoseconds >= 1_000_000_000
                {
                    return Err("compiler custody scope or issuance binding is invalid".into());
                }
                retirement::validate_descriptor(&record, &head, &key)?;
                crate::session_compile::checked_source(root, &record.source)?;
                let baseline = read_record(
                    &directory,
                    &format!("{key}.{}.baseline.txt", head.generation),
                )?
                .ok_or("compiler custody baseline is missing")?;
                if source_revision(&baseline) != record.baseline_sha256 {
                    return Err("compiler custody baseline digest changed".into());
                }
                validate_baseline(&baseline, &record)?;
                let anchor = std::fs::symlink_metadata(directory.path().join(&record.anchor_leaf))
                    .map_err(|error| format!("inspect compiler custody anchor: {error}"))?;
                if object(&anchor) != (record.issued_identity.device, record.issued_identity.inode)
                {
                    return Err("compiler custody anchor differs from issued object".into());
                }
                active_record_sha256 = Some(head.record_sha256.clone());
                active_head = Some(head);
                Some(record)
            }
            None => {
                for entry in
                    std::fs::read_dir(directory.path()).map_err(|error| error.to_string())?
                {
                    let entry = entry.map_err(|error| error.to_string())?;
                    if entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with(&format!("{key}."))
                    {
                        return Err(
                            "compiler custody history has no current head; preserve artifacts"
                                .into(),
                        );
                    }
                }
                None
            }
        };
        Ok(Self {
            _lock: lock,
            directory,
            scope,
            source: context.source.clone(),
            key,
            head_sha256: head_text.as_deref().map(source_revision),
            record_sha256: active_record_sha256,
            active,
            head: active_head,
        })
    }

    pub(super) fn prior_locked(
        &self,
        _guard: &MutexGuard<'_, ()>,
        previous: Option<&NativeSectionAuthority>,
    ) -> Result<Option<PriorSectionUpdatePermit>, String> {
        match (&self.active, previous) {
            (Some(record), previous) => {
                if let Some(previous) = previous {
                    if previous.ownership != record.ownership
                        || previous.receipt.compiler_anchor_leaf()
                            != Some(record.anchor_leaf.as_str())
                    {
                        return Err(
                            "live compiler section disagrees with current custody head".into()
                        );
                    }
                }
                let canonical = Path::new(&self.scope.vault).join(&self.scope.path);
                let pin = crate::vault::reopen_compiler_prior_file_pin(
                    &canonical,
                    &self.directory,
                    &record.anchor_leaf,
                )?;
                Ok(Some(PriorSectionUpdatePermit {
                    ownership: record.ownership.clone(),
                    pin,
                }))
            }
            (None, Some(previous)) => {
                if previous.session_key != self.scope.session_key
                    || previous.path != self.scope.path
                {
                    return Err("live compiler section belongs to a different scope".into());
                }
                Ok(Some(PriorSectionUpdatePermit {
                    ownership: previous.ownership.clone(),
                    pin: crate::vault::compiler_prior_from_receipt(&previous.receipt)?,
                }))
            }
            (None, None) => Ok(None),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn publish_locked(
        &mut self,
        guard: &MutexGuard<'_, ()>,
        compilation: &NativeCompilation,
        ownership: &SectionOwnership,
        path: &Path,
        content: &str,
        prior: Option<&CompilerPriorFilePin>,
        expected: Option<&str>,
        preservation: Option<&PreservedPriorImage>,
    ) -> Result<PublishedCustody, String> {
        if compilation.source_revision() != self.source.source_revision
            || ownership.session_key != self.scope.session_key
            || ownership.path != self.scope.path
            || path != Path::new(&self.scope.vault).join(&self.scope.path)
        {
            return Err("compiler custody issuance differs from fresh source or path".into());
        }
        let before = self.maintain_retirement_locked(guard, 3)?;
        if !before.is_complete() {
            return Err(format!(
                "compiler custody retirement blocks new issuance: {}",
                before.message()
            ));
        }
        if let Some(witness) = preservation {
            if expected != Some(witness.consumed_prior_sha256.as_str())
                || source_revision(content) != witness.successor_sha256
            {
                return Err("compiler preservation witness differs from writer-held images".into());
            }
        } else if self.active.is_some() {
            return Err("compiler predecessor lacks native image-preservation witness".into());
        }
        let head_leaf = format!("{}.head.json", self.key);
        if read_record(&self.directory, &head_leaf)?
            .as_deref()
            .map(source_revision)
            != self.head_sha256
        {
            return Err("compiler custody head changed before publication".into());
        }
        let nonce = crate::session_compile::nonce()?;
        let anchor_leaf = format!("{}.{}.anchor", self.key, nonce);
        let receipt = crate::vault::write_compiler_file_anchored_locked(
            guard,
            path.to_str().ok_or("compiler output path is not UTF-8")?,
            content,
            prior,
            expected,
            &self.directory,
            &anchor_leaf,
        )?;
        #[cfg(test)]
        if let Some(hook) = AFTER_ANCHORED_WRITE
            .lock()
            .map_err(|_| "compiler custody test hook poisoned")?
            .take()
        {
            hook(path)?;
        }
        crate::vault::verify_recorded_file_unlocked(&receipt)?;
        let descriptor = retirement::capture_descriptor(guard, self, &receipt, preservation)?;
        let issued_identity: IssuedIdentity = serde_json::from_value(
            serde_json::to_value(&receipt.file_identity).map_err(|error| error.to_string())?,
        )
        .map_err(|error| format!("compiler anchored output lacks native identity: {error}"))?;
        let record = Record {
            version: 2,
            scope: self.scope.clone(),
            generation: nonce.clone(),
            predecessor: self.record_sha256.clone(),
            source: self.source.clone(),
            artifact_revision: compilation.revision()?,
            anchor_leaf,
            baseline_sha256: receipt.revision.clone(),
            issued_identity,
            ownership: ownership.clone(),
            retirement: descriptor,
        };
        create_record(
            &self.directory,
            &format!("{}.{}.baseline.txt", self.key, nonce),
            content,
        )?;
        let text = serde_json::to_string(&record).map_err(|error| error.to_string())?;
        create_record(
            &self.directory,
            &format!("{}.{}.record.json", self.key, nonce),
            &text,
        )?;
        let has_predecessor = record.retirement.is_some();
        let head = Head {
            version: 2,
            generation: nonce,
            record_sha256: source_revision(&text),
            retirement_step: Some(if has_predecessor { 0 } else { 3 }),
            retirement_state: Some(if has_predecessor {
                RetirementState::Pending
            } else {
                RetirementState::Complete
            }),
            retirement_reason: has_predecessor.then_some(RetirementReason::Cutoff),
        };
        self.write_head_locked(guard, &head)?;
        self.record_sha256 = Some(source_revision(&text));
        self.active = Some(record);
        // Only cleanup failures of a still-valid committed image are normal
        // diagnostics. Head/record/receipt acknowledgement failures stay fatal.
        let retirement = self.maintain_retirement_locked(guard, retirement::action_budget())?;
        crate::vault::verify_recorded_file_unlocked(&receipt)?;
        Ok(PublishedCustody {
            receipt,
            retirement,
        })
    }
}

fn validate_baseline(baseline: &str, record: &Record) -> Result<(), String> {
    super::range(baseline, &record.ownership)?;
    let (metadata, _) = super::super::parse(baseline)?;
    if metadata["session_key"].as_str() != Some(record.scope.session_key.as_str()) {
        return Err("compiler custody baseline has a different session".into());
    }
    for (key, value) in &record.ownership.owned_fields {
        if !matches!(
            key.as_str(),
            "session_key"
                | "raw_path"
                | "session_revision"
                | "session_generated_title"
                | "derived_from"
        ) || metadata.get(key) != Some(value)
        {
            return Err("compiler custody owned fields differ from native baseline".into());
        }
    }
    if record.ownership.owned_fields.is_empty() {
        if record.ownership.display_title.is_some() {
            return Err("legacy custody cannot own a human title".into());
        }
    } else {
        if record.ownership.owned_fields.len() != 5
            || metadata["raw_path"].as_str() != Some(record.source.raw_path.as_str())
            || metadata["session_revision"].as_str() != Some(record.source.source_revision.as_str())
            || !metadata["derived_from"].as_array().is_some_and(|paths| {
                paths.iter().all(|path| path.as_str().is_some())
                    && paths.contains(&serde_json::json!(record.source.raw_path))
            })
        {
            return Err("compiler custody native lineage is incomplete".into());
        }
        if let Some(title) = &record.ownership.display_title {
            if metadata["title"].as_str() != Some(title.as_str())
                || metadata["session_generated_title"].as_str() != Some(title.as_str())
                || !baseline[super::frontmatter_end(baseline)?..]
                    .starts_with(&format!("# {}\n", super::markdown(title)))
            {
                return Err("compiler custody generated title differs from native baseline".into());
            }
        }
    }
    let marker = record
        .ownership
        .marker
        .strip_prefix(super::START)
        .and_then(|value| value.strip_suffix(" -->\n"))
        .ok_or("compiler custody marker is malformed")?;
    let marker: super::Marker = serde_json::from_str(marker).map_err(|error| error.to_string())?;
    if marker.session_key != record.scope.session_key
        || marker.source_revision != record.source.source_revision
        || marker.artifact_revision != record.artifact_revision
        || !hash(&marker.compile_signature)
        || !generation(&marker.nonce)
    {
        return Err("compiler custody marker differs from native issuance record".into());
    }
    Ok(())
}
