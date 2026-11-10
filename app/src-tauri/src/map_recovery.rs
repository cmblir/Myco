//! Read-only retained snapshots; no retry, undo or publication grants.
use crate::vault_session::{AgentVaultSession, VaultRoot};
use serde::Serialize;

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Evidence {
    CurrentObject,
    PublicationUnknown,
    InvalidRecord,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RetainedSnapshot {
    pub record_id: String,
    pub evidence: Evidence,
    pub before: Option<String>,
    pub after: Option<String>,
}

/// Records are sorted by opaque ID, never claimed to be chronological.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecoverySnapshots {
    pub path: String,
    pub records: Vec<RetainedSnapshot>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecoveryCatalog {
    pub keys: Vec<String>,
    pub has_unidentified_records: bool,
}

#[tauri::command]
pub(crate) fn retained_map_keys(
    state: tauri::State<VaultRoot>,
    origin: AgentVaultSession,
) -> Result<RecoveryCatalog, String> {
    catalog(&state, &origin)
}

pub(crate) fn catalog(
    state: &VaultRoot,
    origin: &AgentVaultSession,
) -> Result<RecoveryCatalog, String> {
    state.with_origin(origin, |root| {
        crate::vault::with_root_mutation(root, |canonical, _guard| {
            #[cfg(unix)]
            {
                let private = crate::settings::settings_dir()?
                    .canonicalize()
                    .map_err(|error| error.to_string())?
                    .join("map-creation-custody");
                match std::fs::symlink_metadata(&private) {
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        return Ok(RecoveryCatalog {
                            keys: vec![],
                            has_unidentified_records: false,
                        });
                    }
                    Err(error) => return Err(error.to_string()),
                    Ok(_) => (),
                }
                let directory = crate::vault::open_compiler_pin_directory(&private)?;
                crate::map_creation_observation::catalog::discover(&directory, canonical)
            }
            #[cfg(not(unix))]
            {
                let _ = canonical;
                Err("map recovery catalog requires native file custody on this platform".into())
            }
        })
    })
}

#[tauri::command]
pub(crate) fn retained_map_snapshots(
    state: tauri::State<VaultRoot>,
    origin: AgentVaultSession,
    key: String,
) -> Result<RecoverySnapshots, String> {
    inspect(&state, &origin, &key)
}

pub(crate) fn inspect(
    state: &VaultRoot,
    origin: &AgentVaultSession,
    key: &str,
) -> Result<RecoverySnapshots, String> {
    state.with_origin(origin, |root| {
        let path = crate::distill_publication::ManagedArtifact::Map { key: key.into() }.path()?;
        crate::vault::with_root_mutation(root, |canonical, _guard| {
            #[cfg(unix)]
            {
                let private = crate::settings::settings_dir()?
                    .canonicalize()
                    .map_err(|error| error.to_string())?
                    .join("map-creation-custody");
                match std::fs::symlink_metadata(&private) {
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        return Ok(RecoverySnapshots {
                            path,
                            records: vec![],
                        });
                    }
                    Err(error) => return Err(error.to_string()),
                    Ok(_) => (),
                }
                let directory = crate::vault::open_compiler_pin_directory(&private)?;
                let records = crate::map_creation_observation::recovery::inspect(
                    &directory, canonical, &path,
                )?;
                Ok(RecoverySnapshots { path, records })
            }
            #[cfg(not(unix))]
            {
                let _ = (canonical, path);
                Err("map snapshot inspection requires native file custody on this platform".into())
            }
        })
    })
}
