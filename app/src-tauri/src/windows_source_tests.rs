//! Real Windows source handles, with no emulated identity or mocked errors.
use super::*;
use std::fs;

#[test]
fn unicode_space_source_reopens_and_allows_revision_checks() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("Synthetic 한글 source.md");
    fs::write(&path, "Synthetic source.").unwrap();
    let held = open(&path).unwrap();
    verify(&held, &path).unwrap();
    fs::write(&path, "Synthetic human edit.").unwrap();
    // In-place changes keep identity; the caller separately checks exact bytes.
    verify(&held, &path).unwrap();
    drop(held);
    verify(&open(&path).unwrap(), &path).unwrap();
}

#[test]
fn same_byte_replacement_does_not_match_retained_source() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("source.md");
    let preserved = root.path().join("preserved.md");
    fs::write(&path, "Synthetic original.").unwrap();
    let held = open(&path).unwrap();
    fs::rename(&path, &preserved).unwrap();
    fs::write(&path, "Synthetic original.").unwrap();
    assert!(verify(&held, &path)
        .unwrap_err()
        .contains("identity changed"));
    assert_eq!(fs::read(&path).unwrap(), fs::read(&preserved).unwrap());
}

#[test]
fn added_hard_link_is_rejected_by_both_open_and_recheck() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("source.md");
    fs::write(&path, "Synthetic original.").unwrap();
    let held = open(&path).unwrap();
    fs::hard_link(&path, root.path().join("alias.md")).unwrap();
    assert!(open(&path).is_err());
    assert!(verify(&held, &path).is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "Synthetic original.");
}

#[test]
fn directory_and_missing_source_never_acquire_source_identity() {
    let root = tempfile::tempdir().unwrap();
    assert!(open(root.path()).is_err());
    assert!(open(&root.path().join("missing.md")).is_err());
}

#[test]
fn sharing_denial_preserves_source_and_releases_cleanly() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("source.md");
    fs::write(&path, "Synthetic original.").unwrap();
    let exclusive = OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&path)
        .unwrap();
    assert!(open(&path).is_err());
    drop(exclusive);
    let held = open(&path).unwrap();
    verify(&held, &path).unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "Synthetic original.");
}

#[test]
fn deleted_source_never_verifies_through_its_retained_handle() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("source.md");
    fs::write(&path, "Synthetic original.").unwrap();
    let held = open(&path).unwrap();
    fs::remove_file(&path).unwrap();
    assert!(verify(&held, &path).is_err());
    drop(held);
    assert!(!path.exists());
}
