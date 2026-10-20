//! Synthetic historical v3 checkpoints must receive fresh current admission.

use super::*;

#[test]
fn previous_v3_completion_and_populated_checkpoint_require_a_fresh_current_attempt() {
    with_isolated_data("compiler-empty-structure-contract", |_| {
        let fixture = fixture();
        let old_contract = CompilerContract {
            compiler: "whole-session-compiler-v3".into(),
            schema: "SessionCompilationV1".into(),
            prompt: "source-claims-compilation-and-correlated-review-v4".into(),
        };
        assert_eq!(
            old_contract.prompt,
            "source-claims-compilation-and-correlated-review-v4"
        );
        seed_completed_history(&fixture, old_contract);
        let plan = sources::prepare(&fixture.source, ORIGINAL, &fixture.origin, "en", |_, _| {
            Ok(800)
        })
        .unwrap();
        let mut before = Pending::try_load(fixture.dir.path()).unwrap();
        let attempt = before.compile_jobs[0].attempts.last_mut().unwrap();
        let old_signature = signature(&attempt.identity).unwrap();
        attempt.compiler_progress = Some(state::CompilerProgress {
            version: 1,
            source_revision: fixture.source.source_revision.clone(),
            compile_signature: old_signature.clone(),
            plan_revision: plan.revision.clone(),
            next_packet: 1,
            batches: vec![CompilerBatch {
                index: 0,
                packet_revision: plan.packet_revision(0).unwrap(),
                extraction_output:
                    serde_json::json!({"outcome":"insufficient_evidence","claims":[]}).to_string(),
                compilation_output: serde_json::json!({"version":"SessionCompilationV1","title":"",
                    "titleClaimIds":[],"entities":[],"summaries":[]})
                .to_string(),
                review_output: Some(
                    serde_json::json!({"version":"SessionReviewV1","claims":[],"expressions":[],
                    "missingSpanIds":[],"sourceCoverage":"covered"})
                    .to_string(),
                ),
            }],
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
        assert_eq!(attempt.identity.contract, contract());
        assert!(attempt.compiler_progress.is_none());
        assert!(attempt.outputs.is_empty());
        assert!(attempt.prepared_outputs.is_empty());
        assert_eq!(attempt.checks, ProcessingChecks::default());
        assert_eq!(fixture.protected_bytes(), protected);
        grants().lock().unwrap().remove(&fresh.attempt_id);
    });
}
