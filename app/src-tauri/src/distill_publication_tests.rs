use super::*;

struct Fixture {
    _directory: tempfile::TempDir,
    root: PathBuf,
    state: VaultRoot,
    registry: DistillPublicationRegistry,
    origin: AgentVaultSession,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let state = VaultRoot::default();
        let generation = state.begin_open().unwrap();
        state.finish_open(generation, root.clone(), || ()).unwrap();
        let origin = state.snapshot().unwrap();
        Self {
            _directory: directory,
            root,
            state,
            registry: DistillPublicationRegistry::default(),
            origin,
        }
    }

    fn artifact() -> ManagedArtifact {
        ManagedArtifact::Daily {
            key: "2026-08-10".into(),
        }
    }

    fn publish(
        &self,
        operation: &str,
        content: &str,
        expected: Option<&str>,
    ) -> Result<PublicationReceipt, String> {
        publish(
            &self.state,
            &self.registry,
            &self.origin,
            operation,
            &Self::artifact(),
            content,
            expected,
        )
    }

    fn validate(
        &self,
        operation: &str,
        proof: &PublicationReceipt,
        claim: ArchivePublication,
    ) -> Result<Vec<ArchivePublication>, String> {
        self.state.with_origin(&self.origin, |root| {
            validate(
                &self.registry,
                root,
                &self.origin,
                operation,
                std::slice::from_ref(&proof.publication_id),
                &[claim],
            )
        })
    }
}

fn claim(receipt: &PublicationReceipt, created: bool) -> ArchivePublication {
    ArchivePublication {
        path: receipt.path.clone(),
        revision: receipt.revision.clone(),
        created,
    }
}

#[test]
fn publication_native_absence_cas_issues_created_receipt_and_idempotent_retry() {
    let fixture = Fixture::new();
    let first = fixture.publish("llm-910", "native output", None).unwrap();
    assert!(first.native_created);
    assert_eq!(first.state, PublicationPhase::Published);
    assert_eq!(first.path, "daily/2026-08-10.md");
    assert_eq!(
        first.revision,
        format!("{:x}", Sha256::digest(b"native output"))
    );
    assert_eq!(first.publication_id.len(), 64);
    let retry = fixture.publish("llm-910", "native output", None).unwrap();
    assert_eq!(retry.publication_id, first.publication_id);
    assert_eq!(retry.file_identity, first.file_identity);
    let retry_from_existing = fixture
        .publish("llm-910", "native output", Some(&first.revision))
        .unwrap();
    assert_eq!(retry_from_existing.publication_id, first.publication_id);
    assert!(retry_from_existing.native_created);
    assert!(
        fixture
            .validate("llm-910", &first, claim(&first, false))
            .unwrap()[0]
            .created
    );
    assert!(fixture
        .publish("llm-910", "different output", None)
        .is_err());
}

#[test]
fn publication_native_existing_human_update_never_issues_creation_authority() {
    let fixture = Fixture::new();
    std::fs::create_dir(fixture.root.join("daily")).unwrap();
    std::fs::write(fixture.root.join("daily/2026-08-10.md"), "human original").unwrap();
    let expected = format!("{:x}", Sha256::digest(b"human original"));
    let proof = fixture
        .publish("llm-911", "requested update", Some(&expected))
        .unwrap();
    assert!(!proof.native_created);
    assert!(
        !fixture
            .validate("llm-911", &proof, claim(&proof, true))
            .unwrap()[0]
            .created
    );
    assert!(undo_created(
        &fixture.registry,
        &fixture.root,
        &fixture.origin,
        "llm-911",
        &[proof.path]
    )
    .is_err());
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("daily/2026-08-10.md")).unwrap(),
        "requested update"
    );
}

#[test]
fn publication_native_rejects_forged_other_operation_path_revision_and_token() {
    let fixture = Fixture::new();
    let proof = fixture.publish("llm-912", "output", None).unwrap();
    assert!(fixture
        .validate("llm-999", &proof, claim(&proof, true))
        .is_err());
    for path in [
        "raw/source.md",
        "../outside.md",
        "daily/2026-08-11.md",
        " daily/2026-08-10.md ",
    ] {
        let mut forged = claim(&proof, true);
        forged.path = path.into();
        assert!(fixture.validate("llm-912", &proof, forged).is_err());
    }
    let mut forged = claim(&proof, true);
    forged.revision = "0".repeat(64);
    assert!(fixture.validate("llm-912", &proof, forged).is_err());
    let mut unknown = proof.clone();
    unknown.publication_id = "0".repeat(64);
    assert!(fixture
        .validate("llm-912", &unknown, claim(&proof, true))
        .is_err());
    assert!(validate(
        &fixture.registry,
        &fixture.root,
        &fixture.origin,
        "llm-912",
        &[],
        &[claim(&proof, true)]
    )
    .is_err());
    assert_eq!(
        std::fs::read_to_string(fixture.root.join(&proof.path)).unwrap(),
        "output"
    );
}

#[test]
fn publication_native_rejects_same_path_reopen_and_closed_origin_before_write() {
    let fixture = Fixture::new();
    let first = fixture.publish("llm-913", "output", None).unwrap();
    let generation = fixture.state.begin_open().unwrap();
    fixture
        .state
        .finish_open(generation, fixture.root.clone(), || ())
        .unwrap();
    assert!(fixture.publish("llm-913", "output", None).is_err());
    assert!(fixture
        .validate("llm-913", &first, claim(&first, true))
        .is_err());
    let current = fixture.state.snapshot().unwrap();
    assert!(validate(
        &fixture.registry,
        &fixture.root,
        &current,
        "llm-913",
        std::slice::from_ref(&first.publication_id),
        &[claim(&first, true)]
    )
    .is_err());
    fixture.state.close().unwrap();
    assert!(publish(
        &fixture.state,
        &fixture.registry,
        &current,
        "llm-914",
        &ManagedArtifact::Map {
            key: "topic".into()
        },
        "output",
        None
    )
    .is_err());
    assert!(!fixture.root.join("wiki/maps/topic.md").exists());
}

#[cfg(unix)]
#[test]
fn publication_native_preserves_same_bytes_in_a_replacement_inode() {
    let fixture = Fixture::new();
    let proof = fixture.publish("llm-915", "same bytes", None).unwrap();
    let replacement = fixture.root.join("replacement.md");
    std::fs::write(&replacement, "same bytes").unwrap();
    std::fs::rename(replacement, fixture.root.join(&proof.path)).unwrap();
    assert!(fixture
        .validate("llm-915", &proof, claim(&proof, true))
        .is_err());
    assert!(undo_created(
        &fixture.registry,
        &fixture.root,
        &fixture.origin,
        "llm-915",
        std::slice::from_ref(&proof.path)
    )
    .is_err());
    assert_eq!(
        std::fs::read_to_string(fixture.root.join(proof.path)).unwrap(),
        "same bytes"
    );
}

#[test]
fn publication_native_consumes_creation_only_after_exact_native_removal() {
    let fixture = Fixture::new();
    let proof = fixture.publish("llm-916", "output", None).unwrap();
    assert_eq!(
        undo_created(
            &fixture.registry,
            &fixture.root,
            &fixture.origin,
            "llm-916",
            std::slice::from_ref(&proof.path)
        )
        .unwrap(),
        1
    );
    assert!(!fixture.root.join(&proof.path).exists());
    assert!(fixture
        .validate("llm-916", &proof, claim(&proof, true))
        .is_err());
    assert!(fixture.publish("llm-916", "output", None).is_err());
    assert!(undo_created(
        &fixture.registry,
        &fixture.root,
        &fixture.origin,
        "llm-916",
        &[proof.path]
    )
    .is_err());
}

#[test]
fn publication_native_registry_restart_does_not_reconstruct_authority_from_bytes() {
    let fixture = Fixture::new();
    let proof = fixture.publish("llm-917", "output", None).unwrap();
    let restarted = DistillPublicationRegistry::default();
    assert!(validate(
        &restarted,
        &fixture.root,
        &fixture.origin,
        "llm-917",
        std::slice::from_ref(&proof.publication_id),
        &[claim(&proof, true)]
    )
    .is_err());
    assert!(undo_created(
        &restarted,
        &fixture.root,
        &fixture.origin,
        "llm-917",
        std::slice::from_ref(&proof.path)
    )
    .is_err());
    assert_eq!(
        std::fs::read_to_string(fixture.root.join(proof.path)).unwrap(),
        "output"
    );
}

#[test]
fn publication_native_registration_failure_preserves_output_without_authority() {
    let fixture = Fixture::new();
    fixture
        .registry
        .fail_after_persist
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let error = fixture
        .publish("llm-918", "persisted output", None)
        .unwrap_err();
    assert!(error.contains("bytes persisted"));
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("daily/2026-08-10.md")).unwrap(),
        "persisted output"
    );
    assert!(fixture
        .publish("llm-918", "persisted output", None)
        .is_err());
    assert!(undo_created(
        &fixture.registry,
        &fixture.root,
        &fixture.origin,
        "llm-918",
        &["daily/2026-08-10.md".into()]
    )
    .is_err());
    assert_eq!(
        fixture
            .registry
            .entries
            .lock()
            .unwrap()
            .values()
            .next()
            .unwrap()
            .phase,
        PublicationPhase::Prepared
    );
}

#[test]
fn publication_native_stale_cas_does_not_issue_authority() {
    let fixture = Fixture::new();
    std::fs::create_dir(fixture.root.join("daily")).unwrap();
    std::fs::write(fixture.root.join("daily/2026-08-10.md"), "changed source").unwrap();
    let stale = format!("{:x}", Sha256::digest(b"old source"));
    assert!(fixture
        .publish("llm-919", "stale output", Some(&stale))
        .is_err());
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("daily/2026-08-10.md")).unwrap(),
        "changed source"
    );
    assert!(fixture
        .registry
        .entries
        .lock()
        .unwrap()
        .values()
        .all(|entry| entry.phase == PublicationPhase::Prepared && entry.written.is_none()));
}

#[cfg(unix)]
#[test]
fn publication_native_symlink_and_unowned_hardlink_preserve_raw_and_outside() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("2026-08-10.md"), "outside sentinel").unwrap();
    symlink(outside.path(), fixture.root.join("daily")).unwrap();
    assert!(fixture.publish("llm-920", "overwrite", None).is_err());
    assert_eq!(
        std::fs::read_to_string(outside.path().join("2026-08-10.md")).unwrap(),
        "outside sentinel"
    );
    std::fs::remove_file(fixture.root.join("daily")).unwrap();
    let proof = fixture.publish("llm-921", "native output", None).unwrap();
    std::fs::create_dir(fixture.root.join("raw")).unwrap();
    std::fs::hard_link(
        fixture.root.join(&proof.path),
        fixture.root.join("raw/twin.md"),
    )
    .unwrap();
    assert!(fixture
        .validate("llm-921", &proof, claim(&proof, true))
        .is_err());
    assert!(undo_created(
        &fixture.registry,
        &fixture.root,
        &fixture.origin,
        "llm-921",
        std::slice::from_ref(&proof.path)
    )
    .is_err());
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("raw/twin.md")).unwrap(),
        "native output"
    );
    assert_eq!(
        std::fs::read_to_string(fixture.root.join(proof.path)).unwrap(),
        "native output"
    );
}

#[test]
fn publication_native_managed_keys_cannot_target_raw_human_or_outside_paths() {
    let fixture = Fixture::new();
    for key in [
        "../raw/source",
        "/outside",
        "topic.md",
        " Raw/source ",
        "",
        "한국어",
    ] {
        assert!(publish(
            &fixture.state,
            &fixture.registry,
            &fixture.origin,
            "llm-922",
            &ManagedArtifact::Map { key: key.into() },
            "output",
            None
        )
        .is_err());
    }
    for artifact in [
        ManagedArtifact::Daily {
            key: "2026-13-10".into(),
        },
        ManagedArtifact::Weekly {
            key: "2026-W54".into(),
        },
        ManagedArtifact::Monthly {
            key: "2026-00".into(),
        },
    ] {
        assert!(publish(
            &fixture.state,
            &fixture.registry,
            &fixture.origin,
            "llm-922",
            &artifact,
            "output",
            None
        )
        .is_err());
    }
    assert!(!fixture.root.join("wiki").exists());
    assert!(!fixture.root.join("raw").exists());
}

#[test]
fn publication_native_parallel_same_operation_retries_share_one_receipt() {
    let fixture = std::sync::Arc::new(Fixture::new());
    let workers = (0..4)
        .map(|_| {
            let fixture = fixture.clone();
            std::thread::spawn(move || fixture.publish("llm-923", "output", None).unwrap())
        })
        .collect::<Vec<_>>();
    let receipts = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect::<Vec<_>>();
    assert!(receipts
        .iter()
        .all(|receipt| receipt.publication_id == receipts[0].publication_id));
    assert_eq!(fixture.registry.entries.lock().unwrap().len(), 1);
}

#[test]
fn publication_native_undo_history_cannot_redirect_to_human_or_another_operation() {
    let fixture = Fixture::new();
    let proof = fixture.publish("llm-924", "native output", None).unwrap();
    std::fs::write(fixture.root.join("daily/human.md"), "human sentinel").unwrap();
    std::fs::create_dir_all(fixture.root.join(".myco/distill-runs")).unwrap();
    for created in ["daily/human.md", "raw/source.md", "../outside.md"] {
        std::fs::write(fixture.root.join(".myco/distill-runs/llm-924.json"), serde_json::json!({
            "id": "llm-924", "created": [created], "created_revisions": {created: proof.revision.clone()}
        }).to_string()).unwrap();
        assert!(
            undo_from_history(&fixture.registry, &fixture.root, &fixture.origin, "llm-924")
                .is_err()
        );
    }
    std::fs::write(
        fixture.root.join(".myco/distill-runs/llm-925.json"),
        serde_json::json!({
            "id": "llm-925", "created": [proof.path]
        })
        .to_string(),
    )
    .unwrap();
    assert!(
        undo_from_history(&fixture.registry, &fixture.root, &fixture.origin, "llm-925").is_err()
    );
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("daily/human.md")).unwrap(),
        "human sentinel"
    );
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("daily/2026-08-10.md")).unwrap(),
        "native output"
    );
}

#[test]
fn publication_native_unknown_move_receipt_preserves_all_history_artifacts() {
    let fixture = Fixture::new();
    let proof = fixture.publish("llm-926", "native output", None).unwrap();
    std::fs::create_dir_all(fixture.root.join(".myco/distill-runs")).unwrap();
    std::fs::write(fixture.root.join("archive.md"), "archive sentinel").unwrap();
    std::fs::write(
        fixture.root.join(".myco/distill-runs/llm-926.json"),
        serde_json::json!({
            "id": "llm-926", "created": [proof.path],
            "moves": [{"from": "human.md", "to": "archive.md"}],
            "move_revisions": {"archive.md": format!("{:x}", Sha256::digest(b"archive sentinel"))}
        })
        .to_string(),
    )
    .unwrap();
    let error = undo_from_history(&fixture.registry, &fixture.root, &fixture.origin, "llm-926")
        .unwrap_err();
    assert!(error.contains("private native move receipts"));
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("archive.md")).unwrap(),
        "archive sentinel"
    );
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("daily/2026-08-10.md")).unwrap(),
        "native output"
    );
    assert!(!fixture.root.join("human.md").exists());
}
