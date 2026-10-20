//! Synthetic MCP archive tests run the same copy/move body with a per-call
//! boundary callback. They do not load settings, models or a private vault.

use super::{archive_inbox, archive_inbox_checked};
use crate::vault;
use std::path::Path;

const SOURCE: &str = "Original synthetic inbox source.\n";
const EDITED: &str = "Updated synthetic inbox source.\n";

fn write(root: &Path, rel: &str, content: &str) {
    let path = root.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, content).unwrap();
}

#[test]
fn mcp_archive_refuses_source_changed_after_raw_copy_by_normal_writer() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(root, "_inbox/Synthetic Source.md", SOURCE);
    let source = root.join("_inbox/Synthetic Source.md");
    let result = archive_inbox_checked(root, "Synthetic Source.md", true, || {
        assert_eq!(
            std::fs::read_to_string(root.join("raw/synthetic-source.md")).unwrap(),
            SOURCE
        );
        // The raw absence-CAS has released FILE_WRITE_LOCK; this normal writer
        // must complete before the archive helper checks the captured SHA.
        vault::write_file(&source.to_string_lossy(), EDITED).unwrap();
    });
    let error = result.unwrap_err();
    assert!(error.contains("source changed"), "{error}");
    assert_eq!(std::fs::read_to_string(&source).unwrap(), EDITED);
    assert_eq!(
        std::fs::read_to_string(root.join("raw/synthetic-source.md")).unwrap(),
        SOURCE
    );
    assert!(!root.join("_inbox/.archived/Synthetic Source.md").exists());
}

#[test]
fn mcp_archive_suffixes_around_destination_created_after_raw_copy() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(root, "_inbox/Synthetic Source.md", SOURCE);
    std::fs::create_dir_all(root.join("_inbox/.archived")).unwrap();
    let first = root.join("_inbox/.archived/Synthetic Source.md");
    let second = root.join("_inbox/.archived/Synthetic Source-2.md");
    let out = archive_inbox_checked(root, "Synthetic Source.md", true, || {
        vault::write_file_if_unchanged(&first.to_string_lossy(), "First competitor.\n", None)
            .unwrap();
        vault::write_file_if_unchanged(&second.to_string_lossy(), "Second competitor.\n", None)
            .unwrap();
    })
    .unwrap();
    assert_eq!(out["raw_path"], "raw/synthetic-source.md");
    assert_eq!(out["src_slug"], "src-synthetic-source");
    assert_eq!(out["archived"], "Synthetic Source-3.md");
    assert_eq!(
        std::fs::read_to_string(first).unwrap(),
        "First competitor.\n"
    );
    assert_eq!(
        std::fs::read_to_string(second).unwrap(),
        "Second competitor.\n"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("_inbox/.archived/Synthetic Source-3.md")).unwrap(),
        SOURCE
    );
    assert!(!root.join("_inbox/Synthetic Source.md").exists());
}

#[cfg(unix)]
#[test]
fn mcp_archive_rechecks_source_confinement_after_raw_copy() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(root, "_inbox/Synthetic Source.md", SOURCE);
    write(other.path(), "other.md", "Other synthetic source.\n");
    let source = root.join("_inbox/Synthetic Source.md");
    let result = archive_inbox_checked(root, "Synthetic Source.md", true, || {
        std::fs::remove_file(&source).unwrap();
        symlink(other.path().join("other.md"), &source).unwrap();
    });
    let error = result.unwrap_err();
    assert!(error.contains("symbolic link"), "{error}");
    assert!(std::fs::symlink_metadata(&source)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(
        std::fs::read_to_string(other.path().join("other.md")).unwrap(),
        "Other synthetic source.\n"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("raw/synthetic-source.md")).unwrap(),
        SOURCE
    );
    assert!(!root.join("_inbox/.archived/Synthetic Source.md").exists());
}

#[cfg(unix)]
#[test]
fn mcp_archive_rechecks_archive_confinement_after_raw_copy() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(root, "_inbox/Synthetic Source.md", SOURCE);
    let result = archive_inbox_checked(root, "Synthetic Source.md", true, || {
        symlink(other.path(), root.join("_inbox/.archived")).unwrap();
    });
    let error = result.unwrap_err();
    assert!(error.contains("symbolic link"), "{error}");
    assert_eq!(
        std::fs::read_to_string(root.join("_inbox/Synthetic Source.md")).unwrap(),
        SOURCE
    );
    assert_eq!(
        std::fs::read_to_string(root.join("raw/synthetic-source.md")).unwrap(),
        SOURCE
    );
    assert!(std::fs::read_dir(other.path()).unwrap().next().is_none());
}

#[cfg(unix)]
#[test]
fn mcp_archive_existing_archive_symlink_refuses_before_raw_copy() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(root, "_inbox/Synthetic Source.md", SOURCE);
    symlink(other.path(), root.join("_inbox/.archived")).unwrap();
    let error = archive_inbox(root, "Synthetic Source.md", true).unwrap_err();
    assert!(error.contains("symbolic link"), "{error}");
    assert_eq!(
        std::fs::read_to_string(root.join("_inbox/Synthetic Source.md")).unwrap(),
        SOURCE
    );
    assert!(!root.join("raw/synthetic-source.md").exists());
    assert!(std::fs::read_dir(other.path()).unwrap().next().is_none());
}
