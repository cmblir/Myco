//! Native image authority regressions use synthetic files and loopback only.

use super::{DescribeImageRequest, Failure, FailureCode, ImageIngestState};
use crate::role_authorization::{self, RoleId, RoleSelectionRequest, RoleSnapshot, RoleUsage};
use crate::vault_session::{AgentVaultSession, VaultRoot};
use keyring::credential::{Credential, CredentialApi, CredentialBuilderApi, CredentialPersistence};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

const IMAGE_BYTES: &[u8] = b"synthetic image bytes";
const IMAGE_BASE64: &str = "c3ludGhldGljIGltYWdlIGJ5dGVz";

fn opened_vault(root: &Path) -> (Arc<VaultRoot>, AgentVaultSession) {
    let vault = Arc::new(VaultRoot::default());
    let generation = vault.begin_open().unwrap();
    vault
        .finish_open(generation, root.canonicalize().unwrap(), || ())
        .unwrap();
    let origin = vault.snapshot().unwrap();
    (vault, origin)
}

fn capture(
    vault: &VaultRoot,
    origin: &AgentVaultSession,
    role: RoleId,
    usage: RoleUsage,
) -> RoleSnapshot {
    vault
        .with_origin(origin, |_| {
            role_authorization::capture_role_at(origin, role, usage)
                .map_err(|error| error.to_string())
        })
        .unwrap()
}

fn select(role: RoleId, provider: &str, model: &str) {
    role_authorization::select_role(RoleSelectionRequest {
        role,
        provider_id: provider.into(),
        model_id: model.into(),
        effort: "(default)".into(),
        expected_authorization_revision: role_authorization::settings_snapshot()
            .unwrap()
            .role_authorization_revision,
    })
    .unwrap();
}

fn connect_providers() {
    let mut settings = crate::settings::read_checked().unwrap();
    settings.providers.openai_api = true;
    settings.providers.anthropic_api = true;
    settings.providers.google_api = true;
    crate::settings::save(&settings).unwrap();
}

fn request(
    path: &Path,
    origin: &AgentVaultSession,
    snapshot: RoleSnapshot,
    id: &str,
) -> DescribeImageRequest {
    DescribeImageRequest {
        path: path.to_string_lossy().into_owned(),
        prompt: "Describe the synthetic fixture.".into(),
        origin: origin.clone(),
        role_snapshot: snapshot,
        request_id: id.into(),
    }
}

fn synthetic_state() -> (ImageIngestState, Arc<AtomicUsize>) {
    let reads = Arc::new(AtomicUsize::new(0));
    let observed = reads.clone();
    (
        ImageIngestState::with_credential_resolver(Arc::new(move |_| {
            observed.fetch_add(1, Ordering::SeqCst);
            Ok(Some("synthetic-image-key".into()))
        })),
        reads,
    )
}

fn assert_failure(result: Result<String, Failure>, code: FailureCode) {
    let failure = result.unwrap_err();
    assert_eq!(failure.code, code);
    assert_eq!(
        serde_json::to_value(failure).unwrap(),
        serde_json::json!({
            "version":"ImageIngestFailureV1", "code":code.as_str()
        })
    );
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

async fn mount_response(server: &wiremock::MockServer, provider: &str, text: &str) {
    use wiremock::matchers::method;
    use wiremock::{Mock, ResponseTemplate};
    let body = match provider {
        "openai-api" => serde_json::json!({"choices":[{"message":{"content":text}}]}),
        "anthropic-api" => serde_json::json!({"content":[{"type":"text","text":text}]}),
        "google-api" => serde_json::json!({"candidates":[{"content":{"parts":[{"text":text}]}}]}),
        _ => panic!("unknown synthetic provider"),
    };
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(body))
        .mount(server)
        .await;
}

struct SyntheticCredential {
    inner: keyring::mock::MockCredential,
    reads: Arc<AtomicUsize>,
}

impl CredentialApi for SyntheticCredential {
    fn set_secret(&self, secret: &[u8]) -> keyring::Result<()> {
        self.inner.set_secret(secret)
    }

    fn get_secret(&self) -> keyring::Result<Vec<u8>> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        self.inner.get_secret()
    }

    fn delete_credential(&self) -> keyring::Result<()> {
        self.inner.delete_credential()
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

struct SyntheticCredentialBuilder {
    builds: Arc<AtomicUsize>,
    reads: Arc<AtomicUsize>,
}

impl CredentialBuilderApi for SyntheticCredentialBuilder {
    fn build(
        &self,
        target: Option<&str>,
        service: &str,
        user: &str,
    ) -> keyring::Result<Box<Credential>> {
        self.builds.fetch_add(1, Ordering::SeqCst);
        assert_eq!(target, None);
        assert_eq!(service, "dev.cmblir.myco");
        assert_eq!(user, "openai-api");
        // Each Entry receives its own seeded in-memory credential. The mock
        // store is EntryOnly; seeding a different Entry would not persist it.
        let inner = keyring::mock::MockCredential::default();
        inner.set_password("synthetic-image-key")?;
        Ok(Box::new(SyntheticCredential {
            inner,
            reads: self.reads.clone(),
        }))
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn persistence(&self) -> CredentialPersistence {
        CredentialPersistence::EntryOnly
    }
}

struct RestoreCredentialBuilder;

impl Drop for RestoreCredentialBuilder {
    fn drop(&mut self) {
        // Construction does not read the platform keychain. Run this RED alone
        // in a fresh filtered process so no unrelated Entry can race the seam.
        keyring::set_default_credential_builder(keyring::default::default_credential_builder());
    }
}

struct RestoreEndpoints(Vec<(&'static str, Option<std::ffi::OsString>)>);

impl RestoreEndpoints {
    fn loopback(uri: &str) -> Self {
        let names = [
            "MYCO_OPENAI_URL",
            "MYCO_ANTHROPIC_URL",
            "MYCO_GOOGLE_URL",
            "MEMEX_OPENAI_URL",
            "MEMEX_ANTHROPIC_URL",
            "MEMEX_GOOGLE_URL",
        ];
        let saved = names
            .into_iter()
            .map(|name| {
                let previous = std::env::var_os(name);
                std::env::set_var(name, uri);
                (name, previous)
            })
            .collect();
        Self(saved)
    }
}

impl Drop for RestoreEndpoints {
    fn drop(&mut self) {
        for (name, previous) in &self.0 {
            match previous {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
    }
}

#[test]
fn native_manual_image_legacy_query_does_not_send_without_compilation_consent() {
    crate::settings::test_support::with_isolated_data("image-legacy-query-no-send", |dir| {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            use wiremock::matchers::{method, path};
            use wiremock::{Mock, MockServer, ResponseTemplate};

            let server = MockServer::start().await;
            let _endpoints = RestoreEndpoints::loopback(&server.uri());
            Mock::given(method("POST"))
                .and(path("/"))
                .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "choices": [{"message": {"content": "Synthetic image description"}}]
                })))
                .mount(&server)
                .await;

            let builds = Arc::new(AtomicUsize::new(0));
            let reads = Arc::new(AtomicUsize::new(0));
            keyring::set_default_credential_builder(Box::new(SyntheticCredentialBuilder {
                builds: builds.clone(),
                reads: reads.clone(),
            }));
            let _credentials = RestoreCredentialBuilder;

            let mut settings = crate::settings::Settings::default();
            settings.providers.openai_api = true;
            settings.query_provider = "openai-api".into();
            settings.query_model = "gpt-5.4-mini".into();
            crate::settings::save(&settings).unwrap();
            let selected = crate::settings::read_checked().unwrap();
            assert_eq!(
                selected.model_roles.roles[&crate::role_authorization::RoleId::Compilation]
                    .provider_id,
                "builtin-local"
            );

            let image = dir.join("synthetic.png");
            let image_bytes = b"synthetic image bytes";
            std::fs::write(&image, image_bytes).unwrap();
            // The original four-argument call and its observed RED are archived.
            // Keep the exact no-send assertions through the authorized bridge.
            let (vault, origin) = opened_vault(dir);
            let snapshot = capture(&vault, &origin, RoleId::Compilation, RoleUsage::Foreground);
            let images = ImageIngestState::default();
            let result = crate::commands::describe_image_authorized(
                &vault,
                &images,
                request(&image, &origin, snapshot, "legacy-query"),
            )
            .await;

            let observed = (
                server.received_requests().await.unwrap().len(),
                reads.load(Ordering::SeqCst),
                builds.load(Ordering::SeqCst),
                result.is_err(),
            );
            eprintln!(
                "IMAGE_INGEST_ORIGINAL_BEHAVIOR: {}",
                serde_json::json!({
                    "httpPosts": observed.0,
                    "credentialReads": observed.1,
                    "credentialBuilds": observed.2,
                    "returnedError": observed.3,
                    "credentials": "custom in-memory builder; no OS keyring lookup",
                    "transport": "synthetic loopback only",
                    "compilation": "builtin-local"
                })
            );
            assert_eq!(std::fs::read(&image).unwrap(), image_bytes);
            assert_eq!(
                observed,
                (0, 0, 0, true),
                "legacy Query/provider input must not authorize image transmission"
            );
        });
    });
}

#[test]
fn native_manual_image_dto_is_closed_and_requires_bound_authority() {
    crate::settings::test_support::with_isolated_data("image-dto", |dir| {
        let (vault, origin) = opened_vault(dir);
        let snapshot = capture(&vault, &origin, RoleId::Compilation, RoleUsage::Foreground);
        let valid = serde_json::json!({"path":dir.join("synthetic.png"),"prompt":"Synthetic prompt",
            "origin":origin,"roleSnapshot":snapshot,"requestId":"synthetic-id"});
        assert!(serde_json::from_value::<DescribeImageRequest>(valid.clone()).is_ok());
        for field in ["path", "prompt", "origin", "roleSnapshot", "requestId"] {
            let mut missing = valid.clone();
            missing.as_object_mut().unwrap().remove(field);
            assert!(
                serde_json::from_value::<DescribeImageRequest>(missing).is_err(),
                "missing {field}"
            );
            let mut null = valid.clone();
            null[field] = serde_json::Value::Null;
            assert!(
                serde_json::from_value::<DescribeImageRequest>(null).is_err(),
                "null {field}"
            );
        }
        for field in ["provider", "model", "providerId", "modelId", "unknown"] {
            let mut extra = valid.clone();
            extra[field] = "synthetic extra".into();
            assert!(
                serde_json::from_value::<DescribeImageRequest>(extra).is_err(),
                "extra {field}"
            );
        }
    });
}

#[test]
fn native_manual_image_denied_grants_touch_no_file_key_or_http() {
    crate::settings::test_support::with_isolated_data("image-denied-grants", |dir| {
        runtime().block_on(async {
            let server = wiremock::MockServer::start().await;
            let _endpoints = RestoreEndpoints::loopback(&server.uri());
            connect_providers();
            let (vault, origin) = opened_vault(dir);
            let path = dir.join("must-not-be-opened.png");
            let (images, key_reads) = synthetic_state();
            select(RoleId::Ask, "openai-api", "gpt-5.4-mini");
            let ask = capture(&vault, &origin, RoleId::Ask, RoleUsage::Foreground);
            assert_failure(
                crate::commands::describe_image_authorized(
                    &vault,
                    &images,
                    request(&path, &origin, ask, "wrong-role"),
                )
                .await,
                FailureCode::RoleAuthorizationFailed,
            );

            select(RoleId::Compilation, "openai-api", "gpt-5.4-mini");
            role_authorization::set_automatic(
                RoleId::Compilation,
                true,
                &role_authorization::settings_snapshot()
                    .unwrap()
                    .role_authorization_revision,
            )
            .unwrap();
            let automatic = capture(&vault, &origin, RoleId::Compilation, RoleUsage::Automatic);
            assert_failure(
                crate::commands::describe_image_authorized(
                    &vault,
                    &images,
                    request(&path, &origin, automatic, "wrong-usage"),
                )
                .await,
                FailureCode::RoleAuthorizationFailed,
            );
            let valid = capture(&vault, &origin, RoleId::Compilation, RoleUsage::Foreground);
            let mut forged = valid.clone();
            forged.snapshot_id = "synthetic-forged-id".into();
            assert_failure(
                crate::commands::describe_image_authorized(
                    &vault,
                    &images,
                    request(&path, &origin, forged, "forged"),
                )
                .await,
                FailureCode::RoleAuthorizationFailed,
            );
            let mut wrong_origin = origin.clone();
            wrong_origin.opening_token = "synthetic-foreign-opening".into();
            assert_failure(
                crate::commands::describe_image_authorized(
                    &vault,
                    &images,
                    request(&path, &wrong_origin, valid.clone(), "wrong-origin"),
                )
                .await,
                FailureCode::RoleAuthorizationFailed,
            );
            select(RoleId::Compilation, "openai-api", "gpt-5.4-mini");
            assert_failure(
                crate::commands::describe_image_authorized(
                    &vault,
                    &images,
                    request(&path, &origin, valid, "stale"),
                )
                .await,
                FailureCode::RoleAuthorizationFailed,
            );
            let disconnected = capture(&vault, &origin, RoleId::Compilation, RoleUsage::Foreground);
            let mut settings = crate::settings::read_checked().unwrap();
            settings.providers.openai_api = false;
            crate::settings::save(&settings).unwrap();
            assert_failure(
                crate::commands::describe_image_authorized(
                    &vault,
                    &images,
                    request(&path, &origin, disconnected, "disconnected"),
                )
                .await,
                FailureCode::RoleAuthorizationFailed,
            );
            assert_eq!(images.read_attempts(), 0);
            assert_eq!(key_reads.load(Ordering::SeqCst), 0);
            assert!(server.received_requests().await.unwrap().is_empty());
            assert_eq!(images.active_count(), 0);
        })
    });
}

#[test]
fn native_manual_image_unverified_capability_has_no_fallback() {
    crate::settings::test_support::with_isolated_data("image-capabilities", |dir| {
        runtime().block_on(async {
            let server = wiremock::MockServer::start().await;
            let _endpoints = RestoreEndpoints::loopback(&server.uri());
            connect_providers();
            let (vault, origin) = opened_vault(dir);
            let (images, key_reads) = synthetic_state();
            let path = dir.join("must-not-be-opened.png");
            for (id, choice) in [
                ("connected-only", None),
                ("unknown-exact-id", Some("gpt-5.4-mini-synthetic")),
            ] {
                if let Some(model) = choice {
                    select(RoleId::Compilation, "openai-api", model);
                }
                let snapshot = capture(&vault, &origin, RoleId::Compilation, RoleUsage::Foreground);
                assert_failure(
                    crate::commands::describe_image_authorized(
                        &vault,
                        &images,
                        request(&path, &origin, snapshot, id),
                    )
                    .await,
                    FailureCode::CapabilityUnavailable,
                );
            }
            assert_eq!(images.read_attempts(), 0);
            assert_eq!(key_reads.load(Ordering::SeqCst), 0);
            assert!(server.received_requests().await.unwrap().is_empty());
            assert_eq!(images.active_count(), 0);
            assert!(!super::capabilities::supports(
                "openai-api",
                "gpt-5.4-mini-synthetic"
            ));
            assert!(!super::capabilities::supports(
                "synthetic-provider",
                "gpt-5.4-mini"
            ));
            assert!(!super::capabilities::supports(
                "builtin-local",
                "qwen3.5-2b-q4_k_m"
            ));
        })
    });
}

#[test]
fn native_manual_image_authorized_routes_preserve_three_provider_payloads() {
    crate::settings::test_support::with_isolated_data("image-positive-routes", |dir| {
        runtime().block_on(async {
            let server = wiremock::MockServer::start().await;
            let _endpoints = RestoreEndpoints::loopback(&server.uri());
            connect_providers();
            let (vault, origin) = opened_vault(dir);
            let path = dir.join("synthetic.png");
            std::fs::write(&path, IMAGE_BYTES).unwrap();
            let (images, key_reads) = synthetic_state();
            for (provider, model) in [
                ("openai-api", "gpt-5.4-mini"),
                ("anthropic-api", "claude-haiku-4-5"),
                ("google-api", "gemini-2.5-flash"),
            ] {
                server.reset().await;
                mount_response(&server, provider, "Synthetic image description").await;
                select(RoleId::Compilation, provider, model);
                let snapshot = capture(&vault, &origin, RoleId::Compilation, RoleUsage::Foreground);
                #[cfg(unix)]
                let selected_path = if provider == "openai-api" {
                    let alias = dir.join("synthetic-alias.png");
                    std::os::unix::fs::symlink(&path, &alias).unwrap();
                    alias
                } else {
                    path.clone()
                };
                #[cfg(not(unix))]
                let selected_path = path.clone();
                let answer = crate::commands::describe_image_authorized(
                    &vault,
                    &images,
                    request(&selected_path, &origin, snapshot, provider),
                )
                .await
                .unwrap();
                assert_eq!(answer, "Synthetic image description");
                let posts = server.received_requests().await.unwrap();
                assert_eq!(posts.len(), 1);
                let body: serde_json::Value = serde_json::from_slice(&posts[0].body).unwrap();
                match provider {
                    "openai-api" => {
                        assert_eq!(body["model"], model);
                        assert_eq!(
                            body["messages"][0]["content"][0]["text"],
                            "Describe the synthetic fixture."
                        );
                        assert_eq!(
                            body["messages"][0]["content"][1]["image_url"]["url"],
                            format!("data:image/png;base64,{IMAGE_BASE64}")
                        );
                    }
                    "anthropic-api" => {
                        assert_eq!(body["model"], model);
                        assert_eq!(
                            body["messages"][0]["content"][0]["source"]["media_type"],
                            "image/png"
                        );
                        assert_eq!(
                            body["messages"][0]["content"][0]["source"]["data"],
                            IMAGE_BASE64
                        );
                        assert_eq!(
                            body["messages"][0]["content"][1]["text"],
                            "Describe the synthetic fixture."
                        );
                    }
                    "google-api" => {
                        assert_eq!(posts[0].url.path(), "/gemini-2.5-flash:generateContent");
                        assert_eq!(
                            body["contents"][0]["parts"][0]["inline_data"]["mime_type"],
                            "image/png"
                        );
                        assert_eq!(
                            body["contents"][0]["parts"][0]["inline_data"]["data"],
                            IMAGE_BASE64
                        );
                        assert_eq!(
                            body["contents"][0]["parts"][1]["text"],
                            "Describe the synthetic fixture."
                        );
                    }
                    _ => unreachable!(),
                }
                assert_eq!(std::fs::read(&path).unwrap(), IMAGE_BYTES);
                assert_eq!(images.active_count(), 0);
            }
            assert_eq!(images.read_attempts(), 3);
            assert_eq!(key_reads.load(Ordering::SeqCst), 3);
        })
    });
}

#[test]
fn native_manual_image_invalid_files_and_requests_are_bounded_and_private() {
    crate::settings::test_support::with_isolated_data("image-file-errors", |dir| {
        runtime().block_on(async {
            let server = wiremock::MockServer::start().await;
            let _endpoints = RestoreEndpoints::loopback(&server.uri());
            connect_providers();
            select(RoleId::Compilation, "openai-api", "gpt-5.4-mini");
            let (vault, origin) = opened_vault(dir);
            let snapshot = capture(&vault, &origin, RoleId::Compilation, RoleUsage::Foreground);
            let (images, key_reads) = synthetic_state();
            let empty = dir.join("empty.png");
            std::fs::write(&empty, []).unwrap();
            let large = dir.join("large.png");
            std::fs::File::create(&large)
                .unwrap()
                .set_len(super::MAX_IMAGE_BYTES + 1)
                .unwrap();
            let directory = dir.join("directory.png");
            std::fs::create_dir(&directory).unwrap();
            for (id, path, code) in [
                (
                    "missing",
                    dir.join("missing.png"),
                    FailureCode::ImageReadFailed,
                ),
                ("empty", empty, FailureCode::ImageReadFailed),
                ("large", large, FailureCode::ImageTooLarge),
                ("directory", directory, FailureCode::ImageReadFailed),
            ] {
                assert_failure(
                    crate::commands::describe_image_authorized(
                        &vault,
                        &images,
                        request(&path, &origin, snapshot.clone(), id),
                    )
                    .await,
                    code,
                );
            }
            let before = images.read_attempts();
            for id in ["", "invalid/id"] {
                assert_failure(
                    crate::commands::describe_image_authorized(
                        &vault,
                        &images,
                        request(&dir.join("missing.png"), &origin, snapshot.clone(), id),
                    )
                    .await,
                    FailureCode::InvalidRequest,
                );
            }
            let mut invalid = request(&dir.join("missing.png"), &origin, snapshot, "relative");
            invalid.path = "synthetic-relative.png".into();
            assert_failure(
                crate::commands::describe_image_authorized(&vault, &images, invalid).await,
                FailureCode::InvalidRequest,
            );
            assert_eq!(images.read_attempts(), before);
            assert_eq!(key_reads.load(Ordering::SeqCst), 0);
            assert!(server.received_requests().await.unwrap().is_empty());
            assert_eq!(images.active_count(), 0);
        })
    });
}

#[test]
fn native_manual_image_credential_and_transport_errors_are_sanitized() {
    crate::settings::test_support::with_isolated_data("image-private-errors", |dir| {
        runtime().block_on(async {
            let server = wiremock::MockServer::start().await;
            let _endpoints = RestoreEndpoints::loopback(&server.uri());
            connect_providers();
            select(RoleId::Compilation, "openai-api", "gpt-5.4-mini");
            let (vault, origin) = opened_vault(dir);
            let snapshot = capture(&vault, &origin, RoleId::Compilation, RoleUsage::Foreground);
            let path = dir.join("synthetic.png");
            std::fs::write(&path, IMAGE_BYTES).unwrap();
            for (id, key) in [("missing-key", None), ("empty-key", Some(" ".to_string()))] {
                let images =
                    ImageIngestState::with_credential_resolver(Arc::new(move |_| Ok(key.clone())));
                assert_failure(
                    crate::commands::describe_image_authorized(
                        &vault,
                        &images,
                        request(&path, &origin, snapshot.clone(), id),
                    )
                    .await,
                    FailureCode::CredentialUnavailable,
                );
                assert_eq!(images.active_count(), 0);
            }
            let images = ImageIngestState::with_credential_resolver(Arc::new(|_| {
                Err("synthetic private key failure".into())
            }));
            assert_failure(
                crate::commands::describe_image_authorized(
                    &vault,
                    &images,
                    request(&path, &origin, snapshot.clone(), "key-error"),
                )
                .await,
                FailureCode::CredentialUnavailable,
            );
            assert!(server.received_requests().await.unwrap().is_empty());
            use wiremock::matchers::method;
            use wiremock::{Mock, ResponseTemplate};
            Mock::given(method("POST"))
                .respond_with(
                    ResponseTemplate::new(401).set_body_string("synthetic private vendor response"),
                )
                .mount(&server)
                .await;
            let (images, _) = synthetic_state();
            assert_failure(
                crate::commands::describe_image_authorized(
                    &vault,
                    &images,
                    request(&path, &origin, snapshot.clone(), "transport-error"),
                )
                .await,
                FailureCode::TransportFailed,
            );
            assert_eq!(server.received_requests().await.unwrap().len(), 1);
            server.reset().await;
            mount_response(&server, "openai-api", " ").await;
            assert_failure(
                crate::commands::describe_image_authorized(
                    &vault,
                    &images,
                    request(&path, &origin, snapshot, "empty-answer"),
                )
                .await,
                FailureCode::TransportFailed,
            );
            assert_eq!(server.received_requests().await.unwrap().len(), 1);
            assert_eq!(images.active_count(), 0);
        })
    });
}

#[test]
fn native_manual_image_cancel_is_opening_and_request_specific() {
    crate::settings::test_support::with_isolated_data("image-cancel-id", |dir| {
        runtime().block_on(async {
            let server = wiremock::MockServer::start().await;
            let _endpoints = RestoreEndpoints::loopback(&server.uri());
            mount_response(&server, "openai-api", "Synthetic image description").await;
            connect_providers();
            select(RoleId::Compilation, "openai-api", "gpt-5.4-mini");
            let (vault, origin) = opened_vault(dir);
            let snapshot = capture(&vault, &origin, RoleId::Compilation, RoleUsage::Foreground);
            let (images, keys) = synthetic_state();
            let path = dir.join("synthetic.png");
            std::fs::write(&path, IMAGE_BYTES).unwrap();
            let mut foreign = origin.clone();
            foreign.opening_token = "synthetic-foreign-opening".into();
            assert_eq!(
                crate::commands::cancel_image_ingest_authorized(
                    &vault, &images, &foreign, "stopped"
                )
                .unwrap_err()
                .code,
                FailureCode::RoleAuthorizationFailed
            );
            assert_eq!(images.early_cancel_count(), 0);
            assert!(crate::commands::cancel_image_ingest_authorized(
                &vault, &images, &origin, "stopped"
            )
            .unwrap());
            assert!(crate::commands::describe_image_authorized(
                &vault,
                &images,
                request(&path, &origin, snapshot.clone(), "fresh")
            )
            .await
            .is_ok());
            let before = (
                images.read_attempts(),
                keys.load(Ordering::SeqCst),
                server.received_requests().await.unwrap().len(),
            );
            assert_failure(
                crate::commands::describe_image_authorized(
                    &vault,
                    &images,
                    request(&path, &origin, snapshot, "stopped"),
                )
                .await,
                FailureCode::Cancelled,
            );
            assert_eq!(
                before,
                (
                    images.read_attempts(),
                    keys.load(Ordering::SeqCst),
                    server.received_requests().await.unwrap().len()
                )
            );
            assert_eq!(images.active_count(), 0);
            assert_eq!(images.early_cancel_count(), 0);
        })
    });
}

#[test]
fn native_manual_image_owned_registry_is_bounded_without_evicted_cancellations() {
    let registry = super::requests::Registry::default();
    let origin = AgentVaultSession {
        vault_path: "/synthetic/vault".into(),
        opening_token: "synthetic-opening".into(),
    };
    let runs: Vec<_> = (0..4)
        .map(|id| registry.begin(&origin, &format!("active-{id}")).unwrap())
        .collect();
    assert_eq!(
        registry.begin(&origin, "fifth").err().unwrap().code,
        FailureCode::RequestBusy
    );
    assert_eq!(
        registry.begin(&origin, "active-0").err().unwrap().code,
        FailureCode::RequestBusy
    );
    assert_eq!(registry.active_count(), 4);
    drop(runs);
    assert_eq!(registry.active_count(), 0);
    for id in 0..16 {
        assert!(registry.cancel(&origin, &format!("early-{id}")).unwrap());
    }
    assert_eq!(
        registry.cancel(&origin, "overflow").unwrap_err().code,
        FailureCode::RequestBusy
    );
    for id in 0..16 {
        let run = registry.begin(&origin, &format!("early-{id}")).unwrap();
        assert_eq!(run.check().unwrap_err().code, FailureCode::Cancelled);
    }
    assert_eq!(registry.early_count(), 0);
    assert_eq!(registry.active_count(), 0);
}

#[test]
fn native_manual_image_queued_workers_do_not_read_after_stop_or_revocation() {
    crate::settings::test_support::with_isolated_data("image-queued-worker", |dir| {
        runtime().block_on(async {
            let server = wiremock::MockServer::start().await;
            let _endpoints = RestoreEndpoints::loopback(&server.uri());
            connect_providers();
            let path = dir.join("synthetic.png");
            std::fs::write(&path, IMAGE_BYTES).unwrap();
            for mode in ["stop", "role-change", "reopen"] {
                select(RoleId::Compilation, "openai-api", "gpt-5.4-mini");
                let (vault, origin) = opened_vault(dir);
                let snapshot = capture(&vault, &origin, RoleId::Compilation, RoleUsage::Foreground);
                let (mut images, keys) = synthetic_state();
                let (entered_sender, entered_receiver) = std::sync::mpsc::channel();
                let (release_sender, release_receiver) = std::sync::mpsc::channel();
                let release = std::sync::Mutex::new(release_receiver);
                images.before_read = Some(Arc::new(move || {
                    entered_sender.send(()).unwrap();
                    // The bound prevents a failed regression assertion from
                    // stranding a blocking worker and the test runtime.
                    release
                        .lock()
                        .unwrap()
                        .recv_timeout(Duration::from_secs(3))
                        .unwrap();
                }));
                let images = Arc::new(images);
                let task_vault = vault.clone();
                let task_images = images.clone();
                let bound_request = request(&path, &origin, snapshot, mode);
                let task = tokio::spawn(async move {
                    crate::commands::describe_image_authorized(
                        &task_vault,
                        &task_images,
                        bound_request,
                    )
                    .await
                });
                tokio::task::spawn_blocking(move || {
                    entered_receiver
                        .recv_timeout(Duration::from_secs(2))
                        .unwrap()
                })
                .await
                .unwrap();
                assert_eq!(images.active_count(), 1);
                let code = match mode {
                    "stop" => {
                        assert!(crate::commands::cancel_image_ingest_authorized(
                            &vault, &images, &origin, mode
                        )
                        .unwrap());
                        FailureCode::Cancelled
                    }
                    "role-change" => {
                        select(RoleId::Compilation, "openai-api", "gpt-5.4-mini");
                        FailureCode::RoleAuthorizationFailed
                    }
                    "reopen" => {
                        vault.begin_open().unwrap();
                        FailureCode::RoleAuthorizationFailed
                    }
                    _ => unreachable!(),
                };
                let result = tokio::time::timeout(Duration::from_secs(1), task)
                    .await
                    .unwrap()
                    .unwrap();
                assert_failure(result, code);
                assert_eq!(
                    images.active_count(),
                    1,
                    "worker ownership must survive await-side rejection"
                );
                assert_eq!(images.read_attempts(), 0);
                release_sender.send(()).unwrap();
                tokio::time::timeout(Duration::from_secs(1), async {
                    while images.active_count() != 0 {
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                })
                .await
                .unwrap();
                assert_eq!(images.read_attempts(), 0);
                assert_eq!(keys.load(Ordering::SeqCst), 0);
                assert!(server.received_requests().await.unwrap().is_empty());
            }
        })
    });
}

#[cfg(unix)]
#[test]
fn native_manual_image_fifo_is_rejected_before_opening_or_key_lookup() {
    crate::settings::test_support::with_isolated_data("image-fifo", |dir| {
        runtime().block_on(async {
            let server = wiremock::MockServer::start().await;
            let _endpoints = RestoreEndpoints::loopback(&server.uri());
            connect_providers();
            select(RoleId::Compilation, "openai-api", "gpt-5.4-mini");
            let (vault, origin) = opened_vault(dir);
            let snapshot = capture(&vault, &origin, RoleId::Compilation, RoleUsage::Foreground);
            let path = dir.join("synthetic.png");
            let status = std::process::Command::new("mkfifo")
                .arg(&path)
                .status()
                .unwrap();
            assert!(status.success());
            let (images, keys) = synthetic_state();
            let result = tokio::time::timeout(
                Duration::from_secs(1),
                crate::commands::describe_image_authorized(
                    &vault,
                    &images,
                    request(&path, &origin, snapshot, "fifo"),
                ),
            )
            .await
            .unwrap();
            assert_failure(result, FailureCode::ImageReadFailed);
            assert_eq!(images.active_count(), 0);
            assert_eq!(keys.load(Ordering::SeqCst), 0);
            assert!(server.received_requests().await.unwrap().is_empty());
        })
    });
}

#[cfg(unix)]
#[test]
fn native_manual_image_fifo_replacement_cannot_block_the_owned_worker() {
    crate::settings::test_support::with_isolated_data("image-fifo-replacement", |dir| {
        runtime().block_on(async {
            let server = wiremock::MockServer::start().await;
            let _endpoints = RestoreEndpoints::loopback(&server.uri());
            connect_providers();
            select(RoleId::Compilation, "openai-api", "gpt-5.4-mini");
            let (vault, origin) = opened_vault(dir);
            let snapshot = capture(&vault, &origin, RoleId::Compilation, RoleUsage::Foreground);
            let path = dir.join("synthetic.png");
            std::fs::write(&path, IMAGE_BYTES).unwrap();
            let replacement = path.clone();
            let (mut images, keys) = synthetic_state();
            images.before_open = Some(Arc::new(move || {
                // The hook runs only after the regular-file metadata admission.
                // Replace that exact source with a FIFO before the actual open.
                std::fs::remove_file(&replacement).unwrap();
                let status = std::process::Command::new("mkfifo")
                    .arg(&replacement)
                    .status()
                    .unwrap();
                assert!(status.success());
            }));
            let result = tokio::time::timeout(
                Duration::from_secs(1),
                crate::commands::describe_image_authorized(
                    &vault,
                    &images,
                    request(&path, &origin, snapshot, "fifo-replacement"),
                ),
            )
            .await
            .unwrap();
            assert_failure(result, FailureCode::ImageReadFailed);
            assert_eq!(images.read_attempts(), 1);
            assert_eq!(images.active_count(), 0);
            assert_eq!(keys.load(Ordering::SeqCst), 0);
            assert!(server.received_requests().await.unwrap().is_empty());
        })
    });
}
