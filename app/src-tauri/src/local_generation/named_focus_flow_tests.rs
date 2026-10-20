//! Mock transport exercises the full pipeline; it does not grade model meaning.
use super::*;
use crate::local_llm::generation_telemetry::TelemetrySchema;

fn named_reply(packet: &Value) -> String {
    let tuple: Value = serde_json::from_str(&focus_reply(packet)).unwrap();
    let rows = tuple["claims"].as_array().unwrap().iter().map(|row| {
        json!({"anchorOrdinal":row[0],"focusQuote":row[1],"assertionKind":row[2],"supportOrdinals":row[3],
            "actor":{"role":row[4][0],"basis":row[4][1],"subjectOrdinal":row[4][2]},
            "eventTime":{"value":row[5][0],"basis":row[5][1],"precision":row[5][2],"uncertainty":row[5][3],"timeSupportOrdinal":row[5][4]},
            "speechAct":row[6],"status":row[7],"verificationId":row[8]})
    }).collect::<Vec<_>>();
    json!({"version":"WikiSourceFocusClaimsNamedQaV1","packetSha256":tuple["packetSha256"],"outcome":"claims","claims":rows}).to_string()
}

#[test]
fn named_mock_transport_keeps_exact_measured_input_and_requires_both_reviews() {
    let (_dir, request, checked, _index) = fixture();
    let measured = RefCell::new(Vec::new());
    let served = RefCell::new(Vec::new());
    let output = activity_synthesis_steps_with_resolution_mode_observed(
        &request,
        &checked.evidence,
        checked.originals.as_ref().unwrap(),
        request.origin.as_ref().unwrap(),
        |system, user| {
            measured
                .borrow_mut()
                .push((system.to_owned(), user.to_owned()));
            Ok(1000)
        },
        |system, user, _, _, schema| {
            assert!(measured
                .borrow()
                .iter()
                .any(|pair| pair.0 == system && pair.1 == user));
            served.borrow_mut().push(schema);
            let packet: Value = serde_json::from_str(user).unwrap();
            match schema {
                GenerationSchema::WikiSourceFocusClaimsQaV1(decoder) => {
                    assert_eq!(decoder.wire_version(), "WikiSourceFocusClaimsNamedQaV1");
                    assert_eq!(
                        TelemetrySchema::from(Some(schema)),
                        TelemetrySchema::WikiSourceFocusClaimsNamedQaV1
                    );
                    Ok(named_reply(&packet))
                }
                GenerationSchema::WikiClaimReviewV1(_) | GenerationSchema::AskAnswerReviewV1 => {
                    Ok(review_reply(schema, &packet, "supported"))
                }
                GenerationSchema::AskAnswerV1 => {
                    Ok(json!({"answer":ANSWER,"sources":["S1"]}).to_string())
                }
                _ => panic!("unexpected named flow schema"),
            }
        },
        |_, _| panic!("no resolution requested"),
        |_| panic!("no resolution requested"),
        true,
        true,
        false,
        false,
        None,
    )
    .unwrap();
    assert_eq!(
        output.answer,
        format!("{ANSWER}\n\n[[sessions/synthetic|synthetic]]")
    );
    let served = served.into_inner();
    assert!(served
        .iter()
        .any(|schema| matches!(schema, GenerationSchema::WikiClaimReviewV1(_))));
    assert!(served.contains(&GenerationSchema::AskAnswerReviewV1));
    assert!(output.receipt.semantic_review_required);
    assert_eq!(output.receipt.independent_verification_receipts, 0);
}

#[test]
fn named_selection_without_source_focus_fails_before_any_model_callback() {
    let (_dir, request, checked, _index) = fixture();
    let error = activity_synthesis_steps_with_resolution_mode_observed(
        &request,
        &checked.evidence,
        checked.originals.as_ref().unwrap(),
        request.origin.as_ref().unwrap(),
        |_, _| panic!("invalid selection must not tokenize"),
        |_, _, _, _, _| panic!("invalid selection must not generate"),
        |_, _| panic!("invalid selection must not resolve"),
        |_| panic!("invalid selection must not recheck"),
        false,
        true,
        false,
        false,
        None,
    )
    .unwrap_err();
    assert_eq!(error.code, "source_verification_failed");
}
