//! Additional negative cases over synthetic persisted completion/settings.
//! Historical rows are not native semantic authority. Invalid provenance here
//! is an explicit corrupt-settings fixture, not a normal legacy migration.

use super::*;

fn compiler_issuer_snapshot() -> serde_json::Value {
    let registry = grants().lock().unwrap();
    serde_json::Value::Array(
        registry
            .iter()
            .map(|(id, grant)| {
                let outputs: Vec<_> = grant
                    .outputs
                    .iter()
                    .map(|(path, receipt)| {
                        serde_json::json!({
                            "path": path,
                            "revision": receipt.revision,
                            "identity": receipt.file_identity,
                            "nativeCreated": receipt.native_created,
                        })
                    })
                    .collect();
                serde_json::json!({
                    "id": id,
                    "context": grant.context,
                    "outputs": outputs,
                    "hasCompiler": grant.compiler.is_some(),
                    "compilerBusy": grant.compiler_busy,
                    "compilerRequest": grant.compiler_request,
                })
            })
            .collect(),
    )
}

#[test]
fn explicit_retry_of_current_completion_preserves_history_and_requires_fresh_authority() {
    with_isolated_data("compiler-current-completion-explicit-retry", |_| {
        let fixture = fixture();
        let old = seed_completed_history(&fixture, contract());
        let before = Pending::try_load(fixture.dir.path()).unwrap();
        let history = serde_json::to_value((
            &before.compile_jobs[0].attempts,
            &before.compile_jobs[0].receipts,
        ))
        .unwrap();
        let protected = fixture.protected_bytes();
        let fresh = begin(
            &fixture.vault,
            &fixture.origin,
            fixture.source.clone(),
            RoleUsage::Foreground,
        )
        .unwrap();
        assert_ne!(fresh.attempt_id, old.attempt_id);
        assert_eq!(fresh.compile_signature, old.compile_signature);
        let after = Pending::try_load(fixture.dir.path()).unwrap();
        let job = &after.compile_jobs[0];
        assert_eq!(job.attempts.len(), 2);
        assert_eq!(
            serde_json::to_value((&job.attempts[..1], &job.receipts)).unwrap(),
            history
        );
        let attempt = job.attempts.last().unwrap();
        assert_eq!(attempt.state, WorkState::Running);
        assert_eq!(attempt.identity, identity(&fresh));
        assert_eq!(attempt.checks, ProcessingChecks::default());
        assert!(attempt.outputs.is_empty());
        assert!(attempt.prepared_outputs.is_empty());
        assert!(attempt.compiler_progress.is_none());
        assert_eq!(fixture.protected_bytes(), protected);
        let queue = fixture.queue_bytes();
        assert!(complete(
            &fixture.vault,
            &fresh,
            std::slice::from_ref(&fresh.summary_path)
        )
        .is_err());
        assert_eq!(fixture.queue_bytes(), queue);
        assert_eq!(fixture.protected_bytes(), protected);
        grants().lock().unwrap().remove(&fresh.attempt_id);
    });
}

#[test]
fn inconsistent_current_completion_revalidates_and_allows_a_fresh_native_attempt() {
    with_isolated_data("compiler-inconsistent-completion", |_| {
        for mutation in [
            "receipt-attempt",
            "receipt-identity",
            "attempt-source-identity",
            "last-partial",
            "checks-incomplete",
            "outputs-mismatch",
            "outputs-empty",
            "output-attempt",
            "duplicate-receipt",
        ] {
            let fixture = fixture();
            seed_completed_history(&fixture, contract());
            let mut pending = Pending::try_load(fixture.dir.path()).unwrap();
            let job = &mut pending.compile_jobs[0];
            match mutation {
                "receipt-attempt" => {
                    job.receipts[0].attempt_id = "synthetic-other-attempt".into();
                }
                "receipt-identity" => {
                    job.receipts[0].identity.role_signature = "synthetic-other-route".into();
                }
                "attempt-source-identity" => {
                    job.attempts[0].identity.source.source_revision =
                        source_revision("Synthetic different original");
                    job.receipts[0].identity = job.attempts[0].identity.clone();
                }
                "last-partial" => {
                    let mut later = job.attempts[0].clone();
                    later.id = "synthetic-latest-partial".into();
                    later.state = WorkState::Partial;
                    later.reason = Some("synthetic-review-rejected".into());
                    later.checks.semantic_review = CheckState::Rejected;
                    later.outputs.clear();
                    job.attempts.push(later);
                }
                "checks-incomplete" => {
                    job.attempts[0].checks.processed_units = 0;
                    job.attempts[0].checks.omitted_units = 1;
                    job.receipts[0].checks = job.attempts[0].checks.clone();
                }
                "outputs-mismatch" => {
                    job.receipts[0].outputs[0].revision =
                        source_revision("Synthetic different output");
                }
                "outputs-empty" => {
                    job.attempts[0].outputs.clear();
                    job.receipts[0].outputs.clear();
                }
                "output-attempt" => {
                    job.attempts[0].outputs[0].attempt_id = "synthetic-other-attempt".into();
                    job.receipts[0].outputs = job.attempts[0].outputs.clone();
                }
                "duplicate-receipt" => {
                    job.receipts.push(job.receipts[0].clone());
                }
                _ => unreachable!(),
            }
            let history_before = serde_json::to_value((&job.attempts, &job.receipts)).unwrap();
            let previous_attempt = job.attempts.last().unwrap().id.clone();
            let previous_count = job.attempts.len();
            pending.save(fixture.dir.path()).unwrap();
            let queue_before = fixture.queue_bytes();
            let protected_before = fixture.protected_bytes();
            let grants_before = compiler_issuer_snapshot();
            let view = list_at(fixture.dir.path(), &fixture.origin, 3).unwrap();
            assert_eq!(view.pending_total, 1, "{mutation}");
            assert_eq!(view.items.len(), 1, "{mutation}");
            assert_eq!(view.items[0].key, fixture.source.key, "{mutation}");
            assert_eq!(
                view.items[0].compilation_state,
                WorkState::Pending,
                "{mutation}"
            );
            assert_eq!(
                view.items[0].compilation_reason.as_deref(),
                Some("compiler_contract_revalidation_required"),
                "{mutation}"
            );
            assert_eq!(fixture.queue_bytes(), queue_before, "{mutation}");
            assert_eq!(fixture.protected_bytes(), protected_before, "{mutation}");
            assert_eq!(compiler_issuer_snapshot(), grants_before, "{mutation}");
            let fresh = begin(
                &fixture.vault,
                &fixture.origin,
                fixture.source.clone(),
                RoleUsage::Automatic,
            )
            .unwrap();
            assert_ne!(fresh.attempt_id, previous_attempt, "{mutation}");
            let resumed = Pending::try_load(fixture.dir.path()).unwrap();
            let job = &resumed.compile_jobs[0];
            assert_eq!(job.attempts.len(), previous_count + 1, "{mutation}");
            assert_eq!(
                serde_json::to_value((&job.attempts[..previous_count], &job.receipts)).unwrap(),
                history_before,
                "{mutation}"
            );
            let attempt = job.attempts.last().unwrap();
            assert_eq!(attempt.identity, identity(&fresh), "{mutation}");
            assert_eq!(attempt.state, WorkState::Running, "{mutation}");
            assert!(attempt.compiler_progress.is_none(), "{mutation}");
            assert!(attempt.outputs.is_empty(), "{mutation}");
            assert!(attempt.prepared_outputs.is_empty(), "{mutation}");
            assert_eq!(attempt.checks, ProcessingChecks::default(), "{mutation}");
            assert_eq!(fixture.protected_bytes(), protected_before, "{mutation}");
            grants().lock().unwrap().remove(&fresh.attempt_id);
        }
    });
}

#[test]
fn unavailable_role_keeps_completed_and_other_pending_sources_visible_without_mutation() {
    for (failure, expected_error) in [
        ("disconnected", "connection_unavailable"),
        (
            "invalid-unconfirmed-provenance",
            "model role provenance does not match its route",
        ),
        ("unsupported-cli", "capability_unavailable"),
    ] {
        let isolation = format!("compiler-unavailable-route-{failure}");
        with_isolated_data(&isolation, |data_dir| {
            let fixture = fixture();
            seed_completed_history(&fixture, contract());
            let other_original = "---\nsource: codex\nconversation_id: contract-other\nvia: mcp\n---\n# Other synthetic original\n\n**User:**\nKeep the other synthetic source pending.\n";
            let other = SourceBinding {
                key: "codex:contract-other".into(),
                raw_path: "raw/conversations/codex/contract-other.md".into(),
                source_revision: source_revision(other_original),
            };
            crate::importers::wikify::append_raw(
                fixture.dir.path(),
                &other.raw_path,
                other_original,
            )
            .unwrap();
            let mut pending = Pending::try_load(fixture.dir.path()).unwrap();
            pending.push(crate::importers::wikify::PendingItem {
                key: other.key.clone(),
                raw_path: other.raw_path.clone(),
                source_revision: other.source_revision.clone(),
                src_slug: "src-contract-other".into(),
                title: "Other synthetic source".into(),
                imported: "2026-10-09".into(),
                read_ranges: Vec::new(),
            });
            pending.save(fixture.dir.path()).unwrap();
            let mut settings = crate::settings::read_checked().unwrap();
            let provider = if failure == "unsupported-cli" {
                settings.providers.codex_cli = true;
                "codex-cli"
            } else {
                settings.providers.openai_api = true;
                "openai-api"
            };
            crate::settings::save(&settings).unwrap();
            let selected =
                role_authorization::select_role(role_authorization::RoleSelectionRequest {
                    role: RoleId::Compilation,
                    provider_id: provider.into(),
                    model_id: "synthetic-selected-model".into(),
                    effort: "(default)".into(),
                    expected_authorization_revision: role_authorization::settings_snapshot()
                        .unwrap()
                        .role_authorization_revision,
                })
                .unwrap();
            let mut selected = role_authorization::set_automatic(
                RoleId::Compilation,
                true,
                &selected.role_authorization_revision,
            )
            .unwrap();
            match failure {
                "disconnected" => {
                    selected.providers.openai_api = false;
                    crate::settings::save(&selected).unwrap();
                }
                "invalid-unconfirmed-provenance" => {
                    // Persist a deliberately invalid historical selection. A
                    // normal unknown-provenance legacy route migrates locally;
                    // it is not this malformed role-settings fixture.
                    selected
                        .model_roles
                        .roles
                        .get_mut(&RoleId::Compilation)
                        .unwrap()
                        .selection = role_authorization::Selection::PreservedLocal;
                    std::fs::write(
                        data_dir.join("settings.json"),
                        serde_json::to_vec_pretty(&selected).unwrap(),
                    )
                    .unwrap();
                }
                "unsupported-cli" => {}
                _ => unreachable!(),
            }
            let route_error = role_authorization::capture_role_at(
                &fixture.origin,
                RoleId::Compilation,
                RoleUsage::Foreground,
            )
            .unwrap_err()
            .to_string();
            assert!(
                route_error.contains(expected_error),
                "{failure}: {route_error}"
            );
            let queue_before = fixture.queue_bytes();
            let protected_before = fixture.protected_bytes();
            let other_before = std::fs::read(fixture.dir.path().join(&other.raw_path)).unwrap();
            let settings_before = std::fs::read(data_dir.join("settings.json")).unwrap();
            let grants_before = compiler_issuer_snapshot();
            for _ in 0..2 {
                let view = list_at(fixture.dir.path(), &fixture.origin, 3).unwrap();
                assert_eq!(view.pending_total, 2, "{failure}");
                assert_eq!(view.items.len(), 2, "{failure}");
                let current = view
                    .items
                    .iter()
                    .find(|item| item.key == fixture.source.key)
                    .unwrap();
                assert_eq!(current.compilation_state, WorkState::Pending, "{failure}");
                let reason = current.compilation_reason.as_deref().unwrap();
                assert!(
                    reason.starts_with("compiler_role_revalidation_required"),
                    "{failure}: {reason}"
                );
                assert!(reason.contains(&route_error), "{failure}: {reason}");
                let waiting = view
                    .items
                    .iter()
                    .find(|item| item.key == other.key)
                    .unwrap();
                assert_eq!(waiting.raw_path, other.raw_path, "{failure}");
                assert_eq!(waiting.source_revision, other.source_revision, "{failure}");
                assert_eq!(waiting.compilation_state, WorkState::Pending, "{failure}");
                assert_eq!(fixture.queue_bytes(), queue_before, "{failure}");
                assert_eq!(fixture.protected_bytes(), protected_before, "{failure}");
                assert_eq!(
                    std::fs::read(fixture.dir.path().join(&other.raw_path)).unwrap(),
                    other_before,
                    "{failure}"
                );
                assert_eq!(
                    std::fs::read(data_dir.join("settings.json")).unwrap(),
                    settings_before,
                    "{failure}"
                );
                assert_eq!(compiler_issuer_snapshot(), grants_before, "{failure}");
            }
        });
    }
}
