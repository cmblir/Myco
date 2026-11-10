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
#[serde(deny_unknown_fields)]
struct PreviousContent {
    revision: String,
    content: String,
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
    #[serde(default)]
    previous: Option<PreviousContent>,
}

pub(crate) struct CreationContent {
    pub baseline: String,
    pub current: String,
    pub has_owned_content_edits: bool,
    pub previous_content: Option<String>,
    pin: crate::vault::CompilerPriorFilePin,
    record: std::fs::File,
    record_bytes: Vec<u8>,
    record_leaf: String,
    directory: CompilerPinDirectory,
}

impl CreationContent {
    /// Revalidate the retained record and exact target snapshot before exposing
    /// the held inode to the separately authorized refresh writer.
    pub(crate) fn checked_prior(
        &self,
        guard: &MutexGuard<'_, ()>,
    ) -> Result<&crate::vault::CompilerPriorFilePin, String> {
        crate::map_custody_record::verify_held_record(
            &self.directory,
            &self.record_leaf,
            &self.record,
            &self.record_bytes,
        )?;
        let (current, _) = crate::vault::read_compiler_prior_file_pin_locked(guard, &self.pin)?;
        if current != self.current || self.has_owned_content_edits {
            return Err("map changed after refresh preparation; current content preserved".into());
        }
        Ok(&self.pin)
    }
}

/// Find the current object's retained observation without a process-local key.
/// This bounded discovery returns text only, never recovered mutation authority.
pub(crate) fn discover_creation(
    directory: &CompilerPinDirectory,
    root: &Path,
    relative: &str,
    guard: &MutexGuard<'_, ()>,
) -> Result<CreationContent, String> {
    let key = relative
        .strip_prefix("wiki/maps/")
        .and_then(|name| name.strip_suffix(".md"))
        .ok_or("map discovery target is outside wiki/maps")?;
    if (crate::distill_publication::ManagedArtifact::Map { key: key.into() }).path()? != relative {
        return Err("map discovery target is not canonical".into());
    }
    directory.verify()?;
    let canonical = root.canonicalize().map_err(|error| error.to_string())?;
    let root_metadata = std::fs::symlink_metadata(&canonical).map_err(|error| error.to_string())?;
    let scope = Scope {
        vault: canonical.to_str().ok_or("map vault is not UTF-8")?.into(),
        device: root_metadata.dev(),
        inode: root_metadata.ino(),
        path: relative.into(),
    };
    let prefix = format!(
        "{:x}.",
        Sha256::digest(serde_json::to_vec(&scope).map_err(|error| error.to_string())?)
    );
    let target =
        std::fs::symlink_metadata(canonical.join(relative)).map_err(|error| error.to_string())?;
    if !target.is_file() {
        return Err("map discovery target is not a regular file".into());
    }
    let before = std::fs::symlink_metadata(directory.path()).map_err(|error| error.to_string())?;
    let mut found = None;
    let mut total_bytes = 0usize;
    for (index, entry) in std::fs::read_dir(directory.path())
        .map_err(|error| error.to_string())?
        .enumerate()
    {
        if index >= 4096 {
            return Err("map creation discovery entry budget exceeded".into());
        }
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name();
        let Some(leaf) = name.to_str() else { continue };
        if !leaf.starts_with(&prefix) || !leaf.ends_with(".json") {
            continue;
        }
        let (held, bytes) = crate::map_custody_record::read_record(directory, leaf)?;
        total_bytes += bytes.len();
        if total_bytes > 32 * 1024 * 1024 {
            return Err("map creation discovery byte budget exceeded".into());
        }
        let observation: Observation = serde_json::from_slice(&bytes)
            .map_err(|_| "invalid map creation observation schema")?;
        // An old, undone generation refers to another retained inode. It cannot
        // establish custody of the current file merely by having the same path.
        if (
            observation.file_identity.device,
            observation.file_identity.inode,
        ) != (target.dev(), target.ino())
        {
            continue;
        }
        if found.is_some() {
            return Err("multiple map creation observations match the current object".into());
        }
        found = Some(read_creation(directory, leaf, &canonical, relative, guard)?);
        crate::map_custody_record::verify_held_record(directory, leaf, &held, &bytes)?;
    }
    directory.verify()?;
    let after = std::fs::symlink_metadata(directory.path()).map_err(|error| error.to_string())?;
    if (
        before.mtime(),
        before.mtime_nsec(),
        before.ctime(),
        before.ctime_nsec(),
    ) != (
        after.mtime(),
        after.mtime_nsec(),
        after.ctime(),
        after.ctime_nsec(),
    ) {
        return Err("map creation store changed during discovery".into());
    }
    found.ok_or_else(|| "no creation observation matches the current map object".into())
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
    let is_creation = observation.version == 1
        && observation.state == "creationObserved"
        && observation.previous.is_none();
    let is_refresh = observation.state == "refreshObserved"
        && ((observation.version == 2 && observation.previous.is_none())
            || (observation.version == 3 && observation.previous.is_some()));
    if (!is_creation && !is_refresh)
        || observation.scope != expected
        || !leaf.starts_with(&format!("{scope_hash}."))
        || observation.anchor != expected_anchor
        || observation.revision != format!("{:x}", Sha256::digest(observation.baseline.as_bytes()))
    {
        return Err("map creation observation scope, generation or baseline differs".into());
    }
    if is_creation {
        crate::map_content::validate_new_draft(&observation.baseline)?;
    } else if !crate::map_content::owned_sections_unchanged(
        &observation.baseline,
        &observation.baseline,
    ) {
        return Err("map refresh baseline has invalid generated sections".into());
    }
    if let Some(previous) = &observation.previous {
        if previous.revision != format!("{:x}", Sha256::digest(previous.content.as_bytes()))
            || !crate::map_content::owned_sections_unchanged(&previous.content, &previous.content)
        {
            return Err("map refresh previous snapshot is invalid".into());
        }
    }
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
        has_owned_content_edits: !crate::map_content::owned_sections_unchanged(
            &observation.baseline,
            &current,
        ),
        baseline: observation.baseline,
        previous_content: observation.previous.map(|previous| previous.content),
        current,
        pin,
        record: held_record,
        record_bytes: bytes,
        record_leaf: leaf.into(),
        directory: directory.clone(),
    })
}

#[cfg(test)]
#[path = "map_creation_observation_tests.rs"]
mod tests;
