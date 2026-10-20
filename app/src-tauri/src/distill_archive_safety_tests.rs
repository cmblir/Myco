use super::*;

fn write(root: &Path, rel: &str, bytes: &str) {
    let path = root.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, bytes).unwrap();
}

#[test]
fn archive_manifest_corrupt_append_preserves_bytes() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().canonicalize().unwrap();
    let target = manifest_path(&root, "llm-123");
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    let broken = "{\"id\":\"llm-123\", broken";
    std::fs::write(&target, broken).unwrap();
    assert!(append_distill_manifest(&root, "llm-123", vec![], vec![]).is_err());
    assert_eq!(std::fs::read_to_string(target).unwrap(), broken);
}

#[test]
fn archive_manifest_identity_mismatch_is_rejected() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().canonicalize().unwrap();
    let manifest = RunManifest {
        id: "llm-999".into(),
        ..Default::default()
    };
    let target = manifest_path(&root, "llm-123");
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    let original = serde_json::to_string(&manifest).unwrap();
    std::fs::write(&target, &original).unwrap();
    assert!(append_distill_manifest(&root, "llm-123", vec![], vec![]).is_err());
    assert_eq!(std::fs::read_to_string(target).unwrap(), original);
}

#[test]
fn archive_manifest_append_retry_does_not_duplicate_lineage() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().canonicalize().unwrap();
    write(&root, "wiki/maps/generated.md", "generated map");
    write(&root, "sessions/archive/2026-08/source.md", "source");
    let moved = MoveEntry {
        from: "sessions/source.md".into(),
        to: "sessions/archive/2026-08/source.md".into(),
    };
    for _ in 0..2 {
        append_distill_manifest(
            &root,
            "llm-123",
            vec![moved.clone()],
            vec!["wiki/maps/generated.md".into()],
        )
        .unwrap();
    }
    let manifest: RunManifest =
        serde_json::from_str(&std::fs::read_to_string(manifest_path(&root, "llm-123")).unwrap())
            .unwrap();
    assert_eq!(manifest.moves.len(), 1);
    assert_eq!(manifest.created.len(), 1);
}

#[test]
fn archive_manifest_undo_preserves_same_second_human_edit() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().canonicalize().unwrap();
    let rel = "wiki/maps/generated.md";
    write(&root, rel, "generated map");
    append_distill_manifest(&root, "llm-123", vec![], vec![rel.into()]).unwrap();
    write(&root, rel, "human replacement");
    let manifest: RunManifest =
        serde_json::from_str(&std::fs::read_to_string(manifest_path(&root, "llm-123")).unwrap())
            .unwrap();
    std::fs::File::open(root.join(rel))
        .unwrap()
        .set_modified(
            std::time::UNIX_EPOCH + std::time::Duration::from_secs(manifest.started_at as u64),
        )
        .unwrap();
    assert_eq!(undo(&root, "llm-123").unwrap(), 0);
    assert_eq!(
        std::fs::read_to_string(root.join(rel)).unwrap(),
        "human replacement"
    );
}

#[test]
fn archive_manifest_undo_never_deletes_raw_origin() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().canonicalize().unwrap();
    write(&root, "raw/source.md", "immutable origin");
    append_distill_manifest(&root, "llm-123", vec![], vec!["raw/source.md".into()]).unwrap();
    assert_eq!(undo(&root, "llm-123").unwrap(), 0);
    assert_eq!(
        std::fs::read_to_string(root.join("raw/source.md")).unwrap(),
        "immutable origin"
    );
}

#[test]
fn archive_manifest_undo_preserves_trimmed_raw_alias() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().canonicalize().unwrap();
    write(&root, "raw/source.md", "immutable origin");
    append_distill_manifest_checked(
        &root,
        "llm-124",
        vec![],
        vec![ArchivePublication {
            path: " raw/source.md ".into(),
            revision: archive::sha(b"immutable origin"),
            created: true,
        }],
    )
    .unwrap();
    assert_eq!(undo(&root, "llm-124").unwrap(), 0);
    assert_eq!(
        std::fs::read_to_string(root.join("raw/source.md")).unwrap(),
        "immutable origin"
    );
}

#[test]
fn archive_receipt_reports_revision_mismatch_and_missing_source() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().canonicalize().unwrap();
    write(&root, "sessions/changed.md", "resumed conversation");
    let response = archive_digested_sessions(
        &root,
        "2026-08-10",
        &["sessions/changed.md".into(), "sessions/missing.md".into()],
        Some(&[
            content_fingerprint(b"original"),
            content_fingerprint(b"missing"),
        ]),
    )
    .unwrap();
    let receipt = serde_json::to_value(response).unwrap();
    assert_eq!(receipt["moved"].as_array().map(Vec::len), Some(0));
    assert_eq!(receipt["pending"].as_array().map(Vec::len), Some(2));
    assert!(root.join("sessions/changed.md").exists());
}

#[cfg(unix)]
#[test]
fn archive_symlink_destination_never_moves_source_outside() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().canonicalize().unwrap();
    let outside = tempfile::tempdir().unwrap();
    write(&root, "sessions/source.md", "original conversation");
    std::os::unix::fs::symlink(outside.path(), root.join("sessions/archive")).unwrap();
    let result = archive_digested_sessions(
        &root,
        "2026-08-10",
        &["sessions/source.md".into()],
        Some(&[content_fingerprint(b"original conversation")]),
    );
    assert!(
        result.is_err(),
        "an unsafe archive destination must fail closed"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("sessions/source.md")).unwrap(),
        "original conversation"
    );
    assert!(!outside.path().join("2026-08/source.md").exists());
}

fn context(root: &Path, id: &str, created: bool) -> ArchiveContext {
    ArchiveContext {
        manifest_id: id.into(),
        publications: vec![ArchivePublication {
            path: "daily/2026-08-10.md".into(),
            revision: archive::sha(&std::fs::read(root.join("daily/2026-08-10.md")).unwrap()),
            created,
        }],
    }
}

fn manifest(root: &Path, id: &str) -> RunManifest {
    serde_json::from_slice(&std::fs::read(manifest_path(root, id)).unwrap()).unwrap()
}

fn run_archive(
    root: &Path,
    request: &ArchiveContext,
    files: &[String],
    fingerprints: &[String],
) -> ArchiveReceipt {
    archive_digested_sessions_with_context(
        root,
        "2026-08-10",
        files,
        Some(fingerprints),
        Some(request),
    )
    .unwrap()
}

#[test]
fn archive_journal_receipt_keeps_one_moved_and_two_pending_on_retry() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().canonicalize().unwrap();
    write(&root, "daily/2026-08-10.md", "generated digest");
    write(&root, "sessions/stable.md", "original");
    write(&root, "sessions/changed.md", "resumed");
    let files = vec![
        "sessions/stable.md".into(),
        "sessions/changed.md".into(),
        "sessions/missing.md".into(),
    ];
    let fingerprints = vec![content_fingerprint(b"original"); 3];
    let request = context(&root, "llm-456", true);
    for _ in 0..2 {
        let receipt = run_archive(&root, &request, &files, &fingerprints);
        assert_eq!(receipt.moved.len(), 1);
        assert_eq!(receipt.moved[0].revision, archive::sha(b"original"));
        assert_eq!(receipt.pending.len(), 2);
        assert!(receipt.retryable);
    }
    let recorded = manifest(&root, "llm-456");
    assert_eq!(recorded.moves.len(), 1);
    assert_eq!(recorded.created, vec!["daily/2026-08-10.md"]);
    assert_eq!(
        std::fs::read_to_string(root.join("sessions/changed.md")).unwrap(),
        "resumed"
    );
}

#[test]
fn archive_journal_recovers_move_before_completion_and_keeps_created_lineage() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().canonicalize().unwrap();
    write(&root, "daily/2026-08-10.md", "generated digest");
    write(&root, "sessions/source.md", "original");
    let files = vec!["sessions/source.md".into()];
    let fingerprints = vec![content_fingerprint(b"original")];
    run_archive(
        &root,
        &context(&root, "llm-457", true),
        &files,
        &fingerprints,
    );
    // Synthetic persisted crash state: intent survived, completion did not.
    let mut interrupted = manifest(&root, "llm-457");
    interrupted.moves.clear();
    interrupted.move_revisions.clear();
    save_manifest(&root, &interrupted).unwrap();
    let request = context(&root, "llm-457", false);
    for _ in 0..2 {
        let receipt = run_archive(&root, &request, &files, &fingerprints);
        assert_eq!(receipt.moved.len(), 1);
        assert!(receipt.pending.is_empty());
        assert_eq!(receipt.created_note_paths, vec!["daily/2026-08-10.md"]);
    }
    let repaired = manifest(&root, "llm-457");
    assert_eq!(repaired.moves.len(), 1);
    assert_eq!(repaired.created.len(), 1);
    assert_eq!(undo(&root, "llm-457").unwrap(), 2);
    assert_eq!(
        std::fs::read_to_string(root.join("sessions/source.md")).unwrap(),
        "original"
    );
    assert!(!root.join("daily/2026-08-10.md").exists());
}

#[cfg(unix)]
#[test]
fn archive_journal_recovers_two_names_after_link_before_unlink() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().canonicalize().unwrap();
    write(&root, "daily/2026-08-10.md", "generated digest");
    write(&root, "sessions/source.md", "original");
    let files = vec!["sessions/source.md".into()];
    let fingerprints = vec![content_fingerprint(b"original")];
    let request = context(&root, "llm-458", true);
    let receipt = run_archive(&root, &request, &files, &fingerprints);
    let destination = root.join(&receipt.moved[0].to);
    // Synthetic persisted crash state immediately after a non-overwriting link.
    std::fs::hard_link(&destination, root.join(&files[0])).unwrap();
    let mut interrupted = manifest(&root, "llm-458");
    interrupted.moves.clear();
    interrupted.move_revisions.clear();
    save_manifest(&root, &interrupted).unwrap();
    let recovered = run_archive(&root, &request, &files, &fingerprints);
    assert_eq!(recovered.moved.len(), 1);
    assert!(recovered.pending.is_empty());
    assert!(!root.join(&files[0]).exists());
    assert_eq!(std::fs::read_to_string(destination).unwrap(), "original");
}

#[test]
fn archive_publication_revision_conflict_preserves_source_and_manifest_absence() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().canonicalize().unwrap();
    write(&root, "daily/2026-08-10.md", "generated digest");
    write(&root, "sessions/source.md", "original");
    let request = context(&root, "llm-459", true);
    write(&root, "daily/2026-08-10.md", "human edit");
    let result = archive_digested_sessions_with_context(
        &root,
        "2026-08-10",
        &["sessions/source.md".into()],
        Some(&[content_fingerprint(b"original")]),
        Some(&request),
    );
    assert!(result.is_err());
    assert!(!manifest_path(&root, "llm-459").exists());
    assert_eq!(
        std::fs::read_to_string(root.join("sessions/source.md")).unwrap(),
        "original"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("daily/2026-08-10.md")).unwrap(),
        "human edit"
    );
}

#[test]
fn archive_publication_only_retry_records_created_note_once() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().canonicalize().unwrap();
    write(&root, "daily/2026-08-10.md", "partial evidence digest");
    let first = run_archive(&root, &context(&root, "llm-460", true), &[], &[]);
    let retry = run_archive(&root, &context(&root, "llm-460", false), &[], &[]);
    assert!(first.moved.is_empty() && retry.moved.is_empty());
    assert!(first.pending.is_empty() && retry.pending.is_empty());
    assert_eq!(retry.created_note_paths, vec!["daily/2026-08-10.md"]);
    assert_eq!(manifest(&root, "llm-460").created.len(), 1);
    assert_eq!(undo(&root, "llm-460").unwrap(), 1);
}

#[test]
fn archive_legacy_unsigned_undo_preserves_changed_bytes_even_with_old_mtime() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().canonicalize().unwrap();
    write(
        &root,
        "sessions/archive/2026-08/source.md",
        "human source replacement",
    );
    write(&root, "daily/2026-08-10.md", "human digest replacement");
    for rel in ["sessions/archive/2026-08/source.md", "daily/2026-08-10.md"] {
        std::fs::File::open(root.join(rel))
            .unwrap()
            .set_modified(std::time::UNIX_EPOCH)
            .unwrap();
    }
    save_manifest(
        &root,
        &RunManifest {
            id: "digest-100".into(),
            started_at: 100,
            moves: vec![MoveEntry {
                from: "sessions/source.md".into(),
                to: "sessions/archive/2026-08/source.md".into(),
            }],
            created: vec!["daily/2026-08-10.md".into()],
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(undo(&root, "digest-100").unwrap(), 0);
    assert!(!root.join("sessions/source.md").exists());
    assert_eq!(
        std::fs::read_to_string(root.join("sessions/archive/2026-08/source.md")).unwrap(),
        "human source replacement"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("daily/2026-08-10.md")).unwrap(),
        "human digest replacement"
    );
}

#[cfg(unix)]
#[test]
fn archive_raw_hardlink_source_is_pending_and_immutable() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().canonicalize().unwrap();
    write(&root, "raw/origin.md", "immutable original");
    std::fs::create_dir_all(root.join("sessions")).unwrap();
    std::fs::hard_link(root.join("raw/origin.md"), root.join("sessions/source.md")).unwrap();
    let receipt = archive_digested_sessions(
        &root,
        "2026-08-10",
        &["sessions/source.md".into()],
        Some(&[content_fingerprint(b"immutable original")]),
    )
    .unwrap();
    assert!(receipt.moved.is_empty());
    assert_eq!(receipt.pending.len(), 1);
    assert_eq!(
        std::fs::read_to_string(root.join("raw/origin.md")).unwrap(),
        "immutable original"
    );
    assert!(root.join("sessions/source.md").exists());
}

#[test]
fn archive_partial_read_failure_keeps_completed_move_receipt() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().canonicalize().unwrap();
    write(&root, "sessions/stable.md", "original");
    std::fs::create_dir_all(root.join("sessions/unreadable.md")).unwrap();
    let receipt = archive_digested_sessions(
        &root,
        "2026-08-10",
        &["sessions/stable.md".into(), "sessions/unreadable.md".into()],
        Some(&[
            content_fingerprint(b"original"),
            content_fingerprint(b"original"),
        ]),
    )
    .unwrap();
    assert_eq!(receipt.moved.len(), 1);
    assert_eq!(receipt.pending.len(), 1);
    assert_eq!(receipt.pending[0].path, "sessions/unreadable.md");
    assert!(root.join(&receipt.moved[0].to).exists());
    assert!(root.join("sessions/unreadable.md").is_dir());
}

#[test]
fn archive_edited_journal_cannot_redirect_into_raw() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().canonicalize().unwrap();
    write(&root, "daily/2026-08-10.md", "generated digest");
    write(&root, "sessions/source.md", "original");
    let files = vec!["sessions/source.md".into()];
    let fingerprints = vec![content_fingerprint(b"original")];
    let request = context(&root, "llm-461", true);
    let first = run_archive(&root, &request, &files, &fingerprints);
    std::fs::remove_file(root.join(&first.moved[0].to)).unwrap();
    write(&root, "sessions/source.md", "original");
    std::fs::create_dir_all(root.join("raw")).unwrap();
    let mut edited = manifest(&root, "llm-461");
    edited.moves.clear();
    edited.move_revisions.clear();
    edited.archive.as_mut().unwrap().plans[0].to = "raw/redirected.md".into();
    save_manifest(&root, &edited).unwrap();
    let result = archive_digested_sessions_with_context(
        &root,
        "2026-08-10",
        &files,
        Some(&fingerprints),
        Some(&request),
    );
    assert!(result.is_err());
    assert_eq!(
        std::fs::read_to_string(root.join("sessions/source.md")).unwrap(),
        "original"
    );
    assert!(!root.join("raw/redirected.md").exists());
}
