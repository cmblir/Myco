//! Fake verdicts verify control/binding only, never model semantic quality.

use super::*;
use crate::commands::DateRange;
use crate::retrieval::Scope;
use crate::wiki_claims::{ActorRole, SourceDocument, SpanInput};
use serde_json::{json, Value};

fn fixture() -> (Request, Vec<Evidence>, SourceSet) {
    let origin = AgentVaultSession {
        vault_path: "/synthetic/ordinary-vault".into(),
        opening_token: "synthetic-opening".into(),
    };
    let role = serde_json::from_value(json!({
        "snapshotId":"synthetic-ordinary-role-shape", "origin":origin,
        "role":"ask", "usage":"foreground", "authorizationRevision":"synthetic",
        "routeSignature":{"role":"ask", "providerId":"builtin-local",
            "modelId":"qwen3.5-4b-q4_k_m", "effort":"none", "executionLocation":"in-process",
            "artifactRevision":"synthetic", "artifactSha256":"0".repeat(64),
            "runtimeContract":"synthetic-helper-only", "signature":"synthetic-shape-only"}
    }))
    .unwrap();
    let original =
        "The synthetic service uses port 4117.\nLater correction: the correct port is 4119.";
    let source = SourceDocument::bind(
        "S-original-note".into(),
        "wiki/ordinary.md".into(),
        "wiki/ordinary.md".into(),
        original,
        None,
        vec![SpanInput {
            id: "Q-original-note".into(),
            start: 0,
            end: original.len(),
            turn_id: "T0".into(),
            speaker: ActorRole::Unknown,
            turn_time: None,
        }],
    )
    .unwrap();
    let evidence = vec![Evidence {
        page: "wiki/ordinary.md".into(),
        stem: "Synthetic note".into(),
        title: None,
        section: 0,
        text: "Generated false completion and invented port 9999.".into(),
        compiled: None,
    }];
    let request = Request {
        model_id: None,
        request_id: "synthetic-ordinary-flow".into(),
        question: "Which port should this service use?".into(),
        previous_question: Some("Which service is described in the synthetic note?".into()),
        lang: "en".into(),
        hits: evidence.clone(),
        expected_vault: origin.vault_path.clone(),
        origin: Some(origin.clone()),
        role_snapshot: Some(role),
        scope: Scope::Wiki,
        range: None,
        paths: Some(vec!["wiki/ordinary.md".into()]),
        max_tokens: Some(768),
        activity_overview: false,
        resolution: None,
    };
    (
        request,
        evidence,
        SourceSet::new(origin, Scope::Wiki, vec![source], vec![]).unwrap(),
    )
}

fn draft() -> String {
    json!({"answer":"The note corrects the service port from 4117 to 4119.","sources":["S1"]})
        .to_string()
}

fn accepted_review() -> Value {
    json!({"version":"AskAnswerReviewV1","answerDisposition":"supported","taskResponse":"adequate",
        "sourceCoverage":"covered","missingSpanIds":[],"reason":"Synthetic control verdict, not semantic proof."})
}

#[test]
fn ordinary_flow_uses_two_closed_stages_and_unknown_timeless_originals_not_generated_text() {
    let (request, evidence, sources) = fixture();
    let mut calls = Vec::new();
    let answer = run(
        &request,
        &evidence,
        &sources,
        request.origin.as_ref().unwrap(),
        |_, _| Ok(500),
        |system, user, output, context, schema| {
            calls.push(schema);
            assert!(!user.contains("Generated false completion"));
            assert!(!user.contains("invented port 9999"));
            assert!(user.contains("Later correction"));
            let payload: Value = serde_json::from_str(user).unwrap();
            assert!(payload["context"]["activityPeriod"].is_null());
            assert!(payload["context"]["requestedPeriod"].is_null());
            assert!(payload["context"]["resolutionWindow"].is_null());
            assert_eq!(payload["context"]["previousQuestion"]["kind"], "topic_only");
            assert_eq!(
                payload["context"]["previousQuestion"]["question"],
                request.previous_question.as_deref().unwrap()
            );
            assert_eq!(payload["context"]["question"], request.question);
            match schema {
                GenerationSchema::AskAnswerV1 => {
                    assert_eq!((output, context), (768, 4096));
                    assert!(system.contains("Unknown note"));
                    assert_eq!(
                        payload["sources"][0]["originalSpans"][0]["speaker"],
                        "unknown"
                    );
                    assert!(payload["sources"][0]["originalSpans"][0]["turnTime"].is_null());
                    assert!(payload["sources"][0]["originalSpans"][0]["recordTime"].is_null());
                    Ok(draft())
                }
                GenerationSchema::AskAnswerReviewV1 => {
                    assert_eq!((output, context), (768, 4096));
                    assert!(system.contains("ENTIRE"));
                    assert_eq!(payload["originalSpans"].as_array().unwrap().len(), 1);
                    assert!(payload["independentVerificationReceipts"]
                        .as_array()
                        .unwrap()
                        .is_empty());
                    Ok(accepted_review().to_string())
                }
                _ => panic!("ordinary Ask dispatched an unrelated generation schema"),
            }
        },
    )
    .unwrap();
    assert_eq!(
        calls,
        vec![
            GenerationSchema::AskAnswerV1,
            GenerationSchema::AskAnswerReviewV1
        ]
    );
    assert!(answer.answer.contains("4119"));
    assert_eq!(answer.used_sources, vec!["wiki/ordinary.md"]);
    assert_eq!(answer.selected_chunks, 1);
    assert_eq!(answer.receipt.answer_original_spans, 1);
    assert_eq!(
        answer.receipt.automated_answer_review_input_revision.len(),
        64
    );
}

#[test]
fn ordinary_flow_preserves_requested_output_and_clamps_to_manifest_budget() {
    for (requested, expected) in [
        (None, 768),
        (Some(256), 256),
        (Some(0), 1),
        (Some(1200), 768),
    ] {
        let (mut request, evidence, sources) = fixture();
        request.max_tokens = requested;
        let mut calls = 0;
        let answer = run(
            &request,
            &evidence,
            &sources,
            request.origin.as_ref().unwrap(),
            |_, _| Ok(500),
            |_, _, output, context, schema| {
                calls += 1;
                assert_eq!(context, 4096);
                match schema {
                    GenerationSchema::AskAnswerV1 => {
                        assert_eq!(output, expected);
                        Ok(draft())
                    }
                    GenerationSchema::AskAnswerReviewV1 => {
                        assert_eq!(output, 768);
                        Ok(accepted_review().to_string())
                    }
                    _ => panic!("ordinary Ask dispatched an unrelated generation schema"),
                }
            },
        )
        .unwrap();
        assert_eq!(calls, 2);
        assert_eq!(answer.receipt.answer_original_spans, 1);
    }
}

#[test]
fn ordinary_flow_keeps_full_later_withdrawal_in_draft_and_review_even_with_one_support_hit() {
    let (mut request, evidence, _) = fixture();
    request.question = "What do the export records say?".into();
    let original="Build the export widget.\nAssistant reported completion.\nUser withdrew completion after failure; repair remains unverified.";
    let parts = [
        (0, 24, ActorRole::User),
        (24, 55, ActorRole::Assistant),
        (55, original.len(), ActorRole::User),
    ];
    let source = SourceDocument::bind(
        "S-full-transcript".into(),
        "sessions/ordinary.md".into(),
        evidence[0].page.clone(),
        original,
        None,
        parts
            .into_iter()
            .enumerate()
            .map(|(index, (start, end, speaker))| SpanInput {
                id: format!("Q-turn-{index}"),
                start,
                end,
                turn_id: format!("T{index}"),
                speaker,
                turn_time: None,
            })
            .collect(),
    )
    .unwrap();
    let source = source
        .with_turn_phases(&[
            ("T0".into(), Some("final".into())),
            ("T1".into(), Some("final".into())),
            ("T2".into(), Some("final".into())),
        ])
        .unwrap();
    let sources = SourceSet::new(
        request.origin.as_ref().unwrap().clone(),
        Scope::Wiki,
        vec![source],
        vec![],
    )
    .unwrap();
    let answer=run(&request,&evidence,&sources,request.origin.as_ref().unwrap(),|_,_|Ok(500),|_,user,_,_,schema|{
        let payload:Value=serde_json::from_str(user).unwrap();
        let spans=if schema==GenerationSchema::AskAnswerV1 { &payload["sources"][0]["originalSpans"] } else { &payload["originalSpans"] };
        assert_eq!(spans.as_array().unwrap().len(),3);
        assert!(spans[2]["text"].as_str().unwrap().contains("withdrew completion"));
        assert_eq!(spans[1]["speaker"],"assistant");
        assert_eq!(spans[2]["speaker"],"user");
        assert_eq!(spans[2]["sourcePhase"],"final");
        if schema==GenerationSchema::AskAnswerV1 {
            Ok(json!({"answer":"The assistant reported completion, but the user later withdrew that report after a failure.","sources":["S1"]}).to_string())
        } else { Ok(accepted_review().to_string()) }
    }).unwrap();
    assert_eq!(answer.receipt.answer_original_spans, 3);
}

#[test]
fn ordinary_flow_rejected_uncertain_missing_and_invalid_reviews_never_render_success() {
    let (request, evidence, sources) = fixture();
    for (field, value, code) in [
        ("answerDisposition", json!("unsupported"), "review_rejected"),
        ("taskResponse", json!("inadequate"), "review_rejected"),
        ("answerDisposition", json!("uncertain"), "review_uncertain"),
        ("sourceCoverage", json!("uncertain"), "review_uncertain"),
        ("sourceCoverage", json!("missing"), "review_missing"),
        ("semanticPassed", json!(true), "review_invalid"),
    ] {
        let mut review = accepted_review();
        review[field] = value;
        let result = run(
            &request,
            &evidence,
            &sources,
            request.origin.as_ref().unwrap(),
            |_, _| Ok(500),
            |_, _, _, _, schema| {
                Ok(if schema == GenerationSchema::AskAnswerV1 {
                    draft()
                } else {
                    review.to_string()
                })
            },
        );
        assert_eq!(result.unwrap_err().code, code);
    }
}

#[test]
fn ordinary_flow_review_errors_and_malformed_output_have_exact_failure_codes() {
    let (request, evidence, sources) = fixture();
    for (output, code) in [
        (Ok("not-json".into()), "review_invalid"),
        (Err("model unavailable".into()), "review_unavailable"),
        (Err("cancelled".into()), "review_stopped"),
    ] {
        let mut review = Some(output);
        let result = run(
            &request,
            &evidence,
            &sources,
            request.origin.as_ref().unwrap(),
            |_, _| Ok(500),
            |_, _, _, _, schema| {
                if schema == GenerationSchema::AskAnswerV1 {
                    Ok(draft())
                } else {
                    review.take().unwrap()
                }
            },
        );
        assert_eq!(result.unwrap_err().code, code);
    }
}

#[test]
fn ordinary_flow_entire_review_not_fit_never_sends_a_smaller_review_packet() {
    let (request, evidence, sources) = fixture();
    let mut calls = Vec::new();
    let result = run(
        &request,
        &evidence,
        &sources,
        request.origin.as_ref().unwrap(),
        |_, user| {
            let payload: Value = serde_json::from_str(user).unwrap();
            Ok(if payload.get("answerInputRevision").is_some() {
                4096
            } else {
                500
            })
        },
        |_, _, _, _, schema| {
            calls.push(schema);
            Ok(draft())
        },
    );
    assert_eq!(result.unwrap_err().code, "review_not_fit");
    assert_eq!(calls, vec![GenerationSchema::AskAnswerV1]);
}

#[test]
fn ordinary_flow_entire_draft_not_fit_never_generates_or_omits_sources() {
    let (request, evidence, sources) = fixture();
    let result = run(
        &request,
        &evidence,
        &sources,
        request.origin.as_ref().unwrap(),
        |_, _| Ok(4096),
        |_, _, _, _, _| panic!("over-budget original packet must not generate"),
    );
    assert_eq!(result.unwrap_err().code, "review_not_fit");
}

#[test]
fn ordinary_flow_public_prepare_source_cap_cannot_silently_drop_an_original_page() {
    let (mut request, _, _) = fixture();
    let mut evidence = Vec::new();
    let mut documents = Vec::new();
    for index in 0..7 {
        let page = format!("wiki/ordinary-{index}.md");
        let text = format!("Original synthetic fact for page {index}.");
        evidence.push(Evidence {
            page: page.clone(),
            stem: format!("Synthetic {index}"),
            section: 0,
            title: None,
            compiled: None,
            text: "Generated snippet".into(),
        });
        documents.push(
            SourceDocument::bind(
                format!("S-{index}"),
                page.clone(),
                page,
                &text,
                None,
                vec![SpanInput {
                    id: format!("Q-{index}"),
                    start: 0,
                    end: text.len(),
                    turn_id: "T0".into(),
                    speaker: ActorRole::Unknown,
                    turn_time: None,
                }],
            )
            .unwrap(),
        );
    }
    request.paths = Some(evidence.iter().map(|hit| hit.page.clone()).collect());
    let sources = SourceSet::new(
        request.origin.as_ref().unwrap().clone(),
        Scope::Wiki,
        documents,
        vec![],
    )
    .unwrap();
    let result = run(
        &request,
        &evidence,
        &sources,
        request.origin.as_ref().unwrap(),
        |_, _| Ok(100),
        |_, _, _, _, _| panic!("omitted source must fail before generation"),
    );
    assert_eq!(result.unwrap_err().code, "review_not_fit");
}

#[test]
fn ordinary_flow_long_single_source_cannot_be_replaced_with_a_short_hit() {
    let (request, evidence, _) = fixture();
    let original = "Original factual sentence. ".repeat(400);
    let source = SourceDocument::bind(
        "S-long".into(),
        evidence[0].page.clone(),
        evidence[0].page.clone(),
        &original,
        None,
        vec![SpanInput {
            id: "Q-long".into(),
            start: 0,
            end: original.len(),
            turn_id: "T0".into(),
            speaker: ActorRole::Unknown,
            turn_time: None,
        }],
    )
    .unwrap();
    let sources = SourceSet::new(
        request.origin.as_ref().unwrap().clone(),
        Scope::Wiki,
        vec![source],
        vec![],
    )
    .unwrap();
    let result = run(
        &request,
        &evidence,
        &sources,
        request.origin.as_ref().unwrap(),
        |_, _| Ok(100),
        |_, _, _, _, _| panic!("short selected hit cannot stand in for full original"),
    );
    assert_eq!(result.unwrap_err().code, "review_not_fit");
}

#[test]
fn ordinary_flow_missing_mapping_origin_or_selection_rejects_before_generation() {
    let (mut request, mut evidence, sources) = fixture();
    evidence[0].page = "wiki/unadmitted.md".into();
    let result = run(
        &request,
        &evidence,
        &sources,
        request.origin.as_ref().unwrap(),
        |_, _| Ok(100),
        |_, _, _, _, _| panic!("missing citation mapping must not generate"),
    );
    assert_eq!(result.unwrap_err().code, "source_verification_failed");
    let (original_request, evidence, _) = fixture();
    let origin = original_request.origin.unwrap();
    request.origin = None;
    assert_eq!(
        run(
            &request,
            &evidence,
            &sources,
            &origin,
            |_, _| Ok(100),
            |_, _, _, _, _| panic!("originless must not generate")
        )
        .unwrap_err()
        .code,
        "source_verification_failed"
    );
    request.origin = Some(origin.clone());
    request.role_snapshot = None;
    assert_eq!(
        run(
            &request,
            &evidence,
            &sources,
            &origin,
            |_, _| Ok(100),
            |_, _, _, _, _| panic!("unselected must not generate")
        )
        .unwrap_err()
        .code,
        "source_verification_failed"
    );
}

#[test]
fn ordinary_flow_request_period_and_followup_are_exact_optional_context() {
    let (mut request, evidence, sources) = fixture();
    request.range = Some(DateRange {
        start: "2026-10-03".into(),
        end: "2026-10-03".into(),
        start_epoch: None,
        end_epoch: None,
    });
    run(
        &request,
        &evidence,
        &sources,
        request.origin.as_ref().unwrap(),
        |_, _| Ok(500),
        |_, user, _, _, schema| {
            let payload: Value = serde_json::from_str(user).unwrap();
            assert_eq!(payload["context"]["requestedPeriod"]["start"], "2026-10-03");
            assert!(payload["context"]["activityPeriod"].is_null());
            assert!(payload["context"]["resolutionWindow"].is_null());
            assert!(!user.contains("previousAnswer"));
            Ok(if schema == GenerationSchema::AskAnswerV1 {
                draft()
            } else {
                accepted_review().to_string()
            })
        },
    )
    .unwrap();
}

#[test]
fn ordinary_flow_draft_decode_and_stop_fail_before_review() {
    let (request, evidence, sources) = fixture();
    for (output, code) in [
        (Ok("{\"answer\":\"unfinished".into()), "answer_incomplete"),
        (Err("cancelled".into()), "review_stopped"),
        (Err("model unavailable".into()), "generation_failed"),
    ] {
        let mut output = Some(output);
        let mut calls = 0;
        let result = run(
            &request,
            &evidence,
            &sources,
            request.origin.as_ref().unwrap(),
            |_, _| Ok(500),
            |_, _, _, _, schema| {
                calls += 1;
                assert_eq!(schema, GenerationSchema::AskAnswerV1);
                output.take().unwrap()
            },
        );
        assert_eq!(result.unwrap_err().code, code);
        assert_eq!(calls, 1);
    }
}

#[cfg(feature = "native-index-probe")]
fn qa_context(request: &Request) -> AskReviewContext {
    AskReviewContext::for_question(
        request.origin.as_ref().unwrap(),
        request.role_snapshot.as_ref().unwrap(),
        &request.request_id,
        &request.question,
        request.previous_question.as_deref(),
        &request.lang,
        request.scope,
        request.range.as_ref(),
        request.paths.as_deref(),
    )
    .unwrap()
}

#[cfg(feature = "native-index-probe")]
#[test]
fn grouped_qa_uses_exact_prepared_bytes_and_flat_keeps_existing_inputs() {
    use crate::local_synthesis::original_groups_qa;
    use std::cell::RefCell;
    let (request, evidence, sources) = fixture();
    let context = qa_context(&request);
    let flat = RefCell::new(Vec::new());
    run_with_context(
        &request,
        &evidence,
        &sources,
        &context,
        |_, _| Ok(500),
        |system, user, _, _, schema| {
            flat.borrow_mut().push((system.to_owned(), user.to_owned()));
            Ok(if schema == GenerationSchema::AskAnswerV1 {
                draft()
            } else {
                accepted_review().to_string()
            })
        },
    )
    .unwrap();
    for format in [QaWireFormat::Flat, QaWireFormat::SourceDocumentGroupsQaV1] {
        let counted = RefCell::new(Vec::new());
        let observed = RefCell::new(Vec::new());
        let answer = run_with_wire_format_qa(
            &request,
            &evidence,
            &sources,
            &context,
            format,
            |system, user| {
                counted
                    .borrow_mut()
                    .push((system.to_owned(), user.to_owned()));
                Ok(3320)
            },
            |system, user, output, window, schema| {
                assert_eq!((output, window), (768, 4096));
                assert_eq!(
                    counted.borrow().last().unwrap(),
                    &(system.to_owned(), user.to_owned())
                );
                let index = observed.borrow().len();
                let (mut expected_system, mut expected_user) = flat.borrow()[index].clone();
                if schema == GenerationSchema::AskAnswerV1 {
                    format.apply_draft(&mut expected_system, &mut expected_user)?;
                } else {
                    format.apply_review(&mut expected_system, &mut expected_user)?;
                }
                assert_eq!(
                    (system, user),
                    (expected_system.as_str(), expected_user.as_str())
                );
                if format != QaWireFormat::Flat {
                    assert!(system.ends_with(original_groups_qa::GROUP_INSTRUCTION));
                    let mut restored: Value = serde_json::from_str(user).unwrap();
                    if schema == GenerationSchema::AskAnswerV1 {
                        for source in restored["sources"].as_array_mut().unwrap() {
                            source["originalSpans"] =
                                original_groups_qa::decode(&source["originalSpans"].to_string())?;
                        }
                    } else {
                        restored["originalSpans"] =
                            original_groups_qa::decode(&restored["originalSpans"].to_string())?;
                    }
                    assert_eq!(
                        restored,
                        serde_json::from_str::<Value>(&flat.borrow()[index].1).unwrap()
                    );
                }
                observed
                    .borrow_mut()
                    .push((system.to_owned(), user.to_owned()));
                Ok(if schema == GenerationSchema::AskAnswerV1 {
                    draft()
                } else {
                    accepted_review().to_string()
                })
            },
        )
        .unwrap();
        assert_eq!(observed.borrow().len(), 2);
        assert_eq!(counted.borrow().len(), 2);
        assert_eq!(
            answer.receipt.automated_answer_review_input_revision,
            crate::importers::wikify::source_revision(&observed.borrow()[1].1)
        );
    }
}

#[cfg(feature = "native-index-probe")]
#[test]
fn grouped_qa_keeps_fit_failures_and_mandatory_review_without_retry_or_source_trimming() {
    use std::cell::{Cell, RefCell};
    let (request, evidence, sources) = fixture();
    let context = qa_context(&request);
    for review_overflow in [false, true] {
        let count_calls = Cell::new(0);
        let raw = RefCell::new(Vec::new());
        let error = run_with_wire_format_qa(
            &request,
            &evidence,
            &sources,
            &context,
            QaWireFormat::SourceDocumentGroupsQaV1,
            |_, _| {
                let call = count_calls.get();
                count_calls.set(call + 1);
                Ok(if !review_overflow || call == 1 {
                    3321
                } else {
                    500
                })
            },
            |_, _, _, _, schema| {
                assert_eq!(schema, GenerationSchema::AskAnswerV1);
                raw.borrow_mut().push(draft());
                Ok(draft())
            },
        )
        .unwrap_err();
        assert_eq!(error.code, "review_not_fit");
        assert_eq!(raw.borrow().len(), usize::from(review_overflow));
        assert_eq!(count_calls.get(), if review_overflow { 2 } else { 1 });
    }
    for (field, value, code) in [
        ("answerDisposition", "unsupported", "review_rejected"),
        ("answerDisposition", "uncertain", "review_uncertain"),
        ("sourceCoverage", "missing", "review_missing"),
    ] {
        let calls = Cell::new(0);
        let mut verdict = accepted_review();
        verdict[field] = json!(value);
        let error = run_with_wire_format_qa(
            &request,
            &evidence,
            &sources,
            &context,
            QaWireFormat::SourceDocumentGroupsQaV1,
            |_, _| Ok(500),
            |_, _, _, _, schema| {
                calls.set(calls.get() + 1);
                Ok(if schema == GenerationSchema::AskAnswerV1 {
                    draft()
                } else {
                    verdict.to_string()
                })
            },
        )
        .unwrap_err();
        assert_eq!(error.code, code);
        assert_eq!(calls.get(), 2);
    }
}
