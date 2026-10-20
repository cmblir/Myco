//! Checked native cache admission witnesses; every index is synthetic and local.

use super::{
    decode_store_snapshot, read_store_snapshot, EdgeLookup, Record, VectorCache, VectorStore,
};
use std::path::Path;
use std::sync::Arc;

fn valid_store(model: &str) -> VectorStore {
    VectorStore {
        model: model.into(),
        signature: "synthetic-weights/pooling-v1".into(),
        dim: 2,
        records: vec![Record {
            id: "wiki/example.md#0".into(),
            page: "wiki/example.md".into(),
            stem: "example".into(),
            section: 0,
            hash: 1,
            vector: vec![1.0, 0.0],
        }],
    }
}

fn pair_bytes(store: &VectorStore, generation: u64) -> Vec<u8> {
    use sha2::{Digest, Sha256};
    let dense = store.encode();
    let lexical = crate::retrieval::Bm25Index::default().encode();
    let mut bytes = b"MXP1".to_vec();
    bytes.extend_from_slice(&generation.to_le_bytes());
    bytes.extend_from_slice(&(dense.len() as u64).to_le_bytes());
    bytes.extend_from_slice(&(lexical.len() as u64).to_le_bytes());
    bytes.extend_from_slice(&dense);
    bytes.extend_from_slice(&lexical);
    bytes.extend_from_slice(&Sha256::digest(&bytes));
    assert!(crate::index_publication::decode(&bytes).is_some());
    bytes
}

fn assert_file_unchanged(path: &Path, bytes: &[u8]) {
    assert_eq!(std::fs::read(path).unwrap(), bytes);
}

fn replace_same_stamp(path: &Path, bytes: &[u8]) {
    let metadata = std::fs::metadata(path).unwrap();
    let modified = metadata.modified().unwrap();
    assert_eq!(metadata.len(), bytes.len() as u64);
    std::fs::write(path, bytes).unwrap();
    std::fs::File::open(path)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(modified))
        .unwrap();
    let replaced = std::fs::metadata(path).unwrap();
    assert_eq!(replaced.len(), metadata.len());
    assert_eq!(replaced.modified().unwrap(), modified);
}

#[tokio::test]
async fn cache_admission_corrupt_binary_is_an_error_without_file_mutation() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("index.mxv");
    let bytes = b"MXV2 truncated payload";
    std::fs::write(&path, bytes).unwrap();
    let cache = VectorCache::default();
    assert!(cache.get_async(path.clone()).await.is_err());
    assert!(cache.lookup_edges(&path, 4).is_err());
    assert_file_unchanged(&path, bytes);
}

#[tokio::test]
async fn cache_admission_corrupt_binary_cannot_fall_back_to_valid_legacy_json() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("index.mxv");
    let legacy = path.with_extension("json");
    let bytes = b"invalid authoritative binary";
    let legacy_bytes = serde_json::to_vec(&valid_store("legacy-model")).unwrap();
    std::fs::write(&path, bytes).unwrap();
    std::fs::write(&legacy, &legacy_bytes).unwrap();
    let cache = VectorCache::default();
    assert!(cache.get_async(path.clone()).await.is_err());
    assert!(cache.lookup_edges(&path, 4).is_err());
    assert_file_unchanged(&path, bytes);
    assert_file_unchanged(&legacy, &legacy_bytes);
}

#[tokio::test]
async fn cache_admission_corrupt_legacy_json_is_an_error_without_file_mutation() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("index.mxv");
    let legacy = path.with_extension("json");
    let bytes = b"{\"model\": broken json";
    std::fs::write(&legacy, bytes).unwrap();
    let cache = VectorCache::default();
    assert!(cache.get_async(path.clone()).await.is_err());
    assert!(cache.lookup_edges(&path, 4).is_err());
    assert!(!path.exists());
    assert_file_unchanged(&legacy, bytes);
}

#[tokio::test]
async fn cache_admission_invalid_legacy_geometry_is_an_error() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("index.mxv");
    let legacy = path.with_extension("json");
    let mut invalid = valid_store("invalid-legacy");
    invalid.records[0].vector = vec![0.0, 0.0];
    let bytes = serde_json::to_vec(&invalid).unwrap();
    std::fs::write(&legacy, &bytes).unwrap();
    let cache = VectorCache::default();
    assert!(cache.get_async(path.clone()).await.is_err());
    assert!(cache.lookup_edges(&path, 4).is_err());
    assert_file_unchanged(&legacy, &bytes);
}

#[tokio::test]
async fn cache_admission_directory_cannot_be_mistaken_for_a_missing_index() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("index.mxv");
    std::fs::create_dir(&path).unwrap();
    let cache = VectorCache::default();
    assert!(cache.get_async(path.clone()).await.is_err());
    assert!(cache.lookup_edges(&path, 4).is_err());
    assert!(path.is_dir());
    assert_eq!(std::fs::read_dir(&path).unwrap().count(), 0);
}

#[tokio::test]
async fn cache_admission_parent_not_a_directory_is_a_read_error() {
    let directory = tempfile::tempdir().unwrap();
    let parent = directory.path().join("parent-file");
    let bytes = b"synthetic unrelated parent";
    std::fs::write(&parent, bytes).unwrap();
    let path = parent.join("index.mxv");
    let cache = VectorCache::default();
    assert!(cache.get_async(path.clone()).await.is_err());
    assert!(cache.lookup_edges(&path, 4).is_err());
    assert_file_unchanged(&parent, bytes);
}

#[cfg(unix)]
#[tokio::test]
async fn cache_admission_symlinks_to_valid_and_missing_files_are_errors() {
    let directory = tempfile::tempdir().unwrap();
    let target = directory.path().join("valid.mxv");
    valid_store("target-model").save(&target).unwrap();
    let before = std::fs::read(&target).unwrap();
    for (name, target) in [
        ("valid-link.mxv", target.clone()),
        ("broken-link.mxv", directory.path().join("missing.mxv")),
    ] {
        let path = directory.path().join(name);
        std::os::unix::fs::symlink(&target, &path).unwrap();
        let cache = VectorCache::default();
        assert!(cache.get_async(path.clone()).await.is_err(), "{name}");
        assert!(cache.lookup_edges(&path, 4).is_err(), "{name}");
        assert_eq!(std::fs::read_link(&path).unwrap(), target);
    }
    assert_file_unchanged(&target, &before);
}

#[cfg(unix)]
#[tokio::test]
async fn cache_admission_warm_unreadable_file_is_an_error_then_recovers() {
    use std::os::unix::fs::PermissionsExt;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("index.mxv");
    valid_store("permission-model").save(&path).unwrap();
    let cache = VectorCache::default();
    let first = cache.get_async(path.clone()).await.unwrap();
    let metadata = std::fs::metadata(&path).unwrap();
    let before = std::fs::read(&path).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o0)).unwrap();
    let read_is_denied = std::fs::read(&path).is_err();
    let loaded = cache.get_async(path.clone()).await;
    let edges = cache.lookup_edges(&path, 4);
    std::fs::set_permissions(&path, metadata.permissions()).unwrap();
    assert!(read_is_denied, "test requires an unprivileged file reader");
    assert!(loaded.is_err(), "warm cache hid an existing read failure");
    assert!(edges.is_err(), "edge lookup hid an existing read failure");
    let recovered = cache.get_async(path.clone()).await.unwrap();
    assert!(Arc::ptr_eq(&first, &recovered));
    assert_file_unchanged(&path, &before);
}

#[tokio::test]
async fn cache_admission_missing_and_valid_empty_indexes_remain_distinct() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("index.mxv");
    let cache = VectorCache::default();
    let first = cache.get_async(path.clone()).await.unwrap();
    let second = cache.get_async(path.clone()).await.unwrap();
    assert!(first.records.is_empty());
    assert!(
        !Arc::ptr_eq(&first, &second),
        "missing stores stay uncached"
    );
    assert!(matches!(
        cache.lookup_edges(&path, 4).unwrap(),
        EdgeLookup::Empty
    ));
    VectorStore::default().save(&path).unwrap();
    let first = cache.get_async(path.clone()).await.unwrap();
    let second = cache.get_async(path.clone()).await.unwrap();
    assert!(first.records.is_empty());
    assert!(
        Arc::ptr_eq(&first, &second),
        "valid empty stores are cached"
    );
    let EdgeLookup::Compute(work) = cache.lookup_edges(&path, 4).unwrap() else {
        panic!("valid empty index must keep an existing revision");
    };
    assert!(work.compute().unwrap().0.is_empty());
}

#[tokio::test]
async fn cache_admission_valid_legacy_json_is_cached_and_binary_supersedes_it() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("index.mxv");
    let legacy = path.with_extension("json");
    let bytes = serde_json::to_vec(&valid_store("legacy-model")).unwrap();
    std::fs::write(&legacy, &bytes).unwrap();
    let cache = VectorCache::default();
    let first = cache.get_async(path.clone()).await.unwrap();
    let second = cache.get_async(path.clone()).await.unwrap();
    assert_eq!(first.model, "legacy-model");
    assert!(Arc::ptr_eq(&first, &second));
    assert_file_unchanged(&legacy, &bytes);
    valid_store("binary-model").save(&path).unwrap();
    let binary = cache.get_async(path.clone()).await.unwrap();
    assert_eq!(binary.model, "binary-model");
    assert!(!Arc::ptr_eq(&first, &binary));
}

#[tokio::test]
async fn cache_admission_warm_cache_rejects_corruption_and_recovers_on_valid_revision() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("index.mxv");
    valid_store("initial-model").save(&path).unwrap();
    let cache = VectorCache::default();
    let first = cache.get_async(path.clone()).await.unwrap();
    let bytes = b"corrupt replacement differs in length";
    std::fs::write(&path, bytes).unwrap();
    assert!(cache.get_async(path.clone()).await.is_err());
    assert!(cache.get_async(path.clone()).await.is_err());
    assert!(cache.lookup_edges(&path, 4).is_err());
    assert_file_unchanged(&path, bytes);
    valid_store("recovered-model").save(&path).unwrap();
    let recovered = cache.get_async(path.clone()).await.unwrap();
    assert_eq!(recovered.model, "recovered-model");
    assert!(!Arc::ptr_eq(&first, &recovered));
}

#[tokio::test]
async fn cache_admission_invalid_pair_generation_header_is_an_error() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("index.mxp");
    for bytes in [b"MXP1".as_slice(), b"BAD!12345678".as_slice()] {
        std::fs::write(&path, bytes).unwrap();
        let cache = VectorCache::default();
        assert!(cache.get_async(path.clone()).await.is_err());
        assert!(cache.lookup_edges(&path, 4).is_err());
        assert_file_unchanged(&path, bytes);
    }
}

#[tokio::test]
async fn cache_admission_corrupt_pair_checksum_is_an_error() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("index.mxp");
    let mut bytes = pair_bytes(&valid_store("pair-model"), 1);
    *bytes.last_mut().unwrap() ^= 1;
    std::fs::write(&path, &bytes).unwrap();
    let cache = VectorCache::default();
    assert!(cache.get_async(path.clone()).await.is_err());
    assert!(cache.lookup_edges(&path, 4).is_err());
    assert_file_unchanged(&path, &bytes);
}

#[tokio::test]
async fn cache_admission_pair_generation_expires_same_size_same_mtime_revision() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("index.mxp");
    let initial = pair_bytes(&valid_store("first-model"), 11);
    let replacement = pair_bytes(&valid_store("later-model"), 12);
    assert_eq!(initial.len(), replacement.len());
    std::fs::write(&path, initial).unwrap();
    let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
    let cache = VectorCache::default();
    let first = cache.get_async(path.clone()).await.unwrap();
    std::fs::write(&path, replacement).unwrap();
    std::fs::File::open(&path)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(modified))
        .unwrap();
    assert_eq!(
        std::fs::metadata(&path).unwrap().modified().unwrap(),
        modified
    );
    let replaced = cache.get_async(path.clone()).await.unwrap();
    assert_eq!(first.model, "first-model");
    assert_eq!(replaced.model, "later-model");
    assert!(!Arc::ptr_eq(&first, &replaced));
}

#[tokio::test]
async fn cache_admission_invalid_put_cannot_replace_valid_cached_geometry() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("index.mxv");
    let valid = valid_store("valid-model");
    valid.save(&path).unwrap();
    let before = std::fs::read(&path).unwrap();
    for vector in [
        vec![],
        vec![1.0],
        vec![0.0, 0.0],
        vec![f32::NAN, 1.0],
        vec![f32::INFINITY, 1.0],
    ] {
        let cache = VectorCache::default();
        let first = cache.get_async(path.clone()).await.unwrap();
        let mut invalid = valid_store("invalid-model");
        invalid.records[0].vector = vector;
        assert!(cache.put(&path, invalid).is_err());
        let after = cache.get_async(path.clone()).await.unwrap();
        assert_eq!(after.encode(), valid.encode());
        assert!(Arc::ptr_eq(&first, &after));
        assert_file_unchanged(&path, &before);
    }
}

#[tokio::test]
async fn cache_admission_valid_put_must_match_the_current_persisted_store() {
    let directory = tempfile::tempdir().unwrap();
    for extension in ["mxv", "mxp"] {
        let path = directory.path().join(format!("index.{extension}"));
        let valid = valid_store("persisted-model");
        if extension == "mxp" {
            std::fs::write(&path, pair_bytes(&valid, 7)).unwrap();
        } else {
            valid.save(&path).unwrap();
        }
        let before = std::fs::read(&path).unwrap();
        for change in 0..4 {
            let cache = VectorCache::default();
            let first = cache.get_async(path.clone()).await.unwrap();
            let mut different = valid_store("persisted-model");
            match change {
                0 => different.model = "different-model".into(),
                1 => different.signature = "different-weights/pooling-v1".into(),
                2 => different.records[0].vector = vec![0.0, 1.0],
                _ => different.records[0].hash = 99,
            }
            assert!(cache.put(&path, different).is_err());
            let after = cache.get_async(path.clone()).await.unwrap();
            assert_eq!(
                after.encode(),
                valid.encode(),
                "{extension}, change={change}"
            );
            assert!(Arc::ptr_eq(&first, &after), "{extension}, change={change}");
            assert_file_unchanged(&path, &before);
        }
    }
}

#[test]
fn cache_admission_embedding_space_requires_complete_identity_and_all_geometry() {
    let valid = valid_store("complete-model");
    let space = valid.embedding_space().unwrap();
    assert_eq!(space.model, valid.model);
    assert_eq!(space.signature, valid.signature);
    assert_eq!(space.dim, valid.dim);
    for invalid_identity in 0..4 {
        let mut store = valid_store("complete-model");
        match invalid_identity {
            0 => store.model.clear(),
            1 => store.model = " \t".into(),
            2 => store.signature.clear(),
            _ => store.signature = " \n".into(),
        }
        assert!(store.embedding_space().is_err());
    }
    assert!(VectorStore::default().embedding_space().is_err());
    for vector in [
        vec![0.0, 0.0],
        vec![1.0],
        vec![f32::NAN, 1.0],
        vec![f32::INFINITY, 1.0],
    ] {
        let mut store = valid_store("complete-model");
        let mut late = store.records[0].clone();
        late.id = "wiki/late.md#0".into();
        late.page = "wiki/late.md".into();
        late.vector = vector;
        store.records.push(late);
        assert!(store.embedding_space().is_err());
    }
    let mut finite_nonunit = valid_store("complete-model");
    finite_nonunit.records[0].vector = vec![f32::MAX, 0.0];
    assert_eq!(finite_nonunit.embedding_space().unwrap(), space);
}

#[tokio::test]
async fn cache_admission_put_requires_existing_valid_published_bytes() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("index.mxv");
    let cache = VectorCache::default();
    assert!(cache.put(&path, valid_store("model")).is_err());
    assert!(!path.exists());
    valid_store("model").save(&path).unwrap();
    let first = cache.get_async(path.clone()).await.unwrap();
    let bytes = b"corrupt publication";
    std::fs::write(&path, bytes).unwrap();
    assert!(cache.put(&path, valid_store("model")).is_err());
    assert!(cache.get(&path).is_err());
    assert!(cache.get_async(path.clone()).await.is_err());
    assert!(cache.lookup_edges(&path, 4).is_err());
    assert_file_unchanged(&path, bytes);
    valid_store("model").save(&path).unwrap();
    let recovered = cache.get_async(path.clone()).await.unwrap();
    assert_eq!(recovered.encode(), first.encode());
}

#[cfg(unix)]
#[tokio::test]
async fn cache_admission_legacy_symlink_cannot_be_read_or_adopted() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("index.mxv");
    let target = directory.path().join("target.json");
    let bytes = serde_json::to_vec(&valid_store("legacy-model")).unwrap();
    std::fs::write(&target, &bytes).unwrap();
    std::os::unix::fs::symlink(&target, path.with_extension("json")).unwrap();
    let cache = VectorCache::default();
    assert!(cache.get(&path).is_err());
    assert!(cache.get_async(path.clone()).await.is_err());
    assert!(cache.lookup_edges(&path, 4).is_err());
    assert!(cache.put(&path, valid_store("legacy-model")).is_err());
    assert_file_unchanged(&target, &bytes);
}

#[test]
fn cache_admission_warm_same_stamp_binary_reads_new_content() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("index.mxv");
    let initial = valid_store("same-model");
    initial.save(&path).unwrap();
    let metadata = std::fs::metadata(&path).unwrap();
    let modified = metadata.modified().unwrap();
    let cache = VectorCache::default();
    let first = cache.get(&path).unwrap();
    assert_eq!(first.search(&[1.0, 0.0], 1).unwrap()[0].score, 1.0);

    let mut replacement = valid_store("same-model");
    replacement.records[0].vector = vec![0.0, 1.0];
    assert_eq!(initial.encode().len(), replacement.encode().len());
    replacement.save(&path).unwrap();
    std::fs::File::open(&path)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(modified))
        .unwrap();
    let replaced_metadata = std::fs::metadata(&path).unwrap();
    assert_eq!(replaced_metadata.len(), metadata.len());
    assert_eq!(replaced_metadata.modified().unwrap(), modified);

    let current = cache.get(&path).unwrap();
    assert_eq!(current.search(&[1.0, 0.0], 1).unwrap()[0].score, 0.0);
    assert_eq!(current.records[0].vector, vec![0.0, 1.0]);
    assert!(!Arc::ptr_eq(&first, &current));
    assert_file_unchanged(&path, &replacement.encode());
}

#[test]
fn cache_admission_warm_same_stamp_legacy_json_reads_new_content() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("index.mxv");
    let legacy = path.with_extension("json");
    let initial = valid_store("same-model");
    std::fs::write(&legacy, serde_json::to_vec(&initial).unwrap()).unwrap();
    let cache = VectorCache::default();
    let first = cache.get(&path).unwrap();
    assert_eq!(first.search(&[1.0, 0.0], 1).unwrap()[0].score, 1.0);
    let mut replacement = valid_store("same-model");
    replacement.records[0].vector = vec![0.0, 1.0];
    let bytes = serde_json::to_vec(&replacement).unwrap();
    replace_same_stamp(&legacy, &bytes);
    let current = cache.get(&path).unwrap();
    assert_eq!(current.search(&[1.0, 0.0], 1).unwrap()[0].score, 0.0);
    assert!(!Arc::ptr_eq(&first, &current));
    assert!(!path.exists());
    assert_file_unchanged(&legacy, &bytes);
}

#[test]
fn cache_admission_warm_same_stamp_corruption_cannot_use_legacy_fallback() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("index.mxv");
    let initial = valid_store("same-model");
    initial.save(&path).unwrap();
    let bytes = initial.encode();
    let cache = VectorCache::default();
    let first = cache.get(&path).unwrap();
    let legacy = path.with_extension("json");
    let legacy_bytes = serde_json::to_vec(&valid_store("other-model")).unwrap();
    std::fs::write(&legacy, &legacy_bytes).unwrap();
    let mut corrupt = bytes.clone();
    corrupt[0] ^= 1;
    replace_same_stamp(&path, &corrupt);
    assert!(cache.get(&path).is_err());
    assert!(cache.lookup_edges(&path, 4).is_err());
    assert_file_unchanged(&path, &corrupt);
    assert_file_unchanged(&legacy, &legacy_bytes);
    replace_same_stamp(&path, &bytes);
    assert!(Arc::ptr_eq(&first, &cache.get(&path).unwrap()));
}

#[test]
fn cache_admission_warm_same_generation_pair_reads_content_and_checksum() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("index.mxp");
    let initial = valid_store("same-model");
    std::fs::write(&path, pair_bytes(&initial, 7)).unwrap();
    let cache = VectorCache::default();
    let first = cache.get(&path).unwrap();
    let mut replacement = valid_store("same-model");
    replacement.records[0].vector = vec![0.0, 1.0];
    let mut bytes = pair_bytes(&replacement, 7);
    replace_same_stamp(&path, &bytes);
    let current = cache.get(&path).unwrap();
    assert_eq!(current.search(&[1.0, 0.0], 1).unwrap()[0].score, 0.0);
    assert!(!Arc::ptr_eq(&first, &current));
    *bytes.last_mut().unwrap() ^= 1;
    replace_same_stamp(&path, &bytes);
    assert!(cache.get(&path).is_err());
    assert!(cache.lookup_edges(&path, 4).is_err());
    assert_file_unchanged(&path, &bytes);
}

#[test]
fn cache_admission_same_stamp_geometry_keeps_old_edge_work_out_of_new_revision() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("index.mxv");
    let mut initial = valid_store("same-model");
    let mut other = initial.records[0].clone();
    other.page = "wiki/another.md".into();
    other.id = "wiki/another.md#0".into();
    other.stem = "another".into();
    other.vector = vec![0.0, 1.0];
    initial.records.push(other);
    initial.save(&path).unwrap();
    let cache = VectorCache::default();
    let EdgeLookup::Compute(old_work) = cache.lookup_edges(&path, 1).unwrap() else {
        panic!("initial edge revision must be cold");
    };
    initial.records[1].vector = vec![1.0, 0.0];
    replace_same_stamp(&path, &initial.encode());
    let EdgeLookup::Compute(new_work) = cache.lookup_edges(&path, 1).unwrap() else {
        panic!("same-stamp content change must create new edge work");
    };
    let (old_edges, _) = old_work.compute().unwrap();
    let (new_edges, _) = new_work.compute().unwrap();
    assert_eq!(old_edges[0].score, 0.0);
    assert_eq!(new_edges[0].score, 1.0);
    let EdgeLookup::Ready(current) = cache.lookup_edges(&path, 1).unwrap() else {
        panic!("current revision must use its completed edge work");
    };
    assert!(Arc::ptr_eq(&current, &new_edges));
    assert!(!Arc::ptr_eq(&current, &old_edges));
}

#[test]
fn cache_admission_decoder_uses_captured_bytes_after_path_replacement() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("index.mxv");
    let initial = valid_store("same-model");
    initial.save(&path).unwrap();
    let (revision, bytes) = read_store_snapshot(&path).unwrap().unwrap();
    let mut replacement = valid_store("same-model");
    replacement.records[0].vector = vec![0.0, 1.0];
    replace_same_stamp(&path, &replacement.encode());
    let captured = decode_store_snapshot(&path, &revision, &bytes).unwrap();
    assert_eq!(captured.search(&[1.0, 0.0], 1).unwrap()[0].score, 1.0);
    let current = VectorCache::default().get(&path).unwrap();
    assert_eq!(current.search(&[1.0, 0.0], 1).unwrap()[0].score, 0.0);
}
