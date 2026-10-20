use super::*;
use std::collections::{BTreeMap, BTreeSet};

const DECISION_RAW: &str = "synthetic owner-maintained source";
const DECISION_RETAINED: &str = "kept/reference.md";
const DECISION_TTL: i64 = 2_000_000_000;

fn decision_fixture(rel: &str, body: &str) -> (tempfile::TempDir, Ontology, RunManifest) {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    seed_wiki_pages(root, GATE_MIN_WIKI_PAGES);
    save_synthetic_ontology(root, tiny_ontology());
    let ontology: Ontology =
        serde_json::from_slice(&std::fs::read(dir(root).join("ontology.json")).unwrap()).unwrap();
    let path = root.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, body).unwrap();
    set_mtime(&path, old_mtime());
    std::fs::create_dir_all(root.join("raw")).unwrap();
    std::fs::write(root.join("raw/reference.md"), DECISION_RAW).unwrap();
    std::fs::create_dir_all(root.join("kept")).unwrap();
    std::fs::write(root.join(DECISION_RETAINED), "synthetic retained reference").unwrap();
    let state = serde_json::json!({
        "model": ontology.model,
        "embedding": ontology.embedding,
        "scored": {DECISION_RETAINED: {
            "hash": 7, "tier": "reject", "at": 8, "mtime": 9, "len": 10,
            "rules": GATE_RULES, "nonsemantic": "junk"
        }},
        "rejected_ttl": {DECISION_RETAINED: DECISION_TTL},
        "last_run": 123, "last_backlogs": [5, 4], "agent_turns": [42]
    });
    state_save(root, &serde_json::from_value(state).unwrap()).unwrap();
    std::fs::write(
        dir(root).join("distill-kept.json"),
        serde_json::to_vec(&vec![DECISION_RETAINED]).unwrap(),
    )
    .unwrap();
    config_save(root, &DistillConfig::default()).unwrap();
    (directory, ontology, test_manifest())
}

fn decision_assert_history_preserved(root: &Path, model: &str) {
    let state = state_load_checked(root, model).unwrap();
    assert_eq!(state.rejected_ttl[DECISION_RETAINED], DECISION_TTL);
    assert_eq!(state.agent_turns, vec![42]);
    assert_eq!(&state.last_backlogs[..2], &[5, 4]);
    assert_eq!(
        serde_json::to_value(&state.scored[DECISION_RETAINED]).unwrap(),
        serde_json::json!({
            "hash": 7, "tier": "reject", "at": 8, "mtime": 9, "len": 10,
            "rules": GATE_RULES, "nonsemantic": "junk"
        })
    );
    assert_eq!(
        std::fs::read(root.join("raw/reference.md")).unwrap(),
        DECISION_RAW.as_bytes()
    );
    assert_eq!(kept_load(root).unwrap(), vec![DECISION_RETAINED]);
    assert_eq!(
        std::fs::read(root.join(DECISION_RETAINED)).unwrap(),
        b"synthetic retained reference"
    );
}

fn decision_score(
    root: &Path,
    ontology: &Ontology,
    cfg: &DistillConfig,
    vector: &[f32],
    manifest: &mut RunManifest,
) -> ScanOutcome {
    scan(
        root,
        ontology,
        cfg,
        20,
        &|texts| Ok(texts.iter().map(|_| vector.to_vec()).collect()),
        &[],
        manifest,
    )
    .unwrap()
}

fn decision_tier(root: &Path, ontology: &Ontology, rel: &str) -> String {
    state_load_checked(root, &ontology.model).unwrap().scored[rel]
        .tier
        .clone()
}

#[derive(Debug, PartialEq)]
struct DecisionVaultSnapshot {
    directories: BTreeSet<String>,
    files: BTreeMap<String, (Vec<u8>, std::time::SystemTime)>,
}

fn decision_snapshot(root: &Path) -> DecisionVaultSnapshot {
    fn walk(root: &Path, directory: &Path, snapshot: &mut DecisionVaultSnapshot) {
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
    let mut snapshot = DecisionVaultSnapshot {
        directories: BTreeSet::new(),
        files: BTreeMap::new(),
    };
    walk(root, root, &mut snapshot);
    snapshot
}

fn decision_replace_same_stamp(path: &Path, replacement: &str) {
    let metadata = std::fs::metadata(path).unwrap();
    assert_eq!(metadata.len(), replacement.len() as u64);
    let modified = metadata.modified().unwrap();
    std::fs::write(path, replacement).unwrap();
    set_mtime(path, modified);
    let after = std::fs::metadata(path).unwrap();
    assert_eq!(after.len(), metadata.len());
    assert_eq!(after.modified().unwrap(), modified);
}

#[test]
fn decision_ontology_revision_rechecks_a_warm_full_verdict() {
    crate::settings::test_support::with_isolated_data("distill-decision-source", |_data| {
        let rel = "_inbox/held.md";
        let (directory, mut ontology, mut manifest) = decision_fixture(rel, PROSE);
        let root = directory.path();
        let cfg = DistillConfig::default();
        assert_eq!(
            decision_score(root, &ontology, &cfg, &[1.0, 0.0], &mut manifest).full,
            1
        );
        let space = ontology.embedding.clone();
        ontology.source_signature.push_str("-new-source-revision");
        ontology.clusters[0].centroid = vec![0.0, 1.0];
        assert_eq!(ontology.embedding, space);
        let outcome = decision_score(root, &ontology, &cfg, &[1.0, 0.0], &mut manifest);
        assert_eq!(
            outcome.scored, 1,
            "new knowledge inputs reused the old full verdict"
        );
        assert_eq!(outcome.rejected, 1);
        assert_eq!(decision_tier(root, &ontology, rel), "reject");
        assert_eq!(std::fs::read(root.join(rel)).unwrap(), PROSE.as_bytes());
        decision_assert_history_preserved(root, &ontology.model);
    });
}

#[test]
fn decision_changed_geometry_cannot_hide_behind_the_same_source_signature_or_hash() {
    crate::settings::test_support::with_isolated_data("distill-decision-geometry", |_data| {
        let rel = "_inbox/held.md";
        let (directory, mut ontology, mut manifest) = decision_fixture(rel, PROSE);
        let root = directory.path();
        let cfg = DistillConfig::default();
        assert_eq!(
            decision_score(root, &ontology, &cfg, &[1.0, 0.0], &mut manifest).full,
            1
        );
        let source_signature = ontology.source_signature.clone();
        ontology.clusters[0].centroid = vec![0.0, 1.0];
        set_mtime(
            &root.join(rel),
            old_mtime() - std::time::Duration::from_secs(3600),
        );
        assert_eq!(ontology.source_signature, source_signature);
        let outcome = decision_score(root, &ontology, &cfg, &[1.0, 0.0], &mut manifest);
        assert_eq!(
            outcome.scored, 1,
            "same body hash retained a verdict from different geometry"
        );
        assert_eq!(outcome.rejected, 1);
        assert_eq!(decision_tier(root, &ontology, rel), "reject");
        assert_eq!(std::fs::read(root.join(rel)).unwrap(), PROSE.as_bytes());
        decision_assert_history_preserved(root, &ontology.model);
    });
}

#[test]
fn decision_stricter_preset_rechecks_a_warm_full_verdict() {
    crate::settings::test_support::with_isolated_data("distill-decision-preset", |_data| {
        let rel = "_inbox/held.md";
        let (directory, ontology, mut manifest) = decision_fixture(rel, PROSE);
        let root = directory.path();
        let mut cfg = DistillConfig::default();
        assert_eq!(
            decision_score(root, &ontology, &cfg, &[0.6, 0.8], &mut manifest).full,
            1
        );
        cfg.gate_preset = GatePreset::Strict;
        let outcome = decision_score(root, &ontology, &cfg, &[0.6, 0.8], &mut manifest);
        assert_eq!(
            outcome.scored, 1,
            "new admission policy reused the old full verdict"
        );
        assert_eq!(outcome.summaries, 1);
        assert_eq!(decision_tier(root, &ontology, rel), "summary");
        assert_eq!(std::fs::read(root.join(rel)).unwrap(), PROSE.as_bytes());
        decision_assert_history_preserved(root, &ontology.model);
    });
}

#[test]
fn decision_profile_interest_change_rechecks_a_warm_lifted_verdict() {
    crate::settings::test_support::with_isolated_data("distill-decision-profile", |_data| {
        let rel = "_inbox/held.md";
        let (directory, ontology, _manifest) = decision_fixture(rel, PROSE);
        let root = directory.path();
        let cfg = DistillConfig::default();
        let expected = ontology.embedding.as_ref().unwrap();
        let producer = |texts: Vec<String>| {
            let vectors = texts
                .iter()
                .map(|text| {
                    if text == "other-topic" {
                        vec![1.0, 0.0]
                    } else {
                        vec![0.0, 1.0]
                    }
                })
                .collect();
            Ok(EmbeddedBatch {
                space: expected.clone(),
                vectors,
            })
        };
        std::fs::write(root.join("profile.md"), "## Interests\n- match-topic\n").unwrap();
        let first = run_checked(root, &cfg, expected, &producer).unwrap();
        assert_eq!(first.scan.summaries, 1);
        assert_eq!(decision_tier(root, &ontology, rel), "summary");
        std::fs::write(root.join("profile.md"), "## Interests\n- other-topic\n").unwrap();
        let second = run_checked(root, &cfg, expected, &producer).unwrap();
        assert_eq!(
            second.scan.scored, 1,
            "changed interests retained the old profile lift"
        );
        assert_eq!(second.scan.rejected, 1);
        assert_eq!(decision_tier(root, &ontology, rel), "reject");
        assert_eq!(std::fs::read(root.join(rel)).unwrap(), PROSE.as_bytes());
        decision_assert_history_preserved(root, &ontology.model);
    });
}

#[test]
fn decision_same_length_same_mtime_body_replacement_requires_a_new_verdict() {
    crate::settings::test_support::with_isolated_data("distill-decision-body", |_data| {
        let rel = "_inbox/held.md";
        let original = format!("{PROSE} AAAAA");
        let replacement = format!("{PROSE} BBBBB");
        let (directory, ontology, mut manifest) = decision_fixture(rel, &original);
        let root = directory.path();
        let cfg = DistillConfig::default();
        assert_eq!(
            decision_score(root, &ontology, &cfg, &[1.0, 0.0], &mut manifest).full,
            1
        );
        decision_replace_same_stamp(&root.join(rel), &replacement);
        let outcome = decision_score(root, &ontology, &cfg, &[0.0, 1.0], &mut manifest);
        assert_eq!(
            outcome.scored, 1,
            "current source bytes were confused with an equal file stamp"
        );
        assert_eq!(outcome.rejected, 1);
        assert_eq!(decision_tier(root, &ontology, rel), "reject");
        let state = state_load_checked(root, &ontology.model).unwrap();
        assert_eq!(
            state.scored[rel].hash,
            crate::embeddings::content_hash(&replacement)
        );
        assert_eq!(
            std::fs::read(root.join(rel)).unwrap(),
            replacement.as_bytes()
        );
        decision_assert_history_preserved(root, &ontology.model);
    });
}

#[test]
fn decision_full_tier_queue_withholds_a_changed_current_body() {
    crate::settings::test_support::with_isolated_data("distill-decision-full-queue", |_data| {
        let rel = "_inbox/held.md";
        let original = format!("{PROSE} AAAAA");
        let replacement = format!("{PROSE} BBBBB");
        let (directory, ontology, mut manifest) = decision_fixture(rel, &original);
        let root = directory.path();
        assert_eq!(
            decision_score(
                root,
                &ontology,
                &DistillConfig::default(),
                &[1.0, 0.0],
                &mut manifest
            )
            .full,
            1
        );
        assert_eq!(full_tier_items(root).unwrap(), vec![rel.to_string()]);
        decision_replace_same_stamp(&root.join(rel), &replacement);
        let before = decision_snapshot(root);
        assert!(
            full_tier_items(root).unwrap().is_empty(),
            "stale full verdict authorized ingest of changed bytes"
        );
        assert_eq!(decision_snapshot(root), before);
        decision_assert_history_preserved(root, &ontology.model);
    });
}

#[test]
fn decision_digest_queue_withholds_a_changed_current_session_body() {
    crate::settings::test_support::with_isolated_data("distill-decision-digest-queue", |_data| {
        let rel = "sessions/2026-01-01-work.md";
        let original = format!("{PROSE} AAAAA");
        let replacement = format!("{PROSE} BBBBB");
        let (directory, ontology, mut manifest) = decision_fixture(rel, &original);
        let root = directory.path();
        assert_eq!(
            decision_score(
                root,
                &ontology,
                &DistillConfig::default(),
                &[1.0, 0.0],
                &mut manifest
            )
            .full,
            1
        );
        let baseline = digestable_session_days(root).unwrap();
        assert_eq!(baseline.len(), 1);
        assert_eq!(baseline[0].files, vec![rel.to_string()]);
        decision_replace_same_stamp(&root.join(rel), &replacement);
        let before = decision_snapshot(root);
        assert!(
            digestable_session_days(root).unwrap().is_empty(),
            "stale session verdict authorized digest of changed bytes"
        );
        assert_eq!(decision_snapshot(root), before);
        decision_assert_history_preserved(root, &ontology.model);
    });
}

fn decision_quarantine_fixture() -> (tempfile::TempDir, Ontology, RunManifest) {
    let (directory, ontology, mut manifest) =
        decision_fixture("_inbox/item-0.md", &format!("{PROSE} AAAAA-0"));
    let root = directory.path();
    for index in 1..5 {
        let path = root.join(format!("_inbox/item-{index}.md"));
        std::fs::write(&path, format!("{PROSE} AAAAA-{index}")).unwrap();
        set_mtime(&path, old_mtime());
    }
    let outcome = decision_score(
        root,
        &ontology,
        &DistillConfig::default(),
        &[0.2, 0.96_f32.sqrt()],
        &mut manifest,
    );
    assert_eq!(outcome.quarantined, 5);
    let groups = emerging_clusters(root, 5, 0.9).unwrap();
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].len(), 5);
    (directory, ontology, manifest)
}

#[test]
fn decision_quarantine_groups_withhold_a_vector_for_changed_current_body() {
    crate::settings::test_support::with_isolated_data(
        "distill-decision-quarantine-group",
        |_data| {
            let (directory, ontology, _manifest) = decision_quarantine_fixture();
            let root = directory.path();
            decision_replace_same_stamp(
                &root.join("_inbox/quarantine/item-0.md"),
                &format!("{PROSE} BBBBB-0"),
            );
            let before = decision_snapshot(root);
            assert!(
                emerging_clusters(root, 5, 0.9).unwrap().is_empty(),
                "old vector grouped a changed quarantine body into a five-member topic"
            );
            assert_eq!(
                quarantine_entries(root).len(),
                5,
                "semantic exclusion must retain owner review"
            );
            assert_eq!(decision_snapshot(root), before);
            decision_assert_history_preserved(root, &ontology.model);
        },
    );
}

#[test]
fn decision_quarantine_proposal_cannot_use_a_changed_current_body() {
    crate::settings::test_support::with_isolated_data(
        "distill-decision-quarantine-proposal",
        |_data| {
            let (directory, ontology, mut manifest) = decision_quarantine_fixture();
            let root = directory.path();
            decision_replace_same_stamp(
                &root.join("_inbox/quarantine/item-0.md"),
                &format!("{PROSE} BBBBB-0"),
            );
            let before = decision_snapshot(root);
            let manifest_before = serde_json::to_vec(&manifest).unwrap();
            assert_eq!(
                propose_emerging_clusters(root, &mut manifest).unwrap(),
                0,
                "stale quarantine vector authorized a new topic proposal"
            );
            assert_eq!(serde_json::to_vec(&manifest).unwrap(), manifest_before);
            assert_eq!(quarantine_entries(root).len(), 5);
            assert_eq!(decision_snapshot(root), before);
            decision_assert_history_preserved(root, &ontology.model);
        },
    );
}

#[test]
fn decision_unchanged_context_and_source_reuse_a_current_verdict() {
    crate::settings::test_support::with_isolated_data("distill-decision-positive", |_data| {
        let rel = "_inbox/held.md";
        let (directory, ontology, mut manifest) = decision_fixture(rel, PROSE);
        let root = directory.path();
        let cfg = DistillConfig::default();
        assert_eq!(
            decision_score(root, &ontology, &cfg, &[1.0, 0.0], &mut manifest).full,
            1
        );
        let before = state_load_checked(root, &ontology.model).unwrap();
        let producer = |_: Vec<String>| -> Result<Vec<Vec<f32>>, String> {
            panic!("unchanged admitted source must not request an embedding")
        };
        let outcome = scan(root, &ontology, &cfg, 20, &producer, &[], &mut manifest).unwrap();
        assert_eq!(outcome.scored, 0);
        assert_eq!(decision_tier(root, &ontology, rel), "full");
        let after = state_load_checked(root, &ontology.model).unwrap();
        assert_eq!(
            serde_json::to_value(&after.scored).unwrap(),
            serde_json::to_value(&before.scored).unwrap()
        );
        assert_eq!(after.rejected_ttl, before.rejected_ttl);
        assert_eq!(after.last_run, before.last_run);
        assert_eq!(after.last_backlogs, before.last_backlogs);
        assert_eq!(full_tier_items(root).unwrap(), vec![rel.to_string()]);
        decision_assert_history_preserved(root, &ontology.model);
    });
}
