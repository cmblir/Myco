//! Synthetic file-only package checks; no native models or learned artifacts.

use super::*;
use std::fs;

const BASE_BYTES: &[u8] = b"synthetic GGUF model bytes";
const ADAPTER_BYTES: &[u8] = b"synthetic LoRA adapter bytes";
const CHANGED_ADAPTER_BYTES: &[u8] = b"changed synthetic LoRA bytes";
const ADAPTER: LoraManifest = LoraManifest {
    file: "synthetic-adapter.gguf",
    bytes: ADAPTER_BYTES.len() as u64,
    sha256: "3c06d3f73e4aa0ba34e25f0bb93963eae7f0310db1aa6b2e9bcc5da1c8a8d020",
};
const PACKAGE: ModelManifest = ModelManifest {
    id: "synthetic-learned-package-only",
    repository: "synthetic/package-tests",
    revision: "synthetic-revision",
    file: "synthetic-base.gguf",
    url: "",
    bytes: BASE_BYTES.len() as u64,
    sha256: "b9a41118f23376cc03c23b5969635daadc350ae234394b87c6e86c88618d7160",
    license: "test-only",
    adapter: Some(ADAPTER),
};

fn write_package(dir: &Path) {
    fs::write(dir.join(PACKAGE.file), BASE_BYTES).unwrap();
    fs::write(dir.join(ADAPTER.file), ADAPTER_BYTES).unwrap();
}

#[test]
fn base_only_package_preserves_identity_wire_and_runtime() {
    let manifest = ModelManifest {
        adapter: None,
        ..PACKAGE
    };
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join(manifest.file), BASE_BYTES).unwrap();
    let package = resolve_verified_package(dir.path(), &manifest).unwrap();
    assert_eq!(package.identity(), manifest.sha256);
    assert_eq!(artifact_identity(&manifest), manifest.sha256);
    assert_eq!(runtime_contract(&manifest), "local-generation-v1");
    assert_eq!(package.adapter_path(), None);
    let base_path = resolve_verified_artifact(dir.path(), &manifest).unwrap();
    assert_eq!(package.model_path(), base_path.as_path());
    assert!(serde_json::to_value(manifest)
        .unwrap()
        .get("adapter")
        .is_none());
    for registered in [
        MODEL,
        SMALL_MODEL,
        GEMMA_CANDIDATE,
        QWEN9B_CANDIDATE,
        GEMMA12B_CANDIDATE,
    ] {
        assert!(registered.adapter.is_none());
        assert_eq!(artifact_identity(&registered), registered.sha256);
    }
    assert!(manifest_for(Some(PACKAGE.id)).is_err());
}

#[test]
fn learned_identity_binds_both_hashes_and_selects_lora_runtime() {
    let identity = artifact_identity(&PACKAGE);
    assert_eq!(identity.len(), 64);
    assert_ne!(identity, PACKAGE.sha256);
    assert_eq!(runtime_contract(&PACKAGE), "local-generation-lora-v1");
    let changed_adapter = ModelManifest {
        adapter: Some(LoraManifest {
            sha256: "f0f2a9d93f91bc81ea0fd3c5da5b2f2f0b3ba4c4a9e983997454dfba63a964db",
            ..ADAPTER
        }),
        ..PACKAGE
    };
    assert_ne!(identity, artifact_identity(&changed_adapter));
    let changed_base = ModelManifest {
        sha256: changed_adapter.adapter.unwrap().sha256,
        ..PACKAGE
    };
    assert_ne!(identity, artifact_identity(&changed_base));
    let wire = serde_json::to_value(PACKAGE).unwrap();
    assert_eq!(wire["adapter"]["sha256"], ADAPTER.sha256);
    assert_eq!(wire["adapter"]["bytes"], ADAPTER.bytes);
}

#[test]
fn unchanged_base_and_adapter_each_hash_once() {
    let dir = tempfile::tempdir().unwrap();
    write_package(dir.path());
    let mut base_cache = Verifier::default();
    let mut adapter_cache = Verifier::default();
    for _ in 0..3 {
        let package =
            resolve_package_with_caches(dir.path(), &PACKAGE, &mut base_cache, &mut adapter_cache)
                .unwrap();
        let canonical = dir.path().canonicalize().unwrap();
        assert_eq!(package.model_path(), canonical.join(PACKAGE.file).as_path());
        assert_eq!(
            package.adapter_path(),
            Some(canonical.join(ADAPTER.file).as_path())
        );
        assert_eq!(package.identity(), artifact_identity(&PACKAGE));
    }
    assert_eq!(base_cache.hash_reads, 1);
    assert_eq!(adapter_cache.hash_reads, 1);
}

#[test]
fn missing_and_wrong_size_adapter_never_issue_a_package_or_base_path() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join(PACKAGE.file), BASE_BYTES).unwrap();
    for content in [None, Some(b"short".as_slice())] {
        if let Some(content) = content {
            fs::write(dir.path().join(ADAPTER.file), content).unwrap();
        }
        assert!(resolve_verified_package(dir.path(), &PACKAGE).is_err());
        assert!(resolve_verified_artifact(dir.path(), &PACKAGE).is_err());
    }
    assert_eq!(fs::read(dir.path().join(PACKAGE.file)).unwrap(), BASE_BYTES);
}

#[test]
fn complete_learned_package_cannot_be_loaded_through_a_base_only_path() {
    let dir = tempfile::tempdir().unwrap();
    write_package(dir.path());
    resolve_verified_package(dir.path(), &PACKAGE).unwrap();
    assert_eq!(
        resolve_verified_artifact(dir.path(), &PACKAGE).unwrap_err(),
        "learned local package requires package-aware loading"
    );
}

#[test]
fn unchanged_corrupt_adapter_stays_rejected_without_rehashing_base() {
    let dir = tempfile::tempdir().unwrap();
    write_package(dir.path());
    fs::write(dir.path().join(ADAPTER.file), CHANGED_ADAPTER_BYTES).unwrap();
    let mut base_cache = Verifier::default();
    let mut adapter_cache = Verifier::default();
    for _ in 0..2 {
        let error =
            resolve_package_with_caches(dir.path(), &PACKAGE, &mut base_cache, &mut adapter_cache)
                .unwrap_err();
        assert!(error.contains("adapter") && error.contains("SHA256"));
    }
    assert_eq!(base_cache.hash_reads, 1);
    assert_eq!(adapter_cache.hash_reads, 1);
}

#[cfg(unix)]
#[test]
fn same_size_replaced_adapter_with_preserved_mtime_invalidates_package() {
    let dir = tempfile::tempdir().unwrap();
    write_package(dir.path());
    let mut base_cache = Verifier::default();
    let mut adapter_cache = Verifier::default();
    resolve_package_with_caches(dir.path(), &PACKAGE, &mut base_cache, &mut adapter_cache).unwrap();
    let path = dir.path().join(ADAPTER.file);
    let modified = fs::metadata(&path).unwrap().modified().unwrap();
    let replacement = dir.path().join("synthetic-replacement.gguf");
    fs::write(&replacement, CHANGED_ADAPTER_BYTES).unwrap();
    File::options()
        .write(true)
        .open(&replacement)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(modified))
        .unwrap();
    fs::rename(replacement, &path).unwrap();
    assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), modified);
    assert!(
        resolve_package_with_caches(dir.path(), &PACKAGE, &mut base_cache, &mut adapter_cache)
            .is_err()
    );
    assert_eq!(base_cache.hash_reads, 1);
    assert_eq!(adapter_cache.hash_reads, 2);
}

#[cfg(unix)]
#[test]
fn verified_package_handle_rejects_replacement_of_either_file() {
    for file in [PACKAGE.file, ADAPTER.file] {
        let dir = tempfile::tempdir().unwrap();
        write_package(dir.path());
        let package = resolve_verified_package(dir.path(), &PACKAGE).unwrap();
        package.check_unchanged().unwrap();
        let replacement = dir.path().join("synthetic-replacement.gguf");
        let bytes = if file == PACKAGE.file {
            BASE_BYTES
        } else {
            ADAPTER_BYTES
        };
        // Even byte-identical replacement is a different verified instance.
        fs::write(&replacement, bytes).unwrap();
        fs::rename(replacement, dir.path().join(file)).unwrap();
        assert!(package.check_unchanged().is_err());
        resolve_verified_package(dir.path(), &PACKAGE).unwrap();
    }
}

#[cfg(unix)]
#[test]
fn adapter_symlink_is_rejected_without_reading_or_mutating_its_target() {
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::write(dir.path().join(PACKAGE.file), BASE_BYTES).unwrap();
    let target = outside.path().join("synthetic-adapter.gguf");
    fs::write(&target, ADAPTER_BYTES).unwrap();
    std::os::unix::fs::symlink(&target, dir.path().join(ADAPTER.file)).unwrap();
    let mut base_cache = Verifier::default();
    let mut adapter_cache = Verifier::default();
    assert!(
        resolve_package_with_caches(dir.path(), &PACKAGE, &mut base_cache, &mut adapter_cache)
            .is_err()
    );
    assert_eq!(adapter_cache.hash_reads, 0);
    assert_eq!(fs::read(target).unwrap(), ADAPTER_BYTES);
}

#[test]
fn package_filenames_cannot_escape_the_models_directory() {
    let dir = tempfile::tempdir().unwrap();
    write_package(dir.path());
    for file in [
        "",
        ".",
        "..",
        "../outside.gguf",
        "/outside.gguf",
        "nested/file.gguf",
        "nested\\file.gguf",
    ] {
        let base = ModelManifest { file, ..PACKAGE };
        assert!(resolve_verified_package(dir.path(), &base).is_err());
        let adapter = ModelManifest {
            adapter: Some(LoraManifest { file, ..ADAPTER }),
            ..PACKAGE
        };
        assert!(resolve_verified_package(dir.path(), &adapter).is_err());
        assert!(StagedDownload::new(dir.path(), &base).is_err());
    }
}

#[tokio::test]
async fn base_download_rejects_learned_package_before_progress_or_filesystem_changes() {
    let dir = tempfile::tempdir().unwrap();
    let absent = dir.path().join("not-created");
    let result =
        download_verified_artifact(&absent, &PACKAGE, Arc::new(AtomicBool::new(false)), |_| {
            panic!("a rejected learned package must not report download progress")
        })
        .await;
    assert!(result
        .unwrap_err()
        .contains("qualified local package installer"));
    assert!(!absent.exists());
}
