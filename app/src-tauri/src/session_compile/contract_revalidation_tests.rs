//! Synthetic persisted-history regressions over the actual native queue/begin.
//! Seeded Completed records model historical storage only: they do not prove
//! model meaning or create private compiler/publication authority. No inference
//! or semantic-pass generation callback is used by these tests.

use super::*;
use crate::settings::test_support::with_isolated_data;
use state::{CheckState, CompilationReceipt, CompilerBatch, NativeOutput, ProcessingChecks};

const ORIGINAL: &str = "---\nsource: codex\nconversation_id: contract-synthetic\nvia: mcp\n---\n# Synthetic original\n\n**User:**\nPlease prepare the synthetic report.\n";
const SUMMARY_PATH: &str = "wiki/contract-human.md";
const HUMAN_SUMMARY: &str = "---\ntype: source-summary\ntitle: Human title\nsession_key: codex:contract-synthetic\nannotation: retained\n# Human YAML comment\n---\n# Human title\n\nHuman annotation remains.\n";

struct Fixture {
    dir: tempfile::TempDir,
    vault: VaultRoot,
    origin: AgentVaultSession,
    source: SourceBinding,
}

impl Fixture {
    fn queue_bytes(&self) -> Vec<u8> {
        std::fs::read(Pending::path(self.dir.path())).unwrap()
    }

    fn protected_bytes(&self) -> (Vec<u8>, Vec<u8>) {
        (
            std::fs::read(self.dir.path().join(&self.source.raw_path)).unwrap(),
            std::fs::read(self.dir.path().join(SUMMARY_PATH)).unwrap(),
        )
    }
}

fn fixture() -> Fixture {
    crate::settings::save(&crate::settings::Settings {
        auto_ingest_enabled: true,
        ..Default::default()
    })
    .unwrap();
    let dir = tempfile::Builder::new()
        .prefix("myco-contract-revalidation-synthetic-")
        .tempdir()
        .unwrap();
    std::fs::create_dir_all(dir.path().join("wiki")).unwrap();
    std::fs::write(dir.path().join(SUMMARY_PATH), HUMAN_SUMMARY).unwrap();
    let source = SourceBinding {
        key: "codex:contract-synthetic".into(),
        raw_path: "raw/conversations/codex/contract-synthetic.md".into(),
        source_revision: source_revision(ORIGINAL),
    };
    crate::importers::wikify::append_raw(dir.path(), &source.raw_path, ORIGINAL).unwrap();
    let mut pending = Pending::default();
    pending.push(crate::importers::wikify::PendingItem {
        key: source.key.clone(),
        raw_path: source.raw_path.clone(),
        source_revision: source.source_revision.clone(),
        src_slug: "src-contract-synthetic".into(),
        title: "Synthetic source".into(),
        imported: "2026-10-09".into(),
        read_ranges: Vec::new(),
    });
    pending.save(dir.path()).unwrap();
    let vault = VaultRoot::default();
    let generation = vault.begin_open().unwrap();
    vault
        .finish_open(generation, dir.path().canonicalize().unwrap(), || ())
        .unwrap();
    let origin = vault.snapshot().unwrap();
    Fixture {
        dir,
        vault,
        origin,
        source,
    }
}

fn previous_contract() -> CompilerContract {
    let mut previous = contract();
    previous.prompt = format!("synthetic-previous-contract:{}", previous.prompt);
    previous
}

fn seed_completed_history(
    fixture: &Fixture,
    stored_contract: CompilerContract,
) -> SessionCompileContext {
    let context = begin(
        &fixture.vault,
        &fixture.origin,
        fixture.source.clone(),
        RoleUsage::Foreground,
    )
    .unwrap();
    assert_eq!(context.summary_path, SUMMARY_PATH);
    let mut pending = Pending::try_load(fixture.dir.path()).unwrap();
    let job = &mut pending.compile_jobs[0];
    let attempt = job.attempts.last_mut().unwrap();
    // This is a synthetic historical row, not a successful native completion.
    // The fixture deliberately never installs a compiler or live output grant.
    attempt.identity.contract = stored_contract;
    attempt.state = WorkState::Completed;
    attempt.reason = None;
    attempt.updated = attempt.started + 1;
    attempt.checks = ProcessingChecks {
        original_source: CheckState::Passed,
        source_schema: CheckState::Passed,
        semantic_review: CheckState::Passed,
        eligible_units: 1,
        processed_units: 1,
        omitted_units: 0,
    };
    attempt.outputs = vec![NativeOutput {
        publication_id: source_revision("Synthetic historical publication"),
        attempt_id: attempt.id.clone(),
        path: SUMMARY_PATH.into(),
        revision: source_revision(HUMAN_SUMMARY),
        identity: serde_json::json!({"syntheticHistoricalRecord": true}),
        native_created: false,
    }];
    let receipt = CompilationReceipt {
        attempt_id: attempt.id.clone(),
        identity: attempt.identity.clone(),
        outputs: attempt.outputs.clone(),
        checks: attempt.checks.clone(),
        completed: attempt.updated,
    };
    job.state = WorkState::Completed;
    job.reason = None;
    job.receipts.push(receipt);
    // The durable compiler job must remain discoverable without a legacy
    // reminder, as happens after a previous import has been marked complete.
    pending.pending.clear();
    pending.save(fixture.dir.path()).unwrap();
    grants().lock().unwrap().remove(&context.attempt_id);
    context
}

#[test]
fn previous_contract_completion_is_pending_in_read_only_native_listing() {
    with_isolated_data("compiler-old-contract-list", |_| {
        let fixture = fixture();
        let context = seed_completed_history(&fixture, previous_contract());
        let queue_before = fixture.queue_bytes();
        let protected_before = fixture.protected_bytes();
        for _ in 0..2 {
            let view = list_at(fixture.dir.path(), &fixture.origin, 3).unwrap();
            assert_eq!(view.pending_total, 1);
            assert_eq!(view.items.len(), 1);
            let item = &view.items[0];
            assert_eq!(item.key, fixture.source.key);
            assert_eq!(item.raw_path, fixture.source.raw_path);
            assert_eq!(item.source_revision, fixture.source.source_revision);
            assert_eq!(
                item.compile_job_id.as_deref(),
                Some(context.job_id.as_str())
            );
            assert_eq!(item.summary_path.as_deref(), Some(SUMMARY_PATH));
            assert_eq!(item.compilation_state, WorkState::Pending);
            assert_eq!(
                item.compilation_reason.as_deref(),
                Some("compiler_contract_revalidation_required")
            );
            assert_eq!(fixture.queue_bytes(), queue_before);
            assert_eq!(fixture.protected_bytes(), protected_before);
        }
        let stored = Pending::try_load(fixture.dir.path()).unwrap();
        assert_eq!(stored.compile_jobs[0].state, WorkState::Completed);
        assert_eq!(stored.compile_jobs[0].attempts.len(), 1);
        assert_eq!(stored.compile_jobs[0].receipts.len(), 1);
        let history_before = serde_json::to_value((
            &stored.compile_jobs[0].attempts[0],
            &stored.compile_jobs[0].receipts,
        ))
        .unwrap();
        let fresh = begin(
            &fixture.vault,
            &fixture.origin,
            fixture.source.clone(),
            RoleUsage::Automatic,
        )
        .unwrap();
        assert_ne!(fresh.attempt_id, context.attempt_id);
        let resumed = Pending::try_load(fixture.dir.path()).unwrap();
        let job = &resumed.compile_jobs[0];
        assert_eq!(job.attempts.len(), 2);
        assert_eq!(
            serde_json::to_value((&job.attempts[0], &job.receipts)).unwrap(),
            history_before
        );
        assert_eq!(job.attempts[1].identity, identity(&fresh));
        assert!(job.attempts[1].compiler_progress.is_none());
        assert!(job.attempts[1].outputs.is_empty());
        assert_eq!(job.attempts[1].checks, ProcessingChecks::default());
        assert_eq!(fixture.protected_bytes(), protected_before);
    });
}

#[test]
fn current_completion_stays_excluded_and_automatic_begin_rejects_duplicate() {
    with_isolated_data("compiler-current-contract-dedup", |_| {
        let fixture = fixture();
        seed_completed_history(&fixture, contract());
        let queue_before = fixture.queue_bytes();
        let protected_before = fixture.protected_bytes();
        let view = list_at(fixture.dir.path(), &fixture.origin, 3).unwrap();
        assert_eq!(view.pending_total, 0);
        assert!(view.items.is_empty());
        assert!(begin(
            &fixture.vault,
            &fixture.origin,
            fixture.source.clone(),
            RoleUsage::Automatic,
        )
        .is_err());
        assert_eq!(fixture.queue_bytes(), queue_before);
        assert_eq!(fixture.protected_bytes(), protected_before);
    });
}

#[test]
fn current_contract_completion_with_changed_local_role_requires_revalidation() {
    with_isolated_data("compiler-changed-local-role-list", |_| {
        let fixture = fixture();
        let context = seed_completed_history(&fixture, contract());
        assert_eq!(
            context.role_snapshot.route_signature.model_id,
            crate::local_model::SMALL_MODEL.id
        );
        role_authorization::select_role(role_authorization::RoleSelectionRequest {
            role: RoleId::Compilation,
            provider_id: "builtin-local".into(),
            model_id: crate::local_model::MODEL.id.into(),
            effort: "(default)".into(),
            expected_authorization_revision: role_authorization::settings_snapshot()
                .unwrap()
                .role_authorization_revision,
        })
        .unwrap();
        let queue_before = fixture.queue_bytes();
        let protected_before = fixture.protected_bytes();
        let view = list_at(fixture.dir.path(), &fixture.origin, 3).unwrap();
        assert_eq!(view.pending_total, 1);
        assert_eq!(view.items.len(), 1);
        assert_eq!(view.items[0].compilation_state, WorkState::Pending);
        assert_eq!(
            view.items[0].compilation_reason.as_deref(),
            Some("compiler_role_revalidation_required")
        );
        assert_eq!(fixture.queue_bytes(), queue_before);
        assert_eq!(fixture.protected_bytes(), protected_before);
        let fresh = begin(
            &fixture.vault,
            &fixture.origin,
            fixture.source.clone(),
            RoleUsage::Automatic,
        )
        .unwrap();
        assert_ne!(fresh.attempt_id, context.attempt_id);
        assert_eq!(
            fresh.role_snapshot.route_signature.model_id,
            crate::local_model::MODEL.id
        );
        assert_ne!(fresh.compile_signature, context.compile_signature);
        assert_eq!(fixture.protected_bytes(), protected_before);
    });
}

#[test]
fn completed_state_without_matching_historical_receipt_requires_revalidation() {
    with_isolated_data("compiler-missing-completion-receipt", |_| {
        let fixture = fixture();
        seed_completed_history(&fixture, contract());
        let mut pending = Pending::try_load(fixture.dir.path()).unwrap();
        pending.compile_jobs[0].receipts.clear();
        pending.save(fixture.dir.path()).unwrap();
        let queue_before = fixture.queue_bytes();
        let protected_before = fixture.protected_bytes();
        let view = list_at(fixture.dir.path(), &fixture.origin, 3).unwrap();
        assert_eq!(view.pending_total, 1);
        assert_eq!(view.items.len(), 1);
        assert_eq!(view.items[0].compilation_state, WorkState::Pending);
        assert_eq!(
            view.items[0].compilation_reason.as_deref(),
            Some("compiler_contract_revalidation_required")
        );
        assert_eq!(fixture.queue_bytes(), queue_before);
        assert_eq!(fixture.protected_bytes(), protected_before);
    });
}

#[test]
fn automatic_retry_of_previous_contract_discards_checkpoint_and_preserves_history() {
    with_isolated_data("compiler-old-contract-partial-retry", |_| {
        let fixture = fixture();
        let old = begin(
            &fixture.vault,
            &fixture.origin,
            fixture.source.clone(),
            RoleUsage::Automatic,
        )
        .unwrap();
        let preview = format!(
            "{HUMAN_SUMMARY}\nSynthetic source decision.[^src-contract]\n\n[^src-contract]: {}\n",
            fixture.source.raw_path
        );
        publish(
            &fixture.vault,
            &old,
            &old.summary_path,
            &preview,
            Some(&source_revision(HUMAN_SUMMARY)),
        )
        .unwrap();
        let result = complete(
            &fixture.vault,
            &old,
            std::slice::from_ref(&old.summary_path),
        )
        .unwrap();
        assert_eq!(result["ok"], false);
        assert_eq!(result["state"], "partial");
        assert_eq!(result["checks"]["semanticReview"], "unavailable");
        std::fs::write(
            fixture.dir.path().join(SUMMARY_PATH),
            preview + "\nLater human annotation.\n",
        )
        .unwrap();
        let mut pending = Pending::try_load(fixture.dir.path()).unwrap();
        let attempt = pending.compile_jobs[0].attempts.last_mut().unwrap();
        attempt.identity.contract = previous_contract();
        let previous_signature = signature(&attempt.identity).unwrap();
        // Seed unfinished, unreviewed old-contract work. The fixed token-count
        // fixture creates packet coordinates only; it is not a model smoke.
        let plan = sources::prepare(&fixture.source, ORIGINAL, &fixture.origin, "en", |_, _| {
            Ok(800)
        })
        .unwrap();
        let mut progress = compiler::CompilerRun::new(&old.attempt_id, &previous_signature)
            .initial_progress(&plan);
        progress.next_packet = 1;
        progress.batches.push(CompilerBatch {
            index: 0,
            packet_revision: plan.packet_revision(0).unwrap(),
            extraction_output: "{\"outcome\":\"insufficient_evidence\",\"claims\":[]}".into(),
            compilation_output: "{\"version\":\"SessionCompilationV1\",\"title\":\"\",\"titleClaimIds\":[],\"entities\":[],\"summaries\":[]}".into(),
            review_output: None,
        });
        attempt.compiler_progress = Some(progress);
        let history_before = serde_json::to_value(&*attempt).unwrap();
        pending.save(fixture.dir.path()).unwrap();
        grants().lock().unwrap().remove(&old.attempt_id);
        let protected_before = fixture.protected_bytes();
        let new = begin(
            &fixture.vault,
            &fixture.origin,
            fixture.source.clone(),
            RoleUsage::Automatic,
        )
        .unwrap();
        assert_ne!(new.attempt_id, old.attempt_id);
        assert_ne!(new.compile_signature, previous_signature);
        assert_eq!(new.summary_path, SUMMARY_PATH);
        let after = Pending::try_load(fixture.dir.path()).unwrap();
        let job = &after.compile_jobs[0];
        assert_eq!(job.attempts.len(), 2);
        assert_eq!(
            serde_json::to_value(&job.attempts[0]).unwrap(),
            history_before
        );
        assert_eq!(job.attempts[0].outputs.len(), 1);
        let fresh = &job.attempts[1];
        assert_eq!(fresh.identity, identity(&new));
        assert_eq!(fresh.identity.contract, contract());
        assert_eq!(fresh.state, WorkState::Running);
        assert!(fresh.compiler_progress.is_none());
        assert!(fresh.outputs.is_empty());
        assert!(fresh.prepared_outputs.is_empty());
        assert_eq!(fresh.checks, ProcessingChecks::default());
        assert!(job.receipts.is_empty());
        assert_eq!(fixture.protected_bytes(), protected_before);
        assert_eq!(
            read(&fixture.vault, &new, &fixture.source.raw_path)
                .unwrap()
                .raw,
            ORIGINAL
        );
        let queue_before_failed_completion = fixture.queue_bytes();
        assert!(complete(
            &fixture.vault,
            &new,
            std::slice::from_ref(&new.summary_path),
        )
        .is_err());
        assert_eq!(fixture.queue_bytes(), queue_before_failed_completion);
        assert_eq!(fixture.protected_bytes(), protected_before);
    });
}

#[test]
fn previous_packet_budget_contract_cannot_reuse_completion_or_checkpoint() {
    with_isolated_data("compiler-packet-budget-contract", |_| {
        let fixture = fixture();
        let mut old_contract = contract();
        old_contract.compiler = "whole-session-compiler-v2".into();
        seed_completed_history(&fixture, old_contract);
        let mut before = Pending::try_load(fixture.dir.path()).unwrap();
        let attempt = before.compile_jobs[0].attempts.last_mut().unwrap();
        let old_signature = signature(&attempt.identity).unwrap();
        attempt.compiler_progress = Some(state::CompilerProgress {
            version: 1,
            source_revision: fixture.source.source_revision.clone(),
            compile_signature: old_signature.clone(),
            plan_revision: source_revision("Synthetic previous 1400-token source plan"),
            next_packet: 0,
            batches: vec![],
            unreviewed_batch: None,
            language: "en".into(),
        });
        before.save(fixture.dir.path()).unwrap();
        let history = serde_json::to_value((
            &before.compile_jobs[0].attempts,
            &before.compile_jobs[0].receipts,
        ))
        .unwrap();
        let protected = fixture.protected_bytes();
        let queue_before = fixture.queue_bytes();
        let view = list_at(fixture.dir.path(), &fixture.origin, 3).unwrap();
        assert_eq!(view.pending_total, 1);
        assert_eq!(view.items[0].compilation_state, WorkState::Pending);
        assert_eq!(fixture.queue_bytes(), queue_before);
        let fresh = begin(
            &fixture.vault,
            &fixture.origin,
            fixture.source.clone(),
            RoleUsage::Automatic,
        )
        .unwrap();
        assert_ne!(fresh.compile_signature, old_signature);
        let after = Pending::try_load(fixture.dir.path()).unwrap();
        let job = &after.compile_jobs[0];
        assert_eq!(job.attempts.len(), 2);
        assert_eq!(
            serde_json::to_value((&job.attempts[..1], &job.receipts)).unwrap(),
            history
        );
        let attempt = job.attempts.last().unwrap();
        assert!(attempt.compiler_progress.is_none());
        assert!(attempt.outputs.is_empty());
        assert_eq!(attempt.checks, ProcessingChecks::default());
        assert_eq!(fixture.protected_bytes(), protected);
        grants().lock().unwrap().remove(&fresh.attempt_id);
    });
}

#[path = "contract_revalidation_failure_tests.rs"]
mod failure_tests;

#[path = "empty_compilation_contract_tests.rs"]
mod empty_compilation_contract_tests;

#[path = "materializer_contract_revalidation_tests.rs"]
mod materializer_contract_revalidation_tests;
