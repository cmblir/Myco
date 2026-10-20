//! Native transport and opening admission for activity source reads.

use super::*;
use crate::role_authorization::{RoleId, RoleSnapshot, RoleUsage};
use std::path::Path;

fn ask_fixture() -> (
    tempfile::TempDir,
    VaultRoot,
    crate::retrieval::Bm25Index,
    ActivityRecallRequest,
) {
    let directory = tempfile::tempdir().unwrap();
    std::fs::create_dir(directory.path().join("wiki")).unwrap();
    let content = "---\ncreated: '2026-10-03'\n---\n\n# Synthetic protected activity\n\nSYNTHETIC_ASK_ROLE_SENTINEL was requested.\n";
    std::fs::write(directory.path().join("wiki/synthetic.md"), content).unwrap();
    let mut index = crate::retrieval::Bm25Index::new();
    index.upsert_page(
        "wiki/synthetic.md",
        "synthetic",
        &crate::embeddings::chunk_page(content),
    );
    let state = VaultRoot::default();
    open(&state, directory.path());
    let origin = state.snapshot().unwrap();
    let request = serde_json::from_value(serde_json::json!({
        "expectedVault":origin.vault_path, "origin":origin,
        "range":{"start":"2026-10-01","end":"2026-10-04"}, "scope":"wiki"
    }))
    .unwrap();
    (directory, state, index, request)
}

fn grant(state: &VaultRoot, role: RoleId, usage: RoleUsage) -> RoleSnapshot {
    let origin = state.snapshot().unwrap();
    state
        .with_origin(&origin, |_| {
            crate::role_authorization::capture_role_at(&origin, role, usage)
                .map_err(|error| error.to_string())
        })
        .unwrap()
}

#[test]
fn native_ask_activity_missing_grant_is_rejected_before_source_access() {
    crate::settings::test_support::with_isolated_data("ask-read-missing-role", |_| {
        let (_directory, state, index, request) = ask_fixture();
        assert!(
            activity_read(&state, &index, &request, false).is_err(),
            "native source bridge accepted no issued Ask grant"
        );
    });
}

#[test]
fn native_ask_activity_other_role_is_rejected_before_source_access() {
    crate::settings::test_support::with_isolated_data("ask-read-other-role", |_| {
        let (_directory, state, index, mut request) = ask_fixture();
        request.role_snapshot = Some(grant(&state, RoleId::Organization, RoleUsage::Foreground));
        assert!(
            activity_read(&state, &index, &request, false).is_err(),
            "native Ask read accepted another feature's grant"
        );
    });
}

#[test]
fn native_ask_activity_automatic_grant_is_rejected_before_source_access() {
    crate::settings::test_support::with_isolated_data("ask-read-automatic-role", |_| {
        let (_directory, state, index, mut request) = ask_fixture();
        request.role_snapshot = Some(grant(&state, RoleId::Ask, RoleUsage::Automatic));
        assert!(
            activity_read(&state, &index, &request, false).is_err(),
            "native Ask read accepted automatic-use authority"
        );
    });
}

#[test]
fn native_ask_activity_revoked_grant_is_rejected_before_source_access() {
    crate::settings::test_support::with_isolated_data("ask-read-revoked-role", |_| {
        let (_directory, state, index, mut request) = ask_fixture();
        request.role_snapshot = Some(grant(&state, RoleId::Ask, RoleUsage::Foreground));
        let mut settings = crate::role_authorization::settings_snapshot().unwrap();
        settings.providers.ollama = true;
        crate::settings::save(&settings).unwrap();
        assert!(
            activity_read(&state, &index, &request, false).is_err(),
            "native source bridge accepted revoked role authority"
        );
    });
}

#[test]
fn native_ask_activity_external_selection_is_rejected_by_local_source_route() {
    crate::settings::test_support::with_isolated_data("ask-read-external-role", |_| {
        let (_directory, state, index, mut request) = ask_fixture();
        let mut settings = crate::role_authorization::settings_snapshot().unwrap();
        settings.providers.openai_api = true;
        crate::settings::save(&settings).unwrap();
        crate::role_authorization::select_role(crate::role_authorization::RoleSelectionRequest {
            role: RoleId::Ask,
            provider_id: "openai-api".into(),
            model_id: "synthetic-remote-model".into(),
            effort: "(default)".into(),
            expected_authorization_revision: crate::role_authorization::settings_snapshot()
                .unwrap()
                .role_authorization_revision,
        })
        .unwrap();
        request.role_snapshot = Some(grant(&state, RoleId::Ask, RoleUsage::Foreground));
        assert!(
            activity_read(&state, &index, &request, false).is_err(),
            "local source route accepted an external model selection"
        );
    });
}

#[test]
fn native_ask_planner_missing_grant_is_rejected_before_catalog_access() {
    crate::settings::test_support::with_isolated_data("ask-plan-missing-role", |_| {
        let (_directory, state, index, request) = ask_fixture();
        let root = PathBuf::from(&request.expected_vault);
        let planner = serde_json::from_value(serde_json::json!({
            "requestId":"synthetic-plan-role-missing", "expectedVault":request.expected_vault,
            "origin":request.origin, "question":"Summarize my recent work", "today":"2026-10-07", "scope":"wiki"
        })).unwrap();
        assert!(
            crate::local_query_plan::checked_catalog(
                &state,
                &root,
                &index,
                &planner,
                &std::sync::atomic::AtomicBool::new(false),
                false
            )
            .is_err(),
            "native catalog accepted no issued Ask grant"
        );
    });
}

#[test]
fn native_ask_omitted_model_uses_selected_manifest_and_mismatch_never_dispatches() {
    crate::settings::test_support::with_isolated_data("ask-selected-model", |data| {
        let (_directory, state, _index, request) = ask_fixture();
        crate::role_authorization::select_role(crate::role_authorization::RoleSelectionRequest {
            role: RoleId::Ask,
            provider_id: "builtin-local".into(),
            model_id: crate::local_model::SMALL_MODEL.id.into(),
            effort: "(default)".into(),
            expected_authorization_revision: crate::role_authorization::settings_snapshot()
                .unwrap()
                .role_authorization_revision,
        })
        .unwrap();
        let snapshot = grant(&state, RoleId::Ask, RoleUsage::Foreground);
        let selected = crate::local_generation::with_ask_role(
            &state,
            &request.origin,
            Some(&snapshot),
            None,
            |_, manifest| Ok(manifest.id),
        )
        .unwrap();
        assert_eq!(selected, crate::local_model::SMALL_MODEL.id);
        let accessed = std::sync::atomic::AtomicBool::new(false);
        let mismatch = crate::local_generation::with_ask_role(
            &state,
            &request.origin,
            Some(&snapshot),
            Some(crate::local_model::MODEL.id),
            |_, _| {
                accessed.store(true, std::sync::atomic::Ordering::Relaxed);
                Ok(())
            },
        );
        assert!(mismatch.unwrap_err().contains("request_route_mismatch"));
        assert!(!accessed.load(std::sync::atomic::Ordering::Relaxed));
        assert!(
            !data.join("models").exists(),
            "authority checks must not prepare weights"
        );
    });
}

#[test]
fn native_ask_forged_snapshot_never_reaches_source_dispatch() {
    crate::settings::test_support::with_isolated_data("ask-forged-snapshot", |_| {
        let (_directory, state, index, mut request) = ask_fixture();
        let mut snapshot = grant(&state, RoleId::Ask, RoleUsage::Foreground);
        snapshot.route_signature.model_id = crate::local_model::SMALL_MODEL.id.into();
        request.role_snapshot = Some(snapshot);
        assert!(activity_read(&state, &index, &request, false)
            .unwrap_err()
            .contains("role_mismatch"));
    });
}

#[test]
fn native_ask_async_revocation_drops_late_success() {
    crate::settings::test_support::with_isolated_data("ask-async-revoke", |_| {
        let (_directory, state, _index, request) = ask_fixture();
        let snapshot = grant(&state, RoleId::Ask, RoleUsage::Foreground);
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let result = runtime.block_on(await_authorized(
            &state,
            &request.origin,
            &snapshot,
            RoleId::Ask,
            async {
                let mut settings = crate::role_authorization::settings_snapshot().unwrap();
                settings.providers.ollama = true;
                crate::settings::save(&settings).unwrap();
                Ok("synthetic late answer")
            },
        ));
        assert!(
            result.unwrap_err().contains("snapshot_stale"),
            "late output must not become answer or quote success"
        );
    });
}

#[test]
fn native_ask_async_polling_revocation_drops_owned_pending_future() {
    crate::settings::test_support::with_isolated_data("ask-poll-revoke", |_| {
        struct PendingDrop(std::sync::Arc<std::sync::atomic::AtomicBool>);
        impl Drop for PendingDrop {
            fn drop(&mut self) {
                self.0.store(true, std::sync::atomic::Ordering::Relaxed);
            }
        }
        let (_directory, state, _index, request) = ask_fixture();
        let snapshot = grant(&state, RoleId::Ask, RoleUsage::Foreground);
        let dropped = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let marker = PendingDrop(dropped.clone());
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let result = runtime.block_on(async {
            tokio::time::timeout(
                std::time::Duration::from_secs(2),
                await_authorized(
                    &state,
                    &request.origin,
                    &snapshot,
                    RoleId::Ask,
                    async move {
                        let _marker = marker;
                        let mut settings = crate::role_authorization::settings_snapshot().unwrap();
                        settings.providers.ollama = true;
                        crate::settings::save(&settings).unwrap();
                        std::future::pending::<Result<(), String>>().await
                    },
                ),
            )
            .await
            .expect("isolated revocation test watchdog fired")
        });
        assert!(result.unwrap_err().contains("snapshot_stale"));
        assert!(dropped.load(std::sync::atomic::Ordering::Relaxed));
    });
}

#[test]
fn activity_transport_requires_native_opening() {
    let payload = serde_json::json!({
        "expectedVault":"/synthetic", "range":{"start":"2026-10-01","end":"2026-10-04"}, "scope":"wiki"
    });
    assert!(serde_json::from_value::<ActivityRecallRequest>(payload).is_err());
}

fn open(state: &VaultRoot, root: &Path) {
    let generation = state.begin_open().unwrap();
    state
        .finish_open(generation, root.canonicalize().unwrap(), || ())
        .unwrap();
}

#[test]
fn activity_read_rejects_same_path_reopen_close_and_foreign_origin() {
    crate::settings::test_support::with_isolated_data("ask-existing-reopen", |_| {
        let directory = tempfile::tempdir().unwrap();
        let state = VaultRoot::default();
        open(&state, directory.path());
        let origin = state.snapshot().unwrap();
        let mut request: ActivityRecallRequest = serde_json::from_value(serde_json::json!({
            "expectedVault":origin.vault_path, "origin":origin,
            "range":{"start":"2026-10-01","end":"2026-10-04"}, "scope":"wiki"
        }))
        .unwrap();
        request.role_snapshot = Some(grant(&state, RoleId::Ask, RoleUsage::Foreground));
        let index = crate::retrieval::Bm25Index::new();
        assert!(activity_read(&state, &index, &request, false).is_ok());
        open(&state, directory.path());
        assert!(activity_root(&state, &request.expected_vault, &request.origin).is_err());
        assert!(activity_read(&state, &index, &request, false).is_err());
        request.origin = state.snapshot().unwrap();
        request.role_snapshot = Some(grant(&state, RoleId::Ask, RoleUsage::Foreground));
        request.expected_vault = "/outside-synthetic".into();
        assert!(activity_read(&state, &index, &request, false).is_err());
        state.close().unwrap();
        assert!(activity_read(&state, &index, &request, false).is_err());
    });
}

#[test]
fn planner_catalog_rejects_reopened_identity_before_source_reads() {
    crate::settings::test_support::with_isolated_data("ask-existing-catalog", |_| {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir(directory.path().join("wiki")).unwrap();
        let content = "---\ncreated: '2026-10-03'\n---\n\nSynthetic original request.\n";
        std::fs::write(directory.path().join("wiki/synthetic.md"), content).unwrap();
        let mut index = crate::retrieval::Bm25Index::new();
        index.upsert_page(
            "wiki/synthetic.md",
            "synthetic",
            &crate::embeddings::chunk_page(content),
        );
        let state = VaultRoot::default();
        open(&state, directory.path());
        let origin = state.snapshot().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let mut request: crate::local_query_plan::Request =
            serde_json::from_value(serde_json::json!({
                "requestId":"synthetic-plan", "expectedVault":origin.vault_path, "origin":origin,
                "question":"Summarize my recent work", "today":"2026-10-07", "scope":"wiki"
            }))
            .unwrap();
        request.role_snapshot = Some(grant(&state, RoleId::Ask, RoleUsage::Foreground));
        let flag = std::sync::atomic::AtomicBool::new(false);
        assert!(crate::local_query_plan::checked_catalog(
            &state, &root, &index, &request, &flag, false
        )
        .is_ok());
        open(&state, directory.path());
        assert!(crate::local_query_plan::checked_catalog(
            &state, &root, &index, &request, &flag, false
        )
        .is_err());
        assert_eq!(
            std::fs::read_to_string(root.join("wiki/synthetic.md")).unwrap(),
            content
        );
    });
}

#[test]
fn activity_read_returns_current_indexed_source_under_its_opening() {
    crate::settings::test_support::with_isolated_data("ask-existing-current", |_| {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir(directory.path().join("wiki")).unwrap();
        let content = "---\ncreated: '2026-10-03'\n---\n\n# Synthetic original note\n\nA synthetic change was requested.\n";
        let source = directory.path().join("wiki/synthetic.md");
        std::fs::write(&source, content).unwrap();
        let mut index = crate::retrieval::Bm25Index::new();
        index.upsert_page(
            "wiki/synthetic.md",
            "synthetic",
            &crate::embeddings::chunk_page(content),
        );
        let state = VaultRoot::default();
        open(&state, directory.path());
        let origin = state.snapshot().unwrap();
        let mut request: ActivityRecallRequest = serde_json::from_value(serde_json::json!({
            "expectedVault":origin.vault_path, "origin":origin,
            "range":{"start":"2026-10-01","end":"2026-10-04"}, "scope":"wiki"
        }))
        .unwrap();
        request.role_snapshot = Some(grant(&state, RoleId::Ask, RoleUsage::Foreground));
        let result = activity_read(&state, &index, &request, false).unwrap();
        assert!(result.hits.iter().any(|hit| hit.page == "wiki/synthetic.md"
            && hit.text.contains("A synthetic change was requested.")));
        assert!(!result.incomplete);
        assert_eq!(std::fs::read_to_string(source).unwrap(), content);
    });
}
