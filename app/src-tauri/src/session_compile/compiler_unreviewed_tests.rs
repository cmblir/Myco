//! Synthetic draft/phase tests; these do not establish model semantic quality.

use super::*;
use serde_json::{json, Value};

struct Fixture {
    raw: String,
    plan: PacketPlan,
    origin: AgentVaultSession,
}

fn fixture(body: &str) -> Fixture {
    let raw = format!("---\nsource: codex\nconversation_id: unreviewed-synthetic\n---\n{body}\n");
    let origin = AgentVaultSession {
        vault_path: "/synthetic/unreviewed-compiler".into(),
        opening_token: "synthetic-opening-a".into(),
    };
    let source = super::super::state::SourceBinding {
        key: "codex:unreviewed-synthetic".into(),
        raw_path: "raw/conversations/codex/unreviewed-synthetic.md".into(),
        source_revision: source_revision(&raw),
    };
    let plan = sources::prepare(&source, &raw, &origin, "en", |_, _| Ok(800)).unwrap();
    Fixture { raw, plan, origin }
}

fn request_fixture() -> Fixture {
    let fixture = fixture("**User:**\nPlease request the synthetic report.");
    assert_eq!(fixture.plan.windows.len(), 1);
    fixture
}

#[derive(Clone, Copy)]
enum Failure {
    Tokenizer,
    InputBudget,
    Transport,
}

fn unavailable(
    fixture: &Fixture,
    failure: Failure,
    empty: bool,
) -> (
    CompilerRun,
    CompilerProgress,
    Vec<CompilerSchema>,
    String,
    String,
) {
    let mut run = CompilerRun::new("synthetic-attempt-a", "synthetic-signature");
    let mut progress = run.initial_progress(&fixture.plan);
    let before = serde_json::to_string(&progress).unwrap();
    let original =
        CompilationOriginal::verify(&fixture.raw, &fixture.plan.source.source_revision).unwrap();
    let mut calls = Vec::new();
    let mut raw_claims = String::new();
    let mut raw_structure = if empty {
        structure::empty_output().unwrap()
    } else {
        String::new()
    };
    let error = run
        .step(
            &fixture.plan,
            &original,
            &fixture.origin,
            "en",
            &mut progress,
            |_, user| {
                let input: Value = serde_json::from_str(user).unwrap();
                if input.get("requiredExpressionIds").is_some() {
                    match failure {
                        Failure::Tokenizer => return Err("synthetic tokenizer unavailable".into()),
                        Failure::InputBudget => return Ok(3321),
                        Failure::Transport => {}
                    }
                }
                Ok(800)
            },
            |_, user, _, _, schema| {
                calls.push(schema);
                match schema {
                    CompilerSchema::Claims => {
                        raw_claims = format!(
                            " \n{}\n ",
                            if empty {
                                json!({"outcome":"insufficient_evidence","claims":[]}).to_string()
                            } else {
                                fixture_model(schema, user, false)?
                            }
                        );
                        Ok(raw_claims.clone())
                    }
                    CompilerSchema::Compilation => {
                        assert!(!empty, "empty structure must not use a model");
                        raw_structure = format!(" \n{}\n ", fixture_model(schema, user, false)?);
                        Ok(raw_structure.clone())
                    }
                    CompilerSchema::Review => Err("synthetic review transport unavailable".into()),
                }
            },
        )
        .unwrap_err();
    assert!(
        error.contains("unavailable") || error.contains("cannot fit"),
        "{error}"
    );
    assert_eq!(serde_json::to_string(&progress).unwrap(), before);
    assert!(run.completed(&fixture.plan, &progress).unwrap().is_none());
    (run, progress, calls, raw_claims, raw_structure)
}

#[test]
fn absent_unreviewed_tail_preserves_legacy_checkpoint_bytes() {
    let fixture = request_fixture();
    let run = CompilerRun::new("synthetic-attempt-a", "synthetic-signature");
    let progress = run.initial_progress(&fixture.plan);
    let legacy = format!(
        "{{\"version\":1,\"sourceRevision\":\"{}\",\"compileSignature\":\"synthetic-signature\",\"planRevision\":\"{}\",\"nextPacket\":0,\"batches\":[],\"language\":\"en\"}}",
        fixture.plan.source.source_revision, fixture.plan.revision,
    );
    assert_eq!(serde_json::to_string(&progress).unwrap(), legacy);
    let restored: CompilerProgress = serde_json::from_str(&legacy).unwrap();
    assert!(restored.unreviewed_batch.is_none());
    assert_eq!(serde_json::to_string(&restored).unwrap(), legacy);
}

#[test]
fn pre_output_review_failures_expose_exact_raw_tail_without_advancing_caller() {
    let fixture = request_fixture();
    for failure in [Failure::Tokenizer, Failure::InputBudget, Failure::Transport] {
        let (run, progress, calls, claims, structure) = unavailable(&fixture, failure, false);
        let checkpoint = run
            .unavailable_checkpoint(&fixture.plan, &progress)
            .unwrap()
            .unwrap();
        assert_eq!(checkpoint.next_packet, 0);
        assert!(checkpoint.batches.is_empty());
        let tail = checkpoint.unreviewed_batch.as_ref().unwrap();
        assert_eq!(tail.index, 0);
        assert_eq!(
            tail.packet_revision,
            fixture.plan.packet_revision(0).unwrap()
        );
        assert_eq!(tail.extraction_output, claims);
        assert_eq!(tail.compilation_output, structure);
        assert!(tail.review_output.is_none());
        assert!(claims.starts_with(" \n") && structure.ends_with("\n "));
        assert!(progress.batches.is_empty());
        assert!(progress.unreviewed_batch.is_none());
        assert!(run.completed(&fixture.plan, &checkpoint).unwrap().is_none());
        let checks = run.unavailable_checks(&fixture.plan).unwrap();
        assert_eq!(checks.original_source, CheckState::Passed);
        assert_eq!(checks.source_schema, CheckState::Passed);
        assert_eq!(checks.semantic_review, CheckState::Unavailable);
        assert_eq!(
            (
                checks.eligible_units,
                checks.processed_units,
                checks.omitted_units
            ),
            (1, 0, 1)
        );
        assert_eq!(
            calls[..2],
            [CompilerSchema::Claims, CompilerSchema::Compilation]
        );
        assert_eq!(
            calls.len(),
            if matches!(failure, Failure::Transport) {
                3
            } else {
                2
            }
        );
    }
}

#[test]
fn zero_claim_review_failures_preserve_app_structure_and_omit_only_structure_decode() {
    let fixture = request_fixture();
    for failure in [Failure::Tokenizer, Failure::InputBudget, Failure::Transport] {
        let (run, progress, calls, claims, structure) = unavailable(&fixture, failure, true);
        let checkpoint = run
            .unavailable_checkpoint(&fixture.plan, &progress)
            .unwrap()
            .unwrap();
        let tail = checkpoint.unreviewed_batch.unwrap();
        assert_eq!(tail.extraction_output, claims);
        assert_eq!(tail.compilation_output, structure::empty_output().unwrap());
        assert_eq!(structure, tail.compilation_output);
        assert!(tail.review_output.is_none());
        assert_eq!(calls[0], CompilerSchema::Claims);
        assert!(!calls.contains(&CompilerSchema::Compilation));
        assert_eq!(
            calls.len(),
            if matches!(failure, Failure::Transport) {
                2
            } else {
                1
            }
        );
        assert_eq!(
            run.unavailable_checks(&fixture.plan)
                .unwrap()
                .processed_units,
            0
        );
    }
}

#[test]
fn invalid_returned_review_never_issues_an_unavailable_checkpoint() {
    let fixture = request_fixture();
    let original =
        CompilationOriginal::verify(&fixture.raw, &fixture.plan.source.source_revision).unwrap();
    for output in [
        "synthetic unavailable but invalid JSON".into(),
        json!({"unavailable":true}).to_string(),
        "x".repeat(32 * 1024 + 1),
    ] {
        let mut run = CompilerRun::new("synthetic-attempt-a", "synthetic-signature");
        let mut progress = run.initial_progress(&fixture.plan);
        let before = serde_json::to_string(&progress).unwrap();
        assert!(run
            .step(
                &fixture.plan,
                &original,
                &fixture.origin,
                "en",
                &mut progress,
                |_, _| Ok(800),
                |_, user, _, _, schema| if schema == CompilerSchema::Review {
                    Ok(output.clone())
                } else {
                    fixture_model(schema, user, false)
                },
            )
            .is_err());
        assert_eq!(serde_json::to_string(&progress).unwrap(), before);
        assert!(run
            .unavailable_checkpoint(&fixture.plan, &progress)
            .unwrap()
            .is_none());
        assert!(run.unavailable_checks(&fixture.plan).is_none());
        assert!(run.completed(&fixture.plan, &progress).unwrap().is_none());
    }
}

#[test]
fn invalid_structure_fails_before_review_without_retaining_a_stage() {
    let fixture = request_fixture();
    let original =
        CompilationOriginal::verify(&fixture.raw, &fixture.plan.source.source_revision).unwrap();
    let mut run = CompilerRun::new("synthetic-attempt-a", "synthetic-signature");
    let mut progress = run.initial_progress(&fixture.plan);
    let before = serde_json::to_string(&progress).unwrap();
    let mut calls = Vec::new();
    assert!(run
        .step(
            &fixture.plan,
            &original,
            &fixture.origin,
            "en",
            &mut progress,
            |_, _| Ok(800),
            |_, user, _, _, schema| {
                calls.push(schema);
                if schema == CompilerSchema::Compilation {
                    structure::empty_output()
                } else {
                    fixture_model(schema, user, false)
                }
            },
        )
        .is_err());
    assert_eq!(calls, [CompilerSchema::Claims, CompilerSchema::Compilation]);
    assert_eq!(serde_json::to_string(&progress).unwrap(), before);
    assert!(run
        .unavailable_checkpoint(&fixture.plan, &progress)
        .unwrap()
        .is_none());
    assert!(run.unavailable_checks(&fixture.plan).is_none());
}

#[test]
fn new_foreground_run_rebinds_and_reviews_tail_without_regenerating_raw_output() {
    let fixture = request_fixture();
    let (first, initial, _, claims, structure) = unavailable(&fixture, Failure::Transport, false);
    let saved = first
        .unavailable_checkpoint(&fixture.plan, &initial)
        .unwrap()
        .unwrap();
    let bytes = serde_json::to_vec(&saved).unwrap();
    for rejected in [false, true] {
        let mut progress: CompilerProgress = serde_json::from_slice(&bytes).unwrap();
        let mut resumed = CompilerRun::new("synthetic-attempt-b", "synthetic-signature");
        let original =
            CompilationOriginal::verify(&fixture.raw, &fixture.plan.source.source_revision)
                .unwrap();
        let mut calls = Vec::new();
        let receipt = resumed
            .step(
                &fixture.plan,
                &original,
                &fixture.origin,
                "en",
                &mut progress,
                |_, _| Ok(800),
                |_, user, _, _, schema| {
                    calls.push(schema);
                    assert_eq!(schema, CompilerSchema::Review);
                    let input: Value = serde_json::from_str(user).unwrap();
                    assert_eq!(
                        input["compilation"]["version"],
                        "CanonicalSessionMaterializationV1"
                    );
                    assert_eq!(
                        input["claims"][0]["proposal"]["action"],
                        "Please request the synthetic report."
                    );
                    fixture_model(schema, user, rejected)
                },
            )
            .unwrap();
        assert_eq!(calls, [CompilerSchema::Review]);
        assert_eq!(receipt.review_accepted, !rejected);
        assert!(receipt.all_packets_seen);
        assert_eq!(progress.next_packet, 1);
        assert!(progress.unreviewed_batch.is_none());
        assert_eq!(progress.batches[0].extraction_output, claims);
        assert_eq!(progress.batches[0].compilation_output, structure);
        assert!(progress.batches[0].review_output.is_some());
        assert_eq!(
            resumed
                .completed(&fixture.plan, &progress)
                .unwrap()
                .is_some(),
            !rejected
        );
    }
}

#[test]
fn stored_batch_review_failure_preserves_prior_bytes_without_a_duplicate_tail() {
    let fixture = request_fixture();
    let original =
        CompilationOriginal::verify(&fixture.raw, &fixture.plan.source.source_revision).unwrap();
    let mut first = CompilerRun::new("synthetic-attempt-a", "synthetic-signature");
    let mut progress = first.initial_progress(&fixture.plan);
    first
        .step(
            &fixture.plan,
            &original,
            &fixture.origin,
            "en",
            &mut progress,
            |_, _| Ok(800),
            |_, user, _, _, schema| fixture_model(schema, user, false),
        )
        .unwrap();
    let before = serde_json::to_string(&progress).unwrap();
    let mut resumed = CompilerRun::new("synthetic-attempt-b", "synthetic-signature");
    assert!(resumed
        .step(
            &fixture.plan,
            &original,
            &fixture.origin,
            "en",
            &mut progress,
            |_, _| Ok(800),
            |_, _, _, _, schema| {
                assert_eq!(schema, CompilerSchema::Review);
                Err("synthetic stored review unavailable".into())
            }
        )
        .is_err());
    assert_eq!(serde_json::to_string(&progress).unwrap(), before);
    let checkpoint = resumed
        .unavailable_checkpoint(&fixture.plan, &progress)
        .unwrap()
        .unwrap();
    assert_eq!(serde_json::to_string(&checkpoint).unwrap(), before);
    assert!(checkpoint.unreviewed_batch.is_none());
    assert_eq!(checkpoint.next_packet, 1);
    assert_eq!(
        resumed
            .unavailable_checks(&fixture.plan)
            .unwrap()
            .processed_units,
        0
    );
    assert!(resumed
        .completed(&fixture.plan, &checkpoint)
        .unwrap()
        .is_none());
}

#[test]
fn zero_claim_tail_resume_reviews_the_full_original_without_new_extraction() {
    let fixture = request_fixture();
    let (first, progress, _, _, _) = unavailable(&fixture, Failure::Transport, true);
    let mut saved = first
        .unavailable_checkpoint(&fixture.plan, &progress)
        .unwrap()
        .unwrap();
    let original =
        CompilationOriginal::verify(&fixture.raw, &fixture.plan.source.source_revision).unwrap();
    let packet = fixture.plan.packet(0, &original, &fixture.origin).unwrap();
    let expected_spans = serde_json::to_value(packet.spans().collect::<Vec<_>>()).unwrap();
    let mut resumed = CompilerRun::new("synthetic-attempt-b", "synthetic-signature");
    let mut calls = Vec::new();
    resumed
        .step(
            &fixture.plan,
            &original,
            &fixture.origin,
            "en",
            &mut saved,
            |_, _| Ok(800),
            |_, user, _, _, schema| {
                calls.push(schema);
                assert_eq!(schema, CompilerSchema::Review);
                let input: Value = serde_json::from_str(user).unwrap();
                assert_eq!(input["originalSpans"], expected_spans);
                assert_eq!(input["claims"], json!([]));
                assert_eq!(input["compilation"]["summaries"], json!([]));
                fixture_model(schema, user, false)
            },
        )
        .unwrap();
    assert_eq!(calls, [CompilerSchema::Review]);
    assert_eq!(saved.next_packet, 1);
    assert!(saved.unreviewed_batch.is_none());
    assert!(resumed.completed(&fixture.plan, &saved).unwrap().is_some());
}

#[test]
fn rereviewing_prior_batches_keeps_the_later_unreviewed_tail_until_visited() {
    let fixture = fixture("**User:**\nPlease request the synthetic report.\n\n**Assistant:**\nThe synthetic report was completed.");
    assert_eq!(fixture.plan.windows.len(), 2);
    let original =
        CompilationOriginal::verify(&fixture.raw, &fixture.plan.source.source_revision).unwrap();
    let mut first = CompilerRun::new("synthetic-attempt-a", "synthetic-signature");
    let mut progress = first.initial_progress(&fixture.plan);
    first
        .step(
            &fixture.plan,
            &original,
            &fixture.origin,
            "en",
            &mut progress,
            |_, _| Ok(800),
            |_, user, _, _, schema| fixture_model(schema, user, false),
        )
        .unwrap();
    assert!(first
        .step(
            &fixture.plan,
            &original,
            &fixture.origin,
            "en",
            &mut progress,
            |_, _| Ok(800),
            |_, user, _, _, schema| if schema == CompilerSchema::Review {
                Err("synthetic later review unavailable".into())
            } else {
                fixture_model(schema, user, false)
            }
        )
        .is_err());
    let checks = first.unavailable_checks(&fixture.plan).unwrap();
    assert_eq!((checks.processed_units, checks.omitted_units), (1, 1));
    let mut saved = first
        .unavailable_checkpoint(&fixture.plan, &progress)
        .unwrap()
        .unwrap();
    let tail = serde_json::to_string(&saved.unreviewed_batch).unwrap();
    let before_rereview = serde_json::to_string(&saved).unwrap();
    let mut failed_resume = CompilerRun::new("synthetic-attempt-b", "synthetic-signature");
    assert!(failed_resume
        .step(
            &fixture.plan,
            &original,
            &fixture.origin,
            "en",
            &mut saved,
            |_, _| Ok(800),
            |_, _, _, _, schema| {
                assert_eq!(schema, CompilerSchema::Review);
                Err("synthetic earlier re-review unavailable".into())
            }
        )
        .is_err());
    let still_saved = failed_resume
        .unavailable_checkpoint(&fixture.plan, &saved)
        .unwrap()
        .unwrap();
    assert_eq!(serde_json::to_string(&saved).unwrap(), before_rereview);
    assert_eq!(
        serde_json::to_string(&still_saved).unwrap(),
        before_rereview
    );
    assert_eq!(
        failed_resume
            .unavailable_checks(&fixture.plan)
            .unwrap()
            .processed_units,
        0
    );
    let mut resumed = CompilerRun::new("synthetic-attempt-b", "synthetic-signature");
    for index in 0..2 {
        let receipt = resumed
            .step(
                &fixture.plan,
                &original,
                &fixture.origin,
                "en",
                &mut saved,
                |_, _| Ok(800),
                |_, user, _, _, schema| {
                    assert_eq!(schema, CompilerSchema::Review);
                    fixture_model(schema, user, false)
                },
            )
            .unwrap();
        assert_eq!(receipt.packet_index, index);
        if index == 0 {
            assert_eq!(
                serde_json::to_string(&saved.unreviewed_batch).unwrap(),
                tail
            );
            assert_eq!(saved.next_packet, 1);
            assert!(resumed.completed(&fixture.plan, &saved).unwrap().is_none());
        }
    }
    assert!(saved.unreviewed_batch.is_none());
    assert_eq!(saved.next_packet, 2);
    assert!(resumed.completed(&fixture.plan, &saved).unwrap().is_some());
}

#[test]
fn changed_progress_cannot_adopt_a_previously_issued_unavailable_stage() {
    let fixture = request_fixture();
    let (run, progress, _, _, _) = unavailable(&fixture, Failure::Transport, false);
    let changed = run
        .unavailable_checkpoint(&fixture.plan, &progress)
        .unwrap()
        .unwrap();
    assert!(run.unavailable_checkpoint(&fixture.plan, &changed).is_err());
}

#[test]
fn malformed_or_tampered_unreviewed_tail_is_rejected_before_any_model_call() {
    let fixture = request_fixture();
    let (run, progress, _, _, _) = unavailable(&fixture, Failure::Transport, false);
    let checkpoint = run
        .unavailable_checkpoint(&fixture.plan, &progress)
        .unwrap()
        .unwrap();
    let original =
        CompilationOriginal::verify(&fixture.raw, &fixture.plan.source.source_revision).unwrap();
    for change in ["index", "revision", "review", "structure", "claim-id"] {
        let mut changed = checkpoint.clone();
        let tail = changed.unreviewed_batch.as_mut().unwrap();
        match change {
            "index" => tail.index = 1,
            "revision" => tail.packet_revision = "a".repeat(64),
            "review" => tail.review_output = Some("{}".into()),
            "structure" => tail.compilation_output = "{}".into(),
            _ => {
                let mut proposal: Value = serde_json::from_str(&tail.compilation_output).unwrap();
                proposal["titleClaimIds"] = json!(["invented-native-id"]);
                tail.compilation_output = proposal.to_string();
            }
        }
        let before = serde_json::to_string(&changed).unwrap();
        let mut resumed = CompilerRun::new("synthetic-attempt-b", "synthetic-signature");
        assert!(resumed
            .step(
                &fixture.plan,
                &original,
                &fixture.origin,
                "en",
                &mut changed,
                |_, _| panic!("invalid stored tail must fail before tokenizer"),
                |_, _, _, _, _| panic!("invalid stored tail must fail before generation")
            )
            .is_err());
        assert_eq!(serde_json::to_string(&changed).unwrap(), before);
        assert!(resumed
            .unavailable_checkpoint(&fixture.plan, &changed)
            .unwrap()
            .is_none());
        assert!(resumed.unavailable_checks(&fixture.plan).is_none());
    }
}

#[test]
fn a_new_failed_step_clears_the_previous_private_unavailable_stage() {
    let fixture = request_fixture();
    let (mut run, mut progress, _, _, _) = unavailable(&fixture, Failure::Transport, false);
    let original =
        CompilationOriginal::verify(&fixture.raw, &fixture.plan.source.source_revision).unwrap();
    assert!(run
        .step(
            &fixture.plan,
            &original,
            &fixture.origin,
            "ja",
            &mut progress,
            |_, _| panic!("changed language must fail before tokenizer"),
            |_, _, _, _, _| panic!("changed language must fail before generation")
        )
        .is_err());
    assert!(run
        .unavailable_checkpoint(&fixture.plan, &progress)
        .unwrap()
        .is_none());
    assert!(run.unavailable_checks(&fixture.plan).is_none());
}
