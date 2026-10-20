//! Native local-first regressions against settings and the public command functions.

use crate::providers::{ChatMessage, ChatRequest};
use crate::settings::{test_support::with_isolated_data, Settings};

#[test]
fn native_role_defaults_are_local_and_do_not_assume_cli_connection() {
    let settings = Settings::default();
    assert_eq!(settings.query_provider, "builtin-local");
    assert_eq!(settings.query_model, "qwen3.5-4b-q4_k_m");
    assert_eq!(settings.ingest_provider, "builtin-local");
    assert_eq!(settings.ingest_model, "qwen3.5-2b-q4_k_m");
    assert!(!settings.providers.anthropic_cli);
}

#[test]
fn native_role_corrupt_settings_is_an_error_not_an_external_default() {
    with_isolated_data("role-corrupt-settings", |dir| {
        std::fs::write(dir.join("settings.json"), "{ synthetic invalid").unwrap();
        let result = tauri::async_runtime::block_on(crate::commands::get_settings());
        assert!(
            result.is_err(),
            "unreadable/corrupt settings must remain visible"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("settings.json")).unwrap(),
            "{ synthetic invalid"
        );
    });
}

struct EndpointRestore(Option<std::ffi::OsString>);

impl Drop for EndpointRestore {
    fn drop(&mut self) {
        match &self.0 {
            Some(value) => std::env::set_var("MYCO_OLLAMA_URL", value),
            None => std::env::remove_var("MYCO_OLLAMA_URL"),
        }
    }
}

#[test]
fn native_role_unselected_route_is_rejected_before_synthetic_http() {
    with_isolated_data("role-unselected-http", |_dir| {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            use wiremock::matchers::{method, path};
            use wiremock::{Mock, MockServer, ResponseTemplate};
            let server = MockServer::start().await;
            let _restore = EndpointRestore(std::env::var_os("MYCO_OLLAMA_URL"));
            std::env::set_var("MYCO_OLLAMA_URL", server.uri());
            Mock::given(method("POST"))
                .and(path("/api/chat"))
                .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "message": {"role": "assistant", "content": "Synthetic response"},
                    "prompt_eval_count": 1,
                    "eval_count": 1
                })))
                .mount(&server)
                .await;
            // Actual native bridge, synthetic HTTP only; no keychain or model.
            let result = crate::commands::chat_complete_authorized(
                &crate::vault_session::VaultRoot::default(),
                ChatRequest {
                    provider_id: "ollama".into(),
                    model: "synthetic-unselected".into(),
                    messages: vec![ChatMessage {
                        role: "user".into(),
                        content: "Synthetic request sentinel".into(),
                    }],
                    temperature: None,
                    max_tokens: Some(8),
                },
                None,
                None,
            )
            .await;
            let requests = server.received_requests().await.unwrap();
            assert!(
                requests.is_empty(),
                "unselected native route sent {} requests",
                requests.len()
            );
            assert!(
                result.is_err(),
                "missing native role authority must fail closed"
            );
        });
    });
}
