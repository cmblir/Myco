//! Display evidence only; even a current-object match does not approve content.
use super::{validate_observation, Scope};
use crate::map_recovery::{Evidence, RetainedSnapshot};
use crate::vault::CompilerPinDirectory;
use sha2::{Digest, Sha256};
use std::fs::Metadata;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

fn snapshot(metadata: &Metadata) -> (u64, u64, u64, i64, i64, i64, i64) {
    (
        metadata.dev(),
        metadata.ino(),
        metadata.nlink(),
        metadata.mtime(),
        metadata.mtime_nsec(),
        metadata.ctime(),
        metadata.ctime_nsec(),
    )
}

pub(crate) fn inspect(
    directory: &CompilerPinDirectory,
    root: &Path,
    relative: &str,
) -> Result<Vec<RetainedSnapshot>, String> {
    inspect_at(directory, root, relative, || Ok(()))
}

pub(super) fn inspect_at(
    directory: &CompilerPinDirectory,
    root: &Path,
    relative: &str,
    after_scan: impl FnOnce() -> Result<(), String>,
) -> Result<Vec<RetainedSnapshot>, String> {
    let key = relative
        .strip_prefix("wiki/maps/")
        .and_then(|name| name.strip_suffix(".md"))
        .ok_or("map recovery path is outside wiki/maps")?;
    if (crate::distill_publication::ManagedArtifact::Map { key: key.into() }).path()? != relative {
        return Err("map recovery path is not canonical".into());
    }
    let canonical = root.canonicalize().map_err(|error| error.to_string())?;
    let private = crate::settings::settings_dir()?
        .canonicalize()
        .map_err(|error| error.to_string())?
        .join("map-creation-custody");
    if directory.path() != private || private.starts_with(&canonical) {
        return Err("map recovery store is not private app data".into());
    }
    directory.verify()?;
    // Reject symlink parents before inspecting the current object's identity.
    let mut parents = Vec::new();
    for path in [
        canonical.clone(),
        canonical.join("wiki"),
        canonical.join("wiki/maps"),
    ] {
        let metadata = std::fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
        if !metadata.is_dir() {
            return Err("map recovery parent is not a directory".into());
        }
        parents.push((path, metadata));
    }
    let target_path = canonical.join(relative);
    let target = match std::fs::symlink_metadata(&target_path) {
        Ok(metadata) if metadata.is_file() => Some(metadata),
        Ok(_) => return Err("map recovery target is not a regular file".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.to_string()),
    };
    let scope = Scope {
        vault: canonical.to_str().ok_or("map vault is not UTF-8")?.into(),
        device: parents[0].1.dev(),
        inode: parents[0].1.ino(),
        path: relative.into(),
    };
    let prefix = format!(
        "{:x}.",
        Sha256::digest(serde_json::to_vec(&scope).map_err(|e| e.to_string())?)
    );
    let store_before = std::fs::symlink_metadata(directory.path()).map_err(|e| e.to_string())?;
    let mut retained = Vec::new();
    let mut results = Vec::new();
    let mut anchors = Vec::new();
    let mut total = 0;
    for (index, entry) in std::fs::read_dir(directory.path())
        .map_err(|e| e.to_string())?
        .enumerate()
    {
        if index >= 4096 {
            return Err("map recovery entry budget exceeded".into());
        }
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let Some(leaf) = name.to_str() else { continue };
        if !leaf.starts_with(&prefix) || !leaf.ends_with(".json") {
            continue;
        }
        let (held, bytes) = crate::map_custody_record::read_record(directory, leaf)?;
        total += bytes.len();
        if total > 32 * 1024 * 1024 || results.len() >= 256 {
            return Err("map recovery snapshot budget exceeded".into());
        }
        let mut result = RetainedSnapshot {
            record_id: leaf.into(),
            evidence: Evidence::InvalidRecord,
            before: None,
            after: None,
        };
        // Stable corrupt/schema-invalid records are reported without exposing
        // their untrusted snapshots. I/O, replacement and privacy failures abort.
        if let Ok(observation) = validate_observation(&bytes, &scope, leaf) {
            let anchor_path = directory.path().join(&observation.anchor);
            let anchor = std::fs::symlink_metadata(&anchor_path).map_err(|e| e.to_string())?;
            if !anchor.is_file()
                || (anchor.dev(), anchor.ino())
                    != (
                        observation.file_identity.device,
                        observation.file_identity.inode,
                    )
            {
                return Err("map recovery anchor differs from recorded object".into());
            }
            result.evidence = if target.as_ref().is_some_and(|current| {
                (current.dev(), current.ino()) == (anchor.dev(), anchor.ino())
            }) {
                Evidence::CurrentObject
            } else {
                Evidence::PublicationUnknown
            };
            result.before = observation.previous.map(|previous| previous.content);
            result.after = Some(observation.baseline);
            anchors.push((anchor_path, anchor));
        }
        retained.push((leaf.to_owned(), held, bytes));
        results.push(result);
    }
    after_scan()?;
    for (leaf, held, bytes) in retained {
        crate::map_custody_record::verify_held_record(directory, &leaf, &held, &bytes)?;
    }
    for (path, before) in parents.into_iter().chain(anchors) {
        let after = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
        if snapshot(&before) != snapshot(&after) {
            return Err("map recovery objects changed during inspection".into());
        }
    }
    let after = match std::fs::symlink_metadata(target_path) {
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.to_string()),
    };
    if target.as_ref().map(snapshot) != after.as_ref().map(snapshot)
        || snapshot(&store_before)
            != snapshot(&std::fs::symlink_metadata(directory.path()).map_err(|e| e.to_string())?)
    {
        return Err("map recovery snapshot changed during inspection".into());
    }
    directory.verify()?;
    results.sort_by(|left, right| left.record_id.cmp(&right.record_id));
    Ok(results)
}
