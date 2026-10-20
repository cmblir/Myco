//! Native queue-view ownership regressions over synthetic vaults. Tokenizer and
//! generation callbacks exercise bookkeeping, not model meaning or installed UI.

use super::*;
use crate::session_compile::compiler::CompilerSchema;
use serde_json::Value;
use std::sync::atomic::AtomicBool;

type Protected = (Vec<u8>, Vec<u8>, Vec<u8>, Value);

fn protected(root: &Path, context: &SessionCompileContext) -> Protected {
    let pending = Pending::try_load(root).unwrap();
    (
        std::fs::read(Pending::path(root)).unwrap(),
        std::fs::read(root.join(&context.source.raw_path)).unwrap(),
        std::fs::read(root.join(&context.summary_path)).unwrap(),
        serde_json::to_value((&pending.compile_jobs, &pending.receipts)).unwrap(),
    )
}

fn with_human_summary(
    vault: &VaultRoot,
    origin: &AgentVaultSession,
    source: SourceBinding,
) -> SessionCompileContext {
    let context = begin(vault, origin, source, RoleUsage::Foreground).unwrap();
    publish(
        vault,
        &context,
        &context.summary_path,
        &summary(&context),
        None,
    )
    .unwrap();
    context
}

fn bounded_tokens(_: &str, user: &str) -> Result<usize, String> {
    let input: Value = serde_json::from_str(user).map_err(|error| error.to_string())?;
    let span_len = input["originalSpans"][0]["text"]
        .as_str()
        .map_or(0, str::len);
    // Exercise actual native window planning without changing immutable raw.
    Ok(if span_len > 16 {
        sources::MAX_INPUT_TOKENS + 1
    } else {
        800
    })
}

fn checkpoint(vault: &VaultRoot, context: &SessionCompileContext) {
    let outcome = execution::step(
        vault,
        context,
        "en",
        &AtomicBool::new(false),
        bounded_tokens,
        |_, user, _, _, schema| compiler::fixture_model(schema, user, false),
    )
    .unwrap();
    assert_eq!(outcome.state, WorkState::Running);
    assert!(outcome.eligible_windows > 2);
    assert_eq!(outcome.next_packet, 1);
    assert!(outcome.publication.is_none());
}

fn assert_view(
    vault: &VaultRoot,
    origin: &AgentVaultSession,
    context: &SessionCompileContext,
    expected: WorkState,
) {
    vault
        .with_origin(origin, |root| {
            let before = protected(root, context);
            let view = list_at(root, origin, 3)?;
            assert_eq!(view.pending_total, 1);
            assert_eq!(view.items.len(), 1);
            let item = &view.items[0];
            assert_eq!(item.key, context.source.key);
            assert_eq!(item.raw_path, context.source.raw_path);
            assert_eq!(item.source_revision, context.source.source_revision);
            assert_eq!(
                item.compile_job_id.as_deref(),
                Some(context.job_id.as_str())
            );
            assert_eq!(item.compilation_state, expected);
            assert_eq!(
                item.compilation_reason.as_deref(),
                (expected == WorkState::Pending)
                    .then_some("compiler_runtime_revalidation_required")
            );
            assert_eq!(protected(root, context), before);
            Ok(())
        })
        .unwrap();
}

fn assert_old_context_refused(root: &Path, vault: &VaultRoot, context: &SessionCompileContext) {
    let before = protected(root, context);
    assert!(execution::authorize(vault, context).is_err());
    assert!(read(vault, context, &context.source.raw_path).is_err());
    assert!(complete(vault, context, std::slice::from_ref(&context.summary_path)).is_err());
    assert_eq!(protected(root, context), before);
}

#[test]
fn lost_runtime_issuer_projects_pending_without_mutating_durable_history() {
    with_isolated_data("compiler-live-view-lost-issuer", |_| {
        let (dir, vault, origin, source) = fixture();
        let context = with_human_summary(&vault, &origin, source);
        checkpoint(&vault, &context);
        let before = protected(dir.path(), &context);
        assert!(grants()
            .lock()
            .unwrap()
            .remove(&context.attempt_id)
            .is_some());
        assert_view(&vault, &origin, &context, WorkState::Pending);
        assert_eq!(protected(dir.path(), &context), before);
        let stored = Pending::try_load(dir.path()).unwrap();
        assert_eq!(stored.compile_jobs[0].state, WorkState::Running);
        assert_eq!(stored.compile_jobs[0].attempts[0].state, WorkState::Running);
        assert_eq!(stored.compile_jobs[0].attempts[0].outputs.len(), 1);
        assert!(stored.compile_jobs[0].attempts[0]
            .compiler_progress
            .is_some());
        assert_old_context_refused(dir.path(), &vault, &context);
        assert!(!grants().lock().unwrap().contains_key(&context.attempt_id));
    });
}

#[test]
fn same_path_reopen_projects_pending_even_when_old_issuer_is_retained() {
    with_isolated_data("compiler-live-view-reopen", |_| {
        let (dir, vault, origin, source) = fixture();
        let context = with_human_summary(&vault, &origin, source);
        checkpoint(&vault, &context);
        let before = protected(dir.path(), &context);
        reopen(&vault, dir.path());
        let current = vault.snapshot().unwrap();
        assert_eq!(current.vault_path, origin.vault_path);
        assert_ne!(current.opening_token, origin.opening_token);
        assert!(grants().lock().unwrap().contains_key(&context.attempt_id));
        assert_view(&vault, &current, &context, WorkState::Pending);
        assert_old_context_refused(dir.path(), &vault, &context);
        assert_eq!(protected(dir.path(), &context), before);
        assert!(grants().lock().unwrap().contains_key(&context.attempt_id));
    });
}

#[test]
fn live_idle_bound_and_leased_attempts_remain_running_across_packet_boundaries() {
    with_isolated_data("compiler-live-view-healthy", |_| {
        let (dir, vault, origin, source) = fixture();
        let context = with_human_summary(&vault, &origin, source.clone());
        let before = protected(dir.path(), &context);
        assert_view(&vault, &origin, &context, WorkState::Running);
        assert!(execution::authorize(&vault, &context).is_ok());
        let reused = begin(&vault, &origin, source, RoleUsage::Foreground).unwrap();
        assert_eq!(
            serde_json::to_value(reused).unwrap(),
            serde_json::to_value(&context).unwrap()
        );
        assert_eq!(protected(dir.path(), &context), before);

        let request_id = format!("synthetic-live-view-{}", context.attempt_id);
        let owner = execution::bind_request(&vault, &context, &request_id, "en").unwrap();
        {
            let registry = grants().lock().unwrap();
            let grant = registry.get(&context.attempt_id).unwrap();
            assert!(!grant.compiler_busy);
            assert_eq!(grant.compiler_request.as_deref(), Some(request_id.as_str()));
        }
        assert_view(&vault, &origin, &context, WorkState::Running);
        assert!(execution::bind_request(&vault, &context, "synthetic-duplicate", "en").is_err());
        assert_eq!(protected(dir.path(), &context), before);
        let mut leased_calls = Vec::new();
        let outcome = execution::step_for_request(
            &vault,
            &context,
            "en",
            &AtomicBool::new(false),
            &owner,
            bounded_tokens,
            |_, user, _, _, schema| {
                {
                    let registry = grants().lock().unwrap();
                    let grant = registry.get(&context.attempt_id).unwrap();
                    assert!(grant.compiler_busy);
                    assert_eq!(grant.compiler_request.as_deref(), Some(request_id.as_str()));
                }
                assert_view(&vault, &origin, &context, WorkState::Running);
                assert!(execution::authorize(&vault, &context).is_ok());
                assert_eq!(protected(dir.path(), &context), before);
                leased_calls.push(schema);
                compiler::fixture_model(schema, user, false)
            },
        )
        .unwrap();
        assert_eq!(
            leased_calls,
            vec![CompilerSchema::Claims, CompilerSchema::Review]
        );
        assert_eq!(outcome.state, WorkState::Running);
        assert!(outcome.eligible_windows > 2);
        assert_eq!(outcome.next_packet, 1);
        assert!(outcome.publication.is_none());
        assert_view(&vault, &origin, &context, WorkState::Running);
        execution::release_request(&context, &request_id);
        {
            let registry = grants().lock().unwrap();
            let grant = registry.get(&context.attempt_id).unwrap();
            assert!(!grant.compiler_busy);
            assert!(grant.compiler_request.is_none());
            assert!(grant.compiler.is_some());
        }
        assert_view(&vault, &origin, &context, WorkState::Running);
        let next = execution::step(
            &vault,
            &context,
            "en",
            &AtomicBool::new(false),
            bounded_tokens,
            |_, user, _, _, schema| {
                assert_view(&vault, &origin, &context, WorkState::Running);
                compiler::fixture_model(schema, user, false)
            },
        )
        .unwrap();
        assert_eq!(next.state, WorkState::Running);
        assert_eq!(next.next_packet, 2);
        assert!(next.publication.is_none());
        assert_view(&vault, &origin, &context, WorkState::Running);
        assert_eq!(
            std::fs::read(dir.path().join(&context.source.raw_path)).unwrap(),
            before.1
        );
        assert_eq!(
            std::fs::read(dir.path().join(&context.summary_path)).unwrap(),
            before.2
        );
        assert!(Pending::try_load(dir.path()).unwrap().compile_jobs[0]
            .receipts
            .is_empty());
    });
}

fn mismatched_latest_attempt(
    name: &str,
    mutate: impl FnOnce(&mut state::Attempt),
    compatible_draft: bool,
) {
    with_isolated_data(name, |_| {
        let (dir, vault, origin, source) = fixture();
        let context = with_human_summary(&vault, &origin, source.clone());
        checkpoint(&vault, &context);
        let mut pending = Pending::try_load(dir.path()).unwrap();
        mutate(pending.compile_jobs[0].attempts.last_mut().unwrap());
        pending.save(dir.path()).unwrap();
        let old = serde_json::to_value(&pending.compile_jobs[0].attempts[0]).unwrap();
        let before = protected(dir.path(), &context);
        assert_view(&vault, &origin, &context, WorkState::Pending);
        assert_old_context_refused(dir.path(), &vault, &context);
        assert_eq!(protected(dir.path(), &context), before);

        let retry = begin(&vault, &origin, source, RoleUsage::Foreground).expect(
            "a valid original must receive fresh authority rather than a mismatched old context",
        );
        assert_ne!(retry.attempt_id, context.attempt_id);
        assert_ne!(
            retry.role_snapshot.snapshot_id,
            context.role_snapshot.snapshot_id
        );
        assert_eq!(retry.source, context.source);
        assert_eq!(retry.origin.vault_path, origin.vault_path);
        assert_eq!(retry.origin.opening_token, origin.opening_token);
        let resumed = Pending::try_load(dir.path()).unwrap();
        let job = &resumed.compile_jobs[0];
        assert_eq!(job.attempts.len(), 2);
        let mut retained = serde_json::to_value(&job.attempts[0]).unwrap();
        assert_eq!(job.attempts[0].state, WorkState::Stopped);
        if old["state"] == "running" {
            assert_eq!(
                job.attempts[0].reason.as_deref(),
                Some("expired_origin_or_role_requires_new_attempt")
            );
            for field in ["state", "reason", "updated"] {
                retained[field] = old[field].clone();
            }
        }
        assert_eq!(retained, old);
        assert_eq!(job.attempts[1].id, retry.attempt_id);
        assert_eq!(job.attempts[1].state, WorkState::Running);
        assert!(job.attempts[1].outputs.is_empty());
        assert!(job.attempts[1].prepared_outputs.is_empty());
        assert_eq!(job.attempts[1].checks, state::ProcessingChecks::default());
        if compatible_draft {
            assert_eq!(
                serde_json::to_value(&job.attempts[1].compiler_progress).unwrap(),
                old["compilerProgress"]
            );
        } else {
            assert!(job.attempts[1].compiler_progress.is_none());
        }
        assert!(job.receipts.is_empty());
        assert!(resumed.receipts.is_empty());
        let after_begin = protected(dir.path(), &retry);
        assert!(complete(&vault, &retry, std::slice::from_ref(&retry.summary_path)).is_err());
        assert_eq!(protected(dir.path(), &retry), after_begin);
        assert!(execution::authorize(&vault, &retry).is_ok());
        let mut fresh_calls = Vec::new();
        let outcome = execution::step(
            &vault,
            &retry,
            "en",
            &AtomicBool::new(false),
            bounded_tokens,
            |_, user, _, _, schema| {
                fresh_calls.push(schema);
                compiler::fixture_model(schema, user, false)
            },
        )
        .unwrap();
        assert_eq!(
            fresh_calls,
            if compatible_draft {
                vec![CompilerSchema::Review]
            } else {
                vec![CompilerSchema::Claims, CompilerSchema::Review]
            }
        );
        assert_eq!(outcome.state, WorkState::Running);
        assert!(outcome.publication.is_none());
        assert_eq!(
            std::fs::read(dir.path().join(&retry.source.raw_path)).unwrap(),
            before.1
        );
        assert_eq!(
            std::fs::read(dir.path().join(&retry.summary_path)).unwrap(),
            before.2
        );
    });
}

#[test]
fn latest_source_binding_mismatch_is_pending_and_never_reuses_old_context() {
    mismatched_latest_attempt(
        "compiler-live-view-source",
        |attempt| {
            attempt.identity.source.source_revision = "b".repeat(64);
        },
        false,
    );
}

#[test]
fn latest_origin_binding_mismatch_is_pending_and_never_reuses_old_context() {
    mismatched_latest_attempt(
        "compiler-live-view-origin",
        |attempt| {
            // Keep the same token: comparing only that field would reuse the grant.
            attempt.origin.vault_path = "/synthetic/unissued-other-vault".into();
        },
        true,
    );
}

#[test]
fn latest_role_binding_mismatch_is_pending_and_never_reuses_old_context() {
    mismatched_latest_attempt(
        "compiler-live-view-role",
        |attempt| {
            attempt.role_snapshot_id = "synthetic-unissued-role-snapshot".into();
        },
        true,
    );
}

#[test]
fn latest_identity_binding_mismatch_is_pending_and_never_reuses_old_context() {
    mismatched_latest_attempt(
        "compiler-live-view-identity",
        |attempt| {
            attempt.identity.contract.prompt = "synthetic-unissued-prompt-contract".into();
        },
        false,
    );
}

#[test]
fn latest_non_running_attempt_is_pending_and_never_reuses_old_context() {
    mismatched_latest_attempt(
        "compiler-live-view-state",
        |attempt| {
            attempt.state = WorkState::Stopped;
            attempt.reason = Some("synthetic previously stopped attempt".into());
        },
        true,
    );
}
