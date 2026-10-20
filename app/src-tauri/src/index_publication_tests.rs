use super::*;

fn fixture(generation: u64, word: &str) -> IndexPair {
    let mut store = VectorStore::default();
    store.ensure_signature("synthetic-local-model", "synthetic-signature");
    store
        .upsert_page(
            "wiki/synthetic.md",
            "synthetic",
            vec![(generation, vec![1.0, 0.0])],
        )
        .unwrap();
    let mut lexical = Bm25Index::new();
    lexical.upsert_page("wiki/synthetic.md", "synthetic", &[word.into()]);
    IndexPair {
        generation,
        store,
        lexical,
    }
}

#[test]
fn paired_container_rejects_corruption_and_preserves_generation_identity() {
    let pair = fixture(42, "alpha");
    let bytes = encode(&pair);
    let loaded = decode(&bytes).unwrap();
    assert_eq!(loaded.generation, 42);
    assert_eq!(loaded.store.records[0].hash, 42);
    assert_eq!(loaded.lexical.search("alpha", 1).len(), 1);
    for offset in [0, 8, HEADER_LEN, bytes.len() - 1] {
        let mut damaged = bytes.clone();
        damaged[offset] ^= 1;
        assert!(decode(&damaged).is_none());
    }
    assert!(decode(&bytes[..bytes.len() - 1]).is_none());
}

#[test]
fn numeric_paired_decode_rejects_checksum_valid_invalid_dense_geometry() {
    for vector in [
        vec![0.0, 0.0],
        vec![f32::NAN, 1.0],
        vec![f32::INFINITY, 1.0],
        vec![1.0, 0.0, 0.0],
    ] {
        let mut invalid = fixture(2, "bravo");
        invalid.store.records[0].vector = vector;
        assert!(
            decode(&encode(&invalid)).is_none(),
            "checksum must not authorize invalid dense geometry"
        );
    }
}

#[test]
fn numeric_paired_prepare_rejects_invalid_dense_before_replacing_prior_generation() {
    crate::settings::test_support::with_isolated_data("pair-numeric-invalid", |directory| {
        let root = directory.join("synthetic-vault");
        let path = PreparedPair::prepare(&root, &fixture(1, "alpha"))
            .unwrap()
            .commit()
            .unwrap();
        let before = std::fs::read(&path).unwrap();
        let mut invalid = fixture(2, "bravo");
        invalid.store.records[0].vector = vec![0.0, 0.0];
        let rejected = match PreparedPair::prepare(&root, &invalid) {
            Err(_) => true,
            Ok(prepared) => {
                prepared.commit().unwrap();
                false
            }
        };
        assert_eq!(
            std::fs::read(&path).unwrap(),
            before,
            "invalid dense geometry replaced the published generation"
        );
        assert!(rejected, "invalid dense geometry must fail at prepare");
        let current = load(&root).unwrap();
        assert_eq!(current.generation, 1);
        assert_eq!(current.store.signature, "synthetic-signature");
        assert_eq!(current.lexical.search("alpha", 1).len(), 1);
    });
}

#[test]
fn paired_migration_leaves_legacy_files_unchanged_until_atomic_commit() {
    crate::settings::test_support::with_isolated_data("pair-migration", |directory| {
        let root = directory.join("synthetic-vault");
        let dense = legacy_path_for(&root.to_string_lossy(), "mxv").unwrap();
        let lexical = legacy_path_for(&root.to_string_lossy(), "mxb").unwrap();
        let old = fixture(0, "alpha");
        old.store.save(&dense).unwrap();
        old.lexical.save(&lexical).unwrap();
        let dense_bytes = std::fs::read(&dense).unwrap();
        let lexical_bytes = std::fs::read(&lexical).unwrap();
        let staged = PreparedPair::prepare(&root, &fixture(1, "bravo")).unwrap();
        assert_eq!(
            VectorStore::path_for(&root.to_string_lossy()).unwrap(),
            dense
        );
        assert_eq!(load(&root).unwrap().generation, 0);
        staged.commit().unwrap();
        assert_eq!(
            VectorStore::path_for(&root.to_string_lossy()).unwrap(),
            Bm25Index::path_for(&root.to_string_lossy()).unwrap()
        );
        let pair = load(&root).unwrap();
        assert_eq!(pair.generation, 1);
        assert_eq!(pair.lexical.search("bravo", 1).len(), 1);
        assert_eq!(std::fs::read(&dense).unwrap(), dense_bytes);
        assert_eq!(std::fs::read(&lexical).unwrap(), lexical_bytes);
    });
}

#[test]
fn legacy_corrupt_sidecars_are_errors_instead_of_empty_migration_inputs() {
    crate::settings::test_support::with_isolated_data("pair-legacy-corrupt", |directory| {
        for extension in ["mxv", "mxb", "json"] {
            let root = directory.join(extension);
            let path = legacy_path_for(&root.to_string_lossy(), extension).unwrap();
            std::fs::write(&path, b"synthetic corrupt legacy index").unwrap();
            assert!(
                load(&root).is_err(),
                "existing malformed {extension} must not become empty"
            );
            assert!(!path_for(&root.to_string_lossy()).unwrap().exists());
            assert_eq!(
                std::fs::read(path).unwrap(),
                b"synthetic corrupt legacy index"
            );
        }
    });
}

#[cfg(unix)]
#[test]
fn legacy_unreadable_sidecars_preserve_the_prior_file_and_error() {
    crate::settings::test_support::with_isolated_data("pair-legacy-denied", |directory| {
        let root = directory.join("synthetic-vault");
        let dense = legacy_path_for(&root.to_string_lossy(), "mxv").unwrap();
        fixture(0, "alpha").store.save(&dense).unwrap();
        let before = std::fs::read(&dense).unwrap();
        let denied = crate::vault::scan_tests::DeniedDirectory::new(dense.parent().unwrap());
        let result = load(&root);
        drop(denied);
        assert!(result.is_err());
        assert_eq!(std::fs::read(dense).unwrap(), before);
        assert!(!path_for(&root.to_string_lossy()).unwrap().exists());
    });
}

#[test]
fn failed_pair_commit_keeps_the_prior_persisted_generation() {
    crate::settings::test_support::with_isolated_data("pair-failure", |directory| {
        let root = directory.join("synthetic-vault");
        let path = PreparedPair::prepare(&root, &fixture(1, "alpha"))
            .unwrap()
            .commit()
            .unwrap();
        let before = std::fs::read(&path).unwrap();
        std::fs::create_dir(path.with_extension("mxp.previous")).unwrap();
        assert!(PreparedPair::prepare(&root, &fixture(2, "bravo"))
            .unwrap()
            .commit()
            .is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        let pair = load(&root).unwrap();
        assert_eq!(pair.generation, 1);
        assert_eq!(pair.store.records[0].hash, 1);
        assert_eq!(pair.lexical.search("alpha", 1).len(), 1);
    });
}

#[test]
fn paired_snapshot_and_single_index_caches_use_generation_even_when_mtime_and_size_match() {
    crate::settings::test_support::with_isolated_data("pair-cache", |directory| {
        let root = directory.join("synthetic-vault");
        let path = PreparedPair::prepare(&root, &fixture(1, "alpha"))
            .unwrap()
            .commit()
            .unwrap();
        let metadata = std::fs::metadata(&path).unwrap();
        assert_eq!(generation_of(&path).unwrap(), 1);
        let old = tauri::async_runtime::block_on(snapshot(root.clone())).unwrap();
        let dense_cache = crate::vector_index::VectorCache::default();
        let lexical_cache = crate::retrieval::Bm25Cache::default();
        assert_eq!(dense_cache.get(&path).unwrap().records[0].hash, 1);
        assert_eq!(lexical_cache.get(&path).search("alpha", 1).len(), 1);
        PreparedPair::prepare(&root, &fixture(2, "bravo"))
            .unwrap()
            .commit()
            .unwrap();
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(metadata.modified().unwrap()))
            .unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().len(), metadata.len());
        let current = tauri::async_runtime::block_on(snapshot(root.clone())).unwrap();
        assert_eq!(old.generation, 1);
        assert_eq!(old.store.records[0].hash, 1);
        assert_eq!(old.lexical.search("alpha", 1).len(), 1);
        assert_eq!(current.generation, 2);
        assert_eq!(current.store.records[0].hash, 2);
        assert_eq!(current.lexical.search("bravo", 1).len(), 1);
        assert_eq!(dense_cache.get(&path).unwrap().records[0].hash, 2);
        assert_eq!(lexical_cache.get(&path).search("bravo", 1).len(), 1);
        assert_eq!(
            decode(&std::fs::read(path.with_extension("mxp.previous")).unwrap())
                .unwrap()
                .generation,
            1
        );
    });
}

// Synthetic persisted bytes and real lexical/vector searches; no model execution.
fn content_pair(generation: u64, word: &str, reversed_vectors: bool) -> IndexPair {
    let mut pair = fixture(generation, word);
    pair.store.records[0].hash = crate::embeddings::content_hash(word);
    pair.store.records[0].vector = if reversed_vectors {
        vec![0.0, 1.0]
    } else {
        vec![1.0, 0.0]
    };
    pair.store
        .upsert_page(
            "wiki/secondary.md",
            "secondary",
            vec![(
                9,
                if reversed_vectors {
                    vec![1.0, 0.0]
                } else {
                    vec![0.0, 1.0]
                },
            )],
        )
        .unwrap();
    pair.lexical
        .upsert_page("wiki/secondary.md", "secondary", &["other".into()]);
    pair
}

fn replace_pair_same_stamp(path: &Path, bytes: &[u8]) {
    let metadata = std::fs::metadata(path).unwrap();
    let modified = metadata.modified().unwrap();
    assert_eq!(metadata.len(), bytes.len() as u64);
    std::fs::write(path, bytes).unwrap();
    std::fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(modified))
        .unwrap();
    let current = std::fs::metadata(path).unwrap();
    assert_eq!(current.len(), metadata.len());
    assert_eq!(current.modified().unwrap(), modified);
}

fn assert_pair_search(pair: &PairSnapshot, word: &str, best_page: &str) {
    assert_eq!(pair.lexical.search(word, 1)[0].page, "wiki/synthetic.md");
    let dense = pair.store.search(&[1.0, 0.0], 1).unwrap();
    assert_eq!(dense[0].page, best_page);
    assert_eq!(dense[0].score, 1.0);
}

#[test]
fn paired_cache_same_generation_same_stamp_replacement_changes_both_searches() {
    crate::settings::test_support::with_isolated_data("pair-content-collision", |directory| {
        let root = directory.join("synthetic-vault");
        let original = content_pair(7, "alpha", false);
        let replacement = content_pair(7, "bravo", true);
        let path = PreparedPair::prepare(&root, &original)
            .unwrap()
            .commit()
            .unwrap();
        let before = std::fs::read(&path).unwrap();
        let replaced = encode(&replacement);
        assert_eq!(before.len(), replaced.len());
        assert_ne!(before, replaced);
        let first = tauri::async_runtime::block_on(snapshot(root.clone())).unwrap();
        assert_pair_search(&first, "alpha", "wiki/synthetic.md");
        replace_pair_same_stamp(&path, &replaced);
        assert_eq!(generation_of(&path).unwrap(), 7);
        let current = tauri::async_runtime::block_on(snapshot(root.clone())).unwrap();
        assert_eq!(current.generation, first.generation);
        assert!(!Arc::ptr_eq(&first, &current));
        assert!(current.lexical.search("alpha", 1).is_empty());
        assert_pair_search(&current, "bravo", "wiki/secondary.md");
        assert_pair_search(&first, "alpha", "wiki/synthetic.md");
        assert_eq!(std::fs::read(&path).unwrap(), replaced);
        assert!(!path.with_extension("mxp.previous").exists());
    });
}

#[test]
fn paired_cache_checksum_error_never_adopts_corrupt_bytes_and_restoration_recovers() {
    crate::settings::test_support::with_isolated_data("pair-content-corrupt", |directory| {
        let root = directory.join("synthetic-vault");
        let path = PreparedPair::prepare(&root, &content_pair(7, "alpha", false))
            .unwrap()
            .commit()
            .unwrap();
        let original = std::fs::read(&path).unwrap();
        let first = tauri::async_runtime::block_on(snapshot(root.clone())).unwrap();
        let mut corrupt = original.clone();
        *corrupt.last_mut().unwrap() ^= 1;
        replace_pair_same_stamp(&path, &corrupt);
        assert!(decode(&corrupt).is_none());
        assert!(tauri::async_runtime::block_on(snapshot(root.clone())).is_err());
        let cache = PAIR_CACHE.lock().unwrap();
        assert_eq!(cache.as_ref().unwrap().root, root);
        assert!(Arc::ptr_eq(&cache.as_ref().unwrap().pair, &first));
        drop(cache);
        assert_eq!(std::fs::read(&path).unwrap(), corrupt);
        replace_pair_same_stamp(&path, &original);
        let restored = tauri::async_runtime::block_on(snapshot(root.clone())).unwrap();
        assert_eq!(restored.generation, 7);
        assert_pair_search(&restored, "alpha", "wiki/synthetic.md");
        assert_eq!(std::fs::read(&path).unwrap(), original);
    });
}

#[test]
fn paired_legacy_reader_ignores_unused_malformed_json_when_dense_primary_exists() {
    crate::settings::test_support::with_isolated_data("pair-unused-json", |directory| {
        let root = directory.join("synthetic-vault");
        let old = content_pair(0, "alpha", false);
        let dense = legacy_path_for(&root.to_string_lossy(), "mxv").unwrap();
        let lexical = legacy_path_for(&root.to_string_lossy(), "mxb").unwrap();
        let unused_json = legacy_path_for(&root.to_string_lossy(), "json").unwrap();
        old.store.save(&dense).unwrap();
        old.lexical.save(&lexical).unwrap();
        std::fs::write(&unused_json, b"synthetic malformed JSON").unwrap();
        let dense_before = std::fs::read(&dense).unwrap();
        let lexical_before = std::fs::read(&lexical).unwrap();
        let first = tauri::async_runtime::block_on(snapshot(root.clone())).unwrap();
        assert_eq!(first.generation, 0);
        assert_pair_search(&first, "alpha", "wiki/synthetic.md");
        // An unused fallback is not a dependency of the selected primary.
        std::fs::write(&unused_json, b"different malformed synthetic JSON").unwrap();
        let current = tauri::async_runtime::block_on(snapshot(root.clone())).unwrap();
        assert!(Arc::ptr_eq(&first, &current));
        assert_pair_search(&current, "alpha", "wiki/synthetic.md");
        assert_eq!(std::fs::read(&dense).unwrap(), dense_before);
        assert_eq!(std::fs::read(&lexical).unwrap(), lexical_before);
        assert_eq!(
            std::fs::read(&unused_json).unwrap(),
            b"different malformed synthetic JSON"
        );
        assert!(!path_for(&root.to_string_lossy()).unwrap().exists());
    });
}

#[test]
fn paired_publication_replaces_warm_legacy_and_fresh_reopen_uses_same_complete_bytes() {
    crate::settings::test_support::with_isolated_data("pair-content-reopen", |directory| {
        let root = directory.join("synthetic-vault");
        let old = content_pair(0, "alpha", false);
        let dense = legacy_path_for(&root.to_string_lossy(), "mxv").unwrap();
        let lexical = legacy_path_for(&root.to_string_lossy(), "mxb").unwrap();
        old.store.save(&dense).unwrap();
        old.lexical.save(&lexical).unwrap();
        let dense_before = std::fs::read(&dense).unwrap();
        let lexical_before = std::fs::read(&lexical).unwrap();
        let legacy = tauri::async_runtime::block_on(snapshot(root.clone())).unwrap();
        assert_eq!(legacy.generation, 0);
        assert_pair_search(&legacy, "alpha", "wiki/synthetic.md");
        let replacement = content_pair(7, "bravo", true);
        let path = PreparedPair::prepare(&root, &replacement)
            .unwrap()
            .commit()
            .unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let current = tauri::async_runtime::block_on(snapshot(root.clone())).unwrap();
        assert_eq!(current.generation, 7);
        assert!(!Arc::ptr_eq(&legacy, &current));
        assert!(current.lexical.search("alpha", 1).is_empty());
        assert_pair_search(&current, "bravo", "wiki/secondary.md");
        *PAIR_CACHE.lock().unwrap() = None;
        let reopened = tauri::async_runtime::block_on(snapshot(root.clone())).unwrap();
        assert!(!Arc::ptr_eq(&current, &reopened));
        assert_eq!(reopened.generation, 7);
        assert!(reopened.store.as_ref() == current.store.as_ref());
        assert!(reopened.lexical.search("alpha", 1).is_empty());
        assert_pair_search(&reopened, "bravo", "wiki/secondary.md");
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert_eq!(std::fs::read(&dense).unwrap(), dense_before);
        assert_eq!(std::fs::read(&lexical).unwrap(), lexical_before);
    });
}
