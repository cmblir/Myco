//! Reversible native projection fixtures, not whole-source semantic acceptance.

use super::test_support::{
    assistant_span_id, bound, bound_with_facts, origin, proposal, source_set, structure,
    user_span_id,
};
use super::*;
use crate::retrieval::Scope;
use crate::session_compile::{schema, structure as structure_contract};
use crate::wiki_claims::{ActorRole, AppVerifiedFact, ClaimStatus};
use serde_json::{json, Value};

fn project(claims: &[NativeClaim], lang: &str) -> MaterializedSessionV1 {
    materialize(
        structure_contract::validate(&structure(claims).to_string(), claims).unwrap(),
        claims,
        lang,
    )
    .unwrap()
}

fn field_values(text: &str, lang: &str) -> Vec<Value> {
    let names = labels(lang).unwrap();
    let mut remaining = text;
    let mut values = Vec::new();
    for (index, name) in names.iter().enumerate() {
        remaining = remaining.strip_prefix(&format!("{name}: ")).unwrap();
        let mut stream = serde_json::Deserializer::from_str(remaining).into_iter::<Value>();
        values.push(stream.next().unwrap().unwrap());
        remaining = &remaining[stream.byte_offset()..];
        if index + 1 < names.len() {
            remaining = remaining.strip_prefix(" · ").unwrap();
        }
    }
    assert!(remaining.is_empty());
    values
}

#[test]
fn nested_request_action_survives_the_retained_freeform_failure() {
    let claims = bound(vec![proposal("request the synthetic report")]);
    let legacy = schema::validate(
        &json!({"version":"SessionCompilationV1","title":"Synthetic report",
            "titleClaimIds":[claims[0].id],"entities":[],
            "summaries":[{"claimId":claims[0].id,"text":"The user requested the synthetic report."}]
        })
        .to_string(),
        &claims,
    )
    .unwrap();
    assert_eq!(
        legacy.summaries[0].text,
        "The user requested the synthetic report."
    );
    let canonical = project(&claims, "en");
    let values = field_values(&canonical.as_view().summaries[0].text, "en");
    assert_eq!(values[0], json!("request the synthetic report"));
    assert_eq!(
        values[1],
        json!({"role":"user","basis":"speaker","subjectSpanId":null})
    );
    assert_eq!(values[3], json!("request"));
    assert_eq!(values[4], json!("requested"));
    assert_eq!(
        values[5],
        json!({"value":null,"basis":"unknown","precision":"unknown",
        "uncertainty":"unknown","supportSpanId":null})
    );
    assert_eq!(values[6], Value::Null);
}

#[test]
fn action_literal_roundtrips_markup_controls_separators_and_non_bmp_utf8() {
    for action in [
        "quote \" slash \\ <tag> [link](url) *bold* _emphasis_ \u{0060}code\u{0060}",
        "first\nsecond\rthird\tfourth\u{0000}",
        "x\u{0085}\u{009f}\u{2028}\u{2029}y",
        "🦀 한글 日本語 · Actor: \"untrusted field text\"",
        r"literal \u0085 \n \u2028",
    ] {
        let literal = action_literal(action).unwrap();
        assert_eq!(
            serde_json::from_str::<String>(&literal).unwrap().as_bytes(),
            action.as_bytes()
        );
        assert!(!literal.chars().any(display_control));
        let claims = bound(vec![proposal(action)]);
        let before = serde_json::to_string(&claims).unwrap();
        for lang in ["en", "ko", "ja"] {
            let canonical = project(&claims, lang);
            let row = &canonical.as_view().summaries[0];
            assert_eq!(field_values(&row.text, lang)[0], json!(action));
            assert!(!row.text.chars().any(display_control));
            assert_eq!(row.claim_id, claims[0].id);
        }
        assert_eq!(serde_json::to_string(&claims).unwrap(), before);
    }
}

#[test]
fn full_512_character_actions_survive_separate_trusted_bounds() {
    for action in [
        "x".repeat(512),
        "\u{0001}".repeat(512),
        "x".to_string() + &"\u{0085}".repeat(511),
        "x".to_string() + &"\u{2028}".repeat(511),
        "🦀".repeat(512),
    ] {
        let claims = bound(vec![proposal(&action)]);
        assert_eq!(claims[0].claim.proposal.action.chars().count(), 512);
        let canonical = project(&claims, "ko");
        let row = &canonical.as_view().summaries[0];
        assert_eq!(field_values(&row.text, "ko")[0], json!(action));
        assert!(row.text.chars().count() <= MAX_ROW_CHARACTERS);
        assert!(row.text.len() <= MAX_ROW_BYTES);
        assert!(schema::validate(&serde_json::to_string(&canonical).unwrap(), &claims).is_err());
    }
}

#[test]
fn sixteen_maximum_control_actions_keep_ids_order_and_serialized_byte_bounds() {
    let action = "\u{0001}".repeat(512);
    let claims = bound((0..16).map(|_| proposal(&action)).collect());
    let mut output = structure(&claims);
    output["title"] = json!("🦀".repeat(128));
    output["titleClaimIds"] = json!(claims
        .iter()
        .take(8)
        .map(|claim| claim.id.clone())
        .collect::<Vec<_>>());
    output["entities"] = json!((0..8)
        .map(|_| json!({
            "kind":"artifact","name":"🦀".repeat(80),
            "claimIds":claims.iter().take(8).map(|claim|claim.id.clone()).collect::<Vec<_>>()
        }))
        .collect::<Vec<_>>());
    for lang in ["en", "ko", "ja"] {
        let canonical = materialize(
            structure_contract::validate(&output.to_string(), &claims).unwrap(),
            &claims,
            lang,
        )
        .unwrap();
        assert_eq!(canonical.as_view().summaries.len(), 16);
        for (row, claim) in canonical.as_view().summaries.iter().zip(&claims) {
            assert_eq!(row.claim_id, claim.id);
            assert_eq!(field_values(&row.text, lang)[0], json!(action));
            assert!(row.text.chars().count() <= 3809);
            assert!(row.text.len() <= 4487);
            assert!(serde_json::to_vec(&row.text).unwrap().len() <= 5043);
            assert!(serde_json::to_vec(row).unwrap().len() <= 5129);
        }
        let serialized = serde_json::to_vec(&canonical).unwrap();
        assert!(serialized.len() <= 90837);
        assert!(serialized.len() <= MAX_VIEW_BYTES);
    }
    // This worst-case generic aggregate must not relax the real extractor cap.
    let raw_batch = json!({"outcome":"claims",
        "claims":(0..16).map(|_|proposal(&action)).collect::<Vec<_>>()})
    .to_string();
    assert!(raw_batch.len() > 32 * 1024);
    assert!(source_set(vec![])
        .validate(&raw_batch, &origin(), Scope::All)
        .is_err());
}

#[test]
fn anchor_speaker_is_found_by_id_even_when_support_order_and_actor_differ() {
    let mut value = proposal("the assistant plans to draft the synthetic report");
    value["supportSpanIds"] = json!([assistant_span_id(), user_span_id()]);
    value["actor"] = json!({"role":"assistant","basis":"explicit_subject",
        "subjectSpanId":assistant_span_id()});
    value["speechAct"] = json!("plan");
    value["status"] = json!("planned");
    let claims = bound(vec![value]);
    assert_eq!(
        claims[0].claim.provenance[0].speaker(),
        ActorRole::Assistant
    );
    let canonical = project(&claims, "en");
    let fields = field_values(&canonical.as_view().summaries[0].text, "en");
    assert_eq!(
        fields[1],
        json!({"role":"assistant","basis":"explicit_subject",
        "subjectSpanId":assistant_span_id()})
    );
    assert_eq!(fields[2], json!("user"));
}

#[test]
fn complete_unknown_explicit_inferred_and_reference_times_are_preserved() {
    let mut times = vec![proposal("request the synthetic report")["eventTime"].clone()];
    times.extend([
        json!({"value":"2026-10-01","basis":"explicit","precision":"day",
            "uncertainty":"specified","supportSpanId":user_span_id()}),
        json!({"value":"2026-10-01T12:00:00Z","basis":"inferred_from_turn","precision":"instant",
            "uncertainty":"inferred","supportSpanId":user_span_id()}),
        json!({"value":"2026-10-01","basis":"date_reference","precision":"day",
            "uncertainty":"inferred","supportSpanId":user_span_id()}),
    ]);
    for time in times {
        let mut value = proposal("request the synthetic report");
        value["eventTime"] = time.clone();
        let claims = bound(vec![value]);
        let canonical = project(&claims, "en");
        let fields = field_values(&canonical.as_view().summaries[0].text, "en");
        assert_eq!(fields[5], time);
        if time["basis"] == "unknown" {
            assert!(!canonical.as_view().summaries[0].text.contains("2026-10-06"));
            assert!(!canonical.as_view().summaries[0].text.contains("2026-10-01"));
        }
    }
}

#[test]
fn speech_status_negation_and_qualification_are_never_rewritten() {
    for (speech, status, action) in [
        ("request", "requested", "request the synthetic report"),
        (
            "plan",
            "planned",
            "I plan to draft the synthetic report; no completion is recorded",
        ),
        (
            "report",
            "in_progress",
            "I am drafting the synthetic report",
        ),
        (
            "report",
            "reported_completed",
            "I report that the synthetic report was drafted",
        ),
        (
            "report",
            "reported_failed",
            "I report that the synthetic report could not be drafted",
        ),
        (
            "report",
            "reported_cancelled",
            "I report cancellation of the synthetic report",
        ),
        (
            "report",
            "reported_rolled_back",
            "I report rollback of the synthetic report",
        ),
        (
            "retraction",
            "retracted",
            "The synthetic report is withdrawn; do not treat it as completed",
        ),
        (
            "unknown",
            "unknown",
            "The synthetic report has no recorded outcome",
        ),
        (
            "question",
            "unknown",
            "Has the synthetic report been requested?",
        ),
    ] {
        let mut value = proposal(action);
        value["speechAct"] = json!(speech);
        value["status"] = json!(status);
        let claims = bound(vec![value]);
        let canonical = project(&claims, "en");
        let fields = field_values(&canonical.as_view().summaries[0].text, "en");
        assert_eq!(fields[0], json!(action));
        assert_eq!(fields[3], json!(speech));
        assert_eq!(fields[4], json!(status));
        assert_eq!(fields[6], Value::Null);
    }
}

#[test]
fn generic_bound_receipt_status_is_retained_but_no_receipt_is_manufactured() {
    for (code, status) in [
        ("verified_completed", ClaimStatus::VerifiedCompleted),
        ("verified_failed", ClaimStatus::VerifiedFailed),
    ] {
        let action = "Synthetic application checked statement";
        let receipt_id = "V".repeat(64);
        let mut value = proposal(action);
        value["speechAct"] = json!("verification");
        value["status"] = json!(code);
        value["verificationId"] = json!(receipt_id);
        assert!(source_set(vec![])
            .validate(
                &json!({"outcome":"claims","claims":[value.clone()]}).to_string(),
                &origin(),
                Scope::All,
            )
            .is_err());
        // Synthetic application-receipt fixture, not an observed real-world
        // outcome, an executed independent check, or a materializer receipt.
        let claims = bound_with_facts(
            vec![value],
            vec![AppVerifiedFact {
                id: receipt_id.clone(),
                canonical_statement: action.into(),
                status,
                support_span_ids: vec![user_span_id()],
            }],
        );
        let before = serde_json::to_string(&claims).unwrap();
        let canonical = project(&claims, "en");
        let fields = field_values(&canonical.as_view().summaries[0].text, "en");
        assert_eq!(fields[4], json!(code));
        assert_eq!(fields[6], json!(receipt_id));
        assert_eq!(serde_json::to_string(&claims).unwrap(), before);
    }
}

#[test]
fn zero_claim_view_is_app_owned_and_legacy_parser_always_rejects_its_tag() {
    let canonical = project(&[], "ko");
    assert_eq!(canonical.as_view().version, MATERIALIZED_VERSION);
    assert!(canonical.as_view().title.is_empty());
    assert!(canonical.as_view().title_claim_ids.is_empty());
    assert!(canonical.as_view().entities.is_empty());
    assert!(canonical.as_view().summaries.is_empty());
    assert!(schema::validate(&serde_json::to_string(&canonical).unwrap(), &[]).is_err());
}

#[test]
fn transparent_wrapper_and_borrowed_review_view_have_identical_revision_bytes() {
    let claims = bound(vec![proposal("request the synthetic report")]);
    let canonical = project(&claims, "en");
    let owned = serde_json::to_vec(&canonical).unwrap();
    let borrowed = serde_json::to_vec(canonical.as_view()).unwrap();
    assert_eq!(owned, borrowed);
    assert!(schema::validate(std::str::from_utf8(&owned).unwrap(), &claims).is_err());
}

#[test]
fn locale_groups_bounds_and_unknown_language_failures_are_explicit() {
    let claims = bound(vec![proposal("request the synthetic report")]);
    for lang in ["en", "ko", "ja"] {
        let names = labels(lang).unwrap();
        assert_eq!(names.len(), 7);
        assert!(names.iter().all(|name| !name.trim().is_empty()
            && name.chars().count() <= MAX_LABEL_CHARACTERS
            && !name.chars().any(display_control)));
        assert_eq!(
            field_values(&project(&claims, lang).as_view().summaries[0].text, lang).len(),
            7
        );
    }
    assert_ne!(labels("en").unwrap(), labels("ko").unwrap());
    assert_ne!(labels("en").unwrap(), labels("ja").unwrap());
    for unsupported in ["", "de", "EN"] {
        assert!(materialize(
            structure_contract::validate(&structure(&claims).to_string(), &claims).unwrap(),
            &claims,
            unsupported,
        )
        .is_err());
    }
}

#[test]
fn missing_anchor_or_unchecked_or_oversized_activity_cannot_be_materialized() {
    for kind in ["missing-anchor", "unchecked", "oversized"] {
        let mut claims = bound(vec![proposal("request the synthetic report")]);
        match kind {
            "missing-anchor" => claims[0].claim.provenance.clear(),
            "unchecked" => claims[0].claim.structure_checked = false,
            "oversized" => claims[0].claim.proposal.action = "x".repeat(513),
            _ => unreachable!(),
        }
        let validated =
            structure_contract::validate(&structure(&claims).to_string(), &claims).unwrap();
        assert!(materialize(validated, &claims, "en").is_err(), "{kind}");
    }
}
