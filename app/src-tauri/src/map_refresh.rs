//! Source-bound map refresh previews and revision-checked native updates.

use crate::role_authorization::{RoleId, RoleSnapshot};
use crate::vault_session::{AgentVaultSession, VaultRoot};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RefreshPreview {
    pub path: String,
    pub current_revision: String,
    pub content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RefreshResult {
    pub path: String,
    pub revision: String,
    pub changed: bool,
}

/// Plain snapshots of the latest recorded refresh, never write or undo authority.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RefreshHistory {
    pub path: String,
    pub before: String,
    pub after: String,
    pub has_changes_since_refresh: bool,
}

#[tauri::command]
pub(crate) fn latest_map_refresh_history(
    state: tauri::State<VaultRoot>,
    origin: AgentVaultSession,
    key: String,
) -> Result<Option<RefreshHistory>, String> {
    history(&state, &origin, &key)
}

pub(crate) fn history(
    state: &VaultRoot,
    origin: &AgentVaultSession,
    key: &str,
) -> Result<Option<RefreshHistory>, String> {
    state.with_origin(origin, |root| {
        let path = crate::distill_publication::ManagedArtifact::Map { key: key.into() }.path()?;
        crate::vault::with_root_mutation(root, |canonical, guard| {
            #[cfg(unix)]
            {
                let private_path = crate::settings::settings_dir()?
                    .canonicalize()
                    .map_err(|error| error.to_string())?
                    .join("map-creation-custody");
                let directory = crate::vault::open_compiler_pin_directory(&private_path)?;
                let observation = crate::map_creation_observation::discover_creation(
                    &directory, canonical, &path, guard,
                )?;
                // Older records have no before-image; do not fabricate one.
                Ok(observation.previous_content.map(|before| RefreshHistory {
                    path,
                    before,
                    has_changes_since_refresh: observation.current != observation.baseline,
                    after: observation.baseline,
                }))
            }
            #[cfg(not(unix))]
            {
                let _ = (canonical, guard, path);
                Err("map refresh history requires native file custody on this platform".into())
            }
        })
    })
}

/// Rebuild the merge under fresh source and target checks; preview bytes never
/// become serialized write authority. This command issues no undo receipt.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Keep native role, origin and CAS fields explicit at IPC.
pub(crate) fn apply_map_refresh(
    state: tauri::State<VaultRoot>,
    sources: tauri::State<crate::map_sources::MapSourceRegistry>,
    origin: AgentVaultSession,
    role_snapshot: RoleSnapshot,
    key: String,
    candidate: String,
    source_snapshot_id: String,
    expected_sha256: String,
) -> Result<RefreshResult, String> {
    let result = apply(
        &state,
        &sources,
        &origin,
        &role_snapshot,
        &key,
        &candidate,
        &source_snapshot_id,
        &expected_sha256,
    )?;
    if let Some(updater) = crate::INDEX_UPDATER.get() {
        updater.mark_dirty(
            std::path::Path::new(&origin.vault_path),
            result.path.clone(),
        );
    }
    Ok(result)
}

#[allow(clippy::too_many_arguments)] // Mirrors the flat native IPC contract for tests.
pub(crate) fn apply(
    state: &VaultRoot,
    sources: &crate::map_sources::MapSourceRegistry,
    origin: &AgentVaultSession,
    role: &RoleSnapshot,
    key: &str,
    candidate: &str,
    source_id: &str,
    expected: &str,
) -> Result<RefreshResult, String> {
    crate::commands::authorized_role(state, origin, role, RoleId::Organization, |root| {
        let path = crate::distill_publication::ManagedArtifact::Map { key: key.into() }.path()?;
        crate::map_content::validate_new_draft(candidate)?;
        crate::map_sources::with_checked_publication(
            root,
            sources,
            origin,
            role,
            source_id,
            |canonical, guard, verify| {
                #[cfg(unix)]
                {
                    let store = crate::map_custody::MapCreationStore::open(canonical, &path)?;
                    let written = store.refresh(guard, candidate, expected, verify)?;
                    Ok(RefreshResult {
                        path,
                        changed: written.is_some(),
                        revision: written
                            .map_or_else(|| expected.into(), |receipt| receipt.revision),
                    })
                }
                #[cfg(not(unix))]
                {
                    let _ = (canonical, guard, verify, path, expected);
                    Err("map refresh requires native file custody on this platform".into())
                }
            },
        )
    })
}

/// Prepare review bytes while retaining existing-map publication restrictions.
#[tauri::command]
pub(crate) fn preview_map_refresh(
    state: tauri::State<VaultRoot>,
    sources: tauri::State<crate::map_sources::MapSourceRegistry>,
    origin: AgentVaultSession,
    role_snapshot: RoleSnapshot,
    key: String,
    candidate: String,
    source_snapshot_id: String,
) -> Result<RefreshPreview, String> {
    preview(
        &state,
        &sources,
        &origin,
        &role_snapshot,
        &key,
        &candidate,
        &source_snapshot_id,
    )
}

pub(crate) fn preview(
    state: &VaultRoot,
    sources: &crate::map_sources::MapSourceRegistry,
    origin: &AgentVaultSession,
    role: &RoleSnapshot,
    key: &str,
    candidate: &str,
    source_id: &str,
) -> Result<RefreshPreview, String> {
    crate::commands::authorized_role(state, origin, role, RoleId::Organization, |root| {
        let path = crate::distill_publication::ManagedArtifact::Map { key: key.into() }.path()?;
        crate::map_content::validate_new_draft(candidate)?;
        crate::map_sources::with_checked_publication(
            root,
            sources,
            origin,
            role,
            source_id,
            |canonical, guard, verify| {
                #[cfg(unix)]
                {
                    use sha2::{Digest, Sha256};
                    let private_path = crate::settings::settings_dir()?
                        .canonicalize()
                        .map_err(|error| error.to_string())?
                        .join("map-creation-custody");
                    let directory = crate::vault::open_compiler_pin_directory(&private_path)?;
                    let observation = crate::map_creation_observation::discover_creation(
                        &directory, canonical, &path, guard,
                    )?;
                    let content = crate::map_content::merge_owned_sections(
                        &observation.baseline,
                        &observation.current,
                        candidate,
                    )?;
                    verify()?;
                    Ok(RefreshPreview {
                        path,
                        current_revision: format!(
                            "{:x}",
                            Sha256::digest(observation.current.as_bytes())
                        ),
                        content,
                    })
                }
                #[cfg(not(unix))]
                {
                    let _ = (canonical, guard, verify, path);
                    Err("map refresh preview requires native file custody on this platform".into())
                }
            },
        )
    })
}

#[cfg(all(test, unix))]
#[path = "map_refresh_tests.rs"]
mod tests;

#[cfg(all(test, unix))]
#[path = "map_refresh_apply_tests.rs"]
mod apply_tests;
