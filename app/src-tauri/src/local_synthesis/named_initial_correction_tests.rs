//! Mock transport checks format custody; it never establishes model correctness.
use super::*;
use crate::wiki_claims::focus_claims_qa::Encoding;

fn named_output(packet: &Value, claims: Vec<Value>) -> String {
    let outcome = if claims.is_empty() {
        "insufficient_evidence"
    } else {
        "claims"
    };
    let named: Vec<_> = claims.iter().map(|row| json!({"anchorOrdinal":row[0],"focusQuote":row[1],"assertionKind":row[2],"supportOrdinals":row[3],
        "actor":{"role":row[4][0],"basis":row[4][1],"subjectOrdinal":row[4][2]},
        "eventTime":{"value":row[5][0],"basis":row[5][1],"precision":row[5][2],"uncertainty":row[5][3],"timeSupportOrdinal":row[5][4]},
        "speechAct":row[6],"status":row[7],"verificationId":row[8]})).collect();
    json!({"version":"WikiSourceFocusClaimsNamedQaV1","packetSha256":packet["packetSha256"],"outcome":outcome,"claims":named}).to_string()
}

#[test]
fn named_missing_review_correction_preserves_format_previous_raw_and_originals() {
    let sources = sources(2);
    let context = crate::wiki_claim_review::tests::context(
        QUESTION,
        "en",
        Scope::Sessions,
        &period(),
        &origin(),
    )
    .with_source_focus_qa_encoding(Encoding::NamedV1)
    .unwrap()
    .with_review_correction_qa()
    .unwrap();
    let previous = RefCell::new(String::new());
    let initial = RefCell::new(Value::Null);
    let extraction_calls = Cell::new(0);
    let result = extract(
        &sources,
        &context,
        |_, _| Ok(1500),
        |system, user, _, _, schema| {
            let packet: Value = serde_json::from_str(user).unwrap();
            if matches!(schema, GenerationSchema::WikiClaimReviewV1(_)) {
                return Ok(negative(
                    user,
                    "supported",
                    if extraction_calls.get() == 1 {
                        "missing"
                    } else {
                        "covered"
                    },
                ));
            }
            let GenerationSchema::WikiSourceFocusClaimsQaV1(decoder) = schema else {
                panic!("unexpected schema")
            };
            assert_eq!(decoder.wire_version(), "WikiSourceFocusClaimsNamedQaV1");
            assert!(system.contains("WikiSourceFocusClaimsNamedQaV1"));
            extraction_calls.set(extraction_calls.get() + 1);
            if packet.get("initialExtractionCorrection").is_none() {
                *initial.borrow_mut() = packet.clone();
                let raw = named_output(&packet, vec![]);
                *previous.borrow_mut() = raw.clone();
                return Ok(raw);
            }
            assert_eq!(
                packet["initialExtractionCorrection"]["previousModelResult"],
                *previous.borrow()
            );
            assert_eq!(packet["originalSpans"], initial.borrow()["originalSpans"]);
            Ok(named_output(&packet, good_claims()))
        },
    )
    .unwrap();
    assert_eq!(extraction_calls.get(), 2);
    assert!(result.review_correction_used);
    assert_eq!(
        result.focus_projections[0].encoding(),
        Some(Encoding::NamedV1)
    );
    assert_eq!(result.claims.claims.len(), 4);
}
