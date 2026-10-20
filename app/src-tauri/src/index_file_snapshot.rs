//! One bounded read binds cache freshness and decoding to the same file bytes.

use std::fs::{File, Metadata, OpenOptions};
use std::io::Read;
use std::path::Path;
use std::time::SystemTime;

use sha2::{Digest, Sha256};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct IndexFileRevision {
    modified: SystemTime,
    len: u64,
    digest: [u8; 32],
}

#[derive(Debug)]
pub(crate) struct IndexFileSnapshot {
    pub(crate) bytes: Vec<u8>,
    pub(crate) revision: IndexFileRevision,
}

fn regular(metadata: &Metadata) -> bool {
    metadata.is_file() && !metadata.file_type().is_symlink()
}

fn same_read_identity(left: &Metadata, right: &Metadata) -> bool {
    if !regular(left)
        || !regular(right)
        || left.len() != right.len()
        || left.modified().ok() != right.modified().ok()
    {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        (
            left.dev(),
            left.ino(),
            left.ctime(),
            left.ctime_nsec(),
            left.nlink(),
        ) == (
            right.dev(),
            right.ino(),
            right.ctime(),
            right.ctime_nsec(),
            right.nlink(),
        )
    }
    #[cfg(not(unix))]
    true
}

/// Absence is distinct from an unreadable, replaced, or non-regular index file.
pub(crate) fn read_snapshot(path: &Path) -> Result<Option<IndexFileSnapshot>, String> {
    read_snapshot_after_open(path, |_| {})
}

fn read_snapshot_after_open(
    path: &Path,
    after_open: impl FnOnce(&File),
) -> Result<Option<IndexFileSnapshot>, String> {
    let named = match std::fs::symlink_metadata(path) {
        Ok(metadata) if regular(&metadata) => metadata,
        Ok(_) => return Err("index file is not a regular file".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("inspect index file: {error}")),
    };
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // A replacement FIFO must not block open; a leaf symlink is never followed.
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut file = options
        .open(path)
        .map_err(|error| format!("open index file: {error}"))?;
    let before = file
        .metadata()
        .map_err(|error| format!("inspect opened index file: {error}"))?;
    if !same_read_identity(&named, &before) {
        return Err("index file changed while opening".into());
    }
    let modified = before
        .modified()
        .map_err(|error| format!("inspect index modification time: {error}"))?;
    let limit = before
        .len()
        .checked_add(1)
        .ok_or("index read length overflow")?;
    after_open(&file);
    let mut bytes = Vec::new();
    // Bound a growing file by its initially observed size plus one witness byte.
    file.by_ref()
        .take(limit)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("read index file: {error}"))?;
    let after = file
        .metadata()
        .map_err(|error| format!("inspect read index file: {error}"))?;
    let named_after = std::fs::symlink_metadata(path)
        .map_err(|error| format!("inspect index file after read: {error}"))?;
    if bytes.len() as u64 != before.len()
        || !same_read_identity(&before, &after)
        || !same_read_identity(&after, &named_after)
    {
        return Err("index file changed during read".into());
    }
    let revision = IndexFileRevision {
        modified,
        len: before.len(),
        digest: Sha256::digest(&bytes).into(),
    };
    Ok(Some(IndexFileSnapshot { bytes, revision }))
}

#[cfg(test)]
#[path = "index_file_snapshot_tests.rs"]
mod tests;
