//! Current app-private file pins only; the caller validates native retirement eligibility.
//! The writer guard does not transact arbitrary external directory-entry changes.

use super::{CompilerPinDirectory, RecordedFileIdentity};
use std::sync::MutexGuard;
#[cfg(unix)]
use std::{fs::File, path::PathBuf};

#[cfg(unix)]
const MAX_BYTES: usize = 4 * 1024 * 1024;

/// A fresh physical pin, never a restored write, completion or section-ownership receipt.
#[derive(Debug)]
pub(crate) struct CompilerRetiredFilePin {
    #[cfg(unix)]
    directory: CompilerPinDirectory,
    #[cfg(unix)]
    leaf: String,
    #[cfg(unix)]
    held: File,
    #[cfg(unix)]
    identity: RecordedFileIdentity,
    #[cfg(unix)]
    bytes: u64,
    #[cfg(unix)]
    revision: String,
    #[cfg(not(unix))]
    _unsupported: (),
}

/// Capture only a bounded native-generation leaf in the checked private directory.
/// None means checked initial absence; this does not classify a file as eligible for cleanup.
pub(crate) fn capture_compiler_retired_file_locked(
    _guard: &MutexGuard<'_, ()>,
    directory: &CompilerPinDirectory,
    leaf: &str,
) -> Result<Option<CompilerRetiredFilePin>, String> {
    #[cfg(unix)]
    {
        validate_leaf(leaf)?;
        directory.verify()?;
        let path = directory.path().join(leaf);
        let named = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                directory.verify()?;
                return match std::fs::symlink_metadata(&path) {
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
                    Ok(_) => Err("retired compiler file appeared during absence check".into()),
                    Err(error) => Err(format!("recheck retired compiler absence: {error}")),
                };
            }
            Err(error) => return Err(format!("inspect retired compiler file: {error}")),
        };
        validate_metadata(&named)?;
        let held = super::compiler_pin::open_file(&path)?;
        let actual = held
            .metadata()
            .map_err(|error| format!("inspect retired compiler handle: {error}"))?;
        validate_metadata(&actual)?;
        if super::recorded_identity(&named) != super::recorded_identity(&actual)
            || named.len() != actual.len()
        {
            return Err("retired compiler file changed while capturing".into());
        }
        let identity = super::recorded_identity(&actual)
            .ok_or("retired compiler file identity is unsupported")?;
        let mut pin = CompilerRetiredFilePin {
            directory: directory.clone(),
            leaf: leaf.into(),
            held,
            identity,
            bytes: actual.len(),
            revision: String::new(),
        };
        pin.revision = read_current(&pin)?.1;
        Ok(Some(pin))
    }
    #[cfg(not(unix))]
    {
        let _ = (directory, leaf);
        Err("compiler retirement is unsupported on this platform".into())
    }
}

/// Return actual current data and identity; expected descriptor ownership is checked by the caller.
pub(crate) fn read_compiler_retired_file_pin_locked(
    _guard: &MutexGuard<'_, ()>,
    pin: &CompilerRetiredFilePin,
) -> Result<(String, String, RecordedFileIdentity), String> {
    #[cfg(unix)]
    {
        let (text, revision) = read_current(pin)?;
        if revision != pin.revision {
            return Err("retired compiler pinned bytes changed".into());
        }
        Ok((text, revision, pin.identity.clone()))
    }
    #[cfg(not(unix))]
    {
        let _ = pin;
        Err("compiler retirement is unsupported on this platform".into())
    }
}

/// Remove only this fresh pinned private file, after the caller validates its retirement descriptor.
/// No queue save or earlier authority lock may be acquired while the common writer guard is held.
pub(crate) fn unlink_compiler_retired_file_pin_locked(
    guard: &MutexGuard<'_, ()>,
    pin: &CompilerRetiredFilePin,
    expected_sha256: &str,
) -> Result<(), String> {
    #[cfg(unix)]
    {
        unlink_current(
            guard,
            pin,
            expected_sha256,
            #[cfg(test)]
            |_| Ok(()),
        )
    }
    #[cfg(not(unix))]
    {
        let _ = (guard, pin, expected_sha256);
        Err("compiler retirement is unsupported on this platform".into())
    }
}

#[cfg(unix)]
fn validate_leaf(leaf: &str) -> Result<(), String> {
    let fields: Vec<_> = leaf.split('.').collect();
    let valid = match fields.as_slice() {
        [key, nonce, "anchor"]
        | [key, nonce, "baseline", "txt"]
        | [key, nonce, "record", "json"] => is_hex(key, 64) && is_hex(nonce, 32),
        _ => false,
    };
    if !valid {
        return Err("retired compiler target must be an exact native-generation leaf".into());
    }
    Ok(())
}

#[cfg(unix)]
fn is_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(unix)]
fn validate_metadata(metadata: &std::fs::Metadata) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_BYTES as u64
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o7777 != 0o600
        || metadata.nlink() != 1
    {
        return Err("retired compiler file type, owner, mode, size or link count is unsafe".into());
    }
    Ok(())
}

#[cfg(unix)]
fn path(pin: &CompilerRetiredFilePin) -> PathBuf {
    pin.directory.path().join(&pin.leaf)
}

#[cfg(unix)]
fn verify_current(pin: &CompilerRetiredFilePin) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    pin.directory.verify()?;
    let named = std::fs::symlink_metadata(path(pin))
        .map_err(|error| format!("inspect pinned retired compiler file: {error}"))?;
    let held = pin
        .held
        .metadata()
        .map_err(|error| format!("inspect pinned retired compiler handle: {error}"))?;
    validate_metadata(&named)?;
    validate_metadata(&held)?;
    let directory = std::fs::symlink_metadata(pin.directory.path())
        .map_err(|error| format!("inspect retired compiler directory device: {error}"))?;
    if super::recorded_identity(&named).as_ref() != Some(&pin.identity)
        || super::recorded_identity(&held).as_ref() != Some(&pin.identity)
        || named.len() != pin.bytes
        || held.len() != pin.bytes
        || held.dev() != directory.dev()
    {
        return Err("retired compiler pinned identity or size changed".into());
    }
    Ok(())
}

#[cfg(unix)]
fn read_current(pin: &CompilerRetiredFilePin) -> Result<(String, String), String> {
    use sha2::{Digest, Sha256};
    use std::os::unix::fs::FileExt;
    verify_current(pin)?;
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let limit = (MAX_BYTES + 1 - bytes.len()).min(chunk.len());
        let count = pin
            .held
            .read_at(&mut chunk[..limit], bytes.len() as u64)
            .map_err(|error| format!("read retired compiler file: {error}"))?;
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..count]);
        if bytes.len() > MAX_BYTES {
            return Err("retired compiler file grew beyond 4 MiB".into());
        }
    }
    verify_current(pin)?;
    if bytes.len() as u64 != pin.bytes {
        return Err("retired compiler file length changed during read".into());
    }
    let revision = format!("{:x}", Sha256::digest(&bytes));
    let text = String::from_utf8(bytes).map_err(|_| "retired compiler file is not UTF-8")?;
    if text.contains('\0') {
        return Err("retired compiler file contains NUL".into());
    }
    Ok((text, revision))
}

#[cfg(all(test, unix))]
enum RetirementCheckpoint {
    BeforeRecheck,
    Unlinked,
}

#[cfg(unix)]
fn unlink_current(
    guard: &MutexGuard<'_, ()>,
    pin: &CompilerRetiredFilePin,
    expected: &str,
    #[cfg(test)] mut checkpoint: impl FnMut(RetirementCheckpoint) -> Result<(), String>,
) -> Result<(), String> {
    if !is_hex(expected, 64) || expected != pin.revision {
        return Err("retired compiler file SHA does not match the required cleanup image".into());
    }
    #[cfg(test)]
    checkpoint(RetirementCheckpoint::BeforeRecheck)?;
    let (_, revision, _) = read_compiler_retired_file_pin_locked(guard, pin)?;
    if revision != expected {
        return Err("retired compiler file changed before unlink".into());
    }
    verify_current(pin)?;
    std::fs::remove_file(path(pin))
        .map_err(|error| format!("unlink retired compiler file failed: {error}"))?;
    #[cfg(test)]
    checkpoint(RetirementCheckpoint::Unlinked).map_err(|error| {
        format!("retired compiler file unlinked; acknowledgement incomplete: {error}")
    })?;
    pin.directory.sync().map_err(|error| {
        format!("retired compiler file unlinked; directory acknowledgement incomplete: {error}")
    })
}

#[cfg(all(test, unix))]
#[path = "vault_compiler_retirement_tests.rs"]
mod tests;
