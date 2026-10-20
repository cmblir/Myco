use super::*;
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;

const PREPARED_BYTES: &[u8] = b"GGUFsynthetic-qa-prepared-artifact\n";
const PREPARED_MANIFEST: crate::local_model::ModelManifest = crate::local_model::ModelManifest {
    id: "synthetic-cow-qa-only",
    repository: "synthetic/qa",
    revision: "synthetic-preparation-v1",
    file: "synthetic-cow.gguf",
    url: "",
    bytes: PREPARED_BYTES.len() as u64,
    sha256: "eca107a84a12208a7901d39d347597bf929e2ea547aa448b2889dbdeb432c239",
    license: "test-only",
    adapter: None,
};

#[cfg(target_os = "macos")]
#[test]
fn prepared_artifact_uses_independent_copy_on_write_file() {
    crate::settings::test_support::with_isolated_data("native-ask-cow", |directory| {
        std::fs::create_dir(directory.join("models")).unwrap();
        let source = directory.join("synthetic-prepared.gguf");
        std::fs::write(&source, PREPARED_BYTES).unwrap();
        let before = std::fs::symlink_metadata(&source).unwrap();
        let receipt = seed_artifact(&source, &PREPARED_MANIFEST).unwrap();
        assert_eq!(receipt["preparationMethod"], "apfs_copy_on_write");
        assert_eq!(receipt["nativeArtifactVerification"], true);
        let target = directory.join("models").join(PREPARED_MANIFEST.file);
        let copied = std::fs::symlink_metadata(&target).unwrap();
        assert_eq!(copied.nlink(), 1);
        assert_ne!((before.dev(), before.ino()), (copied.dev(), copied.ino()));
        assert_eq!(std::fs::read(&target).unwrap(), PREPARED_BYTES);
        assert_eq!(
            artifact::identity(&before),
            artifact::identity(&std::fs::metadata(&source).unwrap())
        );
        std::fs::write(&target, b"synthetic changed copy").unwrap();
        assert_eq!(std::fs::read(&source).unwrap(), PREPARED_BYTES);
        std::fs::write(&source, b"synthetic changed original").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"synthetic changed copy");
        assert_eq!(
            std::fs::read_dir(directory.join("models")).unwrap().count(),
            1
        );
    });
}

#[cfg(unix)]
#[test]
fn prepared_artifact_preserves_existing_and_dangling_destination_entries() {
    crate::settings::test_support::with_isolated_data("native-ask-cow-no-clobber", |directory| {
        let models = directory.join("models");
        std::fs::create_dir(&models).unwrap();
        let source = directory.join("synthetic-prepared.gguf");
        std::fs::write(&source, PREPARED_BYTES).unwrap();
        let sentinel = directory.join("synthetic-sentinel");
        std::fs::write(&sentinel, b"preserve destination sentinel").unwrap();
        let target = models.join(PREPARED_MANIFEST.file);
        for destination in [&directory.join("synthetic-absent"), &sentinel] {
            std::os::unix::fs::symlink(destination, &target).unwrap();
            assert!(seed_artifact(&source, &PREPARED_MANIFEST).is_err());
            assert!(std::fs::symlink_metadata(&target)
                .unwrap()
                .file_type()
                .is_symlink());
            assert_eq!(std::fs::read_link(&target).unwrap(), *destination);
            assert_eq!(std::fs::read(&source).unwrap(), PREPARED_BYTES);
            assert_eq!(
                std::fs::read(&sentinel).unwrap(),
                b"preserve destination sentinel"
            );
            std::fs::remove_file(&target).unwrap();
        }
        std::fs::write(&target, b"preserve existing regular target").unwrap();
        assert!(seed_artifact(&source, &PREPARED_MANIFEST).is_err());
        assert_eq!(
            std::fs::read(&target).unwrap(),
            b"preserve existing regular target"
        );
        assert_eq!(std::fs::read_dir(&models).unwrap().count(), 1);
    });
}

#[test]
fn prepared_artifact_rejects_late_corruption_without_publication_or_partial_file() {
    crate::settings::test_support::with_isolated_data("native-ask-cow-corrupt", |directory| {
        let models = directory.join("models");
        std::fs::create_dir(&models).unwrap();
        let source = directory.join("synthetic-corrupt.gguf");
        let mut corrupt = PREPARED_BYTES.to_vec();
        *corrupt.last_mut().unwrap() ^= 1;
        std::fs::write(&source, &corrupt).unwrap();
        assert!(seed_artifact(&source, &PREPARED_MANIFEST)
            .unwrap_err()
            .contains("SHA"));
        assert_eq!(std::fs::read(&source).unwrap(), corrupt);
        assert_eq!(std::fs::read_dir(&models).unwrap().count(), 0);
    });
}

#[cfg(unix)]
#[test]
fn prepared_artifact_rejects_aliases_nonregular_sources_and_size_mismatch() {
    use std::os::unix::ffi::OsStrExt;
    crate::settings::test_support::with_isolated_data("native-ask-cow-inputs", |directory| {
        let models = directory.join("models");
        std::fs::create_dir(&models).unwrap();
        let source = directory.join("synthetic-prepared.gguf");
        std::fs::write(&source, PREPARED_BYTES).unwrap();
        let symbolic = directory.join("synthetic-symbolic");
        std::os::unix::fs::symlink(&source, &symbolic).unwrap();
        let folder = directory.join("synthetic-folder");
        std::fs::create_dir(&folder).unwrap();
        let pipe = directory.join("synthetic-pipe");
        let pipe_name = std::ffi::CString::new(pipe.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(pipe_name.as_ptr(), 0o600) }, 0);
        for input in [&symbolic, &folder, &pipe] {
            assert!(seed_artifact(input, &PREPARED_MANIFEST).is_err());
        }
        let linked = directory.join("synthetic-hardlink");
        std::fs::hard_link(&source, &linked).unwrap();
        assert!(seed_artifact(&source, &PREPARED_MANIFEST).is_err());
        std::fs::remove_file(linked).unwrap();
        let shortened = directory.join("synthetic-shortened");
        std::fs::write(&shortened, &PREPARED_BYTES[..PREPARED_BYTES.len() - 1]).unwrap();
        assert!(seed_artifact(&shortened, &PREPARED_MANIFEST)
            .unwrap_err()
            .contains("size"));
        assert_eq!(std::fs::read(&source).unwrap(), PREPARED_BYTES);
        assert_eq!(std::fs::read_dir(models).unwrap().count(), 0);
    });
}

#[cfg(target_os = "macos")]
#[test]
fn prepared_artifact_clone_uses_held_source_and_never_replaces_a_stage_entry() {
    let owner = tempfile::tempdir().unwrap();
    let source = owner.path().join("synthetic-source");
    std::fs::write(&source, PREPARED_BYTES).unwrap();
    let held = std::fs::File::open(&source).unwrap();
    std::fs::rename(&source, owner.path().join("synthetic-previous")).unwrap();
    std::fs::write(&source, b"synthetic replacement").unwrap();
    let stage = owner.path().join("synthetic-stage");
    let parent = artifact::open_directory(owner.path()).unwrap();
    let cloned = artifact::create_stage(&held, &parent, &stage).unwrap();
    assert_eq!(std::fs::read(&stage).unwrap(), PREPARED_BYTES);
    assert!(artifact::create_stage(&held, &parent, &stage).is_err());
    assert_eq!(std::fs::read(&stage).unwrap(), PREPARED_BYTES);
    assert_eq!(std::fs::read(&source).unwrap(), b"synthetic replacement");
    assert_eq!(cloned.metadata().unwrap().nlink(), 1);
}

#[cfg(unix)]
#[test]
fn prepared_artifact_stage_owner_is_private_and_only_empty_owned_directories_are_removed() {
    let sandbox = tempfile::tempdir().unwrap();
    let parent = artifact::open_directory(sandbox.path()).unwrap();
    let (owner, stage) = artifact::create_owner(sandbox.path(), &parent).unwrap();
    let path = owner.as_path().to_owned();
    assert_eq!(stage.metadata().unwrap().mode() & 0o777, 0o700);
    artifact::verify_directory(&path, &stage, true).unwrap();
    artifact::close_stage(&owner, sandbox.path(), &parent, &stage, None).unwrap();
    assert!(!path.exists());

    let (owner, stage) = artifact::create_owner(sandbox.path(), &parent).unwrap();
    let sentinel = owner.as_path().join("synthetic-unowned-sentinel");
    std::fs::write(&sentinel, b"preserve unowned stage child").unwrap();
    assert!(artifact::close_stage(&owner, sandbox.path(), &parent, &stage, None).is_err());
    assert_eq!(
        std::fs::read(sentinel).unwrap(),
        b"preserve unowned stage child"
    );
}

#[cfg(unix)]
#[test]
fn prepared_artifact_stage_cleanup_preserves_replaced_namespace_and_leaf() {
    let sandbox = tempfile::tempdir().unwrap();
    let parent = artifact::open_directory(sandbox.path()).unwrap();
    let (owner, stage) = artifact::create_owner(sandbox.path(), &parent).unwrap();
    let path = owner.as_path().to_owned();
    let retained = sandbox.path().join("synthetic-retained-stage");
    std::fs::rename(&path, &retained).unwrap();
    std::fs::create_dir(&path).unwrap();
    let sentinel = path.join("synthetic-sentinel");
    std::fs::write(&sentinel, b"preserve replacement directory").unwrap();
    assert!(artifact::close_stage(&owner, sandbox.path(), &parent, &stage, None).is_err());
    assert_eq!(
        std::fs::read(sentinel).unwrap(),
        b"preserve replacement directory"
    );
    assert!(retained.is_dir());

    let (owner, stage) = artifact::create_owner(sandbox.path(), &parent).unwrap();
    let partial = owner.as_path().join("artifact.part");
    std::fs::write(&partial, PREPARED_BYTES).unwrap();
    let held = std::fs::File::open(&partial).unwrap();
    let previous = owner.as_path().join("synthetic-retained-leaf");
    std::fs::rename(&partial, &previous).unwrap();
    std::fs::write(&partial, PREPARED_BYTES).unwrap();
    assert!(artifact::close_stage(&owner, sandbox.path(), &parent, &stage, Some(&held)).is_err());
    assert_eq!(std::fs::read(partial).unwrap(), PREPARED_BYTES);
    assert_eq!(std::fs::read(previous).unwrap(), PREPARED_BYTES);
}

#[cfg(unix)]
#[test]
fn prepared_artifact_stage_cleanup_preserves_replaced_model_parent() {
    let sandbox = tempfile::tempdir().unwrap();
    let directory = sandbox.path().join("synthetic-models");
    std::fs::create_dir(&directory).unwrap();
    let parent = artifact::open_directory(&directory).unwrap();
    let (owner, stage) = artifact::create_owner(&directory, &parent).unwrap();
    let basename = owner.as_path().file_name().unwrap().to_owned();
    let retained = sandbox.path().join("synthetic-retained-models");
    std::fs::rename(&directory, &retained).unwrap();
    std::fs::create_dir(&directory).unwrap();
    let sentinel = directory.join("synthetic-sentinel");
    std::fs::write(&sentinel, b"preserve replacement model parent").unwrap();
    assert!(artifact::close_stage(&owner, &directory, &parent, &stage, None).is_err());
    assert_eq!(
        std::fs::read(sentinel).unwrap(),
        b"preserve replacement model parent"
    );
    assert!(retained.join(basename).is_dir());
}

#[cfg(unix)]
#[test]
fn prepared_artifact_stage_permission_change_prevents_cleanup() {
    use std::os::unix::fs::PermissionsExt;
    let sandbox = tempfile::tempdir().unwrap();
    let parent = artifact::open_directory(sandbox.path()).unwrap();
    let (owner, stage) = artifact::create_owner(sandbox.path(), &parent).unwrap();
    let path = owner.as_path().to_owned();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(artifact::close_stage(&owner, sandbox.path(), &parent, &stage, None).is_err());
    assert!(path.is_dir());
}

#[cfg(unix)]
#[test]
fn prepared_artifact_stage_initial_admission_rejects_same_mode_replacement() {
    use std::os::unix::fs::PermissionsExt;
    let sandbox = tempfile::tempdir().unwrap();
    let parent = artifact::open_directory(sandbox.path()).unwrap();
    let (owner, stage) = artifact::create_owner(sandbox.path(), &parent).unwrap();
    let initial = stage.metadata().unwrap();
    let retained = sandbox.path().join("synthetic-retained-stage");
    std::fs::rename(&owner, &retained).unwrap();
    std::fs::create_dir(&owner).unwrap();
    std::fs::set_permissions(&owner, std::fs::Permissions::from_mode(0o700)).unwrap();
    let sentinel = owner.join("synthetic-sentinel");
    std::fs::write(&sentinel, b"preserve initial replacement").unwrap();
    assert!(
        artifact_io::open_owned_directory(&parent, &owner, (initial.dev(), initial.ino())).is_err()
    );
    assert_eq!(
        std::fs::read(sentinel).unwrap(),
        b"preserve initial replacement"
    );
    assert!(retained.is_dir());
}

#[cfg(unix)]
#[test]
fn prepared_artifact_stage_creation_refuses_replaced_parent_before_mkdir() {
    let sandbox = tempfile::tempdir().unwrap();
    let models = sandbox.path().join("synthetic-models");
    std::fs::create_dir(&models).unwrap();
    let parent = artifact::open_directory(&models).unwrap();
    let retained = sandbox.path().join("synthetic-retained-models");
    std::fs::rename(&models, &retained).unwrap();
    std::fs::create_dir(&models).unwrap();
    let sentinel = models.join("synthetic-sentinel");
    std::fs::write(&sentinel, b"preserve pre-creation parent").unwrap();
    assert!(artifact::create_owner(&models, &parent).is_err());
    assert_eq!(
        std::fs::read(sentinel).unwrap(),
        b"preserve pre-creation parent"
    );
    assert_eq!(std::fs::read_dir(models).unwrap().count(), 1);
    assert_eq!(std::fs::read_dir(retained).unwrap().count(), 0);
}

#[cfg(unix)]
#[test]
fn prepared_artifact_destination_verification_rejects_same_bytes_new_inode_and_links() {
    let sandbox = tempfile::tempdir().unwrap();
    let target = sandbox.path().join("synthetic-published");
    std::fs::write(&target, PREPARED_BYTES).unwrap();
    let held = std::fs::File::open(&target).unwrap();
    let baseline = held.metadata().unwrap();
    artifact::verify_destination(&target, &held, &baseline).unwrap();
    let previous = sandbox.path().join("synthetic-previous");
    std::fs::rename(&target, &previous).unwrap();
    std::fs::write(&target, PREPARED_BYTES).unwrap();
    assert!(artifact::verify_destination(&target, &held, &baseline).is_err());
    assert_eq!(std::fs::read(&target).unwrap(), PREPARED_BYTES);
    std::fs::remove_file(&target).unwrap();
    std::os::unix::fs::symlink(&previous, &target).unwrap();
    assert!(artifact::verify_destination(&target, &held, &baseline).is_err());
    assert!(std::fs::symlink_metadata(target)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(std::fs::read(previous).unwrap(), PREPARED_BYTES);
}

#[cfg(target_os = "macos")]
#[test]
fn prepared_artifact_clone_refuses_replaced_stage_parent() {
    let sandbox = tempfile::tempdir().unwrap();
    let source = sandbox.path().join("synthetic-source");
    std::fs::write(&source, PREPARED_BYTES).unwrap();
    let input = std::fs::File::open(&source).unwrap();
    let parent = artifact::open_directory(sandbox.path()).unwrap();
    let (owner, stage) = artifact::create_owner(sandbox.path(), &parent).unwrap();
    let path = owner.as_path().to_owned();
    let parent = stage;
    std::fs::rename(&path, sandbox.path().join("synthetic-retained-stage")).unwrap();
    std::fs::create_dir(&path).unwrap();
    let sentinel = path.join("synthetic-sentinel");
    std::fs::write(&sentinel, b"preserve clone replacement").unwrap();
    assert!(artifact::create_stage(&input, &parent, &path.join("artifact.part")).is_err());
    assert_eq!(
        std::fs::read(sentinel).unwrap(),
        b"preserve clone replacement"
    );
    assert_eq!(std::fs::read_dir(&path).unwrap().count(), 1);
    assert_eq!(std::fs::read(source).unwrap(), PREPARED_BYTES);
}

#[cfg(target_os = "macos")]
#[test]
fn prepared_artifact_publication_uses_held_parent_without_clobbering_replacement() {
    let sandbox = tempfile::tempdir().unwrap();
    let models = sandbox.path().join("synthetic-models");
    std::fs::create_dir(&models).unwrap();
    let directory = artifact::open_directory(&models).unwrap();
    let (owner, stage) = artifact::create_owner(&models, &directory).unwrap();
    let source = sandbox.path().join("synthetic-source");
    std::fs::write(&source, PREPARED_BYTES).unwrap();
    let input = std::fs::File::open(&source).unwrap();
    let partial = owner.as_path().join("artifact.part");
    let output = artifact::create_stage(&input, &stage, &partial).unwrap();
    let retained = sandbox.path().join("synthetic-retained-models");
    std::fs::rename(&models, &retained).unwrap();
    std::fs::create_dir(&models).unwrap();
    let target = models.join("synthetic-published");
    std::fs::write(&target, b"preserve replacement target").unwrap();
    let published =
        artifact_io::publish_stage(output, &stage, &directory, &partial, &target).unwrap();
    assert_eq!(
        std::fs::read(&target).unwrap(),
        b"preserve replacement target"
    );
    assert_eq!(
        std::fs::read(retained.join("synthetic-published")).unwrap(),
        PREPARED_BYTES
    );
    assert_eq!(published.metadata().unwrap().nlink(), 1);
    assert!(artifact::close_stage(&owner, &models, &directory, &stage, None).is_err());
}

#[test]
fn activity_model_selection_keeps_the_ordinary_control_and_rejects_other_routes() {
    let mut config = Config {
        control_artifact: None,
        watchdog_seconds: 900,
        visible_window: false,
        background_policy: None,
        activity_questions: false,
        activity_model_id: None,
        compact_claims: false,
        source_focus_claims: false,
        named_source_focus_claims: false,
        ordinal_activity: false,
        reviewed_activity_correction: false,
    };
    assert_eq!(
        config.activity_manifest().unwrap().id,
        crate::local_model::MODEL.id
    );
    for manifest in [
        &crate::local_model::MODEL,
        &crate::local_model::GEMMA_CANDIDATE,
        &crate::local_model::QWEN9B_CANDIDATE,
    ] {
        config.activity_model_id = Some(manifest.id.into());
        assert!(config.activity_manifest().is_err());
        config.activity_questions = true;
        assert_eq!(config.activity_manifest().unwrap().id, manifest.id);
        config.activity_questions = false;
    }
    config.activity_questions = true;
    for model in [
        "unknown",
        "",
        crate::local_model::SMALL_MODEL.id,
        "qwen9b",
        "Qwen3.5-9B-Q4_K_M.gguf",
        "qwen3.5-9b-q4_k_m ",
    ] {
        config.activity_model_id = Some(model.into());
        assert!(config.activity_manifest().is_err());
    }
}

#[test]
fn invalid_activity_selection_returns_before_mutating_the_qa_environment() {
    crate::settings::test_support::with_isolated_data("native-ask-model-reject", |_| {
        let before = std::env::var_os("MYCO_DATA_DIR");
        for (activity, model) in [
            (false, crate::local_model::GEMMA_CANDIDATE.id),
            (false, crate::local_model::QWEN9B_CANDIDATE.id),
            (true, crate::local_model::SMALL_MODEL.id),
            (true, "unknown"),
        ] {
            assert_eq!(
                run(Config {
                    control_artifact: None,
                    watchdog_seconds: 900,
                    visible_window: false,
                    background_policy: None,
                    activity_questions: activity,
                    activity_model_id: Some(model.into()),
                    compact_claims: false,
                    source_focus_claims: false,
                    named_source_focus_claims: false,
                    ordinal_activity: false,
                    reviewed_activity_correction: false,
                }),
                1
            );
            assert_eq!(std::env::var_os("MYCO_DATA_DIR"), before);
        }
    });
}

#[test]
fn planner_and_synthesis_request_ids_are_owned_by_the_same_cancel_path() {
    for command in ["local_query_plan", "local_synthesize"] {
        assert_eq!(
            owned_request(command, &json!({"request":{"requestId":"synthetic-owned"}})).unwrap(),
            Some("synthetic-owned".into())
        );
        assert!(owned_request(command, &json!({"request":{"requestId":null}})).is_err());
        assert!(owned_request(command, &json!({})).is_err());
    }
    assert_eq!(owned_request("activity_recall", &json!({})).unwrap(), None);
}

// Synthetic vectors test the persisted QA contract, not embedding inference.
fn publish_pair(root: &Path, model: &str, lexical_note: &str) {
    let chunks = crate::embeddings::chunk_page(NOTE);
    let mut store = crate::vector_index::VectorStore::default();
    store.ensure_signature(model, "synthetic-qa-signature");
    store
        .upsert_page(
            PAGE,
            "synthetic-export-policy",
            chunks
                .iter()
                .map(|chunk| (crate::embeddings::content_hash(chunk), vec![1.0, 0.0]))
                .collect(),
        )
        .unwrap();
    let mut lexical = crate::retrieval::Bm25Index::new();
    lexical.upsert_page(
        PAGE,
        "synthetic-export-policy",
        &crate::embeddings::chunk_page(lexical_note),
    );
    crate::index_publication::PreparedPair::prepare(
        root,
        &crate::index_publication::IndexPair {
            generation: 1,
            store,
            lexical,
        },
    )
    .unwrap()
    .commit()
    .unwrap();
}

#[test]
fn pair_gate_accepts_the_persisted_native_provider_model_identity() {
    crate::settings::test_support::with_isolated_data("native-ask-pair-id", |directory| {
        let root = directory.join("synthetic-vault");
        fixture(&root).unwrap();
        let model = format!("builtin-local:{}", crate::local_llm::BUILTIN_EMBED_MODEL);
        publish_pair(&root, &model, NOTE);
        let receipt = paired(&root).expect("native provider-prefixed E5 pair must be admitted");
        assert_eq!(receipt["model"], model);
        assert_eq!(receipt["generation"], 1);
        retained(&root).unwrap();
    });
}

#[test]
fn pair_gate_keeps_wrong_models_and_divergent_chunk_sets_rejected() {
    crate::settings::test_support::with_isolated_data("native-ask-pair-reject", |directory| {
        for (case, model, lexical) in [
            ("bare-model", crate::local_llm::BUILTIN_EMBED_MODEL, NOTE),
            ("other-model", "builtin-local:synthetic-other-model", NOTE),
            (
                "stale-lexical",
                "builtin-local:e5-small-ko",
                "Synthetic divergent lexical source.\n",
            ),
        ] {
            let root = directory.join(case);
            fixture(&root).unwrap();
            publish_pair(&root, model, lexical);
            assert!(paired(&root).is_err(), "must reject {case}");
            retained(&root).unwrap();
        }
    });
}

#[test]
fn compact_extraction_is_opt_in_and_initial_stage_only() {
    let activity = crate::local_synthesis::claim_prompt::activity_system();
    assert!(prepare_compact_extraction(false, &activity, "invalid user")
        .unwrap()
        .is_none());
    for system in [
        crate::local_synthesis::claim_prompt::extraction_system().to_owned(),
        "Review proposed claims against original sources".into(),
        "Resolve later activity evidence".into(),
        format!("{activity} "),
    ] {
        assert!(prepare_compact_extraction(true, &system, "invalid user")
            .unwrap()
            .is_none());
    }
    assert!(prepare_compact_extraction(true, &activity, "invalid user").is_err());
}

#[test]
fn source_reading_compact_adapter_stays_explicit_and_captures_the_actual_packet() {
    // Synthetic presentation only; these values issue no source or role authority.
    let original = json!({"id":"Q-READING", "speaker":"user", "text":"Synthetic plan, not execution.",
        "turnId":"T-READING", "turnTime":null, "sourcePhase":null, "recordTime":null,
        "sourceId":"S-READING", "sourcePath":"sessions/synthetic.md", "selectionPath":"sessions/synthetic.md",
        "sourceRevision":"a".repeat(64), "start":0, "end":30, "sha256":"b".repeat(64)});
    let private = json!({"question":"Summarize synthetic work", "language":"en",
        "activityPeriod":{"start":"2026-10-01","end":"2026-10-04"},
        "recordPeriodContext":{}, "allowedSpanIds":["Q-READING"],
        "originalSpans":[original], "independentVerificationReceipts":[]})
    .to_string();
    let (system, user) = crate::local_synthesis::claim_prompt::reading_inputs(&private).unwrap();
    assert!(prepare_compact_extraction(false, &system, "invalid user")
        .unwrap()
        .is_none());
    assert!(
        prepare_compact_extraction(true, &(system.clone() + " "), "invalid user")
            .unwrap()
            .is_none()
    );
    assert!(prepare_compact_extraction(true, &system, "invalid user").is_err());
    let prepared = prepare_compact_extraction(true, &system, &user)
        .unwrap()
        .unwrap();
    assert_eq!(prepared.original_user(), user);
    let actual: serde_json::Value = serde_json::from_str(prepared.user()).unwrap();
    let reading: serde_json::Value = serde_json::from_str(&user).unwrap();
    assert_eq!(actual["originalSpans"], reading["originalSpans"]);
    let raw = json!({"version":"WikiClaimsCompactQaV1", "packetSha256":prepared.decoder().packet_sha256(),
        "outcome":"insufficient_evidence", "claims":[]}).to_string();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&prepared.expand(&raw).unwrap()).unwrap(),
        json!({"outcome":"insufficient_evidence", "claims":[]})
    );
}

fn compact_observation_state() -> ProbeState {
    let state = ProbeState {
        compact_claims: true,
        ..ProbeState::default()
    };
    state
        .owned_requests
        .lock()
        .unwrap()
        .insert("qa-owned".into());
    state
        .generations
        .lock()
        .unwrap()
        .push(json!({"requestId":"qa-owned","ordinal":1,
        "user":json!({"packetSha256":"synthetic-packet"}).to_string()}));
    state
}

#[test]
fn compact_expansion_uses_the_issued_owned_generation_and_packet_once() {
    let state = compact_observation_state();
    let result = Ok("synthetic private result".into());
    for (request, digest, ordinal) in [
        ("unowned", "synthetic-packet", Some(1)),
        ("qa-owned", "synthetic-packet", None),
        ("qa-owned", "synthetic-packet", Some(2)),
        ("qa-owned", "different-packet", Some(1)),
    ] {
        assert!(!record_compact_expansion(
            &state, request, digest, ordinal, &result
        ));
        assert!(state.compact_expansions.lock().unwrap().is_empty());
    }
    assert!(record_compact_expansion(
        &state,
        "qa-owned",
        "synthetic-packet",
        Some(1),
        &result
    ));
    assert!(!record_compact_expansion(
        &state,
        "qa-owned",
        "synthetic-packet",
        Some(1),
        &result
    ));
    let records = state.compact_expansions.lock().unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0]["generationOrdinal"], 1);
    assert_eq!(records[0]["semanticAccepted"], false);
}

#[test]
fn compact_expansion_refuses_disabled_full_and_poisoned_observers() {
    let result = Ok("synthetic private result".into());
    let mut disabled = compact_observation_state();
    disabled.compact_claims = false;
    assert!(!record_compact_expansion(
        &disabled,
        "qa-owned",
        "synthetic-packet",
        Some(1),
        &result
    ));
    let state = compact_observation_state();
    state
        .compact_expansions
        .lock()
        .unwrap()
        .extend((2..130).map(|ordinal| json!({"generationOrdinal":ordinal})));
    assert!(!record_compact_expansion(
        &state,
        "qa-owned",
        "synthetic-packet",
        Some(1),
        &result
    ));
    assert_eq!(state.compact_expansions.lock().unwrap().len(), 128);
    let state = compact_observation_state();
    let _ = std::panic::catch_unwind(|| {
        let _guard = state.generations.lock().unwrap();
        panic!("synthetic observation poison");
    });
    assert!(!record_compact_expansion(
        &state,
        "qa-owned",
        "synthetic-packet",
        Some(1),
        &result
    ));
    assert!(state.compact_expansions.lock().unwrap().is_empty());
}

fn source_focus_config() -> Config {
    Config {
        control_artifact: None,
        watchdog_seconds: 900,
        visible_window: false,
        background_policy: None,
        activity_questions: false,
        activity_model_id: None,
        compact_claims: false,
        source_focus_claims: false,
        named_source_focus_claims: false,
        ordinal_activity: false,
        reviewed_activity_correction: false,
    }
}

#[test]
fn source_focus_config_requires_activity_and_excludes_compact_without_changing_the_model() {
    let mut config = source_focus_config();
    assert_eq!(
        config.activity_manifest().unwrap().id,
        crate::local_model::MODEL.id
    );
    config.source_focus_claims = true;
    assert!(config.activity_manifest().is_err());
    config.activity_questions = true;
    assert_eq!(
        config.activity_manifest().unwrap().id,
        crate::local_model::MODEL.id
    );
    config.compact_claims = true;
    assert!(config
        .activity_manifest()
        .unwrap_err()
        .contains("mutually exclusive"));
    config.source_focus_claims = false;
    assert_eq!(
        config.activity_manifest().unwrap().id,
        crate::local_model::MODEL.id
    );
}

#[test]
fn invalid_source_focus_modes_return_before_creating_a_profile_or_mutating_environment() {
    crate::settings::test_support::with_isolated_data("native-ask-focus-reject", |_| {
        let before = std::env::var_os("MYCO_DATA_DIR");
        for (activity, compact) in [(false, false), (false, true), (true, true)] {
            let mut config = source_focus_config();
            config.activity_questions = activity;
            config.compact_claims = compact;
            config.source_focus_claims = true;
            assert_eq!(run(config), 1);
            assert_eq!(std::env::var_os("MYCO_DATA_DIR"), before);
        }
    });
}

#[test]
fn reviewed_correction_selection_is_off_by_default_and_requires_the_exact_qa_route() {
    let mut config = source_focus_config();
    assert!(!config.reviewed_activity_correction);
    config.reviewed_activity_correction = true;
    assert!(config.activity_manifest().is_err());
    config.activity_questions = true;
    assert!(config.activity_manifest().is_err());
    config.source_focus_claims = true;
    assert_eq!(
        config.activity_manifest().unwrap().id,
        crate::local_model::MODEL.id
    );
    config.compact_claims = true;
    assert!(config.activity_manifest().is_err());
    for (activity, focus, compact, correction) in [
        (false, false, false, false),
        (true, true, false, false),
        (false, true, false, true),
        (true, false, false, true),
        (true, true, true, true),
        (true, true, false, true),
    ] {
        let state = ProbeState {
            activity_questions: activity,
            source_focus_claims: focus,
            named_source_focus_claims: false,
            ordinal_activity: false,
            compact_claims: compact,
            reviewed_activity_correction: correction,
            ..ProbeState::default()
        };
        assert_eq!(
            reviewed_activity_correction_mode(&state),
            activity && focus && !compact && correction
        );
    }
}

#[test]
fn invalid_reviewed_correction_returns_before_environment_or_host_preparation() {
    crate::settings::test_support::with_isolated_data("native-ask-correction-reject", |_| {
        let before = std::env::var_os("MYCO_DATA_DIR");
        for (activity, focus, compact) in [
            (false, false, false),
            (true, false, false),
            (true, true, true),
        ] {
            let mut config = source_focus_config();
            config.reviewed_activity_correction = true;
            config.activity_questions = activity;
            config.source_focus_claims = focus;
            config.compact_claims = compact;
            assert_eq!(run(config), 1);
            assert_eq!(std::env::var_os("MYCO_DATA_DIR"), before);
        }
    });
}

fn backing_fixture() -> crate::wiki_claims::SourceSet {
    use crate::wiki_claims::{ActorRole, SourceDocument, SourceSet, SpanInput};
    let first = "Synthetic backing body sentinel A.\n";
    let second = "Synthetic backing body sentinel B.";
    let body = format!("{first}{second}");
    let document = SourceDocument::bind(
        "synthetic-source".into(),
        "sessions/backing.md".into(),
        "sessions/backing.md".into(),
        &body,
        None,
        vec![
            SpanInput {
                id: "Q-Z".into(),
                start: 0,
                end: first.len(),
                turn_id: "T0".into(),
                speaker: ActorRole::User,
                turn_time: None,
            },
            SpanInput {
                id: "Q-A".into(),
                start: first.len(),
                end: body.len(),
                turn_id: "T1".into(),
                speaker: ActorRole::Assistant,
                turn_time: None,
            },
        ],
    )
    .unwrap();
    SourceSet::new(
        crate::vault_session::AgentVaultSession {
            vault_path: "/synthetic/backing-observation".into(),
            opening_token: "synthetic-opening".into(),
        },
        crate::retrieval::Scope::All,
        vec![document],
        vec![],
    )
    .unwrap()
}

fn backing_state() -> ProbeState {
    let state = ProbeState {
        activity_questions: true,
        ..ProbeState::default()
    };
    state
        .owned_requests
        .lock()
        .unwrap()
        .insert("qa-owned".into());
    state
}

#[test]
fn baseline_activity_backing_observation_preserves_order_without_bodies_or_processing_claims() {
    let state = backing_state();
    let sources = backing_fixture();
    assert!(!state.compact_claims && !state.source_focus_claims);
    assert!(record_activity_backing(&state, "qa-owned", &sources));
    let records = state.backing_observations.lock().unwrap();
    assert_eq!(records.len(), 1);
    let record = &records[0];
    assert_eq!(record["stage"], "initial_backing_before_windowing");
    assert_eq!(record["originalSpanCount"], 2);
    assert_eq!(record["spanIds"], json!(["Q-Z", "Q-A"]));
    assert_eq!(
        record["sourceRevisions"],
        json!(sources
            .spans()
            .map(|span| span.source_revision())
            .collect::<Vec<_>>())
    );
    assert_eq!(record["originalBodiesIncluded"], false);
    assert!(record["modelProvidedSpanCount"].is_null());
    assert!(record["processedSpanCount"].is_null());
    assert_eq!(record["nativeIoAuthenticated"], false);
    assert_eq!(record["semanticAccepted"], false);
    assert_eq!(record["productionAccepted"], false);
    assert!(!record.to_string().contains("backing body sentinel"));
    assert!(record.get("originalSpans").is_none());
    assert_eq!(state.observation_errors.load(Ordering::Relaxed), 0);
}

#[test]
fn backing_observation_requires_exact_owned_request_and_is_no_op_when_unselected() {
    let sources = backing_fixture();
    let disabled = ProbeState::default();
    assert!(!record_activity_backing(&disabled, "qa-owned", &sources));
    assert!(disabled.backing_observations.lock().unwrap().is_empty());
    assert_eq!(disabled.observation_errors.load(Ordering::Relaxed), 0);
    let missing = ProbeState {
        activity_questions: true,
        ..ProbeState::default()
    };
    assert!(!record_activity_backing(&missing, "qa-owned", &sources));
    assert_eq!(missing.observation_errors.load(Ordering::Relaxed), 1);
    let state = backing_state();
    for request in ["", "unowned", "qa-owned-extra", "QA-owned"] {
        assert!(!record_activity_backing(&state, request, &sources));
    }
    assert!(state.backing_observations.lock().unwrap().is_empty());
    assert_eq!(state.observation_errors.load(Ordering::Relaxed), 4);
    assert!(record_activity_backing(&state, "qa-owned", &sources));
    assert!(!record_activity_backing(&state, "qa-owned", &sources));
    assert_eq!(state.backing_observations.lock().unwrap().len(), 1);
    assert_eq!(state.observation_errors.load(Ordering::Relaxed), 5);
}

#[test]
fn full_and_poisoned_backing_observers_fail_visible_without_fabricating_a_snapshot() {
    let sources = backing_fixture();
    let full = backing_state();
    full.backing_observations
        .lock()
        .unwrap()
        .extend((0..128).map(|index| json!({"requestId":format!("other-{index}")})));
    assert!(!record_activity_backing(&full, "qa-owned", &sources));
    assert_eq!(full.backing_observations.lock().unwrap().len(), 128);
    assert_eq!(full.observation_errors.load(Ordering::Relaxed), 1);
    let poisoned = backing_state();
    assert!(std::panic::catch_unwind(|| {
        let _guard = poisoned.owned_requests.lock().unwrap();
        panic!("synthetic backing ownership poison");
    })
    .is_err());
    assert!(!record_activity_backing(&poisoned, "qa-owned", &sources));
    assert!(poisoned.backing_observations.lock().unwrap().is_empty());
    assert_eq!(poisoned.observation_errors.load(Ordering::Relaxed), 1);
}

#[test]
fn activity_qwen9b_preserves_bounded_correction_with_exact_model_pin() {
    let config = Config {
        control_artifact: None,
        watchdog_seconds: 900,
        visible_window: false,
        background_policy: None,
        activity_questions: true,
        activity_model_id: Some("qwen3.5-9b-q4_k_m".into()),
        compact_claims: false,
        source_focus_claims: true,
        named_source_focus_claims: false,
        ordinal_activity: false,
        reviewed_activity_correction: true,
    };
    let manifest = config
        .activity_manifest()
        .expect("explicit native QA must admit the pinned larger local candidate");
    assert_eq!(manifest.id, "qwen3.5-9b-q4_k_m");
    assert_eq!(
        manifest.revision,
        "1379f25c6b505a3fc737bd7818cb09389cf807c1"
    );
    assert_eq!(manifest.bytes, 5_627_044_256);
    assert_eq!(
        manifest.sha256,
        "cd76ec205963b3b33350093e6904d9de16c4e666fd104e1f632d25c7f15f2a13"
    );
    assert!(config.source_focus_claims && config.reviewed_activity_correction);
    assert!(!config.compact_claims && !config.visible_window);
    assert!(config.background_policy.is_none() && config.control_artifact.is_none());
}

#[path = "native_ask_probe/named_focus_tests.rs"]
mod named_focus_tests;
