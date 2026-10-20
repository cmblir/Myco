//! Closed structure and unchanged legacy parser boundaries, not semantic gold.

use super::*;
use crate::session_compile::materializer::test_support::{bound, proposal, structure};
use serde_json::json;

#[test]
fn zero_one_and_sixteen_claims_are_closed_and_bound() {
    for count in [0, 1, 16] {
        let claims = bound(
            (0..count)
                .map(|_| proposal("request the synthetic report"))
                .collect(),
        );
        let validated = validate(&structure(&claims).to_string(), &claims).unwrap();
        let accepted = validated.into_proposal(&claims).unwrap();
        assert_eq!(accepted.version, "SessionStructureV1");
        assert_eq!(accepted.title.is_empty(), count == 0);
        assert!(accepted.entities.is_empty());
    }
    let claims = bound(
        (0..17)
            .map(|_| proposal("request the synthetic report"))
            .collect(),
    );
    assert!(validate(&structure(&claims).to_string(), &claims).is_err());
}

#[test]
fn empty_output_is_exact_and_malformed_empty_is_not_normalized() {
    let raw = empty_output().unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&raw).unwrap(),
        json!({"version":"SessionStructureV1","title":"","titleClaimIds":[],"entities":[]})
    );
    validate(&raw, &[]).unwrap();
    for malformed in [
        json!({"version":"SessionStructureV1","title":"Invented title","titleClaimIds":[],"entities":[]}),
        json!({"version":"SessionStructureV1","title":"","titleClaimIds":["FOREIGN"],"entities":[]}),
        json!({"version":"SessionStructureV1","title":"","titleClaimIds":[],
            "entities":[{"kind":"topic","name":"Invented","claimIds":[]}]}),
        json!({"version":"SessionStructureV1","title":"","titleClaimIds":[],"entities":[],"summaries":[]}),
    ] {
        assert!(validate(&malformed.to_string(), &[]).is_err());
    }
}

#[test]
fn unknown_fields_old_summaries_and_duplicate_json_fields_are_rejected() {
    let claims = bound(vec![proposal("request the synthetic report")]);
    for field in [
        "summaries",
        "actions",
        "actor",
        "eventTime",
        "sourceRevision",
        "completed",
    ] {
        let mut output = structure(&claims);
        output[field] = json!([]);
        assert!(validate(&output.to_string(), &claims).is_err(), "{field}");
    }
    let duplicate = format!(
        "{{\"version\":\"SessionStructureV1\",\"title\":\"First\",\"title\":\"Second\",\"titleClaimIds\":[\"{}\"],\"entities\":[]}}",
        claims[0].id
    );
    assert!(validate(&duplicate, &claims).is_err());
    let mut legacy = structure(&claims);
    legacy["version"] = json!("SessionCompilationV1");
    assert!(validate(&legacy.to_string(), &claims).is_err());
}

#[test]
fn title_and_entity_references_cannot_be_unknown_duplicate_or_unbounded() {
    let claims = bound(vec![proposal("request the synthetic report")]);
    for ids in [
        json!([]),
        json!(["FOREIGN"]),
        json!([claims[0].id, claims[0].id]),
        json!((0..9).map(|_| claims[0].id.clone()).collect::<Vec<_>>()),
    ] {
        let mut output = structure(&claims);
        output["titleClaimIds"] = ids;
        assert!(validate(&output.to_string(), &claims).is_err());
    }
    for ids in [
        json!([]),
        json!(["FOREIGN"]),
        json!([claims[0].id, claims[0].id]),
    ] {
        let mut output = structure(&claims);
        output["entities"] = json!([{"kind":"topic","name":"Synthetic report","claimIds":ids}]);
        assert!(validate(&output.to_string(), &claims).is_err());
    }
    let mut duplicate_native = claims.clone();
    duplicate_native.push(claims[0].clone());
    assert!(validate(&structure(&duplicate_native).to_string(), &duplicate_native).is_err());
    let mut bad_native = claims.clone();
    bad_native[0].id = "not a native ID".into();
    assert!(validate(&structure(&bad_native).to_string(), &bad_native).is_err());
}

#[test]
fn title_entity_text_kind_and_count_keep_existing_bounds() {
    let claims = bound(vec![proposal("request the synthetic report")]);
    for title in ["".to_string(), "x".repeat(129), "x\n".into()] {
        let mut output = structure(&claims);
        output["title"] = json!(title);
        assert!(validate(&output.to_string(), &claims).is_err());
    }
    for name in [
        "".to_string(),
        " ".into(),
        "x".repeat(81),
        "x\u{0085}".into(),
    ] {
        let mut output = structure(&claims);
        output["entities"] = json!([{"kind":"topic","name":name,"claimIds":[claims[0].id]}]);
        assert!(validate(&output.to_string(), &claims).is_err());
    }
    let mut output = structure(&claims);
    output["entities"] =
        json!([{"kind":"arbitrary_kind","name":"Synthetic","claimIds":[claims[0].id]}]);
    assert!(validate(&output.to_string(), &claims).is_err());
    output["entities"] = json!((0..9)
        .map(|_| json!({
            "kind":"topic","name":"Synthetic","claimIds":[claims[0].id]
        }))
        .collect::<Vec<_>>());
    assert!(validate(&output.to_string(), &claims).is_err());
}

#[test]
fn raw_structure_byte_cap_and_exact_native_binding_are_not_bypassed() {
    let claims = bound(vec![proposal("request the synthetic report")]);
    let raw = structure(&claims).to_string() + &" ".repeat(MAX_STRUCTURE_OUTPUT_BYTES);
    assert!(validate(&raw, &claims).is_err());
    let validated = validate(&structure(&claims).to_string(), &claims).unwrap();
    let mut changed = claims.clone();
    changed[0].claim.proposal.action = "produce the synthetic report".into();
    assert!(validated.into_proposal(&changed).is_err());
}

#[test]
fn legacy_model_summary_512_is_accepted_513_and_controls_are_rejected() {
    let claims = bound(vec![proposal("request the synthetic report")]);
    let legacy = |text: &str| {
        json!({
            "version":"SessionCompilationV1","title":"Synthetic report",
            "titleClaimIds":[claims[0].id],"entities":[],
            "summaries":[{"claimId":claims[0].id,"text":text}]
        })
        .to_string()
    };
    assert!(schema::validate(&legacy(&"x".repeat(512)), &claims).is_ok());
    assert!(schema::validate(&legacy(&"x".repeat(513)), &claims).is_err());
    for text in ["x\n", "x\u{0085}"] {
        assert!(schema::validate(&legacy(text), &claims).is_err());
    }
}
