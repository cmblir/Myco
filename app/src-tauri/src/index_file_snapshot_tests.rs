use super::*;

#[test]
fn snapshot_distinguishes_absence_from_directory_and_leaf_symlink() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("index.mxb");
    assert!(read_snapshot(&path).unwrap().is_none());
    std::fs::create_dir(&path).unwrap();
    assert!(read_snapshot(&path).is_err());
    #[cfg(unix)]
    {
        std::fs::remove_dir(&path).unwrap();
        let target = directory.path().join("target");
        std::fs::write(&target, b"alpha").unwrap();
        std::os::unix::fs::symlink(&target, &path).unwrap();
        assert!(read_snapshot(&path).is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"alpha");
    }
}

#[test]
fn snapshot_revision_binds_same_stamp_bytes_and_survives_metadata_only_restore() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("index.mxb");
    std::fs::write(&path, b"alpha").unwrap();
    let first = read_snapshot(&path).unwrap().unwrap();
    let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
    std::fs::write(&path, b"bravo").unwrap();
    let file = File::open(&path).unwrap();
    file.set_times(std::fs::FileTimes::new().set_modified(modified))
        .unwrap();
    let second = read_snapshot(&path).unwrap().unwrap();
    assert_eq!(first.revision.len, second.revision.len);
    assert_eq!(first.revision.modified, second.revision.modified);
    assert_ne!(first.revision.digest, second.revision.digest);
    assert_eq!(second.bytes, b"bravo");
    std::fs::write(&path, b"alpha").unwrap();
    file.set_times(std::fs::FileTimes::new().set_modified(modified))
        .unwrap();
    assert_eq!(
        first.revision,
        read_snapshot(&path).unwrap().unwrap().revision
    );
}

#[test]
fn snapshot_rejects_path_replacement_without_changing_either_file() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("index.mxb");
    let old = directory.path().join("retained.mxb");
    std::fs::write(&path, b"alpha").unwrap();
    let result = read_snapshot_after_open(&path, |_| {
        std::fs::rename(&path, &old).unwrap();
        std::fs::write(&path, b"bravo").unwrap();
    });
    assert!(result.unwrap_err().contains("changed during read"));
    assert_eq!(std::fs::read(&old).unwrap(), b"alpha");
    assert_eq!(std::fs::read(&path).unwrap(), b"bravo");
}

#[test]
fn snapshot_rejects_growth_and_shrink_during_held_read() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("index.mxb");
    for replacement in [b"bravo more".as_slice(), b"b".as_slice()] {
        std::fs::write(&path, b"alpha").unwrap();
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        let result = read_snapshot_after_open(&path, |_| {
            std::fs::write(&path, replacement).unwrap();
            File::open(&path)
                .unwrap()
                .set_times(std::fs::FileTimes::new().set_modified(modified))
                .unwrap();
        });
        assert!(result.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), replacement);
    }
}

#[cfg(unix)]
#[test]
fn snapshot_rejects_same_stamp_write_during_held_read() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("index.mxb");
    std::fs::write(&path, b"alpha").unwrap();
    let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
    let result = read_snapshot_after_open(&path, |_| {
        std::fs::write(&path, b"bravo").unwrap();
        File::open(&path)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(modified))
            .unwrap();
    });
    assert!(result.is_err());
    assert_eq!(std::fs::read(&path).unwrap(), b"bravo");
}

#[test]
#[ignore = "explicit synthetic cache cost measurement; not a latency gate"]
fn snapshot_cache_cost_measurement() {
    use crate::retrieval::{Bm25Cache, Bm25Index};
    use crate::vector_index::{Record, VectorCache, VectorStore};
    use std::sync::Arc;
    use std::time::Instant;

    let directory = tempfile::tempdir().unwrap();
    let mut measurements = Vec::new();
    for count in [1_000_usize, 10_000] {
        let dense_path = directory.path().join(format!("{count}.mxv"));
        let lexical_path = directory.path().join(format!("{count}.mxb"));
        let mut store = VectorStore {
            model: "synthetic-local-model".into(),
            signature: "synthetic-content-cache-v1".into(),
            dim: 384,
            records: Vec::with_capacity(count),
        };
        let mut lexical = Bm25Index::new();
        for index in 0..count {
            let page = format!("wiki/synthetic-{index}.md");
            let mut vector = vec![0.0; 384];
            vector[index % 384] = 1.0;
            store.records.push(Record {
                id: format!("{page}#0"),
                page: page.clone(),
                stem: format!("synthetic-{index}"),
                section: 0,
                hash: index as u64,
                vector,
            });
            lexical.upsert_page(&page, "synthetic", &[format!("alpha synthetic {index}")]);
        }
        store.save(&dense_path).unwrap();
        lexical.save(&lexical_path).unwrap();
        let dense = VectorCache::default();
        let lexical_cache = Bm25Cache::default();
        let started = Instant::now();
        let dense_first = dense.get(&dense_path).unwrap();
        let dense_cold_ms = started.elapsed().as_secs_f64() * 1_000.0;
        let started = Instant::now();
        let lexical_first = lexical_cache.get_checked(&lexical_path).unwrap();
        let lexical_cold_ms = started.elapsed().as_secs_f64() * 1_000.0;
        let mut dense_warm_ms = Vec::new();
        let mut lexical_warm_ms = Vec::new();
        for _ in 0..5 {
            let started = Instant::now();
            let current = dense.get(&dense_path).unwrap();
            dense_warm_ms.push(started.elapsed().as_secs_f64() * 1_000.0);
            assert!(Arc::ptr_eq(&current, &dense_first));
            let started = Instant::now();
            let current = lexical_cache.get_checked(&lexical_path).unwrap();
            lexical_warm_ms.push(started.elapsed().as_secs_f64() * 1_000.0);
            assert!(Arc::ptr_eq(&current, &lexical_first));
        }
        assert_eq!(
            dense_first
                .search(&store.records[0].vector, 1)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(lexical_first.search("alpha", 1).len(), 1);
        measurements.push(serde_json::json!({
            "records": count, "dimension": 384,
            "denseBytes": std::fs::metadata(&dense_path).unwrap().len(),
            "lexicalBytes": std::fs::metadata(&lexical_path).unwrap().len(),
            "denseColdMs": dense_cold_ms, "lexicalColdMs": lexical_cold_ms,
            "denseWarmMs": dense_warm_ms, "lexicalWarmMs": lexical_warm_ms,
            "warmReadsRetainParsedArc": true,
        }));
    }
    println!(
        "content-cache-cost {}",
        serde_json::to_string(&measurements).unwrap()
    );
}

#[cfg(unix)]
#[test]
fn snapshot_rejects_fifo_and_post_open_symlink_without_following_target() {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("index.mxb");
    let c_path = CString::new(path.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
    assert!(read_snapshot(&path).is_err());
    std::fs::remove_file(&path).unwrap();
    std::fs::write(&path, b"alpha").unwrap();
    let target = directory.path().join("target");
    std::fs::write(&target, b"bravo").unwrap();
    let result = read_snapshot_after_open(&path, |_| {
        std::fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(&target, &path).unwrap();
    });
    assert!(result.is_err());
    assert_eq!(std::fs::read(&target).unwrap(), b"bravo");
}
