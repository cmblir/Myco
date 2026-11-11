//! Convert already-confined native paths to the vault's portable page keys.

use std::path::{Component, Path};

/// Keep filesystem confinement separate from the slash-delimited identity used
/// by retrieval, citations and manifests. Callers must resolve links first.
pub(crate) fn relative_key(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    let mut parts = Vec::new();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return None;
        };
        let name = name.to_str()?;
        // On Unix a backslash is a filename byte, not a path separator. Never
        // turn that distinct file into a different portable page identity.
        if name.contains(['\\', '\0']) {
            return None;
        }
        parts.push(name);
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_components_produce_portable_keys_without_changing_names() {
        let root = std::env::temp_dir().join("myco-key-test");
        let path = root.join("raw").join("conversations").join("한글 note.md");
        assert_eq!(
            relative_key(&root, &path).as_deref(),
            Some("raw/conversations/한글 note.md")
        );
    }

    #[test]
    fn rejects_outside_and_parent_components_instead_of_normalizing_them() {
        let root = std::env::temp_dir().join("myco-key-test");
        assert!(relative_key(&root, &root.with_file_name("other").join("note.md")).is_none());
        assert!(relative_key(&root, &root.join("wiki").join("..").join("note.md")).is_none());
        assert!(relative_key(&root, &root).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_nonportable_names_without_lossy_aliases() {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;
        let root = Path::new("/synthetic-vault");
        assert!(relative_key(root, &root.join("wiki").join("a\\b.md")).is_none());
        assert!(relative_key(root, &root.join(OsStr::from_bytes(b"note\xff.md"))).is_none());
    }

    #[cfg(windows)]
    #[test]
    fn accepts_verbatim_windows_roots_but_rejects_other_drives() {
        let root = Path::new(r"\\?\C:\synthetic-vault");
        assert_eq!(
            relative_key(root, &root.join(r"wiki\maps\topic.md")).as_deref(),
            Some("wiki/maps/topic.md")
        );
        assert!(relative_key(root, Path::new(r"\\?\D:\synthetic-vault\note.md")).is_none());
    }
}
