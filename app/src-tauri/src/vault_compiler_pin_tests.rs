//! Synthetic physical-custody controls; no model or section-authority substitution.

use super::*;
use crate::vault;
use sha2::{Digest, Sha256};
use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};

fn fixture() -> (tempfile::TempDir, PathBuf, CompilerPinDirectory) {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().canonicalize().unwrap();
    let store = root.join("private-custody");
    fs::create_dir(&store).unwrap();
    fs::set_permissions(&store, fs::Permissions::from_mode(0o700)).unwrap();
    let directory = open_compiler_pin_directory(&store).unwrap();
    (temporary, root.join("synthetic.md"), directory)
}

fn hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

fn create(path: &Path, directory: &CompilerPinDirectory) -> RecordedWriteReceipt {
    let guard = vault::lock_file_mutation().unwrap();
    write_compiler_file_anchored_locked(
        &guard,
        path.to_str().unwrap(),
        "Native section\n",
        None,
        None,
        directory,
        "first-native.anchor",
    )
    .unwrap()
}

#[test]
fn new_anchor_receipt_uses_postlink_identity_and_exact_native_issuance() {
    let (_temporary, path, directory) = fixture();
    let receipt = create(&path, &directory);
    let anchor = directory
        .path()
        .join(receipt.compiler_anchor_leaf().unwrap());
    assert_eq!(fs::metadata(&path).unwrap().nlink(), 2);
    assert_eq!(
        fs::metadata(&path).unwrap().ino(),
        fs::metadata(&anchor).unwrap().ino()
    );
    assert_eq!(
        receipt.file_identity,
        vault::recorded_identity(&fs::metadata(&path).unwrap())
    );
    assert!(receipt.native_created);
    assert!(receipt.same_native_issuance(&receipt.clone()));
    vault::verify_recorded_file(&receipt).unwrap();
    let mut changed = receipt.clone();
    changed.revision = hash("Another content\n");
    assert!(!receipt.same_native_issuance(&changed));
    assert!(vault::remove_recorded_file(&receipt)
        .unwrap_err()
        .contains("does not grant deletion"));
    assert_eq!(fs::read_to_string(&path).unwrap(), "Native section\n");
    assert_eq!(fs::read_to_string(anchor).unwrap(), "Native section\n");
}

#[test]
fn restart_physical_pin_allows_outside_edit_but_never_restores_old_completion() {
    use std::io::Write;
    let (_temporary, path, directory) = fixture();
    let receipt = create(&path, &directory);
    let leaf = receipt.compiler_anchor_leaf().unwrap().to_owned();
    let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
    file.write_all(b"Human postscript\n").unwrap();
    file.sync_all().unwrap();
    assert!(vault::verify_recorded_file(&receipt).is_err());
    assert!(vault::read_same_native_file(&receipt)
        .unwrap()
        .0
        .ends_with("Human postscript\n"));
    drop(receipt);
    let pin = reopen_compiler_prior_file_pin(&path, &directory, &leaf).unwrap();
    let guard = vault::lock_file_mutation().unwrap();
    let (current, revision) = read_compiler_prior_file_pin_locked(&guard, &pin).unwrap();
    assert_eq!(current, "Native section\nHuman postscript\n");
    let updated = write_compiler_file_anchored_locked(
        &guard,
        path.to_str().unwrap(),
        "Fresh section\nHuman postscript\n",
        Some(&pin),
        Some(&revision),
        &directory,
        "second-native.anchor",
    )
    .unwrap();
    assert!(!updated.native_created);
    vault::verify_recorded_file_unlocked(&updated).unwrap();
    assert_eq!(
        fs::read_to_string(directory.path().join(leaf)).unwrap(),
        current
    );
    assert_eq!(
        fs::metadata(directory.path().join("first-native.anchor"))
            .unwrap()
            .nlink(),
        1
    );
    assert!(read_compiler_prior_file_pin_locked(&guard, &pin).is_err());
}

#[test]
fn same_bytes_replacement_cannot_recreate_old_pair_or_receipt() {
    let (_temporary, path, directory) = fixture();
    let receipt = create(&path, &directory);
    let prior = compiler_prior_from_receipt(&receipt).unwrap();
    let replacement = vault::write_file_if_unchanged_recorded(
        path.to_str().unwrap(),
        "Native section\n",
        Some(&receipt.revision),
    )
    .unwrap();
    assert_eq!(replacement.revision, receipt.revision);
    assert!(!receipt.same_native_issuance(&replacement));
    assert!(vault::verify_recorded_file(&receipt).is_err());
    assert!(reopen_compiler_prior_file_pin(&path, &directory, "first-native.anchor").is_err());
    let guard = vault::lock_file_mutation().unwrap();
    assert!(write_compiler_file_anchored_locked(
        &guard,
        path.to_str().unwrap(),
        "Forbidden update\n",
        Some(&prior),
        Some(&receipt.revision),
        &directory,
        "rejected-native.anchor",
    )
    .is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "Native section\n");
}

#[test]
fn third_link_and_bare_two_link_initial_pin_are_rejected() {
    let (_temporary, path, directory) = fixture();
    let receipt = create(&path, &directory);
    let additional = path.with_file_name("unowned-alias.md");
    fs::hard_link(&path, &additional).unwrap();
    assert!(vault::verify_recorded_file(&receipt).is_err());
    assert!(vault::read_same_native_file(&receipt).is_err());
    let guard = vault::lock_file_mutation().unwrap();
    assert!(capture_compiler_initial_file_pin_locked(&guard, &path).is_err());
    assert!(reopen_compiler_prior_file_pin(&path, &directory, "first-native.anchor").is_err());
    assert_eq!(fs::read_to_string(&additional).unwrap(), "Native section\n");
    let ordinary = path.with_file_name("ordinary.md");
    fs::write(&ordinary, "Human page\n").unwrap();
    fs::hard_link(&ordinary, path.with_file_name("ordinary-alias.md")).unwrap();
    assert!(capture_compiler_initial_file_pin_locked(&guard, &ordinary).is_err());
}

#[test]
fn physical_initial_pin_keeps_explicit_overwrite_and_absence_contracts() {
    let (_temporary, path, directory) = fixture();
    fs::write(&path, "Human page\n").unwrap();
    let guard = vault::lock_file_mutation().unwrap();
    let prior = capture_compiler_initial_file_pin_locked(&guard, &path).unwrap();
    let (_, revision) = read_compiler_prior_file_pin_locked(&guard, &prior).unwrap();
    for (pin, expected) in [
        (None, Some(revision.as_str())),
        (Some(&prior), None),
        (None, None),
    ] {
        assert!(write_compiler_file_anchored_locked(
            &guard,
            path.to_str().unwrap(),
            "Forbidden\n",
            pin,
            expected,
            &directory,
            "unused-native.anchor",
        )
        .is_err());
    }
    assert!(write_compiler_file_anchored_locked(
        &guard,
        path.to_str().unwrap(),
        "Forbidden\n",
        Some(&prior),
        Some(&"0".repeat(64)),
        &directory,
        "wrong-hash.anchor",
    )
    .is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "Human page\n");
    let receipt = write_compiler_file_anchored_locked(
        &guard,
        path.to_str().unwrap(),
        "Human page\nNative append\n",
        Some(&prior),
        Some(&revision),
        &directory,
        "initial-native.anchor",
    )
    .unwrap();
    assert!(!receipt.native_created);
    vault::verify_recorded_file_unlocked(&receipt).unwrap();
}

#[test]
fn live_single_receipt_can_narrow_to_a_physical_pin() {
    let (_temporary, path, directory) = fixture();
    let old =
        vault::write_file_if_unchanged_recorded(path.to_str().unwrap(), "Native section\n", None)
            .unwrap();
    let prior = compiler_prior_from_receipt(&old).unwrap();
    let guard = vault::lock_file_mutation().unwrap();
    let (_, revision) = read_compiler_prior_file_pin_locked(&guard, &prior).unwrap();
    let fresh = write_compiler_file_anchored_locked(
        &guard,
        path.to_str().unwrap(),
        "Fresh section\n",
        Some(&prior),
        Some(&revision),
        &directory,
        "fresh-native.anchor",
    )
    .unwrap();
    assert!(!old.same_native_issuance(&fresh));
    assert!(!fresh.native_created);
    vault::verify_recorded_file_unlocked(&fresh).unwrap();
}

#[test]
fn private_directory_mode_replacement_and_ancestor_symlink_are_rejected() {
    let (_temporary, path, directory) = fixture();
    let receipt = create(&path, &directory);
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o755)).unwrap();
    assert!(directory.verify().is_err());
    assert!(vault::verify_recorded_file(&receipt).is_err());
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let retained = directory.path().with_file_name("retained-store");
    fs::rename(directory.path(), &retained).unwrap();
    fs::create_dir(directory.path()).unwrap();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    assert!(directory.verify().is_err());
    assert!(vault::read_same_native_file(&receipt).is_err());
    assert_eq!(
        fs::read_to_string(retained.join("first-native.anchor")).unwrap(),
        "Native section\n"
    );
    let alias = path.with_file_name("directory-alias");
    std::os::unix::fs::symlink(&retained, &alias).unwrap();
    assert!(open_compiler_pin_directory(&alias).is_err());
    let child = retained.join("child");
    fs::create_dir(&child).unwrap();
    fs::set_permissions(&child, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(open_compiler_pin_directory(&alias.join("child")).is_err());
}

#[test]
fn anchor_collision_wrong_pair_and_invalid_leaves_preserve_canonical() {
    let (_temporary, path, directory) = fixture();
    let receipt = create(&path, &directory);
    let prior = compiler_prior_from_receipt(&receipt).unwrap();
    let guard = vault::lock_file_mutation().unwrap();
    for leaf in [
        "first-native.anchor",
        "../outside",
        "bad/name",
        "bad\\name",
        "a..b",
        ".",
        "",
    ] {
        assert!(write_compiler_file_anchored_locked(
            &guard,
            path.to_str().unwrap(),
            "Forbidden\n",
            Some(&prior),
            Some(&receipt.revision),
            &directory,
            leaf,
        )
        .is_err());
    }
    fs::write(
        directory.path().join("independent-copy.anchor"),
        "Native section\n",
    )
    .unwrap();
    assert!(reopen_compiler_prior_file_pin(&path, &directory, "independent-copy.anchor").is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "Native section\n");
    assert_eq!(
        fs::read_to_string(directory.path().join("first-native.anchor")).unwrap(),
        "Native section\n"
    );
}

#[test]
fn bounded_read_utf8_and_symlink_controls_do_not_grant_an_update() {
    let (_temporary, path, directory) = fixture();
    fs::write(&path, "Human page\n").unwrap();
    let guard = vault::lock_file_mutation().unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(MAX_BYTES as u64 + 1)
        .unwrap();
    assert!(capture_compiler_initial_file_pin_locked(&guard, &path).is_err());
    fs::write(&path, [0xff]).unwrap();
    assert!(capture_compiler_initial_file_pin_locked(&guard, &path).is_err());
    assert!(write_compiler_file_anchored_locked(
        &guard,
        path.with_file_name("oversized.md").to_str().unwrap(),
        &"x".repeat(MAX_BYTES + 1),
        None,
        None,
        &directory,
        "oversized.anchor",
    )
    .is_err());
    let alias = path.with_file_name("symlink.md");
    std::os::unix::fs::symlink(&path, &alias).unwrap();
    assert!(capture_compiler_initial_file_pin_locked(&guard, &alias).is_err());
}

#[test]
fn fifo_leaf_swap_during_open_is_nonblocking_and_rejected() {
    use std::os::unix::ffi::OsStrExt;
    let (_temporary, path, _directory) = fixture();
    fs::write(&path, "Human page\n").unwrap();
    let retained = path.with_file_name("retained-human.md");
    let error = open_file_with_checkpoint(&path, || {
        fs::rename(&path, &retained).map_err(|e| e.to_string())?;
        let name = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        if unsafe { libc::mkfifo(name.as_ptr(), 0o600) } != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(())
    })
    .unwrap_err();
    assert!(error.contains("identity changed while opening"), "{error}");
    assert_eq!(fs::read_to_string(retained).unwrap(), "Human page\n");
}

#[test]
fn same_bytes_aba_after_staging_is_caught_by_writer_held_identity_recheck() {
    let (_temporary, path, directory) = fixture();
    let old = create(&path, &directory);
    let prior = compiler_prior_from_receipt(&old).unwrap();
    let _guard = vault::lock_file_mutation().unwrap();
    let error = write_anchored(
        &path,
        "Fresh section\n",
        Some(&prior),
        Some(&old.revision),
        &directory,
        "staged-native.anchor",
        |phase| {
            if matches!(phase, PinCheckpoint::Pinned) {
                let replacement = path.with_file_name("external-replacement.md");
                fs::write(&replacement, "Native section\n").map_err(|e| e.to_string())?;
                fs::rename(&replacement, &path).map_err(|e| e.to_string())?;
            }
            Ok(())
        },
    )
    .unwrap_err();
    assert!(error.contains("before canonical persist"), "{error}");
    assert_eq!(fs::read_to_string(&path).unwrap(), "Native section\n");
    assert_eq!(
        fs::read_to_string(directory.path().join("staged-native.anchor")).unwrap(),
        "Fresh section\n"
    );
    assert_eq!(
        fs::read_to_string(directory.path().join("first-native.anchor")).unwrap(),
        "Native section\n"
    );
}

#[test]
fn failure_after_canonical_persist_keeps_old_and_new_inode_custody() {
    let (_temporary, path, directory) = fixture();
    let old = create(&path, &directory);
    let prior = compiler_prior_from_receipt(&old).unwrap();
    let _guard = vault::lock_file_mutation().unwrap();
    let error = write_anchored(
        &path,
        "Fresh section\n",
        Some(&prior),
        Some(&old.revision),
        &directory,
        "uncertain-native.anchor",
        |phase| {
            if matches!(phase, PinCheckpoint::Persisted) {
                return Err("synthetic post-persist failure".into());
            }
            Ok(())
        },
    )
    .unwrap_err();
    assert!(
        error.contains("canonical persisted but admission incomplete"),
        "{error}"
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), "Fresh section\n");
    assert_eq!(
        fs::read_to_string(directory.path().join("uncertain-native.anchor")).unwrap(),
        "Fresh section\n"
    );
    assert_eq!(fs::metadata(&path).unwrap().nlink(), 2);
    assert_eq!(
        fs::read_to_string(directory.path().join("first-native.anchor")).unwrap(),
        "Native section\n"
    );
    assert_eq!(
        fs::metadata(directory.path().join("first-native.anchor"))
            .unwrap()
            .nlink(),
        1
    );
}
