//! Common model-view factoring controls; synthetic verdicts prove no meaning.
use super::*;
use crate::local_synthesis::answer_draft::validate_answer_draft;
use crate::wiki_claims::{ActorRole, SourceDocument, SpanInput};
use std::cell::{Cell, RefCell};

const RAW: &str = r#"{"answer":"The user requested an export button; completion has not been reported.","sources":["S1"]}"#;

fn complete_packet() -> SourceSet {
    let origin = crate::vault_session::AgentVaultSession {
        vault_path: "/synthetic/review-vault".into(),
        opening_token: "synthetic-opening".into(),
    };
    let documents = [
        (
            "source",
            "sessions/review.md",
            "Q0",
            "Please add the synthetic export button. Completion has not been reported.",
        ),
        (
            "contrary",
            "sessions/contrary.md",
            "Q-tail",
            "The request was later withdrawn. Investigation only; do not deploy.",
        ),
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
    SourceSet::new(origin, crate::retrieval::Scope::Sessions, documents, vec![]).unwrap()
}

#[test]
fn common_equal_answer_is_factored_before_count_and_generation_with_full_originals_unchanged() {
    let (_, _, context) = fixture();
    let packet = complete_packet();
    assert!(context.check_packet(&packet).is_ok());
    let prompt = prompt(&packet);
    let draft = validate_answer_draft(RAW, &prompt, "en").unwrap();
    let canonical = draft.review_payload();
    assert_eq!(
        canonical["modelAnswer"],
        canonical["proseWithoutModelLinkLabels"]
    );
    assert_eq!(canonical["inputRevision"], source_revision(RAW));
    let private_revision = draft.revision().unwrap();
    let spans = json!(packet.spans().collect::<Vec<_>>());
    let measured = RefCell::new(None::<(String, String)>);
    let calls = Cell::new(0);
    let receipt = run(
        &context,
        &packet,
        &prompt,
        &draft,
        |system, user| {
            let input: serde_json::Value = serde_json::from_str(user).unwrap();
            assert!(
                input["answer"].get("modelAnswer").is_none(),
                "equal prose must not be sent twice"
            );
            assert!(
                input["answer"].get("inputRevision").is_none(),
                "equal raw revision must not be sent twice"
            );
            assert_eq!(
                input["answer"]["proseWithoutModelLinkLabels"],
                canonical["proseWithoutModelLinkLabels"]
            );
            assert_eq!(input["answer"]["sourceIds"], canonical["sourceIds"]);
            assert_eq!(input["answerInputRevision"], source_revision(RAW));
            assert_eq!(input["originalSpans"], spans);
            assert_eq!(input["originalSpans"].as_array().unwrap().len(), 2);
            assert!(input["originalSpans"]
                .as_array()
                .unwrap()
                .iter()
                .all(|span| span.as_object().unwrap().len() == 14));
            assert_eq!(input["originalSpans"][1]["id"], "Q-tail");
            assert!(input["originalSpans"][1]["text"]
                .as_str()
                .unwrap()
                .contains("withdrawn"));
            assert_eq!(
                input["citations"],
                json!([{"id":"S1","path":"sessions/review.md"}])
            );
            assert_eq!(input["context"], *context.payload());
            assert_eq!(input["contextRevision"], context.revision());
            let mut expected_period = json!({});
            context
                .add_record_period_context(&mut expected_period, &packet)
                .unwrap();
            assert_eq!(
                input["recordPeriodContext"],
                expected_period["recordPeriodContext"]
            );
            assert_eq!(input["recordPeriodContext"]["counts"]["uncertainSpans"], 2);
            assert_eq!(input["independentVerificationReceipts"], json!([]));
            *measured.borrow_mut() = Some((system.into(), user.into()));
            Ok(1000)
        },
        |system, user, output_tokens, context_tokens| {
            calls.set(calls.get() + 1);
            assert_eq!(
                (system.to_owned(), user.to_owned()),
                *measured.borrow().as_ref().unwrap()
            );
            assert_eq!((output_tokens, context_tokens), (768, 4096));
            Ok(output().to_string())
        },
    )
    .unwrap();
    assert_eq!(calls.get(), 1);
    let actual = measured.into_inner().unwrap();
    let prepared = prepare_base(&context, &packet, &prompt, &draft).unwrap();
    assert_eq!((prepared.system, prepared.user), actual);
    assert_eq!(receipt.input_revision(), source_revision(&actual.1));
    assert!(receipt.binds(&context, &packet, &prompt, &draft));
    assert_eq!(draft.review_payload(), canonical);
    assert_eq!(draft.revision().unwrap(), private_revision);
    assert_eq!(draft.input_revision(), source_revision(RAW));
    assert_eq!(json!(packet.spans().collect::<Vec<_>>()), spans);
}

#[test]
fn common_receipt_rejects_changed_model_input_hash_and_distinct_raw_json() {
    let (packet, _, context) = fixture();
    let prompt = prompt(&packet);
    let draft = validate_answer_draft(RAW, &prompt, "en").unwrap();
    let mut receipt = run(
        &context,
        &packet,
        &prompt,
        &draft,
        |_, _| Ok(1000),
        |_, _, _, _| Ok(output().to_string()),
    )
    .unwrap();
    assert!(receipt.binds(&context, &packet, &prompt, &draft));
    let actual_revision = receipt.input_revision.clone();
    receipt.input_revision = "0".repeat(64);
    assert!(
        !receipt.binds(&context, &packet, &prompt, &draft),
        "a valid context/draft cannot authenticate a different model input"
    );
    receipt.input_revision = actual_revision;
    assert!(receipt.binds(&context, &packet, &prompt, &draft));
    let differently_serialized_raw = format!(" \n{RAW}\n ");
    let changed = validate_answer_draft(&differently_serialized_raw, &prompt, "en").unwrap();
    assert_eq!(
        changed.review_payload()["proseWithoutModelLinkLabels"],
        draft.review_payload()["proseWithoutModelLinkLabels"]
    );
    assert_ne!(changed.input_revision(), draft.input_revision());
    assert!(!receipt.binds(&context, &packet, &prompt, &changed));
}

#[test]
fn common_unequal_or_linked_views_remain_complete_and_invalid_factoring_is_atomic() {
    let (packet, _, context) = fixture();
    let prompt = prompt(&packet);
    let raw = json!({"answer":"The user requested an export button; completion has not been reported. [[S1|VERIFY LABEL]]","sources":["S1"]}).to_string();
    let draft = validate_answer_draft(&raw, &prompt, "en").unwrap();
    let canonical = draft.review_payload();
    assert_ne!(
        canonical["modelAnswer"],
        canonical["proseWithoutModelLinkLabels"]
    );
    let prepared = prepare_base(&context, &packet, &prompt, &draft).unwrap();
    let input: serde_json::Value = serde_json::from_str(&prepared.user).unwrap();
    assert_eq!(
        input["answer"], canonical,
        "unequal prose preserves the entire original view"
    );
    assert_eq!(input["answerInputRevision"], source_revision(&raw));

    {
        // Exercise byte equality and atomic validation without forging a draft.
        for (model, prose) in [
            ("Synthetic prose.", "Synthetic prose. "),
            ("caf\u{00e9}", "cafe\u{0301}"),
            ("[[S1|Identical label]]", "[[S1|Identical label]]"),
        ] {
            let mut value = json!({"answerInputRevision":"a".repeat(64),"answer":{
                "inputRevision":"a".repeat(64),"modelAnswer":model,
                "proseWithoutModelLinkLabels":prose,"sourceIds":["S1"]}});
            let original = value.clone();
            deduplicate_answer_view(&mut value).unwrap();
            assert_eq!(
                value, original,
                "unsafe-to-factor text must retain all values"
            );
        }
        for mutation in ["revision", "missing_prose"] {
            let mut value = json!({"answerInputRevision":"a".repeat(64),"answer":{
                "inputRevision":"a".repeat(64),"modelAnswer":"Exact prose.",
                "proseWithoutModelLinkLabels":"Exact prose.","sourceIds":["S1"]}});
            if mutation == "revision" {
                value["answer"]["inputRevision"] = json!("b".repeat(64));
            } else {
                value["answer"]
                    .as_object_mut()
                    .unwrap()
                    .remove("proseWithoutModelLinkLabels");
            }
            let original = value.clone();
            assert_eq!(
                deduplicate_answer_view(&mut value).unwrap_err().code(),
                "review_invalid"
            );
            assert_eq!(value, original);
        }
    }
}

#[test]
fn common_revision_validation_precedes_unequal_or_linked_view_preservation() {
    for (model, prose) in [
        ("Synthetic prose.", "Synthetic prose. "),
        ("[[S1|Identical label]]", "[[S1|Identical label]]"),
    ] {
        let mut value = json!({"answerInputRevision":"a".repeat(64),"answer":{
            "inputRevision":"b".repeat(64),"modelAnswer":model,
            "proseWithoutModelLinkLabels":prose,"sourceIds":["S1"]}});
        let original = value.clone();
        assert_eq!(
            deduplicate_answer_view(&mut value).unwrap_err().code(),
            "review_invalid"
        );
        assert_eq!(value, original);
    }
}

#[test]
fn common_factoring_preserves_review_budget_and_never_generates_when_full_packet_is_not_fit() {
    let (_, _, context) = fixture();
    let packet = complete_packet();
    let prompt = prompt(&packet);
    let draft = validate_answer_draft(RAW, &prompt, "en").unwrap();
    for counted in [3320, 3321] {
        let generations = Cell::new(0);
        let result = run(
            &context,
            &packet,
            &prompt,
            &draft,
            |_, user| {
                let input: serde_json::Value = serde_json::from_str(user).unwrap();
                assert_eq!(
                    input["originalSpans"],
                    json!(packet.spans().collect::<Vec<_>>())
                );
                // Synthetic counts test admission only, never actual token savings.
                Ok(counted)
            },
            |_, _, output_tokens, context_tokens| {
                generations.set(generations.get() + 1);
                assert_eq!((output_tokens, context_tokens), (768, 4096));
                Ok(output().to_string())
            },
        );
        if counted == 3320 {
            assert!(result.is_ok());
            assert_eq!(generations.get(), 1);
        } else {
            assert_eq!(result.unwrap_err().code(), "review_not_fit");
            assert_eq!(generations.get(), 0);
        }
    }
}
