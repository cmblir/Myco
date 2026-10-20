//! Synthetic plumbing/authority tests. The generation hooks are mocks and do
//! not establish actual-model semantic quality or release acceptance.

use super::*;
use crate::wiki_claims::{ActorRole, ClaimStatus, SourceDocument, SpanInput};
use serde_json::{json, Value};

#[path = "empty_compilation_tests.rs"]
mod empty_compilation_tests;

fn origin(token: &str) -> AgentVaultSession {
    AgentVaultSession {
        vault_path: "/synthetic/compiler-fixture".into(),
        opening_token: token.into(),
    }
}
fn raw(tail: bool) -> String {
    let mut text = "---\nsource: codex\nconversation_id: synthetic-session\ncreated: 2026-10-01\n---\n# Synthetic session\n\n**User:**\nPlease request the synthetic report.\n\n**Assistant:**\nThe synthetic report was completed.\n\n".to_string();
    for index in 0..30 {
        text.push_str(&format!(
            "**Assistant:**\nSynthetic coordination filler {index}; no observed human outcome.\n\n"
        ));
    }
    if tail {
        text.push_str(
            "**User:**\nThe synthetic report is withdrawn; do not treat it as completed.\n",
        );
    }
    text
}
fn binding(raw: &str) -> super::super::state::SourceBinding {
    super::super::state::SourceBinding {
        key: "codex:synthetic-session".into(),
        raw_path: "raw/conversations/codex/synthetic-r1.md".into(),
        source_revision: source_revision(raw),
    }
}
fn plan(raw: &str) -> PacketPlan {
    sources::prepare(&binding(raw), raw, &origin("process-a:1"), "en", |_, _| {
        Ok(800)
    })
    .unwrap()
}

pub(in crate::session_compile) fn model(
    schema: CompilerSchema,
    user: &str,
    rejected: bool,
) -> Result<String, String> {
    let input: Value = serde_json::from_str(user).unwrap();
    Ok(match schema {
        CompilerSchema::Claims => {
            let span = &input["originalSpans"][0];
            let text = span["text"].as_str().unwrap();
            let (act, status) = if text.contains("withdrawn") { ("retraction", "retracted") }
                else if text.contains("was completed") { ("report", "reported_completed") }
                else if text.contains("Please request") { ("request", "requested") }
                else { return Ok(json!({"outcome":"insufficient_evidence","claims":[]}).to_string()); };
            json!({"outcome":"claims","claims":[{
                "action": text.trim(), "anchorSpanId": span["id"], "supportSpanIds":[span["id"]],
                "actor":{"role":span["speaker"],"basis":"speaker","subjectSpanId":null},
                "eventTime":{"value":null,"basis":"unknown","precision":"unknown","uncertainty":"unknown","supportSpanId":null},
                "speechAct":act,"status":status,"verificationId":null
            }]})
        }
        CompilerSchema::Compilation => {
            let claims = input["claims"].as_array().unwrap();
            json!({"version":"SessionStructureV1",
                "title":if claims.is_empty(){""}else{"Synthetic report"},
                "titleClaimIds":claims.iter().take(1).map(|claim|claim["id"].clone()).collect::<Vec<_>>(),
                "entities":[]})
        }
        CompilerSchema::Review => {
            let decisions = |ids: &Value| ids.as_array().unwrap().iter().map(|id| json!({
                "id":id,"disposition":if rejected{"unsupported"}else{"supported"},
                "reason":"Synthetic mock disposition; not model-quality proof."})).collect::<Vec<_>>();
            json!({"version":"SessionReviewV1", "claims":decisions(&input["requiredClaimIds"]),
                "expressions":decisions(&input["requiredExpressionIds"]), "missingSpanIds":[],
                "sourceCoverage":if rejected{"uncertain"}else{"covered"}})
        }
    }.to_string())
}

fn finish_all(
    run: &mut CompilerRun,
    plan: &PacketPlan,
    raw: &str,
    progress: &mut CompilerProgress,
) {
    let original = CompilationOriginal::verify(raw, &plan.source.source_revision).unwrap();
    for _ in 0..plan.windows.len() {
        run.step(
            plan,
            &original,
            &origin("process-a:1"),
            "en",
            progress,
            |_, _| Ok(800),
            |_, user, _, _, schema| model(schema, user, false),
        )
        .unwrap();
    }
}

#[test]
fn long_tail_after_six_excerpts_and_twenty_four_windows_is_not_lost() {
    let raw = raw(true);
    let plan = plan(&raw);
    assert!(plan.windows.len() > 24);
    let original = CompilationOriginal::verify(&raw, &plan.source.source_revision).unwrap();
    let mut run = CompilerRun::new("attempt-a", "contract-role-signature-a");
    let mut progress = run.initial_progress(&plan);
    for index in 0..plan.windows.len() {
        let receipt = run
            .step(
                &plan,
                &original,
                &origin("process-a:1"),
                "en",
                &mut progress,
                |_, _| Ok(800),
                |_, user, _, _, schema| model(schema, user, false),
            )
            .unwrap();
        assert_eq!(receipt.packet_index, index);
        if index + 1 < plan.windows.len() {
            assert!(run.completed(&plan, &progress).unwrap().is_none());
        }
    }
    let artifact = run.completed(&plan, &progress).unwrap().unwrap();
    let claims: Vec<_> = artifact
        .packets()
        .iter()
        .flat_map(|packet| &packet.claims)
        .collect();
    assert_eq!(claims.len(), 3);
    assert_eq!(claims[0].claim.proposal.status, ClaimStatus::Requested);
    assert_eq!(
        claims[1].claim.proposal.status,
        ClaimStatus::ReportedCompleted
    );
    assert_eq!(claims[2].claim.proposal.status, ClaimStatus::Retracted);
    assert_eq!(
        claims[1].claim.provenance[0].speaker(),
        ActorRole::Assistant
    );
    assert_eq!(
        claims[2].claim.provenance[0].source_revision(),
        plan.source.source_revision
    );
    assert!(claims[2].claim.provenance[0].start() > raw.len() / 2);
    assert_eq!(artifact.checks().omitted_units, 0);
    assert!(!artifact.release_ground_truth);
    assert_eq!(artifact.independent_verification_receipts, 0);
}

#[test]
fn existing_activity_cap_is_explicit_but_not_inherited_by_session_compiler() {
    let raw = raw(true);
    let plan = plan(&raw);
    let document = SourceDocument::bind(
        "S1".into(),
        plan.source.raw_path.clone(),
        plan.source.raw_path.clone(),
        &raw,
        None,
        plan.windows
            .iter()
            .map(|window| SpanInput {
                id: window.id.clone(),
                start: window.start,
                end: window.end,
                turn_id: window.turn_id.clone(),
                speaker: window.speaker,
                turn_time: None,
            })
            .collect(),
    )
    .unwrap();
    let set = SourceSet::new(origin("process-a:1"), Scope::All, vec![document], vec![]).unwrap();
    let range = crate::commands::DateRange {
        start: "2026-10-01".into(),
        end: "2026-10-09".into(),
        start_epoch: None,
        end_epoch: None,
    };
    let legacy = crate::local_synthesis::claim_prompt::extract(
        "Synthetic recent work",
        "en",
        &range,
        &set,
        &origin("process-a:1"),
        Scope::All,
        768,
        |_, _| Ok(800),
        |_, user, _, _, schema| {
            if matches!(
                schema,
                crate::local_llm::GenerationSchema::WikiClaimReviewV1(_)
            ) {
                Ok(crate::wiki_claim_review::tests::accepting_review(user))
            } else {
                Ok(json!({"outcome":"insufficient_evidence","claims":[]}).to_string())
            }
        },
        &crate::wiki_claim_review::tests::context(
            "Synthetic recent work",
            "en",
            Scope::All,
            &range,
            &origin("process-a:1"),
        ),
    )
    .unwrap();
    assert_eq!(legacy.processed_spans, 24);
    assert!(legacy.omitted_spans > 0);
    let mut run = CompilerRun::new("attempt-a", "signature-a");
    let mut progress = run.initial_progress(&plan);
    finish_all(&mut run, &plan, &raw, &mut progress);
    assert_eq!(
        run.completed(&plan, &progress)
            .unwrap()
            .unwrap()
            .checks()
            .processed_units,
        plan.windows.len()
    );
}

#[test]
fn new_attempt_reviews_every_persisted_packet_instead_of_trusting_cursor_or_verdict() {
    let raw = raw(true);
    let plan = plan(&raw);
    let mut first = CompilerRun::new("attempt-a", "signature-a");
    let mut progress = first.initial_progress(&plan);
    finish_all(&mut first, &plan, &raw, &mut progress);
    let persisted = serde_json::to_vec(&progress).unwrap();
    let mut resumed: CompilerProgress = serde_json::from_slice(&persisted).unwrap();
    for batch in &mut resumed.batches {
        batch.review_output = Some("{\"passed\":true}".into());
    }
    let mut fresh = CompilerRun::new("attempt-b", "signature-a");
    assert!(fresh.completed(&plan, &resumed).unwrap().is_none());
    let original = CompilationOriginal::verify(&raw, &plan.source.source_revision).unwrap();
    let mut review_calls = 0;
    for index in 0..plan.windows.len() {
        fresh
            .step(
                &plan,
                &original,
                &origin("process-b:1"),
                "en",
                &mut resumed,
                |_, _| Ok(800),
                |_, user, _, _, schema| {
                    assert_eq!(schema, CompilerSchema::Review);
                    review_calls += 1;
                    model(schema, user, false)
                },
            )
            .unwrap();
        if index + 1 < plan.windows.len() {
            assert!(fresh.completed(&plan, &resumed).unwrap().is_none());
        }
    }
    assert_eq!(review_calls, plan.windows.len());
    assert_eq!(
        fresh
            .completed(&plan, &resumed)
            .unwrap()
            .unwrap()
            .attempt_id(),
        "attempt-b"
    );
}

#[test]
fn forged_skip_reordered_batch_or_changed_contract_is_rejected() {
    let raw = raw(true);
    let plan = plan(&raw);
    let mut run = CompilerRun::new("attempt-a", "signature-a");
    let original = CompilationOriginal::verify(&raw, &plan.source.source_revision).unwrap();
    let mut progress = run.initial_progress(&plan);
    progress.next_packet = plan.windows.len();
    assert!(run
        .step(
            &plan,
            &original,
            &origin("process-a:1"),
            "en",
            &mut progress,
            |_, _| Ok(800),
            |_, user, _, _, schema| model(schema, user, false)
        )
        .is_err());
    progress.next_packet = 0;
    run.step(
        &plan,
        &original,
        &origin("process-a:1"),
        "en",
        &mut progress,
        |_, _| Ok(800),
        |_, user, _, _, schema| model(schema, user, false),
    )
    .unwrap();
    let mut reordered = progress.clone();
    reordered.batches[0].index = 30;
    assert!(run.completed(&plan, &reordered).is_err());
    for change in ["source", "signature", "plan"] {
        let mut changed = progress.clone();
        match change {
            "source" => changed.source_revision = "b".repeat(64),
            "signature" => changed.compile_signature = "new".into(),
            _ => changed.plan_revision = "c".repeat(64),
        }
        assert!(run.completed(&plan, &changed).is_err());
    }
}

#[test]
fn valid_source_shape_but_rejected_semantics_never_issues_completion() {
    let raw = raw(false);
    let plan = plan(&raw);
    let original = CompilationOriginal::verify(&raw, &plan.source.source_revision).unwrap();
    let mut run = CompilerRun::new("attempt-a", "signature-a");
    let mut progress = run.initial_progress(&plan);
    for _ in &plan.windows {
        let receipt = run
            .step(
                &plan,
                &original,
                &origin("process-a:1"),
                "en",
                &mut progress,
                |_, _| Ok(800),
                |_, user, _, _, schema| model(schema, user, true),
            )
            .unwrap();
        assert!(receipt.source_schema_checked);
        assert!(!receipt.review_accepted);
    }
    assert!(run.completed(&plan, &progress).unwrap().is_none());
}

#[test]
fn unavailable_review_does_not_advance_a_durable_cursor() {
    let raw = raw(true);
    let plan = plan(&raw);
    let original = CompilationOriginal::verify(&raw, &plan.source.source_revision).unwrap();
    let mut run = CompilerRun::new("attempt-a", "signature-a");
    let mut progress = run.initial_progress(&plan);
    let before = serde_json::to_string(&progress).unwrap();
    let error = run
        .step(
            &plan,
            &original,
            &origin("process-a:1"),
            "en",
            &mut progress,
            |_, _| Ok(800),
            |_, user, _, _, schema| {
                if schema == CompilerSchema::Review {
                    Err("synthetic model unavailable".into())
                } else {
                    model(schema, user, false)
                }
            },
        )
        .unwrap_err();
    assert!(error.contains("unavailable"));
    assert_eq!(serde_json::to_string(&progress).unwrap(), before);
    assert!(run.completed(&plan, &progress).unwrap().is_none());
}

#[test]
fn full_stage_prompt_overflow_never_generates_or_advances_that_stage() {
    let raw = raw(false);
    let plan = plan(&raw);
    let original = CompilationOriginal::verify(&raw, &plan.source.source_revision).unwrap();
    for overflow in [
        CompilerSchema::Claims,
        CompilerSchema::Compilation,
        CompilerSchema::Review,
    ] {
        let mut run = CompilerRun::new("attempt-a", "signature-a");
        let mut progress = run.initial_progress(&plan);
        // Visit the empty preamble first so every arm tests a nonempty User
        // packet, including the model-generated compilation stage.
        run.step(
            &plan,
            &original,
            &origin("process-a:1"),
            "en",
            &mut progress,
            |_, _| Ok(800),
            |_, user, _, _, schema| model(schema, user, false),
        )
        .unwrap();
        assert_eq!(progress.next_packet, 1);
        let before = serde_json::to_string(&progress).unwrap();
        let mut calls = Vec::new();
        let error = run
            .step(
                &plan,
                &original,
                &origin("process-a:1"),
                "en",
                &mut progress,
                |_, user| {
                    let payload: Value = serde_json::from_str(user).unwrap();
                    let schema = if payload.get("requiredExpressionIds").is_some() {
                        CompilerSchema::Review
                    } else if payload.get("allowedClaimIds").is_some() {
                        CompilerSchema::Compilation
                    } else {
                        CompilerSchema::Claims
                    };
                    Ok(if schema == overflow { 3321 } else { 800 })
                },
                |_, user, _, _, schema| {
                    calls.push(schema);
                    model(schema, user, false)
                },
            )
            .unwrap_err();
        assert!(error.contains("cannot fit") || error.contains("smaller exact-source packet"));
        let expected = match overflow {
            CompilerSchema::Claims => vec![],
            CompilerSchema::Compilation => vec![CompilerSchema::Claims],
            CompilerSchema::Review => vec![CompilerSchema::Claims, CompilerSchema::Compilation],
        };
        assert_eq!(calls, expected);
        assert_eq!(serde_json::to_string(&progress).unwrap(), before);
        assert!(run.completed(&plan, &progress).unwrap().is_none());
    }
}

#[test]
fn model_passed_boolean_or_missing_decisions_is_not_review_authority() {
    let raw = raw(true);
    let plan = plan(&raw);
    let original = CompilationOriginal::verify(&raw, &plan.source.source_revision).unwrap();
    for malicious in [
        json!({"passed":true}),
        json!({"version":"SessionReviewV1","claims":[],
        "expressions":[],"missingSpanIds":[],"sourceCoverage":"covered","passed":true}),
    ] {
        let mut run = CompilerRun::new("attempt-a", "signature-a");
        let mut progress = run.initial_progress(&plan);
        assert!(run
            .step(
                &plan,
                &original,
                &origin("process-a:1"),
                "en",
                &mut progress,
                |_, _| Ok(800),
                |_, user, _, _, schema| if schema == CompilerSchema::Review {
                    Ok(malicious.to_string())
                } else {
                    model(schema, user, false)
                }
            )
            .is_err());
        assert!(run.completed(&plan, &progress).unwrap().is_none());
    }
}

#[test]
fn source_injection_cannot_invent_span_or_independent_verification() {
    let raw = raw(true);
    let plan = plan(&raw);
    let original = CompilationOriginal::verify(&raw, &plan.source.source_revision).unwrap();
    let mut run = CompilerRun::new("attempt-a", "signature-a");
    let mut progress = run.initial_progress(&plan);
    assert!(run.step(&plan,&original,&origin("process-a:1"),"en",&mut progress,|_,_|Ok(800),
        |_,user,_,_,schema| {
            if schema != CompilerSchema::Claims { panic!("invalid original claims must stop before later stages"); }
            let input: Value=serde_json::from_str(user).unwrap();
            let id=&input["originalSpans"][0]["id"];
            Ok(json!({"outcome":"claims","claims":[{"action":"Invented independently verified outcome",
                "anchorSpanId":id,"supportSpanIds":["Q-not-admitted"],
                "actor":{"role":"user","basis":"speaker","subjectSpanId":null},
                "eventTime":{"value":null,"basis":"unknown","precision":"unknown","uncertainty":"unknown","supportSpanId":null},
                "speechAct":"verification","status":"verified_completed","verificationId":"fabricated"}]}).to_string())
        }).is_err());
    assert_eq!(progress.next_packet, 0);
}

#[test]
fn native_run_rejects_same_path_reopen_and_changed_language() {
    let raw = raw(true);
    let plan = plan(&raw);
    let original = CompilationOriginal::verify(&raw, &plan.source.source_revision).unwrap();
    let mut run = CompilerRun::new("attempt-a", "signature-a");
    let mut progress = run.initial_progress(&plan);
    run.step(
        &plan,
        &original,
        &origin("process-a:1"),
        "en",
        &mut progress,
        |_, _| Ok(800),
        |_, user, _, _, schema| model(schema, user, false),
    )
    .unwrap();
    for (opening, lang) in [("process-a:2", "en"), ("process-a:1", "ko")] {
        assert!(run
            .step(
                &plan,
                &original,
                &origin(opening),
                lang,
                &mut progress,
                |_, _| Ok(800),
                |_, user, _, _, schema| model(schema, user, false)
            )
            .is_err());
    }
}

#[test]
fn fresh_different_language_attempt_does_not_reuse_old_packet_processing() {
    let raw = raw(true);
    let english = plan(&raw);
    let korean = sources::prepare(
        &binding(&raw),
        &raw,
        &origin("process-b:1"),
        "ko",
        |_, _| Ok(800),
    )
    .unwrap();
    assert_eq!(english.windows, korean.windows);
    assert_ne!(english.revision, korean.revision);
    let mut first = CompilerRun::new("attempt-a", "signature-a");
    let mut progress = first.initial_progress(&english);
    finish_all(&mut first, &english, &raw, &mut progress);
    let fresh = CompilerRun::new("attempt-b", "signature-a");
    assert!(fresh.completed(&korean, &progress).is_err());
    assert_eq!(fresh.initial_progress(&korean).language, "ko");
}

#[test]
fn schema_rejects_unknown_fields_and_empty_claim_title() {
    for invalid in [
        json!({"version":"SessionCompilationV1","title":"Invented title","titleClaimIds":[],"entities":[],"summaries":[]}),
        json!({"version":"SessionCompilationV1","title":"","titleClaimIds":[],"entities":[],"summaries":[],"completed":true}),
    ] {
        assert!(schema::validate(&invalid.to_string(), &[]).is_err());
    }
}

#[test]
fn turn_metadata_conflict_and_wrong_original_sha_are_not_compiled() {
    let invalid="---\nsource: codex\nconversation_id: synthetic-session\nturn_metadata: [{original_role: assistant}]\n---\n**User:**\nSynthetic request\n";
    assert!(sources::prepare(
        &binding(invalid),
        invalid,
        &origin("process-a:1"),
        "en",
        |_, _| Ok(800)
    )
    .is_err());
    let normal = raw(true);
    let mut source = binding(&normal);
    source.source_revision = "a".repeat(64);
    assert!(
        sources::prepare(&source, &normal, &origin("process-a:1"), "en", |_, _| Ok(
            800
        ))
        .is_err()
    );
}

#[path = "compiler_materialization_tests.rs"]
mod materialization_tests;

#[path = "review_decode_compiler_tests.rs"]
mod review_decode_tests;
