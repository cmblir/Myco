//! Stable private record bytes only. Schema, scope and anchor validation remain
//! necessary before any future update permission; this module issues no grants.

use crate::vault::CompilerPinDirectory;
use std::fs::{File, Metadata, OpenOptions};
use std::io::Read;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

pub(crate) const MAX_BYTES: usize = 8 * 1024 * 1024;

fn private_file(metadata: &Metadata) -> Result<(), String> {
    if !metadata.is_file()
        || metadata.len() > MAX_BYTES as u64
        || metadata.nlink() != 1
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o777 != 0o600
    {
        return Err("map custody record is not a bounded private regular file".into());
    }
    Ok(())
}

fn same_snapshot(left: &Metadata, right: &Metadata) -> bool {
    left.dev() == right.dev()
        && left.ino() == right.ino()
        && left.mode() == right.mode()
        && left.uid() == right.uid()
        && left.nlink() == right.nlink()
        && left.len() == right.len()
        && left.mtime() == right.mtime()
        && left.mtime_nsec() == right.mtime_nsec()
        && left.ctime() == right.ctime()
        && left.ctime_nsec() == right.ctime_nsec()
}

fn valid_leaf(leaf: &str) -> bool {
    let Some(stem) = leaf.strip_suffix(".json") else {
        return false;
    };
    let Some((scope, generation)) = stem.split_once('.') else {
        return false;
    };
    let hex = |value: &str| {
        value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    };
    scope.len() == 64 && generation.len() == 32 && hex(scope) && hex(generation)
}

/// Bounded no-follow read, retaining the opened record for issuance comparison.
pub(crate) fn read_record(
    directory: &CompilerPinDirectory,
    leaf: &str,
) -> Result<(File, Vec<u8>), String> {
    read_at(directory, leaf, || Ok(()))
}

fn read_at(
    directory: &CompilerPinDirectory,
    leaf: &str,
    after_read: impl FnOnce() -> Result<(), String>,
) -> Result<(File, Vec<u8>), String> {
    if !valid_leaf(leaf) {
        return Err("invalid map custody record leaf".into());
    }
    directory.verify()?;
    let path = directory.path().join(leaf);
    let named = std::fs::symlink_metadata(&path)
        .map_err(|error| format!("inspect map custody record: {error}"))?;
    private_file(&named)?;
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&path)
        .map_err(|error| format!("open map custody record: {error}"))?;
    let before = file.metadata().map_err(|error| error.to_string())?;
    private_file(&before)?;
    if !same_snapshot(&named, &before) {
        return Err("map custody record changed while opening".into());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("read map custody record: {error}"))?;
    after_read()?;
    let after = file.metadata().map_err(|error| error.to_string())?;
    let named_after = std::fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
    if bytes.len() > MAX_BYTES
        || bytes.len() as u64 != before.len()
        || !same_snapshot(&before, &after)
        || !same_snapshot(&after, &named_after)
    {
        return Err("map custody record changed during bounded read".into());
    }
    directory.verify()?;
    Ok((file, bytes))
}

/// Compare persisted bytes and object identity to a live held record (including
/// its original writer), never a caller-supplied serialized file identity.
pub(crate) fn verify_held_record(
    directory: &CompilerPinDirectory,
    leaf: &str,
    written: &File,
    expected: &[u8],
) -> Result<(), String> {
    let before = written.metadata().map_err(|error| error.to_string())?;
    let (read, bytes) = read_record(directory, leaf)?;
    let read_metadata = read.metadata().map_err(|error| error.to_string())?;
    let after = written.metadata().map_err(|error| error.to_string())?;
    if bytes != expected
        || !same_snapshot(&before, &read_metadata)
        || !same_snapshot(&before, &after)
    {
        return Err("map custody record readback differs from native write".into());
    }
    Ok(())
}

#[cfg(test)]
#[path = "map_custody_record_tests.rs"]
mod tests;
