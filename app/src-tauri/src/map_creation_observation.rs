//! Validated creation evidence, not an update, completion or deletion permit.
//! Current text may contain human edits and must be merged under separate authority.

use crate::vault::CompilerPinDirectory;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::sync::MutexGuard;

#[derive(Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Scope {
    vault: String,
    device: u64,
    inode: u64,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IssuedObject {
    device: u64,
    inode: u64,
    #[serde(rename = "changedSeconds")]
    _changed_seconds: i64,
    #[serde(rename = "changedNanoseconds")]
    _changed_nanoseconds: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Observation {
    version: u8,
    state: String,
    scope: Scope,
    anchor: String,
    revision: String,
    file_identity: IssuedObject,
    baseline: String,
}

pub(crate) struct CreationContent {
    pub baseline: String,
    pub current: String,
}

/// Reopen stable private evidence and its exact file object. This function never
/// rebuilds an old native receipt, nor proves current text is safe to overwrite.
pub(crate) fn read_creation(
    directory: &CompilerPinDirectory,
    leaf: &str,
    root: &Path,
    relative: &str,
    guard: &MutexGuard<'_, ()>,
) -> Result<CreationContent, String> {
    read_at(directory, leaf, root, relative, guard, || Ok(()))
}

fn read_at(
    directory: &CompilerPinDirectory,
    leaf: &str,
    root: &Path,
    relative: &str,
    guard: &MutexGuard<'_, ()>,
    after_anchor_check: impl FnOnce() -> Result<(), String>,
) -> Result<CreationContent, String> {
    let key = relative
        .strip_prefix("wiki/maps/")
        .and_then(|name| name.strip_suffix(".md"))
        .ok_or("map observation target is outside wiki/maps")?;
    if (crate::distill_publication::ManagedArtifact::Map { key: key.into() }).path()? != relative {
        return Err("map observation target is not canonical".into());
    }
    let canonical = root.canonicalize().map_err(|error| error.to_string())?;
    let private_path = crate::settings::settings_dir()?
        .canonicalize()
        .map_err(|error| error.to_string())?
        .join("map-creation-custody");
    if directory.path() != private_path || private_path.starts_with(&canonical) {
        return Err("map observation store is not the private app-data directory".into());
    }
    let metadata = std::fs::symlink_metadata(&canonical).map_err(|error| error.to_string())?;
    let expected = Scope {
        vault: canonical.to_str().ok_or("map vault is not UTF-8")?.into(),
        device: metadata.dev(),
        inode: metadata.ino(),
        path: relative.into(),
    };
    let (held_record, bytes) = crate::map_custody_record::read_record(directory, leaf)?;
    let observation: Observation =
        serde_json::from_slice(&bytes).map_err(|_| "invalid map creation observation schema")?;
    let scope_hash = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&expected).map_err(|error| error.to_string())?)
    );
    let expected_anchor = format!(
        "{}.anchor",
        leaf.strip_suffix(".json")
            .ok_or("invalid map observation leaf")?
    );
    if observation.version != 1
        || observation.state != "creationObserved"
        || observation.scope != expected
        || !leaf.starts_with(&format!("{scope_hash}."))
        || observation.anchor != expected_anchor
        || observation.revision != format!("{:x}", Sha256::digest(observation.baseline.as_bytes()))
    {
        return Err("map creation observation scope, generation or baseline differs".into());
    }
    crate::map_content::validate_new_draft(&observation.baseline)?;
    let anchor = std::fs::symlink_metadata(directory.path().join(&observation.anchor))
        .map_err(|error| format!("inspect map creation anchor: {error}"))?;
    if !anchor.is_file()
        || anchor.dev() != observation.file_identity.device
        || anchor.ino() != observation.file_identity.inode
    {
        return Err("map creation anchor differs from issued object".into());
    }
    after_anchor_check()?;
    let pin = crate::vault::reopen_compiler_prior_file_pin(
        &canonical.join(relative),
        directory,
        &observation.anchor,
    )?;
    let (current, _) = crate::vault::read_compiler_prior_file_pin_locked(guard, &pin)?;
    pin.verify_issued_object(
        observation.file_identity.device,
        observation.file_identity.inode,
    )?;
    crate::map_custody_record::verify_held_record(directory, leaf, &held_record, &bytes)?;
    let after = std::fs::symlink_metadata(&canonical).map_err(|error| error.to_string())?;
    if (after.dev(), after.ino()) != (expected.device, expected.inode) {
        return Err("map creation vault identity changed during read".into());
    }
    Ok(CreationContent {
        baseline: observation.baseline,
        current,
    })
}

#[cfg(test)]
#[path = "map_creation_observation_tests.rs"]
mod tests;
