use super::*;

fn space() -> EmbeddingSpace {
    EmbeddingSpace {
        model: "synthetic-local:encoder".into(),
        signature: "synthetic-artifact-a/policy-v1".into(),
        dim: 2,
    }
}

#[test]
fn producer_admission_exact_space_and_complete_unit_batch_are_required() {
    let expected = space();
    let batch = EmbeddedBatch {
        space: expected.clone(),
        vectors: vec![vec![1.0, 0.0], vec![0.0, 1.0]],
    };
    batch.validate(&expected, 2).unwrap();
    assert!(batch.validate(&expected, 1).is_err());
    assert!(batch.validate(&expected, 3).is_err());
    for changed in [
        EmbeddingSpace {
            model: "synthetic-local:other".into(),
            ..expected.clone()
        },
        EmbeddingSpace {
            signature: "synthetic-artifact-b/policy-v1".into(),
            ..expected.clone()
        },
        EmbeddingSpace {
            dim: 3,
            ..expected.clone()
        },
    ] {
        assert!(batch.validate(&changed, 2).is_err());
    }
}

#[test]
fn producer_admission_does_not_repair_invalid_or_nonunit_output() {
    let expected = space();
    for vector in [
        vec![3.0, 4.0],
        vec![0.0, 0.0],
        vec![f32::NAN, 1.0],
        vec![1.0, 0.0, 0.0],
    ] {
        let batch = EmbeddedBatch {
            space: expected.clone(),
            vectors: vec![vec![1.0, 0.0], vector],
        };
        let before: Vec<Vec<u32>> = batch
            .vectors
            .iter()
            .map(|v| v.iter().map(|n| n.to_bits()).collect())
            .collect();
        assert!(batch.validate(&expected, 2).is_err());
        assert_eq!(
            batch
                .vectors
                .iter()
                .map(|v| v.iter().map(|n| n.to_bits()).collect::<Vec<_>>())
                .collect::<Vec<_>>(),
            before
        );
    }
}

#[test]
fn producer_admission_missing_identity_or_invalid_dimension_is_not_a_default() {
    let expected = space();
    for invalid in [
        EmbeddingSpace {
            model: " ".into(),
            ..expected.clone()
        },
        EmbeddingSpace {
            signature: "".into(),
            ..expected.clone()
        },
        EmbeddingSpace {
            dim: 0,
            ..expected.clone()
        },
        EmbeddingSpace {
            dim: u32::MAX as usize + 1,
            ..expected.clone()
        },
    ] {
        assert!(invalid.validate().is_err());
    }
    assert!(
        serde_json::from_value::<EmbeddingSpace>(serde_json::json!({"model": "synthetic"}))
            .is_err()
    );
    assert!(serde_json::from_value::<EmbeddingSpace>(
        serde_json::json!({"model": "synthetic", "signature":"policy", "dim":2, "unknown":true})
    )
    .is_err());
}

fn tags(name: &str, digest: &str) -> serde_json::Value {
    serde_json::json!({"models":[{"name":name, "digest":digest}]})
}

#[test]
fn producer_admission_ollama_identity_uses_selected_tag_manifest_digest() {
    let first = "a".repeat(64);
    let second = "B".repeat(64);
    assert_eq!(
        ollama_digest_from_tags(&tags("synthetic:latest", &first), "synthetic").unwrap(),
        first
    );
    assert_eq!(
        ollama_digest_from_tags(&tags("synthetic:latest", &second), "synthetic").unwrap(),
        second.to_lowercase()
    );
    assert_eq!(
        ollama_digest_from_tags(
            &tags("registry.invalid:5000/team/synthetic:q4", &first),
            "registry.invalid:5000/team/synthetic:q4"
        )
        .unwrap(),
        first
    );
    assert!(ollama_digest_from_tags(&tags("synthetic:q4", &first), "synthetic").is_err());
}

#[test]
fn producer_admission_ollama_identity_refuses_missing_malformed_and_ambiguous_tags() {
    let digest = "a".repeat(64);
    for body in [
        serde_json::json!({}),
        serde_json::json!({"models":null}),
        serde_json::json!({"models":[]}),
        serde_json::json!({"models":[{"model":"synthetic:latest", "digest":digest}]}),
        tags("other:latest", &digest),
        tags("synthetic:latest", ""),
        tags("synthetic:latest", &"a".repeat(63)),
        tags("synthetic:latest", &"z".repeat(64)),
        serde_json::json!({"models":[{"name":"synthetic:latest", "digest":null}]}),
        serde_json::json!({"models":[{"name":"synthetic:latest", "digest":digest}, {"name":"synthetic", "digest":digest}]}),
    ] {
        assert!(
            ollama_digest_from_tags(&body, "synthetic").is_err(),
            "accepted malformed inventory: {body}"
        );
    }
}

#[tokio::test]
async fn producer_admission_ollama_identity_route_sends_metadata_request_without_prompt() {
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};
    let server = MockServer::start().await;
    let digest = "a".repeat(64);
    Mock::given(method("GET"))
        .and(path("/api/tags"))
        .respond_with(ResponseTemplate::new(200).set_body_json(tags("synthetic:latest", &digest)))
        .expect(1)
        .mount(&server)
        .await;
    assert_eq!(
        ollama_model_digest(&server.uri(), "synthetic")
            .await
            .unwrap(),
        digest
    );
    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].body.is_empty());
    assert!(requests[0].url.query().is_none());
}

#[tokio::test]
async fn producer_admission_ollama_identity_refuses_http_decode_and_inventory_failures() {
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};
    for response in [
        ResponseTemplate::new(503),
        ResponseTemplate::new(200).set_body_string("invalid json"),
        ResponseTemplate::new(200).set_body_json(serde_json::json!({"models":[]})),
    ] {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/tags"))
            .respond_with(response)
            .expect(1)
            .mount(&server)
            .await;
        assert!(ollama_model_digest(&server.uri(), "synthetic")
            .await
            .is_err());
    }
}

#[tokio::test]
async fn producer_admission_ollama_routes_refuse_redirects_without_forwarding_requests() {
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};
    let source = MockServer::start().await;
    let target = MockServer::start().await;
    for (verb, route) in [
        ("GET", "/api/tags"),
        ("GET", "/api/version"),
        ("POST", "/api/embeddings"),
    ] {
        Mock::given(method(verb))
            .and(path(route))
            .respond_with(
                ResponseTemplate::new(307)
                    .insert_header("Location", format!("{}{route}", target.uri())),
            )
            .expect(1)
            .mount(&source)
            .await;
    }
    assert!(ollama_model_digest(&source.uri(), "synthetic")
        .await
        .is_err());
    assert!(ollama_runtime_version(&source.uri()).await.is_err());
    assert!(embed_ollama(
        &source.uri(),
        "synthetic",
        &["Synthetic test prompt".into()]
    )
    .await
    .is_err());
    assert!(target.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn producer_admission_ollama_runtime_version_is_checked_metadata_without_prompt() {
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/version"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"version":"0.5.1-synthetic"})),
        )
        .expect(1)
        .mount(&server)
        .await;
    assert_eq!(
        ollama_runtime_version(&server.uri()).await.unwrap(),
        "0.5.1-synthetic"
    );
    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].body.is_empty());
    assert!(requests[0].url.query().is_none());
}

#[tokio::test]
async fn producer_admission_ollama_runtime_version_cannot_be_missing_or_malformed() {
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};
    for body in [
        serde_json::json!({}),
        serde_json::json!({"version":null}),
        serde_json::json!({"version":12}),
        serde_json::json!({"version":""}),
        serde_json::json!({"version":" "}),
        serde_json::json!({"version":"0.5.1:extra"}),
        serde_json::json!({"version":"a".repeat(129)}),
    ] {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/version"))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .expect(1)
            .mount(&server)
            .await;
        assert!(ollama_runtime_version(&server.uri()).await.is_err());
    }
}
