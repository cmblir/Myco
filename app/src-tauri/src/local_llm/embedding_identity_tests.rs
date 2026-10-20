use super::*;

fn replace_with_same_stamp(path: &Path, bytes: &[u8]) {
    let stamp = std::fs::metadata(path).unwrap().modified().unwrap();
    std::fs::write(path, bytes).unwrap();
    std::fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(stamp))
        .unwrap();
    assert_eq!(std::fs::metadata(path).unwrap().modified().unwrap(), stamp);
}

#[test]
fn identity_admission_weight_digest_not_reused_for_equal_size_and_mtime() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("synthetic-weights.bin");
    std::fs::write(&path, b"first-fixed-bytes").unwrap();
    let before = embed_model_fingerprint(&path).unwrap();
    replace_with_same_stamp(&path, b"other-fixed-bytes");
    assert_ne!(embed_model_fingerprint(&path).unwrap(), before);
    assert_eq!(std::fs::read(&path).unwrap(), b"other-fixed-bytes");
}

#[test]
#[ignore = "loads a temporary copy of the existing bundled E5 artifact"]
fn identity_admission_e5_same_stamp_replacement_cannot_reuse_resident_encoder() {
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("models/multilingual-e5-small-ko-v2-q8_0.gguf");
    let original = std::fs::read(&source).unwrap();
    let source_digest = embed_model_fingerprint(&source).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let copy = temp.path().join("temporary-e5.gguf");
    std::fs::write(&copy, &original).unwrap();
    let mut host = LocalLlm::load_embed_host().unwrap();
    host.ensure_embed_model(&copy).unwrap();
    let admitted_identity = host.embed_identity.clone();
    let mut replacement = original.clone();
    replacement[..4].copy_from_slice(b"BAD!");
    replace_with_same_stamp(&copy, &replacement);

    assert!(host.ensure_embed_model(&copy).is_err());
    assert_eq!(host.embed_identity, admitted_identity);
    assert_eq!(std::fs::read(&source).unwrap(), original);
    assert_eq!(embed_model_fingerprint(&source).unwrap(), source_digest);

    replace_with_same_stamp(&copy, &original);
    host.ensure_embed_model(&copy).unwrap();
    let vectors = host
        .embed_spec(
            embed_spec_by_id("e5-small-ko").unwrap(),
            EmbedRole::Query,
            &["Synthetic local recovery query".into()],
        )
        .unwrap();
    crate::embeddings::validate_embedding_batch(&vectors, 1, Some(384)).unwrap();
}

#[test]
fn producer_admission_unloaded_host_cannot_supply_resident_embedding_identity() {
    let host = LocalLlm::load_embed_host().unwrap();
    assert!(host.resident_embed_fingerprint().is_err());
}

#[test]
#[ignore = "loads a temporary copy of the existing bundled E5 artifact"]
fn producer_admission_e5_resident_identity_does_not_follow_replaced_path_bytes() {
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("models/multilingual-e5-small-ko-v2-q8_0.gguf");
    let original = std::fs::read(&source).unwrap();
    let source_digest = embed_model_fingerprint(&source).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let copy = temp.path().join("temporary-e5.gguf");
    std::fs::write(&copy, &original).unwrap();
    let mut host = LocalLlm::load_embed_host().unwrap();
    host.ensure_embed_model(&copy).unwrap();
    assert_eq!(host.resident_embed_fingerprint().unwrap(), source_digest);
    let mut replacement = original.clone();
    replacement[..4].copy_from_slice(b"BAD!");
    replace_with_same_stamp(&copy, &replacement);
    assert_ne!(embed_model_fingerprint(&copy).unwrap(), source_digest);
    assert_eq!(host.resident_embed_fingerprint().unwrap(), source_digest);
    assert_eq!(std::fs::read(&source).unwrap(), original);
    assert_eq!(embed_model_fingerprint(&source).unwrap(), source_digest);
}
