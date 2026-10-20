//! Physical compiler custody only; journals and fresh section authority belong to the caller.

use super::RecordedWriteReceipt;
use std::path::{Path, PathBuf};
use std::sync::MutexGuard;
#[cfg(unix)]
use std::{fs::File, io::Read, sync::Arc};

#[cfg(unix)]
const MAX_BYTES: usize = 4 * 1024 * 1024;

/// A checked existing native private directory, never a serialized permission flag.
#[derive(Clone, Debug)]
pub(crate) struct CompilerPinDirectory {
    path: PathBuf,
    #[cfg(unix)]
    held: Arc<File>,
}

impl CompilerPinDirectory {
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn verify(&self) -> Result<(), String> {
        #[cfg(unix)]
        {
            let named = directory_metadata(&self.path, true)?;
            let held = self
                .held
                .metadata()
                .map_err(|e| format!("inspect held compiler store: {e}"))?;
            if !same_directory(&named, &held) {
                return Err("compiler pin directory identity changed".into());
            }
            Ok(())
        }
        #[cfg(not(unix))]
        Err("compiler inode custody is unsupported on this platform".into())
    }

    pub(crate) fn sync(&self) -> Result<(), String> {
        self.verify()?;
        #[cfg(unix)]
        self.held
            .sync_all()
            .map_err(|e| format!("compiler pin directory sync failed; custody retained: {e}"))?;
        self.verify()
    }
}

/// Update-only physical CAS pin. It is neither a write receipt nor section ownership.
#[derive(Clone, Debug)]
pub(crate) struct CompilerPriorFilePin {
    #[cfg(unix)]
    path: PathBuf,
    #[cfg(unix)]
    held: Arc<File>,
    #[cfg(unix)]
    anchor: Option<Arc<CompilerAnchorLease>>,
}

#[cfg(unix)]
#[derive(Debug)]
pub(super) struct CompilerAnchorLease {
    directory: CompilerPinDirectory,
    canonical: PathBuf,
    leaf: String,
    held: Arc<File>,
}

/// Open only a caller-selected trusted app-data directory; this does not trust vault JSON.
pub(crate) fn open_compiler_pin_directory(path: &Path) -> Result<CompilerPinDirectory, String> {
    #[cfg(unix)]
    {
        let held = open_directory(path, true)?;
        let directory = CompilerPinDirectory {
            path: path.into(),
            held: Arc::new(held),
        };
        directory.verify()?;
        Ok(directory)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Err("compiler inode custody is unsupported on this platform".into())
    }
}

/// Narrow an actual live receipt to physical update custody, without granting completion.
pub(crate) fn compiler_prior_from_receipt(
    receipt: &RecordedWriteReceipt,
) -> Result<CompilerPriorFilePin, String> {
    #[cfg(unix)]
    {
        Ok(CompilerPriorFilePin {
            path: receipt.path.clone(),
            held: Arc::clone(&receipt.file_handle),
            anchor: receipt.retained_anchor.clone(),
        })
    }
    #[cfg(not(unix))]
    {
        let _ = receipt;
        Err("compiler inode custody is unsupported on this platform".into())
    }
}

/// Pin an unmarked legacy page physically; only the caller can validate its initial append policy.
pub(crate) fn capture_compiler_initial_file_pin_locked(
    _guard: &MutexGuard<'_, ()>,
    path: &Path,
) -> Result<CompilerPriorFilePin, String> {
    #[cfg(unix)]
    {
        let pin = CompilerPriorFilePin {
            path: path.into(),
            held: Arc::new(open_file(path)?),
            anchor: None,
        };
        read_prior(&pin)?;
        Ok(pin)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Err("compiler inode custody is unsupported on this platform".into())
    }
}

/// Reopen exact physical custody after the caller authenticates its private issuance journal.
/// This never recreates an old RecordedWriteReceipt or an old compiler grant.
pub(crate) fn reopen_compiler_prior_file_pin(
    path: &Path,
    directory: &CompilerPinDirectory,
    anchor_leaf: &str,
) -> Result<CompilerPriorFilePin, String> {
    #[cfg(unix)]
    {
        directory.verify()?;
        let anchor_path = anchor_path(directory, anchor_leaf)?;
        let pin = CompilerPriorFilePin {
            path: path.into(),
            held: Arc::new(open_file(path)?),
            anchor: Some(Arc::new(CompilerAnchorLease {
                directory: directory.clone(),
                canonical: path.into(),
                leaf: anchor_leaf.into(),
                held: Arc::new(open_file(&anchor_path)?),
            })),
        };
        read_prior(&pin)?;
        Ok(pin)
    }
    #[cfg(not(unix))]
    {
        let _ = (path, directory, anchor_leaf);
        Err("compiler inode custody is unsupported on this platform".into())
    }
}

/// Caller holds the common writer guard through this read and the subsequent exact-inode CAS.
pub(crate) fn read_compiler_prior_file_pin_locked(
    _guard: &MutexGuard<'_, ()>,
    pin: &CompilerPriorFilePin,
) -> Result<(String, String), String> {
    #[cfg(unix)]
    {
        read_prior(pin)
    }
    #[cfg(not(unix))]
    {
        let _ = pin;
        Err("compiler inode custody is unsupported on this platform".into())
    }
}

/// Write a newly issued anchored receipt. Some/Some replaces the pinned inode;
/// None/None creates only if absent. The guard must not be held through Pending::save.
pub(crate) fn write_compiler_file_anchored_locked(
    _guard: &MutexGuard<'_, ()>,
    path: &str,
    content: &str,
    prior: Option<&CompilerPriorFilePin>,
    expected_sha256: Option<&str>,
    directory: &CompilerPinDirectory,
    anchor_leaf: &str,
) -> Result<RecordedWriteReceipt, String> {
    #[cfg(unix)]
    {
        write_anchored(
            Path::new(path),
            content,
            prior,
            expected_sha256,
            directory,
            anchor_leaf,
            #[cfg(test)]
            |_| Ok(()),
        )
    }
    #[cfg(not(unix))]
    {
        let _ = (
            path,
            content,
            prior,
            expected_sha256,
            directory,
            anchor_leaf,
        );
        Err("compiler inode custody is unsupported on this platform".into())
    }
}

impl RecordedWriteReceipt {
    /// Compare the exact private native issuance, not just reproducible public JSON fields.
    pub(crate) fn same_native_issuance(&self, other: &Self) -> bool {
        if self.path != other.path
            || self.revision != other.revision
            || self.file_identity != other.file_identity
            || self.native_created != other.native_created
        {
            return false;
        }
        #[cfg(unix)]
        {
            Arc::ptr_eq(&self.file_handle, &other.file_handle)
                && match (&self.retained_anchor, &other.retained_anchor) {
                    (None, None) => true,
                    (Some(left), Some(right)) => Arc::ptr_eq(left, right),
                    _ => false,
                }
        }
        #[cfg(not(unix))]
        false
    }

    pub(crate) fn compiler_anchor_leaf(&self) -> Option<&str> {
        #[cfg(unix)]
        {
            self.retained_anchor
                .as_ref()
                .map(|anchor| anchor.leaf.as_str())
        }
        #[cfg(not(unix))]
        {
            None
        }
    }
}

#[cfg(unix)]
fn directory_metadata(path: &Path, private: bool) -> Result<std::fs::Metadata, String> {
    use std::os::unix::fs::MetadataExt;
    if !path.is_absolute() {
        return Err("compiler custody path must be absolute".into());
    }
    let mut current = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::RootDir | std::path::Component::Normal(_) => {
                current.push(component.as_os_str())
            }
            _ => return Err("compiler custody path is not a canonical native path".into()),
        }
        let metadata = std::fs::symlink_metadata(&current)
            .map_err(|e| format!("inspect compiler directory: {e}"))?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("compiler custody directory contains a symlink or non-directory".into());
        }
    }
    let metadata =
        std::fs::symlink_metadata(path).map_err(|e| format!("inspect compiler store: {e}"))?;
    if private && (metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o777 != 0o700)
    {
        return Err("compiler pin directory ownership or permissions are unsafe".into());
    }
    Ok(metadata)
}

#[cfg(unix)]
fn same_directory(left: &std::fs::Metadata, right: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    left.is_dir()
        && right.is_dir()
        && left.dev() == right.dev()
        && left.ino() == right.ino()
        && left.uid() == right.uid()
}

#[cfg(unix)]
fn open_directory(path: &Path, private: bool) -> Result<File, String> {
    use std::os::unix::fs::OpenOptionsExt;
    let named = directory_metadata(path, private)?;
    let held = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY)
        .open(path)
        .map_err(|e| format!("open compiler directory: {e}"))?;
    if !same_directory(&named, &held.metadata().map_err(|e| e.to_string())?)
        || !same_directory(&named, &directory_metadata(path, private)?)
    {
        return Err("compiler custody directory changed while opening".into());
    }
    Ok(held)
}

#[cfg(unix)]
pub(super) fn open_file(path: &Path) -> Result<File, String> {
    open_file_with_checkpoint(
        path,
        #[cfg(test)]
        || Ok(()),
    )
}

#[cfg(unix)]
fn open_file_with_checkpoint(
    path: &Path,
    #[cfg(test)] before_open: impl FnOnce() -> Result<(), String>,
) -> Result<File, String> {
    use std::os::unix::fs::OpenOptionsExt;
    directory_metadata(path.parent().ok_or("compiler file has no parent")?, false)?;
    let named =
        std::fs::symlink_metadata(path).map_err(|e| format!("inspect compiler file: {e}"))?;
    if !named.file_type().is_file() {
        return Err("compiler custody target is not a regular file".into());
    }
    #[cfg(test)]
    before_open()?;
    let held = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|e| format!("open compiler file: {e}"))?;
    let actual = held.metadata().map_err(|e| e.to_string())?;
    if !actual.is_file() || super::recorded_identity(&named) != super::recorded_identity(&actual) {
        return Err("compiler file identity changed while opening".into());
    }
    Ok(held)
}

#[cfg(unix)]
fn anchor_path(directory: &CompilerPinDirectory, leaf: &str) -> Result<PathBuf, String> {
    if leaf.is_empty()
        || leaf.len() > 255
        || leaf.contains("..")
        || !leaf
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        || leaf == "."
    {
        return Err("compiler anchor must be a single native leaf".into());
    }
    Ok(directory.path.join(leaf))
}

#[cfg(unix)]
fn same_file(left: &std::fs::Metadata, right: &std::fs::Metadata, links: u64) -> bool {
    use std::os::unix::fs::MetadataExt;
    left.is_file()
        && right.is_file()
        && left.dev() == right.dev()
        && left.ino() == right.ino()
        && left.nlink() == links
        && right.nlink() == links
}

#[cfg(unix)]
fn verify_pin(pin: &CompilerPriorFilePin) -> Result<std::fs::Metadata, String> {
    let held = pin
        .held
        .metadata()
        .map_err(|e| format!("inspect held compiler file: {e}"))?;
    directory_metadata(
        pin.path.parent().ok_or("compiler file has no parent")?,
        false,
    )?;
    let named = std::fs::symlink_metadata(&pin.path)
        .map_err(|e| format!("inspect compiler canonical: {e}"))?;
    let links = if let Some(anchor) = &pin.anchor {
        anchor.directory.verify()?;
        if anchor.canonical != pin.path {
            return Err("compiler anchor canonical path changed".into());
        }
        let named_anchor = std::fs::symlink_metadata(anchor_path(&anchor.directory, &anchor.leaf)?)
            .map_err(|e| format!("inspect compiler anchor: {e}"))?;
        let held_anchor = anchor
            .held
            .metadata()
            .map_err(|e| format!("inspect held compiler anchor: {e}"))?;
        if !same_file(&held, &named_anchor, 2) || !same_file(&held, &held_anchor, 2) {
            return Err("compiler anchor identity or link count changed".into());
        }
        2
    } else {
        1
    };
    if !same_file(&held, &named, links) {
        return Err("compiler canonical identity or link count changed".into());
    }
    Ok(held)
}

#[cfg(unix)]
fn read_prior(pin: &CompilerPriorFilePin) -> Result<(String, String), String> {
    use sha2::{Digest, Sha256};
    let before = verify_pin(pin)?;
    if before.len() > MAX_BYTES as u64 {
        return Err("compiler retained file size changed beyond 4 MiB".into());
    }
    let mut file = open_file(&pin.path)?;
    if super::recorded_identity(&before)
        != super::recorded_identity(&file.metadata().map_err(|e| e.to_string())?)
    {
        return Err("compiler file changed before read".into());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("read compiler file: {e}"))?;
    let after = verify_pin(pin)?;
    if bytes.len() > MAX_BYTES
        || before.len() != after.len()
        || super::recorded_identity(&before) != super::recorded_identity(&after)
        || super::recorded_identity(&after)
            != super::recorded_identity(&file.metadata().map_err(|e| e.to_string())?)
    {
        return Err("compiler file changed during bounded read".into());
    }
    let revision = format!("{:x}", Sha256::digest(&bytes));
    Ok((
        String::from_utf8(bytes).map_err(|_| "compiler retained file is not UTF-8")?,
        revision,
    ))
}

#[cfg(unix)]
pub(super) fn read_anchored_receipt(
    receipt: &RecordedWriteReceipt,
) -> Result<(String, String), String> {
    if receipt.retained_anchor.is_none() {
        return Err("compiler receipt has no retained anchor".into());
    }
    read_prior(&compiler_prior_from_receipt(receipt)?)
}

#[cfg(unix)]
pub(super) fn verify_anchored_receipt(receipt: &RecordedWriteReceipt) -> Result<(), String> {
    let identity = receipt
        .file_identity
        .as_ref()
        .ok_or("compiler receipt lacks native identity")?;
    if super::recorded_identity(&receipt.file_handle.metadata().map_err(|e| e.to_string())?)
        .as_ref()
        != Some(identity)
    {
        return Err("compiler receipt identity changed".into());
    }
    let (_, revision) = read_anchored_receipt(receipt)?;
    if revision != receipt.revision
        || super::recorded_identity(&receipt.file_handle.metadata().map_err(|e| e.to_string())?)
            .as_ref()
            != Some(identity)
    {
        return Err("compiler receipt bytes or identity changed".into());
    }
    Ok(())
}

#[cfg(unix)]
fn check_prior(
    path: &Path,
    prior: Option<&CompilerPriorFilePin>,
    expected: Option<&str>,
) -> Result<(), String> {
    match (prior, expected) {
        (Some(pin), Some(hash))
            if pin.path == path
                && hash.len() == 64
                && hash
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) =>
        {
            if read_prior(pin)?.1 != hash {
                return Err("compiler write conflict: bytes changed since read".into());
            }
            Ok(())
        }
        (None, None) => match std::fs::symlink_metadata(path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Ok(_) => Err("compiler write conflict: creation target already exists".into()),
            Err(error) => Err(format!("inspect compiler creation target: {error}")),
        },
        _ => Err(
            "compiler write requires an exact prior pin and SHA, or absence-only creation".into(),
        ),
    }
}

#[cfg(unix)]
#[cfg(test)]
enum PinCheckpoint {
    Pinned,
    Persisted,
}

#[cfg(unix)]
fn write_anchored(
    path: &Path,
    content: &str,
    prior: Option<&CompilerPriorFilePin>,
    expected: Option<&str>,
    directory: &CompilerPinDirectory,
    leaf: &str,
    #[cfg(test)] mut checkpoint: impl FnMut(PinCheckpoint) -> Result<(), String>,
) -> Result<RecordedWriteReceipt, String> {
    use sha2::{Digest, Sha256};
    use std::{io::Write, os::unix::fs::MetadataExt};
    if content.len() > MAX_BYTES {
        return Err("compiler output exceeds 4 MiB".into());
    }
    directory.verify()?;
    let anchor_path = anchor_path(directory, leaf)?;
    if path == anchor_path {
        return Err("compiler canonical cannot be its own anchor".into());
    }
    let parent_path = path.parent().ok_or("compiler output has no parent")?;
    let parent = open_directory(parent_path, false)?;
    if parent.metadata().map_err(|e| e.to_string())?.dev()
        != directory.held.metadata().map_err(|e| e.to_string())?.dev()
    {
        return Err("compiler pin store and output must be on the same filesystem".into());
    }
    check_prior(path, prior, expected)?;
    let mut staged = tempfile::Builder::new()
        .prefix(".myco-tmp-")
        .suffix(".md")
        .tempfile_in(parent_path)
        .map_err(|e| format!("create compiler staging file: {e}"))?;
    staged
        .write_all(content.as_bytes())
        .map_err(|e| format!("write compiler staging file: {e}"))?;
    staged
        .as_file()
        .sync_all()
        .map_err(|e| format!("sync compiler staging file: {e}"))?;
    std::fs::hard_link(staged.path(), &anchor_path)
        .map_err(|e| format!("create non-overwriting compiler anchor: {e}"))?;
    let retained = |error: String| {
        format!("compiler anchored publication failed before canonical persist; source and staged anchor {} retained: {error}", anchor_path.display())
    };
    directory.sync().map_err(retained)?;
    let anchor_file = Arc::new(open_file(&anchor_path).map_err(retained)?);
    let staged_metadata = staged
        .as_file()
        .metadata()
        .map_err(|e| retained(e.to_string()))?;
    if !same_file(
        &staged_metadata,
        &anchor_file
            .metadata()
            .map_err(|e| retained(e.to_string()))?,
        2,
    ) {
        return Err(retained("staged compiler anchor identity changed".into()));
    }
    #[cfg(test)]
    checkpoint(PinCheckpoint::Pinned).map_err(retained)?;
    check_prior(path, prior, expected).map_err(retained)?;
    directory.verify().map_err(retained)?;
    if !same_directory(
        &parent.metadata().map_err(|e| retained(e.to_string()))?,
        &directory_metadata(parent_path, false).map_err(retained)?,
    ) {
        return Err(retained("compiler output parent identity changed".into()));
    }
    let persisted = if prior.is_some() {
        staged.persist(path)
    } else {
        staged.persist_noclobber(path)
    }
    .map_err(|e| retained(format!("canonical persist failed: {}", e.error)))?;
    let retained = |error: String| {
        format!("compiler canonical persisted but admission incomplete; canonical {} and anchor {} retained: {error}", path.display(), anchor_path.display())
    };
    #[cfg(test)]
    checkpoint(PinCheckpoint::Persisted).map_err(retained)?;
    persisted
        .sync_all()
        .map_err(|e| retained(format!("persisted file sync failed: {e}")))?;
    parent
        .sync_all()
        .map_err(|e| retained(format!("canonical parent sync failed: {e}")))?;
    directory.sync().map_err(retained)?;
    if !same_directory(
        &parent.metadata().map_err(|e| retained(e.to_string()))?,
        &directory_metadata(parent_path, false).map_err(retained)?,
    ) {
        return Err(retained(
            "compiler output parent identity changed after persist".into(),
        ));
    }
    let held = Arc::new(persisted);
    let identity = super::recorded_identity(&held.metadata().map_err(|e| retained(e.to_string()))?);
    let receipt = RecordedWriteReceipt {
        path: path.into(),
        revision: format!("{:x}", Sha256::digest(content.as_bytes())),
        file_identity: identity,
        native_created: prior.is_none(),
        file_handle: held,
        retained_anchor: Some(Arc::new(CompilerAnchorLease {
            directory: directory.clone(),
            canonical: path.into(),
            leaf: leaf.into(),
            held: anchor_file,
        })),
    };
    verify_anchored_receipt(&receipt).map_err(retained)?;
    Ok(receipt)
}

#[cfg(all(test, unix))]
#[path = "vault_compiler_pin_tests.rs"]
mod tests;
