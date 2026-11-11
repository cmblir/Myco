//! Opening- and role-bound, process-local read grants for selected map members.

use crate::commands::{authorized_role, AgentVaultSession, VaultRoot};
use crate::map_source_io::SourceSet;
use crate::role_authorization::{RoleId, RoleSnapshot};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;

const MEMBER_LIMIT: usize = 12;
const SNAPSHOT_LIMIT: usize = 8;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemberSnapshot {
    pub path: String,
    pub revision: String,
    pub raw: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    pub snapshot_id: String,
    pub origin: AgentVaultSession,
    pub members: Vec<MemberSnapshot>,
}

struct Grant {
    origin: AgentVaultSession,
    role: String,
    sources: SourceSet,
}
#[derive(Default)]
pub(crate) struct MapSourceRegistry(Mutex<BTreeMap<String, Grant>>);

fn same_origin(left: &AgentVaultSession, right: &AgentVaultSession) -> bool {
    left.vault_path == right.vault_path && left.opening_token == right.opening_token
}
fn validate_paths(paths: &[String]) -> Result<(), String> {
    if paths.is_empty() || paths.len() > MEMBER_LIMIT {
        return Err("map sources require one to twelve selected members".into());
    }
    let mut unique = BTreeSet::new();
    for path in paths {
        if path.encode_utf16().count() > 512
            || !path.to_ascii_lowercase().ends_with(".md")
            || path
                .chars()
                .any(|c| c.is_control() || ":\\[]|#<>\"?*".contains(c))
            || path.split('/').any(|part| {
                let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
                part.is_empty()
                    || part.starts_with('.')
                    || part.ends_with(['.', ' '])
                    || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                    || ((stem.starts_with("COM") || stem.starts_with("LPT"))
                        && stem.len() == 4
                        && matches!(stem.as_bytes()[3], b'1'..=b'9'))
            })
        {
            return Err("map source has no safe portable path".into());
        }
        if !unique.insert(crate::norm::nfc(path).to_lowercase()) {
            return Err("map source paths are duplicate or ambiguous".into());
        }
    }
    Ok(())
}

pub(crate) fn capture(
    vault: &VaultRoot,
    registry: &MapSourceRegistry,
    origin: &AgentVaultSession,
    role: &RoleSnapshot,
    paths: &[String],
) -> Result<Snapshot, String> {
    validate_paths(paths)?;
    authorized_role(vault, origin, role, RoleId::Organization, |root| {
        let mut grants = registry
            .0
            .lock()
            .map_err(|_| "map source registry poisoned")?;
        // A single active opening exists. Old handles cannot authorize new reads.
        grants.retain(|_, grant| same_origin(&grant.origin, origin));
        if grants.len() >= SNAPSHOT_LIMIT {
            return Err("map source snapshot limit reached; release a pending snapshot".into());
        }
        crate::vault::with_root_mutation(root, |canonical, _guard| {
            let (sources, members) = SourceSet::capture(canonical, paths)?;
            let mut entropy = [0u8; 32];
            getrandom::fill(&mut entropy).map_err(|_| "map source entropy unavailable")?;
            let snapshot_id: String = entropy.iter().map(|byte| format!("{byte:02x}")).collect();
            if grants.contains_key(&snapshot_id) {
                return Err("map source snapshot collision".into());
            }
            let role = serde_json::to_string(role).map_err(|error| error.to_string())?;
            grants.insert(
                snapshot_id.clone(),
                Grant {
                    origin: origin.clone(),
                    role,
                    sources,
                },
            );
            Ok(Snapshot {
                snapshot_id,
                origin: origin.clone(),
                members,
            })
        })
    })
}

/// Check while holding native origin, role, registry and cooperating-writer guards.
/// This does not bind a subsequent publication into the same transaction.
pub(crate) fn check(
    vault: &VaultRoot,
    registry: &MapSourceRegistry,
    origin: &AgentVaultSession,
    role: &RoleSnapshot,
    snapshot_id: &str,
) -> Result<(), String> {
    authorized_role(vault, origin, role, RoleId::Organization, |root| {
        with_checked_publication(root, registry, origin, role, snapshot_id, |_, _, verify| {
            verify()
        })
    })
}

/// Caller must hold authorized_role. Keep source custody and the writer lock through publication.
pub(crate) fn with_checked_publication<T>(
    root: &std::path::Path,
    registry: &MapSourceRegistry,
    origin: &AgentVaultSession,
    role: &RoleSnapshot,
    snapshot_id: &str,
    operation: impl FnOnce(
        &std::path::Path,
        &std::sync::MutexGuard<'_, ()>,
        &dyn Fn() -> Result<(), String>,
    ) -> Result<T, String>,
) -> Result<T, String> {
    let grants = registry
        .0
        .lock()
        .map_err(|_| "map source registry poisoned")?;
    let grant = grants
        .get(snapshot_id)
        .ok_or("unknown map source snapshot")?;
    if !same_origin(&grant.origin, origin)
        || grant.role != serde_json::to_string(role).map_err(|error| error.to_string())?
    {
        return Err("map source snapshot origin or role differs".into());
    }
    crate::vault::with_root_mutation(root, |canonical, guard| {
        let verify = || grant.sources.check(canonical);
        verify()?;
        operation(canonical, guard, &verify)
    })
}

/// Release the original grant even after its opening or role has been revoked.
pub(crate) fn release(
    registry: &MapSourceRegistry,
    origin: &AgentVaultSession,
    snapshot_id: &str,
) -> Result<(), String> {
    let mut grants = registry
        .0
        .lock()
        .map_err(|_| "map source registry poisoned")?;
    if let Some(grant) = grants.get(snapshot_id) {
        if !same_origin(&grant.origin, origin) {
            return Err("map source release origin differs".into());
        }
        grants.remove(snapshot_id);
    }
    Ok(())
}

#[cfg(test)]
#[path = "map_sources_tests.rs"]
mod tests;
