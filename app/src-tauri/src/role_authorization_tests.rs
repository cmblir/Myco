use super::*;
use crate::settings::test_support::with_isolated_data;

fn origin() -> AgentVaultSession {
    AgentVaultSession {
        vault_path: "/synthetic/native-vault".into(),
        opening_token: "synthetic-opening-one".into(),
    }
}
fn select(role: RoleId, model: &str) -> Settings {
    select_role(RoleSelectionRequest {
        role,
        provider_id: "builtin-local".into(),
        model_id: model.into(),
        effort: "(default)".into(),
        expected_authorization_revision: settings_snapshot().unwrap().role_authorization_revision,
    })
    .unwrap()
}
fn validate(snapshot: &RoleSnapshot) -> Result<(), RoleError> {
    with_current_role_at(
        &origin(),
        snapshot,
        snapshot.role,
        snapshot.usage,
        || Ok(()),
    )
}

#[test]
fn native_role_legacy_external_is_preserved_without_granting_consent() {
    with_isolated_data("role-legacy-external", |dir| {
        std::fs::write(dir.join("settings.json"), r#"{"query_provider":"openai-api","query_model":"synthetic-legacy","providers":{"openai_api":true}}"#).unwrap();
        let settings = settings::read_checked().unwrap();
        assert_eq!(settings.query_provider, "openai-api");
        let selected = &settings.model_roles.roles[&RoleId::Ask];
        assert_eq!(selected.provider_id, "builtin-local");
        assert_eq!(
            selected.legacy_unconfirmed.as_ref().unwrap().model_id,
            "synthetic-legacy"
        );
        assert_eq!(
            capture_role_at(&origin(), RoleId::Ask, RoleUsage::Foreground)
                .unwrap()
                .route_signature
                .provider_id,
            "builtin-local"
        );
    });
}

#[test]
fn native_role_legacy_extractives_are_deliberate_local_choices() {
    with_isolated_data("role-legacy-local", |dir| {
        std::fs::write(dir.join("settings.json"), r#"{"query_provider":"builtin-local","query_model":"extractive-retrieval","ingest_provider":"builtin-local","ingest_model":"extractive-ingest"}"#).unwrap();
        let settings = settings::read_checked().unwrap();
        assert_eq!(
            settings.model_roles.roles[&RoleId::Ask].selection,
            Selection::PreservedLocal
        );
        assert_eq!(
            capture_role_at(&origin(), RoleId::Compilation, RoleUsage::Automatic)
                .unwrap()
                .route_signature
                .model_id,
            "extractive-ingest"
        );
    });
}

#[test]
fn native_role_generic_settings_cannot_forge_selection_or_automatic_consent() {
    with_isolated_data("role-forged-settings", |_| {
        let mut settings = Settings::default();
        let role = settings.model_roles.roles.get_mut(&RoleId::Ask).unwrap();
        role.provider_id = "openai-api".into();
        role.selection = Selection::ExplicitExternal;
        role.automatic_external_allowed = true;
        settings.providers.openai_api = true;
        assert!(settings::save(&settings).is_err());
        assert_eq!(
            settings::read_checked().unwrap().model_roles.roles[&RoleId::Ask].provider_id,
            "builtin-local"
        );
    });
}

#[test]
fn native_role_missing_weights_issue_a_route_not_readiness() {
    with_isolated_data("role-missing-weights", |dir| {
        let grant = capture_role_at(&origin(), RoleId::Compilation, RoleUsage::Automatic).unwrap();
        assert_eq!(
            grant.route_signature.artifact_sha256.as_deref(),
            Some(crate::local_model::SMALL_MODEL.sha256)
        );
        assert!(!dir.join("models").exists());
        validate(&grant).unwrap();
    });
}

#[test]
fn native_role_forged_snapshot_and_cross_origin_or_usage_are_rejected() {
    with_isolated_data("role-forged-grant", |_| {
        let grant = capture_role_at(&origin(), RoleId::Ask, RoleUsage::Foreground).unwrap();
        let mut forged = grant.clone();
        forged.route_signature.model_id = "synthetic-forged".into();
        assert!(validate(&forged).is_err());
        let mut other = origin();
        other.opening_token = "synthetic-opening-two".into();
        assert!(with_current_role_at(
            &other,
            &grant,
            RoleId::Ask,
            RoleUsage::Foreground,
            || Ok(())
        )
        .is_err());
        assert!(with_current_role_at(
            &origin(),
            &grant,
            RoleId::Reflect,
            RoleUsage::Foreground,
            || Ok(())
        )
        .is_err());
        assert!(
            with_current_role_at(&origin(), &grant, RoleId::Ask, RoleUsage::Automatic, || Ok(
                ()
            ))
            .is_err()
        );
    });
}

#[test]
fn native_role_change_back_does_not_resurrect_snapshot() {
    with_isolated_data("role-change-back", |_| {
        let grant = capture_role_at(&origin(), RoleId::Ask, RoleUsage::Foreground).unwrap();
        select(RoleId::Ask, crate::local_model::SMALL_MODEL.id);
        select(RoleId::Ask, crate::local_model::MODEL.id);
        assert!(validate(&grant).is_err());
    });
}

#[test]
fn native_role_connection_and_selection_require_separate_automatic_permission() {
    with_isolated_data("role-external-permission", |_| {
        let mut settings = Settings::default();
        settings.providers.ollama = true;
        settings::save(&settings).unwrap();
        let settings = select_role(RoleSelectionRequest {
            role: RoleId::Reflect,
            provider_id: "ollama".into(),
            model_id: "synthetic-model".into(),
            effort: "(default)".into(),
            expected_authorization_revision: settings_snapshot()
                .unwrap()
                .role_authorization_revision,
        })
        .unwrap();
        assert_eq!(
            settings.model_roles.roles[&RoleId::Ask].provider_id,
            "builtin-local"
        );
        assert!(capture_role_at(&origin(), RoleId::Reflect, RoleUsage::Automatic).is_err());
        let foreground =
            capture_role_at(&origin(), RoleId::Reflect, RoleUsage::Foreground).unwrap();
        set_automatic(
            RoleId::Reflect,
            true,
            &settings_snapshot().unwrap().role_authorization_revision,
        )
        .unwrap();
        assert!(validate(&foreground).is_err());
        capture_role_at(&origin(), RoleId::Reflect, RoleUsage::Automatic).unwrap();
        set_automatic(
            RoleId::Reflect,
            false,
            &settings_snapshot().unwrap().role_authorization_revision,
        )
        .unwrap();
        assert!(capture_role_at(&origin(), RoleId::Reflect, RoleUsage::Automatic).is_err());
    });
}

#[test]
fn native_role_unrelated_settings_preserve_stable_signature_and_snapshot() {
    with_isolated_data("role-unrelated-settings", |_| {
        let grant = capture_role_at(&origin(), RoleId::Compilation, RoleUsage::Foreground).unwrap();
        let mut settings = settings::read_checked().unwrap();
        settings.permanent_delete = true;
        settings::save(&settings).unwrap();
        validate(&grant).unwrap();
        let next = capture_role_at(&origin(), RoleId::Compilation, RoleUsage::Foreground).unwrap();
        assert_eq!(
            grant.route_signature.signature(),
            next.route_signature.signature()
        );
        assert_ne!(grant.snapshot_id, next.snapshot_id);
    });
}

#[test]
fn native_role_credential_replacement_revokes_without_real_keychain() {
    with_isolated_data("role-fake-credential-change", |_| {
        let grant = capture_role_at(&origin(), RoleId::Ask, RoleUsage::Foreground).unwrap();
        with_credential_change(|| Ok(())).unwrap();
        assert!(validate(&grant).is_err());
    });
}

#[test]
fn native_role_corrupt_settings_cannot_be_overwritten_by_unrelated_save() {
    with_isolated_data("role-corrupt-save", |dir| {
        std::fs::write(dir.join("settings.json"), "synthetic invalid settings").unwrap();
        assert!(settings::save(&Settings::default()).is_err());
        assert_eq!(
            std::fs::read_to_string(dir.join("settings.json")).unwrap(),
            "synthetic invalid settings"
        );
        assert!(capture_role_at(&origin(), RoleId::Ask, RoleUsage::Foreground).is_err());
    });
}

#[test]
fn native_role_publication_and_settings_save_share_the_same_guard() {
    with_isolated_data("role-publication-race", |dir| {
        let grant =
            capture_role_at(&origin(), RoleId::Organization, RoleUsage::Foreground).unwrap();
        let path = dir.join("synthetic-output.md");
        let (entered_send, entered_receive) = std::sync::mpsc::channel();
        let (release_send, release_receive) = std::sync::mpsc::channel();
        let output = path.clone();
        let issued = grant.clone();
        let publication = std::thread::spawn(move || {
            with_current_role_at(
                &origin(),
                &issued,
                RoleId::Organization,
                RoleUsage::Foreground,
                || {
                    entered_send.send(()).unwrap();
                    release_receive.recv().unwrap();
                    std::fs::write(output, "synthetic admitted publication")
                        .map_err(|error| error.to_string())
                },
            )
        });
        entered_receive.recv().unwrap();
        let (saved_send, saved_receive) = std::sync::mpsc::channel();
        let change = std::thread::spawn(move || {
            select(RoleId::Organization, crate::local_model::SMALL_MODEL.id);
            saved_send.send(()).unwrap();
        });
        assert!(saved_receive
            .recv_timeout(std::time::Duration::from_millis(20))
            .is_err());
        release_send.send(()).unwrap();
        publication.join().unwrap().unwrap();
        change.join().unwrap();
        assert!(validate(&grant).is_err());
        assert_eq!(
            std::fs::read_to_string(path).unwrap(),
            "synthetic admitted publication"
        );
    });
}

#[test]
fn native_role_explicit_loopback_dispatch_and_mismatch_use_the_real_bridge() {
    with_isolated_data("role-explicit-loopback", |dir| {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            use wiremock::matchers::{method, path};
            use wiremock::{Mock, MockServer, ResponseTemplate};
            let server = MockServer::start().await;
            struct Restore(Option<std::ffi::OsString>);
            impl Drop for Restore { fn drop(&mut self) { match &self.0 { Some(value) => std::env::set_var("MYCO_OLLAMA_URL", value), None => std::env::remove_var("MYCO_OLLAMA_URL") } } }
            let _restore = Restore(std::env::var_os("MYCO_OLLAMA_URL"));
            std::env::set_var("MYCO_OLLAMA_URL", server.uri());
            Mock::given(method("POST")).and(path("/api/chat")).respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"message":{"role":"assistant","content":"synthetic selected answer"},"prompt_eval_count":1,"eval_count":1}))).mount(&server).await;
            let vault_dir = dir.join("vault"); std::fs::create_dir(&vault_dir).unwrap();
            let vault = crate::vault_session::VaultRoot::default();
            let generation = vault.begin_open().unwrap(); vault.finish_open(generation, vault_dir.canonicalize().unwrap(), || ()).unwrap();
            let opening = vault.snapshot().unwrap();
            let mut settings = settings::read_checked().unwrap(); settings.providers.ollama = true; settings::save(&settings).unwrap();
            select_role(RoleSelectionRequest { role: RoleId::Ask, provider_id: "ollama".into(), model_id: "synthetic-selected".into(), effort: "(default)".into(), expected_authorization_revision: settings_snapshot().unwrap().role_authorization_revision }).unwrap();
            let snapshot = vault.with_origin(&opening, |_| capture_role_at(&opening, RoleId::Ask, RoleUsage::Foreground).map_err(|error| error.to_string())).unwrap();
            let request = |model: &str| crate::providers::ChatRequest { provider_id: "ollama".into(), model: model.into(), messages: vec![crate::providers::ChatMessage { role: "user".into(), content: "synthetic selected source".into() }], temperature: None, max_tokens: Some(8) };
            assert!(crate::commands::chat_complete_authorized(&vault, request("synthetic-other"), Some(opening.clone()), Some(snapshot.clone())).await.is_err());
            assert!(server.received_requests().await.unwrap().is_empty());
            let answer = crate::commands::chat_complete_authorized(&vault, request("synthetic-selected"), Some(opening.clone()), Some(snapshot.clone())).await.unwrap();
            assert_eq!(answer.content, "synthetic selected answer");
            assert_eq!(server.received_requests().await.unwrap().len(), 1);
            vault.begin_open().unwrap();
            assert!(crate::commands::chat_complete_authorized(&vault, request("synthetic-selected"), Some(opening), Some(snapshot)).await.is_err());
            assert_eq!(server.received_requests().await.unwrap().len(), 1);
        });
    });
}

#[test]
fn native_role_automatic_toggle_revokes_without_changing_compiler_signature() {
    with_isolated_data("role-auto-toggle", |_| {
        let grant = capture_role_at(&origin(), RoleId::Compilation, RoleUsage::Automatic).unwrap();
        let mut settings = settings::read_checked().unwrap();
        settings.auto_ingest_enabled = true;
        settings::save(&settings).unwrap();
        assert!(validate(&grant).is_err());
        let next = capture_role_at(&origin(), RoleId::Compilation, RoleUsage::Automatic).unwrap();
        assert_eq!(
            grant.route_signature.signature(),
            next.route_signature.signature()
        );
    });
}

#[test]
fn native_role_delayed_automatic_consent_cannot_apply_to_a_changed_route() {
    with_isolated_data("role-delayed-consent", |_| {
        let mut settings = Settings::default();
        settings.providers.ollama = true;
        settings::save(&settings).unwrap();
        let selected = select_role(RoleSelectionRequest {
            role: RoleId::Reflect,
            provider_id: "ollama".into(),
            model_id: "synthetic-one".into(),
            effort: "(default)".into(),
            expected_authorization_revision: settings_snapshot()
                .unwrap()
                .role_authorization_revision,
        })
        .unwrap();
        select(RoleId::Reflect, crate::local_model::MODEL.id);
        assert!(
            set_automatic(RoleId::Reflect, true, &selected.role_authorization_revision).is_err()
        );
    });
}
