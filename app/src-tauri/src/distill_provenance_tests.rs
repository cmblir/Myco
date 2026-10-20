use super::*;
use std::collections::{BTreeMap, BTreeSet};

fn provenance_space(signature: &str) -> serde_json::Value {
    serde_json::json!({
        "model": "test-model",
        "signature": signature,
        "dim": 2,
    })
}

fn provenance_ontology(signature: &str) -> Ontology {
    let mut value = serde_json::to_value(tiny_ontology()).unwrap();
    value["embedding"] = provenance_space(signature);
    value["source_signature"] = "synthetic-source-revision".into();
    serde_json::from_value(value).unwrap()
}

fn provenance_active_store(root: &Path) {
    let space: EmbeddingSpace = serde_json::from_value(provenance_space("space-active")).unwrap();
    let store = synthetic_current_store(root, &space, &[("wiki/topic.md".into(), vec![1.0, 0.0])]);
    let path =
        crate::vector_index::VectorStore::path_for(&root.canonicalize().unwrap().to_string_lossy())
            .unwrap();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    store.save(&path).unwrap();
    let titles = crate::commands::wiki_titles(root);
    let anchors = map_anchors_from_store(root, &store).unwrap();
    let ontology = crate::ontology::build(&store, &titles, &anchors).unwrap();
    crate::ontology::save(root, &ontology).unwrap();
}

fn provenance_sidecar(root: &Path, stem: &str, vector: serde_json::Value) -> String {
    let directory = root.join("_inbox/quarantine");
    std::fs::create_dir_all(&directory).unwrap();
    let content = format!("{PROSE} {stem}");
    std::fs::write(directory.join(format!("{stem}.md")), &content).unwrap();
    let ontology =
        match crate::index_publication::read_checked(&dir(root).join("ontology.json")).unwrap() {
            Some(raw) => serde_json::from_slice(&raw).unwrap(),
            None => provenance_ontology("space-active"),
        };
    let decision = admission::capture(root, &ontology, &config_load(root)).unwrap();
    let value = serde_json::json!({
        "tier": "quarantine",
        "s_knn": 0.2,
        "nearest_cluster": "topic",
        "reason": "synthetic semantic quarantine",
        "expires": now_secs() + 1_000_000,
        "vector": vector,
        "from": format!("_inbox/{stem}.md"),
        "embedding": provenance_space("space-active"),
        "source_sha256": admission::sha256(content.as_bytes()),
        "decision_signature": decision.signature,
    });
    std::fs::write(
        directory.join(format!("{stem}.verdict.json")),
        serde_json::to_vec_pretty(&value).unwrap(),
    )
    .unwrap();
    format!("_inbox/quarantine/{stem}.md")
}

fn provenance_edit_sidecar(root: &Path, rel: &str, edit: impl FnOnce(&mut serde_json::Value)) {
    let path = sidecar_path(&root.join(rel));
    let mut value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    edit(&mut value);
    std::fs::write(path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
}

#[derive(Debug, PartialEq)]
struct ProvenanceSnapshot {
    directories: BTreeSet<String>,
    files: BTreeMap<String, (Vec<u8>, std::time::SystemTime)>,
}

fn provenance_snapshot(root: &Path) -> ProvenanceSnapshot {
    fn walk(root: &Path, directory: &Path, snapshot: &mut ProvenanceSnapshot) {
        for entry in std::fs::read_dir(directory).unwrap() {
            let path = entry.unwrap().path();
            let relative = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .into_owned();
            let metadata = std::fs::metadata(&path).unwrap();
            if metadata.is_dir() {
                snapshot.directories.insert(relative);
                walk(root, &path, snapshot);
            } else {
                snapshot.files.insert(
                    relative,
                    (std::fs::read(&path).unwrap(), metadata.modified().unwrap()),
                );
            }
        }
    }
    let mut snapshot = ProvenanceSnapshot {
        directories: BTreeSet::new(),
        files: BTreeMap::new(),
    };
    walk(root, root, &mut snapshot);
    snapshot
}

fn provenance_assert_invalid_sidecar(vector: serde_json::Value) {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let rel = provenance_sidecar(root, "invalid", vector);
    let before = provenance_snapshot(root);
    assert!(
        read_sidecar(root, &rel).is_err(),
        "malformed semantic vector was accepted or repaired"
    );
    assert_eq!(provenance_snapshot(root), before);
}

#[test]
fn provenance_sidecar_cannot_shorten_a_vector_around_a_string_member() {
    provenance_assert_invalid_sidecar(serde_json::json!([1.0, "bad", 0.0]));
}

#[test]
fn provenance_sidecar_cannot_shorten_a_vector_around_a_null_member() {
    provenance_assert_invalid_sidecar(serde_json::json!([1.0, null, 0.0]));
}

#[test]
fn provenance_sidecar_rejects_finite_json_that_overflows_f32() {
    provenance_assert_invalid_sidecar(serde_json::json!([1e300, 0.0]));
}

#[test]
fn provenance_sidecar_rejects_zero_vector() {
    provenance_assert_invalid_sidecar(serde_json::json!([0.0, 0.0]));
}

#[test]
fn provenance_sidecar_rejects_width_different_from_its_stamp() {
    provenance_assert_invalid_sidecar(serde_json::json!([1.0]));
}

#[test]
fn provenance_sidecar_rejects_partial_embedding_identity() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let rel = provenance_sidecar(root, "partial", serde_json::json!([1.0, 0.0]));
    provenance_edit_sidecar(root, &rel, |value| {
        value["embedding"]
            .as_object_mut()
            .unwrap()
            .remove("signature");
    });
    assert!(
        read_sidecar(root, &rel).is_err(),
        "partial identity was accepted"
    );
}

#[test]
fn provenance_sidecar_rejects_score_overflow_instead_of_inventing_a_mean() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let rel = provenance_sidecar(root, "score", serde_json::json!([1.0, 0.0]));
    provenance_edit_sidecar(root, &rel, |value| {
        value["s_knn"] = serde_json::json!(1e300)
    });
    assert!(
        read_sidecar(root, &rel).is_err(),
        "nonfinite narrowed score was accepted"
    );
}

#[test]
fn provenance_same_width_stale_space_is_excluded_without_touching_files() {
    crate::settings::test_support::with_isolated_data("distill-sidecar-stale-space", |_data| {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        provenance_active_store(root);
        for index in 0..5 {
            provenance_sidecar(
                root,
                &format!("active{index}"),
                serde_json::json!([1.0, 0.0]),
            );
            let rel = provenance_sidecar(
                root,
                &format!("stale{index}"),
                serde_json::json!([1.0, 0.0]),
            );
            provenance_edit_sidecar(root, &rel, |value| {
                value["embedding"] = provenance_space("space-old")
            });
        }
        let before = provenance_snapshot(root);
        let groups = emerging_clusters(root, 5, 0.9).unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(
            groups[0].len(),
            5,
            "same-width representation mismatch was compared"
        );
        assert!(groups[0].iter().all(|rel| rel.contains("/active")));
        assert_eq!(provenance_snapshot(root), before);
    });
}

#[test]
fn provenance_legacy_and_machine_empty_vectors_never_form_semantic_groups() {
    crate::settings::test_support::with_isolated_data("distill-sidecar-legacy-machine", |_data| {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        provenance_active_store(root);
        let legacy = provenance_sidecar(root, "legacy", serde_json::json!([1.0, 0.0]));
        provenance_edit_sidecar(root, &legacy, |value| {
            value.as_object_mut().unwrap().remove("embedding");
            value.as_object_mut().unwrap().remove("source_sha256");
            value.as_object_mut().unwrap().remove("decision_signature");
        });
        let machine = provenance_sidecar(root, "machine", serde_json::json!([]));
        provenance_edit_sidecar(root, &machine, |value| {
            value["reason"] = "machine:agent".into();
            value["from"] = "sessions/synthetic.md".into();
            value.as_object_mut().unwrap().remove("embedding");
            value.as_object_mut().unwrap().remove("source_sha256");
            value.as_object_mut().unwrap().remove("decision_signature");
        });
        let before = provenance_snapshot(root);
        assert!(
            emerging_clusters(root, 1, 0.0).unwrap().is_empty(),
            "nonsemantic vectors became a topic"
        );
        assert_eq!(
            quarantine_entries(root).len(),
            2,
            "semantic exclusion must preserve human review"
        );
        assert_eq!(provenance_snapshot(root), before);
    });
}

#[test]
fn provenance_late_invalid_sidecar_cannot_leave_a_partial_proposal_or_manifest() {
    crate::settings::test_support::with_isolated_data("distill-sidecar-late-error", |_data| {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        provenance_active_store(root);
        for index in 0..5 {
            provenance_sidecar(
                root,
                &format!("a-valid{index}"),
                serde_json::json!([1.0, 0.0]),
            );
        }
        provenance_sidecar(root, "z-invalid", serde_json::json!([1.0, "bad", 0.0]));
        let mut manifest = test_manifest();
        save_manifest(root, &manifest).unwrap();
        let before = provenance_snapshot(root);
        let manifest_before = serde_json::to_vec(&manifest).unwrap();
        assert!(
            propose_emerging_clusters(root, &mut manifest).is_err(),
            "invalid late input did not abort proposal preparation"
        );
        assert_eq!(serde_json::to_vec(&manifest).unwrap(), manifest_before);
        assert_eq!(provenance_snapshot(root), before);
    });
}

#[test]
fn provenance_valid_nonunit_sidecars_keep_deterministic_geometry() {
    crate::settings::test_support::with_isolated_data("distill-sidecar-positive", |_data| {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        provenance_active_store(root);
        for index in 0..5 {
            provenance_sidecar(root, &format!("same{index}"), serde_json::json!([2.0, 0.0]));
        }
        provenance_sidecar(root, "different", serde_json::json!([0.0, 3.0]));
        let before = provenance_snapshot(root);
        let groups = emerging_clusters(root, 5, 0.9).unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].len(), 5);
        assert!(groups[0].windows(2).all(|pair| pair[0] < pair[1]));
        assert_eq!(provenance_snapshot(root), before);
    });
}

#[test]
fn provenance_model_mismatch_preserves_lifecycle_ledger_and_stale_scores() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let original = DistillState {
        model: "model-old".into(),
        embedding: None,
        decision_signature: None,
        scored: HashMap::from([(
            "_inbox/held.md".into(),
            ScoredEntry {
                hash: 7,
                tier: "reject".into(),
                at: 8,
                mtime: 9,
                len: 10,
                rules: GATE_RULES,
                turn: Some(11),
                embedding: None,
                nonsemantic: None,
                source_sha256: None,
                decision_signature: None,
            },
        )]),
        rejected_ttl: HashMap::from([("_inbox/held.md".into(), 2_000_000_000)]),
        last_run: Some(12),
        last_backlogs: vec![13, 14],
        agent_turns: vec![15],
    };
    state_save(root, &original).unwrap();
    let before = provenance_snapshot(root);
    let loaded = state_load(root, "model-current");
    assert_eq!(
        serde_json::to_value(&loaded.scored).unwrap(),
        serde_json::to_value(&original.scored).unwrap()
    );
    assert_eq!(loaded.rejected_ttl, original.rejected_ttl);
    assert_eq!(loaded.last_run, original.last_run);
    assert_eq!(loaded.last_backlogs, original.last_backlogs);
    assert_eq!(loaded.agent_turns, original.agent_turns);
    assert_eq!(provenance_snapshot(root), before);
}

#[test]
fn provenance_corrupt_state_cannot_be_overwritten_by_a_successful_scan() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    std::fs::create_dir_all(dir(root)).unwrap();
    std::fs::write(state_path(root), b"{\"scored\":").unwrap();
    let mut manifest = test_manifest();
    save_manifest(root, &manifest).unwrap();
    let before = provenance_snapshot(root);
    let manifest_before = serde_json::to_vec(&manifest).unwrap();
    assert!(scan(
        root,
        &provenance_ontology("space-active"),
        &DistillConfig::default(),
        10,
        &dummy_embed,
        &[],
        &mut manifest
    )
    .is_err());
    assert_eq!(serde_json::to_vec(&manifest).unwrap(), manifest_before);
    assert_eq!(provenance_snapshot(root), before);
}

fn provenance_assert_stale_fingerprint_reembedded(touch: bool) {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    std::fs::create_dir_all(root.join("_inbox")).unwrap();
    let path = root.join("_inbox/held.md");
    std::fs::write(&path, PROSE).unwrap();
    set_mtime(&path, old_mtime());
    let state = serde_json::json!({
        "model": "test-model",
        "scored": {"_inbox/held.md": {
            "hash": crate::embeddings::content_hash(PROSE), "tier": "reject", "at": 1,
            "mtime": mtime_secs(&path).unwrap(), "len": PROSE.len(), "rules": GATE_RULES,
            "embedding": provenance_space("space-old"),
        }},
        "rejected_ttl": {"_inbox/held.md": 2_000_000_000_i64},
        "last_run": 123, "last_backlogs": [5, 4], "agent_turns": [42],
    });
    std::fs::create_dir_all(dir(root)).unwrap();
    std::fs::write(state_path(root), serde_json::to_vec_pretty(&state).unwrap()).unwrap();
    if touch {
        set_mtime(&path, old_mtime() - std::time::Duration::from_secs(3600));
    }
    let calls = std::cell::Cell::new(0);
    let embed = |texts: Vec<String>| {
        calls.set(calls.get() + 1);
        Ok(texts.iter().map(|_| vec![1.0, 0.0]).collect())
    };
    let mut manifest = test_manifest();
    let outcome = scan(
        root,
        &provenance_ontology("space-active"),
        &DistillConfig::default(),
        10,
        &embed,
        &[],
        &mut manifest,
    )
    .unwrap();
    assert_eq!(calls.get(), 1, "a stale semantic score bypassed embedding");
    assert_eq!(outcome.scored, 1);
    let after: serde_json::Value =
        serde_json::from_slice(&std::fs::read(state_path(root)).unwrap()).unwrap();
    assert_eq!(
        after["scored"]["_inbox/held.md"]["embedding"],
        provenance_space("space-active")
    );
    assert_eq!(after["rejected_ttl"]["_inbox/held.md"], 2_000_000_000_i64);
    assert_eq!(after["last_run"], 123);
    assert_eq!(after["last_backlogs"], serde_json::json!([5, 4]));
    assert_eq!(after["agent_turns"], serde_json::json!([42]));
    assert!(path.exists());
}

#[test]
fn provenance_unchanged_stamp_cannot_reuse_a_different_semantic_space() {
    provenance_assert_stale_fingerprint_reembedded(false);
}

#[test]
fn provenance_unchanged_hash_cannot_reuse_a_different_semantic_space() {
    provenance_assert_stale_fingerprint_reembedded(true);
}

#[test]
fn provenance_rule_only_scores_and_lifecycle_survive_a_space_change() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    std::fs::create_dir_all(root.join("_inbox")).unwrap();
    let path = root.join("_inbox/junk.md");
    std::fs::write(&path, "synthetic stub").unwrap();
    set_mtime(&path, old_mtime());
    let state = serde_json::json!({
        "model": "test-model", "embedding": provenance_space("space-old"),
        "scored": {"_inbox/junk.md": {
            "hash": crate::embeddings::content_hash("synthetic stub"), "tier": "reject", "at": 1,
            "mtime": mtime_secs(&path).unwrap(), "len": "synthetic stub".len(), "rules": GATE_RULES,
            "nonsemantic": "junk",
            "source_sha256": admission::sha256(b"synthetic stub"),
        }},
        "rejected_ttl": {"_inbox/junk.md": 2_000_000_000_i64},
        "last_run": 123, "last_backlogs": [5, 4], "agent_turns": [42],
    });
    std::fs::create_dir_all(dir(root)).unwrap();
    std::fs::write(state_path(root), serde_json::to_vec_pretty(&state).unwrap()).unwrap();
    std::fs::write(dir(root).join("distill-kept.json"), b"[\"_inbox/junk.md\"]").unwrap();
    let kept = std::fs::read(dir(root).join("distill-kept.json")).unwrap();
    let embed = |_: Vec<String>| -> Result<Vec<Vec<f32>>, String> {
        panic!("rule-only score must not be embedded")
    };
    let mut manifest = test_manifest();
    let outcome = scan(
        root,
        &provenance_ontology("space-active"),
        &DistillConfig::default(),
        10,
        &embed,
        &[],
        &mut manifest,
    )
    .unwrap();
    assert_eq!(outcome.scored, 0);
    let after: serde_json::Value =
        serde_json::from_slice(&std::fs::read(state_path(root)).unwrap()).unwrap();
    assert_eq!(after["scored"], state["scored"]);
    assert_eq!(after["rejected_ttl"], state["rejected_ttl"]);
    assert_eq!(after["agent_turns"], state["agent_turns"]);
    assert_eq!(after["last_backlogs"], state["last_backlogs"]);
    assert_eq!(after["last_run"], state["last_run"]);
    assert_eq!(
        std::fs::read(dir(root).join("distill-kept.json")).unwrap(),
        kept
    );
    assert!(path.exists());
}

#[test]
fn provenance_updating_context_cannot_stamp_unprocessed_budget_entries() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    std::fs::create_dir_all(root.join("_inbox")).unwrap();
    let mut scores = serde_json::Map::new();
    for index in 0..2 {
        let rel = format!("_inbox/held{index}.md");
        let path = root.join(&rel);
        std::fs::write(&path, PROSE).unwrap();
        set_mtime(&path, old_mtime());
        scores.insert(
            rel,
            serde_json::json!({
                "hash": crate::embeddings::content_hash(PROSE), "tier": "reject", "at": 1,
                "mtime": mtime_secs(&path).unwrap(), "len": PROSE.len(), "rules": GATE_RULES,
                "embedding": provenance_space("space-old"),
            }),
        );
    }
    let state = serde_json::json!({"model": "test-model", "embedding": provenance_space("space-old"), "scored": scores, "agent_turns": [42], "last_backlogs": [5, 4]});
    std::fs::create_dir_all(dir(root)).unwrap();
    std::fs::write(state_path(root), serde_json::to_vec_pretty(&state).unwrap()).unwrap();
    let mut manifest = test_manifest();
    let result = scan(
        root,
        &provenance_ontology("space-active"),
        &DistillConfig::default(),
        1,
        &dummy_embed,
        &[],
        &mut manifest,
    )
    .unwrap();
    assert_eq!(result.scored, 1);
    let after: serde_json::Value =
        serde_json::from_slice(&std::fs::read(state_path(root)).unwrap()).unwrap();
    assert_eq!(after["embedding"], provenance_space("space-active"));
    assert_eq!(
        after["scored"]["_inbox/held0.md"]["embedding"],
        provenance_space("space-active")
    );
    assert_eq!(
        after["scored"]["_inbox/held1.md"],
        state["scored"]["_inbox/held1.md"]
    );
    assert_eq!(after["agent_turns"], state["agent_turns"]);
    assert_eq!(after["last_backlogs"], state["last_backlogs"]);
}

#[test]
fn provenance_nonsemantic_tag_cannot_authorize_a_full_tier_score() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    std::fs::create_dir_all(dir(root)).unwrap();
    let state = serde_json::json!({"model":"test-model", "scored":{"_inbox/fake.md":{"hash":7,"tier":"full","at":1,"rules":GATE_RULES,"nonsemantic":"junk"}}});
    std::fs::write(state_path(root), serde_json::to_vec(&state).unwrap()).unwrap();
    let before = provenance_snapshot(root);
    assert!(state_load_checked(root, "test-model").is_err());
    assert_eq!(provenance_snapshot(root), before);
}

#[test]
fn provenance_checked_run_refuses_a_different_store_before_partitioning() {
    crate::settings::test_support::with_isolated_data("distill-checked-run-space", |_data| {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        provenance_active_store(root);
        std::fs::create_dir_all(root.join("sessions")).unwrap();
        std::fs::write(root.join("sessions/loose.md"), PROSE).unwrap();
        let expected: EmbeddingSpace =
            serde_json::from_value(provenance_space("space-stale")).unwrap();
        let before = provenance_snapshot(root);
        let embed = |_: Vec<String>| -> Result<EmbeddedBatch, String> {
            panic!("stale pinned space must abort before producer work")
        };
        assert!(run_checked(root, &DistillConfig::default(), &expected, &embed).is_err());
        assert_eq!(provenance_snapshot(root), before);
    });
}

#[test]
fn provenance_checked_run_rejects_a_late_batch_space_before_admission_moves() {
    crate::settings::test_support::with_isolated_data("distill-checked-run-late-batch", |_data| {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        seed_wiki_pages(root, GATE_MIN_WIKI_PAGES);
        provenance_active_store(root);
        std::fs::create_dir_all(root.join("_inbox")).unwrap();
        for index in 0..33 {
            let path = root.join(format!("_inbox/held{index:02}.md"));
            std::fs::write(&path, PROSE).unwrap();
            set_mtime(&path, old_mtime());
        }
        let before: Vec<Vec<u8>> = (0..33)
            .map(|index| std::fs::read(root.join(format!("_inbox/held{index:02}.md"))).unwrap())
            .collect();
        let expected: EmbeddingSpace =
            serde_json::from_value(provenance_space("space-active")).unwrap();
        let calls = std::cell::Cell::new(0);
        let embed = |texts: Vec<String>| {
            calls.set(calls.get() + 1);
            let space = if calls.get() == 1 {
                expected.clone()
            } else {
                serde_json::from_value(provenance_space("space-changed")).unwrap()
            };
            Ok(EmbeddedBatch {
                space,
                vectors: texts.iter().map(|_| vec![1.0, 0.0]).collect(),
            })
        };
        assert!(run_checked(root, &DistillConfig::default(), &expected, &embed).is_err());
        assert_eq!(calls.get(), 2);
        for (index, bytes) in before.iter().enumerate() {
            assert_eq!(
                std::fs::read(root.join(format!("_inbox/held{index:02}.md"))).unwrap(),
                *bytes
            );
        }
        assert!(!root.join("_inbox/quarantine").exists());
        assert!(!state_path(root).exists());
    });
}

#[test]
fn provenance_checked_profile_failure_cannot_continue_to_ttl_or_admission() {
    crate::settings::test_support::with_isolated_data("distill-checked-profile-failure", |_data| {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        provenance_active_store(root);
        std::fs::write(root.join("profile.md"), "## Interests\n- synthetic topic\n").unwrap();
        let rel = provenance_sidecar(root, "expired", serde_json::json!([1.0, 0.0]));
        provenance_edit_sidecar(root, &rel, |value| {
            value["expires"] = serde_json::json!(now_secs() - 1)
        });
        let content_before = std::fs::read(root.join(&rel)).unwrap();
        let sidecar_before = std::fs::read(sidecar_path(&root.join(&rel))).unwrap();
        let expected: EmbeddingSpace =
            serde_json::from_value(provenance_space("space-active")).unwrap();
        let embed = |_: Vec<String>| -> Result<EmbeddedBatch, String> {
            Err("synthetic provider failure".into())
        };
        assert!(run_checked(root, &DistillConfig::default(), &expected, &embed).is_err());
        assert_eq!(std::fs::read(root.join(&rel)).unwrap(), content_before);
        assert_eq!(
            std::fs::read(sidecar_path(&root.join(&rel))).unwrap(),
            sidecar_before
        );
        assert!(!root.join(".myco/trash").exists());
    });
}

#[test]
fn provenance_semantic_listing_propagates_a_corrupt_state() {
    crate::settings::test_support::with_isolated_data(
        "distill-semantic-list-corrupt-state",
        |_data| {
            let directory = tempfile::tempdir().unwrap();
            let root = directory.path();
            provenance_active_store(root);
            std::fs::create_dir_all(dir(root)).unwrap();
            std::fs::write(state_path(root), b"{\"scored\":").unwrap();
            let before = provenance_snapshot(root);
            assert!(full_tier_items(root).is_err());
            assert!(digestable_session_days(root).is_err());
            assert_eq!(provenance_snapshot(root), before);
        },
    );
}

#[test]
fn provenance_empty_index_lifecycle_runs_without_models_and_keeps_history() {
    crate::settings::test_support::with_isolated_data("distill-empty-index-lifecycle", |_data| {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        seed_wiki_pages(root, 4);
        std::fs::create_dir_all(root.join("raw")).unwrap();
        std::fs::write(root.join("raw/reference.md"), b"synthetic immutable raw").unwrap();
        std::fs::write(
            root.join("profile.md"),
            "## Interests\n- must not request an embedding\n",
        )
        .unwrap();
        let original = DistillState {
            model: "model-old".into(),
            agent_turns: vec![42],
            rejected_ttl: HashMap::from([("raw/reference.md".into(), 2_000_000_000)]),
            last_run: Some(1),
            last_backlogs: vec![5, 4],
            ..Default::default()
        };
        state_save(root, &original).unwrap();
        std::fs::write(
            dir(root).join("distill-kept.json"),
            b"[\"raw/reference.md\"]",
        )
        .unwrap();
        let kept_before = std::fs::read(dir(root).join("distill-kept.json")).unwrap();
        let rel = provenance_sidecar(root, "expired-cold", serde_json::json!([1.0, 0.0]));
        provenance_edit_sidecar(root, &rel, |value| {
            value["expires"] = serde_json::json!(now_secs() - 1)
        });
        std::fs::write(dir(root).join("ontology.json"), b"{\"legacy-corrupt\":").unwrap();
        let ontology_before = std::fs::read(dir(root).join("ontology.json")).unwrap();
        let report = run_without_embeddings(root, &DistillConfig::default()).unwrap();
        assert_eq!(report.scan.scored, 0);
        assert_eq!(
            report.scan.gate_wiki_pages,
            Some(4),
            "cold-start count must be the real wiki count"
        );
        assert_eq!(
            report.trashed + report.deleted,
            1,
            "rule-only expiry must remain available without model installation"
        );
        assert!(!root.join(&rel).exists());
        assert_eq!(
            std::fs::read(root.join("raw/reference.md")).unwrap(),
            b"synthetic immutable raw"
        );
        assert_eq!(
            std::fs::read(dir(root).join("distill-kept.json")).unwrap(),
            kept_before
        );
        assert_eq!(
            std::fs::read(dir(root).join("ontology.json")).unwrap(),
            ontology_before
        );
        let after = state_load_checked(root, "").unwrap();
        assert_eq!(after.agent_turns, original.agent_turns);
        assert_eq!(after.rejected_ttl, original.rejected_ttl);
        assert_eq!(&after.last_backlogs[..2], original.last_backlogs.as_slice());
    });
}

#[test]
fn provenance_lifecycle_only_route_refuses_a_stamped_nonempty_index() {
    crate::settings::test_support::with_isolated_data("distill-lifecycle-index-refusal", |_data| {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        provenance_active_store(root);
        std::fs::create_dir_all(root.join("sessions")).unwrap();
        std::fs::write(root.join("sessions/loose.md"), PROSE).unwrap();
        let before = provenance_snapshot(root);
        assert!(run_without_embeddings(root, &DistillConfig::default()).is_err());
        assert_eq!(provenance_snapshot(root), before);
    });
}

fn provenance_assert_bad_kept_marks(make_bad: impl FnOnce(&Path)) {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    std::fs::create_dir_all(root.join("_inbox")).unwrap();
    let note = root.join("_inbox/held.md");
    std::fs::write(&note, PROSE).unwrap();
    set_mtime(&note, old_mtime());
    std::fs::create_dir_all(dir(root)).unwrap();
    make_bad(&dir(root).join("distill-kept.json"));
    let before = provenance_snapshot(root);
    let embed = |texts: Vec<String>| {
        Ok(texts
            .iter()
            .map(|_| vec![0.2_f32, (1.0 - 0.2_f32 * 0.2_f32).sqrt()])
            .collect())
    };
    let mut manifest = test_manifest();
    let manifest_before = serde_json::to_vec(&manifest).unwrap();
    assert!(scan(
        root,
        &provenance_ontology("space-active"),
        &DistillConfig::default(),
        10,
        &embed,
        &[],
        &mut manifest
    )
    .is_err());
    assert!(record_kept(root, &["_inbox/held.md".into()]).is_err());
    assert_eq!(serde_json::to_vec(&manifest).unwrap(), manifest_before);
    assert_eq!(provenance_snapshot(root), before);
    assert!(note.exists());
    assert!(!root.join("_inbox/quarantine").exists());
}

#[test]
fn provenance_corrupt_kept_marks_cannot_be_overwritten_or_requarantined() {
    provenance_assert_bad_kept_marks(|path| std::fs::write(path, b"[\"held\",").unwrap());
}

#[test]
fn provenance_nonregular_kept_marks_cannot_be_overwritten_or_requarantined() {
    provenance_assert_bad_kept_marks(|path| std::fs::create_dir(path).unwrap());
}

#[cfg(unix)]
#[test]
fn provenance_linked_kept_marks_cannot_be_followed_or_requarantined() {
    let outside = tempfile::tempdir().unwrap();
    let target = outside.path().join("synthetic-kept.json");
    std::fs::write(&target, b"[\"_inbox/held.md\"]").unwrap();
    let target_before = std::fs::read(&target).unwrap();
    provenance_assert_bad_kept_marks(|path| std::os::unix::fs::symlink(&target, path).unwrap());
    assert_eq!(std::fs::read(&target).unwrap(), target_before);
}

#[test]
fn provenance_corrupt_kept_marks_abort_the_cold_lifecycle_before_partitioning() {
    crate::settings::test_support::with_isolated_data("distill-cold-corrupt-kept", |_data| {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        std::fs::create_dir_all(dir(root)).unwrap();
        std::fs::write(dir(root).join("distill-kept.json"), b"[").unwrap();
        std::fs::create_dir_all(root.join("sessions")).unwrap();
        std::fs::write(root.join("sessions/loose.md"), PROSE).unwrap();
        let before = provenance_snapshot(root);
        assert!(run_without_embeddings(root, &DistillConfig::default()).is_err());
        assert_eq!(provenance_snapshot(root), before);
    });
}

#[test]
fn provenance_restore_refuses_to_move_before_lost_kept_marks_are_recovered() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let rel = provenance_sidecar(root, "held", serde_json::json!([1.0, 0.0]));
    std::fs::create_dir_all(dir(root)).unwrap();
    std::fs::write(dir(root).join("distill-kept.json"), b"[").unwrap();
    let before = provenance_snapshot(root);
    assert!(readmit_quarantine(root, &[rel]).is_err());
    assert_eq!(provenance_snapshot(root), before);
}

#[test]
fn provenance_semantic_directory_failure_is_not_an_empty_group_success() {
    crate::settings::test_support::with_isolated_data(
        "distill-quarantine-directory-error",
        |_data| {
            let directory = tempfile::tempdir().unwrap();
            let root = directory.path();
            provenance_active_store(root);
            std::fs::create_dir_all(root.join("_inbox")).unwrap();
            std::fs::write(root.join("_inbox/quarantine"), b"synthetic non-directory").unwrap();
            let before = provenance_snapshot(root);
            assert!(emerging_clusters(root, 1, 0.0).is_err());
            let mut manifest = test_manifest();
            assert!(propose_emerging_clusters(root, &mut manifest).is_err());
            assert_eq!(provenance_snapshot(root), before);
        },
    );
}

#[cfg(unix)]
#[test]
fn provenance_linked_sidecar_is_an_error_without_following_its_target() {
    crate::settings::test_support::with_isolated_data(
        "distill-quarantine-linked-sidecar",
        |_data| {
            let directory = tempfile::tempdir().unwrap();
            let outside = tempfile::tempdir().unwrap();
            let root = directory.path();
            provenance_active_store(root);
            let rel = provenance_sidecar(root, "linked", serde_json::json!([1.0, 0.0]));
            let sidecar = sidecar_path(&root.join(&rel));
            let target = outside.path().join("synthetic-sidecar.json");
            std::fs::rename(&sidecar, &target).unwrap();
            std::os::unix::fs::symlink(&target, &sidecar).unwrap();
            let target_before = std::fs::read(&target).unwrap();
            assert!(read_sidecar(root, &rel).is_err());
            assert!(emerging_clusters(root, 1, 0.0).is_err());
            assert_eq!(std::fs::read(&target).unwrap(), target_before);
            assert!(root.join(rel).exists());
        },
    );
}

#[cfg(unix)]
#[test]
fn provenance_linked_state_is_not_read_as_admission_authority() {
    let directory = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let root = directory.path();
    std::fs::create_dir_all(dir(root)).unwrap();
    let target = outside.path().join("synthetic-state.json");
    std::fs::write(&target, b"{\"model\":\"test-model\",\"scored\":{}}").unwrap();
    std::os::unix::fs::symlink(&target, state_path(root)).unwrap();
    let target_before = std::fs::read(&target).unwrap();
    assert!(state_load_checked(root, "test-model").is_err());
    assert_eq!(std::fs::read(&target).unwrap(), target_before);
}

#[test]
fn provenance_metadata_counts_use_current_space_instead_of_the_last_context() {
    crate::settings::test_support::with_isolated_data("distill-metadata-current-space", |_data| {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        provenance_active_store(root);
        std::fs::create_dir_all(root.join("_inbox")).unwrap();
        let path = root.join("_inbox/held.md");
        std::fs::write(&path, PROSE).unwrap();
        set_mtime(&path, old_mtime());
        let state = serde_json::json!({"model":"test-model", "embedding":provenance_space("space-active"), "scored":{"_inbox/held.md":{"hash":crate::embeddings::content_hash(PROSE),"tier":"full","at":1,"embedding":provenance_space("space-active")}}});
        let mut state = state;
        let ontology: Ontology =
            serde_json::from_slice(&std::fs::read(dir(root).join("ontology.json")).unwrap())
                .unwrap();
        let decision = admission::capture(root, &ontology, &config_load(root)).unwrap();
        state["decision_signature"] = decision.signature.clone().into();
        state["scored"]["_inbox/held.md"]["decision_signature"] = decision.signature.into();
        state["scored"]["_inbox/held.md"]["source_sha256"] =
            admission::sha256(PROSE.as_bytes()).into();
        std::fs::create_dir_all(dir(root)).unwrap();
        std::fs::write(state_path(root), serde_json::to_vec(&state).unwrap()).unwrap();
        assert_eq!(status(root).backlog, 0);
        let space: EmbeddingSpace = serde_json::from_value(provenance_space("space-new")).unwrap();
        let store =
            synthetic_current_store(root, &space, &[("wiki/topic.md".into(), vec![1.0, 0.0])]);
        let index_path = crate::vector_index::VectorStore::path_for(
            &root.canonicalize().unwrap().to_string_lossy(),
        )
        .unwrap();
        store.save(&index_path).unwrap();
        let before = provenance_snapshot(root);
        assert_eq!(status(root).backlog, 1);
        assert_eq!(report(root).unscored_by_folder["_inbox"], 1);
        assert!(full_tier_items(root).unwrap().is_empty());
        assert_eq!(provenance_snapshot(root), before);
    });
}
