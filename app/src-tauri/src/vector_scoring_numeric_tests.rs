//! Native scoring witnesses for valid finite nonunit vector geometry.

use super::{Record, VectorStore};

fn store(vectors: &[(&str, Vec<f32>)]) -> VectorStore {
    let mut store = VectorStore::default();
    for (page, vector) in vectors {
        store.dim = vector.len();
        store.records.push(Record {
            id: format!("{page}#{}", store.records.len()),
            page: (*page).into(),
            stem: (*page).into(),
            section: store.records.len(),
            hash: 0,
            vector: vector.clone(),
        });
    }
    store
}

#[test]
fn numeric_cosine_retains_large_parallel_direction() {
    let vector = [f32::MAX, f32::MAX];
    let score = crate::embeddings::cosine(&vector, &vector);
    assert!(score.is_finite(), "valid cosine must be finite: {score}");
    assert!((score - 1.0).abs() < 1e-6, "parallel cosine: {score}");
}

#[test]
fn numeric_cosine_retains_subnormal_parallel_direction() {
    let vector = [f32::from_bits(1), f32::from_bits(2)];
    let score = crate::embeddings::cosine(&vector, &vector);
    assert!(score.is_finite());
    assert!((score - 1.0).abs() < 1e-6, "parallel cosine: {score}");
}

#[test]
fn numeric_cosine_retains_antipodal_large_direction() {
    let vector = [f32::MAX, f32::MAX];
    let opposite = [-f32::MAX, -f32::MAX];
    let score = crate::embeddings::cosine(&vector, &opposite);
    assert!(score.is_finite(), "valid cosine must be finite: {score}");
    assert!((score + 1.0).abs() < 1e-6, "antipodal cosine: {score}");
}

#[test]
fn numeric_dense_search_ranks_valid_large_nonunit_vectors() {
    let store = store(&[
        ("wiki/orthogonal.md", vec![0.0, f32::MAX]),
        ("wiki/parallel.md", vec![f32::MAX, 0.0]),
    ]);
    let hits = store.search(&[f32::MAX, 0.0], 2).unwrap();
    assert!(hits.iter().all(|hit| hit.score.is_finite()));
    assert_eq!(hits[0].page, "wiki/parallel.md");
    assert!((hits[0].score - 1.0).abs() < 1e-6);
    assert!(hits[1].score.abs() < 1e-6);
}

#[test]
fn numeric_related_retains_negative_similarity() {
    let store = store(&[
        ("wiki/seed.md", vec![1.0, 0.0]),
        ("wiki/opposite.md", vec![-1.0, 0.0]),
    ]);
    let hits = store.related("wiki/seed.md", 2).unwrap();
    assert_eq!(hits.len(), 1);
    assert!((hits[0].score + 1.0).abs() < 1e-6);
}

#[test]
fn numeric_page_mean_retains_large_direction_without_overflow() {
    let store = store(&[
        ("wiki/large.md", vec![f32::MAX, f32::MAX]),
        ("wiki/large.md", vec![f32::MAX, f32::MAX]),
    ]);
    let centroids = store.page_centroids().unwrap();
    assert_eq!(centroids.len(), 1);
    let vector = &centroids[0].1;
    let norm = vector
        .iter()
        .map(|v| f64::from(*v).powi(2))
        .sum::<f64>()
        .sqrt();
    assert!(vector.iter().all(|v| v.is_finite()));
    assert!((norm - 1.0).abs() < 1e-6, "centroid norm: {norm}");
    assert!((vector[0] - std::f32::consts::FRAC_1_SQRT_2).abs() < 1e-6);
    assert!((vector[1] - vector[0]).abs() < 1e-6);
}

#[test]
fn numeric_page_mean_retains_subnormal_direction() {
    let store = store(&[
        ("wiki/small.md", vec![f32::from_bits(1), 0.0]),
        ("wiki/small.md", vec![0.0, f32::from_bits(1)]),
    ]);
    let centroids = store.page_centroids().unwrap();
    assert_eq!(centroids.len(), 1);
    let vector = &centroids[0].1;
    assert!((vector[0] - std::f32::consts::FRAC_1_SQRT_2).abs() < 1e-6);
    assert!((vector[1] - vector[0]).abs() < 1e-6);
}

#[test]
fn numeric_checked_cosine_rejects_invalid_geometry() {
    for vector in [
        vec![],
        vec![0.0, 0.0],
        vec![1.0],
        vec![1.0, 0.0, 0.0],
        vec![f32::NAN, 0.0],
        vec![f32::INFINITY, 0.0],
    ] {
        assert!(crate::embeddings::checked_cosine(&[1.0, 0.0], &vector).is_err());
        assert!(crate::embeddings::checked_cosine(&vector, &[1.0, 0.0]).is_err());
    }
}

#[test]
fn numeric_semantic_readers_reject_a_malformed_late_record_without_store_changes() {
    for vector in [
        vec![],
        vec![0.0, 0.0],
        vec![1.0],
        vec![1.0, 0.0, 0.0],
        vec![f32::NAN, 0.0],
        vec![f32::INFINITY, 0.0],
    ] {
        let mut store = store(&[("wiki/good.md", vec![1.0, 0.0])]);
        store.records.push(Record {
            id: "wiki/bad.md#0".into(),
            page: "wiki/bad.md".into(),
            stem: "bad".into(),
            section: 0,
            hash: 0,
            vector,
        });
        let before = store.encode();
        assert!(store.search(&[1.0, 0.0], 1).is_err());
        assert!(store.search(&[1.0, 0.0], 0).is_err());
        assert!(store.related("wiki/good.md", 1).is_err());
        assert!(store.related("wiki/missing.md", 1).is_err());
        assert!(store.page_centroids().is_err());
        assert!(store.centroid_edges(1).is_err());
        assert!(store.centroid_edges(0).is_err());
        assert_eq!(store.encode(), before);
    }
}

#[test]
fn numeric_search_refuses_an_invalid_query_even_without_records() {
    for vector in [vec![], vec![0.0, 0.0], vec![f32::NAN, 0.0]] {
        assert!(VectorStore::default().search(&vector, 0).is_err());
    }
    assert!(store(&[("wiki/good.md", vec![1.0, 0.0])])
        .search(&[1.0], 1)
        .is_err());
    assert!(VectorStore::default()
        .search(&[1.0, 0.0], 1)
        .unwrap()
        .is_empty());
}

#[test]
fn numeric_page_mean_preserves_raw_nonunit_weights() {
    let store = store(&[
        ("wiki/weighted.md", vec![100.0, 0.0]),
        ("wiki/weighted.md", vec![0.0, 1.0]),
    ]);
    let centroids = store.page_centroids().unwrap();
    assert!((centroids[0].1[0] / centroids[0].1[1] - 100.0).abs() < 1e-4);
}

#[test]
fn numeric_antipodal_page_cancellation_is_unavailable_not_a_zero_centroid() {
    let store = store(&[
        ("wiki/cancel.md", vec![1.0, 0.0]),
        ("wiki/cancel.md", vec![-1.0, 0.0]),
        ("wiki/good.md", vec![0.0, 1.0]),
    ]);
    let before = store.encode();
    assert!(store.page_centroids().is_err());
    assert!(store.centroid_edges(4).is_err());
    assert_eq!(store.encode(), before);
    // Individual valid chunks are still searchable; aggregation failure is
    // not a reason to erase their original geometry or the persisted store.
    assert_eq!(store.search(&[1.0, 0.0], 3).unwrap()[0].score, 1.0);
}

#[test]
fn numeric_edge_cache_retains_failure_until_a_checked_new_revision() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("index.mxv");
    let invalid_aggregate = store(&[
        ("wiki/cancel.md", vec![1.0, 0.0]),
        ("wiki/cancel.md", vec![-1.0, 0.0]),
    ]);
    invalid_aggregate.save(&path).unwrap();
    let before = std::fs::read(&path).unwrap();
    let cache = super::VectorCache::default();
    let super::EdgeLookup::Compute(work) = cache.lookup_edges(&path, 4).unwrap() else {
        panic!("expected a cold revision");
    };
    assert!(work.compute().is_err());
    assert!(cache.lookup_edges(&path, 4).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), before);
    let good = store(&[("wiki/a.md", vec![1.0, 0.0]), ("wiki/b.md", vec![0.0, 1.0])]);
    good.save(&path).unwrap();
    let super::EdgeLookup::Compute(work) = cache.lookup_edges(&path, 4).unwrap() else {
        panic!("new revision must not reuse a failed cell");
    };
    assert_eq!(work.compute().unwrap().0.len(), 1);
}

#[test]
fn numeric_compensated_page_mean_keeps_a_small_nonzero_residual() {
    let store = store(&[
        ("wiki/residual.md", vec![f32::MAX, 1.0]),
        ("wiki/residual.md", vec![1.0, 0.0]),
        ("wiki/residual.md", vec![-f32::MAX, -1.0]),
    ]);
    let before = store.encode();
    let centroids = store.page_centroids().unwrap();
    assert_eq!(centroids[0].1, vec![1.0, 0.0]);
    assert_eq!(store.encode(), before);
}

#[test]
fn numeric_compensated_page_mean_keeps_a_unit_vector_subnormal_residual() {
    let tiny = f32::from_bits(1);
    let store = store(&[
        ("wiki/residual.md", vec![1.0, tiny]),
        ("wiki/residual.md", vec![tiny, 1.0]),
        ("wiki/residual.md", vec![-1.0, -tiny]),
        ("wiki/residual.md", vec![0.0, -1.0]),
    ]);
    let centroids = store.page_centroids().unwrap();
    assert_eq!(centroids[0].1, vec![1.0, 0.0]);
}

#[test]
fn numeric_compensated_window_mean_keeps_a_small_nonzero_residual() {
    let output = crate::embeddings::combine_window_vectors(
        &[vec![f32::MAX, 1.0], vec![1.0, 0.0], vec![-f32::MAX, -1.0]],
        &[1, 1, 1],
    )
    .unwrap();
    assert_eq!(output, vec![1.0, 0.0]);
}

#[test]
fn numeric_compensated_cosine_keeps_a_representable_cancelled_dot_residual() {
    let max = f32::MAX;
    let score = crate::embeddings::checked_cosine(&[max, 1.0, max], &[1.0, 1.0, -1.0]).unwrap();
    let expected = 1.0 / (f64::from(max) * 2.0f64.sqrt() * 3.0f64.sqrt());
    assert!(score > 0.0, "nonzero residual became an orthogonal score");
    assert!((f64::from(score) / expected - 1.0).abs() < 1e-5);
}
