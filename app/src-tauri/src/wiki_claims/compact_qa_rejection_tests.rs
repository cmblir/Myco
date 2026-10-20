//! Fail closed on malformed wire syntax instead of repairing partial output.

use super::*;

#[test]
fn prepare_rejects_zero_nine_unordered_duplicate_and_nonempty_receipt_packets() {
    let (_, raw, _) = fixture();
    let input: Value = serde_json::from_str(&raw).unwrap();
    for count in [0, 1, 3, 8, 9] {
        let mut candidate = input.clone();
        let spans = (0..count)
            .map(|ordinal| {
                let mut span = input["originalSpans"][0].clone();
                span["id"] = json!(format!("SPAN_{ordinal}"));
                span
            })
            .collect::<Vec<_>>();
        candidate["allowedSpanIds"] = json!(spans
            .iter()
            .map(|span| span["id"].clone())
            .collect::<Vec<_>>());
        candidate["originalSpans"] = json!(spans);
        let result = PreparedCompactQa::prepare(extraction_system(), &candidate.to_string());
        assert_eq!(result.is_ok(), (1..=8).contains(&count));
        if let Ok(packet) = result {
            assert_eq!(packet.decoder().span_count(), count);
            if count == 8 {
                assert!(packet.decoder().grammar().contains("| \"7\"\n"));
            }
            assert!(!packet.decoder().grammar().contains("\"8\""));
        }
    }
    let mut mutations = Vec::new();
    let mut swapped = input.clone();
    swapped["allowedSpanIds"].as_array_mut().unwrap().swap(0, 1);
    mutations.push(swapped);
    let mut duplicate = input.clone();
    duplicate["originalSpans"][1]["id"] = duplicate["originalSpans"][0]["id"].clone();
    duplicate["allowedSpanIds"][1] = duplicate["allowedSpanIds"][0].clone();
    mutations.push(duplicate);
    let mut receipts = input.clone();
    receipts["independentVerificationReceipts"] = json!([{"id":"fabricated"}]);
    mutations.push(receipts);
    let mut missing_receipts = input.clone();
    missing_receipts
        .as_object_mut()
        .unwrap()
        .remove("independentVerificationReceipts");
    mutations.push(missing_receipts);
    let mut missing_allowed = input.clone();
    missing_allowed
        .as_object_mut()
        .unwrap()
        .remove("allowedSpanIds");
    mutations.push(missing_allowed);
    let mut reserved = input;
    reserved["packetSha256"] = json!("forged");
    mutations.push(reserved);
    for candidate in mutations {
        assert!(PreparedCompactQa::prepare(extraction_system(), &candidate.to_string()).is_err());
    }
}

#[test]
fn tuple_outer_and_nested_extra_missing_and_duplicate_fields_are_rejected() {
    let (_, packet, native) = prepared();
    let valid = compact(&packet, &native);
    let mut mutations = Vec::new();
    for key in ["version", "packetSha256", "outcome", "claims"] {
        let mut missing = valid.clone();
        missing.as_object_mut().unwrap().remove(key);
        mutations.push(missing);
    }
    let mut extra = valid.clone();
    extra["approved"] = json!(true);
    mutations.push(extra);
    for path in [vec![], vec![3], vec![4]] {
        for is_extra in [false, true] {
            let mut candidate = valid.clone();
            let mut tuple = &mut candidate["claims"][0];
            for index in &path {
                tuple = &mut tuple[*index];
            }
            let values = tuple.as_array_mut().unwrap();
            if is_extra {
                values.push(Value::Null);
            } else {
                values.pop();
            }
            mutations.push(candidate);
        }
    }
    for candidate in mutations {
        assert!(packet.expand(&candidate.to_string()).is_err());
    }
    let serialized = valid.to_string();
    let duplicate_version = serialized.replacen("{", &format!("{{\"version\":\"{VERSION}\","), 1);
    assert!(packet.expand(&duplicate_version).is_err());
}

#[test]
fn all_reference_slots_reject_negative_fractional_string_and_absent_ordinals() {
    let (_, packet, native) = prepared();
    let valid = compact(&packet, &native);
    for invalid in [
        json!(-1),
        json!(0.5),
        json!("0"),
        json!(2),
        json!(18446744073709551615_u64),
    ] {
        for slot in 0..4 {
            let mut candidate = valid.clone();
            match slot {
                0 => candidate["claims"][0][1] = invalid.clone(),
                1 => candidate["claims"][0][2][0] = invalid.clone(),
                2 => candidate["claims"][2][3][2] = invalid.clone(),
                _ => candidate["claims"][2][4][4] = invalid.clone(),
            }
            assert!(packet.expand(&candidate.to_string()).is_err());
        }
    }
}

#[test]
fn exact_duplicates_wrong_coupling_receipts_and_inconsistent_outcomes_are_rejected() {
    let (_, packet, native) = prepared();
    let valid = compact(&packet, &native);
    let mut mutations = Vec::new();
    let mut repeated_claim = valid.clone();
    let first = repeated_claim["claims"][0].clone();
    repeated_claim["claims"].as_array_mut().unwrap().push(first);
    mutations.push(repeated_claim);
    let mut repeated_support = valid.clone();
    repeated_support["claims"][0][2] = json!([0, 0]);
    mutations.push(repeated_support);
    let mut no_anchor = valid.clone();
    no_anchor["claims"][0][2] = json!([1]);
    mutations.push(no_anchor);
    let mut outside_actor = valid.clone();
    outside_actor["claims"][2][3][2] = json!(1);
    mutations.push(outside_actor);
    let mut outside_time = valid.clone();
    outside_time["claims"][2][4][4] = json!(1);
    mutations.push(outside_time);
    let mut actor = valid.clone();
    actor["claims"][0][3] = json!(["assistant", "unknown", null]);
    mutations.push(actor);
    let mut time = valid.clone();
    time["claims"][0][4] = json!(["2026-10-01", "unknown", "day", "specified", 0]);
    mutations.push(time);
    let mut act = valid.clone();
    act["claims"][0][5] = json!("request");
    mutations.push(act);
    for status in ["verified_completed", "verified_failed"] {
        let mut verified = valid.clone();
        verified["claims"][0][5] = json!("verification");
        verified["claims"][0][6] = json!(status);
        mutations.push(verified);
    }
    let mut receipt = valid.clone();
    receipt["claims"][0][7] = json!("fabricated_receipt");
    mutations.push(receipt);
    let mut wrong_outcome = valid.clone();
    wrong_outcome["outcome"] = json!("insufficient_evidence");
    mutations.push(wrong_outcome);
    let mut empty_claims = valid.clone();
    empty_claims["claims"] = json!([]);
    mutations.push(empty_claims);
    let mut wrong_version = valid.clone();
    wrong_version["version"] = json!("WikiClaimsV1");
    mutations.push(wrong_version);
    let mut wrong_digest = valid;
    wrong_digest["packetSha256"] = json!("0".repeat(64));
    mutations.push(wrong_digest);
    for candidate in mutations {
        assert!(packet.expand(&candidate.to_string()).is_err());
    }
}

#[test]
fn eof_prefixes_and_oversized_output_fail_without_salvage() {
    let (_, packet, native) = prepared();
    let raw = compact(&packet, &native).to_string();
    for boundary in raw.char_indices().map(|(index, _)| index) {
        assert!(packet.expand(&raw[..boundary]).is_err());
    }
    assert!(packet
        .expand(&(raw.clone() + &" ".repeat(crate::wiki_claims::MAX_OUTPUT_BYTES)))
        .is_err());
    let mut many = compact(&packet, &native);
    let original = many["claims"][0].clone();
    many["claims"] = json!((0..17)
        .map(|ordinal| {
            let mut claim = original.clone();
            claim[0] = json!(format!("Distinct proposed action {ordinal}"));
            claim
        })
        .collect::<Vec<_>>());
    assert!(packet.expand(&many.to_string()).is_err());
}
