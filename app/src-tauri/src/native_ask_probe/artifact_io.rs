//! Filesystem ownership checks for explicit native QA artifact preparation.

use super::require;
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

#[cfg(unix)]
pub(super) fn identity(metadata: &std::fs::Metadata) -> (u64, u64, u64, i64, i64, u64) {
    (
        metadata.dev(),
        metadata.ino(),
        metadata.nlink(),
        metadata.ctime(),
        metadata.ctime_nsec(),
        metadata.len(),
    )
}

pub(super) fn open_directory(path: &Path) -> Result<std::fs::File, String> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW);
    }
    options.open(path).map_err(|error| error.to_string())
}

#[cfg(unix)]
pub(super) fn create_owner(
    directory: &Path,
    parent: &std::fs::File,
) -> Result<(PathBuf, std::fs::File), String> {
    use std::os::fd::AsRawFd;
    verify_directory(directory, parent, false)?;
    let mut entropy = [0_u8; 16];
    getrandom::fill(&mut entropy).map_err(|error| format!("control stage entropy: {error}"))?;
    let basename = format!(
        "native-ask-control-{}",
        entropy
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    );
    let name = std::ffi::CString::new(basename.as_bytes())
        .map_err(|_| "control stage name contains NUL")?;
    // No path-based mkdir or automatic recursive cleanup in the QA owner.
    if unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
        return Err(format!(
            "control stage creation: {}",
            std::io::Error::last_os_error()
        ));
    }
    let mut created = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe {
        libc::fstatat(
            parent.as_raw_fd(),
            name.as_ptr(),
            created.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return Err(format!(
            "control stage identity: {}",
            std::io::Error::last_os_error()
        ));
    }
    // fstatat initialized every stat field on success.
    let created = unsafe { created.assume_init() };
    let path = directory.join(basename);
    let held = open_owned_directory(parent, &path, (created.st_dev as u64, created.st_ino))?;
    verify_directory(directory, parent, false)?;
    Ok((path, held))
}

#[cfg(unix)]
pub(super) fn open_owned_directory(
    parent: &std::fs::File,
    path: &Path,
    expected: (u64, u64),
) -> Result<std::fs::File, String> {
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    let name = std::ffi::CString::new(
        path.file_name()
            .ok_or("stage directory name unavailable")?
            .as_bytes(),
    )
    .map_err(|_| "stage directory name contains NUL")?;
    let descriptor = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if descriptor < 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    // openat returned a new owned directory descriptor.
    let held = unsafe { std::fs::File::from_raw_fd(descriptor) };
    let opened = held.metadata().map_err(|error| error.to_string())?;
    require(
        (opened.dev(), opened.ino()) == expected,
        "control stage changed before initial descriptor admission",
    )?;
    verify_directory(path, &held, true)?;
    Ok(held)
}

#[cfg(not(unix))]
pub(super) fn create_owner(
    directory: &Path,
    parent: &std::fs::File,
) -> Result<(PathBuf, std::fs::File), String> {
    verify_directory(directory, parent, false)?;
    let path = tempfile::Builder::new()
        .prefix("native-ask-control-")
        .tempdir_in(directory)
        .map_err(|error| error.to_string())?
        .keep();
    let held = open_directory(&path)?;
    Ok((path, held))
}

pub(super) fn verify_directory(
    path: &Path,
    held: &std::fs::File,
    is_private: bool,
) -> Result<(), String> {
    let named = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    let opened = held.metadata().map_err(|error| error.to_string())?;
    require(
        named.is_dir() && opened.is_dir() && !named.file_type().is_symlink(),
        "control directory is not a regular directory",
    )?;
    #[cfg(unix)]
    require(
        (named.dev(), named.ino(), named.uid(), named.mode())
            == (opened.dev(), opened.ino(), opened.uid(), opened.mode())
            && opened.uid() == unsafe { libc::geteuid() }
            && (!is_private || opened.mode() & 0o777 == 0o700),
        "control directory ownership or private permissions changed",
    )?;
    #[cfg(not(unix))]
    let _ = is_private;
    Ok(())
}

pub(super) fn close_stage(
    owner: &Path,
    directory: &Path,
    parent: &std::fs::File,
    stage: &std::fs::File,
    artifact: Option<&std::fs::File>,
) -> Result<(), String> {
    // Ownership paths have no automatic cleanup. Replacements remain untouched.
    verify_directory(directory, parent, false)?;
    verify_directory(owner, stage, true)?;
    let partial = owner.join("artifact.part");
    if let Some(artifact) = artifact {
        match std::fs::symlink_metadata(&partial) {
            Ok(named) => {
                verify_destination(&partial, artifact, &named)?;
                remove_entry(stage, &partial, false)?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("control stage inspection: {error}")),
        }
    }
    verify_directory(directory, parent, false)?;
    verify_directory(owner, stage, true)?;
    // Only an empty owned directory may be removed; never recursively delete.
    remove_entry(parent, owner, true)
}

#[cfg(unix)]
fn remove_entry(parent: &std::fs::File, path: &Path, is_directory: bool) -> Result<(), String> {
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStrExt;
    let name = std::ffi::CString::new(
        path.file_name()
            .ok_or("cleanup filename unavailable")?
            .as_bytes(),
    )
    .map_err(|_| "cleanup filename contains NUL")?;
    let flags = if is_directory { libc::AT_REMOVEDIR } else { 0 };
    if unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), flags) } != 0 {
        return Err(format!(
            "control stage cleanup: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(not(unix))]
fn remove_entry(_parent: &std::fs::File, path: &Path, is_directory: bool) -> Result<(), String> {
    if is_directory {
        std::fs::remove_dir(path)
    } else {
        std::fs::remove_file(path)
    }
    .map_err(|error| format!("control stage cleanup: {error}"))
}

pub(super) fn verify_destination(
    target: &Path,
    published: &std::fs::File,
    before: &std::fs::Metadata,
) -> Result<(), String> {
    let named = std::fs::symlink_metadata(target).map_err(|error| error.to_string())?;
    let held = published.metadata().map_err(|error| error.to_string())?;
    require(
        named.is_file() && !named.file_type().is_symlink() && held.is_file(),
        "control destination is not a regular non-symlink file",
    )?;
    #[cfg(unix)]
    require(
        identity(&named) == identity(before) && identity(&held) == identity(before),
        "control destination changed during native verification",
    )?;
    #[cfg(not(unix))]
    require(
        named.len() == before.len() && held.len() == before.len(),
        "control destination size changed during native verification",
    )?;
    Ok(())
}

#[cfg(target_os = "macos")]
pub(super) fn create_stage(
    input: &std::fs::File,
    parent: &std::fs::File,
    path: &Path,
) -> Result<std::fs::File, String> {
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    verify_directory(
        path.parent().ok_or("control stage has no parent")?,
        parent,
        false,
    )?;
    let name = std::ffi::CString::new(
        path.file_name()
            .ok_or("control stage has no filename")?
            .as_bytes(),
    )
    .map_err(|_| "control stage filename contains NUL")?;
    // Clone the held source into an absent name under the private stage owner.
    // No streaming fallback: large QA weights must not exhaust a small volume.
    let result =
        unsafe { libc::fclonefileat(input.as_raw_fd(), parent.as_raw_fd(), name.as_ptr(), 0) };
    if result != 0 {
        return Err(format!(
            "control copy-on-write preparation failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    let descriptor = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )
    };
    if descriptor < 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    // openat returned a new owned descriptor, including when the path was renamed.
    Ok(unsafe { std::fs::File::from_raw_fd(descriptor) })
}

#[cfg(not(target_os = "macos"))]
pub(super) fn create_stage(
    _input: &std::fs::File,
    parent: &std::fs::File,
    path: &Path,
) -> Result<std::fs::File, String> {
    verify_directory(
        path.parent().ok_or("control stage has no parent")?,
        parent,
        false,
    )?;
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
pub(super) fn publish_stage(
    output: std::fs::File,
    stage: &std::fs::File,
    directory: &std::fs::File,
    staging: &Path,
    target: &Path,
) -> Result<std::fs::File, String> {
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStrExt;
    let source = std::ffi::CString::new(
        staging
            .file_name()
            .ok_or("stage filename unavailable")?
            .as_bytes(),
    )
    .map_err(|_| "stage filename contains NUL")?;
    let destination = std::ffi::CString::new(
        target
            .file_name()
            .ok_or("target filename unavailable")?
            .as_bytes(),
    )
    .map_err(|_| "target filename contains NUL")?;
    // Keep both namespaces bound to held directories and never replace an entry.
    if unsafe {
        libc::renameatx_np(
            stage.as_raw_fd(),
            source.as_ptr(),
            directory.as_raw_fd(),
            destination.as_ptr(),
            libc::RENAME_EXCL,
        )
    } != 0
    {
        return Err(format!(
            "isolated control publication refused: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(output)
}

#[cfg(not(target_os = "macos"))]
pub(super) fn publish_stage(
    output: std::fs::File,
    _stage: &std::fs::File,
    _directory: &std::fs::File,
    staging: &Path,
    target: &Path,
) -> Result<std::fs::File, String> {
    let mut path = tempfile::TempPath::try_from_path(staging).map_err(|error| error.to_string())?;
    path.disable_cleanup(true);
    tempfile::NamedTempFile::from_parts(output, path)
        .persist_noclobber(target)
        .map_err(|error| format!("isolated control publication refused: {}", error.error))
}
