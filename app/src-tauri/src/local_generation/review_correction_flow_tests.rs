//! Mock transport proves limits and custody, never actual-model usefulness.

use super::*;
use crate::local_generation::activity_flow::{ActivityFlowFailure, ActivityFlowOutput};
use std::sync::atomic::Ordering;

fn run_correction(
    request: &Request,
    checked: &CheckedEvidence,
    enabled: bool,
    count: impl Fn(&str, &str) -> Result<usize, String>,
    generate: impl FnMut(&str, &str, i32, u32, GenerationSchema) -> Result<String, String>,
) -> Result<ActivityFlowOutput, ActivityFlowFailure> {
    activity_synthesis_steps_with_resolution_mode_observed(
        request,
        &checked.evidence,
        checked.originals.as_ref().unwrap(),
        request.origin.as_ref().unwrap(),
        count,
        generate,
        |_, _| panic!("no resolution requested"),
        |_| panic!("no resolution requested"),
        true,
        false,
        false,
        enabled,
        None,
    )
}

fn missing_review(schema: GenerationSchema, packet: &Value) -> String {
    let mut verdict: Value =
        serde_json::from_str(&review_reply(schema, packet, "supported")).unwrap();
    verdict["sourceCoverage"] = json!("missing");
    verdict["missingSpanIds"] = json!([packet["originalSpans"][0]["id"]]);
    verdict.to_string()
}

fn empty_focus(packet: &Value) -> String {
    json!({"version":"WikiSourceFocusClaimsQaV1", "packetSha256":packet["packetSha256"],
        "outcome":"insufficient_evidence", "claims":[]})
    .to_string()
}

#[test]
fn both_stage_corrections_are_independent_and_only_fresh_success_is_returned() {
    let (_dir, request, checked, _index) = fixture();
    let measured = RefCell::new(Vec::new());
    let mut inputs: Vec<Value> = Vec::new();
    let mut outputs: Vec<String> = Vec::new();
    let mut phases = Vec::new();
    let reply = run_correction(
        &request,
        &checked,
        true,
        |system, user| count_exact(&measured, system, user),
        |system, user, output, window, schema| {
            assert_measured(&measured, system, user);
            assert_eq!((output, window), (768, 4096));
            let packet: Value = serde_json::from_str(user).unwrap();
            let ordinal = inputs.len();
            let raw = match ordinal {
                0 => {
                    phases.push("extract");
                    empty_focus(&packet)
                }
                1 => {
                    phases.push("missing");
                    missing_review(schema, &packet)
                }
                2 => {
                    phases.push("initial_correct");
                    assert!(matches!(
                        schema,
                        GenerationSchema::WikiSourceFocusClaimsQaV1(_)
                    ));
                    assert_eq!(packet["originalSpans"], inputs[0]["originalSpans"]);
                    assert_eq!(
                        packet["initialExtractionCorrection"]["previousModelResult"],
                        outputs[0]
                    );
                    assert_ne!(packet["packetSha256"], inputs[0]["packetSha256"]);
                    focus_reply(&packet)
                }
                3 => {
                    phases.push("claim_review");
                    review_reply(schema, &packet, "supported")
                }
                4 => {
                    phases.push("draft");
                    json!({"answer":format!("첫 답변입니다. {ANSWER}"),"sources":["S1"]})
                        .to_string()
                }
                5 => {
                    phases.push("reject");
                    review_reply(schema, &packet, "unsupported")
                }
                6 => {
                    phases.push("answer_correct");
                    assert_eq!(schema, GenerationSchema::AskAnswerV1);
                    let mut expected: Value = inputs[4].clone();
                    expected["sourceFocusInterpretationRevision"] =
                        packet["sourceFocusInterpretationRevision"].clone();
                    expected["answerCorrection"] = packet["answerCorrection"].clone();
                    assert_eq!(packet, expected);
                    assert_eq!(
                        packet["answerCorrection"]["review"],
                        serde_json::from_str::<Value>(&outputs[5]).unwrap()
                    );
                    assert_eq!(packet["answerCorrection"]["untrustedModelJudgments"], true);
                    assert_ne!(
                        packet["sourceFocusInterpretationRevision"],
                        inputs[4]["sourceFocusInterpretationRevision"]
                    );
                    json!({"answer":ANSWER,"sources":["S1"]}).to_string()
                }
                7 => {
                    phases.push("final_review");
                    review_reply(schema, &packet, "supported")
                }
                _ => panic!("each stage has one correction allowance"),
            };
            inputs.push(packet);
            outputs.push(raw.clone());
            Ok(raw)
        },
    )
    .unwrap();
    assert_eq!(
        phases,
        [
            "extract",
            "missing",
            "initial_correct",
            "claim_review",
            "draft",
            "reject",
            "answer_correct",
            "final_review"
        ]
    );
    assert!(reply.answer.starts_with(ANSWER));
    assert!(!reply.answer.contains("첫 답변입니다"));
    assert_eq!(
        (
            reply.receipt.processed_windows,
            reply.receipt.extraction_batches,
            reply.receipt.automated_claim_reviews
        ),
        (2, 1, 1)
    );
    assert_eq!(
        (reply.receipt.proposed_claims, reply.receipt.selected_claims),
        (3, 3)
    );
    assert_eq!(
        (
            reply.receipt.initial_extraction_corrections,
            reply.receipt.answer_corrections
        ),
        (Some(1), Some(1))
    );
    assert_eq!(inputs[7]["answerInputRevision"], sha(outputs[6].as_bytes()));
    assert_ne!(
        inputs[5]["answerInputRevision"],
        inputs[7]["answerInputRevision"]
    );
    assert_eq!(
        reply.receipt.automated_answer_review_input_revision,
        sha(serde_json::to_string(&inputs[7]).unwrap().as_bytes())
    );
}

#[test]
fn a_second_negative_initial_review_never_replenishes_the_allowance() {
    let (_dir, request, checked, _index) = fixture();
    let mut schemas = Vec::new();
    let failure = run_correction(
        &request,
        &checked,
        true,
        |_, _| Ok(1800),
        |_, user, _, _, schema| {
            schemas.push(schema);
            let packet: Value = serde_json::from_str(user).unwrap();
            match schema {
                GenerationSchema::WikiSourceFocusClaimsQaV1(_) => Ok(empty_focus(&packet)),
                GenerationSchema::WikiClaimReviewV1(_) => Ok(missing_review(schema, &packet)),
                _ => panic!("failed initial review cannot generate an answer"),
            }
        },
    )
    .unwrap_err();
    assert_eq!(failure.code, "review_missing");
    assert_eq!(schemas.len(), 4);
}

#[test]
fn a_second_negative_final_review_cannot_deliver_or_retry_again() {
    let (_dir, request, checked, _index) = fixture();
    let mut schemas = Vec::new();
    let failure = run_correction(
        &request,
        &checked,
        true,
        |_, _| Ok(1800),
        |_, user, _, _, schema| {
            schemas.push(schema);
            let packet: Value = serde_json::from_str(user).unwrap();
            match schema {
                GenerationSchema::WikiSourceFocusClaimsQaV1(_) => Ok(focus_reply(&packet)),
                GenerationSchema::WikiClaimReviewV1(_) => {
                    Ok(review_reply(schema, &packet, "supported"))
                }
                GenerationSchema::AskAnswerV1 => {
                    Ok(json!({"answer":ANSWER,"sources":["S1"]}).to_string())
                }
                GenerationSchema::AskAnswerReviewV1 => {
                    Ok(review_reply(schema, &packet, "unsupported"))
                }
                _ => panic!("unexpected schema"),
            }
        },
    )
    .unwrap_err();
    assert_eq!(failure.code, "review_rejected");
    assert_eq!(schemas.len(), 6);
}

#[test]
fn actual_corrective_inputs_that_do_not_fit_or_cannot_be_counted_never_generate() {
    for initial in [true, false] {
        for count_error in [false, true] {
            let (_dir, request, checked, _index) = fixture();
            let corrective_counts = Cell::new(0);
            let mut calls = 0;
            let failure = run_correction(
                &request,
                &checked,
                true,
                |_, user| {
                    let packet: Value = serde_json::from_str(user).unwrap();
                    if packet
                        .get(if initial {
                            "initialExtractionCorrection"
                        } else {
                            "answerCorrection"
                        })
                        .is_some()
                    {
                        corrective_counts.set(corrective_counts.get() + 1);
                        return if count_error {
                            Err("local generation cancelled".into())
                        } else {
                            Ok(3321)
                        };
                    }
                    Ok(1800)
                },
                |_, user, _, _, schema| {
                    calls += 1;
                    let packet: Value = serde_json::from_str(user).unwrap();
                    match schema {
                        GenerationSchema::WikiSourceFocusClaimsQaV1(_) => Ok(if initial {
                            empty_focus(&packet)
                        } else {
                            focus_reply(&packet)
                        }),
                        GenerationSchema::WikiClaimReviewV1(_) => Ok(if initial {
                            missing_review(schema, &packet)
                        } else {
                            review_reply(schema, &packet, "supported")
                        }),
                        GenerationSchema::AskAnswerV1 => {
                            Ok(json!({"answer":ANSWER,"sources":["S1"]}).to_string())
                        }
                        GenerationSchema::AskAnswerReviewV1 => {
                            Ok(review_reply(schema, &packet, "unsupported"))
                        }
                        _ => panic!("unexpected schema"),
                    }
                },
            )
            .unwrap_err();
            assert_eq!(calls, if initial { 2 } else { 4 });
            assert_eq!(corrective_counts.get(), 1);
            if count_error {
                assert!(failure.detail.contains("local generation cancelled"));
            } else {
                assert_eq!(failure.code, "review_not_fit");
            }
        }
    }
}

#[test]
fn stop_role_or_source_changes_after_negative_review_prevent_corrective_count_and_generation() {
    for initial in [true, false] {
        for boundary in ["stop", "role", "source"] {
            let (_dir, request, checked, _index) = fixture();
            let cancelled = AtomicBool::new(false);
            let changed = Cell::new(false);
            let counted = Cell::new(0);
            let mut calls = 0;
            let failure = run_correction(
                &request,
                &checked,
                true,
                |_, _| {
                    crate::local_generation::stage_guard::run(
                        &cancelled,
                        || {
                            if changed.get() {
                                Err(format!("{boundary} changed"))
                            } else {
                                Ok(())
                            }
                        },
                        || {
                            counted.set(counted.get() + 1);
                            Ok(1800)
                        },
                    )
                },
                |_, user, _, _, schema| {
                    calls += 1;
                    let packet: Value = serde_json::from_str(user).unwrap();
                    let negative = if initial {
                        matches!(schema, GenerationSchema::WikiClaimReviewV1(_))
                    } else {
                        schema == GenerationSchema::AskAnswerReviewV1
                    };
                    if negative {
                        if boundary == "stop" {
                            cancelled.store(true, Ordering::Release);
                        } else {
                            changed.set(true);
                        }
                    }
                    match schema {
                        GenerationSchema::WikiSourceFocusClaimsQaV1(_) => Ok(if initial {
                            empty_focus(&packet)
                        } else {
                            focus_reply(&packet)
                        }),
                        GenerationSchema::WikiClaimReviewV1(_) => Ok(if initial {
                            missing_review(schema, &packet)
                        } else {
                            review_reply(schema, &packet, "supported")
                        }),
                        GenerationSchema::AskAnswerV1 => {
                            Ok(json!({"answer":ANSWER,"sources":["S1"]}).to_string())
                        }
                        GenerationSchema::AskAnswerReviewV1 => {
                            Ok(review_reply(schema, &packet, "unsupported"))
                        }
                        _ => panic!("unexpected schema"),
                    }
                },
            )
            .unwrap_err();
            assert_eq!(calls, if initial { 2 } else { 4 });
            assert!(counted.get() > 0);
            assert!(failure.detail.contains(if boundary == "stop" {
                "cancelled"
            } else {
                "changed"
            }));
        }
    }
}

#[test]
fn opt_out_and_uncertain_verdicts_preserve_single_attempt_failure_paths() {
    for enabled in [false, true] {
        for disposition in ["unsupported", "uncertain"] {
            let (_dir, request, checked, _index) = fixture();
            let mut calls = 0;
            let failure = run_correction(
                &request,
                &checked,
                enabled,
                |_, _| Ok(1800),
                |_, user, _, _, schema| {
                    calls += 1;
                    let packet: Value = serde_json::from_str(user).unwrap();
                    match schema {
                        GenerationSchema::WikiSourceFocusClaimsQaV1(_) => Ok(focus_reply(&packet)),
                        GenerationSchema::WikiClaimReviewV1(_) => {
                            Ok(review_reply(schema, &packet, disposition))
                        }
                        _ => panic!("negative initial review cannot deliver"),
                    }
                },
            )
            .unwrap_err();
            assert_eq!(
                failure.code,
                if disposition == "uncertain" {
                    "review_uncertain"
                } else {
                    "review_rejected"
                }
            );
            assert_eq!(
                calls,
                if enabled && disposition == "unsupported" {
                    4
                } else {
                    2
                }
            );
        }
    }
}
