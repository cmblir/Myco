//! Current-file cleanup controls; no restored write or section-ownership authority.

use super::*;
use crate::vault;
use sha2::{Digest, Sha256};
use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};

fn fixture() -> (tempfile::TempDir, CompilerPinDirectory) {
    let temporary = tempfile::tempdir().unwrap();
    let directory = temporary
        .path()
        .canonicalize()
        .unwrap()
        .join("private-custody");
    fs::create_dir(&directory).unwrap();
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
    let pinned = vault::open_compiler_pin_directory(&directory).unwrap();
    (temporary, pinned)
}

fn leaf(kind: &str) -> String {
    format!("{}.{}.{kind}", "a".repeat(64), "b".repeat(32))
}

fn create(directory: &CompilerPinDirectory, kind: &str, bytes: &[u8]) -> PathBuf {
    let path = directory.path().join(leaf(kind));
    fs::write(&path, bytes).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    path
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn replace(path: &Path, bytes: &[u8]) {
    let staged = path.with_extension("replacement");
    fs::write(&staged, bytes).unwrap();
    fs::set_permissions(&staged, fs::Permissions::from_mode(0o600)).unwrap();
    fs::rename(staged, path).unwrap();
}

#[test]
fn fresh_private_pin_reads_actual_snapshot_and_removes_only_its_leaf() {
    let (_temporary, directory) = fixture();
    let guard = vault::lock_file_mutation().unwrap();
    let protected = directory.path().join("unknown.txt");
    fs::write(&protected, "Unknown human bytes\n").unwrap();
    for kind in ["anchor", "baseline.txt", "record.json"] {
        let path = create(&directory, kind, b"Native private image\n");
        let pin = capture_compiler_retired_file_locked(&guard, &directory, &leaf(kind))
            .unwrap()
            .unwrap();
        let (text, revision, identity) =
            read_compiler_retired_file_pin_locked(&guard, &pin).unwrap();
        assert_eq!(text, "Native private image\n");
        assert_eq!(revision, hash(text.as_bytes()));
        assert_eq!(
            Some(identity),
            vault::recorded_identity(&fs::metadata(&path).unwrap())
        );
        unlink_compiler_retired_file_pin_locked(&guard, &pin, &revision).unwrap();
        assert!(!path.exists());
        assert!(
            capture_compiler_retired_file_locked(&guard, &directory, &leaf(kind))
                .unwrap()
                .is_none()
        );
    }
    assert_eq!(
        fs::read_to_string(protected).unwrap(),
        "Unknown human bytes\n"
    );
}

#[test]
fn only_valid_native_generation_leaf_can_report_checked_absence() {
    let (_temporary, directory) = fixture();
    let guard = vault::lock_file_mutation().unwrap();
    assert!(
        capture_compiler_retired_file_locked(&guard, &directory, &leaf("anchor"))
            .unwrap()
            .is_none()
    );
    for invalid in [
        "head.json".into(),
        "raw.md".into(),
        "../raw.md".into(),
        format!("../{}", leaf("anchor")),
        format!("nested/{}", leaf("anchor")),
        format!("nested\\{}", leaf("anchor")),
        leaf("unknown"),
        format!("{}.{}.anchor", "a".repeat(63), "b".repeat(32)),
        format!("{}.{}.anchor", "A".repeat(64), "b".repeat(32)),
    ] {
        assert!(
            capture_compiler_retired_file_locked(&guard, &directory, &invalid).is_err(),
            "{invalid}"
        );
    }
}

#[test]
fn actual_late_human_image_is_readable_but_old_expected_sha_cannot_delete_it() {
    let (_temporary, directory) = fixture();
    let path = create(
        &directory,
        "anchor",
        b"Old section\nUnique late human bytes\n",
    );
    let guard = vault::lock_file_mutation().unwrap();
    let pin = capture_compiler_retired_file_locked(&guard, &directory, &leaf("anchor"))
        .unwrap()
        .unwrap();
    let (text, revision, _) = read_compiler_retired_file_pin_locked(&guard, &pin).unwrap();
    assert!(text.contains("Unique late human bytes"));
    assert_ne!(revision, hash(b"Old section\n"));
    assert!(
        unlink_compiler_retired_file_pin_locked(&guard, &pin, &hash(b"Old section\n")).is_err()
    );
    assert!(unlink_compiler_retired_file_pin_locked(&guard, &pin, "not-a-sha").is_err());
    assert_eq!(fs::read_to_string(path).unwrap(), text);
}

#[test]
fn same_bytes_replacement_cannot_reuse_a_captured_cleanup_pin() {
    let (_temporary, directory) = fixture();
    let path = create(&directory, "baseline.txt", b"Same image\n");
    let guard = vault::lock_file_mutation().unwrap();
    let pin = capture_compiler_retired_file_locked(&guard, &directory, &leaf("baseline.txt"))
        .unwrap()
        .unwrap();
    let original_inode = fs::metadata(&path).unwrap().ino();
    replace(&path, b"Same image\n");
    assert_ne!(fs::metadata(&path).unwrap().ino(), original_inode);
    assert!(read_compiler_retired_file_pin_locked(&guard, &pin).is_err());
    assert!(unlink_compiler_retired_file_pin_locked(&guard, &pin, &hash(b"Same image\n")).is_err());
    assert_eq!(fs::read(&path).unwrap(), b"Same image\n");
}

#[test]
fn changed_pinned_inode_is_retained_and_fresh_capture_reports_actual_image() {
    let (_temporary, directory) = fixture();
    let path = create(&directory, "anchor", b"Old image\n");
    let guard = vault::lock_file_mutation().unwrap();
    let pin = capture_compiler_retired_file_locked(&guard, &directory, &leaf("anchor"))
        .unwrap()
        .unwrap();
    fs::write(&path, "Changed image with human residue\n").unwrap();
    assert!(read_compiler_retired_file_pin_locked(&guard, &pin).is_err());
    assert!(unlink_compiler_retired_file_pin_locked(&guard, &pin, &hash(b"Old image\n")).is_err());
    let fresh = capture_compiler_retired_file_locked(&guard, &directory, &leaf("anchor"))
        .unwrap()
        .unwrap();
    assert_eq!(
        read_compiler_retired_file_pin_locked(&guard, &fresh)
            .unwrap()
            .0,
        "Changed image with human residue\n"
    );
    assert!(
        unlink_compiler_retired_file_pin_locked(&guard, &fresh, &hash(b"Old image\n")).is_err()
    );
    assert!(path.exists());
}

#[test]
fn active_two_link_anchor_and_added_alias_are_not_cleanup_targets() {
    let (_temporary, directory) = fixture();
    let path = create(&directory, "anchor", b"Current canonical image\n");
    let alias = directory
        .path()
        .parent()
        .unwrap()
        .join("current-canonical.md");
    fs::hard_link(&path, &alias).unwrap();
    let guard = vault::lock_file_mutation().unwrap();
    assert!(capture_compiler_retired_file_locked(&guard, &directory, &leaf("anchor")).is_err());
    fs::remove_file(&alias).unwrap();
    let pin = capture_compiler_retired_file_locked(&guard, &directory, &leaf("anchor"))
        .unwrap()
        .unwrap();
    fs::hard_link(&path, &alias).unwrap();
    assert!(unlink_compiler_retired_file_pin_locked(
        &guard,
        &pin,
        &hash(b"Current canonical image\n")
    )
    .is_err());
    assert_eq!(fs::read(&alias).unwrap(), b"Current canonical image\n");
    assert!(path.exists());
}

#[test]
fn unsafe_mode_is_retained_even_for_a_single_link_anchor() {
    let (_temporary, directory) = fixture();
    let path = create(&directory, "anchor", b"Preserved bytes\n");
    let guard = vault::lock_file_mutation().unwrap();
    for mode in [0o644, 0o4600] {
        fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
        assert!(capture_compiler_retired_file_locked(&guard, &directory, &leaf("anchor")).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"Preserved bytes\n");
    }
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let pin = capture_compiler_retired_file_locked(&guard, &directory, &leaf("anchor"))
        .unwrap()
        .unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(
        unlink_compiler_retired_file_pin_locked(&guard, &pin, &hash(b"Preserved bytes\n")).is_err()
    );
    assert!(path.exists());
}

#[test]
fn symlink_directory_and_fifo_leaves_are_refused_without_deletion() {
    use std::os::unix::{ffi::OsStrExt, fs::symlink};
    let (_temporary, directory) = fixture();
    let target = directory.path().parent().unwrap().join("human.md");
    fs::write(&target, "Human original\n").unwrap();
    let symlink_path = directory.path().join(leaf("anchor"));
    symlink(&target, &symlink_path).unwrap();
    let directory_path = directory.path().join(leaf("baseline.txt"));
    fs::create_dir(&directory_path).unwrap();
    let fifo_path = directory.path().join(leaf("record.json"));
    let fifo_name = std::ffi::CString::new(fifo_path.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo_name.as_ptr(), 0o600) }, 0);
    let guard = vault::lock_file_mutation().unwrap();
    for kind in ["anchor", "baseline.txt", "record.json"] {
        assert!(capture_compiler_retired_file_locked(&guard, &directory, &leaf(kind)).is_err());
    }
    assert_eq!(fs::read_to_string(target).unwrap(), "Human original\n");
    assert!(fs::symlink_metadata(symlink_path)
        .unwrap()
        .file_type()
        .is_symlink());
    assert!(directory_path.is_dir());
    assert!(fs::symlink_metadata(fifo_path).is_ok());
}

#[test]
fn invalid_utf8_nul_and_oversize_images_are_preserved() {
    let (_temporary, directory) = fixture();
    let guard = vault::lock_file_mutation().unwrap();
    for bytes in [
        vec![0xff, 0xfe],
        b"Native\0hidden".to_vec(),
        vec![b'x'; MAX_BYTES + 1],
    ] {
        let path = create(&directory, "record.json", &bytes);
        assert!(
            capture_compiler_retired_file_locked(&guard, &directory, &leaf("record.json")).is_err()
        );
        assert_eq!(fs::read(path).unwrap(), bytes);
    }
}

#[test]
fn replaced_or_untrusted_private_directory_invalidates_cleanup_pin() {
    let (_temporary, directory) = fixture();
    let path = create(&directory, "anchor", b"Original pinned image\n");
    let guard = vault::lock_file_mutation().unwrap();
    let pin = capture_compiler_retired_file_locked(&guard, &directory, &leaf("anchor"))
        .unwrap()
        .unwrap();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o755)).unwrap();
    assert!(read_compiler_retired_file_pin_locked(&guard, &pin).is_err());
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let moved = directory.path().with_file_name("retained-old-directory");
    fs::rename(directory.path(), &moved).unwrap();
    fs::create_dir(directory.path()).unwrap();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(&path, "Unrelated replacement\n").unwrap();
    assert!(unlink_compiler_retired_file_pin_locked(
        &guard,
        &pin,
        &hash(b"Original pinned image\n")
    )
    .is_err());
    assert_eq!(fs::read_to_string(path).unwrap(), "Unrelated replacement\n");
    assert_eq!(
        fs::read_to_string(moved.join(leaf("anchor"))).unwrap(),
        "Original pinned image\n"
    );
}

#[test]
fn final_unlink_recheck_rejects_same_bytes_replacement() {
    let (_temporary, directory) = fixture();
    let path = create(&directory, "baseline.txt", b"Original image\n");
    let guard = vault::lock_file_mutation().unwrap();
    let pin = capture_compiler_retired_file_locked(&guard, &directory, &leaf("baseline.txt"))
        .unwrap()
        .unwrap();
    let result = unlink_current(&guard, &pin, &hash(b"Original image\n"), |phase| {
        if matches!(phase, RetirementCheckpoint::BeforeRecheck) {
            replace(&path, b"Original image\n");
        }
        Ok(())
    });
    assert!(result.is_err());
    assert_eq!(fs::read(path).unwrap(), b"Original image\n");
}

#[test]
fn interrupted_unlink_acknowledgement_is_loud_and_fresh_absence_is_observable() {
    let (_temporary, directory) = fixture();
    let path = create(&directory, "record.json", b"Eligible old record\n");
    let protected = create(&directory, "anchor", b"Other retained image\n");
    let guard = vault::lock_file_mutation().unwrap();
    let pin = capture_compiler_retired_file_locked(&guard, &directory, &leaf("record.json"))
        .unwrap()
        .unwrap();
    let error = unlink_current(&guard, &pin, &hash(b"Eligible old record\n"), |phase| {
        if matches!(phase, RetirementCheckpoint::Unlinked) {
            return Err("synthetic acknowledgement cutoff".into());
        }
        Ok(())
    })
    .unwrap_err();
    assert!(error.contains("unlinked; acknowledgement incomplete"));
    assert!(!path.exists());
    assert!(
        capture_compiler_retired_file_locked(&guard, &directory, &leaf("record.json"))
            .unwrap()
            .is_none()
    );
    assert_eq!(fs::read(protected).unwrap(), b"Other retained image\n");
}
