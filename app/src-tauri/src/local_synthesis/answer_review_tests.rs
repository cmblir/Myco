use super::*;
use crate::local_synthesis::{prepare, Evidence};
use crate::wiki_claim_review::tests::fixture;

#[cfg(feature = "native-index-probe")]
#[path = "answer_review_dedup_tests.rs"]
mod dedup;
#[cfg(feature = "native-index-probe")]
#[path = "answer_review_feedback_tests.rs"]
mod feedback;
#[cfg(feature = "native-index-probe")]
#[path = "answer_review_wire_format_qa_tests.rs"]
mod wire_format_qa;

fn prompt(packet: &SourceSet) -> Prompt {
    prepare(
        "Synthetic work",
        None,
        "en",
        &[Evidence {
            page: "sessions/review.md".into(),
            stem: "Synthetic source".into(),
            section: 0,
            text: packet.spans().map(|span| span.text()).collect::<String>(),
            title: None,
            compiled: None,
        }],
        |_, _| Ok(true),
    )
    .unwrap()
}
fn output() -> serde_json::Value {
    json!({"version":"AskAnswerReviewV1","answerDisposition":"supported","taskResponse":"adequate",
        "sourceCoverage":"covered","missingSpanIds":[],"reason":"Synthetic plumbing verdict, not semantic proof."})
}
#[test]
fn answer_review_uses_originals_question_and_frozen_draft_with_exact_binding() {
    let (packet, _, context) = fixture();
    let mut prompt = prompt(&packet);
    let draft=super::super::answer_draft::validate_answer_draft(r#"{"answer":"The user requested an export button; completion has not been reported.","sources":["S1"]}"#,&prompt,"en").unwrap();
    let review = run(
        &context,
        &packet,
        &prompt,
        &draft,
        |system, user| {
            assert!(system.contains(crate::activity_recall::period_context::INSTRUCTIONS));
            let input: serde_json::Value = serde_json::from_str(user).unwrap();
            assert_eq!(input["recordPeriodContext"]["spans"][0]["spanId"], "Q0");
            assert_eq!(input["recordPeriodContext"]["counts"]["uncertainSpans"], 1);
            Ok(1000)
        },
        |system, user, output_tokens, context_tokens| {
            assert!(system.contains("ENTIRE"));
            assert_eq!((output_tokens, context_tokens), (768, 4096));
            let input: serde_json::Value = serde_json::from_str(user).unwrap();
            assert_eq!(input["context"]["question"], "Synthetic work");
            assert_eq!(input["originalSpans"][0]["speaker"], "user");
            assert!(input["originalSpans"][0]["text"]
                .as_str()
                .unwrap()
                .contains("Completion has not"));
            Ok(output().to_string())
        },
    )
    .unwrap();
    assert!(review.require_accepted().is_ok());
    assert!(review.binds(&context, &packet, &prompt, &draft));
    assert_eq!(review.input_revision().len(), 64);
    prompt.evidence[0].text.push_str(" changed");
    assert!(!review.binds(&context, &packet, &prompt, &draft));
}
#[test]
fn inadequate_quote_count_or_wrong_meaning_review_cannot_become_success() {
    let (packet, _, context) = fixture();
    let prompt = prompt(&packet);
    let draft = super::super::answer_draft::validate_answer_draft(
        r#"{"answer":"There are 598 items.","sources":["S1"]}"#,
        &prompt,
        "en",
    )
    .unwrap();
    for (field, value, code) in [
        ("answerDisposition", "unsupported", "review_rejected"),
        ("taskResponse", "inadequate", "review_rejected"),
        ("taskResponse", "uncertain", "review_uncertain"),
        ("sourceCoverage", "uncertain", "review_uncertain"),
    ] {
        let mut verdict = output();
        verdict[field] = json!(value);
        let review = run(
            &context,
            &packet,
            &prompt,
            &draft,
            |_, _| Ok(1000),
            |_, _, _, _| Ok(verdict.to_string()),
        )
        .unwrap();
        assert_eq!(review.require_accepted().unwrap_err().code(), code);
    }
}
#[test]
fn malformed_missing_ids_forged_fields_and_decoded_controls_fail_closed() {
    let (packet, _, context) = fixture();
    let prompt = prompt(&packet);
    let draft = super::super::answer_draft::validate_answer_draft(
        r#"{"answer":"Check the source.","sources":["S1"]}"#,
        &prompt,
        "en",
    )
    .unwrap();
    for mutation in 0..5 {
        let mut verdict = output();
        match mutation {
            0 => verdict["missingSpanIds"] = json!(["Q999"]),
            1 => verdict["semanticPassed"] = json!(true),
            2 => verdict["reason"] = json!("bad\u{0000}reason"),
            3 => verdict["missingSpanIds"] = json!(["Q0"]),
            _ => verdict["answerDisposition"] = json!("verified"),
        }
        assert_eq!(
            run(
                &context,
                &packet,
                &prompt,
                &draft,
                |_, _| Ok(1000),
                |_, _, _, _| Ok(verdict.to_string())
            )
            .unwrap_err()
            .code(),
            "review_invalid"
        );
    }
}
#[test]
fn full_packet_not_fit_and_failed_generation_do_not_issue_an_accepted_receipt() {
    let (packet, _, context) = fixture();
    let prompt = prompt(&packet);
    let draft = super::super::answer_draft::validate_answer_draft(
        r#"{"answer":"Check the source.","sources":["S1"]}"#,
        &prompt,
        "en",
    )
    .unwrap();
    assert_eq!(
        run(
            &context,
            &packet,
            &prompt,
            &draft,
            |_, _| Ok(5000),
            |_, _, _, _| panic!("must not generate")
        )
        .unwrap_err()
        .code(),
        "review_not_fit"
    );
    assert_eq!(
        run(
            &context,
            &packet,
            &prompt,
            &draft,
            |_, _| Ok(1000),
            |_, _, _, _| Err("model unavailable".into())
        )
        .unwrap_err()
        .code(),
        "review_unavailable"
    );
}

#[cfg(feature = "native-index-probe")]
fn focus_fixture(
    question: &str,
) -> (
    SourceSet,
    AskReviewContext,
    ActivityPrompt,
    ValidatedAnswerDraft,
) {
    use crate::commands::DateRange;
    use crate::local_llm::GenerationSchema;
    use crate::local_synthesis::claim_prompt;
    use crate::retrieval::Scope;
    use crate::vault_session::AgentVaultSession;
    let (packet, _, _) = fixture();
    let origin = AgentVaultSession {
        vault_path: "/synthetic/review-vault".into(),
        opening_token: "synthetic-opening".into(),
    };
    let range = DateRange {
        start: "2026-10-01".into(),
        end: "2026-10-04".into(),
        start_epoch: None,
        end_epoch: None,
    };
    let context =
        crate::wiki_claim_review::tests::context(question, "en", Scope::Sessions, &range, &origin)
            .with_source_focus_qa()
            .unwrap();
    // Verdicts are transport fixtures, not a native grant or model meaning proof.
    let extraction = claim_prompt::extract(question, "en", &range, &packet, &origin, Scope::Sessions, 768,
        |_, _| Ok(1000), |_, user, _, _, schema| {
            let input: serde_json::Value = serde_json::from_str(user).unwrap();
            match schema {
                GenerationSchema::WikiSourceFocusClaimsQaV1(_) => Ok(json!({
                    "version":"WikiSourceFocusClaimsQaV1","packetSha256":input["packetSha256"],
                    "outcome":"claims","claims":[
                        [0,"Please add the synthetic export button.","intention",[0],["user","speaker",null],
                            [null,"unknown","unknown","unknown",null],"request","requested",null],
                        [0,"Completion has not been reported.","record_or_verification_limit",[0],
                            ["unknown","unknown",null],[null,"unknown","unknown","unknown",null],
                            "report","unknown",null]
                    ]}).to_string()),
                GenerationSchema::WikiClaimReviewV1(_) => Ok(crate::wiki_claim_review::tests::accepting_review(user)),
                _ => panic!("unexpected fixture extraction schema"),
            }
        }, &context).unwrap();
    let evidence = vec![Evidence {
        page: "sessions/review.md".into(),
        stem: "Synthetic source".into(),
        section: 0,
        text: packet.spans().map(|span| span.text()).collect::<String>(),
        title: None,
        compiled: None,
    }];
    let prepared = claim_prompt::prepare_answer(
        question,
        "en",
        &range,
        &evidence,
        &packet,
        &extraction,
        |_, _| Ok(true),
    )
    .unwrap();
    let draft = super::super::answer_draft::validate_answer_draft(
        r#"{"answer":"The user requested an export button; completion has not been reported.","sources":["S1"]}"#,
        &prepared.prompt, "en").unwrap();
    (packet, context, prepared, draft)
}

#[cfg(feature = "native-index-probe")]
#[test]
fn focus_final_review_retains_native_proposals_and_binds_actual_compact_inputs() {
    use std::cell::RefCell;
    let (packet, context, mut activity, draft) = focus_fixture("Synthetic work");
    let answer: serde_json::Value = serde_json::from_str(&activity.prompt.user).unwrap();
    let proof_revision = activity
        .focus_answer
        .as_ref()
        .unwrap()
        .revision()
        .to_owned();
    let measured = RefCell::new(None::<(String, String)>);
    let generated = RefCell::new(None::<(String, String)>);
    let mut review = run_activity(
        &context,
        &packet,
        &activity,
        &draft,
        |system, user| {
            *measured.borrow_mut() = Some((system.into(), user.into()));
            // A byte-based transport mock; no actual tokenizer savings are claimed.
            Ok((system.len() + user.len()).div_ceil(4))
        },
        |system, user, output_tokens, context_tokens| {
            assert_eq!((output_tokens, context_tokens), (768, 4096));
            assert_eq!(
                measured.borrow().as_ref().unwrap(),
                &(system.to_owned(), user.to_owned())
            );
            assert!(system.contains("zero-based index into this unchanged claimProposals array"));
            let input: serde_json::Value = serde_json::from_str(user).unwrap();
            assert_eq!(
                input["originalSpans"],
                json!(activity
                    .focus_answer
                    .as_ref()
                    .unwrap()
                    .model_original_spans()
                    .unwrap())
            );
            for (model, native) in input["originalSpans"]
                .as_array()
                .unwrap()
                .iter()
                .zip(packet.spans())
            {
                let native = serde_json::to_value(native).unwrap();
                assert_eq!(model.as_object().unwrap().len(), 7);
                for field in [
                    "id",
                    "text",
                    "speaker",
                    "turnId",
                    "turnTime",
                    "recordTime",
                    "sourcePhase",
                ] {
                    assert_eq!(model[field], native[field]);
                }
            }
            assert_eq!(input["claimProposals"], answer["claimProposals"]);
            assert_eq!(
                input["sourceFocusInterpretations"],
                answer["sourceFocusInterpretations"]
            );
            assert_eq!(input["sourceFocusInterpretationRevision"], proof_revision);
            assert_eq!(user.matches(proof_revision.as_str()).count(), 1);
            assert!(input.get("sourceFocusInterpretationRevisions").is_none());
            for entry in input["sourceFocusInterpretations"].as_array().unwrap() {
                assert_eq!(entry.as_object().unwrap().len(), 2);
            }
            *generated.borrow_mut() = Some((system.into(), user.into()));
            Ok(output().to_string())
        },
    )
    .unwrap();
    let actual = generated.into_inner().unwrap();
    assert_eq!(measured.into_inner().unwrap(), actual);
    assert!(review.require_accepted().is_ok());
    assert!(review.binds_activity(&context, &packet, &activity, &draft));
    assert!(!review.binds(&context, &packet, &activity.prompt, &draft));
    assert_eq!(review.input_revision(), source_revision(&actual.1));
    assert_eq!(
        review.focus_revision.as_deref(),
        Some(proof_revision.as_str())
    );
    assert_eq!(
        review.focus_system_revision.as_deref(),
        Some(source_revision(&actual.0).as_str())
    );
    let old = review.focus_system_revision.take();
    assert!(!review.binds_activity(&context, &packet, &activity, &draft));
    review.focus_system_revision = old;
    let old = review.focus_revision.replace("0".repeat(64));
    assert!(!review.binds_activity(&context, &packet, &activity, &draft));
    review.focus_revision = old;
    review.input_revision = "0".repeat(64);
    assert!(!review.binds_activity(&context, &packet, &activity, &draft));
    activity.focus_answer = None;
    assert!(!review.binds_activity(&context, &packet, &activity, &draft));
}

#[cfg(feature = "native-index-probe")]
#[test]
fn missing_mutated_or_replayed_focus_proof_fails_before_token_count_or_generation() {
    use std::cell::Cell;
    for mutation in 0..9 {
        let (mut packet, mut context, mut activity, _) = focus_fixture("Synthetic work");
        let mut input: serde_json::Value = serde_json::from_str(&activity.prompt.user).unwrap();
        match mutation {
            0 => activity.focus_answer = None,
            1 => input["sourceFocusInterpretations"][0]["assertionKind"] = json!("uncertain"),
            2 => input["claimProposals"][0]["status"] = json!("reported_completed"),
            3 => {
                input["sources"][0]["originalSpans"][0]["text"] = json!("Changed synthetic source")
            }
            4 => input["sourceFocusInterpretationRevision"] = json!("0".repeat(64)),
            5 => {
                let (_, _, mut foreign, _) = focus_fixture("A different synthetic question");
                activity.focus_answer = foreign.focus_answer.take();
            }
            6 => input["claimProposals"][0]["actor"]["role"] = json!("assistant"),
            7 => {
                use crate::wiki_claims::{ActorRole, SourceDocument, SpanInput};
                let body="Please add the synthetic export button. Completion has not been reported. Changed synthetic tail.";
                let source = SourceDocument::bind(
                    "source".into(),
                    "sessions/review.md".into(),
                    "sessions/review.md".into(),
                    body,
                    None,
                    vec![SpanInput {
                        id: "Q0".into(),
                        start: 0,
                        end: body.len(),
                        turn_id: "T0".into(),
                        speaker: ActorRole::User,
                        turn_time: None,
                    }],
                )
                .unwrap();
                packet = SourceSet::new(
                    crate::vault_session::AgentVaultSession {
                        vault_path: "/synthetic/review-vault".into(),
                        opening_token: "synthetic-opening".into(),
                    },
                    crate::retrieval::Scope::Sessions,
                    vec![source],
                    vec![],
                )
                .unwrap();
            }
            _ => {
                let origin = crate::vault_session::AgentVaultSession {
                    vault_path: "/synthetic/review-vault".into(),
                    opening_token: "synthetic-opening".into(),
                };
                let period = crate::commands::DateRange {
                    start: "2026-10-01".into(),
                    end: "2026-10-03".into(),
                    start_epoch: None,
                    end_epoch: None,
                };
                context = crate::wiki_claim_review::tests::context(
                    "Synthetic work",
                    "en",
                    crate::retrieval::Scope::Sessions,
                    &period,
                    &origin,
                )
                .with_source_focus_qa()
                .unwrap();
            }
        }
        activity.prompt.user = input.to_string();
        // Revalidate against the changed public prompt so rejection must come
        // from its private proof, not merely the previous draft prompt hash.
        let draft = super::super::answer_draft::validate_answer_draft(
            r#"{"answer":"The user requested an export button; completion has not been reported.","sources":["S1"]}"#,
            &activity.prompt, "en").unwrap();
        let tokens = Cell::new(0);
        let calls = Cell::new(0);
        let error = run_activity(
            &context,
            &packet,
            &activity,
            &draft,
            |_, _| {
                tokens.set(tokens.get() + 1);
                Ok(1000)
            },
            |_, _, _, _| {
                calls.set(calls.get() + 1);
                Ok(output().to_string())
            },
        )
        .unwrap_err();
        assert_eq!(error.code(), "review_invalid");
        assert_eq!((tokens.get(), calls.get()), (0, 0));
    }
    let (packet, context, activity, draft) = focus_fixture("Synthetic work");
    assert_eq!(
        run(
            &context,
            &packet,
            &activity.prompt,
            &draft,
            |_, _| panic!("QA cannot use ordinary tokenizer"),
            |_, _, _, _| panic!("QA cannot use ordinary review")
        )
        .unwrap_err()
        .code(),
        "review_invalid"
    );
}

#[test]
fn ordinary_activity_final_review_keeps_exact_default_bytes_and_receipt_shape() {
    let (packet, _, context) = fixture();
    let prepared = prompt(&packet);
    let draft = super::super::answer_draft::validate_answer_draft(
        r#"{"answer":"The user requested an export button; completion has not been reported.","sources":["S1"]}"#,
        &prepared, "en").unwrap();
    let expected = prepare_base(&context, &packet, &prepared, &draft).unwrap();
    let ordinary = run(
        &context,
        &packet,
        &prepared,
        &draft,
        |_, _| Ok(1000),
        |_, _, _, _| Ok(output().to_string()),
    )
    .unwrap();
    let activity = ActivityPrompt {
        prompt: prepared,
        proposed_claims: 0,
        selected_claims: 0,
        omitted_claims: 0,
        original_spans: packet.spans().count(),
        selected_originals: packet.spans().cloned().collect(),
        #[cfg(feature = "native-index-probe")]
        focus_answer: None,
    };
    let review = run_activity(
        &context,
        &packet,
        &activity,
        &draft,
        |system, user| {
            assert_eq!(
                (system, user),
                (expected.system.as_str(), expected.user.as_str())
            );
            Ok(1000)
        },
        |system, user, _, _| {
            assert_eq!(
                (system, user),
                (expected.system.as_str(), expected.user.as_str())
            );
            Ok(output().to_string())
        },
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(&review).unwrap(),
        serde_json::to_value(ordinary).unwrap()
    );
    assert!(review.binds(&context, &packet, &activity.prompt, &draft));
    assert!(review.binds_activity(&context, &packet, &activity, &draft));
    let encoded = serde_json::to_value(review).unwrap();
    assert!(encoded.get("focusRevision").is_none());
    assert!(encoded.get("focusSystemRevision").is_none());
}

#[cfg(feature = "native-index-probe")]
#[test]
fn focus_final_review_keeps_full_input_budget_rejection_and_visible_cancellation() {
    let (packet, context, activity, draft) = focus_fixture("Synthetic work");
    let failure = run_activity(
        &context,
        &packet,
        &activity,
        &draft,
        |_, _| Ok(3321),
        |_, _, _, _| panic!("not-fit final review cannot generate"),
    )
    .unwrap_err();
    assert_eq!(failure.code(), "review_not_fit");
    let failure = run_activity(
        &context,
        &packet,
        &activity,
        &draft,
        |_, _| Ok(1000),
        |_, _, _, _| Err("local generation cancelled".into()),
    )
    .unwrap_err();
    assert_eq!(failure.code(), "review_stopped");
    assert!(failure.to_string().contains("local generation cancelled"));
}

#[path = "answer_review_factoring_tests.rs"]
mod factoring;
