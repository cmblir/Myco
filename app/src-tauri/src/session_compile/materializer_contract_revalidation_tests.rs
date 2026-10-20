//! Historical v4/v5/v6/v7 storage must receive fresh native admission under v8.
//! Completed history is synthetic, never a successful model/publication gate.
//! Partial history is produced by actual publish -> unavailable completion.

use super::*;

fn historical_v4_contract() -> CompilerContract {
    CompilerContract {
        compiler: "whole-session-compiler-v4".into(),
        schema: "SessionCompilationV1".into(),
        prompt: "source-claims-compilation-and-correlated-review-v4".into(),
    }
}

fn historical_v5_contract() -> CompilerContract {
    CompilerContract {
        compiler: "whole-session-compiler-v5".into(),
        schema: "SessionStructureV1".into(),
        prompt: "source-claims-structure-canonical-materialization-and-correlated-review-v5".into(),
    }
}

fn historical_v6_contract() -> CompilerContract {
    CompilerContract {
        compiler: "whole-session-compiler-v6".into(),
        schema: "SessionStructureV1".into(),
        prompt: "source-claims-structure-canonical-materialization-and-source-bound-review-v6"
            .into(),
    }
}

fn historical_v7_contract() -> CompilerContract {
    CompilerContract {
        compiler: "whole-session-compiler-v7".into(),
        schema: "SessionStructureV1".into(),
        prompt: "source-claims-structure-canonical-materialization-and-source-bound-review-v7"
            .into(),
    }
}

fn store_historical_checkpoint(fixture: &Fixture, old_contract: CompilerContract) {
    let plan = sources::prepare(&fixture.source, ORIGINAL, &fixture.origin, "en", |_, _| {
        Ok(800)
    })
    .unwrap();
    let mut pending = Pending::try_load(fixture.dir.path()).unwrap();
    let attempt = pending.compile_jobs[0].attempts.last_mut().unwrap();
    let compilation_output =
        if old_contract == historical_v6_contract() || old_contract == historical_v7_contract() {
            super::super::structure::empty_output().unwrap()
        } else {
            serde_json::json!({"version":"SessionCompilationV1","title":"",
            "titleClaimIds":[],"entities":[],"summaries":[]})
            .to_string()
        };
    attempt.identity.contract = old_contract;
    let old_signature = signature(&attempt.identity).unwrap();
    // Fixed token counts only locate synthetic packets. This stored draft is
    // unfinished/unreviewed work, not native compiler or publication authority.
    let mut progress =
        compiler::CompilerRun::new(&attempt.id, &old_signature).initial_progress(&plan);
    progress.next_packet = 1;
    progress.batches.push(CompilerBatch {
        index: 0,
        packet_revision: plan.packet_revision(0).unwrap(),
        extraction_output: serde_json::json!({"outcome":"insufficient_evidence","claims":[]})
            .to_string(),
        compilation_output,
        review_output: None,
    });
    attempt.compiler_progress = Some(progress);
    pending.save(fixture.dir.path()).unwrap();
}

fn assert_fresh_v8_admission(
    fixture: &Fixture,
    old: &SessionCompileContext,
    old_state: WorkState,
    receipt_count: usize,
    old_contract: CompilerContract,
) {
    let before = Pending::try_load(fixture.dir.path()).unwrap();
    let old_job = &before.compile_jobs[0];
    assert_eq!(before.compile_jobs.len(), 1);
    assert_eq!(old_job.state, old_state);
    assert_eq!(old_job.attempts.len(), 1);
    assert_eq!(old_job.receipts.len(), receipt_count);
    let old_attempt = &old_job.attempts[0];
    assert_eq!(old_attempt.id, old.attempt_id);
    assert_eq!(old_attempt.state, old_state);
    assert_eq!(old_attempt.identity.contract, old_contract);
    assert_eq!(old_attempt.outputs.len(), 1);
    let old_signature = signature(&old_attempt.identity).unwrap();
    let old_progress = old_attempt.compiler_progress.as_ref().unwrap();
    assert_eq!(old_progress.compile_signature, old_signature);
    assert_eq!(old_progress.next_packet, 1);
    assert_eq!(old_progress.batches.len(), 1);
    assert!(old_progress.batches[0].review_output.is_none());
    let history = serde_json::to_value((&old_job.attempts, &old_job.receipts)).unwrap();
    let reminders = serde_json::to_value(&before.pending).unwrap();
    let queue_before = fixture.queue_bytes();
    let protected_before = fixture.protected_bytes();

    // Read-only observations must not silently re-admit historical work.
    let mut views = Vec::new();
    for _ in 0..2 {
        views.push(list_at(fixture.dir.path(), &fixture.origin, 3).unwrap());
        assert_eq!(fixture.queue_bytes(), queue_before);
        assert_eq!(fixture.protected_bytes(), protected_before);
    }
    let fresh = begin(
        &fixture.vault,
        &fixture.origin,
        fixture.source.clone(),
        RoleUsage::Automatic,
    )
    .unwrap_or_else(|error| {
        assert_eq!(fixture.queue_bytes(), queue_before);
        assert_eq!(fixture.protected_bytes(), protected_before);
        panic!("historical {old_state:?} must receive fresh v8 admission: {error}");
    });
    assert_eq!(
        contract(),
        CompilerContract {
            compiler: "whole-session-compiler-v8".into(),
            schema: "SessionStructureV1".into(),
            prompt: "source-reading-layout-v1-structure-canonical-materialization-and-source-bound-review-v8"
                .into(),
        }
    );
    for view in views {
        assert_eq!(view.pending_total, 1);
        assert_eq!(view.items.len(), 1);
        let item = &view.items[0];
        assert_eq!(item.key, fixture.source.key);
        assert_eq!(item.raw_path, fixture.source.raw_path);
        assert_eq!(item.source_revision, fixture.source.source_revision);
        assert_eq!(item.compile_job_id.as_deref(), Some(old.job_id.as_str()));
        assert_eq!(item.summary_path.as_deref(), Some(SUMMARY_PATH));
        let (state, reason) = if old_state == WorkState::Completed {
            (
                WorkState::Pending,
                "compiler_contract_revalidation_required",
            )
        } else {
            (
                WorkState::Partial,
                "native_compilation_or_review_incomplete",
            )
        };
        assert_eq!(item.compilation_state, state);
        assert_eq!(item.compilation_reason.as_deref(), Some(reason));
    }

    assert_eq!(fresh.job_id, old.job_id);
    assert_ne!(fresh.attempt_id, old.attempt_id);
    assert_ne!(fresh.compile_signature, old_signature);
    assert_eq!(fresh.summary_path, SUMMARY_PATH);
    let after = Pending::try_load(fixture.dir.path()).unwrap();
    assert_eq!(after.compile_jobs.len(), 1);
    assert_eq!(serde_json::to_value(&after.pending).unwrap(), reminders);
    let job = &after.compile_jobs[0];
    assert_eq!(job.state, WorkState::Running);
    assert!(job.reason.is_none());
    assert_eq!(job.attempts.len(), 2);
    assert_eq!(
        serde_json::to_value((&job.attempts[..1], &job.receipts)).unwrap(),
        history
    );
    let attempt = &job.attempts[1];
    assert_eq!(attempt.identity, identity(&fresh));
    assert_eq!(attempt.identity.contract, contract());
    assert_eq!(attempt.state, WorkState::Running);
    assert!(attempt.reason.is_none());
    assert!(attempt.compiler_progress.is_none());
    assert!(attempt.outputs.is_empty());
    assert!(attempt.prepared_outputs.is_empty());
    assert_eq!(attempt.checks, ProcessingChecks::default());
    assert_eq!(fixture.protected_bytes(), protected_before);
    assert_eq!(
        read(&fixture.vault, &fresh, &fixture.source.raw_path)
            .unwrap()
            .raw,
        ORIGINAL
    );

    // Historical publications/receipts cannot finish the new attempt.
    let queue_before_finish = fixture.queue_bytes();
    assert!(complete(
        &fixture.vault,
        &fresh,
        std::slice::from_ref(&fresh.summary_path),
    )
    .is_err());
    assert_eq!(fixture.queue_bytes(), queue_before_finish);
    assert_eq!(fixture.protected_bytes(), protected_before);
    grants().lock().unwrap().remove(&fresh.attempt_id);
}

#[test]
fn historical_v4_completed_re_admission_requires_a_fresh_v8_attempt() {
    with_isolated_data("compiler-materializer-v4-completed", |_| {
        let fixture = fixture();
        let old = seed_completed_history(&fixture, historical_v4_contract());
        store_historical_checkpoint(&fixture, historical_v4_contract());
        assert_fresh_v8_admission(
            &fixture,
            &old,
            WorkState::Completed,
            1,
            historical_v4_contract(),
        );
    });
}

#[test]
fn historical_v5_completed_re_admission_requires_a_fresh_v8_attempt() {
    with_isolated_data("compiler-materializer-v5-completed", |_| {
        let fixture = fixture();
        let old = seed_completed_history(&fixture, historical_v5_contract());
        store_historical_checkpoint(&fixture, historical_v5_contract());
        assert_fresh_v8_admission(
            &fixture,
            &old,
            WorkState::Completed,
            1,
            historical_v5_contract(),
        );
    });
}

#[test]
fn historical_v6_completed_re_admission_requires_a_fresh_v8_attempt() {
    with_isolated_data("compiler-materializer-v6-completed", |_| {
        let fixture = fixture();
        let old = seed_completed_history(&fixture, historical_v6_contract());
        store_historical_checkpoint(&fixture, historical_v6_contract());
        assert_fresh_v8_admission(
            &fixture,
            &old,
            WorkState::Completed,
            1,
            historical_v6_contract(),
        );
    });
}

fn assert_historical_partial_re_admission(old_contract: CompilerContract) {
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
    assert_eq!(
        result["publicationValidation"]["markdownSyntaxAndCitation"],
        true
    );
    let partial = Pending::try_load(fixture.dir.path()).unwrap();
    assert_eq!(partial.compile_jobs[0].state, WorkState::Partial);
    assert_eq!(
        partial.compile_jobs[0].attempts[0].state,
        WorkState::Partial
    );
    assert_eq!(
        partial.compile_jobs[0].attempts[0].checks.semantic_review,
        CheckState::Unavailable
    );
    assert!(partial.compile_jobs[0].receipts.is_empty());
    // Human edits remain newer than the historical preview output receipt.
    std::fs::write(
        fixture.dir.path().join(SUMMARY_PATH),
        preview + "\nLater human annotation.\n",
    )
    .unwrap();
    store_historical_checkpoint(&fixture, old_contract.clone());
    grants().lock().unwrap().remove(&old.attempt_id);
    assert_fresh_v8_admission(&fixture, &old, WorkState::Partial, 0, old_contract);
}

#[test]
fn historical_v4_unavailable_partial_re_admission_requires_a_fresh_v8_attempt() {
    with_isolated_data("compiler-materializer-v4-partial", |_| {
        assert_historical_partial_re_admission(historical_v4_contract());
    });
}

#[test]
fn historical_v5_unavailable_partial_re_admission_requires_a_fresh_v8_attempt() {
    with_isolated_data("compiler-materializer-v5-partial", |_| {
        assert_historical_partial_re_admission(historical_v5_contract());
    });
}

#[test]
fn historical_v6_unavailable_partial_re_admission_requires_a_fresh_v8_attempt() {
    with_isolated_data("compiler-materializer-v6-partial", |_| {
        assert_historical_partial_re_admission(historical_v6_contract());
    });
}

#[test]
fn source_reading_v7_completed_history_requires_a_fresh_v8_attempt() {
    with_isolated_data("compiler-source-reading-v7-completed", |_| {
        let fixture = fixture();
        let old = seed_completed_history(&fixture, historical_v7_contract());
        store_historical_checkpoint(&fixture, historical_v7_contract());
        assert_fresh_v8_admission(
            &fixture,
            &old,
            WorkState::Completed,
            1,
            historical_v7_contract(),
        );
    });
}

#[test]
fn source_reading_v7_unreviewed_partial_requires_a_fresh_v8_attempt() {
    with_isolated_data("compiler-source-reading-v7-partial", |_| {
        assert_historical_partial_re_admission(historical_v7_contract());
    });
}
