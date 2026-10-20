//! Synthetic presentation/replay controls; no tokenizer or model-quality claim.

use super::*;
use crate::local_synthesis::original_groups_qa::{decode, GROUP_INSTRUCTION};
use std::cell::{Cell, RefCell};

const GROUPED: QaWireFormat = QaWireFormat::SourceDocumentGroupsQaV1;
const RAW: &str = r#"{"answer":"The user requested an export button; completion has not been reported.","sources":["S1"]}"#;

fn packet_with_contrary_tail(tail: &str) -> SourceSet {
    use crate::wiki_claims::{ActorRole, SourceDocument, SpanInput};
    let first = "Please add the synthetic export button. Completion has not been reported.";
    let documents = [
        ("source", "sessions/review.md", "Q0", first),
        ("contrary", "sessions/contrary.md", "Q1", tail),
    ]
    .into_iter()
    .map(|(id, path, span, text)| {
        SourceDocument::bind(
            id.into(),
            path.into(),
            path.into(),
            text,
            None,
            vec![SpanInput {
                id: span.into(),
                start: 0,
                end: text.len(),
                turn_id: format!("T-{span}"),
                speaker: ActorRole::User,
                turn_time: None,
            }],
        )
        .unwrap()
    })
    .collect();
    SourceSet::new(
        crate::vault_session::AgentVaultSession {
            vault_path: "/synthetic/review-vault".into(),
            opening_token: "synthetic-opening".into(),
        },
        crate::retrieval::Scope::Sessions,
        documents,
        vec![],
    )
    .unwrap()
}

fn bound() -> (SourceSet, AskReviewContext, Prompt, ValidatedAnswerDraft) {
    let (_, _, context) = fixture();
    let packet =
        packet_with_contrary_tail("The request was withdrawn. Investigation only; do not deploy.");
    let prompt = prompt(&packet);
    let draft =
        crate::local_synthesis::answer_draft::validate_answer_draft(RAW, &prompt, "en").unwrap();
    (packet, context, prompt, draft)
}

fn accepted(
    context: &AskReviewContext,
    packet: &SourceSet,
    prompt: &Prompt,
    draft: &ValidatedAnswerDraft,
    format: QaWireFormat,
) -> NativeAnswerReview {
    run_with_wire_format_qa(
        context,
        packet,
        prompt,
        draft,
        format,
        |_, _| Ok(1000),
        |_, _, _, _| Ok(output().to_string()),
    )
    .unwrap()
}

#[test]
fn flat_qa_keeps_default_wire_bytes_and_receipt_serialization() {
    let (packet, context, prompt, draft) = bound();
    let baseline = prepare_base(&context, &packet, &prompt, &draft).unwrap();
    let ordinary = run(
        &context,
        &packet,
        &prompt,
        &draft,
        |_, _| Ok(1000),
        |_, _, _, _| Ok(output().to_string()),
    )
    .unwrap();
    let review = run_with_wire_format_qa(
        &context,
        &packet,
        &prompt,
        &draft,
        QaWireFormat::Flat,
        |system, user| {
            assert_eq!(
                (system, user),
                (baseline.system.as_str(), baseline.user.as_str())
            );
            Ok(1000)
        },
        |system, user, _, _| {
            assert_eq!(
                (system, user),
                (baseline.system.as_str(), baseline.user.as_str())
            );
            Ok(output().to_string())
        },
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(&review).unwrap(),
        serde_json::to_value(ordinary).unwrap()
    );
    assert!(review.binds(&context, &packet, &prompt, &draft));
    assert!(review.binds_with_wire_format_qa(
        &context,
        &packet,
        &prompt,
        &draft,
        QaWireFormat::Flat
    ));
    assert!(!review.binds_with_wire_format_qa(&context, &packet, &prompt, &draft, GROUPED));
    let serialized = serde_json::to_value(review).unwrap();
    for field in [
        "wireFormat",
        "wireSystemRevision",
        "focusRevision",
        "focusSystemRevision",
    ] {
        assert!(serialized.get(field).is_none());
    }
}

#[test]
fn grouped_review_counts_serves_and_binds_complete_originals_with_unchanged_payload() {
    let (packet, context, prompt, draft) = bound();
    let baseline = prepare_base(&context, &packet, &prompt, &draft).unwrap();
    let measured = RefCell::new(None::<(String, String)>);
    let review = run_with_wire_format_qa(
        &context,
        &packet,
        &prompt,
        &draft,
        GROUPED,
        |system, user| {
            assert_eq!(system, format!("{}{}", baseline.system, GROUP_INSTRUCTION));
            *measured.borrow_mut() = Some((system.into(), user.into()));
            Ok(1000)
        },
        |system, user, output_tokens, context_tokens| {
            assert_eq!((output_tokens, context_tokens), (768, 4096));
            assert_eq!(
                measured.borrow().as_ref().unwrap(),
                &(system.to_owned(), user.to_owned())
            );
            let mut restored: serde_json::Value = serde_json::from_str(user).unwrap();
            restored["originalSpans"] = decode(&restored["originalSpans"].to_string()).unwrap();
            assert_eq!(
                restored,
                serde_json::from_str::<serde_json::Value>(&baseline.user).unwrap()
            );
            let originals = restored["originalSpans"].as_array().unwrap();
            assert_eq!(
                originals,
                &packet
                    .spans()
                    .map(|span| serde_json::to_value(span).unwrap())
                    .collect::<Vec<_>>()
            );
            assert!(originals
                .iter()
                .all(|span| span.as_object().unwrap().len() == 14));
            assert_eq!(originals[1]["selectionPath"], "sessions/contrary.md");
            assert!(originals[1]["text"].as_str().unwrap().contains("withdrawn"));
            assert_eq!(restored["answer"]["sourceIds"], json!(["S1"]));
            assert!(restored["answer"].get("modelAnswer").is_none());
            assert!(restored["answer"].get("inputRevision").is_none());
            let mut answer = restored["answer"].clone();
            answer["modelAnswer"] = answer["proseWithoutModelLinkLabels"].clone();
            answer["inputRevision"] = restored["answerInputRevision"].clone();
            assert_eq!(answer, draft.review_payload());
            Ok(output().to_string())
        },
    )
    .unwrap();
    let actual = measured.into_inner().unwrap();
    assert_eq!(review.input_revision(), source_revision(&actual.1));
    assert_eq!(
        review.wire_system_revision.as_deref(),
        Some(source_revision(&actual.0).as_str())
    );
    assert_eq!(review.wire_format, Some(GROUPED));
    assert!(review.binds_with_wire_format_qa(&context, &packet, &prompt, &draft, GROUPED));
    assert!(!review.binds(&context, &packet, &prompt, &draft));
    assert!(!review.binds_with_wire_format_qa(
        &context,
        &packet,
        &prompt,
        &draft,
        QaWireFormat::Flat
    ));
}

#[test]
fn grouped_receipt_rejects_missing_changed_or_crossed_wire_markers_and_hashes() {
    let (packet, context, prompt, draft) = bound();
    for mutation in 0..7 {
        let mut review = accepted(&context, &packet, &prompt, &draft, GROUPED);
        match mutation {
            0 => review.input_revision = "0".repeat(64),
            1 => review.wire_system_revision = Some("0".repeat(64)),
            2 => review.wire_system_revision = None,
            3 => review.wire_format = None,
            4 => review.wire_format = Some(QaWireFormat::Flat),
            5 => review.focus_revision = Some("0".repeat(64)),
            _ => review.focus_system_revision = Some("0".repeat(64)),
        }
        assert!(
            !review.binds_with_wire_format_qa(&context, &packet, &prompt, &draft, GROUPED),
            "mutation {mutation}"
        );
        assert!(
            !review.binds(&context, &packet, &prompt, &draft),
            "mutation {mutation}"
        );
    }
    for mutate_system in [false, true] {
        let mut flat = accepted(&context, &packet, &prompt, &draft, QaWireFormat::Flat);
        if mutate_system {
            flat.wire_system_revision = Some("0".repeat(64));
        } else {
            flat.wire_format = Some(GROUPED);
        }
        assert!(!flat.binds(&context, &packet, &prompt, &draft));
        assert!(!flat.binds_with_wire_format_qa(&context, &packet, &prompt, &draft, GROUPED));
    }
}

#[test]
fn grouped_receipt_rejects_context_draft_prompt_source_and_citation_replay() {
    let (packet, context, prompt, draft) = bound();
    let review = accepted(&context, &packet, &prompt, &draft, GROUPED);
    let changed_raw = format!("\n{RAW}\n");
    let changed_draft =
        crate::local_synthesis::answer_draft::validate_answer_draft(&changed_raw, &prompt, "en")
            .unwrap();
    assert!(!review.binds_with_wire_format_qa(&context, &packet, &prompt, &changed_draft, GROUPED));
    let origin = crate::vault_session::AgentVaultSession {
        vault_path: "/synthetic/review-vault".into(),
        opening_token: "synthetic-opening".into(),
    };
    let range = crate::commands::DateRange {
        start: "2026-10-01".into(),
        end: "2026-10-03".into(),
        start_epoch: None,
        end_epoch: None,
    };
    let changed_context = crate::wiki_claim_review::tests::context(
        "Synthetic work",
        "en",
        crate::retrieval::Scope::Sessions,
        &range,
        &origin,
    );
    assert!(!review.binds_with_wire_format_qa(&changed_context, &packet, &prompt, &draft, GROUPED));
    let changed_packet =
        packet_with_contrary_tail("A changed contrary original; rollout remains cancelled.");
    assert!(!review.binds_with_wire_format_qa(&context, &changed_packet, &prompt, &draft, GROUPED));
    for mutation in 0..3 {
        let mut changed_prompt = super::prompt(&packet);
        match mutation {
            0 => changed_prompt
                .system
                .push_str(" Changed synthetic instruction."),
            1 => changed_prompt.user.push(' '),
            _ => changed_prompt.evidence[0].page = "sessions/forged.md".into(),
        }
        let changed =
            crate::local_synthesis::answer_draft::validate_answer_draft(RAW, &changed_prompt, "en")
                .unwrap();
        assert!(!review.binds_with_wire_format_qa(
            &context,
            &packet,
            &changed_prompt,
            &changed,
            GROUPED
        ));
        if mutation == 2 {
            assert_eq!(
                run_with_wire_format_qa(
                    &context,
                    &packet,
                    &changed_prompt,
                    &changed,
                    GROUPED,
                    |_, _| panic!("invalid citation cannot be counted"),
                    |_, _, _, _| panic!("invalid citation cannot generate")
                )
                .unwrap_err()
                .code(),
                "review_invalid"
            );
        }
    }
}

#[test]
fn grouped_review_retains_exact_fit_boundary_and_rejected_draft_without_retry() {
    let (packet, context, prompt, draft) = bound();
    let frozen = serde_json::to_value(&draft).unwrap();
    for count in [3320, 3321] {
        let calls = Cell::new(0);
        let result = run_with_wire_format_qa(
            &context,
            &packet,
            &prompt,
            &draft,
            GROUPED,
            |_, _| Ok(count),
            |_, _, _, _| {
                calls.set(calls.get() + 1);
                Ok(output().to_string())
            },
        );
        if count == 3320 {
            assert!(result.unwrap().require_accepted().is_ok());
            assert_eq!(calls.get(), 1);
        } else {
            assert_eq!(result.unwrap_err().code(), "review_not_fit");
            assert_eq!(calls.get(), 0);
        }
        assert_eq!(serde_json::to_value(&draft).unwrap(), frozen);
    }
    for (field, value, missing, code) in [
        ("answerDisposition", "unsupported", false, "review_rejected"),
        ("answerDisposition", "uncertain", false, "review_uncertain"),
        ("taskResponse", "inadequate", false, "review_rejected"),
        ("taskResponse", "uncertain", false, "review_uncertain"),
        ("sourceCoverage", "missing", true, "review_missing"),
        ("sourceCoverage", "uncertain", false, "review_uncertain"),
    ] {
        let mut verdict = output();
        verdict[field] = json!(value);
        if missing {
            verdict["missingSpanIds"] = json!(["Q1"]);
        }
        let calls = Cell::new(0);
        let review = run_with_wire_format_qa(
            &context,
            &packet,
            &prompt,
            &draft,
            GROUPED,
            |_, _| Ok(1000),
            |_, _, _, _| {
                calls.set(calls.get() + 1);
                Ok(verdict.to_string())
            },
        )
        .unwrap();
        assert_eq!(review.require_accepted().unwrap_err().code(), code);
        assert_eq!(calls.get(), 1);
        assert_eq!(serde_json::to_value(&draft).unwrap(), frozen);
    }
}

#[test]
fn grouped_review_does_not_mix_focus_proofs_or_accept_invented_coverage_ids() {
    let (packet, context, activity, draft) = focus_fixture("Synthetic work");
    for format in [QaWireFormat::Flat, GROUPED] {
        assert_eq!(
            run_with_wire_format_qa(
                &context,
                &packet,
                &activity.prompt,
                &draft,
                format,
                |_, _| panic!("focus cannot enter ordinary grouped count"),
                |_, _, _, _| panic!("focus cannot enter ordinary grouped review")
            )
            .unwrap_err()
            .code(),
            "review_invalid"
        );
    }
    let (packet, context, prompt, draft) = bound();
    let mut verdict = output();
    verdict["sourceCoverage"] = json!("missing");
    verdict["missingSpanIds"] = json!(["Q999"]);
    assert_eq!(
        run_with_wire_format_qa(
            &context,
            &packet,
            &prompt,
            &draft,
            GROUPED,
            |_, _| Ok(1000),
            |_, _, _, _| Ok(verdict.to_string())
        )
        .unwrap_err()
        .code(),
        "review_invalid"
    );
}
