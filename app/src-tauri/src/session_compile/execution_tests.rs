//! Synthetic native queue/lease tests with mocked generation. They do not
//! prove actual-model semantics, installed UI, networking or release quality.

use super::*;
use crate::importers::wikify::{source_revision, Pending, PendingItem};
use crate::role_authorization::RoleUsage;
use crate::settings::test_support::with_isolated_data;
use crate::vault_session::AgentVaultSession;
use serde_json::{json, Value};
use std::sync::atomic::AtomicBool;

#[cfg(feature = "native-index-probe")]
#[path = "execution_model_tests.rs"]
mod model_tests;

#[path = "execution_failure_tests.rs"]
mod failure_tests;

#[path = "execution_process_recovery_tests.rs"]
mod process_recovery_tests;

#[path = "execution_unreviewed_checkpoint_tests.rs"]
mod unreviewed_checkpoint_tests;

fn fixture() -> (
    tempfile::TempDir,
    VaultRoot,
    AgentVaultSession,
    super::super::SourceBinding,
) {
    let dir = tempfile::Builder::new()
        .prefix("myco-compiler-execution-synthetic-")
        .tempdir()
        .unwrap();
    let raw_path = "raw/conversations/codex/synthetic-native.md".to_string();
    let raw = "---\nsource: codex\nconversation_id: synthetic-native\ncreated: 2026-10-01\n---\n# Synthetic conversation\n\n**User:**\nPlease request the synthetic report.\n\n**Assistant:**\nI plan to draft the synthetic report; no completion is recorded.\n";
    crate::importers::wikify::append_raw(dir.path(), &raw_path, raw).unwrap();
    let source = super::super::SourceBinding {
        key: "codex:synthetic-native".into(),
        raw_path: raw_path.clone(),
        source_revision: source_revision(raw),
    };
    let mut pending = Pending::default();
    pending.push(PendingItem {
        key: source.key.clone(),
        raw_path,
        source_revision: source.source_revision.clone(),
        src_slug: "src-synthetic-native".into(),
        title: "Synthetic conversation".into(),
        imported: "2026-10-09".into(),
        read_ranges: vec![],
    });
    pending.save(dir.path()).unwrap();
    let vault = VaultRoot::default();
    reopen(&vault, dir.path());
    let origin = vault.snapshot().unwrap();
    (dir, vault, origin, source)
}

fn reopen(vault: &VaultRoot, path: &std::path::Path) {
    let generation = vault.begin_open().unwrap();
    vault
        .finish_open(generation, path.canonicalize().unwrap(), || ())
        .unwrap();
}

fn model(schema: CompilerSchema, user: &str, reject: bool) -> Result<String, String> {
    let packet: Value = serde_json::from_str(user).unwrap();
    Ok(match schema {
        CompilerSchema::Claims => json!({"outcome":"insufficient_evidence","claims":[]}),
        CompilerSchema::Compilation => json!({"version":"SessionCompilationV1", "title":"",
            "titleClaimIds":[],"entities":[],"summaries":[]}),
        CompilerSchema::Review => {
            assert_eq!(packet["requiredClaimIds"], json!([]));
            assert_eq!(packet["requiredExpressionIds"], json!([]));
            json!({"version":"SessionReviewV1","claims":[],"expressions":[],
                "missingSpanIds":[],"sourceCoverage":if reject {"uncertain"} else {"covered"}})
        }
    }
    .to_string())
}

#[test]
fn checkpoint_requires_native_source_review_and_inference_does_not_hold_opening_lock() {
    with_isolated_data("compiler-native-checkpoint", |_| {
        let (dir, vault, origin, source) = fixture();
        let context = super::super::begin(&vault, &origin, source, RoleUsage::Foreground).unwrap();
        let mut calls = Vec::new();
        let outcome = step(
            &vault,
            &context,
            "en",
            &AtomicBool::new(false),
            |_, _| Ok(800),
            |_, user, _, _, schema| {
                // Reacquisition would deadlock if inference held this guard.
                assert_eq!(
                    vault.snapshot().unwrap().opening_token,
                    origin.opening_token
                );
                calls.push(schema);
                model(schema, user, false)
            },
        )
        .unwrap();
        assert_eq!(calls, vec![CompilerSchema::Claims, CompilerSchema::Review]);
        assert_eq!(outcome.state, WorkState::Running);
        assert_eq!(outcome.next_packet, 1);
        assert!(outcome.publication.is_none());
        let pending = Pending::try_load(dir.path()).unwrap();
        let attempt = pending.compile_jobs[0].attempts.last().unwrap();
        assert_eq!(attempt.compiler_progress.as_ref().unwrap().batches.len(), 1);
        assert!(pending.compile_jobs[0].receipts.is_empty());
        assert!(!dir.path().join(&context.summary_path).exists());
    });
}

#[test]
fn generation_error_still_rechecks_changed_original_without_a_checkpoint() {
    with_isolated_data("compiler-native-changed-source", |_| {
        let (dir, vault, origin, source) = fixture();
        let context = super::super::begin(&vault, &origin, source, RoleUsage::Foreground).unwrap();
        let error = step(
            &vault,
            &context,
            "en",
            &AtomicBool::new(false),
            |_, _| Ok(800),
            |_, _, _, _, _| {
                std::fs::write(
                    dir.path().join(&context.source.raw_path),
                    "Synthetic changed original",
                )
                .unwrap();
                Err("synthetic generator failure".into())
            },
        )
        .err()
        .unwrap();
        assert!(
            error.to_string().contains("source revision changed"),
            "{error}"
        );
        let pending = Pending::try_load(dir.path()).unwrap();
        assert!(pending.compile_jobs[0]
            .attempts
            .last()
            .unwrap()
            .compiler_progress
            .is_none());
        assert!(pending.compile_jobs[0].receipts.is_empty());
    });
}

#[test]
fn same_path_reopen_during_model_call_never_checkpoints_old_attempt() {
    with_isolated_data("compiler-native-reopen", |_| {
        let (dir, vault, origin, source) = fixture();
        let context = super::super::begin(&vault, &origin, source, RoleUsage::Foreground).unwrap();
        let error = step(
            &vault,
            &context,
            "en",
            &AtomicBool::new(false),
            |_, _| Ok(800),
            |_, user, _, _, schema| {
                reopen(&vault, dir.path());
                model(schema, user, false)
            },
        )
        .err()
        .unwrap();
        assert!(
            error.to_string().contains("active vault changed"),
            "{error}"
        );
        assert!(
            Pending::try_load(dir.path()).unwrap().compile_jobs[0].attempts[0]
                .compiler_progress
                .is_none()
        );
    });
}

#[test]
fn cancellation_before_checkpoint_does_not_save_model_passed_output() {
    with_isolated_data("compiler-native-cancel", |_| {
        let (dir, vault, origin, source) = fixture();
        let context = super::super::begin(&vault, &origin, source, RoleUsage::Foreground).unwrap();
        let flag = AtomicBool::new(false);
        let error = step(
            &vault,
            &context,
            "en",
            &flag,
            |_, _| Ok(800),
            |_, user, _, _, schema| {
                if schema == CompilerSchema::Review {
                    flag.store(true, Ordering::Release);
                }
                model(schema, user, false)
            },
        )
        .err()
        .unwrap();
        assert!(error.to_string().contains("cancelled"));
        let pending = Pending::try_load(dir.path()).unwrap();
        assert!(pending.compile_jobs[0].attempts[0]
            .compiler_progress
            .is_none());
        assert!(pending.compile_jobs[0].receipts.is_empty());
    });
}

#[test]
fn fresh_attempt_rechecks_saved_batches_instead_of_reusing_review_authority() {
    with_isolated_data("compiler-native-resume", |_| {
        let (dir, vault, origin, source) = fixture();
        let old =
            super::super::begin(&vault, &origin, source.clone(), RoleUsage::Foreground).unwrap();
        step(
            &vault,
            &old,
            "en",
            &AtomicBool::new(false),
            |_, _| Ok(800),
            |_, user, _, _, schema| model(schema, user, false),
        )
        .unwrap();
        grants().lock().unwrap().remove(&old.attempt_id);
        let fresh = super::super::begin(&vault, &origin, source, RoleUsage::Foreground).unwrap();
        assert_ne!(fresh.attempt_id, old.attempt_id);
        let mut calls = Vec::new();
        let receipt = step(
            &vault,
            &fresh,
            "en",
            &AtomicBool::new(false),
            |_, _| Ok(800),
            |_, user, _, _, schema| {
                calls.push(schema);
                model(schema, user, true)
            },
        )
        .unwrap();
        assert_eq!(calls, vec![CompilerSchema::Review]);
        assert_eq!(receipt.step.as_ref().unwrap().packet_index, 0);
        assert!(!receipt.step.as_ref().unwrap().review_accepted);
        assert!(Pending::try_load(dir.path()).unwrap().compile_jobs[0]
            .receipts
            .is_empty());
    });
}

#[test]
fn empty_proposals_with_missing_source_coverage_finish_partial_without_publication() {
    with_isolated_data("compiler-native-empty-omission", |_| {
        let (dir, vault, origin, source) = fixture();
        let original = super::super::checked_source(dir.path(), &source).unwrap();
        let context = super::super::begin(&vault, &origin, source, RoleUsage::Foreground).unwrap();
        let mut outcomes = Vec::new();
        for _ in 0..3 {
            let outcome = step(
                &vault, &context, "en", &AtomicBool::new(false),
                |_, _| Ok(800),
                |_, user, _, _, schema| match schema {
                    CompilerSchema::Claims => model(schema, user, false),
                    CompilerSchema::Compilation => panic!("empty structure must not be model generated"),
                    CompilerSchema::Review => {
                        let input: Value = serde_json::from_str(user).unwrap();
                        assert_eq!(input["claims"], json!([]));
                        assert_eq!(input["compilation"]["title"], "");
                        Ok(json!({"version":"SessionReviewV1","claims":[],"expressions":[],
                            "missingSpanIds":[input["originalSpans"][0]["id"]],"sourceCoverage":"missing"}).to_string())
                    }
                },
            ).unwrap();
            assert!(!outcome.step.as_ref().unwrap().review_accepted);
            assert!(outcome.publication.is_none());
            outcomes.push(outcome);
        }
        assert_eq!(
            outcomes
                .iter()
                .map(|outcome| outcome.state)
                .collect::<Vec<_>>(),
            vec![WorkState::Running, WorkState::Running, WorkState::Partial]
        );
        let pending = Pending::try_load(dir.path()).unwrap();
        let job = &pending.compile_jobs[0];
        let attempt = job.attempts.last().unwrap();
        let progress = attempt.compiler_progress.as_ref().unwrap();
        assert_eq!(progress.next_packet, 3);
        assert_eq!(progress.batches.len(), 3);
        assert_eq!(attempt.state, WorkState::Partial);
        assert_eq!(
            attempt.checks.semantic_review,
            super::super::state::CheckState::Rejected
        );
        assert!(attempt.outputs.is_empty());
        assert!(attempt.prepared_outputs.is_empty());
        assert!(job.receipts.is_empty());
        assert!(!dir.path().join(&context.summary_path).exists());
        assert_eq!(
            super::super::checked_source(dir.path(), &context.source).unwrap(),
            original
        );
        grants().lock().unwrap().remove(&context.attempt_id);
    });
}
