//! Native cache-boundary witnesses for representation and source provenance.

use super::*;

fn labelled_store() -> VectorStore {
    let mut store = super::tests::six_pages();
    store.model = "builtin-local:synthetic-encoder".into();
    store.signature = "synthetic-policy-v1/artifact-epoch-a".into();
    store
}

fn current_cache(
    root: &Path,
    store: &VectorStore,
    titles: &[(String, String)],
    anchors: &[(String, Vec<f32>)],
) -> Option<Ontology> {
    load_for_store(root, store, titles, anchors).unwrap()
}

fn cache_path(root: &Path) -> std::path::PathBuf {
    crate::vault_dir::dir(root).join("ontology.json")
}

fn assert_stale_preserves_cache(
    mutate: impl FnOnce(&mut VectorStore, &mut Vec<(String, String)>, &mut Vec<(String, Vec<f32>)>),
) {
    let dir = tempfile::tempdir().unwrap();
    let mut store = labelled_store();
    let mut titles = vec![("a".into(), "Synthetic topic".into())];
    let mut anchors = Vec::new();
    let ontology = build(&store, &titles, &anchors).unwrap();
    save(dir.path(), &ontology).unwrap();
    let path = cache_path(dir.path());
    let before = std::fs::read(&path).unwrap();
    let before_mtime = std::fs::metadata(&path).unwrap().modified().unwrap();
    mutate(&mut store, &mut titles, &mut anchors);

    assert!(
        current_cache(dir.path(), &store, &titles, &anchors).is_none(),
        "a cache from incompatible geometry or changed sources must not be reusable"
    );
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert_eq!(
        std::fs::metadata(&path).unwrap().modified().unwrap(),
        before_mtime
    );
    assert!(!path.parent().unwrap().join(".ontology.json.tmp").exists());
}

#[test]
fn provenance_same_model_changed_signature_cache_is_stale() {
    assert_stale_preserves_cache(|store, _, _| {
        store.signature = "synthetic-policy-v2/artifact-epoch-b".into();
    });
}

#[test]
fn provenance_same_model_changed_width_cache_is_stale() {
    assert_stale_preserves_cache(|store, _, _| {
        store.dim += 1;
        for record in &mut store.records {
            record.vector.push(0.0);
        }
    });
}

#[test]
fn provenance_same_page_count_changed_member_hash_cache_is_stale() {
    assert_stale_preserves_cache(|store, _, _| {
        store.records[0].hash = 41;
    });
}

#[test]
fn provenance_same_page_count_changed_member_vector_cache_is_stale() {
    assert_stale_preserves_cache(|store, _, _| {
        store.records[0].vector = vec![0.0, 1.0, 0.0];
    });
}

#[test]
fn provenance_same_page_count_changed_titles_cache_is_stale() {
    assert_stale_preserves_cache(|_, titles, _| {
        titles[0].1 = "Another synthetic topic".into();
    });
}

#[test]
fn provenance_changed_map_anchor_cache_is_stale() {
    assert_stale_preserves_cache(|_, _, anchors| {
        anchors.push(("a".into(), vec![0.0, 1.0, 0.0]));
    });
}

#[test]
fn provenance_legacy_cache_without_representation_is_stale_without_rewrite() {
    let dir = tempfile::tempdir().unwrap();
    let store = labelled_store();
    let mut legacy = serde_json::to_value(build(&store, &[], &[]).unwrap()).unwrap();
    let object = legacy.as_object_mut().unwrap();
    object.remove("embedding");
    object.remove("source_signature");
    let path = cache_path(dir.path());
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let before = serde_json::to_vec(&legacy).unwrap();
    std::fs::write(&path, &before).unwrap();
    let before_mtime = std::fs::metadata(&path).unwrap().modified().unwrap();

    assert!(current_cache(dir.path(), &store, &[], &[]).is_none());
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert_eq!(
        std::fs::metadata(&path).unwrap().modified().unwrap(),
        before_mtime
    );
}

#[test]
fn provenance_late_stamped_dimension_mismatch_cannot_replace_good_cache() {
    let dir = tempfile::tempdir().unwrap();
    let store = labelled_store();
    let good = build(&store, &[], &[]).unwrap();
    save(dir.path(), &good).unwrap();
    let path = cache_path(dir.path());
    let before = std::fs::read(&path).unwrap();
    let before_mtime = std::fs::metadata(&path).unwrap().modified().unwrap();
    let mut payload = serde_json::to_value(&good).unwrap();
    payload["embedding"] = serde_json::json!({
        "model": store.model,
        "signature": store.signature,
        "dim": 4,
    });
    let invalid: Ontology = serde_json::from_value(payload).unwrap();

    assert!(
        save(dir.path(), &invalid).is_err(),
        "an embedding stamp must agree with every centroid before publication"
    );
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert_eq!(
        std::fs::metadata(&path).unwrap().modified().unwrap(),
        before_mtime
    );
    assert!(!path.parent().unwrap().join(".ontology.json.tmp").exists());
}

#[test]
fn provenance_fresh_cache_reuses_the_exact_declared_space_and_sources() {
    let dir = tempfile::tempdir().unwrap();
    let store = labelled_store();
    let titles = vec![("a".into(), "Synthetic topic".into())];
    let ontology = build(&store, &titles, &[]).unwrap();
    assert_eq!(ontology.embedding, Some(store.embedding_space().unwrap()));
    assert_eq!(ontology.source_signature.len(), 64);
    save(dir.path(), &ontology).unwrap();

    let loaded = load_for_store(dir.path(), &store, &titles, &[])
        .unwrap()
        .expect("an unchanged labelled cache remains reusable");
    assert_eq!(loaded.embedding, ontology.embedding);
    assert_eq!(loaded.source_signature, ontology.source_signature);
    assert_eq!(loaded.clusters[0].centroid, ontology.clusters[0].centroid);
    assert_eq!(loaded.clusters[0].members, ontology.clusters[0].members);
}

#[test]
fn provenance_same_sources_changed_model_cache_is_stale() {
    assert_stale_preserves_cache(|store, _, _| {
        store.model = "builtin-local:another-synthetic-encoder".into();
    });
}

#[test]
fn provenance_missing_cache_remains_absent_without_creating_directories() {
    let dir = tempfile::tempdir().unwrap();
    let store = labelled_store();
    assert!(load_for_store(dir.path(), &store, &[], &[])
        .unwrap()
        .is_none());
    assert!(!crate::vault_dir::dir(dir.path()).exists());
}

#[test]
fn provenance_corrupt_cache_returns_error_without_rewrite() {
    let dir = tempfile::tempdir().unwrap();
    let store = labelled_store();
    let path = cache_path(dir.path());
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let before = b"{\"model\":\"synthetic\",\"clusters\":";
    std::fs::write(&path, before).unwrap();
    let before_mtime = std::fs::metadata(&path).unwrap().modified().unwrap();

    assert!(load_for_store(dir.path(), &store, &[], &[]).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert_eq!(
        std::fs::metadata(&path).unwrap().modified().unwrap(),
        before_mtime
    );
    assert!(!path.parent().unwrap().join(".ontology.json.tmp").exists());
}

#[test]
fn provenance_cache_directory_is_error_instead_of_absence() {
    let dir = tempfile::tempdir().unwrap();
    let store = labelled_store();
    let path = cache_path(dir.path());
    std::fs::create_dir_all(&path).unwrap();
    assert!(load_for_store(dir.path(), &store, &[], &[]).is_err());
    assert!(path.is_dir());
}

#[cfg(unix)]
#[test]
fn provenance_symlink_cache_is_error_without_reading_or_overwriting_target() {
    let dir = tempfile::tempdir().unwrap();
    let target_dir = tempfile::tempdir().unwrap();
    let store = labelled_store();
    let target = target_dir.path().join("synthetic-cache.json");
    let before = b"synthetic outside target";
    std::fs::write(&target, before).unwrap();
    let path = cache_path(dir.path());
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(&target, &path).unwrap();

    assert!(load_for_store(dir.path(), &store, &[], &[]).is_err());
    assert_eq!(std::fs::read(&target).unwrap(), before);
    assert!(std::fs::symlink_metadata(&path)
        .unwrap()
        .file_type()
        .is_symlink());
}

#[test]
fn provenance_empty_ontology_still_rejects_a_changed_space() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = labelled_store();
    store.records.clear();
    let ontology = build(&store, &[], &[]).unwrap();
    assert!(ontology.clusters.is_empty());
    assert_eq!(ontology.embedding, Some(store.embedding_space().unwrap()));
    save(dir.path(), &ontology).unwrap();
    assert!(load_for_store(dir.path(), &store, &[], &[])
        .unwrap()
        .is_some());

    store.signature = "synthetic-policy-v2/artifact-epoch-b".into();
    assert!(load_for_store(dir.path(), &store, &[], &[])
        .unwrap()
        .is_none());
}

#[test]
fn provenance_unlabelled_geometry_is_not_promoted_to_cache_authority() {
    let dir = tempfile::tempdir().unwrap();
    let store = super::tests::six_pages();
    let ontology = build(&store, &[], &[]).unwrap();
    assert!(ontology.embedding.is_none());
    save(dir.path(), &ontology).unwrap();
    assert!(load_for_store(dir.path(), &store, &[], &[]).is_err());
    assert!(load_for_store(dir.path(), &labelled_store(), &[], &[])
        .unwrap()
        .is_none());
}

#[test]
fn provenance_declared_nonunit_source_vectors_keep_generic_geometry_valid() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = labelled_store();
    for record in &mut store.records {
        for component in &mut record.vector {
            *component *= 0.5;
        }
    }
    let ontology = build(&store, &[], &[]).unwrap();
    save(dir.path(), &ontology).unwrap();
    assert!(load_for_store(dir.path(), &store, &[], &[])
        .unwrap()
        .is_some());
}

#[test]
fn provenance_stamped_model_mismatch_cannot_create_a_cache_directory() {
    let dir = tempfile::tempdir().unwrap();
    let store = labelled_store();
    let mut ontology = build(&store, &[], &[]).unwrap();
    ontology.embedding.as_mut().unwrap().model = "builtin-local:another-synthetic-encoder".into();
    assert!(save(dir.path(), &ontology).is_err());
    assert!(!crate::vault_dir::dir(dir.path()).exists());
}

#[test]
fn provenance_invalid_expected_geometry_cannot_look_like_a_cache_miss() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = labelled_store();
    store.records.last_mut().unwrap().vector.clear();
    assert!(load_for_store(dir.path(), &store, &[], &[]).is_err());
    assert!(!crate::vault_dir::dir(dir.path()).exists());
}
