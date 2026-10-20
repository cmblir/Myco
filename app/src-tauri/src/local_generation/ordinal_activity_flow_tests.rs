//! Synthetic transport exercises mandatory stages; it does not grade model meaning.
use super::*;

fn ordinal_reply(packet: &Value) -> String {
    let rows = packet["originalSpans"].as_array().unwrap();
    let mut interpretations = Vec::new();
    for (ordinal, row) in rows.iter().enumerate() {
        let original = &row["original"];
        let known = |focus: &str, activity_type: &str, role: &str| {
            json!({
            "focusQuote":focus,"supportSpanIds":[original["id"]],
            "actor":{"role":role,"basis":if role=="unknown" {"unknown"} else {"speaker"},"subjectOrdinal":null},
            "eventTime":{"value":null,"basis":"unknown","precision":"unknown","uncertainty":"unknown","supportSpanId":null},
            "activityType":activity_type,"verificationId":null})
        };
        let claims = if original["speaker"] == "user" {
            vec![known(REQUEST_FOCUS, "requested_work", "user")]
        } else {
            vec![
                known(PREPARATION_FOCUS, "reported_completion", "assistant"),
                known(LIMIT_FOCUS, "record_or_verification_limit", "unknown"),
            ]
        };
        interpretations
            .push(json!({"unitOrdinal":ordinal,"relevance":"relevant","interpretations":claims}));
    }
    json!({"version":"NativeActivityTypesQaV2","units":interpretations}).to_string()
}

fn run_ordinal(
    reject_stage: Option<&str>,
) -> (
    Result<
        crate::local_generation::ActivityFlowOutput,
        crate::local_generation::ActivityFlowFailure,
    >,
    Vec<&'static str>,
) {
    let (_dir, request, checked, _index) = fixture();
    let measured = RefCell::new(Vec::new());
    let stages = RefCell::new(Vec::new());
    let result = activity_synthesis_steps_with_resolution_mode_observed(
        &request,
        &checked.evidence,
        checked.originals.as_ref().unwrap(),
        request.origin.as_ref().unwrap(),
        |system, user| count_exact(&measured, system, user),
        |system, user, _, _, schema| {
            assert_measured(&measured, system, user);
            let packet: Value = serde_json::from_str(user).unwrap();
            let selected = crate::local_generation::activity_sampler_qa::gemma_activity_decoder(
                crate::local_model::GEMMA_CANDIDATE.id,
                true,
                schema,
            );
            assert_eq!(
                selected.is_some(),
                matches!(schema, GenerationSchema::NativeActivityTypesQaV2(_))
            );
            assert!(
                crate::local_generation::activity_sampler_qa::gemma_activity_decoder(
                    crate::local_model::MODEL.id,
                    true,
                    schema,
                )
                .is_none()
            );
            match schema {
                GenerationSchema::NativeActivityTypesQaV2(decoder) => {
                    assert_eq!(decoder.units(), 2);
                    assert_eq!(
                        packet["version"],
                        "NativeSourceInterpretationOrdinalActivityQaInputV4"
                    );
                    assert_eq!(packet["question"], request.question);
                    assert_eq!(packet["language"], request.lang);
                    assert_eq!(packet["originalSpans"].as_array().unwrap().len(), 2);
                    assert!(packet.get("packetSha256").is_none());
                    assert!(user.starts_with(&format!(
                        "{{\"version\":\"NativeSourceInterpretationOrdinalActivityQaInputV4\",\"question\":{},\"language\":{},\"originalSpans\":[",
                        packet["question"], packet["language"]
                    )));
                    stages.borrow_mut().push("ordinal");
                    Ok(ordinal_reply(&packet))
                }
                GenerationSchema::WikiClaimReviewV1(_) => {
                    stages.borrow_mut().push("claim_review");
                    assert_eq!(
                        packet["sourceFocusInterpretations"]["version"],
                        "NativeSourceInterpretationOrdinalActivityQaV3"
                    );
                    assert_eq!(packet["originalSpans"].as_array().unwrap().len(), 2);
                    Ok(review_reply(
                        schema,
                        &packet,
                        if reject_stage == Some("claim_review") {
                            "unsupported"
                        } else {
                            "supported"
                        },
                    ))
                }
                GenerationSchema::AskAnswerV1 => {
                    stages.borrow_mut().push("writer");
                    assert_selected_witnesses(&packet);
                    Ok(json!({"answer":ANSWER,"sources":["S1"]}).to_string())
                }
                GenerationSchema::AskAnswerReviewV1 => {
                    stages.borrow_mut().push("final_review");
                    Ok(review_reply(
                        schema,
                        &packet,
                        if reject_stage == Some("final_review") {
                            "unsupported"
                        } else {
                            "supported"
                        },
                    ))
                }
                _ => panic!(
                    "Ordinal activity must not fall back to tuple, named or ordinary extraction"
                ),
            }
        },
        |_, _| panic!("no resolution requested"),
        |_| panic!("no resolution requested"),
        true,
        false,
        true,
        false,
        None,
    );
    (result, stages.into_inner())
}

#[test]
fn ordinal_transport_uses_actual_inputs_and_mandatory_claim_writer_and_final_review() {
    let (output, stages) = run_ordinal(None);
    let output = output.unwrap();
    assert_eq!(
        stages,
        vec!["ordinal", "claim_review", "writer", "final_review"]
    );
    assert_eq!(
        output.answer,
        format!("{ANSWER}\n\n[[sessions/synthetic|synthetic]]")
    );
    assert!(output.receipt.semantic_review_required);
    assert_eq!(output.receipt.independent_verification_receipts, 0);
}

#[test]
fn ordinal_rejected_initial_review_never_reaches_writer_or_retries_extraction() {
    let (result, stages) = run_ordinal(Some("claim_review"));
    assert_eq!(result.unwrap_err().code, "review_rejected");
    assert_eq!(stages, vec!["ordinal", "claim_review"]);
}

#[test]
fn ordinal_final_rejection_cannot_deliver_an_unreviewed_draft() {
    let (result, stages) = run_ordinal(Some("final_review"));
    assert_eq!(result.unwrap_err().code, "review_rejected");
    assert_eq!(
        stages,
        vec!["ordinal", "claim_review", "writer", "final_review"]
    );
}

#[test]
fn ordinal_correction_selection_is_rejected_before_tokenization_or_generation() {
    let (_dir, request, checked, _index) = fixture();
    let error = activity_synthesis_steps_with_resolution_mode_observed(
        &request,
        &checked.evidence,
        checked.originals.as_ref().unwrap(),
        request.origin.as_ref().unwrap(),
        |_, _| panic!("unsupported combination must not tokenize"),
        |_, _, _, _, _| panic!("must not generate"),
        |_, _| panic!("must not resolve"),
        |_| panic!("must not recheck"),
        true,
        false,
        true,
        true,
        None,
    )
    .unwrap_err();
    assert_eq!(error.code, "source_verification_failed");
}
