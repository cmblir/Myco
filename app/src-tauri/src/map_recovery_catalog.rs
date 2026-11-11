//! Discover retained map names without depending on the current vault file tree.
use super::{validate_observation, Observation};
use crate::map_recovery::RecoveryCatalog;
use crate::vault::CompilerPinDirectory;
use std::collections::BTreeSet;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

pub(crate) fn discover(
    directory: &CompilerPinDirectory,
    root: &Path,
) -> Result<RecoveryCatalog, String> {
    discover_at(directory, root, || Ok(()))
}

pub(super) fn discover_at(
    directory: &CompilerPinDirectory,
    root: &Path,
    after_scan: impl FnOnce() -> Result<(), String>,
) -> Result<RecoveryCatalog, String> {
    let canonical = root.canonicalize().map_err(|error| error.to_string())?;
    let private = crate::settings::settings_dir()?
        .canonicalize()
        .map_err(|error| error.to_string())?
        .join("map-creation-custody");
    if directory.path() != private || private.starts_with(&canonical) {
        return Err("map catalog store is not private app data".into());
    }
    directory.verify()?;
    let root_before = std::fs::symlink_metadata(&canonical).map_err(|e| e.to_string())?;
    let store_before = std::fs::symlink_metadata(directory.path()).map_err(|e| e.to_string())?;
    let mut retained = Vec::new();
    let mut anchors = Vec::new();
    let mut keys = BTreeSet::new();
    let mut unidentified = false;
    let mut total = 0usize;
    for (index, entry) in std::fs::read_dir(directory.path())
        .map_err(|e| e.to_string())?
        .enumerate()
    {
        if index >= 4096 {
            return Err("map catalog entry budget exceeded".into());
        }
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let Some(leaf) = name.to_str() else { continue };
        if !leaf.ends_with(".json") {
            continue;
        }
        let (held, bytes) = crate::map_custody_record::read_record(directory, leaf)?;
        total += bytes.len();
        if total > 32 * 1024 * 1024 {
            return Err("map catalog byte budget exceeded".into());
        }
        match serde_json::from_slice::<Observation>(&bytes) {
            Err(_) => unidentified = true,
            Ok(record)
                if record.scope.vault != canonical.to_str().ok_or("map vault is not UTF-8")?
                    || record.scope.device != root_before.dev()
                    || record.scope.inode != root_before.ino() => {}
            Ok(record) => {
                let key = record
                    .scope
                    .path
                    .strip_prefix("wiki/maps/")
                    .and_then(|name| name.strip_suffix(".md"));
                let valid_key = key.filter(|key| {
                    (crate::distill_publication::ManagedArtifact::Map { key: (*key).into() })
                        .path()
                        .is_ok_and(|path| path == record.scope.path)
                });
                if let Some(key) =
                    valid_key.filter(|_| validate_observation(&bytes, &record.scope, leaf).is_ok())
                {
                    let path = directory.path().join(&record.anchor);
                    let anchor = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
                    if !anchor.is_file()
                        || (anchor.dev(), anchor.ino())
                            != (record.file_identity.device, record.file_identity.inode)
                    {
                        return Err("map catalog anchor differs from recorded object".into());
                    }
                    anchors.push((path, anchor));
                    keys.insert(key.to_owned());
                    if keys.len() > 256 {
                        return Err("map catalog key budget exceeded".into());
                    }
                } else {
                    unidentified = true;
                }
            }
        }
        retained.push((leaf.to_owned(), held, bytes));
    }
    after_scan()?;
    for (leaf, held, bytes) in retained {
        crate::map_custody_record::verify_held_record(directory, &leaf, &held, &bytes)?;
    }
    for (path, before) in anchors.into_iter().chain([
        (canonical, root_before),
        (directory.path().to_owned(), store_before),
    ]) {
        let after = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
        if (
            before.dev(),
            before.ino(),
            before.nlink(),
            before.mtime(),
            before.mtime_nsec(),
            before.ctime(),
            before.ctime_nsec(),
        ) != (
            after.dev(),
            after.ino(),
            after.nlink(),
            after.mtime(),
            after.mtime_nsec(),
            after.ctime(),
            after.ctime_nsec(),
        ) {
            return Err("map catalog changed during discovery".into());
        }
    }
    directory.verify()?;
    Ok(RecoveryCatalog {
        keys: keys.into_iter().collect(),
        has_unidentified_records: unidentified,
    })
}
