use super::*;

#[test]
fn checked_collector_accepts_a_readable_root_with_absent_optional_trees() {
    let vault = tempfile::tempdir().unwrap();
    assert!(collect_pages_checked(vault.path(), false)
        .unwrap()
        .is_empty());
}

#[test]
fn checked_collector_rejects_missing_root() {
    let vault = tempfile::tempdir().unwrap();
    assert!(collect_pages_checked(&vault.path().join("missing"), false).is_err());
}

#[cfg(unix)]
#[test]
fn checked_collector_rejects_unreadable_root_and_active_subtree() {
    use crate::vault::scan_tests::DeniedDirectory;
    let vault = tempfile::tempdir().unwrap();
    let wiki = vault.path().join("wiki");
    std::fs::create_dir(&wiki).unwrap();
    std::fs::write(wiki.join("note.md"), "synthetic content").unwrap();
    let denied = DeniedDirectory::new(vault.path());
    let root_result = collect_pages_checked(vault.path(), false);
    drop(denied);
    assert!(root_result.is_err());
    let denied = DeniedDirectory::new(&wiki);
    let subtree_result = collect_pages_checked(vault.path(), false);
    drop(denied);
    assert!(subtree_result.is_err());
    assert_eq!(collect_pages_checked(vault.path(), false).unwrap().len(), 1);
}

#[cfg(unix)]
#[test]
fn checked_collector_rejects_unreadable_file_without_dropping_the_page() {
    use std::os::unix::fs::PermissionsExt;
    let vault = tempfile::tempdir().unwrap();
    let wiki = vault.path().join("wiki");
    std::fs::create_dir(&wiki).unwrap();
    let page = wiki.join("note.md");
    std::fs::write(&page, "synthetic content").unwrap();
    let original = std::fs::metadata(&page).unwrap().permissions();
    std::fs::set_permissions(&page, std::fs::Permissions::from_mode(0o0)).unwrap();
    assert_eq!(
        std::fs::read(&page).unwrap_err().kind(),
        std::io::ErrorKind::PermissionDenied
    );
    let result = collect_pages_checked(vault.path(), false);
    std::fs::set_permissions(&page, original).unwrap();
    assert!(result.is_err());
    assert_eq!(collect_pages_checked(vault.path(), false).unwrap().len(), 1);
}

#[cfg(unix)]
#[test]
fn checked_collector_skips_cold_permission_denial_until_opted_in() {
    use crate::vault::scan_tests::DeniedDirectory;
    let vault = tempfile::tempdir().unwrap();
    let archive = vault.path().join("sessions/archive");
    std::fs::create_dir_all(&archive).unwrap();
    std::fs::write(archive.join("old.md"), "synthetic archive").unwrap();
    let denied = DeniedDirectory::new(&archive);
    let excluded = collect_pages_checked(vault.path(), false);
    let included = collect_pages_checked(vault.path(), true);
    drop(denied);
    assert!(excluded.unwrap().is_empty());
    assert!(included.is_err());
}

#[cfg(unix)]
#[test]
fn checked_collector_rejects_redirected_optional_tree() {
    let vault = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(outside.path(), vault.path().join("wiki")).unwrap();
    assert!(collect_pages_checked(vault.path(), false).is_err());
}

#[test]
fn native_reflect_creates_a_stub_without_overwriting_an_existing_human_page() {
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path().canonicalize().unwrap();
    let created = reflect_create_missing_page_at(&root, "Synthetic note").unwrap();
    assert!(std::fs::read_to_string(&created)
        .unwrap()
        .contains("# Synthetic note"));
    std::fs::write(&created, "Human annotations").unwrap();
    assert_eq!(
        reflect_create_missing_page_at(&root, "Synthetic note").unwrap(),
        created
    );
    assert_eq!(
        std::fs::read_to_string(&created).unwrap(),
        "Human annotations"
    );
    assert_eq!(
        reflect_create_missing_page_at(&root, "wiki/Synthetic note").unwrap(),
        created
    );
    assert!(!root.join("wiki/wiki-Synthetic note.md").exists());
}

#[cfg(unix)]
#[test]
fn native_reflect_refuses_a_wiki_alias_to_raw_or_outside() {
    for is_raw in [true, false] {
        let vault = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let raw = vault.path().join("raw");
        std::fs::create_dir(&raw).unwrap();
        let root = vault.path().canonicalize().unwrap();
        let destination = if is_raw {
            raw.as_path()
        } else {
            outside.path()
        };
        std::os::unix::fs::symlink(destination, root.join("wiki")).unwrap();
        assert!(reflect_create_missing_page_at(&root, "Synthetic note").is_err());
        assert!(!destination.join("Synthetic note.md").exists());
    }
}
