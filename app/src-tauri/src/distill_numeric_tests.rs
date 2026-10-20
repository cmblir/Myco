use super::*;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, PartialEq)]
struct NumericVaultSnapshot {
    directories: BTreeSet<String>,
    files: BTreeMap<String, (Vec<u8>, std::time::SystemTime)>,
}

fn numeric_vault_snapshot(root: &Path) -> NumericVaultSnapshot {
    fn walk(root: &Path, directory: &Path, snapshot: &mut NumericVaultSnapshot) {
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
    let mut snapshot = NumericVaultSnapshot {
        directories: BTreeSet::new(),
        files: BTreeMap::new(),
    };
    walk(root, root, &mut snapshot);
    snapshot
}

fn numeric_scan_fixture(count: usize) -> (tempfile::TempDir, Ontology, RunManifest) {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    std::fs::create_dir_all(root.join("_inbox")).unwrap();
    for index in 0..count {
        let path = root.join(format!("_inbox/item-{index:02}.md"));
        std::fs::write(&path, format!("{PROSE} Synthetic item {index}.")).unwrap();
        set_mtime(&path, old_mtime());
    }
    std::fs::create_dir_all(root.join("kept")).unwrap();
    std::fs::write(
        root.join("kept/reference.md"),
        "synthetic retained reference",
    )
    .unwrap();
    let ontology = tiny_ontology();
    let state = DistillState {
        model: ontology.model.clone(),
        embedding: ontology.embedding.clone(),
        decision_signature: None,
        scored: HashMap::from([(
            "kept/reference.md".into(),
            ScoredEntry {
                hash: 7,
                tier: "full".into(),
                at: 1,
                mtime: 2,
                len: 3,
                rules: GATE_RULES,
                turn: None,
                embedding: None,
                nonsemantic: None,
                source_sha256: None,
                decision_signature: None,
            },
        )]),
        rejected_ttl: HashMap::from([("kept/reference.md".into(), 2_000_000_000)]),
        last_run: Some(123),
        last_backlogs: vec![5, 4],
        agent_turns: vec![42],
    };
    state_save(root, &state).unwrap();
    let mut manifest = test_manifest();
    manifest.created.push("kept/reference.md".into());
    save_manifest(root, &manifest).unwrap();
    (directory, ontology, manifest)
}

fn numeric_assert_scan_error_preserves_vault(
    count: usize,
    change_ontology: impl FnOnce(&mut Ontology),
    embed: &dyn Fn(Vec<String>) -> Result<Vec<Vec<f32>>, String>,
) {
    let (directory, mut ontology, mut manifest) = numeric_scan_fixture(count);
    let root = directory.path();
    change_ontology(&mut ontology);
    let before = numeric_vault_snapshot(root);
    let manifest_before = serde_json::to_vec(&manifest).unwrap();
    let result = scan(
        root,
        &ontology,
        &DistillConfig::default(),
        count,
        embed,
        &[],
        &mut manifest,
    );
    assert!(
        result.is_err(),
        "invalid semantic input was accepted: {result:?}"
    );
    assert_eq!(serde_json::to_vec(&manifest).unwrap(), manifest_before);
    assert_eq!(numeric_vault_snapshot(root), before);
    assert!(!root.join("_inbox/quarantine").exists());
}

#[test]
fn numeric_scan_refuses_short_embedding_batch_without_scoring_or_moves() {
    numeric_assert_scan_error_preserves_vault(2, |_| {}, &|_| Ok(vec![vec![1.0, 0.0]]));
}

#[test]
fn numeric_scan_refuses_extra_embedding_batch_without_scoring_or_moves() {
    numeric_assert_scan_error_preserves_vault(1, |_| {}, &|_| {
        Ok(vec![vec![1.0, 0.0], vec![1.0, 0.0]])
    });
}

fn numeric_assert_invalid_item(vector: Vec<f32>) {
    numeric_assert_scan_error_preserves_vault(1, |_| {}, &|_| Ok(vec![vector.clone()]));
}

#[test]
fn numeric_scan_refuses_empty_item_vector() {
    numeric_assert_invalid_item(vec![]);
}

#[test]
fn numeric_scan_refuses_short_item_vector() {
    numeric_assert_invalid_item(vec![1.0]);
}

#[test]
fn numeric_scan_refuses_long_item_vector() {
    numeric_assert_invalid_item(vec![1.0, 0.0, 0.0]);
}

#[test]
fn numeric_scan_refuses_zero_item_vector() {
    numeric_assert_invalid_item(vec![0.0, 0.0]);
}

#[test]
fn numeric_scan_refuses_nan_item_vector() {
    numeric_assert_invalid_item(vec![f32::NAN, 0.0]);
}

#[test]
fn numeric_scan_refuses_infinite_item_vector() {
    numeric_assert_invalid_item(vec![f32::INFINITY, 0.0]);
}

#[test]
fn numeric_scan_refuses_nonunit_producer_item_vector() {
    numeric_assert_invalid_item(vec![2.0, 0.0]);
}

#[test]
fn numeric_later_short_batch_leaves_earlier_32_items_unmoved() {
    let calls = std::cell::RefCell::new(Vec::new());
    let embed = |texts: Vec<String>| -> Result<Vec<Vec<f32>>, String> {
        calls.borrow_mut().push(texts.len());
        if texts.len() == 1 {
            Ok(Vec::new())
        } else {
            // Similarity 0.2 is in tiny_ontology's quarantine band.
            Ok(texts.iter().map(|_| vec![0.2, 0.96_f32.sqrt()]).collect())
        }
    };
    numeric_assert_scan_error_preserves_vault(33, |_| {}, &embed);
    assert_eq!(*calls.borrow(), vec![32, 1]);
}

fn numeric_assert_invalid_ontology(change: impl FnOnce(&mut Ontology)) {
    numeric_assert_scan_error_preserves_vault(2, change, &|texts| {
        Ok(texts.iter().map(|_| vec![0.2, 0.96_f32.sqrt()]).collect())
    });
}

#[test]
fn numeric_scan_refuses_empty_ontology_centroid() {
    numeric_assert_invalid_ontology(|ontology| ontology.clusters[0].centroid.clear());
}

#[test]
fn numeric_scan_refuses_zero_ontology_centroid() {
    numeric_assert_invalid_ontology(|ontology| ontology.clusters[0].centroid = vec![0.0, 0.0]);
}

#[test]
fn numeric_scan_refuses_nan_ontology_centroid() {
    numeric_assert_invalid_ontology(|ontology| {
        ontology.clusters[0].centroid = vec![f32::NAN, 0.0];
    });
}

#[test]
fn numeric_scan_refuses_infinite_ontology_centroid() {
    numeric_assert_invalid_ontology(|ontology| {
        ontology.clusters[0].centroid = vec![f32::INFINITY, 0.0];
    });
}

#[test]
fn numeric_scan_refuses_mixed_ontology_dimensions_before_any_item_move() {
    numeric_assert_invalid_ontology(|ontology| {
        let mut malformed = ontology.clusters[0].clone();
        malformed.id = 1;
        malformed.centroid = vec![0.0, 1.0, 0.0];
        ontology.clusters.push(malformed);
    });
}

#[test]
fn numeric_scan_refuses_negative_ontology_stddev() {
    numeric_assert_invalid_ontology(|ontology| ontology.clusters[0].sim_std = -0.1);
}

#[test]
fn numeric_scan_refuses_nonfinite_ontology_statistics() {
    numeric_assert_invalid_ontology(|ontology| ontology.clusters[0].sim_mean = f32::INFINITY);
}

#[test]
fn numeric_scan_refuses_unordered_ontology_percentiles() {
    numeric_assert_invalid_ontology(|ontology| ontology.clusters[0].p5 = 0.8);
}

fn numeric_assert_profile_no_lift(profile_vectors: Vec<Vec<f32>>) {
    crate::settings::test_support::with_isolated_data("distill-invalid-profile", |_data| {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        seed_wiki_pages(root, GATE_MIN_WIKI_PAGES);
        std::fs::create_dir_all(root.join("_inbox")).unwrap();
        let note = root.join("_inbox/note.md");
        std::fs::write(&note, PROSE).unwrap();
        set_mtime(&note, old_mtime());
        std::fs::write(
            root.join("profile.md"),
            "## Interests\n- widgets\n- gadgets\n",
        )
        .unwrap();
        save_synthetic_ontology(root, ontology_two_clusters());
        let embed = |texts: Vec<String>| -> Result<Vec<Vec<f32>>, String> {
            if texts == vec!["widgets".to_string(), "gadgets".to_string()] {
                return Ok(profile_vectors.clone());
            }
            Ok(texts.iter().map(|_| vec![0.0, 0.0, 1.0]).collect())
        };
        let report = run(root, &DistillConfig::default(), &embed).unwrap();
        assert_eq!(
            report.scan.rejected, 1,
            "invalid optional profile must not grant a lift"
        );
        assert_eq!(report.scan.summaries, 0);
        assert_eq!(report.scan.quarantined, 0);
        assert_eq!(std::fs::read_to_string(&note).unwrap(), PROSE);
        assert!(!root.join("_inbox/quarantine").exists());
    });
}

#[test]
fn numeric_profile_short_batch_degrades_to_no_lift() {
    numeric_assert_profile_no_lift(vec![vec![0.0, 0.0, 1.0]]);
}

#[test]
fn numeric_profile_extra_batch_degrades_to_no_lift() {
    numeric_assert_profile_no_lift(vec![vec![0.0, 0.0, 1.0]; 3]);
}

#[test]
fn numeric_profile_empty_batch_remains_no_lift() {
    numeric_assert_profile_no_lift(Vec::new());
}

fn numeric_assert_bad_profile_neighbor(vector: Vec<f32>) {
    numeric_assert_profile_no_lift(vec![vec![0.0, 0.0, 1.0], vector]);
}

#[test]
fn numeric_profile_empty_neighbor_invalidates_the_whole_optional_batch() {
    numeric_assert_bad_profile_neighbor(vec![]);
}

#[test]
fn numeric_profile_short_neighbor_invalidates_the_whole_optional_batch() {
    numeric_assert_bad_profile_neighbor(vec![0.0, 1.0]);
}

#[test]
fn numeric_profile_long_neighbor_invalidates_the_whole_optional_batch() {
    numeric_assert_bad_profile_neighbor(vec![0.0, 0.0, 1.0, 0.0]);
}

#[test]
fn numeric_profile_zero_neighbor_invalidates_the_whole_optional_batch() {
    numeric_assert_bad_profile_neighbor(vec![0.0, 0.0, 0.0]);
}

#[test]
fn numeric_profile_nan_neighbor_invalidates_the_whole_optional_batch() {
    numeric_assert_bad_profile_neighbor(vec![f32::NAN, 0.0, 0.0]);
}

#[test]
fn numeric_profile_infinite_neighbor_invalidates_the_whole_optional_batch() {
    numeric_assert_bad_profile_neighbor(vec![f32::INFINITY, 0.0, 0.0]);
}

#[test]
fn numeric_profile_nonunit_neighbor_invalidates_the_whole_optional_batch() {
    numeric_assert_bad_profile_neighbor(vec![0.0, 0.0, 2.0]);
}

#[test]
fn numeric_later_selected_threshold_error_leaves_prior_quarantine_unmoved() {
    let change = |ontology: &mut Ontology| {
        let mut overflowing = ontology.clusters[0].clone();
        overflowing.id = 1;
        overflowing.label = "overflowing synthetic topic".into();
        overflowing.centroid = vec![-1.0, 0.0];
        overflowing.p5 = -f32::MAX;
        overflowing.p25 = -f32::MAX;
        overflowing.p40 = -f32::MAX;
        overflowing.override_widen = f32::MAX;
        ontology.clusters.push(overflowing);
        assert!(ontology.validate_geometry(None).is_ok());
        assert_eq!(
            admit(
                ontology,
                &[0.2, 0.96_f32.sqrt()],
                PROSE,
                &GatePreset::Normal,
                &[],
            )
            .unwrap()
            .tier,
            Tier::Quarantine
        );
        assert!(admit(ontology, &[-1.0, 0.0], PROSE, &GatePreset::Normal, &[]).is_err());
    };
    numeric_assert_scan_error_preserves_vault(2, change, &|texts| {
        assert_eq!(texts.len(), 2);
        Ok(vec![vec![0.2, 0.96_f32.sqrt()], vec![-1.0, 0.0]])
    });
}
