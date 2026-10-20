//! Synthetic retained-handle checks; no personal vault or model access.

use super::*;

fn fixture() -> (tempfile::TempDir, PathBuf, RecordedWriteReceipt) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("synthetic.md");
    let receipt =
        write_file_if_unchanged_recorded(path.to_str().unwrap(), "Owned generated section\n", None)
            .unwrap();
    (dir, path, receipt)
}

#[test]
#[cfg(unix)]
fn retained_handle_allows_in_place_human_edits_but_does_not_grant_deletion() {
    use std::io::Write;
    let (_dir, path, receipt) = fixture();
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap();
    file.write_all(b"Human annotation outside the owned section\n")
        .unwrap();
    file.sync_all().unwrap();
    let (text, revision) = read_same_native_file(&receipt).unwrap();
    assert!(text.ends_with("Human annotation outside the owned section\n"));
    assert_ne!(revision, receipt.revision);
    assert!(verify_recorded_file(&receipt).is_err());
    assert!(remove_recorded_file(&receipt).is_err());
    assert_eq!(std::fs::read_to_string(path).unwrap(), text);
}

#[test]
#[cfg(unix)]
fn identical_replacement_cannot_restore_retained_handle_authority() {
    let (_dir, path, receipt) = fixture();
    let text = std::fs::read_to_string(&path).unwrap();
    let replacement =
        write_file_if_unchanged_recorded(path.to_str().unwrap(), &text, Some(&receipt.revision))
            .unwrap();
    assert_eq!(replacement.revision, receipt.revision);
    assert!(read_same_native_file(&receipt)
        .unwrap_err()
        .contains("identity changed"));
    assert_eq!(read_same_native_file(&replacement).unwrap().0, text);
}

#[test]
#[cfg(unix)]
fn retained_handle_rejects_hard_link_and_symlink_targets() {
    let (dir, path, receipt) = fixture();
    let alias = dir.path().join("synthetic-hard-link.md");
    std::fs::hard_link(&path, &alias).unwrap();
    assert!(read_same_native_file(&receipt).is_err());
    std::fs::remove_file(&alias).unwrap();
    std::fs::rename(&path, &alias).unwrap();
    std::os::unix::fs::symlink(&alias, &path).unwrap();
    assert!(read_same_native_file(&receipt).is_err());
}

#[test]
#[cfg(unix)]
fn retained_handle_does_not_skip_bounded_read_or_utf8_checks() {
    let (_dir, path, receipt) = fixture();
    std::fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(4 * 1024 * 1024 + 1)
        .unwrap();
    assert!(read_same_native_file(&receipt)
        .unwrap_err()
        .contains("size changed"));
    std::fs::write(&path, [0xff]).unwrap();
    assert!(read_same_native_file(&receipt)
        .unwrap_err()
        .contains("UTF-8"));
}
