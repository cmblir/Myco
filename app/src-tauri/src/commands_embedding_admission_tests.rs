use super::*;

fn labelled_store() -> VectorStore {
    let mut store = VectorStore::default();
    store.ensure_signature("synthetic-local:encoder", "synthetic-policy-a");
    store
        .upsert_page("wiki/synthetic.md", "synthetic", vec![(1, vec![1.0, 0.0])])
        .unwrap();
    store
}

#[tokio::test]
async fn producer_admission_absent_dense_index_does_not_resolve_or_require_a_model() {
    let store = VectorStore::default();
    let unavailable = async { panic!("empty dense index must not poll identity resolver") };
    assert!(dense_index_skip_reason(
        &store,
        Err("selected model unavailable".into()),
        unavailable
    )
    .await
    .unwrap()
    .is_some());
}

#[tokio::test]
async fn producer_admission_retired_model_does_not_resolve_replacement_weights() {
    let store = labelled_store();
    let unavailable = async { panic!("retired index must not poll replacement identity resolver") };
    assert!(dense_index_skip_reason(
        &store,
        Ok("synthetic-local:replacement".into()),
        unavailable
    )
    .await
    .unwrap()
    .is_some());
}

#[tokio::test]
async fn producer_admission_same_model_requires_checked_signature_resolution() {
    let store = labelled_store();
    assert!(
        dense_index_skip_reason(&store, Ok(store.model.clone()), async {
            Err("metadata read failure".into())
        })
        .await
        .is_err()
    );
    assert!(
        dense_index_skip_reason(&store, Ok(store.model.clone()), async {
            Ok("synthetic-policy-b".into())
        })
        .await
        .unwrap()
        .is_some()
    );
    assert!(
        dense_index_skip_reason(&store, Ok(store.model.clone()), async {
            Ok(store.signature.clone())
        })
        .await
        .unwrap()
        .is_none()
    );
}

#[test]
fn producer_admission_provider_defaults_have_one_canonical_model_identity() {
    assert_eq!(
        embedding_model_id("", "").unwrap(),
        embedding_model_id("builtin-local", crate::local_llm::BUILTIN_EMBED_MODEL).unwrap()
    );
    assert_eq!(
        embedding_model_id("ollama", "").unwrap(),
        "ollama:nomic-embed-text"
    );
    assert!(embedding_model_id("unsupported", "synthetic").is_err());
}

#[test]
fn producer_admission_same_model_weight_replacement_changes_builtin_signature() {
    let spec = crate::local_llm::embed_spec_by_id(crate::local_llm::BUILTIN_EMBED_MODEL).unwrap();
    assert_ne!(
        builtin_embedding_signature(spec, &"a".repeat(64)),
        builtin_embedding_signature(spec, &"b".repeat(64))
    );
}
