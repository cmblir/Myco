//! Native publication authority for one process/opening lifetime. This is an
//! intermediate boundary: restart-durable publication recovery is still required.

use crate::distill::ArchivePublication;
use crate::vault::{RecordedFileIdentity, RecordedWriteReceipt};
use crate::vault_session::AgentVaultSession;
#[cfg(test)]
use crate::vault_session::VaultRoot;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum ManagedArtifact {
    Daily { key: String },
    Weekly { key: String },
    Monthly { key: String },
    Map { key: String },
}

impl ManagedArtifact {
    fn path(&self) -> Result<String, String> {
        let (folder, key, valid) = match self {
            Self::Daily { key } => ("daily", key, valid_date(key)),
            Self::Weekly { key } => ("weekly", key, valid_week(key)),
            Self::Monthly { key } => ("monthly", key, valid_month(key)),
            Self::Map { key } => (
                "wiki/maps",
                key,
                !key.is_empty()
                    && key.len() <= 252
                    && key
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                    && !key.starts_with('-')
                    && !key.ends_with('-'),
            ),
        };
        if !valid {
            return Err("invalid managed publication key".into());
        }
        Ok(format!("{folder}/{key}.md"))
    }
}

fn digits(value: &str) -> bool {
    value.bytes().all(|b| b.is_ascii_digit())
}
fn valid_month(key: &str) -> bool {
    key.len() == 7
        && key.is_ascii()
        && digits(&key[..4])
        && &key[4..5] == "-"
        && digits(&key[5..])
        && matches!(key[5..].parse::<u8>(), Ok(1..=12))
}
fn valid_date(key: &str) -> bool {
    key.len() == 10
        && key.is_ascii()
        && valid_month(&key[..7])
        && &key[7..8] == "-"
        && digits(&key[8..])
        && matches!(key[8..].parse::<u8>(), Ok(1..=31))
}
fn valid_week(key: &str) -> bool {
    key.len() == 8
        && key.is_ascii()
        && digits(&key[..4])
        && &key[4..6] == "-W"
        && digits(&key[6..])
        && matches!(key[6..].parse::<u8>(), Ok(1..=53))
}
fn validate_operation(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 128
        || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("invalid publication operation identity".into());
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PublicationPhase {
    Prepared,
    Published,
    Consumed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublicationReceipt {
    pub publication_id: String,
    pub operation_id: String,
    pub path: String,
    pub revision: String,
    pub file_identity: RecordedFileIdentity,
    pub native_created: bool,
    pub state: PublicationPhase,
}

#[derive(Clone)]
struct Entry {
    origin: AgentVaultSession,
    operation: String,
    path: String,
    content_revision: String,
    expected_revision: Option<String>,
    phase: PublicationPhase,
    written: Option<RecordedWriteReceipt>,
}

#[derive(Default)]
pub(crate) struct DistillPublicationRegistry {
    entries: Mutex<BTreeMap<String, Entry>>,
    #[cfg(test)]
    pub(crate) fail_after_persist: std::sync::atomic::AtomicBool,
}

fn same_origin(a: &AgentVaultSession, b: &AgentVaultSession) -> bool {
    a.vault_path == b.vault_path && a.opening_token == b.opening_token
}

fn target(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let joined = crate::myco_pro::safe_join(root, rel)?;
    crate::vault::confine_delete_path(root, &joined.to_string_lossy())
}

fn receipt(id: &str, entry: &Entry) -> Result<PublicationReceipt, String> {
    let written = entry
        .written
        .as_ref()
        .ok_or("publication has no native write receipt")?;
    Ok(PublicationReceipt {
        publication_id: id.into(),
        operation_id: entry.operation.clone(),
        path: entry.path.clone(),
        revision: written.revision.clone(),
        file_identity: written
            .file_identity
            .clone()
            .ok_or("publication file identity is unsupported on this platform")?,
        native_created: written.native_created,
        state: entry.phase,
    })
}

/// Test bridge retains the same native origin transaction as production dispatch.
#[cfg(test)]
pub(crate) fn publish(
    state: &VaultRoot,
    registry: &DistillPublicationRegistry,
    origin: &AgentVaultSession,
    operation: &str,
    artifact: &ManagedArtifact,
    content: &str,
    expected_revision: Option<&str>,
) -> Result<PublicationReceipt, String> {
    state.with_origin(origin, |root| {
        publish_at(
            root,
            registry,
            origin,
            operation,
            artifact,
            content,
            expected_revision,
        )
    })
}

/// Called under the existing native origin and feature-authorization guards.
pub(crate) fn publish_at(
    root: &Path,
    registry: &DistillPublicationRegistry,
    origin: &AgentVaultSession,
    operation: &str,
    artifact: &ManagedArtifact,
    content: &str,
    expected_revision: Option<&str>,
) -> Result<PublicationReceipt, String> {
    validate_operation(operation)?;
    let rel = artifact.path()?;
    #[cfg(not(unix))]
    return Err("native publication identity is not yet supported on this platform".into());
    #[cfg(unix)]
    {
        let path = target(root, &rel)?;
        let content_revision = format!("{:x}", Sha256::digest(content.as_bytes()));
        let existing = {
            let entries = registry
                .entries
                .lock()
                .map_err(|_| "publication registry lock poisoned")?;
            if entries.values().any(|e| {
                same_origin(&e.origin, origin)
                    && e.operation == operation
                    && e.phase == PublicationPhase::Consumed
            }) {
                return Err("publication operation has already been consumed".into());
            }
            entries
                .iter()
                .find(|(_, e)| {
                    same_origin(&e.origin, origin) && e.operation == operation && e.path == rel
                })
                .map(|(id, e)| (id.clone(), e.clone()))
        };
        let id = if let Some((id, entry)) = existing {
            if entry.content_revision != content_revision {
                return Err("publication operation is bound to different write input".into());
            }
            if entry.phase == PublicationPhase::Published {
                let written = entry.written.as_ref().ok_or("missing native receipt")?;
                if entry.expected_revision.as_deref() != expected_revision
                    && expected_revision != Some(written.revision.as_str())
                {
                    return Err(
                        "publication retry precondition differs from its native receipt".into(),
                    );
                }
                crate::vault::verify_recorded_file(written)?;
                return receipt(&id, &entry);
            }
            if entry.expected_revision.as_deref() != expected_revision {
                return Err(
                    "prepared publication is bound to a different write precondition".into(),
                );
            }
            id
        } else {
            let mut random = [0u8; 32];
            getrandom::fill(&mut random)
                .map_err(|e| format!("publication identity entropy failed: {e}"))?;
            let id = random
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            let mut entries = registry
                .entries
                .lock()
                .map_err(|_| "publication registry lock poisoned")?;
            if entries.contains_key(&id) {
                return Err("publication identity collision".into());
            }
            entries.insert(
                id.clone(),
                Entry {
                    origin: origin.clone(),
                    operation: operation.into(),
                    path: rel.clone(),
                    content_revision,
                    expected_revision: expected_revision.map(str::to_owned),
                    phase: PublicationPhase::Prepared,
                    written: None,
                },
            );
            id
        };
        let parent = target(
            root,
            path.parent()
                .ok_or("publication has no parent")?
                .strip_prefix(root)
                .map_err(|_| "publication parent escaped vault")?
                .to_str()
                .ok_or("publication parent is not UTF-8")?,
        )?;
        std::fs::create_dir_all(&parent)
            .map_err(|e| format!("create managed publication directory: {e}"))?;
        let path = target(root, &rel)?;
        let written = crate::vault::write_file_if_unchanged_recorded(
            &path.to_string_lossy(),
            content,
            expected_revision,
        )?;
        #[cfg(test)]
        if registry
            .fail_after_persist
            .swap(false, std::sync::atomic::Ordering::SeqCst)
        {
            return Err("publication bytes persisted but capability registration failed; output preserved for manual recovery".into());
        }
        let mut entries = registry.entries.lock().map_err(|_| "publication bytes persisted but registry lock poisoned; output preserved for manual recovery")?;
        let entry = entries
            .get_mut(&id)
            .ok_or("publication bytes persisted but prepared identity disappeared")?;
        entry.written = Some(written);
        entry.phase = PublicationPhase::Published;
        receipt(&id, entry)
    }
}

/// Caller-supplied creation flags never determine native ownership.
pub(crate) fn validate(
    registry: &DistillPublicationRegistry,
    root: &Path,
    origin: &AgentVaultSession,
    operation: &str,
    publication_ids: &[String],
    claims: &[ArchivePublication],
) -> Result<Vec<ArchivePublication>, String> {
    validate_operation(operation)?;
    if publication_ids.is_empty()
        || publication_ids.len() != claims.len()
        || publication_ids.iter().collect::<HashSet<_>>().len() != publication_ids.len()
        || claims.iter().map(|p| &p.path).collect::<HashSet<_>>().len() != claims.len()
    {
        return Err("publication requires distinct native capability identities; preserve artifacts for manual recovery".into());
    }
    let proven = {
        let entries = registry
            .entries
            .lock()
            .map_err(|_| "publication registry lock poisoned")?;
        publication_ids.iter().zip(claims).map(|(id, claim)| {
            let entry = entries.get(id).ok_or("unknown publication capability; manual recovery required")?;
            if !same_origin(&entry.origin, origin) || entry.operation != operation || entry.path != claim.path
                || entry.phase != PublicationPhase::Published || entry.content_revision != claim.revision {
                return Err("publication capability does not match this origin, operation, path, revision or phase".into());
            }
            Ok((claim.clone(), entry.written.clone().ok_or("publication has no native write receipt")?))
        }).collect::<Result<Vec<_>, String>>()?
    };
    proven
        .into_iter()
        .map(|(mut claim, written)| {
            if target(root, &claim.path)? != written.path {
                return Err("publication target differs from native write receipt".into());
            }
            crate::vault::verify_recorded_file(&written)?;
            claim.created = written.native_created;
            Ok(claim)
        })
        .collect()
}

/// Created-note undo uses private native receipts, never writable history as authority.
/// Unknown move receipts must be rejected by the command before calling this slice.
pub(crate) fn undo_created(
    registry: &DistillPublicationRegistry,
    root: &Path,
    origin: &AgentVaultSession,
    operation: &str,
    paths: &[String],
) -> Result<usize, String> {
    validate_operation(operation)?;
    if paths.is_empty() {
        return Err("undo has no native creation receipt; manual recovery required".into());
    }
    if paths.iter().collect::<HashSet<_>>().len() != paths.len() {
        return Err("duplicate undo creation path".into());
    }
    let owned = {
        let entries = registry
            .entries
            .lock()
            .map_err(|_| "publication registry lock poisoned")?;
        paths
            .iter()
            .map(|path| {
                let (id, entry) = entries
                    .iter()
                    .find(|(_, e)| {
                        same_origin(&e.origin, origin)
                            && e.operation == operation
                            && &e.path == path
                    })
                    .ok_or("created note has no native capability; manual recovery required")?;
                let written = entry.written.clone().ok_or("creation was not published")?;
                if entry.phase != PublicationPhase::Published || !written.native_created {
                    return Err("undo has no unconsumed native creation authority".into());
                }
                Ok((id.clone(), written))
            })
            .collect::<Result<Vec<_>, String>>()?
    };
    for (_, written) in &owned {
        if !written.path.starts_with(root) {
            return Err("undo publication escaped its vault".into());
        }
        crate::vault::confine_delete_path(root, &written.path.to_string_lossy())?;
        crate::vault::verify_recorded_file(written)?;
    }
    let mut removed = 0;
    for (id, written) in owned {
        crate::vault::remove_recorded_file(&written).map_err(|e| {
            format!("publication undo stopped after {removed} completed removals: {e}")
        })?;
        removed += 1;
        let mut entries = registry.entries.lock().map_err(|_| format!("publication undo completed {removed} removals but consumption could not be recorded"))?;
        entries
            .get_mut(&id)
            .ok_or("publication identity disappeared after removal")?
            .phase = PublicationPhase::Consumed;
    }
    Ok(removed)
}

#[derive(Deserialize)]
struct UndoHistory {
    id: String,
    #[serde(default)]
    created: Vec<String>,
    #[serde(default)]
    moves: Vec<crate::distill::MoveEntry>,
    #[serde(default)]
    trashed: Vec<crate::distill::MoveEntry>,
}

/// History selects requested paths but never supplies deletion or move authority.
pub(crate) fn undo_from_history(
    registry: &DistillPublicationRegistry,
    root: &Path,
    origin: &AgentVaultSession,
    operation: &str,
) -> Result<usize, String> {
    validate_operation(operation)?;
    let path = target(root, &format!(".myco/distill-runs/{operation}.json"))?;
    let bytes = std::fs::read(path).map_err(|e| format!("read undo history: {e}"))?;
    let history: UndoHistory =
        serde_json::from_slice(&bytes).map_err(|e| format!("parse undo history: {e}"))?;
    if history.id != operation {
        return Err("undo history identity differs from its operation".into());
    }
    if !history.moves.is_empty() || !history.trashed.is_empty() {
        return Err("undo moves require private native move receipts; artifacts preserved for manual recovery".into());
    }
    undo_created(registry, root, origin, operation, &history.created)
}

#[cfg(test)]
#[path = "distill_publication_tests.rs"]
mod tests;
