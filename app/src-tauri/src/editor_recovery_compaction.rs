//! Checked completed-record compaction and exact-nonce raw-custody cleanup.

use super::{
    capture_bytes, compacting_path, hash, identity, paths, read, read_stored, state,
    CompletionReceipt, PrivateDirectory, Scope, Stored,
};
use crate::vault;
use std::path::Path;

pub(super) fn maintain_completed(
    directory: &PrivateDirectory,
    target: &Path,
    scope: &Scope,
    guard: &std::sync::MutexGuard<'_, ()>,
    revision: &str,
) {
    if let Err(error) = compact_completed(
        directory,
        target,
        scope,
        guard,
        revision,
        #[cfg(test)]
        |_, _| Ok(()),
    ) {
        eprintln!(
            "editor recovery retirement committed; raw custody compaction incomplete: {error}"
        );
    }
}

fn remove_completed_copy(
    directory: &PrivateDirectory,
    path: &Path,
    scope: &Scope,
    receipt: &CompletionReceipt,
) -> Result<bool, String> {
    let Some(copy) = read(directory, path, scope)? else {
        return Ok(false);
    };
    if !receipt.matches_original(&copy.journal, &copy.digest) {
        return Err("completed recovery copy differs from its receipt".into());
    }
    directory.check()?;
    if identity(Path::new(&scope.root))? != scope.object {
        return Err("recovery vault changed before completed copy cleanup".into());
    }
    std::fs::remove_file(path)
        .map_err(|error| format!("remove completed recovery copy: {error}"))?;
    directory.sync()?;
    Ok(true)
}

pub(super) fn compact_completed(
    directory: &PrivateDirectory,
    target: &Path,
    scope: &Scope,
    guard: &std::sync::MutexGuard<'_, ()>,
    revision: &str,
    #[cfg(test)] after_publish: impl FnOnce(&Path, &Path) -> Result<(), String>,
) -> Result<(), String> {
    let current = state(directory, target, scope)?;
    if current.primary.is_some() || current.pending.is_some() {
        return Err("active recovery cannot authorize completed raw cleanup".into());
    }
    let (pending, committed) = paths(directory, target, revision)?;
    let backup = compacting_path(directory, target, revision)?;
    let completed =
        read_stored(directory, &committed, Some(scope))?.ok_or("completion receipt is absent")?;
    let full = match completed {
        Stored::Compact(receipt) => {
            // Verified v2 is already committed; only this nonce's exact full residues may leave.
            remove_completed_copy(directory, &pending, scope, &receipt)?;
            remove_completed_copy(directory, &backup, scope, &receipt)?;
            return Ok(());
        }
        Stored::Full(full) => full,
    };
    let receipt = CompletionReceipt::from_original(&full.journal, &full.digest)?;
    remove_completed_copy(directory, &pending, scope, &receipt)?;
    if let Some(existing) = read(directory, &backup, scope)? {
        if existing.digest != full.digest {
            return Err("recovery compaction backup differs from completion".into());
        }
    } else {
        let copied = vault::write_file_if_unchanged_recorded_locked(
            guard,
            &backup.to_string_lossy(),
            &full.raw,
            None,
        )?;
        if copied.revision != full.digest {
            return Err("recovery compaction backup receipt differs".into());
        }
    }
    let copied =
        read(directory, &backup, scope)?.ok_or("recovery compaction backup disappeared")?;
    if copied.digest != full.digest {
        return Err("recovery compaction backup bytes differ".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let marker = std::fs::symlink_metadata(&committed)
            .map_err(|error| format!("inspect recovery completion: {error}"))?;
        let copy = std::fs::symlink_metadata(&backup)
            .map_err(|error| format!("inspect recovery compaction copy: {error}"))?;
        if (marker.dev(), marker.ino()) == (copy.dev(), copy.ino()) {
            return Err("recovery compaction copy is not independent".into());
        }
    }
    // Retain the exact full original through real v2 publication and confirmation failures.
    directory.sync()?;
    if identity(Path::new(&scope.root))? != scope.object {
        return Err("recovery vault changed before raw compaction".into());
    }
    let raw = serde_json::to_string(&receipt)
        .map_err(|error| format!("encode recovery completion: {error}"))?;
    let persisted = vault::write_file_if_unchanged_recorded_locked_impl(
        guard,
        &committed.to_string_lossy(),
        &raw,
        Some(&full.digest),
        #[cfg(test)]
        |published| after_publish(published, &backup),
    )?;
    let expected_digest = hash(raw.as_bytes());
    if persisted.revision != expected_digest {
        return Err("compact completion persisted receipt differs".into());
    }
    let actual = read_stored(directory, &committed, Some(scope))?
        .ok_or("compact completion disappeared after publication")?;
    if !matches!(actual, Stored::Compact(ref actual) if actual.matches_original(&full.journal, &full.digest))
        || capture_bytes(directory, &committed)?
            .as_deref()
            .map(hash)
            .as_deref()
            != Some(expected_digest.as_str())
    {
        return Err("compact completion readback differs from its exact publication".into());
    }
    directory.sync()?;
    remove_completed_copy(directory, &backup, scope, &receipt)?;
    Ok(())
}
