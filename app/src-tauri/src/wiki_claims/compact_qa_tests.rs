//! Synthetic source/representation checks, not model comprehension grades.

use super::*;
use crate::local_synthesis::claim_prompt::extraction_system;
use crate::retrieval::Scope;
use crate::vault_session::AgentVaultSession;
use crate::wiki_claims::{ActorRole, SourceDocument, SourceSet, SpanInput};
use serde_json::{json, Value};

fn origin() -> AgentVaultSession {
    AgentVaultSession {
        vault_path: "/synthetic/compact-qa".into(),
        opening_token: "compact-qa-opening".into(),
    }
}

fn unknown_time() -> Value {
    json!({"value":null,"basis":"unknown","precision":"unknown",
        "uncertainty":"unknown","supportSpanId":null})
}

fn native_claim(action: &str, anchor: &str, actor: Value, time: Value, status: &str) -> Value {
    json!({"action":action,"anchorSpanId":anchor,"supportSpanIds":[anchor],
        "actor":actor,"eventTime":time,"speechAct":"report","status":status,
        "verificationId":null})
}

fn fixture() -> (SourceSet, String, Value) {
    let first = "I prepared the archive repair plan. I did not repair the archive on 2026-10-01. The maintainer repaired the archive on 2026-10-01; I have not independently verified it.";
    let second = "I decided not to deploy because the preview was blank. I cancelled the rollout, reopened the investigation, and did not deploy.";
    let prefix = "선행 원문\n";
    let original = format!("{prefix}{first}\n{second}");
    let second_start = prefix.len() + first.len() + 1;
    let document = SourceDocument::bind(
        "S-COMPACT".into(),
        "sessions/compact-original.md".into(),
        "sessions/compact-original.md".into(),
        &original,
        Some("2026-10-02".into()),
        vec![
            SpanInput {
                id: "A1".into(),
                start: prefix.len(),
                end: prefix.len() + first.len(),
                turn_id: "T-A".into(),
                speaker: ActorRole::Assistant,
                turn_time: Some("2026-10-03T08:00:00Z".into()),
            },
            SpanInput {
                id: "B1".into(),
                start: second_start,
                end: original.len(),
                turn_id: "T-B".into(),
                speaker: ActorRole::User,
                turn_time: Some("2026-10-04T09:00:00Z".into()),
            },
        ],
    )
    .unwrap()
    .with_turn_phases(&[
        ("T-A".into(), Some("final".into())),
        ("T-B".into(), Some("final".into())),
    ])
    .unwrap();
    let sources = SourceSet::new(origin(), Scope::Sessions, vec![document], vec![]).unwrap();
    let input = json!({
        "question":"Summarize the recent work", "language":"en",
        "allowedSpanIds":["A1","B1"],
        "originalSpans":sources.spans().collect::<Vec<_>>(),
        "activityPeriod":{"start":"2026-10-01","end":"2026-10-04"},
        "recordPeriodContext":{"annotations":[{"original":"A1","eligible":true}]},
        "preservedMetadata":{"opaque":"그대로\n保存", "values":[1,null,false]},
        "independentVerificationReceipts":[],
    });
    let speaker = |role| json!({"role":role,"basis":"speaker","subjectSpanId":null});
    let explicit_time = json!({"value":"2026-10-01","basis":"explicit",
        "precision":"day","uncertainty":"specified","supportSpanId":"A1"});
    let claims = vec![
        native_claim(
            "Prepare the archive repair plan",
            "A1",
            speaker("assistant"),
            unknown_time(),
            "reported_completed",
        ),
        native_claim(
            "I did not repair the archive",
            "A1",
            speaker("assistant"),
            explicit_time.clone(),
            "unknown",
        ),
        native_claim(
            "The maintainer repaired the archive",
            "A1",
            json!({"role":"source","basis":"explicit_subject","subjectSpanId":"A1"}),
            explicit_time,
            "reported_completed",
        ),
        native_claim(
            "I have not independently verified the repair",
            "A1",
            speaker("assistant"),
            unknown_time(),
            "unknown",
        ),
        native_claim(
            "Decide not to deploy because the preview was blank",
            "B1",
            speaker("user"),
            unknown_time(),
            "reported_completed",
        ),
        native_claim(
            "Cancel the rollout",
            "B1",
            speaker("user"),
            unknown_time(),
            "reported_cancelled",
        ),
        native_claim(
            "Reopen the investigation",
            "B1",
            speaker("user"),
            unknown_time(),
            "reported_completed",
        ),
        native_claim(
            "I did not deploy",
            "B1",
            speaker("user"),
            unknown_time(),
            "unknown",
        ),
    ];
    (
        sources,
        serde_json::to_string_pretty(&input).unwrap(),
        json!({"outcome":"claims","claims":claims}),
    )
}

fn prepared() -> (SourceSet, PreparedCompactQa, Value) {
    let (sources, input, native) = fixture();
    let packet = PreparedCompactQa::prepare(extraction_system(), &input).unwrap();
    (sources, packet, native)
}

fn compact(packet: &PreparedCompactQa, native: &Value) -> Value {
    serde_json::from_str(&wire::encode_native(&packet.packet, &native.to_string()).unwrap())
        .unwrap()
}

#[test]
fn complete_native_snapshot_and_claims_round_trip_without_meaning_upgrade() {
    let (sources, packet, native) = prepared();
    let original: Value = serde_json::from_str(packet.original_user()).unwrap();
    let mut augmented: Value = serde_json::from_str(packet.user()).unwrap();
    assert_eq!(augmented["originalSpans"], original["originalSpans"]);
    assert_eq!(
        augmented["spanOrdinalDictionary"],
        json!([
            {"ordinal":0,"spanId":"A1"},{"ordinal":1,"spanId":"B1"},
        ])
    );
    assert_eq!(
        augmented["packetSha256"],
        crate::wiki_claims::sha256(packet.original_user().as_bytes())
    );
    augmented
        .as_object_mut()
        .unwrap()
        .remove("spanOrdinalDictionary");
    augmented.as_object_mut().unwrap().remove("packetSha256");
    assert_eq!(augmented, original);
    let expanded = packet
        .expand(&compact(&packet, &native).to_string())
        .unwrap();
    assert_eq!(serde_json::from_str::<Value>(&expanded).unwrap(), native);
    let checked = sources
        .validate(&expanded, &origin(), Scope::Sessions)
        .unwrap();
    assert_eq!(checked.claims.len(), 8);
    for claim in &checked.claims {
        assert!(claim.structure_checked && claim.semantic_review_required);
        assert!(claim
            .provenance
            .iter()
            .all(|span| sources.spans().any(|original| original == span)));
    }
    assert_eq!(checked.claims[2].proposal.actor.role, ActorRole::Source);
    assert_eq!(
        checked.claims[2].proposal.event_time.value.as_deref(),
        Some("2026-10-01")
    );
    assert!(checked.claims[4]
        .proposal
        .action
        .contains("because the preview was blank"));
    assert!(checked.claims[7].proposal.action.contains("did not deploy"));
}

#[test]
fn unknown_actor_time_and_status_and_exact_action_bytes_are_retained() {
    let (_, packet, mut native) = prepared();
    native["claims"] = json!([native["claims"][0].clone()]);
    native["claims"][0]["action"] = json!("  Prepare \"archivé\" plan\n  ");
    native["claims"][0]["actor"] = json!({"role":"unknown","basis":"unknown","subjectSpanId":null});
    native["claims"][0]["status"] = json!("unknown");
    let raw = compact(&packet, &native);
    assert_eq!(
        serde_json::from_str::<Value>(&packet.expand(&raw.to_string()).unwrap()).unwrap(),
        native
    );
}

#[test]
fn same_count_different_order_body_metadata_or_raw_json_cannot_replay() {
    let (_, packet, native) = prepared();
    let emitted = compact(&packet, &native).to_string();
    let original: Value = serde_json::from_str(packet.original_user()).unwrap();
    let mut variants = Vec::new();
    let mut reordered = original.clone();
    reordered["originalSpans"]
        .as_array_mut()
        .unwrap()
        .swap(0, 1);
    reordered["allowedSpanIds"]
        .as_array_mut()
        .unwrap()
        .swap(0, 1);
    variants.push(reordered.to_string());
    let mut changed_body = original.clone();
    changed_body["originalSpans"][0]["text"] = json!("I changed the source body.");
    variants.push(changed_body.to_string());
    let mut changed_metadata = original.clone();
    changed_metadata["originalSpans"][0]["turnTime"] = json!("2026-10-06T08:00:00Z");
    variants.push(changed_metadata.to_string());
    variants.push(original.to_string());
    for input in variants {
        let different = PreparedCompactQa::prepare(extraction_system(), &input).unwrap();
        assert_ne!(different.decoder(), packet.decoder());
        assert!(different
            .expand(&emitted)
            .unwrap_err()
            .contains("SHA differs"));
    }
}

#[test]
fn source_actor_and_date_checks_still_reject_structurally_valid_tuples() {
    let (sources, packet, mut native) = prepared();
    native["claims"] = json!([native["claims"][0].clone()]);
    native["claims"][0]["actor"]["role"] = json!("user");
    let expanded = packet
        .expand(&compact(&packet, &native).to_string())
        .unwrap();
    assert!(sources
        .validate(&expanded, &origin(), Scope::Sessions)
        .is_err());
    native["claims"][0]["actor"]["role"] = json!("assistant");
    native["claims"][0]["eventTime"] = json!({"value":"2026-09-30","basis":"explicit",
        "precision":"day","uncertainty":"specified","supportSpanId":"A1"});
    let expanded = packet
        .expand(&compact(&packet, &native).to_string())
        .unwrap();
    assert!(sources
        .validate(&expanded, &origin(), Scope::Sessions)
        .unwrap_err()
        .contains("absent"));
}

#[test]
fn prompt_retains_semantics_period_suffix_and_mechanically_encoded_demonstration() {
    let (_, input, _) = fixture();
    let period = format!("\n{}", crate::activity_recall::period_context::INSTRUCTIONS);
    let system = crate::local_synthesis::claim_prompt::activity_system();
    let packet = PreparedCompactQa::prepare(&system, &input).unwrap();
    assert!(packet.system().ends_with(&period));
    let original_policy = extraction_system()
        .split_once("\nPreserve each relevant")
        .unwrap()
        .1
        .split_once("The following is a fictional")
        .unwrap()
        .0;
    let empty = prompt::empty_output(packet.decoder());
    let expected_policy = original_policy.replace(prompt::EMPTY_NATIVE, &empty);
    assert!(packet.system().contains(&expected_policy));
    let extract_demo = |system: &str| {
        let (_, rest) = system.split_once(prompt::INPUT_MARKER).unwrap();
        let (input, rest) = rest.split_once(prompt::OUTPUT_MARKER).unwrap();
        let (output, _) = rest.split_once(prompt::END_MARKER).unwrap();
        (
            serde_json::from_str::<Value>(input).unwrap(),
            serde_json::from_str::<Value>(output).unwrap(),
        )
    };
    let (original_demo, native_demo) = extract_demo(extraction_system());
    let (mut compact_demo, output) = extract_demo(packet.system());
    let expected_hash = compact_demo["packetSha256"].as_str().unwrap().to_owned();
    compact_demo.as_object_mut().unwrap().remove("packetSha256");
    compact_demo
        .as_object_mut()
        .unwrap()
        .remove("spanOrdinalDictionary");
    let demo_packet = Packet::capture(&compact_demo.to_string()).unwrap();
    assert_eq!(demo_packet.decoder.digest_hex(), expected_hash);
    assert_eq!(
        serde_json::from_str::<Value>(&wire::expand(&demo_packet, &output.to_string()).unwrap())
            .unwrap(),
        native_demo
    );
    compact_demo
        .as_object_mut()
        .unwrap()
        .remove("allowedSpanIds");
    assert_eq!(compact_demo, original_demo);
}

#[test]
fn decoder_grammar_fixes_complete_digest_and_each_captured_ordinal() {
    let (_, packet, _) = prepared();
    let grammar = packet.decoder().grammar();
    assert!(grammar.contains("WikiClaimsCompactQaV1"));
    assert!(grammar.contains(&packet.decoder().digest_hex()));
    assert!(grammar.contains("ordinal ::= \"0\" | \"1\"\n"));
    assert!(!grammar.contains("\"2\""));
    assert!(!grammar.contains("verified_completed"));
    assert!(!grammar.contains("verified_failed"));
}

#[test]
fn explicit_insufficient_evidence_projects_empty_claims_without_approval() {
    let (sources, packet, _) = prepared();
    let projected = packet
        .expand(&prompt::empty_output(packet.decoder()))
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&projected).unwrap(),
        json!({"outcome":"insufficient_evidence","claims":[]})
    );
    assert!(sources
        .validate(&projected, &origin(), Scope::Sessions)
        .unwrap()
        .claims
        .is_empty());
}

#[test]
fn captured_snapshot_mutation_is_rejected_instead_of_rebinding() {
    let (_, mut packet, native) = prepared();
    let raw = compact(&packet, &native).to_string();
    packet.packet.original_spans[0]["text"] = json!("Changed retained snapshot");
    assert!(packet
        .expand(&raw)
        .unwrap_err()
        .contains("captured original packet changed"));
}

#[path = "compact_qa_rejection_tests.rs"]
mod rejection;
