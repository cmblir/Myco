//! Complete paired diagnostic plumbing, never original-grounded model acceptance.
use super::*;
use crate::local_synthesis::original_groups_qa::{decode, GROUP_INSTRUCTION};
use std::cell::{Cell, RefCell};

fn fake_stage(schema: GenerationSchema, disposition: &str) -> String {
    if schema == GenerationSchema::AskAnswerV1 {
        json!({"answer":"기록된 목적이 지금도 유효하다면 작은 확인부터 시작할 수 있습니다.","sources":["S1"]}).to_string()
    } else {
        assert_eq!(schema, GenerationSchema::AskAnswerReviewV1);
        json!({"version":"AskAnswerReviewV1","answerDisposition":disposition,"taskResponse":"adequate",
            "sourceCoverage":"covered","missingSpanIds":[],"reason":"Synthetic plumbing verdict, not semantic proof."}).to_string()
    }
}

type Stage = (GenerationSchema, String, String);
fn captured(case: &PreparedCase, policy: Option<KoAdvicePolicyQa>) -> (Value, Vec<Stage>) {
    let stages = RefCell::new(Vec::new());
    let measured = RefCell::new(None::<(String, String)>);
    let format = QaWireFormat::SourceDocumentGroupsQaV1;
    let count = |system: &str, user: &str| {
        *measured.borrow_mut() = Some((system.into(), user.into()));
        Ok(500)
    };
    let generate = |system: &str, user: &str, output, context, schema| {
        assert_eq!((output, context), (768, 4096));
        assert_eq!(
            &(system.to_owned(), user.to_owned()),
            measured.borrow().as_ref().unwrap()
        );
        stages
            .borrow_mut()
            .push((schema, system.into(), user.into()));
        Ok(fake_stage(schema, "supported"))
    };
    let result = match policy {
        Some(policy) => case.run_with_advice_policy_qa(format, policy, count, generate),
        None => case.run_with_wire_format_qa(format, count, generate),
    }
    .unwrap();
    (result, stages.into_inner())
}

#[test]
fn old_control_and_treatment_share_exact_writer_user_and_all_nine_review_originals() {
    let cases = prepare_all().unwrap();
    let case = &cases[1];
    let (_, old) = captured(case, None);
    let (control_result, control) = captured(case, Some(KoAdvicePolicyQa::ExistingControl));
    let (treatment_result, treatment) = captured(case, Some(KoAdvicePolicyQa::IntentConditionalV1));
    assert_eq!(
        old, control,
        "existing wire-only path and explicit control have identical actual inputs"
    );
    assert_eq!(control.len(), 2);
    assert_eq!(treatment.len(), 2);
    assert_eq!(control[0].0, GenerationSchema::AskAnswerV1);
    assert_eq!(control[1].0, GenerationSchema::AskAnswerReviewV1);
    assert_eq!(control[0].2, treatment[0].2);
    assert_eq!(
        control[0].1.replacen(
            KoAdvicePolicyQa::ExistingControl.branches(),
            KoAdvicePolicyQa::IntentConditionalV1.branches(),
            1
        ),
        treatment[0].1
    );
    assert!(control[0].1.ends_with(GROUP_INSTRUCTION));
    assert!(treatment[0].1.ends_with(GROUP_INSTRUCTION));
    assert_eq!(control[1].1, treatment[1].1, "reviewer policy is unchanged");
    // Identical synthetic raw answers produce identical review USERs here;
    // actual paired writer outputs may differ and must be logged separately.
    assert_eq!(control[1].2, treatment[1].2);
    let expected = json!(case.sources.spans().collect::<Vec<_>>());
    for stages in [&control, &treatment] {
        for (schema, _, user) in stages {
            let payload: Value = serde_json::from_str(user).unwrap();
            let spans = if *schema == GenerationSchema::AskAnswerV1 {
                let mut spans = Vec::new();
                for source in payload["sources"].as_array().unwrap() {
                    spans.extend(
                        decode(&source["originalSpans"].to_string())
                            .unwrap()
                            .as_array()
                            .unwrap()
                            .iter()
                            .cloned(),
                    );
                }
                Value::Array(spans)
            } else {
                decode(&payload["originalSpans"].to_string()).unwrap()
            };
            assert_eq!(spans, expected);
            assert_eq!(spans.as_array().unwrap().len(), 9);
            assert!(spans
                .as_array()
                .unwrap()
                .iter()
                .all(|span| span.as_object().unwrap().len() == 14));
            assert_eq!(spans.as_array().unwrap().last().unwrap()["turnId"], "D4C");
            assert!(payload.get("required_meanings").is_none());
            assert!(payload.get("expectation_class").is_none());
        }
    }
    for result in [control_result, treatment_result] {
        for field in [
            "native_io_authenticated",
            "product_role_authorized",
            "semantic_accepted",
            "production_accepted",
            "activityContractAccepted",
        ] {
            assert_eq!(result[field], false);
        }
        assert_eq!(result["referenceCriteriaServedToModel"], false);
    }
}

#[test]
fn paired_advice_method_refuses_changed_case_language_question_or_role_before_callbacks() {
    for fault in ["summary", "language", "question", "role"] {
        for policy in [
            KoAdvicePolicyQa::ExistingControl,
            KoAdvicePolicyQa::IntentConditionalV1,
        ] {
            let mut cases = prepare_all().unwrap();
            let case = if fault == "summary" {
                &mut cases[0]
            } else {
                &mut cases[1]
            };
            if fault == "language" {
                case.request.lang = "en".into();
            }
            if fault == "question" {
                case.request.question = "다른 질문입니다.".into();
            }
            if fault == "role" {
                case.request
                    .role_snapshot
                    .as_mut()
                    .unwrap()
                    .route_signature
                    .artifact_sha256 = Some("0".repeat(64));
            }
            let calls = Cell::new(0);
            let error = case
                .run_with_advice_policy_qa(
                    QaWireFormat::SourceDocumentGroupsQaV1,
                    policy,
                    |_, _| {
                        calls.set(calls.get() + 1);
                        Ok(500)
                    },
                    |_, _, _, _, schema| {
                        calls.set(calls.get() + 1);
                        Ok(fake_stage(schema, "supported"))
                    },
                )
                .unwrap_err();
            assert_eq!(error.code, "source_verification_failed");
            assert_eq!(calls.get(), 0);
        }
    }
}

#[test]
fn paired_policy_preserves_3320_boundary_mandatory_review_and_zero_retry() {
    let cases = prepare_all().unwrap();
    let case = &cases[1];
    for policy in [
        KoAdvicePolicyQa::ExistingControl,
        KoAdvicePolicyQa::IntentConditionalV1,
    ] {
        for (writer_count, review_count, disposition, expected_calls, error) in [
            (3320, 3320, "supported", 2, None),
            (3321, 500, "supported", 0, Some("review_not_fit")),
            (500, 3321, "supported", 1, Some("review_not_fit")),
            (500, 500, "unsupported", 2, Some("review_rejected")),
        ] {
            let counts = Cell::new(0);
            let generations = Cell::new(0);
            let result = case.run_with_advice_policy_qa(
                QaWireFormat::SourceDocumentGroupsQaV1,
                policy,
                |_, _| {
                    let stage = counts.get();
                    counts.set(stage + 1);
                    assert!(stage < 2);
                    // Synthetic values establish admission boundaries only.
                    Ok(if stage == 0 {
                        writer_count
                    } else {
                        review_count
                    })
                },
                |_, _, output, context, schema| {
                    generations.set(generations.get() + 1);
                    assert_eq!((output, context), (768, 4096));
                    Ok(fake_stage(schema, disposition))
                },
            );
            assert_eq!(generations.get(), expected_calls);
            if let Some(error) = error {
                assert_eq!(result.unwrap_err().code, error);
            } else {
                assert!(result.is_ok());
            }
        }
    }
}
