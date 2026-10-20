//! Synthetic lexical cache witnesses use captured content and live query results.

use super::{decode_captured_index, Bm25Cache, Bm25Index};
use std::path::Path;
use std::sync::Arc;

fn index(text: &str) -> Bm25Index {
    let mut index = Bm25Index::new();
    index.upsert_page("wiki/example.md", "example", &[text.into()]);
    index
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

fn pair_bytes(lexical: &Bm25Index, generation: u64) -> Vec<u8> {
    use sha2::{Digest, Sha256};
    let dense = crate::vector_index::VectorStore::default().encode();
    let lexical = lexical.encode();
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

#[test]
fn bm25_warm_same_stamp_reads_new_terms_and_chunk_hash() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("index.mxb");
    let initial = index("alpha");
    let replacement = index("bravo");
    initial.save(&path).unwrap();
    let cache = Bm25Cache::default();
    let first = cache.get_checked(&path).unwrap();
    assert_eq!(first.search("alpha", 1).len(), 1);
    replace_same_stamp(&path, &replacement.encode());
    let current = cache.get_checked(&path).unwrap();
    assert!(current.search("alpha", 1).is_empty());
    assert_eq!(current.search("bravo", 1)[0].page, "wiki/example.md");
    assert_ne!(
        first.chunk_hash("wiki/example.md", 0),
        current.chunk_hash("wiki/example.md", 0)
    );
    assert_eq!(
        current.chunk_hash("wiki/example.md", 0),
        replacement.chunk_hash("wiki/example.md", 0)
    );
    assert!(!Arc::ptr_eq(&first, &current));
    assert_eq!(std::fs::read(&path).unwrap(), replacement.encode());
}

#[tokio::test]
async fn bm25_warm_same_generation_pair_reads_terms_and_checks_checksum() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("index.mxp");
    std::fs::write(&path, pair_bytes(&index("alpha"), 7)).unwrap();
    let cache = Bm25Cache::default();
    let first = cache.get_async(path.clone()).await.unwrap();
    let mut replacement = pair_bytes(&index("bravo"), 7);
    replace_same_stamp(&path, &replacement);
    let current = cache.get_async(path.clone()).await.unwrap();
    assert!(current.search("alpha", 1).is_empty());
    assert_eq!(current.search("bravo", 1).len(), 1);
    assert!(!Arc::ptr_eq(&first, &current));
    *replacement.last_mut().unwrap() ^= 1;
    replace_same_stamp(&path, &replacement);
    assert!(cache.get_checked(&path).is_err());
    assert!(cache.get_async(path.clone()).await.is_err());
    assert_eq!(std::fs::read(&path).unwrap(), replacement);
}

#[tokio::test]
async fn bm25_warm_same_stamp_corruption_is_checked_error_then_recovers() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("index.mxb");
    let initial = index("alpha");
    initial.save(&path).unwrap();
    let cache = Bm25Cache::default();
    let first = cache.get_checked(&path).unwrap();
    let mut corrupt = initial.encode();
    corrupt[0] ^= 1;
    replace_same_stamp(&path, &corrupt);
    assert!(cache.get_checked(&path).is_err());
    assert!(cache.get_async(path.clone()).await.is_err());
    assert!(cache.get(&path).is_empty());
    assert_eq!(std::fs::read(&path).unwrap(), corrupt);
    replace_same_stamp(&path, &initial.encode());
    assert!(Arc::ptr_eq(&first, &cache.get_checked(&path).unwrap()));
}

#[test]
fn bm25_checked_put_rejects_mismatching_persisted_fields_without_cache_mutation() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("index.mxb");
    index("alpha").save(&path).unwrap();
    let bytes = std::fs::read(&path).unwrap();
    let cache = Bm25Cache::default();
    let first = cache.get_checked(&path).unwrap();
    for field in 0..6 {
        let mut supplied = index("alpha");
        let slot = supplied.slots[0].as_mut().unwrap();
        match field {
            0 => slot.doc.hash ^= 1,
            1 => slot.doc.section = 1,
            2 => slot.doc.page = "wiki/another.md".into(),
            3 => slot.doc.stem = "another".into(),
            4 => slot.doc.len += 1,
            _ => {
                slot.terms.remove("alpha");
                slot.terms.insert("bravo".into(), 1);
            }
        }
        assert!(cache.put_checked(&path, supplied).is_err(), "field={field}");
        assert!(Arc::ptr_eq(&first, &cache.get_checked(&path).unwrap()));
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
    }
}

#[test]
fn bm25_checked_put_uses_persisted_derived_state_and_ignores_free_slots() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("index.mxb");
    let mut supplied = index("alpha");
    supplied.upsert_page("wiki/other.md", "other", &["bravo".into()]);
    supplied.upsert_page("wiki/example.md", "example", &[]);
    supplied.save(&path).unwrap();
    assert!(supplied.slots.iter().any(Option::is_none));
    supplied.postings.clear();
    supplied.page_slots.clear();
    supplied.total_len = 0;
    supplied.n_live = 99;
    let cache = Bm25Cache::default();
    cache.put_checked(&path, supplied).unwrap();
    let current = cache.get_checked(&path).unwrap();
    assert_eq!(current.len(), 1);
    assert_eq!(current.search("bravo", 1)[0].page, "wiki/other.md");
    assert!(current.search("alpha", 1).is_empty());
}

#[test]
fn bm25_checked_put_missing_file_cannot_pin_supplied_content() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("index.mxb");
    let cache = Bm25Cache::default();
    assert!(cache.put_checked(&path, index("alpha")).is_err());
    assert!(cache.get_checked(&path).unwrap().is_empty());
    index("bravo").save(&path).unwrap();
    assert_eq!(
        cache.get_checked(&path).unwrap().search("bravo", 1).len(),
        1
    );
}

#[test]
fn bm25_decoder_uses_captured_bytes_after_path_replacement() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("index.mxb");
    index("alpha").save(&path).unwrap();
    let snapshot = crate::index_publication::read_snapshot(&path)
        .unwrap()
        .unwrap();
    replace_same_stamp(&path, &index("bravo").encode());
    let captured = decode_captured_index(&path, &snapshot.bytes).unwrap();
    assert_eq!(captured.search("alpha", 1).len(), 1);
    assert!(captured.search("bravo", 1).is_empty());
    let current = Bm25Cache::default().get_checked(&path).unwrap();
    assert_eq!(current.search("bravo", 1).len(), 1);
}

#[test]
fn bm25_checked_read_rejects_nonregular_existing_file() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("index.mxb");
    std::fs::create_dir(&path).unwrap();
    let cache = Bm25Cache::default();
    assert!(cache.get_checked(&path).is_err());
    assert!(cache.put_checked(&path, index("alpha")).is_err());
    assert!(path.is_dir());
}

#[cfg(unix)]
#[tokio::test]
async fn bm25_warm_unreadable_file_is_checked_error_then_recovers() {
    use std::os::unix::fs::PermissionsExt;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("index.mxb");
    index("alpha").save(&path).unwrap();
    let cache = Bm25Cache::default();
    let first = cache.get_checked(&path).unwrap();
    let metadata = std::fs::metadata(&path).unwrap();
    let bytes = std::fs::read(&path).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o0)).unwrap();
    let denied = std::fs::read(&path).is_err();
    let loaded = cache.get_async(path.clone()).await;
    std::fs::set_permissions(&path, metadata.permissions()).unwrap();
    assert!(denied, "test requires an unprivileged file reader");
    assert!(
        loaded.is_err(),
        "warm lexical cache hid an existing read failure"
    );
    assert!(Arc::ptr_eq(&first, &cache.get_checked(&path).unwrap()));
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
}

#[cfg(unix)]
#[test]
fn bm25_warm_file_replaced_by_symlink_cannot_serve_cached_content() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("index.mxb");
    let target = directory.path().join("target.mxb");
    index("alpha").save(&path).unwrap();
    index("alpha").save(&target).unwrap();
    let bytes = std::fs::read(&target).unwrap();
    let cache = Bm25Cache::default();
    assert_eq!(
        cache.get_checked(&path).unwrap().search("alpha", 1).len(),
        1
    );
    std::fs::remove_file(&path).unwrap();
    std::os::unix::fs::symlink(&target, &path).unwrap();
    assert!(cache.get_checked(&path).is_err());
    assert!(cache.put_checked(&path, index("alpha")).is_err());
    assert_eq!(std::fs::read_link(&path).unwrap(), target);
    assert_eq!(std::fs::read(&target).unwrap(), bytes);
}
