use super::*;

#[cfg(unix)]
pub(crate) struct DeniedDirectory {
    path: PathBuf,
    permissions: std::fs::Permissions,
}

#[cfg(unix)]
impl DeniedDirectory {
    pub(crate) fn new(path: &Path) -> Self {
        use std::os::unix::fs::PermissionsExt;
        let permissions = std::fs::metadata(path).unwrap().permissions();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o0)).unwrap();
        let denied = Self {
            path: path.to_path_buf(),
            permissions,
        };
        assert_eq!(
            std::fs::read_dir(path).unwrap_err().kind(),
            std::io::ErrorKind::PermissionDenied,
            "the synthetic permission-denial fixture requires an unprivileged test process"
        );
        denied
    }
}

#[cfg(unix)]
impl Drop for DeniedDirectory {
    fn drop(&mut self) {
        std::fs::set_permissions(&self.path, self.permissions.clone())
            .expect("restore synthetic directory permissions");
    }
}

#[test]
fn checked_listing_accepts_a_readable_empty_vault() {
    let vault = tempfile::tempdir().unwrap();
    assert!(list_files(vault.path().to_str().unwrap())
        .unwrap()
        .is_empty());
}

#[test]
fn checked_listing_rejects_a_missing_root() {
    let vault = tempfile::tempdir().unwrap();
    assert!(list_files(vault.path().join("missing").to_str().unwrap()).is_err());
}

#[cfg(unix)]
#[test]
fn checked_directory_entries_preserve_missing_and_permission_error_kinds() {
    let vault = tempfile::tempdir().unwrap();
    let missing = vault_entries_checked(&vault.path().join("missing")).unwrap_err();
    assert_eq!(missing.kind(), std::io::ErrorKind::NotFound);
    let denied = DeniedDirectory::new(vault.path());
    let unreadable = vault_entries_checked(vault.path()).unwrap_err();
    drop(denied);
    assert_eq!(unreadable.kind(), std::io::ErrorKind::PermissionDenied);
}

#[cfg(unix)]
#[test]
fn checked_directory_entries_reject_root_links_and_skip_child_links() {
    use std::os::unix::fs::symlink;
    let vault = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(vault.path().join("note.md"), "synthetic note").unwrap();
    std::fs::write(outside.path().join("secret.md"), "synthetic sentinel").unwrap();
    symlink(outside.path(), vault.path().join("linked")).unwrap();
    let entries = vault_entries_checked(vault.path()).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].0.file_name(), "note.md");
    assert!(vault_entries_checked(&vault.path().join("linked")).is_err());
}

#[cfg(unix)]
#[test]
fn checked_listing_rejects_an_unreadable_root() {
    let vault = tempfile::tempdir().unwrap();
    std::fs::write(vault.path().join("note.md"), "synthetic note").unwrap();
    let denied = DeniedDirectory::new(vault.path());
    let result = list_files(vault.path().to_str().unwrap());
    drop(denied);
    assert!(
        result.is_err(),
        "an unreadable vault must not become an empty tree"
    );
    assert_eq!(list_files(vault.path().to_str().unwrap()).unwrap().len(), 1);
}

#[cfg(unix)]
#[test]
fn checked_listing_rejects_an_incomplete_child_scan() {
    let vault = tempfile::tempdir().unwrap();
    let child = vault.path().join("wiki");
    std::fs::create_dir(&child).unwrap();
    std::fs::write(child.join("note.md"), "synthetic note").unwrap();
    let denied = DeniedDirectory::new(&child);
    let result = list_files(vault.path().to_str().unwrap());
    drop(denied);
    assert!(
        result.is_err(),
        "a partial tree must not be a successful listing"
    );
}

#[cfg(unix)]
#[test]
fn checked_revision_rejects_an_incomplete_child_scan() {
    let vault = tempfile::tempdir().unwrap();
    let child = vault.path().join("wiki");
    std::fs::create_dir(&child).unwrap();
    std::fs::write(child.join("note.md"), "synthetic note").unwrap();
    let revision = vault_revision(vault.path().to_str().unwrap()).unwrap();
    let denied = DeniedDirectory::new(&child);
    let result = vault_revision(vault.path().to_str().unwrap());
    drop(denied);
    assert!(
        result.is_err(),
        "a partial scan must not publish a new revision"
    );
    assert_eq!(
        vault_revision(vault.path().to_str().unwrap()).unwrap(),
        revision
    );
}

#[cfg(unix)]
#[test]
fn checked_mtimes_rejects_an_incomplete_child_scan() {
    let vault = tempfile::tempdir().unwrap();
    let child = vault.path().join("wiki");
    std::fs::create_dir(&child).unwrap();
    std::fs::write(child.join("note.md"), "synthetic note").unwrap();
    let denied = DeniedDirectory::new(&child);
    let result = file_mtimes(vault.path().to_str().unwrap());
    drop(denied);
    assert!(
        result.is_err(),
        "partial mtimes must not replace the complete set"
    );
}
