//! Retained parent/file identities and bounded UTF-8 deck reads.

use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

pub(super) struct Sources {
    root: File,
    directory: Option<File>,
    file: Option<File>,
    pub(super) revision: Option<String>,
}

pub(super) fn path(root: &Path, requested_root: &Path, requested: &str) -> Result<PathBuf, String> {
    if requested.len() > 8192 || requested.chars().any(char::is_control) {
        return Err("invalid study deck path".into());
    }
    let path = crate::vault::confine_mutation_path(root, requested_root, requested)?;
    if path.parent() != Some(root.join("cards").as_path()) {
        return Err("study deck requires a direct cards/*.md file".into());
    }
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("invalid study deck filename")?;
    if name.len() <= 3 || !name.to_ascii_lowercase().ends_with(".md") {
        return Err("study deck requires a markdown filename".into());
    }
    Ok(path)
}

fn inspect(path: &Path) -> Result<Option<std::fs::Metadata>, String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("inspect study deck: {error}")),
    }
}

fn identity(handle: &File, path: &Path, directory: bool) -> Result<(), String> {
    let held = handle
        .metadata()
        .map_err(|error| format!("inspect held study deck: {error}"))?;
    let named = inspect(path)?.ok_or("study deck identity is missing")?;
    if if directory {
        !held.is_dir() || !named.file_type().is_dir()
    } else {
        !held.is_file() || !named.file_type().is_file()
    } {
        return Err("study deck is not its retained regular file/directory".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if held.dev() != named.dev()
            || held.ino() != named.ino()
            || (!directory && (held.nlink() != 1 || named.nlink() != 1))
        {
            return Err("study deck identity changed or has unowned hard links".into());
        }
        Ok(())
    }
    #[cfg(not(unix))]
    Err("retained study deck identity is unsupported on this platform".into())
}

fn open(path: &Path, directory: bool) -> Result<File, String> {
    let metadata = inspect(path)?.ok_or("study deck file/directory is missing")?;
    if if directory {
        !metadata.file_type().is_dir()
    } else {
        !metadata.file_type().is_file()
    } {
        return Err("study deck is not a regular file/directory".into());
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let flags =
            libc::O_NOFOLLOW | libc::O_NONBLOCK | if directory { libc::O_DIRECTORY } else { 0 };
        options.custom_flags(flags);
    }
    let handle = options
        .open(path)
        .map_err(|error| format!("open study deck: {error}"))?;
    identity(&handle, path, directory)?;
    Ok(handle)
}

fn read(handle: &File) -> Result<String, String> {
    if handle
        .metadata()
        .map_err(|error| format!("inspect study deck length: {error}"))?
        .len()
        > super::MAX_BYTES as u64
    {
        return Err("study deck input exceeds the 1 MiB limit".into());
    }
    let mut bytes = Vec::new();
    handle
        .take(super::MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("read study deck: {error}"))?;
    if bytes.len() > super::MAX_BYTES {
        return Err("study deck grew beyond the 1 MiB limit".into());
    }
    String::from_utf8(bytes).map_err(|error| format!("study deck is not UTF-8: {error}"))
}

pub(super) fn digest(content: &str) -> String {
    format!("{:x}", Sha256::digest(content.as_bytes()))
}

pub(super) fn capture(
    root: &Path,
    path: &Path,
    before_read: impl FnOnce() -> Result<(), String>,
) -> Result<(Sources, String), String> {
    supported_platform()?;
    let root_handle = open(root, true)?;
    let directory_path = root.join("cards");
    let directory = match inspect(&directory_path)? {
        Some(_) => Some(open(&directory_path, true)?),
        None => None,
    };
    let file = match inspect(path)? {
        Some(_) => Some(open(path, false)?),
        None => None,
    };
    before_read()?;
    let raw = match &file {
        Some(handle) => read(handle)?,
        None => String::new(),
    };
    let revision = file.as_ref().map(|_| digest(&raw));
    let captured = Sources {
        root: root_handle,
        directory,
        file,
        revision,
    };
    captured.verify_parent(root, path)?;
    if let Some(handle) = &captured.file {
        identity(handle, path, false)?;
    }
    Ok((captured, raw))
}

fn supported_platform() -> Result<(), String> {
    #[cfg(unix)]
    {
        Ok(())
    }
    #[cfg(not(unix))]
    {
        Err("retained study deck identity is unsupported on this platform".into())
    }
}

impl Sources {
    pub(super) fn verify_parent(&self, root: &Path, path: &Path) -> Result<(), String> {
        identity(&self.root, root, true)?;
        let directory_path = root.join("cards");
        if path.parent() != Some(directory_path.as_path()) {
            return Err("study deck parent changed".into());
        }
        match &self.directory {
            Some(handle) => identity(handle, &directory_path, true),
            None if inspect(&directory_path)?.is_none() => Ok(()),
            None => Err("study deck directory changed since the native read".into()),
        }
    }

    pub(super) fn verify(&self, root: &Path, path: &Path) -> Result<(), String> {
        self.verify_parent(root, path)?;
        match &self.file {
            Some(handle) => {
                identity(handle, path, false)?;
                let current = open(path, false)?;
                let actual = read(&current)?;
                identity(&current, path, false)?;
                identity(handle, path, false)?;
                if self.revision.as_deref() != Some(digest(&actual).as_str()) {
                    return Err("study deck bytes changed since the native read".into());
                }
            }
            None if inspect(path)?.is_none() => {}
            None => return Err("study deck was created since the native read".into()),
        }
        self.verify_parent(root, path)
    }

    pub(super) fn prepare_directory(&mut self, root: &Path, path: &Path) -> Result<(), String> {
        self.verify_parent(root, path)?;
        if self.directory.is_none() {
            let directory_path = root.join("cards");
            std::fs::create_dir(&directory_path)
                .map_err(|error| format!("create study deck directory: {error}"))?;
            self.directory = Some(open(&directory_path, true)?);
        }
        self.verify_parent(root, path)
    }
}
