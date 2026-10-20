//! Synthetic admission/review controls; verdicts establish no semantic truth.
use super::*;
use std::cell::{Cell, RefCell};

fn verdict(disposition: &str, task: &str, coverage: &str, missing: Vec<&str>) -> String {
    json!({"version":"AskAnswerReviewV1","answerDisposition":disposition,"taskResponse":task,
        "sourceCoverage":coverage,"missingSpanIds":missing,"reason":"Synthetic plumbing verdict only."}).to_string()
}
fn accepting() -> String {
    verdict("supported", "adequate", "covered", vec![])
}

#[test]
fn exact_sixteen_bind_every_original_field_and_keep_pair_context_without_serving_labels() {
    assert_eq!(source_revision(RUNTIME), RUNTIME_SHA256);
    let input: Value = serde_json::from_str(RUNTIME).unwrap();
    let cases = prepare_all().unwrap();
    assert_eq!(cases.len(), 16);
    let mut originals = 0;
    for (index, case) in cases.iter().enumerate() {
        let family = &input["families"][index / 2];
        let declared = &family["recordPeriodContext"];
        let meta = case.metadata();
        assert_eq!(
            case.id(),
            format!("F{:02}-P{:02}", index / 2 + 1, index % 2 + 1)
        );
        assert_eq!(meta["originalSpans"], family["originalSpans"]);
        assert_eq!(meta["declaredRecordPeriodContext"], *declared);
        assert_eq!(
            meta["context"]["answerReviewQualificationQa"]["declaredRecordPeriodContext"],
            *declared
        );
        assert_eq!(meta["context"]["resolutionWindow"], Value::Null);
        assert_eq!(
            meta["context"]["requestedPeriod"]["start"],
            declared["periodStart"]
        );
        let last = case.sources.spans().last().unwrap();
        assert_eq!(
            json!(last),
            family["originalSpans"]
                .as_array()
                .unwrap()
                .last()
                .unwrap()
                .clone()
        );
        for span in meta["originalSpans"].as_array().unwrap() {
            assert_eq!(span.as_object().unwrap().len(), 14);
            assert_eq!(span["sourcePhase"], Value::Null);
            assert!(matches!(
                span["speaker"].as_str(),
                Some("user" | "assistant")
            ));
        }
        if index % 2 == 0 {
            originals += case.original_count();
        }
        let (_, prompt, draft) = case.checked_inputs().unwrap();
        assert_eq!(draft.input_revision(), source_revision(case.raw_draft()));
        let role = case.request.role_snapshot.as_ref().unwrap();
        assert!(!case.context.matches_question_request(
            &case.origin,
            role,
            &case.request.request_id,
            &case.request.question,
            None,
            &case.request.lang,
            Scope::All,
            case.request.range.as_ref(),
            case.request.paths.as_deref()
        ));
        let packet: Value = serde_json::from_str(&prompt.user).unwrap();
        assert!(packet.get("references").is_none() && packet.get("correctProposalId").is_none());
        if index % 2 == 1 {
            let before = cases[index - 1].metadata();
            assert_eq!(meta["context"], before["context"]);
            assert_eq!(meta["contextRevision"], before["contextRevision"]);
            assert_eq!(meta["sourcePacketRevision"], before["sourcePacketRevision"]);
            assert_eq!(meta["originalSpans"], before["originalSpans"]);
            assert_ne!(case.raw_draft(), cases[index - 1].raw_draft());
        }
    }
    assert_eq!(originals, 26);
    assert_eq!(corpus_manifest().as_array().unwrap().len(), 16);
}

#[test]
fn source_header_span_selection_and_declared_period_changes_fail_admission() {
    for mutation in 0..12 {
        let mut value: Value = serde_json::from_str(RUNTIME).unwrap();
        let family = &mut value["families"][0];
        match mutation {
            0 => {
                let raw = family["documents"][0]["raw"].as_str().unwrap().to_owned();
                family["documents"][0]["raw"] = json!(format!("{raw}changed"));
            }
            1 => {
                family["documents"][0]["sha256"] = json!("0".repeat(64));
            }
            2 => {
                family["originalSpans"][0]["speaker"] = json!("assistant");
            }
            3 => {
                family["originalSpans"][0]["turnTime"] = json!("2026-02-05T09:10:00Z");
            }
            4 => {
                family["originalSpans"][0]["selectionPath"] = json!("sessions/other.md");
            }
            5 => {
                family["originalSpans"][0]["sourcePhase"] = json!("commentary");
            }
            6 => {
                family["originalSpans"][0]["recordTime"] = json!("2026-02-04T17:00:00Z");
            }
            7 => {
                family["recordPeriodContext"]["timeZone"] = json!("UTC+09");
            }
            8 => {
                family["recordPeriodContext"]["resolutionWindow"] = json!({"mode":"current"});
            }
            9 => {
                family["recordPeriodContext"]["asOf"] = Value::Null;
            }
            10 => {
                family["fixedDrafts"][0]["rawDraft"] =
                    json!("{\"answer\":\"합성 답변\",\"sources\":[\"S9\"]}");
            }
            _ => {
                family["documents"][0]["created"] = json!("2026-02-04T17:00:00Z");
            }
        };
        assert!(inputs::prepare(value).is_err(), "mutation {mutation}");
    }
}

#[test]
fn changed_captured_role_opening_draft_context_or_source_never_calls_callbacks() {
    for mutation in 0..9 {
        let mut cases = prepare_all().unwrap();
        let mut case = cases.remove(0);
        match mutation {
            0 => case
                .request
                .role_snapshot
                .as_mut()
                .unwrap()
                .origin
                .opening_token
                .push_str("changed"),
            1 => case.origin.opening_token.push_str("changed"),
            2 => case.raw_draft.push(' '),
            3 => case.declared["scope"] = json!("A different synthetic scope."),
            4 => case
                .request
                .paths
                .as_mut()
                .unwrap()
                .push("sessions/unprovided.md".into()),
            5 => case.sources = cases.remove(2).sources,
            6 => case.request.question.push_str(" changed"),
            7 => case.request.lang = "en".into(),
            _ => case.request.range.as_mut().unwrap().end_epoch = None,
        }
        let counts = Cell::new(0);
        let calls = Cell::new(0);
        assert!(case
            .run(
                |_, _| {
                    counts.set(counts.get() + 1);
                    Ok(1)
                },
                |_, _, _, _, _| {
                    calls.set(calls.get() + 1);
                    Ok(accepting())
                }
            )
            .is_err());
        assert_eq!((counts.get(), calls.get()), (0, 0), "mutation {mutation}");
    }
}

#[test]
fn reviewer_counts_and_generates_exact_same_full_packet_at_3320_without_writer() {
    let cases = prepare_all().unwrap();
    let case = &cases[10];
    let wire = RefCell::new(None);
    let calls = Cell::new(0);
    let review_sha = RefCell::new(String::new());
    let result = case
        .run(
            |system, user| {
                let packet: Value = serde_json::from_str(user).unwrap();
                assert_eq!(packet["originalSpans"], case.metadata()["originalSpans"]);
                assert_eq!(packet["context"], case.metadata()["context"]);
                assert_eq!(
                    packet["answerInputRevision"],
                    source_revision(case.raw_draft())
                );
                assert_eq!(packet["citations"].as_array().unwrap().len(), 2);
                *review_sha.borrow_mut() = source_revision(user);
                *wire.borrow_mut() = Some((system.to_owned(), user.to_owned()));
                Ok(3320)
            },
            |system, user, output, context, schema| {
                calls.set(calls.get() + 1);
                assert_eq!((output, context), (768, 4096));
                assert_eq!(schema, GenerationSchema::AskAnswerReviewV1);
                assert_eq!(
                    wire.borrow_mut().take(),
                    Some((system.to_owned(), user.to_owned()))
                );
                Ok(accepting())
            },
        )
        .unwrap();
    assert_eq!(calls.get(), 1);
    assert_eq!(result["writerGenerations"], 0);
    assert_eq!(result["automatedAccepted"], true);
    assert_eq!(
        result["reviewReceipt"]["contextRevision"],
        case.context.revision()
    );
    assert_eq!(
        result["automatedAnswerReviewInputRevision"],
        *review_sha.borrow()
    );
    assert_eq!(
        result["reviewReceipt"]["inputRevision"],
        *review_sha.borrow()
    );
    let counts = Cell::new(0);
    let calls = Cell::new(0);
    let error = case
        .run(
            |_, _| {
                counts.set(counts.get() + 1);
                Ok(3321)
            },
            |_, _, _, _, _| {
                calls.set(calls.get() + 1);
                Ok(accepting())
            },
        )
        .err()
        .unwrap();
    assert_eq!(error.code, "review_not_fit");
    assert_eq!((counts.get(), calls.get()), (1, 0));
}

#[test]
fn supported_unsupported_uncertain_and_missing_are_observations_not_ground_truth() {
    let cases = prepare_all().unwrap();
    for (disposition, task, coverage, missing, code) in [
        ("supported", "adequate", "covered", vec![], None),
        (
            "unsupported",
            "adequate",
            "covered",
            vec![],
            Some("review_rejected"),
        ),
        (
            "supported",
            "inadequate",
            "covered",
            vec![],
            Some("review_rejected"),
        ),
        (
            "uncertain",
            "adequate",
            "covered",
            vec![],
            Some("review_uncertain"),
        ),
        (
            "supported",
            "adequate",
            "missing",
            vec!["Q-development-F01D1A"],
            Some("review_missing"),
        ),
    ] {
        let calls = Cell::new(0);
        let result = cases[1]
            .run(
                |_, _| Ok(1000),
                |_, _, _, _, _| {
                    calls.set(calls.get() + 1);
                    Ok(verdict(disposition, task, coverage, missing.clone()))
                },
            )
            .unwrap();
        assert_eq!(calls.get(), 1);
        assert_eq!(result["automatedAccepted"], code.is_none());
        assert_eq!(result["rejectionCode"], json!(code));
        for flag in [
            "native_io_authenticated",
            "product_role_authorized",
            "semantic_accepted",
            "production_accepted",
            "activityContractAccepted",
        ] {
            assert_eq!(result[flag], false);
        }
    }
}

#[test]
fn review_receipt_cannot_replay_other_draft_family_or_plain_product_context() {
    let cases = prepare_all().unwrap();
    let case = &cases[0];
    let (context, prompt, draft) = case.checked_inputs().unwrap();
    let receipt = answer_review::run(
        &context,
        &case.sources,
        &prompt,
        &draft,
        |_, _| Ok(1000),
        |_, _, _, _| Ok(accepting()),
    )
    .unwrap();
    assert!(receipt.binds(&context, &case.sources, &prompt, &draft));
    for index in [1, 2] {
        let other = &cases[index];
        let (other_context, other_prompt, other_draft) = other.checked_inputs().unwrap();
        assert!(!receipt.binds(&other_context, &other.sources, &other_prompt, &other_draft));
    }
    let role = case.request.role_snapshot.as_ref().unwrap();
    let plain = AskReviewContext::for_question(
        &case.origin,
        role,
        &case.request.request_id,
        &case.request.question,
        None,
        "ko",
        Scope::All,
        case.request.range.as_ref(),
        case.request.paths.as_deref(),
    )
    .unwrap();
    let product_prompt =
        ordinary_flow::original_prompt(&case.request, &case.evidence, &case.sources, &plain)
            .unwrap();
    let product_draft =
        answer_draft::validate_answer_draft(case.raw_draft(), &product_prompt, "ko").unwrap();
    assert!(!receipt.binds(&plain, &case.sources, &product_prompt, &product_draft));
    assert_ne!(plain.revision(), context.revision());
}

#[test]
fn uncited_original_tail_stays_in_mandatory_fixed_answer_review() {
    // A separate synthetic plumbing variant; the compiled sixteen drafts are unchanged.
    let mut case = prepare_all().unwrap().remove(10);
    let mut raw: Value = serde_json::from_str(case.raw_draft()).unwrap();
    raw["sources"] = json!(["S1"]);
    case.raw_draft = raw.to_string();
    case.fixed_draft_sha = source_revision(&case.raw_draft);
    let expected = case.original_spans.clone();
    let observed = Cell::new(false);
    let result = case
        .run(
            |_, user| {
                let packet: Value = serde_json::from_str(user).unwrap();
                assert_eq!(packet["answer"]["sourceIds"], json!(["S1"]));
                assert_eq!(packet["originalSpans"], expected);
                assert_eq!(packet["originalSpans"].as_array().unwrap().len(), 4);
                assert_eq!(packet["citations"].as_array().unwrap().len(), 2);
                assert_eq!(packet["originalSpans"][3]["id"], "Q-development-F06D2B");
                observed.set(true);
                Ok(1000)
            },
            |_, _, _, _, _| Ok(accepting()),
        )
        .unwrap();
    assert!(observed.get());
    assert_eq!(result["automatedAccepted"], true);
}
