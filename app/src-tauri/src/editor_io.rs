//! Full editor baselines and saves bound to the originating vault opening.

use crate::vault::{self, FileContent};
use crate::vault_session::{AgentVaultSession, VaultRoot};
use serde::Serialize;
use sha2::{Digest, Sha256};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadReceipt {
    pub file: FileContent,
    pub origin: AgentVaultSession,
    pub revision: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteReceipt {
    pub path: String,
    pub origin: AgentVaultSession,
    pub revision: String,
}

/// Hash the exact raw bytes returned to the editor while its opening is held.
pub(crate) fn read(
    state: &VaultRoot,
    path: &str,
    origin: &AgentVaultSession,
) -> Result<ReadReceipt, String> {
    state.with_origin(origin, |root| {
        vault::with_root_mutation(root, |canonical_root, _guard| {
            let confined = vault::confine_mutation_path(canonical_root, root, path)?;
            let file = vault::read_file(&confined.to_string_lossy())?;
            // External writers do not share FILE. Reject a changed alias or
            // escaped canonical result rather than return an outside baseline.
            vault::confine_mutation_path(canonical_root, root, path)?;
            vault::confine_mutation_path(canonical_root, root, &file.path)?;
            let revision = format!("{:x}", Sha256::digest(file.raw.as_bytes()));
            let receipt = ReadReceipt {
                file,
                origin: origin.clone(),
                revision,
            };
            crate::editor_recovery::register_snapshot(&receipt)?;
            Ok(receipt)
        })
    })
}

/// Recheck opening, path and raw protection before the unlocked recorded CAS.
pub(crate) fn write(
    state: &VaultRoot,
    path: &str,
    content: &str,
    expected_sha256: &str,
    origin: &AgentVaultSession,
) -> Result<WriteReceipt, String> {
    write_impl(
        state,
        path,
        content,
        expected_sha256,
        origin,
        #[cfg(test)]
        || {},
        #[cfg(test)]
        |_| Ok(()),
    )
}

pub(crate) fn write_impl(
    state: &VaultRoot,
    path: &str,
    content: &str,
    expected_sha256: &str,
    origin: &AgentVaultSession,
    #[cfg(test)] before_lock: impl FnOnce(),
    #[cfg(test)] after_persist: impl FnOnce(&std::path::Path) -> Result<(), String>,
) -> Result<WriteReceipt, String> {
    state.with_origin(origin, |root| {
        let receipt = vault::with_root_mutation_impl(
            root,
            |canonical_root, guard| {
                let confined = vault::confine_mutation_path(canonical_root, root, path)?;
                if vault::is_raw_path(canonical_root, &confined) {
                    return Err(
                        "refused: raw/ is immutable — editor saves are for derived notes".into(),
                    );
                }
                vault::write_file_if_unchanged_recorded_locked_impl(
                    guard,
                    &confined.to_string_lossy(),
                    content,
                    Some(expected_sha256),
                    #[cfg(test)]
                    after_persist,
                )
            },
            #[cfg(test)]
            before_lock,
        )?;
        // The recorded writer checked these exact persisted bytes before
        // returning. A later reread must not replace them with an external edit.
        crate::editor_recovery::register_written(
            &receipt.path.to_string_lossy(),
            content,
            &receipt.revision,
            origin,
        )
        .map_err(|error| format!("write persisted but recovery baseline failed: {error}"))?;
        if let Some(updater) = crate::INDEX_UPDATER.get() {
            if let Ok(relative) = receipt.path.strip_prefix(root) {
                updater.mark_dirty(root, relative.to_string_lossy().replace('\\', "/"));
            }
        }
        Ok(WriteReceipt {
            path: receipt.path.to_string_lossy().into_owned(),
            origin: origin.clone(),
            revision: receipt.revision,
        })
    })
}
