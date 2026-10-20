use super::archive_inbox_source_completion_at;
use std::path::Path;

fn fixture() -> (tempfile::TempDir, std::path::PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    std::fs::create_dir(root.join("_inbox")).unwrap();
    std::fs::write(root.join("_inbox/a.md"), "original inbox evidence").unwrap();
    (directory, root)
}

fn assert_pending_original(root: &Path) {
    assert_eq!(
        std::fs::read_to_string(root.join("_inbox/a.md")).unwrap(),
        "original inbox evidence"
    );
    assert!(!root.join("_inbox/.archived").exists());
}

#[test]
fn inbox_completion_caller_boolean_cannot_archive_or_complete_a_source() {
    let (_directory, root) = fixture();
    let result = archive_inbox_source_completion_at(
        &root,
        &root.join("_inbox/a.md").to_string_lossy(),
        true,
    );
    assert!(
        result.is_err(),
        "caller boolean became completion authority: {result:?}"
    );
    assert_pending_original(&root);
    assert!(!root.join(".myco/backfill.json").exists());
}

#[test]
fn inbox_completion_corrupt_state_must_not_move_before_refusal() {
    let (_directory, root) = fixture();
    std::fs::create_dir(root.join(".myco")).unwrap();
    std::fs::write(root.join(".myco/backfill.json"), "{ corrupt state").unwrap();
    let result = archive_inbox_source_completion_at(
        &root,
        &root.join("_inbox/a.md").to_string_lossy(),
        true,
    );
    assert!(result.is_err());
    assert_pending_original(&root);
    assert_eq!(
        std::fs::read_to_string(root.join(".myco/backfill.json")).unwrap(),
        "{ corrupt state"
    );
}

#[test]
fn inbox_completion_manual_archive_preserves_original_bytes_without_completing() {
    let (_directory, root) = fixture();
    let archived = archive_inbox_source_completion_at(
        &root,
        &root.join("_inbox/a.md").to_string_lossy(),
        false,
    )
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(archived).unwrap(),
        "original inbox evidence"
    );
    assert!(!root.join("_inbox/a.md").exists());
    assert!(!root.join(".myco/backfill.json").exists());
}
