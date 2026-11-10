//! Read-only source pins. These never establish publication or write custody.

use std::path::Path;

#[cfg(unix)]
pub(crate) const SOURCE_BYTES: usize = 128 * 1024;

#[cfg(unix)]
mod platform {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::fs::{File, Metadata, OpenOptions};
    use std::io::Read;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

    #[derive(Debug, PartialEq, Eq)]
    struct Revision {
        object: (u64, u64),
        size: u64,
        links: u64,
        changed: (i64, i64),
        modified: (i64, i64),
    }
    fn revision(metadata: &Metadata) -> Revision {
        Revision {
            object: identity(metadata),
            size: metadata.len(),
            links: metadata.nlink(),
            changed: (metadata.ctime(), metadata.ctime_nsec()),
            modified: (metadata.mtime(), metadata.mtime_nsec()),
        }
    }
    fn identity(metadata: &Metadata) -> (u64, u64) {
        (metadata.dev(), metadata.ino())
    }
    fn metadata(file: &File) -> Result<Metadata, String> {
        file.metadata()
            .map_err(|error| format!("map source metadata: {error}"))
    }
    fn directory(path: &Path) -> Result<File, String> {
        OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)
            .map_err(|error| format!("map source root: {error}"))
    }
    fn child(parent: &File, name: &str, is_directory: bool) -> Result<File, String> {
        let name = std::ffi::CString::new(name).map_err(|_| "map source name contains NUL")?;
        let flags = libc::O_RDONLY
            | libc::O_NOFOLLOW
            | libc::O_CLOEXEC
            | if is_directory {
                libc::O_DIRECTORY
            } else {
                libc::O_NONBLOCK
            };
        // Each component is opened relative to an already-held directory; symlinks are never followed.
        let descriptor = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
        if descriptor < 0 {
            return Err(format!(
                "map source open: {}",
                std::io::Error::last_os_error()
            ));
        }
        // openat returned a new owned descriptor.
        Ok(unsafe { File::from_raw_fd(descriptor) })
    }
    fn parent(root: &File, path: &str) -> Result<File, String> {
        let mut held = root.try_clone().map_err(|error| error.to_string())?;
        let components: Vec<_> = path.split('/').collect();
        for part in &components[..components.len() - 1] {
            held = child(&held, part, true)?;
        }
        Ok(held)
    }
    fn read(file: &mut File) -> Result<(String, Revision), String> {
        read_at(
            file,
            #[cfg(test)]
            || {},
        )
    }
    fn read_at(
        file: &mut File,
        #[cfg(test)] before_read: impl FnOnce(),
    ) -> Result<(String, Revision), String> {
        let before = metadata(file)?;
        if !before.is_file() || before.len() > SOURCE_BYTES as u64 {
            return Err("map source is not a bounded regular file".into());
        }
        let mut bytes = Vec::new();
        #[cfg(test)]
        before_read();
        file.take((SOURCE_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("map source read: {error}"))?;
        if bytes.len() > SOURCE_BYTES {
            return Err("map source grew beyond the size budget".into());
        }
        let after = metadata(file)?;
        if revision(&before) != revision(&after) || bytes.len() as u64 != after.len() {
            return Err("map source changed during read".into());
        }
        let raw = String::from_utf8(bytes).map_err(|_| "map source is not UTF-8")?;
        if raw.contains('\0') {
            return Err("map source contains NUL".into());
        }
        Ok((raw, revision(&after)))
    }

    #[cfg(test)]
    #[test]
    fn map_source_read_rejects_growth_shrink_and_restored_mtime_during_read() {
        use std::io::Write;
        for change in ["growth", "shrink", "same-size"] {
            let fixture = tempfile::tempdir().unwrap();
            let path = fixture.path().join("source.md");
            std::fs::write(&path, "Synthetic source.").unwrap();
            let mut held = File::open(&path).unwrap();
            let old_modified = held.metadata().unwrap().modified().unwrap();
            let result = read_at(&mut held, || {
                let mut writer = OpenOptions::new().write(true).open(&path).unwrap();
                match change {
                    "growth" => writer.write_all(&vec![b'g'; SOURCE_BYTES * 4]).unwrap(),
                    "shrink" => writer.set_len(2).unwrap(),
                    _ => writer.write_all(b"Corrected source.").unwrap(),
                }
                writer.set_modified(old_modified).unwrap();
            });
            assert!(result.is_err(), "{change}");
        }
    }

    pub(crate) struct SourceSet {
        root: File,
        members: Vec<Member>,
    }
    struct Member {
        path: String,
        parent: File,
        file: File,
        revision: Revision,
        digest: String,
    }

    impl SourceSet {
        pub(crate) fn capture(
            root_path: &Path,
            paths: &[String],
        ) -> Result<(Self, Vec<super::super::map_sources::MemberSnapshot>), String> {
            let root = directory(root_path)?;
            let mut members = Vec::new();
            let mut snapshots = Vec::new();
            let mut identities = std::collections::BTreeSet::new();
            for path in paths {
                let parent = parent(&root, path)?;
                let mut file = child(
                    &parent,
                    path.rsplit('/').next().ok_or("missing map source name")?,
                    false,
                )?;
                let (raw, revision) = read(&mut file)?;
                if !identities.insert(revision.object) {
                    return Err("map sources refer to the same file identity".into());
                }
                let digest = format!("{:x}", Sha256::digest(raw.as_bytes()));
                snapshots.push(super::super::map_sources::MemberSnapshot {
                    path: path.clone(),
                    revision: digest.clone(),
                    raw,
                });
                members.push(Member {
                    path: path.clone(),
                    parent,
                    file,
                    revision,
                    digest,
                });
            }
            let captured = Self { root, members };
            captured.check(root_path)?;
            Ok((captured, snapshots))
        }

        pub(crate) fn check(&self, root_path: &Path) -> Result<(), String> {
            self.check_root(root_path)?;
            for member in &self.members {
                let current_parent = parent(&self.root, &member.path)?;
                if identity(&metadata(&current_parent)?) != identity(&metadata(&member.parent)?) {
                    return Err("map source parent identity changed".into());
                }
                let mut current = child(
                    &current_parent,
                    member
                        .path
                        .rsplit('/')
                        .next()
                        .ok_or("missing map source name")?,
                    false,
                )?;
                if revision(&metadata(&current)?) != member.revision
                    || revision(&metadata(&member.file)?) != member.revision
                {
                    return Err("map source file identity or revision changed".into());
                }
                let (raw, observed) = read(&mut current)?;
                if observed != member.revision
                    || format!("{:x}", Sha256::digest(raw.as_bytes())) != member.digest
                {
                    return Err("map source content changed".into());
                }
                // Rewalk after reading too: an external rename must not return a detached member.
                let after_parent = parent(&self.root, &member.path)?;
                let after_file = child(
                    &after_parent,
                    member
                        .path
                        .rsplit('/')
                        .next()
                        .ok_or("missing map source name")?,
                    false,
                )?;
                if identity(&metadata(&after_parent)?) != identity(&metadata(&member.parent)?)
                    || revision(&metadata(&after_file)?) != member.revision
                {
                    return Err("map source chain changed during check".into());
                }
            }
            self.check_root(root_path)
        }
        fn check_root(&self, path: &Path) -> Result<(), String> {
            if identity(&metadata(&directory(path)?)?) != identity(&metadata(&self.root)?) {
                return Err("map source root identity changed".into());
            }
            Ok(())
        }
    }
}

#[cfg(unix)]
pub(crate) use platform::SourceSet;

#[cfg(not(unix))]
pub(crate) struct SourceSet;
#[cfg(not(unix))]
impl SourceSet {
    pub(crate) fn capture(
        _: &Path,
        _: &[String],
    ) -> Result<(Self, Vec<crate::map_sources::MemberSnapshot>), String> {
        Err("native map source identity is unsupported on this platform".into())
    }
    pub(crate) fn check(&self, _: &Path) -> Result<(), String> {
        Err("native map source identity is unsupported on this platform".into())
    }
}
