use super::*;

fn open(state: &VaultRoot, root: &Path) -> AgentVaultSession {
    let generation = state.begin_open().unwrap();
    state
        .finish_open(generation, root.to_path_buf(), || ())
        .unwrap();
    state.snapshot().unwrap()
}

fn fixture() -> (tempfile::TempDir, PathBuf, VaultRoot, AgentVaultSession) {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    std::fs::create_dir(root.join("_inbox")).unwrap();
    std::fs::write(root.join("_inbox/a.md"), "native inbox original\n").unwrap();
    let state = VaultRoot::default();
    let origin = open(&state, &root);
    (directory, root, state, origin)
}

#[test]
fn native_snapshot_reads_exact_bytes_and_rejects_selected_revision_change() {
    let (_directory, root, state, origin) = fixture();
    let expected = digest(b"native inbox original\n");
    let snapshot = capture(&state, &origin, "_inbox/a.md", Some(&expected)).unwrap();
    assert_eq!(snapshot.text, "native inbox original\n");
    assert_eq!(snapshot.source_revision, expected);
    std::fs::write(root.join("_inbox/a.md"), "changed original\n").unwrap();
    assert!(original(&state, &snapshot).is_err());
    assert!(capture(&state, &origin, "_inbox/a.md", Some(&expected)).is_err());
    assert!(archive(&state, &snapshot, None).is_err());
    assert_eq!(
        std::fs::read_to_string(root.join("_inbox/a.md")).unwrap(),
        "changed original\n"
    );
    assert!(!root.join("_inbox/.archived").exists());
    release(&snapshot).unwrap();
}

#[test]
fn same_path_reopen_refuses_old_snapshot_and_release_still_reclaims_it() {
    let (_directory, root, state, origin) = fixture();
    let snapshot = capture(&state, &origin, "_inbox/a.md", None).unwrap();
    let current = open(&state, &root);
    assert!(!same_origin(&current, &origin));
    assert!(original(&state, &snapshot).is_err());
    assert!(archive(&state, &snapshot, None).is_err());
    assert!(begin(&state, &snapshot, RoleUsage::Foreground).is_err());
    assert!(root.join("_inbox/a.md").is_file());
    release(&snapshot).unwrap();
    assert!(!grants().lock().unwrap().contains_key(&snapshot.snapshot_id));
}

#[test]
fn public_snapshot_fields_do_not_recreate_native_authority() {
    let (_directory, root, state, origin) = fixture();
    let snapshot = capture(&state, &origin, "_inbox/a.md", None).unwrap();
    let mut changed = snapshot.clone();
    changed.text = "caller supplied original".into();
    assert!(original(&state, &changed).is_err());
    assert!(release(&changed).is_err());
    changed = snapshot.clone();
    changed.snapshot_id = "00".repeat(16);
    assert!(original(&state, &changed).is_err());
    changed = snapshot.clone();
    changed.source_revision = digest(changed.text.as_bytes()).to_uppercase();
    assert!(original(&state, &changed).is_err());
    assert!(root.join("_inbox/a.md").is_file());
    release(&snapshot).unwrap();
    assert!(original(&state, &snapshot).is_err());
}

#[test]
fn checked_manual_archive_returns_real_path_and_never_claims_harvest_completion() {
    let (_directory, root, state, origin) = fixture();
    let snapshot = capture(&state, &origin, "_inbox/a.md", None).unwrap();
    let receipt = archive(&state, &snapshot, None).unwrap();
    assert!(!receipt.harvest_completed);
    assert_eq!(receipt.source_revision, snapshot.source_revision);
    assert_eq!(
        std::fs::read_to_string(&receipt.archived_path).unwrap(),
        snapshot.text
    );
    assert!(!root.join("_inbox/a.md").exists());
    assert!(!root.join(".myco/backfill.json").exists());
    release(&snapshot).unwrap();
}

#[test]
fn corrupt_state_refuses_checked_archive_without_moving_original() {
    let (_directory, root, state, origin) = fixture();
    let snapshot = capture(&state, &origin, "_inbox/a.md", None).unwrap();
    std::fs::create_dir(root.join(".myco")).unwrap();
    std::fs::write(root.join(".myco/backfill.json"), "{ malformed").unwrap();
    assert!(archive(&state, &snapshot, None).is_err());
    assert_eq!(
        std::fs::read_to_string(root.join("_inbox/a.md")).unwrap(),
        snapshot.text
    );
    assert!(!root.join("_inbox/.archived").exists());
    assert_eq!(
        std::fs::read_to_string(root.join(".myco/backfill.json")).unwrap(),
        "{ malformed"
    );
    release(&snapshot).unwrap();
}

#[cfg(unix)]
#[test]
fn snapshot_rejects_links_nested_paths_binary_and_same_bytes_replacement() {
    use std::os::unix::fs::symlink;
    let (_directory, root, state, origin) = fixture();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("evidence.md"), "outside").unwrap();
    symlink(
        outside.path().join("evidence.md"),
        root.join("_inbox/linked.md"),
    )
    .unwrap();
    assert!(capture(&state, &origin, "_inbox/linked.md", None).is_err());
    assert!(capture(&state, &origin, "_inbox/../outside.md", None).is_err());
    assert!(capture(&state, &origin, "_inbox/nested/a.md", None).is_err());
    std::fs::write(root.join("_inbox/image.png"), b"synthetic binary").unwrap();
    assert!(capture(&state, &origin, "_inbox/image.png", None).is_err());
    let snapshot = capture(&state, &origin, "_inbox/a.md", None).unwrap();
    std::fs::rename(
        root.join("_inbox/a.md"),
        root.join("_inbox/retained-original.md"),
    )
    .unwrap();
    std::fs::write(root.join("_inbox/a.md"), &snapshot.text).unwrap();
    assert!(archive(&state, &snapshot, None).is_err());
    assert!(root.join("_inbox/a.md").is_file());
    assert!(root.join("_inbox/retained-original.md").is_file());
    release(&snapshot).unwrap();
}
