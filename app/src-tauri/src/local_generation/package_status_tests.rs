//! Synthetic file checks only; no model host or inference is initialized.

use super::*;

const BASE_BYTES: &[u8] = b"synthetic GGUF model bytes";
const ADAPTER_BYTES: &[u8] = b"synthetic LoRA adapter bytes";
const PACKAGE: local_model::ModelManifest = local_model::ModelManifest {
    id: "synthetic-status-package-only",
    repository: "synthetic/status-tests",
    revision: "synthetic-revision",
    file: "synthetic-base.gguf",
    url: "",
    bytes: BASE_BYTES.len() as u64,
    sha256: "b9a41118f23376cc03c23b5969635daadc350ae234394b87c6e86c88618d7160",
    license: "test-only",
    adapter: Some(local_model::LoraManifest {
        file: "synthetic-adapter.gguf",
        bytes: ADAPTER_BYTES.len() as u64,
        sha256: "3c06d3f73e4aa0ba34e25f0bb93963eae7f0310db1aa6b2e9bcc5da1c8a8d020",
    }),
};

#[test]
fn package_status_never_reports_ready_for_missing_or_corrupt_adapter() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(PACKAGE.file), BASE_BYTES).unwrap();
    assert_eq!(status_in_dir(dir.path(), &PACKAGE).state, "missing");
    let adapter_path = dir.path().join(PACKAGE.adapter.unwrap().file);
    std::fs::write(&adapter_path, b"changed synthetic LoRA bytes").unwrap();
    let corrupt = status_in_dir(dir.path(), &PACKAGE);
    assert_eq!(corrupt.state, "error");
    assert_eq!(corrupt.bytes, 0);
    assert!(corrupt.reason.unwrap().contains("qualified local package"));
    std::fs::write(&adapter_path, ADAPTER_BYTES).unwrap();
    let ready = status_in_dir(dir.path(), &PACKAGE);
    assert_eq!(ready.state, "ready");
    assert_eq!(ready.bytes, PACKAGE.bytes);
    assert!(ready.reason.is_none());
    std::fs::remove_file(adapter_path).unwrap();
    assert_eq!(status_in_dir(dir.path(), &PACKAGE).state, "missing");
}

#[test]
fn base_only_status_remains_ready_without_an_adapter() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(PACKAGE.file), BASE_BYTES).unwrap();
    let base = local_model::ModelManifest {
        adapter: None,
        ..PACKAGE
    };
    let status = status_in_dir(dir.path(), &base);
    assert_eq!(status.state, "ready");
    assert_eq!(status.bytes, base.bytes);
    assert!(status.reason.is_none());
}

#[tokio::test]
async fn unknown_learned_model_id_is_rejected_before_status_checks() {
    assert_eq!(
        status(Some(PACKAGE.id)).await.err().unwrap(),
        "unsupported local generation model"
    );
}
