//! Native-issued exact inbox reads. Public text, hashes and terminal UI states
//! cannot create processing or archive-completion authority.

use crate::role_authorization::RoleUsage;
use crate::session_compile::SessionCompileContext;
use crate::vault_session::{AgentVaultSession, VaultRoot};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

const MAX_SOURCE_BYTES: usize = 128 * 1024 * 1024;
const MAX_RETAINED_BYTES: usize = 256 * 1024 * 1024;
const MAX_SNAPSHOTS: usize = 8;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Snapshot {
    pub snapshot_id: String,
    pub origin: AgentVaultSession,
    pub inbox_rel: String,
    pub source_revision: String,
    pub text: String,
}

struct Grant {
    origin: AgentVaultSession,
    inbox_rel: String,
    revision: String,
    original: Arc<String>,
    file: std::fs::File,
}

fn grants() -> &'static Mutex<BTreeMap<String, Grant>> {
    static GRANTS: OnceLock<Mutex<BTreeMap<String, Grant>>> = OnceLock::new();
    GRANTS.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn same_origin(left: &AgentVaultSession, right: &AgentVaultSession) -> bool {
    left.vault_path == right.vault_path && left.opening_token == right.opening_token
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn checked_revision(revision: &str) -> Result<(), String> {
    if revision.len() == 64
        && revision
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err("invalid inbox source revision".into())
    }
}

fn path(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let name = rel
        .strip_prefix("_inbox/")
        .ok_or("source is outside the inbox")?;
    if name.is_empty()
        || name.starts_with('.')
        || name.contains(['/', '\\'])
        || name.chars().any(char::is_control)
        || !name.to_ascii_lowercase().ends_with(".md")
    {
        return Err(
            "source requires a direct markdown inbox file; other formats remain pending".into(),
        );
    }
    crate::vault::confine_delete_path(root, &root.join(rel).to_string_lossy())
}

fn verify_identity(file: &std::fs::File, named: &Path) -> Result<(), String> {
    let held = file
        .metadata()
        .map_err(|error| format!("inspect held inbox source: {error}"))?;
    let current = std::fs::symlink_metadata(named)
        .map_err(|error| format!("inspect inbox source: {error}"))?;
    if !held.is_file() || !current.file_type().is_file() {
        return Err("inbox source is not the retained regular file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if held.dev() != current.dev()
            || held.ino() != current.ino()
            || held.nlink() != 1
            || current.nlink() != 1
        {
            return Err("inbox source identity changed or has unowned hard links".into());
        }
    }
    #[cfg(not(unix))]
    return Err("native inbox source identity is unsupported on this platform".into());
    #[cfg(unix)]
    Ok(())
}

fn read_bounded(file: &std::fs::File) -> Result<String, String> {
    if file
        .metadata()
        .map_err(|error| format!("inspect inbox length: {error}"))?
        .len()
        > MAX_SOURCE_BYTES as u64
    {
        return Err(
            "inbox source exceeds the bounded compiler input; source remains pending".into(),
        );
    }
    let mut bytes = Vec::new();
    file.take(MAX_SOURCE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("read inbox source: {error}"))?;
    if bytes.len() > MAX_SOURCE_BYTES {
        return Err("inbox source grew beyond the compiler input; source remains pending".into());
    }
    String::from_utf8(bytes).map_err(|error| format!("inbox source is not UTF-8: {error}"))
}

fn authenticate(snapshot: &Snapshot, grant: &Grant) -> Result<(), String> {
    if !same_origin(&snapshot.origin, &grant.origin)
        || snapshot.inbox_rel != grant.inbox_rel
        || snapshot.source_revision != grant.revision
        || snapshot.text.as_str() != grant.original.as_str()
    {
        return Err("inbox snapshot differs from its native issued source".into());
    }
    Ok(())
}

fn verify_source(root: &Path, grant: &Grant) -> Result<(), String> {
    let named = path(root, &grant.inbox_rel)?;
    verify_identity(&grant.file, &named)?;
    let fresh =
        std::fs::File::open(&named).map_err(|error| format!("reread inbox source: {error}"))?;
    let actual = read_bounded(&fresh)?;
    verify_identity(&grant.file, &named)?;
    if digest(actual.as_bytes()) != grant.revision {
        return Err("inbox source revision changed; the source remains pending".into());
    }
    Ok(())
}

pub(crate) fn capture(
    state: &VaultRoot,
    origin: &AgentVaultSession,
    rel: &str,
    expected: Option<&str>,
) -> Result<Snapshot, String> {
    if let Some(expected) = expected {
        checked_revision(expected)?;
    }
    state.with_origin(origin, |root| {
        // All paths use opening -> issuer -> writer; capture must not invert
        // the order used by source validation and checked archive.
        let mut registry = grants().lock().map_err(|_| "inbox snapshot issuer lock poisoned")?;
        registry.retain(|_, grant| grant.origin.vault_path != origin.vault_path || same_origin(&grant.origin, origin));
        crate::vault::with_root_mutation(root, |root, _guard| {
        let named = path(root, rel)?;
        let file = std::fs::File::open(&named).map_err(|error| format!("open inbox source: {error}"))?;
        verify_identity(&file, &named)?;
        let original = read_bounded(&file)?;
        verify_identity(&file, &named)?;
        let revision = digest(original.as_bytes());
        if expected.is_some_and(|expected| expected != revision) {
            return Err("inbox copy revision differs from the selected promotion; source remains pending".into());
        }
        let mut entropy = [0u8; 16];
        getrandom::fill(&mut entropy).map_err(|error| format!("inbox snapshot entropy: {error}"))?;
        let snapshot_id: String = entropy.iter().map(|byte| format!("{byte:02x}")).collect();
        let retained: usize = registry.values().map(|grant| grant.original.len()).sum();
        if registry.len() >= MAX_SNAPSHOTS || retained + original.len() > MAX_RETAINED_BYTES {
            return Err("inbox snapshot capacity is occupied; release or finish existing work".into());
        }
        let snapshot = Snapshot { snapshot_id: snapshot_id.clone(), origin: origin.clone(),
            inbox_rel: rel.into(), source_revision: revision.clone(), text: original.clone() };
        registry.insert(snapshot_id, Grant { origin: origin.clone(), inbox_rel: rel.into(),
            revision, original: Arc::new(original), file });
        Ok(snapshot)
        })
    })
}

fn original(state: &VaultRoot, snapshot: &Snapshot) -> Result<Arc<String>, String> {
    state.with_origin(&snapshot.origin, |root| {
        let registry = grants()
            .lock()
            .map_err(|_| "inbox snapshot issuer lock poisoned")?;
        let grant = registry
            .get(&snapshot.snapshot_id)
            .ok_or("native inbox snapshot expired")?;
        authenticate(snapshot, grant)?;
        crate::vault::with_root_mutation(root, |root, _guard| verify_source(root, grant))?;
        Ok(grant.original.clone())
    })
}

pub(crate) fn begin(
    state: &VaultRoot,
    snapshot: &Snapshot,
    usage: RoleUsage,
) -> Result<SessionCompileContext, String> {
    let text = original(state, snapshot)?;
    crate::session_compile::begin_inbox_original(state, &snapshot.origin, &text, usage)
}

pub(crate) fn archive(
    state: &VaultRoot,
    snapshot: &Snapshot,
    context: Option<&SessionCompileContext>,
) -> Result<crate::backfill::InboxArchiveReceipt, String> {
    let text = original(state, snapshot)?;
    let commit = |root: &Path, compiled: Option<&dyn Fn() -> Result<(), String>>| {
        let registry = grants()
            .lock()
            .map_err(|_| "inbox snapshot issuer lock poisoned")?;
        let grant = registry
            .get(&snapshot.snapshot_id)
            .ok_or("native inbox snapshot expired")?;
        authenticate(snapshot, grant)?;
        let sources = if compiled.is_some() {
            crate::backfill::pending_sources_for_inbox(
                root,
                &snapshot.inbox_rel,
                &snapshot.source_revision,
            )?
        } else {
            Vec::new()
        };
        crate::backfill::archive_pending_inbox_at(
            root,
            &snapshot.inbox_rel,
            &snapshot.source_revision,
            &sources,
            || {
                verify_source(root, grant)?;
                if let Some(verify) = compiled {
                    verify()?;
                }
                for rel in &sources {
                    let named = crate::backfill::session_path(root, rel)?;
                    let bytes = std::fs::read(named)
                        .map_err(|error| format!("reread harvested session: {error}"))?;
                    if bytes != text.as_bytes() {
                        return Err(
                            "harvested session differs from the exact native compiled original"
                                .into(),
                        );
                    }
                }
                Ok(())
            },
        )
    };
    if let Some(context) = context {
        if !same_origin(&context.origin, &snapshot.origin) {
            return Err("inbox compilation belongs to a different native opening".into());
        }
        crate::session_compile::with_verified_inbox_completion(
            state,
            context,
            &text,
            |root, verify| commit(root, Some(verify)),
        )
    } else {
        state.with_origin(&snapshot.origin, |root| commit(root, None))
    }
}

pub(crate) fn release(snapshot: &Snapshot) -> Result<(), String> {
    let mut registry = grants()
        .lock()
        .map_err(|_| "inbox snapshot issuer lock poisoned")?;
    if let Some(grant) = registry.get(&snapshot.snapshot_id) {
        authenticate(snapshot, grant)?;
        registry.remove(&snapshot.snapshot_id);
    }
    Ok(())
}

#[cfg(test)]
#[path = "inbox_source_tests.rs"]
mod tests;
