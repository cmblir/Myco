//! Native regression tests for ontology geometry at persistence boundaries.

use super::*;

fn good_ontology() -> Ontology {
    build(&super::tests::six_pages(), &[], &[]).unwrap()
}

fn assert_invalid_save_preserves_cache(change: impl FnOnce(&mut Ontology)) {
    let dir = tempfile::tempdir().unwrap();
    let good = good_ontology();
    save(dir.path(), &good).unwrap();
    let cache_dir = crate::vault_dir::dir(dir.path());
    let cache_path = cache_dir.join("ontology.json");
    let before = std::fs::read(&cache_path).unwrap();
    let mut invalid = good;
    change(&mut invalid);

    assert!(
        save(dir.path(), &invalid).is_err(),
        "invalid ontology must fail before replacing its last good cache"
    );
    assert_eq!(std::fs::read(&cache_path).unwrap(), before);
    assert!(!cache_dir.join(".ontology.json.tmp").exists());
}

#[test]
fn numeric_save_rejects_mixed_centroid_widths_before_publication() {
    assert_invalid_save_preserves_cache(|ontology| {
        ontology.clusters[1].centroid.pop();
    });
}

#[test]
fn numeric_save_rejects_empty_centroid_before_publication() {
    assert_invalid_save_preserves_cache(|ontology| ontology.clusters[0].centroid.clear());
}

#[test]
fn numeric_save_rejects_zero_centroid_before_publication() {
    assert_invalid_save_preserves_cache(|ontology| ontology.clusters[0].centroid.fill(0.0));
}

#[test]
fn numeric_save_rejects_nan_centroid_before_publication() {
    assert_invalid_save_preserves_cache(|ontology| {
        ontology.clusters[0].centroid[0] = f32::NAN;
    });
}

#[test]
fn numeric_save_rejects_infinite_centroid_before_publication() {
    assert_invalid_save_preserves_cache(|ontology| {
        ontology.clusters[0].centroid[0] = f32::INFINITY;
    });
}

#[test]
fn numeric_save_rejects_negative_standard_deviation_before_publication() {
    assert_invalid_save_preserves_cache(|ontology| ontology.clusters[0].sim_std = -0.1);
}

#[test]
fn numeric_save_rejects_descending_p5_p25_before_publication() {
    assert_invalid_save_preserves_cache(|ontology| {
        ontology.clusters[0].p5 = 0.5;
        ontology.clusters[0].p25 = 0.1;
        ontology.clusters[0].p40 = 0.9;
    });
}

#[test]
fn numeric_save_rejects_descending_p25_p40_before_publication() {
    assert_invalid_save_preserves_cache(|ontology| {
        ontology.clusters[0].p5 = 0.1;
        ontology.clusters[0].p25 = 0.9;
        ontology.clusters[0].p40 = 0.5;
    });
}

#[test]
fn numeric_save_rejects_nonfinite_similarity_mean_before_publication() {
    assert_invalid_save_preserves_cache(|ontology| ontology.clusters[0].sim_mean = f32::NAN);
}

#[test]
fn numeric_save_rejects_nonfinite_percentile_before_publication() {
    assert_invalid_save_preserves_cache(|ontology| ontology.clusters[0].p25 = f32::INFINITY);
}

#[test]
fn numeric_save_rejects_nonfinite_widening_before_publication() {
    assert_invalid_save_preserves_cache(|ontology| {
        ontology.clusters[0].override_widen = f32::INFINITY;
    });
}

#[test]
fn numeric_save_accepts_valid_nonunit_centroids_and_negative_percentiles() {
    let dir = tempfile::tempdir().unwrap();
    let mut ontology = good_ontology();
    for cluster in &mut ontology.clusters {
        for component in &mut cluster.centroid {
            *component *= 0.5;
        }
        cluster.sim_mean = -0.2;
        cluster.sim_std = 0.1;
        cluster.p5 = -0.8;
        cluster.p25 = -0.4;
        cluster.p40 = -0.1;
    }
    save(dir.path(), &ontology).unwrap();
    let loaded = load(dir.path(), &ontology.model).unwrap();
    assert_eq!(loaded.clusters[0].centroid, ontology.clusters[0].centroid);
    assert_eq!(loaded.clusters[0].p5, -0.8);
    assert_eq!(loaded.clusters[0].p25, -0.4);
    assert_eq!(loaded.clusters[0].p40, -0.1);
}

#[test]
fn numeric_save_accepts_equal_percentiles_and_zero_standard_deviation() {
    let dir = tempfile::tempdir().unwrap();
    let mut ontology = good_ontology();
    for cluster in &mut ontology.clusters {
        cluster.sim_std = 0.0;
        cluster.p5 = 0.2;
        cluster.p25 = 0.2;
        cluster.p40 = 0.2;
    }
    save(dir.path(), &ontology).unwrap();
    assert!(load(dir.path(), &ontology.model).is_some());
}

#[test]
fn numeric_save_keeps_an_empty_ontology_valid() {
    let dir = tempfile::tempdir().unwrap();
    let ontology = Ontology {
        model: "m".into(),
        embedding: None,
        source_signature: String::new(),
        built_at: 0,
        wiki_pages: 0,
        clusters: Vec::new(),
        entities: Vec::new(),
    };
    save(dir.path(), &ontology).unwrap();
    assert!(load(dir.path(), "m").is_some());
}

#[test]
fn numeric_invalid_save_does_not_create_a_cache_directory() {
    let dir = tempfile::tempdir().unwrap();
    let mut ontology = good_ontology();
    ontology.clusters[0].centroid.fill(0.0);
    assert!(save(dir.path(), &ontology).is_err());
    assert!(!crate::vault_dir::dir(dir.path()).exists());
}

#[test]
fn numeric_load_excludes_malformed_finite_cache_without_rewriting_it() {
    let changes: [fn(&mut Ontology); 5] = [
        |ontology| ontology.clusters[0].centroid.clear(),
        |ontology| ontology.clusters[1].centroid.truncate(2),
        |ontology| ontology.clusters[0].centroid.fill(0.0),
        |ontology| ontology.clusters[0].sim_std = -0.1,
        |ontology| ontology.clusters[0].p5 = 2.0,
    ];
    for change in changes {
        let dir = tempfile::tempdir().unwrap();
        let mut ontology = good_ontology();
        let cache_dir = crate::vault_dir::dir(dir.path());
        std::fs::create_dir_all(&cache_dir).unwrap();
        change(&mut ontology);
        let bytes = serde_json::to_vec(&ontology).unwrap();
        let path = cache_dir.join("ontology.json");
        std::fs::write(&path, &bytes).unwrap();
        assert!(load(dir.path(), &ontology.model).is_none());
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert!(!cache_dir.join(".ontology.json.tmp").exists());
    }
}

#[test]
fn numeric_ontology_respects_an_explicit_expected_width() {
    let ontology = good_ontology();
    assert!(ontology.validate_geometry(Some(3)).is_ok());
    assert!(ontology.validate_geometry(Some(2)).is_err());
    assert!(ontology.validate_geometry(Some(4)).is_err());
}

#[test]
fn numeric_mean_rejects_an_empty_group() {
    assert!(mean_renorm(&[]).is_err());
}

#[test]
fn numeric_mean_rejects_mismatched_member_widths() {
    let first = vec![1.0, 0.0];
    let shorter = vec![1.0];
    let longer = vec![1.0, 0.0, 0.0];
    assert!(mean_renorm(&[&first, &shorter]).is_err());
    assert!(mean_renorm(&[&first, &longer]).is_err());
}

#[test]
fn numeric_mean_rejects_exact_cancellation() {
    let first = vec![1.0, 0.0];
    let opposite = vec![-1.0, 0.0];
    assert!(mean_renorm(&[&first, &opposite]).is_err());
}

#[test]
fn numeric_mean_preserves_large_finite_direction() {
    let first = vec![f32::MAX, f32::MAX];
    let second = first.clone();
    let mean = mean_renorm(&[&first, &second]).unwrap();
    let expected = 1.0 / 2.0f32.sqrt();
    assert!((mean[0] - expected).abs() < 1e-6);
    assert!((mean[1] - expected).abs() < 1e-6);
    assert!((checked_vector_norm(&mean, Some(2)).unwrap() - 1.0).abs() < 1e-6);
}

#[test]
fn numeric_mean_preserves_subnormal_direction() {
    let small = f32::from_bits(1);
    let first = vec![small, 0.0];
    let second = vec![0.0, small];
    let mean = mean_renorm(&[&first, &second]).unwrap();
    let expected = 1.0 / 2.0f32.sqrt();
    assert!((mean[0] - expected).abs() < 1e-6);
    assert!((mean[1] - expected).abs() < 1e-6);
}

#[test]
fn numeric_mean_normalizes_a_single_valid_nonunit_member() {
    for first in [
        vec![0.5, 0.0],
        vec![f32::from_bits(1), 0.0],
        vec![f32::MAX, 0.0],
    ] {
        assert_eq!(mean_renorm(&[&first]).unwrap(), vec![1.0, 0.0]);
    }
}

#[test]
fn numeric_build_rejects_invalid_store_records() {
    let mut store = super::tests::six_pages();
    store.records[0].vector.fill(0.0);
    assert!(build(&store, &[], &[]).is_err());
}

#[test]
fn numeric_build_rejects_cancelled_page_centroid() {
    let mut store = super::tests::six_pages();
    let mut opposite = store.records[0].clone();
    opposite.id = "wiki/a.md#1".into();
    opposite.section = 1;
    for component in &mut opposite.vector {
        *component = -*component;
    }
    store.records.push(opposite);
    assert!(build(&store, &[], &[]).is_err());
}

#[test]
fn numeric_build_rejects_invalid_matching_and_unmatched_map_anchors() {
    let store = super::tests::six_pages();
    for label in ["a", "unused"] {
        for vector in [
            vec![],
            vec![1.0, 0.0],
            vec![0.0, 0.0, 0.0],
            vec![f32::NAN, 0.0, 0.0],
        ] {
            assert!(build(&store, &[], &[(label.into(), vector)]).is_err());
        }
    }
}

#[test]
fn numeric_admit_rejects_invalid_item_vectors() {
    let ontology = good_ontology();
    for vector in [
        vec![],
        vec![1.0, 0.0],
        vec![1.0, 0.0, 0.0, 0.0],
        vec![0.0, 0.0, 0.0],
        vec![f32::NAN, 0.0, 0.0],
        vec![f32::INFINITY, 0.0, 0.0],
    ] {
        assert!(admit(&ontology, &vector, "", &GatePreset::Normal, &[]).is_err());
    }
}

#[test]
fn numeric_admit_validates_all_clusters_before_a_verdict() {
    let mut ontology = good_ontology();
    let item = ontology.clusters[0].centroid.clone();
    ontology.clusters[1].sim_std = -0.1;
    assert!(admit(&ontology, &item, "", &GatePreset::Normal, &[]).is_err());
}

#[test]
fn numeric_admit_rejects_invalid_optional_profiles_at_its_boundary() {
    let ontology = good_ontology();
    let item = ontology.clusters[0].centroid.clone();
    for vector in [
        vec![],
        vec![1.0, 0.0],
        vec![0.0, 0.0, 0.0],
        vec![f32::NAN, 0.0, 0.0],
    ] {
        assert!(admit(&ontology, &item, "", &GatePreset::Normal, &[vector]).is_err());
    }
}

#[test]
fn numeric_admit_scores_valid_nonunit_and_extreme_finite_items() {
    let mut ontology = good_ontology();
    ontology.clusters.truncate(1);
    ontology.clusters[0].centroid = vec![0.5, 0.0, 0.0];
    for item in [
        vec![0.5, 0.0, 0.0],
        vec![f32::MAX, 0.0, 0.0],
        vec![f32::from_bits(1), 0.0, 0.0],
    ] {
        let verdict = admit(&ontology, &item, "", &GatePreset::Normal, &[]).unwrap();
        assert_eq!(verdict.tier, Tier::Full);
        assert!((verdict.s_knn - 1.0).abs() < 1e-6);
    }
}

#[test]
fn numeric_admit_keeps_an_empty_ontology_as_normal_no_ontology_reject() {
    let mut ontology = good_ontology();
    ontology.clusters.clear();
    let verdict = admit(&ontology, &[1.0, 0.0], "", &GatePreset::Normal, &[]).unwrap();
    assert_eq!(verdict.tier, Tier::Reject);
    assert!(verdict.reason.contains("no ontology yet"));
    assert!(admit(&ontology, &[], "", &GatePreset::Normal, &[]).is_err());
}

#[test]
fn numeric_admit_rejects_overflowing_extrapolated_thresholds() {
    let mut ontology = good_ontology();
    ontology.clusters.truncate(1);
    let item = ontology.clusters[0].centroid.clone();
    ontology.clusters[0].p5 = -f32::MAX;
    ontology.clusters[0].p25 = f32::MAX;
    ontology.clusters[0].p40 = f32::MAX;
    assert!(ontology.validate_geometry(None).is_ok());
    assert!(admit(&ontology, &item, "", &GatePreset::Loose, &[]).is_err());
}

#[test]
fn numeric_admit_rejects_overflowing_threshold_widening() {
    let mut ontology = good_ontology();
    ontology.clusters.truncate(1);
    let item = ontology.clusters[0].centroid.clone();
    ontology.clusters[0].p5 = -f32::MAX;
    ontology.clusters[0].p25 = -f32::MAX;
    ontology.clusters[0].p40 = -f32::MAX;
    ontology.clusters[0].override_widen = f32::MAX;
    assert!(ontology.validate_geometry(None).is_ok());
    assert!(admit(&ontology, &item, "", &GatePreset::Normal, &[]).is_err());
}

#[test]
fn numeric_admit_keeps_a_finite_threshold_midpoint_without_f32_sum_overflow() {
    let mut ontology = good_ontology();
    ontology.clusters.truncate(1);
    let item = ontology.clusters[0].centroid.clone();
    ontology.clusters[0].p5 = f32::MAX;
    ontology.clusters[0].p25 = f32::MAX;
    ontology.clusters[0].p40 = f32::MAX;
    let verdict = admit(&ontology, &item, "", &GatePreset::Normal, &[]).unwrap();
    assert_eq!(verdict.tier, Tier::Reject);
    assert!(verdict.s_knn.is_finite());
}
