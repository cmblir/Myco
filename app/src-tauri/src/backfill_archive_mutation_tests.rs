use super::*;

fn archived_source(root: &Path) -> String {
    let path = root.join("_inbox/.archived/synthetic.md");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, "synthetic archived source\n").unwrap();
    path.to_string_lossy().into_owned()
}

#[test]
fn completion_refuses_corrupt_state_instead_of_claiming_no_pending_copy() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let archived = archived_source(root);
    std::fs::create_dir_all(root.join(".myco")).unwrap();
    let corrupt = "{ invalid backfill state";
    std::fs::write(state_path(root), corrupt).unwrap();

    let result = complete_inbox_at(root, "_inbox/synthetic.md", &archived);

    assert!(
        result.is_err(),
        "corrupt state became completion: {result:?}"
    );
    assert_eq!(std::fs::read_to_string(state_path(root)).unwrap(), corrupt);
    assert_eq!(
        std::fs::read_to_string(archived).unwrap(),
        "synthetic archived source\n"
    );
}

#[test]
fn completion_refuses_unreadable_state_instead_of_claiming_no_pending_copy() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let archived = archived_source(root);
    std::fs::create_dir_all(state_path(root)).unwrap();

    let result = complete_inbox_at(root, "_inbox/synthetic.md", &archived);

    assert!(
        result.is_err(),
        "unreadable state became completion: {result:?}"
    );
    assert!(state_path(root).is_dir());
    assert_eq!(
        std::fs::read_to_string(archived).unwrap(),
        "synthetic archived source\n"
    );
}

#[test]
fn completion_without_a_state_file_retains_the_no_pending_copy_result() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let archived = archived_source(root);

    assert!(!complete_inbox_at(root, "_inbox/synthetic.md", &archived).unwrap());
    assert!(!state_path(root).exists());
    assert_eq!(
        std::fs::read_to_string(archived).unwrap(),
        "synthetic archived source\n"
    );
}

fn session_source(root: &Path) -> String {
    let body = "synthetic session source\n".repeat(800);
    std::fs::create_dir_all(root.join("sessions")).unwrap();
    std::fs::write(root.join("sessions/synthetic.md"), &body).unwrap();
    body
}

#[test]
fn promotion_refuses_corrupt_state_before_copying_or_replacing_bookkeeping() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let source = session_source(root);
    std::fs::create_dir_all(root.join(".myco")).unwrap();
    let corrupt = "{ invalid backfill state";
    std::fs::write(state_path(root), corrupt).unwrap();

    let result = promote_rels(root, &["sessions/synthetic.md".to_string()]);

    assert!(result.is_err(), "corrupt state permitted promotion");
    assert!(!root.join("_inbox").exists());
    assert_eq!(std::fs::read_to_string(state_path(root)).unwrap(), corrupt);
    assert_eq!(
        std::fs::read_to_string(root.join("sessions/synthetic.md")).unwrap(),
        source
    );
}

#[test]
fn promotion_refuses_unreadable_state_before_copying_or_replacing_bookkeeping() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let source = session_source(root);
    std::fs::create_dir_all(state_path(root)).unwrap();

    let result = promote_rels(root, &["sessions/synthetic.md".to_string()]);

    assert!(result.is_err(), "unreadable state permitted promotion");
    assert!(!root.join("_inbox").exists());
    assert!(state_path(root).is_dir());
    assert_eq!(
        std::fs::read_to_string(root.join("sessions/synthetic.md")).unwrap(),
        source
    );
}

#[test]
fn archive_refuses_a_shared_pending_revision_mismatch_before_moving_the_copy() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let source = session_source(root);
    std::fs::create_dir_all(root.join("_inbox")).unwrap();
    std::fs::write(root.join("_inbox/shared.md"), &source).unwrap();
    let expected_revision = revision(source.as_bytes());
    let mut state = BackfillState::default();
    state.pending.insert(
        "sessions/a.md".to_string(),
        PendingCopy {
            inbox_rel: "_inbox/shared.md".to_string(),
            source_revision: expected_revision.clone(),
        },
    );
    state.pending.insert(
        "sessions/b.md".to_string(),
        PendingCopy {
            inbox_rel: "_inbox/shared.md".to_string(),
            source_revision: revision(b"another original revision"),
        },
    );
    save_state(root, &state).unwrap();
    let before = std::fs::read(state_path(root)).unwrap();

    let result = archive_pending_inbox_at(
        root,
        "_inbox/shared.md",
        &expected_revision,
        &["sessions/a.md".to_string(), "sessions/b.md".to_string()],
        || Ok(()),
    );

    assert!(
        result.is_err(),
        "mismatched pending revision archived: {result:?}"
    );
    assert_eq!(
        std::fs::read(root.join("_inbox/shared.md")).unwrap(),
        source.as_bytes()
    );
    assert!(!root.join("_inbox/.archived").exists());
    assert_eq!(std::fs::read(state_path(root)).unwrap(), before);
    assert!(read_state_checked(root).unwrap().completed.is_empty());
}

#[test]
fn promotion_refuses_changed_copy_bytes_and_preserves_the_unregistered_copy() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let original = session_source(root);
    let changed = "changed synthetic session source\n".repeat(800);

    let result = promote_rels_impl(
        root,
        &["sessions/synthetic.md".to_string()],
        |_| Ok(()),
        |root, source_rel| {
            std::fs::write(root.join(source_rel), &changed)
                .map_err(|error| format!("change test source before copy: {error}"))
        },
    )
    .unwrap();

    assert_eq!(result.failed.len(), 1, "changed source was accepted");
    assert_eq!(result.failed[0].0, "sessions/synthetic.md");
    assert!(result.names.is_empty());
    assert!(result.inbox_sources.is_empty());
    assert!(!state_path(root).exists());
    assert_eq!(
        std::fs::read(root.join("_inbox/synthetic.md")).unwrap(),
        changed.as_bytes()
    );
    assert_eq!(
        std::fs::read(root.join("sessions/synthetic.md")).unwrap(),
        changed.as_bytes()
    );
    assert_ne!(original, changed);
}

fn shared_pending_source(root: &Path) -> String {
    let body = "shared synthetic session source\n".repeat(800);
    std::fs::create_dir_all(root.join("sessions")).unwrap();
    std::fs::write(root.join("sessions/a.md"), &body).unwrap();
    std::fs::write(root.join("sessions/b.md"), &body).unwrap();
    let promoted = promote_rels(
        root,
        &["sessions/a.md".to_string(), "sessions/b.md".to_string()],
    )
    .unwrap();
    assert_eq!(promoted.names, vec!["a.md", "a.md"]);
    body
}

#[test]
fn shared_copy_bindings_and_pending_lookup_retain_each_source_identity() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let source = shared_pending_source(root);
    let expected = revision(source.as_bytes());

    let resumed = promote_rels(
        root,
        &["sessions/a.md".to_string(), "sessions/b.md".to_string()],
    )
    .unwrap();

    assert_eq!(resumed.created, 0);
    assert_eq!(
        resumed.inbox_sources,
        vec![
            InboxSourceBinding {
                source_rel: "sessions/a.md".to_string(),
                inbox_rel: "_inbox/a.md".to_string(),
                source_revision: expected.clone(),
            },
            InboxSourceBinding {
                source_rel: "sessions/b.md".to_string(),
                inbox_rel: "_inbox/a.md".to_string(),
                source_revision: expected.clone(),
            },
        ]
    );
    assert_eq!(
        pending_sources_for_inbox(root, "_inbox/a.md", &expected).unwrap(),
        vec!["sessions/a.md", "sessions/b.md"]
    );
    assert!(pending_sources_for_inbox(root, "_inbox/a.md", &revision(b"changed")).is_err());
    assert_eq!(
        std::fs::read(root.join("_inbox/a.md")).unwrap(),
        source.as_bytes()
    );
}

#[test]
fn archive_completes_only_authorized_shared_sources_and_keeps_the_rest_pending() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let source = shared_pending_source(root);
    let expected = revision(source.as_bytes());

    let receipt = archive_pending_inbox_at(
        root,
        "_inbox/a.md",
        &expected,
        &["sessions/a.md".to_string()],
        || Ok(()),
    )
    .unwrap();

    assert!(!receipt.harvest_completed);
    assert_eq!(receipt.source_revision, expected);
    assert_eq!(
        std::fs::read(receipt.archived_path).unwrap(),
        source.as_bytes()
    );
    let state = read_state_checked(root).unwrap();
    assert_eq!(state.completed.len(), 1);
    assert!(state.completed.contains_key("sessions/a.md"));
    assert_eq!(state.pending.len(), 1);
    assert!(state.pending.contains_key("sessions/b.md"));
    assert_eq!(
        std::fs::read(root.join("sessions/a.md")).unwrap(),
        source.as_bytes()
    );
    assert_eq!(
        std::fs::read(root.join("sessions/b.md")).unwrap(),
        source.as_bytes()
    );
}

#[test]
fn archive_reports_completion_only_when_every_pending_source_is_authorized() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let source = shared_pending_source(root);
    let expected = revision(source.as_bytes());

    let receipt = archive_pending_inbox_at(
        root,
        "_inbox/a.md",
        &expected,
        &["sessions/a.md".to_string(), "sessions/b.md".to_string()],
        || Ok(()),
    )
    .unwrap();

    assert!(receipt.harvest_completed);
    assert_eq!(
        std::fs::read(receipt.archived_path).unwrap(),
        source.as_bytes()
    );
    let state = read_state_checked(root).unwrap();
    assert!(state.pending.is_empty());
    assert_eq!(state.completed.len(), 2);
    assert!(state
        .completed
        .values()
        .all(|item| item.source_revision == expected));
}

#[test]
fn archive_without_authorized_sources_preserves_all_pending_state() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let source = shared_pending_source(root);
    let before = std::fs::read(state_path(root)).unwrap();

    let receipt = archive_pending_inbox_at(
        root,
        "_inbox/a.md",
        &revision(source.as_bytes()),
        &[],
        || Ok(()),
    )
    .unwrap();

    assert!(!receipt.harvest_completed);
    assert_eq!(
        std::fs::read(receipt.archived_path).unwrap(),
        source.as_bytes()
    );
    assert_eq!(std::fs::read(state_path(root)).unwrap(), before);
    assert!(read_state_checked(root).unwrap().completed.is_empty());
}

#[test]
fn archive_rejects_unknown_and_duplicate_completion_keys_before_movement() {
    for keys in [
        vec!["sessions/unrelated.md".to_string()],
        vec!["sessions/a.md".to_string(), "sessions/a.md".to_string()],
    ] {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let source = shared_pending_source(root);
        let before = std::fs::read(state_path(root)).unwrap();

        let result = archive_pending_inbox_at(
            root,
            "_inbox/a.md",
            &revision(source.as_bytes()),
            &keys,
            || Ok(()),
        );

        assert!(result.is_err());
        assert_eq!(
            std::fs::read(root.join("_inbox/a.md")).unwrap(),
            source.as_bytes()
        );
        assert!(!root.join("_inbox/.archived").exists());
        assert_eq!(std::fs::read(state_path(root)).unwrap(), before);
    }
}

#[test]
fn archive_rejects_failed_native_validation_without_moving_or_completing() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let source = shared_pending_source(root);
    let before = std::fs::read(state_path(root)).unwrap();

    let result = archive_pending_inbox_at(
        root,
        "_inbox/a.md",
        &revision(source.as_bytes()),
        &["sessions/a.md".to_string(), "sessions/b.md".to_string()],
        || Err("native publication changed".to_string()),
    );

    assert!(result.unwrap_err().contains("native publication changed"));
    assert_eq!(
        std::fs::read(root.join("_inbox/a.md")).unwrap(),
        source.as_bytes()
    );
    assert!(!root.join("_inbox/.archived").exists());
    assert_eq!(std::fs::read(state_path(root)).unwrap(), before);
}

#[test]
fn archive_state_save_failure_reports_the_retained_archive_and_preserves_pending_backing() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let source = session_source(root);
    let promoted = promote_rels(root, &["sessions/synthetic.md".to_string()]).unwrap();
    let expected = promoted.inbox_sources[0].source_revision.clone();
    let before = std::fs::read(state_path(root)).unwrap();
    let backup = root.join(".myco/backfill.before-save.json");

    let result = archive_pending_inbox_impl(
        root,
        "_inbox/synthetic.md",
        &expected,
        &["sessions/synthetic.md".to_string()],
        || Ok(()),
        |_| {
            std::fs::rename(state_path(root), &backup)
                .map_err(|error| format!("retain test state before save failure: {error}"))?;
            std::fs::create_dir(state_path(root))
                .map_err(|error| format!("inject test state save failure: {error}"))
        },
    );

    let error = result.unwrap_err();
    let archived = root
        .canonicalize()
        .unwrap()
        .join("_inbox/.archived/synthetic.md");
    assert!(
        error.contains(&archived.to_string_lossy().to_string()),
        "{error}"
    );
    assert!(error.contains("completion state was not saved"), "{error}");
    assert!(error.contains("persist state:"), "{error}");
    assert_eq!(std::fs::read(archived).unwrap(), source.as_bytes());
    assert_eq!(
        std::fs::read(root.join("sessions/synthetic.md")).unwrap(),
        source.as_bytes()
    );
    assert!(state_path(root).is_dir());
    assert_eq!(std::fs::read(&backup).unwrap(), before);
    let preserved: BackfillState = serde_json::from_slice(&std::fs::read(backup).unwrap()).unwrap();
    assert_eq!(preserved.pending.len(), 1);
    assert_eq!(
        preserved.pending["sessions/synthetic.md"].source_revision,
        expected
    );
    assert!(preserved.completed.is_empty());
}

#[test]
fn archive_rejects_a_changed_state_snapshot_without_overwriting_the_new_state() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let source = shared_pending_source(root);
    let replacement = r#"{"promoted":{"sessions/later.md":42},"pending":{},"completed":{}}"#;

    let result = archive_pending_inbox_at(
        root,
        "_inbox/a.md",
        &revision(source.as_bytes()),
        &[],
        || {
            std::fs::write(state_path(root), replacement)
                .map_err(|error| format!("replace test state before move: {error}"))
        },
    );

    assert!(result.unwrap_err().contains("backfill state changed"));
    assert_eq!(
        std::fs::read(root.join("_inbox/a.md")).unwrap(),
        source.as_bytes()
    );
    assert_eq!(
        std::fs::read(root.join("sessions/a.md")).unwrap(),
        source.as_bytes()
    );
    assert_eq!(
        std::fs::read(root.join("sessions/b.md")).unwrap(),
        source.as_bytes()
    );
    assert!(!root.join("_inbox/.archived").exists());
    assert_eq!(
        std::fs::read_to_string(state_path(root)).unwrap(),
        replacement
    );
}

#[test]
fn generic_archive_keeps_false_completion_and_uses_the_camel_case_ipc_receipt() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let source = session_source(root);
    std::fs::create_dir_all(root.join("_inbox")).unwrap();
    std::fs::write(root.join("_inbox/manual.md"), &source).unwrap();
    let expected = revision(source.as_bytes());

    let receipt =
        archive_pending_inbox_at(root, "_inbox/manual.md", &expected, &[], || Ok(())).unwrap();

    assert_eq!(
        serde_json::to_value(&receipt).unwrap(),
        serde_json::json!({
            "archivedPath": receipt.archived_path,
            "sourceRevision": expected,
            "harvestCompleted": false,
        })
    );
    assert!(!receipt.harvest_completed);
    assert_eq!(
        std::fs::read(receipt.archived_path).unwrap(),
        source.as_bytes()
    );
    assert!(!state_path(root).exists());
}

#[test]
fn archive_rejects_state_creation_after_an_absent_snapshot() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let source = session_source(root);
    std::fs::create_dir_all(root.join("_inbox")).unwrap();
    std::fs::write(root.join("_inbox/manual.md"), &source).unwrap();
    std::fs::create_dir_all(root.join(".myco")).unwrap();

    let result = archive_pending_inbox_at(
        root,
        "_inbox/manual.md",
        &revision(source.as_bytes()),
        &[],
        || {
            std::fs::write(state_path(root), "{}")
                .map_err(|error| format!("create test state before move: {error}"))
        },
    );

    assert!(result.unwrap_err().contains("backfill state changed"));
    assert_eq!(
        std::fs::read(root.join("_inbox/manual.md")).unwrap(),
        source.as_bytes()
    );
    assert!(!root.join("_inbox/.archived").exists());
    assert_eq!(std::fs::read_to_string(state_path(root)).unwrap(), "{}");
}

#[test]
fn archive_and_pending_lookup_refuse_corrupt_or_unreadable_state_before_movement() {
    for unreadable in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let source = session_source(root);
        std::fs::create_dir_all(root.join("_inbox")).unwrap();
        std::fs::write(root.join("_inbox/manual.md"), &source).unwrap();
        std::fs::create_dir_all(root.join(".myco")).unwrap();
        if unreadable {
            std::fs::create_dir(state_path(root)).unwrap();
        } else {
            std::fs::write(state_path(root), "{ corrupt state").unwrap();
        }
        let expected = revision(source.as_bytes());

        assert!(pending_sources_for_inbox(root, "_inbox/manual.md", &expected).is_err());
        let result = archive_pending_inbox_at(root, "_inbox/manual.md", &expected, &[], || Ok(()));

        assert!(result.is_err());
        assert_eq!(
            std::fs::read(root.join("_inbox/manual.md")).unwrap(),
            source.as_bytes()
        );
        assert!(!root.join("_inbox/.archived").exists());
        if unreadable {
            assert!(state_path(root).is_dir());
        } else {
            assert_eq!(
                std::fs::read_to_string(state_path(root)).unwrap(),
                "{ corrupt state"
            );
        }
    }
}
