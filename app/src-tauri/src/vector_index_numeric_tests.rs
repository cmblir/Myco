use super::{Record, VectorStore};

fn fixture() -> VectorStore {
    VectorStore {
        model: "synthetic-numeric-model".into(),
        signature: "synthetic-numeric-signature".into(),
        dim: 2,
        records: vec![Record {
            id: "wiki/synthetic.md#0".into(),
            page: "wiki/synthetic.md".into(),
            stem: "synthetic".into(),
            section: 0,
            hash: 1,
            vector: vec![0.5, 0.5],
        }],
    }
}

fn invalid_vectors() -> Vec<(&'static str, Vec<f32>)> {
    vec![
        ("empty", vec![]),
        ("zero", vec![0.0, 0.0]),
        ("nan", vec![f32::NAN, 1.0]),
        ("positive-infinity", vec![f32::INFINITY, 1.0]),
        ("negative-infinity", vec![f32::NEG_INFINITY, 1.0]),
        ("short", vec![1.0]),
        ("long", vec![1.0, 0.0, 0.0]),
    ]
}

#[test]
fn numeric_upsert_rejects_invalid_late_chunk_without_changing_existing_store() {
    for (label, vector) in invalid_vectors() {
        let mut store = fixture();
        let before = store.encode();
        // The invalid vector is late in a batch with a valid first chunk.
        let result = store.upsert_page(
            "wiki/synthetic.md",
            "replacement",
            vec![(2, vec![1.0, 0.0]), (3, vector)],
        );
        assert_eq!(
            store.encode(),
            before,
            "invalid incoming {label} changed the store"
        );
        assert!(
            result.is_err(),
            "invalid incoming {label} must return an error"
        );
    }
}

#[test]
fn numeric_sparse_upsert_rejects_invalid_late_chunk_without_changing_existing_store() {
    for (label, vector) in invalid_vectors() {
        let mut store = fixture();
        let before = store.encode();
        let result = store.upsert_page_sections(
            "wiki/synthetic.md",
            "replacement",
            vec![(5, 2, vec![1.0, 0.0]), (299, 3, vector)],
        );
        assert_eq!(
            store.encode(),
            before,
            "invalid sparse {label} changed the store"
        );
        assert!(
            result.is_err(),
            "invalid sparse {label} must return an error"
        );
    }
}

#[test]
fn numeric_first_batch_rejects_mixed_widths_without_setting_dimension() {
    let mut store = VectorStore::default();
    store.ensure_signature("synthetic-numeric-model", "synthetic-numeric-signature");
    let before = store.encode();
    let result = store.upsert_page(
        "wiki/synthetic.md",
        "synthetic",
        vec![(2, vec![1.0, 0.0]), (3, vec![1.0, 0.0, 0.0])],
    );
    assert_eq!(
        store.encode(),
        before,
        "mixed first batch changed dimension or records"
    );
    assert!(result.is_err(), "mixed first batch must return an error");
}

#[test]
fn numeric_first_batch_rejects_zero_without_setting_dimension() {
    let mut store = VectorStore::default();
    store.ensure_signature("synthetic-numeric-model", "synthetic-numeric-signature");
    let before = store.encode();
    let result = store.upsert_page("wiki/synthetic.md", "synthetic", vec![(2, vec![0.0, 0.0])]);
    assert_eq!(
        store.encode(),
        before,
        "zero first batch changed dimension or records"
    );
    assert!(result.is_err(), "zero first batch must return an error");
}

#[test]
fn numeric_empty_replacement_still_deliberately_deletes_the_page() {
    let mut store = fixture();
    store
        .upsert_page("wiki/synthetic.md", "", Vec::new())
        .unwrap();
    assert!(store.records.is_empty());
    assert_eq!(store.dim, 2);
    assert_eq!(store.signature, "synthetic-numeric-signature");
}

#[test]
fn numeric_nonunit_large_and_tiny_finite_vectors_remain_valid_codec_inputs() {
    for vector in [
        vec![0.5, 0.5],
        vec![f32::MAX / 4.0; 2],
        vec![f32::from_bits(1); 2],
    ] {
        let mut store = fixture();
        store
            .upsert_page("wiki/synthetic.md", "synthetic", vec![(2, vector.clone())])
            .unwrap();
        let decoded = VectorStore::decode(&store.encode()).unwrap();
        assert_eq!(decoded.records[0].vector, vector);
    }
}

#[test]
fn numeric_save_rejects_invalid_store_and_preserves_prior_binary_and_legacy() {
    for (label, vector) in invalid_vectors() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("synthetic.mxv");
        let legacy = path.with_extension("json");
        let old = fixture();
        old.save(&path).unwrap();
        let before = std::fs::read(&path).unwrap();
        let legacy_before = serde_json::to_vec(&old).unwrap();
        std::fs::write(&legacy, &legacy_before).unwrap();
        let mut invalid = fixture();
        invalid.records[0].vector = vector;
        let result = invalid.save(&path);
        assert_eq!(
            std::fs::read(&path).unwrap(),
            before,
            "invalid save {label} replaced binary"
        );
        assert_eq!(
            std::fs::read(&legacy).unwrap(),
            legacy_before,
            "invalid save {label} removed legacy"
        );
        assert!(result.is_err(), "invalid save {label} must return an error");
    }
}

#[test]
fn numeric_decode_rejects_trailing_bytes_and_wrong_declared_dimension() {
    let bytes = fixture().encode();
    let mut trailing = bytes.clone();
    trailing.push(0);
    assert!(
        VectorStore::decode(&trailing).is_none(),
        "trailing payload must not decode"
    );
    let mut short_dimension = bytes;
    short_dimension[4..8].copy_from_slice(&1u32.to_le_bytes());
    assert!(
        VectorStore::decode(&short_dimension).is_none(),
        "declared width must consume the whole payload"
    );
}

#[test]
fn numeric_decode_rejects_zero_and_nonfinite_vectors() {
    for (label, vector) in invalid_vectors()
        .into_iter()
        .filter(|(_, vector)| vector.len() == 2)
    {
        let mut invalid = fixture();
        invalid.records[0].vector = vector;
        assert!(
            VectorStore::decode(&invalid.encode()).is_none(),
            "invalid encoded {label} decoded"
        );
    }
}

#[test]
fn numeric_decode_rejects_nonempty_zero_dimension_and_mixed_record_widths() {
    let mut invalid = fixture();
    invalid.dim = 0;
    invalid.records[0].vector.clear();
    assert!(
        VectorStore::decode(&invalid.encode()).is_none(),
        "nonempty zero-dimension store decoded"
    );
    let mut invalid = fixture();
    let mut extra = invalid.records[0].clone();
    extra.id = "wiki/other.md#0".into();
    extra.page = "wiki/other.md".into();
    extra.vector.push(0.25);
    invalid.records.push(extra);
    assert!(
        VectorStore::decode(&invalid.encode()).is_none(),
        "mixed record widths decoded"
    );
}

#[test]
fn numeric_legacy_json_geometry_is_rejected_by_checked_and_compatibility_reads() {
    for (label, vector) in invalid_vectors()
        .into_iter()
        .filter(|(_, vector)| vector.iter().all(|value| value.is_finite()))
    {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("synthetic.mxv");
        let legacy = path.with_extension("json");
        let mut invalid = fixture();
        invalid.records[0].vector = vector;
        let before = serde_json::to_vec(&invalid).unwrap();
        std::fs::write(&legacy, &before).unwrap();
        assert!(
            VectorStore::load_checked(&path).is_err(),
            "invalid legacy {label} accepted by authoritative load"
        );
        assert!(
            VectorStore::load(&path).records.is_empty(),
            "invalid legacy {label} entered compatibility cache"
        );
        assert_eq!(std::fs::read(&legacy).unwrap(), before);
        assert!(!path.exists());
    }
}

#[test]
fn numeric_legacy_json_rejects_mixed_widths_and_nonempty_zero_dimension() {
    let mut mixed = fixture();
    let mut extra = mixed.records[0].clone();
    extra.vector.push(0.25);
    mixed.records.push(extra);
    let mut zero_dimension = fixture();
    zero_dimension.dim = 0;
    zero_dimension.records[0].vector.clear();
    for (label, invalid) in [("mixed-widths", mixed), ("zero-dimension", zero_dimension)] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("synthetic.mxv");
        std::fs::write(
            path.with_extension("json"),
            serde_json::to_vec(&invalid).unwrap(),
        )
        .unwrap();
        assert!(
            VectorStore::load_checked(&path).is_err(),
            "invalid legacy {label} accepted"
        );
    }
}

fn empty_store_with_dimension(dim: usize) -> VectorStore {
    VectorStore {
        model: "synthetic-numeric-model".into(),
        signature: "synthetic-numeric-signature".into(),
        dim,
        records: Vec::new(),
    }
}

#[cfg(target_pointer_width = "64")]
fn assert_oversized_legacy_json_refused(dim: usize) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("synthetic.mxv");
    let legacy = path.with_extension("json");
    let before = serde_json::to_vec(&empty_store_with_dimension(dim)).unwrap();
    std::fs::write(&legacy, &before).unwrap();
    assert!(VectorStore::load_checked(&path).is_err());
    let compatibility = VectorStore::load(&path);
    assert_eq!(
        compatibility.dim, 0,
        "oversized metadata entered the compatibility cache"
    );
    assert!(compatibility.model.is_empty());
    assert!(compatibility.signature.is_empty());
    assert_eq!(std::fs::read(&legacy).unwrap(), before);
    assert!(!path.exists());
}

#[cfg(target_pointer_width = "64")]
fn assert_oversized_save_refused(dim: usize) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("synthetic.mxv");
    let legacy = path.with_extension("json");
    let old = fixture();
    old.save(&path).unwrap();
    let before = std::fs::read(&path).unwrap();
    let legacy_before = serde_json::to_vec(&old).unwrap();
    std::fs::write(&legacy, &legacy_before).unwrap();
    let invalid = empty_store_with_dimension(dim);
    let result = std::panic::catch_unwind(|| invalid.save(&path));
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert_eq!(std::fs::read(&legacy).unwrap(), legacy_before);
    assert!(
        result.is_ok(),
        "invalid metadata must produce an error, not a panic"
    );
    assert!(
        result.unwrap().is_err(),
        "oversized metadata must not be saved"
    );
}

#[cfg(target_pointer_width = "64")]
fn assert_oversized_pair_prepare_refused(dim: usize) {
    crate::settings::test_support::with_isolated_data("pair-numeric-oversized", |directory| {
        let root = directory.join("synthetic-vault");
        let mut lexical = crate::retrieval::Bm25Index::new();
        lexical.upsert_page("wiki/synthetic.md", "synthetic", &["alpha".into()]);
        let old = crate::index_publication::IndexPair {
            generation: 1,
            store: fixture(),
            lexical,
        };
        let path = crate::index_publication::PreparedPair::prepare(&root, &old)
            .unwrap()
            .commit()
            .unwrap();
        let before = std::fs::read(&path).unwrap();
        let invalid = crate::index_publication::IndexPair {
            generation: 2,
            store: empty_store_with_dimension(dim),
            lexical: crate::retrieval::Bm25Index::new(),
        };
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            crate::index_publication::PreparedPair::prepare(&root, &invalid)
        }));
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert!(
            result.is_ok(),
            "invalid metadata must produce an error, not a panic"
        );
        assert!(
            result.unwrap().is_err(),
            "oversized metadata must fail at prepare"
        );
        assert!(!path.with_extension("mxp.previous").exists());
        let current = crate::index_publication::load(&root).unwrap();
        assert_eq!(current.generation, 1);
        assert_eq!(current.store.signature, "synthetic-numeric-signature");
        assert_eq!(current.lexical.search("alpha", 1).len(), 1);
    });
}

#[cfg(target_pointer_width = "64")]
#[test]
fn numeric_oversized_empty_legacy_json_is_refused_without_removing_original() {
    assert_oversized_legacy_json_refused(usize::MAX);
}

#[cfg(target_pointer_width = "64")]
#[test]
fn numeric_u32_boundary_empty_legacy_json_is_refused_without_removing_original() {
    assert_oversized_legacy_json_refused(u32::MAX as usize + 1);
}

#[cfg(target_pointer_width = "64")]
#[test]
fn numeric_oversized_empty_save_returns_error_without_panicking_or_replacing_files() {
    assert_oversized_save_refused(usize::MAX);
}

#[cfg(target_pointer_width = "64")]
#[test]
fn numeric_u32_boundary_empty_save_returns_error_without_replacing_files() {
    assert_oversized_save_refused(u32::MAX as usize + 1);
}

#[cfg(target_pointer_width = "64")]
#[test]
fn numeric_oversized_empty_pair_prepare_returns_error_and_preserves_prior_pair() {
    assert_oversized_pair_prepare_refused(usize::MAX);
}

#[cfg(target_pointer_width = "64")]
#[test]
fn numeric_u32_boundary_empty_pair_prepare_returns_error_and_preserves_prior_pair() {
    assert_oversized_pair_prepare_refused(u32::MAX as usize + 1);
}

#[test]
fn numeric_raw_encode_does_not_overflow_preallocation_for_empty_metadata() {
    let mut dimensions = vec![usize::MAX, u32::MAX as usize];
    if let Some(dim) = (u32::MAX as usize).checked_add(1) {
        dimensions.push(dim);
    }
    for dim in dimensions {
        let store = empty_store_with_dimension(dim);
        // This unchecked codec API has no error channel. Avoiding a panic does
        // not make these bytes admissible at a persistence/publication boundary.
        assert!(std::panic::catch_unwind(|| store.encode()).is_ok());
    }
}

#[test]
fn numeric_normal_empty_dimensions_remain_valid_after_deliberate_deletion() {
    for dim in [0, 384] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("synthetic.mxv");
        let mut store = empty_store_with_dimension(dim);
        store
            .upsert_page("wiki/synthetic.md", "", Vec::new())
            .unwrap();
        assert_eq!(store.dim, dim);
        store.save(&path).unwrap();
        let decoded = VectorStore::load_checked(&path).unwrap();
        assert!(decoded.records.is_empty());
        assert_eq!(decoded.dim, dim);
        assert_eq!(decoded.signature, "synthetic-numeric-signature");
    }
}
