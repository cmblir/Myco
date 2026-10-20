//! QA view deduplication controls; mocked verdicts never establish model meaning.

use super::*;
use std::cell::RefCell;

#[test]
fn equal_qa_answer_view_removes_only_duplicates_and_keeps_private_draft_binding() {
    let (packet, context, activity, draft) = focus_fixture("Synthetic work");
    let canonical = draft.review_payload();
    let draft_revision = draft.revision().unwrap();
    let proof = activity.focus_answer.as_ref().unwrap();
    let model = proof.model_payload().unwrap();
    let base = prepare_base(&context, &packet, &activity.prompt, &draft).unwrap();
    let mut expected: serde_json::Value = serde_json::from_str(&base.user).unwrap();
    // Rebuild the complete pre-factoring view from the unchanged private draft.
    expected["answer"] = canonical.clone();
    expected["originalSpans"] = json!(proof.model_original_spans().unwrap());
    for field in [
        "sourceFocusInterpretations",
        "sourceFocusRepresentation",
        "sourceFocusInterpretationRevision",
        "claimProposals",
    ] {
        expected[field] = model[field].clone();
    }
    assert_eq!(
        expected["answer"]["modelAnswer"],
        expected["answer"]["proseWithoutModelLinkLabels"]
    );
    let full_bytes = expected.to_string().len();
    let full_revision = source_revision(&expected.to_string());
    expected["answer"]
        .as_object_mut()
        .unwrap()
        .remove("modelAnswer");
    expected["answer"]
        .as_object_mut()
        .unwrap()
        .remove("inputRevision");
    let prepared = prepare_activity(&context, &packet, &activity, &draft).unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&prepared.user).unwrap(),
        expected
    );
    assert!(prepared.user.len() < full_bytes);
    assert_eq!(expected["answer"]["sourceIds"], canonical["sourceIds"]);
    assert_eq!(
        expected["answer"]["proseWithoutModelLinkLabels"],
        canonical["proseWithoutModelLinkLabels"]
    );
    assert_eq!(expected["answerInputRevision"], draft.input_revision());
    let measured = RefCell::new(None::<(String, String)>);
    let mut receipt = run_activity(
        &context,
        &packet,
        &activity,
        &draft,
        |system, user| {
            *measured.borrow_mut() = Some((system.into(), user.into()));
            Ok(1000)
        },
        |system, user, output_tokens, context_tokens| {
            assert_eq!(
                measured.borrow().as_ref().unwrap(),
                &(system.to_owned(), user.to_owned())
            );
            assert_eq!(
                (system, user),
                (prepared.system.as_str(), prepared.user.as_str())
            );
            assert_eq!((output_tokens, context_tokens), (768, 4096));
            Ok(output().to_string())
        },
    )
    .unwrap();
    assert_eq!(draft.review_payload(), canonical);
    assert_eq!(draft.revision().unwrap(), draft_revision);
    assert_eq!(receipt.draft_revision, draft_revision);
    assert_eq!(receipt.input_revision(), source_revision(&prepared.user));
    assert_eq!(
        receipt.focus_system_revision.as_deref(),
        Some(source_revision(&prepared.system).as_str())
    );
    assert!(receipt.binds_activity(&context, &packet, &activity, &draft));
    assert!(!receipt.binds(&context, &packet, &activity.prompt, &draft));
    let actual_revision = receipt.input_revision.clone();
    receipt.input_revision = full_revision;
    assert!(!receipt.binds_activity(&context, &packet, &activity, &draft));
    receipt.input_revision = actual_revision;
    assert!(receipt.binds_activity(&context, &packet, &activity, &draft));
}

#[test]
fn genuine_link_label_answer_retains_distinct_views_and_native_draft() {
    let (packet, context, activity, _) = focus_fixture("Synthetic work");
    let raw=json!({"answer":"The user requested an export button; completion has not been reported. [[S1|VERIFIED_COMPLETION]]","sources":["S1"]}).to_string();
    let draft =
        crate::local_synthesis::answer_draft::validate_answer_draft(&raw, &activity.prompt, "en")
            .unwrap();
    let canonical = draft.review_payload();
    let revision = draft.revision().unwrap();
    assert_ne!(
        canonical["modelAnswer"],
        canonical["proseWithoutModelLinkLabels"]
    );
    assert!(canonical["modelAnswer"]
        .as_str()
        .unwrap()
        .contains("VERIFIED_COMPLETION"));
    assert!(!canonical["proseWithoutModelLinkLabels"]
        .as_str()
        .unwrap()
        .contains("VERIFIED_COMPLETION"));
    let prepared = prepare_activity(&context, &packet, &activity, &draft).unwrap();
    let input: serde_json::Value = serde_json::from_str(&prepared.user).unwrap();
    assert_eq!(input["answer"]["modelAnswer"], canonical["modelAnswer"]);
    assert_eq!(
        input["answer"]["proseWithoutModelLinkLabels"],
        canonical["proseWithoutModelLinkLabels"]
    );
    assert_eq!(input["answer"]["sourceIds"], canonical["sourceIds"]);
    assert_eq!(input["answer"], canonical);
    assert_eq!(input["answerInputRevision"], source_revision(&raw));
    assert_eq!(draft.review_payload(), canonical);
    assert_eq!(draft.revision().unwrap(), revision);
}

#[test]
fn body_dedup_requires_byte_equality_and_retains_link_containing_views() {
    for (model, prose, removed) in [
        ("Exact synthetic prose.", "Exact synthetic prose.", true),
        (
            "Keep S1 after this clause; S10 is literal.",
            "Keep S1 after this clause; S10 is literal.",
            true,
        ),
        ("Synthetic prose.", "Synthetic prose. ", false),
        ("caf\u{00e9}", "cafe\u{0301}", false),
        ("[[S1|Same label]]", "[[S1|Same label]]", false),
        ("Synthetic [[S1|Label]] prose.", "Synthetic  prose.", false),
    ] {
        let mut payload = json!({"answerInputRevision":"a".repeat(64),"answer":{
            "inputRevision":"a".repeat(64),"modelAnswer":model,"proseWithoutModelLinkLabels":prose,"sourceIds":["S1"]}});
        let original = payload.clone();
        deduplicate_answer_view(&mut payload).unwrap();
        assert_eq!(payload["answer"].get("modelAnswer").is_none(), removed);
        if !removed {
            assert_eq!(payload["answer"]["modelAnswer"], model);
        }
        assert_eq!(payload["answer"]["proseWithoutModelLinkLabels"], prose);
        assert_eq!(payload["answer"]["sourceIds"], json!(["S1"]));
        if removed {
            assert!(payload["answer"].get("inputRevision").is_none());
        } else {
            assert_eq!(payload, original);
        }
    }
}

#[test]
fn unexpected_duplicate_revision_or_missing_view_fails_without_partial_mutation() {
    for mutation in 0..10 {
        let mut payload = json!({"answerInputRevision":"a".repeat(64),"answer":{
            "inputRevision":"a".repeat(64),"modelAnswer":"Synthetic prose.","proseWithoutModelLinkLabels":"Synthetic prose.","sourceIds":["S1"]}});
        match mutation {
            0 => payload["answer"]["inputRevision"] = json!("b".repeat(64)),
            1 => {
                payload["answer"]
                    .as_object_mut()
                    .unwrap()
                    .remove("inputRevision");
            }
            2 => payload["answerInputRevision"] = json!(null),
            3 => payload["answer"]["inputRevision"] = json!(7),
            4 => payload["answer"]["modelAnswer"] = json!(null),
            5 => payload["answer"]["proseWithoutModelLinkLabels"] = json!(false),
            6 => payload["answer"] = json!([]),
            7 => {
                payload.as_object_mut().unwrap().remove("answer");
            }
            8 => {
                payload["answer"]
                    .as_object_mut()
                    .unwrap()
                    .remove("modelAnswer");
                payload["answer"]
                    .as_object_mut()
                    .unwrap()
                    .remove("proseWithoutModelLinkLabels");
            }
            _ => {
                payload["answer"]["modelAnswer"] = json!(null);
                payload["answer"]["proseWithoutModelLinkLabels"] = json!(null);
            }
        }
        let original = payload.clone();
        assert_eq!(
            deduplicate_answer_view(&mut payload).unwrap_err().code(),
            "review_invalid"
        );
        assert_eq!(payload, original);
    }
}

#[test]
fn ordinary_base_model_view_factors_duplicates_and_reconstructs_the_complete_answer() {
    let (packet, _, context) = fixture();
    let prompt = prompt(&packet);
    let raw=json!({"answer":"The user requested an export button; completion has not been reported.","sources":["S1"]}).to_string();
    let draft =
        crate::local_synthesis::answer_draft::validate_answer_draft(&raw, &prompt, "en").unwrap();
    let prepared = prepare_base(&context, &packet, &prompt, &draft).unwrap();
    let expected: serde_json::Value = serde_json::from_str(&prepared.user).unwrap();
    assert!(expected["answer"].get("modelAnswer").is_none());
    assert!(expected["answer"].get("inputRevision").is_none());
    let mut restored = expected["answer"].clone();
    restored["modelAnswer"] = restored["proseWithoutModelLinkLabels"].clone();
    restored["inputRevision"] = expected["answerInputRevision"].clone();
    assert_eq!(restored, draft.review_payload());
    assert_eq!(expected["answerInputRevision"], source_revision(&raw));
    run(
        &context,
        &packet,
        &prompt,
        &draft,
        |system, user| {
            assert_eq!(
                (system, user),
                (prepared.system.as_str(), prepared.user.as_str())
            );
            Ok(1000)
        },
        |system, user, _, _| {
            assert_eq!(
                (system, user),
                (prepared.system.as_str(), prepared.user.as_str())
            );
            Ok(output().to_string())
        },
    )
    .unwrap();
}

#[test]
fn same_prose_from_different_raw_json_cannot_replay_private_review_receipt() {
    let (packet, context, activity, draft) = focus_fixture("Synthetic work");
    let receipt = run_activity(
        &context,
        &packet,
        &activity,
        &draft,
        |_, _| Ok(1000),
        |_, _, _, _| Ok(output().to_string()),
    )
    .unwrap();
    let changed_raw = format!(
        " \n{}\n",
        json!({"answer":"The user requested an export button; completion has not been reported.","sources":["S1"]})
    );
    let changed = crate::local_synthesis::answer_draft::validate_answer_draft(
        &changed_raw,
        &activity.prompt,
        "en",
    )
    .unwrap();
    let before = draft.review_payload();
    let after = changed.review_payload();
    for field in ["modelAnswer", "proseWithoutModelLinkLabels", "sourceIds"] {
        assert_eq!(before[field], after[field]);
    }
    assert_ne!(draft.input_revision(), changed.input_revision());
    assert_ne!(draft.revision().unwrap(), changed.revision().unwrap());
    let original = prepare_activity(&context, &packet, &activity, &draft).unwrap();
    let replacement = prepare_activity(&context, &packet, &activity, &changed).unwrap();
    assert_eq!(original.system, replacement.system);
    assert_ne!(original.user, replacement.user);
    assert!(!receipt.binds_activity(&context, &packet, &activity, &changed));
}
