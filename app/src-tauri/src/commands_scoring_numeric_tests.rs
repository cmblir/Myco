//! Native command-core regressions for unavailable semantic geometry.

use super::*;

fn indexed_fixture(root: &std::path::Path) -> (VectorStore, crate::retrieval::Bm25Index) {
    let page = "wiki/synthetic.md";
    let body = "# Synthetic\n\nSynthetic retrieval boundary evidence.";
    std::fs::create_dir_all(root.join("wiki")).unwrap();
    std::fs::write(root.join(page), body).unwrap();
    let chunks = embeddings::chunk_page(body);
    let mut store = VectorStore::default();
    store
        .upsert_page(
            page,
            "synthetic",
            chunks
                .iter()
                .map(|chunk| (embeddings::content_hash(chunk), vec![1.0, 0.0]))
                .collect(),
        )
        .unwrap();
    let mut lexical = crate::retrieval::Bm25Index::new();
    lexical.upsert_page(page, "synthetic", &chunks);
    (store, lexical)
}

#[test]
fn numeric_hybrid_refuses_invalid_queries_instead_of_returning_lexical_success() {
    let directory = tempfile::tempdir().unwrap();
    let (store, lexical) = indexed_fixture(directory.path());
    for query in [vec![], vec![0.0, 0.0], vec![1.0], vec![f32::NAN, 0.0]] {
        assert!(rank_hybrid(
            directory.path(),
            &store,
            Some(&query),
            &lexical,
            "Synthetic",
            5,
            None,
            crate::retrieval::Scope::All,
            None,
            &crate::retrieval::TierWeights::FLAT
        )
        .is_err());
    }
    let lexical_only = rank_hybrid(
        directory.path(),
        &VectorStore::default(),
        None,
        &lexical,
        "Synthetic",
        5,
        None,
        crate::retrieval::Scope::All,
        None,
        &crate::retrieval::TierWeights::FLAT,
    )
    .unwrap();
    assert_eq!(lexical_only[0].page, "wiki/synthetic.md");
    assert_eq!(lexical_only[0].similarity, None);
}

#[test]
fn numeric_hybrid_refuses_a_bad_late_record_before_scope_or_pool_cuts() {
    let directory = tempfile::tempdir().unwrap();
    let (mut store, lexical) = indexed_fixture(directory.path());
    store.records.push(crate::vector_index::Record {
        id: "sessions/synthetic.md#0".into(),
        page: "sessions/synthetic.md".into(),
        stem: "synthetic-session".into(),
        section: 0,
        hash: 1,
        vector: vec![0.0, 0.0],
    });
    let before = store.encode();
    assert!(rank_hybrid(
        directory.path(),
        &store,
        Some(&[1.0, 0.0]),
        &lexical,
        "Synthetic",
        1,
        None,
        crate::retrieval::Scope::Wiki,
        None,
        &crate::retrieval::TierWeights::FLAT
    )
    .is_err());
    assert_eq!(store.encode(), before);
}

#[test]
fn numeric_resurface_refuses_invalid_seed_and_late_geometry() {
    let directory = tempfile::tempdir().unwrap();
    let (mut store, _) = indexed_fixture(directory.path());
    let opens = std::collections::HashMap::new();
    let mtimes = std::collections::HashMap::from([("wiki/synthetic.md".into(), 0)]);
    let text = |_: &str, _: usize| Some("synthetic text".into());
    assert!(resurface_core(&store, &[0.0, 0.0], &opens, &mtimes, 100, 1, 0.0, 1, &text).is_err());
    assert!(resurface_core(&store, &[1.0], &opens, &mtimes, 100, 1, 0.0, 1, &text).is_err());
    assert!(resurface_core(
        &store,
        &[1.0, 0.0],
        &opens,
        &mtimes,
        100,
        1,
        f32::NAN,
        1,
        &text
    )
    .is_err());
    store.records[0].vector = vec![f32::INFINITY, 0.0];
    let before = store.encode();
    assert!(resurface_core(&store, &[1.0, 0.0], &opens, &mtimes, 100, 1, 0.0, 1, &text).is_err());
    assert_eq!(store.encode(), before);
}

#[test]
fn numeric_harvest_checks_complete_batch_before_assigning_any_clusters() {
    let directory = tempfile::tempdir().unwrap();
    let (store, _) = indexed_fixture(directory.path());
    for (vectors, expected) in [
        (vec![vec![1.0, 0.0]], 2),
        (vec![vec![1.0, 0.0]; 2], 1),
        (vec![vec![1.0, 0.0], vec![0.0, 0.0]], 2),
        (vec![vec![1.0, 0.0], vec![1.0]], 2),
        (vec![vec![1.0, 0.0], vec![2.0, 0.0]], 2),
    ] {
        assert!(harvest_clusters(&store, &vectors, expected).is_err());
    }
    let good = harvest_clusters(&store, &[vec![1.0, 0.0], vec![1.0, 0.0]], 2).unwrap();
    assert_eq!(good.len(), 2);
    assert!(good
        .iter()
        .all(|cluster| cluster.as_ref().unwrap().page == "wiki/synthetic.md"));
}
