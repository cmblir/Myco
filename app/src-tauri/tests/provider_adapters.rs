// End-to-end HTTP adapter tests. Each test stands up a local wiremock
// server, points the corresponding MEMEX_*_URL env var at it, and asserts
// both the outgoing request shape and the parsed response.

use memex_lib::providers::{chat_complete, list_models, ChatMessage, ChatRequest};
use serde_json::json;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

// Mirrors providers::MAX_RESPONSE_BYTES (32 MB). Kept local because the constant
// is private to the provider module.
const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;

fn user_msg(text: &str) -> ChatMessage {
    ChatMessage {
        role: "user".into(),
        content: text.into(),
    }
}

fn system_msg(text: &str) -> ChatMessage {
    ChatMessage {
        role: "system".into(),
        content: text.into(),
    }
}

// ---------- Anthropic ----------

#[tokio::test]
#[serial_test::serial]
async fn anthropic_chat_parses_text_content_and_usage() {
    let server = MockServer::start().await;
    std::env::set_var(
        "MEMEX_ANTHROPIC_URL",
        format!("{}/v1/messages", server.uri()),
    );

    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .and(header("x-api-key", "test-key"))
        .and(header("anthropic-version", "2023-06-01"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "msg_01",
            "type": "message",
            "role": "assistant",
            "content": [
                { "type": "text", "text": "Hello back." },
                { "type": "tool_use", "id": "t1", "name": "noop", "input": {} },
                { "type": "text", "text": " More text." }
            ],
            "model": "claude-sonnet-4-6",
            "usage": { "input_tokens": 7, "output_tokens": 12 }
        })))
        .expect(1)
        .mount(&server)
        .await;

    let req = ChatRequest {
        provider_id: "anthropic-api".into(),
        model: "claude-sonnet-4-6".into(),
        messages: vec![system_msg("be terse"), user_msg("hi")],
        temperature: Some(0.3),
        max_tokens: Some(200),
    };
    let resp = chat_complete(req, Some("test-key".into())).await.unwrap();
    assert_eq!(resp.content, "Hello back. More text.");
    let u = resp.usage.unwrap();
    assert_eq!(u.input_tokens, 7);
    assert_eq!(u.output_tokens, 12);
}

#[tokio::test]
#[serial_test::serial]
async fn anthropic_missing_key_errors_immediately() {
    let req = ChatRequest {
        provider_id: "anthropic-api".into(),
        model: "claude-haiku-4-5".into(),
        messages: vec![user_msg("hi")],
        temperature: None,
        max_tokens: None,
    };
    let res = chat_complete(req, None).await;
    assert!(res.is_err());
    assert!(res.unwrap_err().contains("missing Anthropic API key"));
}

#[tokio::test]
#[serial_test::serial]
async fn anthropic_propagates_http_error_with_body() {
    let server = MockServer::start().await;
    std::env::set_var(
        "MEMEX_ANTHROPIC_URL",
        format!("{}/v1/messages", server.uri()),
    );
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(ResponseTemplate::new(401).set_body_string(
            r#"{"type":"error","error":{"type":"authentication_error","message":"bad key"}}"#,
        ))
        .mount(&server)
        .await;

    let req = ChatRequest {
        provider_id: "anthropic-api".into(),
        model: "claude-haiku-4-5".into(),
        messages: vec![user_msg("hi")],
        temperature: None,
        max_tokens: None,
    };
    let err = chat_complete(req, Some("bad".into())).await.unwrap_err();
    assert!(err.contains("401"));
    assert!(err.contains("authentication_error"));
}

// ---------- OpenAI ----------

#[tokio::test]
#[serial_test::serial]
async fn openai_chat_parses_choices() {
    let server = MockServer::start().await;
    std::env::set_var(
        "MEMEX_OPENAI_URL",
        format!("{}/v1/chat/completions", server.uri()),
    );
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(header("authorization", "Bearer sk-test"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "chatcmpl-1",
            "choices": [{
                "message": { "role": "assistant", "content": "Hi from gpt." }
            }],
            "usage": { "prompt_tokens": 3, "completion_tokens": 5, "total_tokens": 8 }
        })))
        .mount(&server)
        .await;

    let req = ChatRequest {
        provider_id: "openai-api".into(),
        model: "gpt-4o-mini".into(),
        messages: vec![user_msg("ping")],
        temperature: None,
        max_tokens: None,
    };
    let resp = chat_complete(req, Some("sk-test".into())).await.unwrap();
    assert_eq!(resp.content, "Hi from gpt.");
    let u = resp.usage.unwrap();
    assert_eq!(u.input_tokens, 3);
    assert_eq!(u.output_tokens, 5);
}

#[tokio::test]
#[serial_test::serial]
async fn openai_list_models_filters_to_chat_capable() {
    let server = MockServer::start().await;
    std::env::set_var(
        "MEMEX_OPENAI_MODELS_URL",
        format!("{}/v1/models", server.uri()),
    );
    Mock::given(method("GET"))
        .and(path("/v1/models"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "data": [
                { "id": "gpt-4o" },
                { "id": "gpt-4o-mini" },
                { "id": "o1-preview" },
                { "id": "o3-mini" },
                { "id": "text-embedding-3-small" },
                { "id": "dall-e-3" },
                { "id": "whisper-1" }
            ]
        })))
        .mount(&server)
        .await;
    let models = list_models("openai-api", Some("sk-test".into()))
        .await
        .unwrap();
    assert!(models.contains(&"gpt-4o".into()));
    assert!(models.contains(&"gpt-4o-mini".into()));
    assert!(models.contains(&"o1-preview".into()));
    assert!(models.contains(&"o3-mini".into()));
    assert!(!models.contains(&"text-embedding-3-small".into()));
    assert!(!models.contains(&"dall-e-3".into()));
    assert!(!models.contains(&"whisper-1".into()));
}

// ---------- OpenRouter (OpenAI-compatible) ----------

#[tokio::test]
#[serial_test::serial]
async fn openrouter_chat_uses_openrouter_url() {
    let server = MockServer::start().await;
    std::env::set_var(
        "MEMEX_OPENROUTER_URL",
        format!("{}/api/v1/chat/completions", server.uri()),
    );
    Mock::given(method("POST"))
        .and(path("/api/v1/chat/completions"))
        .and(header("authorization", "Bearer sk-or-test"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "choices": [{ "message": { "role": "assistant", "content": "via openrouter" } }]
        })))
        .mount(&server)
        .await;
    let req = ChatRequest {
        provider_id: "openrouter".into(),
        model: "meta-llama/llama-3.1-70b-instruct".into(),
        messages: vec![user_msg("hi")],
        temperature: None,
        max_tokens: None,
    };
    let resp = chat_complete(req, Some("sk-or-test".into())).await.unwrap();
    assert_eq!(resp.content, "via openrouter");
}

#[tokio::test]
#[serial_test::serial]
async fn openrouter_list_models_takes_top_80() {
    let server = MockServer::start().await;
    std::env::set_var(
        "MEMEX_OPENROUTER_MODELS_URL",
        format!("{}/api/v1/models", server.uri()),
    );
    let many: Vec<serde_json::Value> = (0..120)
        .map(|i| json!({ "id": format!("model-{i:03}") }))
        .collect();
    Mock::given(method("GET"))
        .and(path("/api/v1/models"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "data": many })))
        .mount(&server)
        .await;
    let models = list_models("openrouter", None).await.unwrap();
    assert_eq!(models.len(), 80);
}

// ---------- Google Gemini ----------

#[tokio::test]
#[serial_test::serial]
async fn google_chat_uses_system_instruction_and_concatenates_parts() {
    let server = MockServer::start().await;
    std::env::set_var(
        "MEMEX_GOOGLE_URL",
        format!("{}/v1beta/models", server.uri()),
    );
    Mock::given(method("POST"))
        .and(path("/v1beta/models/gemini-2.0-flash:generateContent"))
        // The key must travel in the x-goog-api-key header, never the URL query
        // (a query-string key leaks into reqwest error strings). The mock only
        // matches when the header is present.
        .and(header("x-goog-api-key", "gkey"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "candidates": [{
                "content": {
                    "role": "model",
                    "parts": [{ "text": "part-a " }, { "text": "part-b" }]
                }
            }],
            "usageMetadata": {
                "promptTokenCount": 9,
                "candidatesTokenCount": 4
            }
        })))
        .mount(&server)
        .await;
    let req = ChatRequest {
        provider_id: "google-api".into(),
        model: "gemini-2.0-flash".into(),
        messages: vec![system_msg("be brief"), user_msg("hi")],
        temperature: None,
        max_tokens: Some(64),
    };
    let resp = chat_complete(req, Some("gkey".into())).await.unwrap();
    assert_eq!(resp.content, "part-a part-b");
    let u = resp.usage.unwrap();
    assert_eq!(u.input_tokens, 9);
    assert_eq!(u.output_tokens, 4);
}

// ---------- Ollama ----------

#[tokio::test]
#[serial_test::serial]
async fn ollama_chat_returns_content_and_token_counts() {
    let server = MockServer::start().await;
    std::env::set_var("MEMEX_OLLAMA_URL", server.uri());
    Mock::given(method("POST"))
        .and(path("/api/chat"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "model": "llama3.2:3b",
            "message": { "role": "assistant", "content": "local hello" },
            "done": true,
            "prompt_eval_count": 11,
            "eval_count": 22
        })))
        .mount(&server)
        .await;
    let req = ChatRequest {
        provider_id: "ollama".into(),
        model: "llama3.2:3b".into(),
        messages: vec![user_msg("hi")],
        temperature: Some(0.0),
        max_tokens: Some(128),
    };
    let resp = chat_complete(req, None).await.unwrap();
    assert_eq!(resp.content, "local hello");
    let u = resp.usage.unwrap();
    assert_eq!(u.input_tokens, 11);
    assert_eq!(u.output_tokens, 22);
}

#[tokio::test]
#[serial_test::serial]
async fn ollama_list_models_parses_tags() {
    let server = MockServer::start().await;
    std::env::set_var("MEMEX_OLLAMA_URL", server.uri());
    Mock::given(method("GET"))
        .and(path("/api/tags"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "models": [
                { "name": "llama3.2:1b", "size": 770_000_000_u64 },
                { "name": "qwen2.5:7b",  "size": 4_700_000_000_u64 }
            ]
        })))
        .mount(&server)
        .await;
    let models = list_models("ollama", None).await.unwrap();
    assert_eq!(
        models,
        vec!["llama3.2:1b".to_string(), "qwen2.5:7b".to_string()]
    );
}

// ---------- Provider selection ----------

#[tokio::test]
#[serial_test::serial]
async fn unknown_provider_returns_error() {
    let req = ChatRequest {
        provider_id: "mystery".into(),
        model: "x".into(),
        messages: vec![user_msg("hi")],
        temperature: None,
        max_tokens: None,
    };
    let err = chat_complete(req, None).await.unwrap_err();
    assert!(err.contains("unsupported provider"));
}

#[tokio::test]
#[serial_test::serial]
async fn anthropic_static_model_catalog() {
    let models = list_models("anthropic-api", Some("k".into()))
        .await
        .unwrap();
    assert!(models.iter().any(|m| m.starts_with("claude-")));
    assert!(models.contains(&"claude-sonnet-4-6".into()));
}

#[tokio::test]
#[serial_test::serial]
async fn google_static_model_catalog() {
    let models = list_models("google-api", Some("k".into())).await.unwrap();
    assert!(models.iter().any(|m| m.starts_with("gemini-")));
}

// ---------- Robustness: response body cap ----------

#[tokio::test]
#[serial_test::serial]
async fn chat_rejects_over_cap_response_body() {
    let server = MockServer::start().await;
    std::env::set_var(
        "MEMEX_OPENAI_URL",
        format!("{}/v1/chat/completions", server.uri()),
    );
    // A body one byte past the cap must be rejected before we attempt to parse
    // it, guarding against a hostile endpoint OOMing the app.
    let oversized = "x".repeat(MAX_RESPONSE_BYTES + 1);
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_string(oversized))
        .mount(&server)
        .await;

    let req = ChatRequest {
        provider_id: "openai-api".into(),
        model: "gpt-4o-mini".into(),
        messages: vec![user_msg("hi")],
        temperature: None,
        max_tokens: None,
    };
    let err = chat_complete(req, Some("sk-test".into()))
        .await
        .unwrap_err();
    assert!(
        err.contains("too large"),
        "expected size-cap error, got: {err}"
    );
}

// ---------- Robustness: retry on transient failure ----------

#[tokio::test]
#[serial_test::serial]
async fn chat_retries_503_then_succeeds() {
    let server = MockServer::start().await;
    std::env::set_var(
        "MEMEX_OPENAI_URL",
        format!("{}/v1/chat/completions", server.uri()),
    );
    // First attempt: a transient 503. wiremock serves mounts in priority order
    // and `up_to_n_times` retires a mock after N matches, so the 503 answers the
    // first request and the 200 answers the retry.
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(503).set_body_string("service unavailable"))
        .up_to_n_times(1)
        .with_priority(1)
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "choices": [{ "message": { "role": "assistant", "content": "recovered" } }]
        })))
        .with_priority(2)
        .expect(1)
        .mount(&server)
        .await;

    let req = ChatRequest {
        provider_id: "openai-api".into(),
        model: "gpt-4o-mini".into(),
        messages: vec![user_msg("hi")],
        temperature: None,
        max_tokens: None,
    };
    let resp = chat_complete(req, Some("sk-test".into())).await.unwrap();
    assert_eq!(resp.content, "recovered");
}

#[tokio::test]
#[serial_test::serial]
async fn chat_does_not_retry_4xx_auth_error() {
    let server = MockServer::start().await;
    std::env::set_var(
        "MEMEX_OPENAI_URL",
        format!("{}/v1/chat/completions", server.uri()),
    );
    // A 401 is a hard auth failure; we must fail fast and hit the endpoint
    // exactly once (no wasted retries).
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(401).set_body_string("bad key"))
        .expect(1)
        .mount(&server)
        .await;

    let req = ChatRequest {
        provider_id: "openai-api".into(),
        model: "gpt-4o-mini".into(),
        messages: vec![user_msg("hi")],
        temperature: None,
        max_tokens: None,
    };
    let err = chat_complete(req, Some("sk-test".into()))
        .await
        .unwrap_err();
    assert!(err.contains("401"), "expected 401 error, got: {err}");
}
