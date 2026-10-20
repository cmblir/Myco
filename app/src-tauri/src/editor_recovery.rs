//! Private draft checkpoints preserve data, never authority to overwrite a note.

use crate::editor_io::ReadReceipt;
use crate::vault;
use crate::vault_session::{AgentVaultSession, VaultRoot};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{File, Metadata, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

static SNAPSHOTS: OnceLock<Mutex<Vec<Snapshot>>> = OnceLock::new();
static JOURNAL_LOCK: Mutex<()> = Mutex::new(());

#[path = "editor_recovery_retirement.rs"]
mod retirement;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecoveryDraft {
    pub path: String,
    pub baseline_raw: String,
    pub baseline_revision: String,
    pub draft_raw: String,
    pub revision: String,
    pub origin: AgentVaultSession,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VaultIdentity {
    device: u64,
    inode: u64,
}

struct Snapshot {
    path: String,
    raw: String,
    revision: String,
    origin: AgentVaultSession,
    identity: Option<VaultIdentity>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Journal {
    version: u32,
    canonical_vault: String,
    vault_identity: VaultIdentity,
    relative_path: String,
    draft_sha256: String,
    recovery: RecoveryDraft,
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn is_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn same_origin(left: &AgentVaultSession, right: &AgentVaultSession) -> bool {
    left.vault_path == right.vault_path && left.opening_token == right.opening_token
}

#[cfg(unix)]
fn identity(root: &Path) -> Result<VaultIdentity, String> {
    use std::os::unix::fs::MetadataExt;
    let metadata = std::fs::symlink_metadata(root)
        .map_err(|error| format!("inspect recovery vault identity: {error}"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("recovery vault is not a real directory".into());
    }
    Ok(VaultIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}

#[cfg(not(unix))]
fn identity(_root: &Path) -> Result<VaultIdentity, String> {
    Err("durable editor recovery requires supported native vault object identity".into())
}

/// Call only while the native receipt's opening is held; renderer raw is not accepted.
pub(crate) fn register_snapshot(receipt: &ReadReceipt) -> Result<(), String> {
    register_written(
        &receipt.file.path,
        &receipt.file.raw,
        &receipt.revision,
        &receipt.origin,
    )
}

/// Register exact bytes already checked by the native recorded writer, without rereading.
pub(crate) fn register_written(
    path: &str,
    raw: &str,
    revision: &str,
    origin: &AgentVaultSession,
) -> Result<(), String> {
    if !is_hex(revision, 64) || hash(raw.as_bytes()) != revision {
        return Err("recovery snapshot differs from its native receipt".into());
    }
    if !Path::new(path).starts_with(&origin.vault_path) || origin.opening_token.is_empty() {
        return Err("recovery snapshot is outside its native opening".into());
    }
    #[cfg(unix)]
    let captured_identity = Some(identity(Path::new(&origin.vault_path))?);
    #[cfg(not(unix))]
    let captured_identity = None;
    let mut snapshots = SNAPSHOTS
        .get_or_init(|| Mutex::new(Vec::new()))
        .lock()
        .map_err(|_| "editor snapshot lock poisoned")?;
    snapshots.retain(|saved| {
        saved.origin.vault_path != origin.vault_path
            || saved.origin.opening_token == origin.opening_token
    });
    if snapshots.iter().any(|saved| {
        saved.path == path
            && saved.revision == revision
            && same_origin(&saved.origin, origin)
            && saved.identity == captured_identity
    }) {
        return Ok(());
    }
    snapshots.push(Snapshot {
        path: path.to_owned(),
        raw: raw.to_owned(),
        revision: revision.to_owned(),
        origin: origin.clone(),
        identity: captured_identity,
    });
    Ok(())
}

struct PrivateDirectory {
    base_path: PathBuf,
    base: File,
    path: PathBuf,
    held: File,
}

fn inspect_directory(path: &Path, private: bool) -> Result<Metadata, String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("inspect recovery directory: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("recovery directory is not a real directory".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.uid() != unsafe { libc::geteuid() }
            || (private && metadata.mode() & 0o777 != 0o700)
            || (!private && metadata.mode() & 0o022 != 0)
        {
            return Err("recovery directory ownership or permissions are unsafe".into());
        }
    }
    #[cfg(not(unix))]
    let _ = private;
    Ok(metadata)
}

fn same_directory(left: &Metadata, right: &Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        left.dev() == right.dev() && left.ino() == right.ino() && left.uid() == right.uid()
    }
    #[cfg(not(unix))]
    {
        left.is_dir() && right.is_dir()
    }
}

fn open_directory(path: &Path, private: bool) -> Result<File, String> {
    let named = inspect_directory(path, private)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY);
    }
    let held = options
        .open(path)
        .map_err(|error| format!("open recovery directory: {error}"))?;
    let actual = held
        .metadata()
        .map_err(|error| format!("inspect held recovery directory: {error}"))?;
    if !same_directory(&named, &actual)
        || !same_directory(&actual, &inspect_directory(path, private)?)
    {
        return Err("recovery directory changed while opening".into());
    }
    Ok(held)
}

impl PrivateDirectory {
    fn open() -> Result<Self, String> {
        let base_path = crate::settings::settings_dir()?;
        let base = open_directory(&base_path, false)?;
        let path = base_path.join("editor-recovery");
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        match builder.create(&path) {
            Ok(()) => {
                base.sync_all().map_err(|error| {
                    format!("recovery directory created but parent sync failed: {error}")
                })?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(format!("create recovery directory: {error}")),
        }
        let held = open_directory(&path, true)?;
        let directory = Self {
            base_path,
            base,
            path,
            held,
        };
        directory.check()?;
        Ok(directory)
    }

    fn check(&self) -> Result<(), String> {
        for (path, held, private) in [
            (&self.base_path, &self.base, false),
            (&self.path, &self.held, true),
        ] {
            let metadata = held
                .metadata()
                .map_err(|error| format!("inspect held recovery directory: {error}"))?;
            if !same_directory(&metadata, &inspect_directory(path, private)?) {
                return Err("recovery directory identity changed".into());
            }
        }
        Ok(())
    }

    fn sync(&self) -> Result<(), String> {
        self.check()?;
        self.held.sync_all().map_err(|error| {
            format!("recovery journal persisted but parent sync failed: {error}")
        })?;
        self.check()
    }
}

struct Scope {
    root: String,
    object: VaultIdentity,
    path: String,
    relative: String,
}

impl Scope {
    fn capture(canonical_root: &Path, requested_root: &Path, path: &str) -> Result<Self, String> {
        let confined = vault::confine_mutation_path(canonical_root, requested_root, path)?;
        if vault::is_raw_path(canonical_root, &confined) {
            return Err("refused: raw/ is immutable — editor recovery is for derived notes".into());
        }
        if confined == canonical_root {
            return Err("refused: editor recovery is only for derived note paths".into());
        }
        match std::fs::symlink_metadata(&confined) {
            Ok(metadata) if !metadata.is_file() => {
                return Err("editor recovery target is not a regular note".into())
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("inspect recovery note path: {error}")),
        }
        let relative = confined
            .strip_prefix(canonical_root)
            .map_err(|_| "recovery path is outside its vault")?
            .to_str()
            .ok_or("recovery relative path is not UTF-8")?
            .to_owned();
        Ok(Self {
            root: canonical_root
                .to_str()
                .ok_or("recovery vault path is not UTF-8")?
                .to_owned(),
            object: identity(canonical_root)?,
            path: confined
                .to_str()
                .ok_or("recovery note path is not UTF-8")?
                .to_owned(),
            relative,
        })
    }

    fn journal_path(&self, directory: &PrivateDirectory) -> Result<PathBuf, String> {
        let key = serde_json::to_vec(&(&self.root, &self.object, &self.relative))
            .map_err(|error| format!("encode recovery key: {error}"))?;
        Ok(directory.path.join(format!("{}.json", hash(&key))))
    }

    fn validate(&self, journal: &Journal) -> Result<(), String> {
        let saved = &journal.recovery;
        if journal.version != 1
            || journal.canonical_vault != self.root
            || journal.vault_identity != self.object
            || journal.relative_path != self.relative
            || saved.path != self.path
            || saved.origin.vault_path != self.root
            || saved.origin.opening_token.is_empty()
            || !is_hex(&saved.revision, 32)
            || !is_hex(&saved.baseline_revision, 64)
            || hash(saved.baseline_raw.as_bytes()) != saved.baseline_revision
            || hash(saved.draft_raw.as_bytes()) != journal.draft_sha256
        {
            return Err("recovery journal identity, version or raw hashes are invalid".into());
        }
        Ok(())
    }
}

fn read_journal(
    directory: &PrivateDirectory,
    path: &Path,
    scope: &Scope,
) -> Result<Option<(Journal, String)>, String> {
    let captured = capture_journal(directory, path)?;
    if let Some((journal, _)) = &captured {
        scope.validate(journal)?;
    }
    Ok(captured)
}

fn capture_journal(
    directory: &PrivateDirectory,
    path: &Path,
) -> Result<Option<(Journal, String)>, String> {
    let Some(bytes) = capture_bytes(directory, path)? else {
        return Ok(None);
    };
    let digest = hash(&bytes);
    let journal: Journal = serde_json::from_slice(&bytes)
        .map_err(|error| format!("parse recovery journal: {error}"))?;
    Ok(Some((journal, digest)))
}

fn capture_bytes(directory: &PrivateDirectory, path: &Path) -> Result<Option<Vec<u8>>, String> {
    directory.check()?;
    let snapshot = crate::index_publication::read_snapshot(path)?;
    directory.check()?;
    let Some(snapshot) = snapshot else {
        return Ok(None);
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = std::fs::symlink_metadata(path)
            .map_err(|error| format!("inspect recovery journal: {error}"))?;
        if metadata.uid() != unsafe { libc::geteuid() }
            || metadata.nlink() != 1
            || metadata.mode() & 0o777 != 0o600
        {
            return Err("recovery journal ownership or permissions are unsafe".into());
        }
    }
    Ok(Some(snapshot.bytes))
}

/// Caller holds the current opening through this check and its subsequent mutation.
/// Locks protect one cooperating app process, not simultaneous independent instances.
#[cfg(unix)]
pub(crate) fn assert_no_pending_at(root: &Path, from: &str) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    vault::with_root_mutation(root, |canonical, _| {
        let source = vault::confine_mutation_path(canonical, root, from)?;
        if vault::is_raw_mutation_source(canonical, &source) {
            return Err("refused: raw/ is immutable — sources cannot be changed".into());
        }
        let object = identity(canonical)?;
        let _journal_guard = JOURNAL_LOCK
            .lock()
            .map_err(|_| "editor recovery journal lock poisoned")?;
        let directory = PrivateDirectory::open()?;
        let mut validated_primary = std::collections::HashSet::new();
        for entry in std::fs::read_dir(&directory.path)
            .map_err(|error| format!("list recovery journals: {error}"))?
        {
            let path = entry
                .map_err(|error| format!("inspect recovery entry: {error}"))?
                .path();
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or("recovery journal name is not UTF-8")?;
            if name.starts_with(".myco-tmp-") && name.ends_with(".md") {
                // An interrupted atomic writer may leave an unacknowledged temporary.
                let metadata = std::fs::symlink_metadata(&path)
                    .map_err(|error| format!("inspect recovery temporary: {error}"))?;
                if !metadata.is_file()
                    || metadata.file_type().is_symlink()
                    || metadata.uid() != unsafe { libc::geteuid() }
                    || metadata.nlink() != 1
                    || metadata.mode() & 0o777 != 0o600
                {
                    return Err(
                        "recovery temporary ownership, type or permissions are unsafe".into(),
                    );
                }
                continue;
            }
            let primary = retirement::primary_for_entry(&directory, &path)?;
            let scope = retirement::scope_for_entry(&directory, &path)?;
            if validated_primary.contains(&primary) {
                continue;
            }
            // Validate each group once, including completion/backup pairs from other vaults.
            if Path::new(&scope.root) == canonical
                && scope.object == object
                && Path::new(&scope.path).starts_with(&source)
            {
                retirement::assert_path_change_clear(&directory, &primary, &scope)?;
            } else {
                retirement::load(&directory, &primary, &scope)?;
            }
            validated_primary.insert(primary);
        }
        directory.check()?;
        if identity(canonical)? != object {
            return Err("recovery vault identity changed during mutation guard".into());
        }
        Ok(())
    })
}

#[cfg(not(unix))]
pub(crate) fn assert_no_pending_at(_root: &Path, _from: &str) -> Result<(), String> {
    // Durable recovery is unavailable on this platform; ordinary mutations remain available.
    Ok(())
}

fn with_journal<T>(
    state: &VaultRoot,
    path: &str,
    origin: &AgentVaultSession,
    operation: impl FnOnce(
        &Scope,
        &PrivateDirectory,
        &Path,
        &std::sync::MutexGuard<'_, ()>,
    ) -> Result<T, String>,
) -> Result<T, String> {
    state.with_origin(origin, |root| {
        vault::with_root_mutation(root, |canonical, guard| {
            let scope = Scope::capture(canonical, root, path)?;
            let _journal_guard = JOURNAL_LOCK
                .lock()
                .map_err(|_| "editor recovery journal lock poisoned")?;
            let directory = PrivateDirectory::open()?;
            let target = scope.journal_path(&directory)?;
            let result = operation(&scope, &directory, &target, guard);
            let boundary = directory.check().and_then(|()| {
                if identity(canonical)? != scope.object {
                    return Err("recovery vault identity changed during checkpoint".into());
                }
                Ok(())
            });
            match (result, boundary) {
                (Ok(value), Ok(())) => Ok(value),
                (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
                (Err(error), Err(boundary)) => Err(format!(
                    "{error}; recovery boundary check also failed: {boundary}"
                )),
            }
        })
    })
}

/// Checkpoint exact registered A plus D; journal revision CAS never authorizes a note save.
pub(crate) fn stage(
    state: &VaultRoot,
    path: &str,
    expected_sha: &str,
    draft: &str,
    origin: &AgentVaultSession,
    expected_journal_revision: Option<&str>,
) -> Result<RecoveryDraft, String> {
    with_journal(state, path, origin, |scope, directory, target, guard| {
        retirement::assert_stage_clear(directory, target, scope)?;
        let previous = read_journal(directory, target, scope)?;
        if previous
            .as_ref()
            .map(|(saved, _)| saved.recovery.revision.as_str())
            != expected_journal_revision
        {
            return Err("recovery conflict: journal changed since it was acknowledged".into());
        }
        if previous.as_ref().is_some_and(|(saved, _)| {
            saved.recovery.baseline_revision != expected_sha
                || !same_origin(&saved.recovery.origin, origin)
        }) {
            return Err("recovery conflict: pending baseline or opening differs".into());
        }
        let snapshots = SNAPSHOTS
            .get_or_init(|| Mutex::new(Vec::new()))
            .lock()
            .map_err(|_| "editor snapshot lock poisoned")?;
        let snapshot = snapshots
            .iter()
            .find(|saved| {
                saved.path == scope.path
                    && saved.revision == expected_sha
                    && same_origin(&saved.origin, origin)
                    && saved.identity.as_ref() == Some(&scope.object)
            })
            .ok_or("recovery baseline has no registered native read or accepted write")?;
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce)
            .map_err(|error| format!("recovery revision entropy failed: {error}"))?;
        let recovery = RecoveryDraft {
            path: scope.path.clone(),
            baseline_raw: snapshot.raw.clone(),
            baseline_revision: snapshot.revision.clone(),
            draft_raw: draft.to_owned(),
            revision: nonce.iter().map(|byte| format!("{byte:02x}")).collect(),
            origin: origin.clone(),
        };
        drop(snapshots);
        let journal = Journal {
            version: 1,
            canonical_vault: scope.root.clone(),
            vault_identity: scope.object.clone(),
            relative_path: scope.relative.clone(),
            draft_sha256: hash(draft.as_bytes()),
            recovery: recovery.clone(),
        };
        let raw = serde_json::to_string(&journal)
            .map_err(|error| format!("encode recovery journal: {error}"))?;
        directory.check()?;
        vault::write_file_if_unchanged_recorded_locked(
            guard,
            &target.to_string_lossy(),
            &raw,
            previous.as_ref().map(|(_, revision)| revision.as_str()),
        )?;
        directory.sync()?;
        let actual = read_journal(directory, target, scope)?
            .ok_or("recovery journal disappeared after checkpoint")?;
        if actual.1 != hash(raw.as_bytes()) {
            return Err("recovery journal changed after checkpoint".into());
        }
        Ok(recovery)
    })
}

/// Restore data under a current opening while retaining its original, expired provenance.
pub(crate) fn load(
    state: &VaultRoot,
    path: &str,
    origin: &AgentVaultSession,
) -> Result<Option<RecoveryDraft>, String> {
    with_journal(state, path, origin, |scope, directory, target, _| {
        Ok(retirement::load(directory, target, scope)?.map(|(journal, _)| journal.recovery))
    })
}

/// Retire only the acknowledged journal; never remove or rewrite the note itself.
pub(crate) fn retire(
    state: &VaultRoot,
    path: &str,
    origin: &AgentVaultSession,
    expected_journal_revision: &str,
) -> Result<(), String> {
    retire_impl(
        state,
        path,
        origin,
        expected_journal_revision,
        #[cfg(test)]
        |_| Ok(()),
    )
}

fn retire_impl(
    state: &VaultRoot,
    path: &str,
    origin: &AgentVaultSession,
    expected_journal_revision: &str,
    #[cfg(test)] after_unlink: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<(), String> {
    retire_with_cleanup_impl(
        state,
        path,
        origin,
        expected_journal_revision,
        #[cfg(test)]
        after_unlink,
        #[cfg(test)]
        |pending| {
            std::fs::remove_file(pending)
                .map_err(|error| format!("remove retired pending copy: {error}"))
        },
    )
}

fn retire_with_cleanup_impl(
    state: &VaultRoot,
    path: &str,
    origin: &AgentVaultSession,
    expected_journal_revision: &str,
    #[cfg(test)] after_unlink: impl FnOnce(&Path) -> Result<(), String>,
    #[cfg(test)] pending_cleanup: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<(), String> {
    let mut committed = false;
    let result = with_journal(state, path, origin, |scope, directory, target, guard| {
        if retirement::acknowledge_committed(
            directory,
            target,
            scope,
            expected_journal_revision,
            guard,
        )? {
            committed = true;
            return Ok(());
        }
        let prepared =
            retirement::prepare(directory, target, scope, guard, expected_journal_revision)?;
        if prepared.has_primary {
            std::fs::remove_file(target)
                .map_err(|error| format!("retire recovery journal: {error}"))?;
            #[cfg(test)]
            after_unlink(target)?;
        }
        directory.sync()?;
        retirement::commit(
            directory,
            target,
            scope,
            guard,
            &prepared,
            &mut committed,
            #[cfg(test)]
            pending_cleanup,
        )
    });
    result.map_err(|error| {
        if committed && !error.starts_with("retirement committed") {
            format!("retirement committed but confirmation failed: {error}")
        } else {
            error
        }
    })
}

#[cfg(test)]
#[path = "editor_recovery_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "editor_recovery_retirement_tests.rs"]
mod retirement_tests;

#[cfg(test)]
#[path = "editor_recovery_compaction_tests.rs"]
mod compaction_tests;
