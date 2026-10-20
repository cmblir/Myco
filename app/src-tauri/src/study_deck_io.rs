//! Opening-bound deck snapshots and recorded CAS; card patching remains in TS.

mod sources;
#[cfg(test)]
mod tests;

use crate::vault_session::{AgentVaultSession, VaultRoot};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;

const MAX_SNAPSHOTS: usize = 64;
const MAX_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Context {
    pub snapshot_id: String,
    pub origin: AgentVaultSession,
    pub path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    pub context: Context,
    pub raw: String,
    pub revision: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MutationState {
    Persisted,
    Partial,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MutationReceipt {
    pub path: String,
    pub origin: AgentVaultSession,
    pub state: MutationState,
    pub revision: Option<String>,
    pub error: Option<String>,
}

struct Grant {
    context: Context,
    sources: sources::Sources,
    terminal: Option<MutationReceipt>,
    terminal_content_sha256: Option<String>,
    recorded: Option<crate::vault::RecordedWriteReceipt>,
}

#[derive(Default)]
pub(crate) struct StudyDeckRegistry(Mutex<BTreeMap<String, Grant>>);

fn same_origin(left: &AgentVaultSession, right: &AgentVaultSession) -> bool {
    left.vault_path == right.vault_path && left.opening_token == right.opening_token
}

fn authenticate(context: &Context, grant: &Grant) -> Result<(), String> {
    if context.snapshot_id != grant.context.snapshot_id
        || context.path != grant.context.path
        || !same_origin(&context.origin, &grant.context.origin)
    {
        return Err("study deck context differs from its native snapshot".into());
    }
    Ok(())
}

/// Read exact deck bytes or actual absence without preparing a model grant.
pub(crate) fn read(
    state: &VaultRoot,
    registry: &StudyDeckRegistry,
    path: &str,
    origin: &AgentVaultSession,
) -> Result<Snapshot, String> {
    read_impl(state, registry, path, origin, || Ok(()))
}

fn read_impl(
    state: &VaultRoot,
    registry: &StudyDeckRegistry,
    path: &str,
    origin: &AgentVaultSession,
    before_read: impl FnOnce() -> Result<(), String>,
) -> Result<Snapshot, String> {
    state.with_origin(origin, |requested_root| {
        let mut grants = registry
            .0
            .lock()
            .map_err(|_| "study deck registry lock poisoned")?;
        grants.retain(|_, grant| {
            grant.context.origin.vault_path != origin.vault_path
                || same_origin(&grant.context.origin, origin)
        });
        if grants.len() >= MAX_SNAPSHOTS {
            return Err(
                "study deck snapshot capacity is occupied; discard finished snapshots".into(),
            );
        }
        crate::vault::with_root_mutation(requested_root, |root, _writer| {
            let path = sources::path(root, requested_root, path)?;
            let (sources, raw) = sources::capture(root, &path, before_read)?;
            let revision = sources.revision.clone();
            let mut nonce = [0u8; 16];
            getrandom::fill(&mut nonce)
                .map_err(|error| format!("study deck snapshot entropy: {error}"))?;
            let snapshot_id: String = nonce.iter().map(|byte| format!("{byte:02x}")).collect();
            if grants.contains_key(&snapshot_id) {
                return Err("study deck snapshot identity collision".into());
            }
            let context = Context {
                snapshot_id,
                origin: origin.clone(),
                path: path.to_string_lossy().into_owned(),
            };
            grants.insert(
                context.snapshot_id.clone(),
                Grant {
                    context: context.clone(),
                    sources,
                    terminal: None,
                    terminal_content_sha256: None,
                    recorded: None,
                },
            );
            Ok(Snapshot {
                context,
                raw,
                revision,
            })
        })
    })
}

/// Persist only the exact original deck snapshot, retaining uncertain outcomes.
pub(crate) fn write(
    state: &VaultRoot,
    registry: &StudyDeckRegistry,
    context: &Context,
    content: &str,
) -> Result<MutationReceipt, String> {
    write_impl(
        state,
        registry,
        context,
        content,
        || {},
        |_, _, _, _| Ok(None),
    )
}

#[cfg(test)]
fn write_with(
    state: &VaultRoot,
    registry: &StudyDeckRegistry,
    context: &Context,
    content: &str,
    before_writer: impl FnOnce(),
    after_persist: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<MutationReceipt, String> {
    write_impl(
        state,
        registry,
        context,
        content,
        before_writer,
        |writer, path, content, expected| {
            crate::vault::write_file_if_unchanged_recorded_locked_impl(
                writer,
                &path.to_string_lossy(),
                content,
                expected,
                after_persist,
            )
            .map(Some)
        },
    )
}

fn write_impl(
    state: &VaultRoot,
    registry: &StudyDeckRegistry,
    context: &Context,
    content: &str,
    before_writer: impl FnOnce(),
    write_override: impl FnOnce(
        &std::sync::MutexGuard<'_, ()>,
        &Path,
        &str,
        Option<&str>,
    ) -> Result<Option<crate::vault::RecordedWriteReceipt>, String>,
) -> Result<MutationReceipt, String> {
    if content.len() > MAX_BYTES {
        return Err("study deck output exceeds the 1 MiB limit".into());
    }
    let content_sha256 = sources::digest(content);
    let (receipt, root, relative, did_write) = state.with_origin(&context.origin, |requested_root| {
        let mut grants = registry.0.lock().map_err(|_| "study deck registry lock poisoned")?;
        let grant = grants.get_mut(&context.snapshot_id).ok_or("native study deck snapshot expired")?;
        authenticate(context, grant)?;
        before_writer();
        crate::vault::with_root_mutation(requested_root, |root, writer| {
            let path = sources::path(root, requested_root, &context.path)?;
            let relative = path.strip_prefix(root).map_err(|_| "study deck is outside its vault")?
                .to_string_lossy().replace('\\', "/");
            if let Some(terminal) = &grant.terminal {
                if grant.terminal_content_sha256.as_deref() != Some(content_sha256.as_str()) {
                    return Err("study deck snapshot was already used with different content".into());
                }
                if terminal.state == MutationState::Persisted {
                    grant.sources.verify_parent(root, &path)?;
                    crate::vault::verify_recorded_file_unlocked(
                        grant.recorded.as_ref().ok_or("study deck persisted receipt is missing")?,
                    )?;
                }
                return Ok((terminal.clone(), root.to_path_buf(), relative, false));
            }
            grant.sources.verify(root, &path)?;
            grant.sources.prepare_directory(root, &path)?;
            let result = match write_override(writer, &path, content, grant.sources.revision.as_deref()) {
                Ok(Some(receipt)) => Ok(receipt),
                Ok(None) => crate::vault::write_file_if_unchanged_recorded_locked(
                    writer, &path.to_string_lossy(), content, grant.sources.revision.as_deref(),
                ),
                Err(error) => Err(error),
            };
            let (state, revision, error) = match result {
                Ok(recorded) => {
                    let verified = grant.sources.verify_parent(root, &path)
                        .and_then(|()| sources::path(root, requested_root, &context.path).map(|_| ()))
                        .and_then(|()| crate::vault::verify_recorded_file_unlocked(&recorded));
                    let outcome = match verified {
                        Ok(()) => (MutationState::Persisted, Some(recorded.revision.clone()), None),
                        Err(error) => (MutationState::Partial, None,
                            Some(format!("write persisted but study deck receipt verification failed: {error}"))),
                    };
                    grant.recorded = Some(recorded);
                    outcome
                }
                Err(error) if error.starts_with("write persisted but ") =>
                    (MutationState::Partial, None, Some(error)),
                Err(error) => return Err(error),
            };
            let receipt = MutationReceipt { path: context.path.clone(), origin: context.origin.clone(),
                state, revision, error };
            grant.terminal_content_sha256 = Some(content_sha256);
            grant.terminal = Some(receipt.clone());
            Ok((receipt, root.to_path_buf(), relative, true))
        })
    })?;
    if did_write {
        if let Some(updater) = crate::INDEX_UPDATER.get() {
            updater.mark_dirty(&root, relative);
        }
    }
    Ok(receipt)
}

/// Release an exact snapshot, including one from an opening that has ended.
pub(crate) fn discard(registry: &StudyDeckRegistry, context: &Context) -> Result<bool, String> {
    let mut grants = registry
        .0
        .lock()
        .map_err(|_| "study deck registry lock poisoned")?;
    let Some(grant) = grants.get(&context.snapshot_id) else {
        return Ok(false);
    };
    authenticate(context, grant)?;
    grants.remove(&context.snapshot_id);
    Ok(true)
}
