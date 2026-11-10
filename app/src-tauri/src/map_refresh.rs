//! Read-only, source-bound map refresh previews. No update or undo authority.

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
