//! Pure source/proposal binding tests; no semantic approval or model inference.

use super::*;
use crate::retrieval::Scope;
use crate::vault_session::AgentVaultSession;
use crate::wiki_claims::focus_claims_qa::PreparedFocusQa;
use crate::wiki_claims::{ActorRole, SourceDocument, SpanInput};

#[path = "focus_answer_qa_correction_tests.rs"]
mod correction;

const QUESTION: &str = "Summarize my synthetic activity.";
const FIRST: &str = "Please repair the synthetic fixture. I have not repaired it. The maintainer repaired the synthetic fixture on 2026-10-01. I plan to check the synthetic fixture.";
const SECOND: &str = "I finished drafting a repair plan. I cannot independently confirm the repair. The repair outcome is uncertain.";
const LATER: &str = "I reopened the synthetic fixture investigation.";
const PROOF_SPAN_FIELDS: [&str; 7] = [
    "sourceId",
    "sourcePath",
    "selectionPath",
    "sourceRevision",
    "start",
    "end",
    "sha256",
];

struct Fixture {
    range: DateRange,
    packet: SourceSet,
    extraction: Extraction,
}

fn origin() -> AgentVaultSession {
    AgentVaultSession {
        vault_path: "/synthetic/focus-answer".into(),
        opening_token: "synthetic-opening".into(),
    }
}

fn period() -> DateRange {
    DateRange {
        start: "2026-10-01".into(),
        end: "2026-10-04".into(),
        start_epoch: crate::importers::parse_iso8601("2026-09-30T15:00:00Z"),
        end_epoch: crate::importers::parse_iso8601("2026-10-04T15:00:00Z"),
    }
}

fn sources(first: &str, speaker: ActorRole, turn_time: &str, reversed: bool) -> SourceSet {
    let prefix = "선행 원문\n";
    let text = format!("{prefix}{first}\n{SECOND}");
    let second_start = prefix.len() + first.len() + 1;
    let mut inputs = vec![
        SpanInput {
            id: "Q-FIRST".into(),
            start: prefix.len(),
            end: prefix.len() + first.len(),
            turn_id: "T-FIRST".into(),
            speaker,
            turn_time: Some(turn_time.into()),
        },
        SpanInput {
            id: "Q-SECOND".into(),
            start: second_start,
            end: text.len(),
            turn_id: "T-SECOND".into(),
            speaker: ActorRole::Assistant,
            turn_time: Some("2026-10-04T08:00:00Z".into()),
        },
    ];
    if reversed {
        inputs.reverse();
    }
    let first_document = SourceDocument::bind(
        "S-FIRST".into(),
        "sessions/first.md".into(),
        "sessions/first.md".into(),
        &text,
        Some("2026-10-04T09:00:00Z".into()),
        inputs,
    )
    .unwrap()
    .with_turn_phases(&[
        ("T-FIRST".into(), Some("final".into())),
        ("T-SECOND".into(), Some("final".into())),
    ])
    .unwrap();
    let later_document = SourceDocument::bind(
        "S-LATER".into(),
        "sessions/later.md".into(),
        "sessions/later.md".into(),
        LATER,
        Some("2026-10-05T09:00:00Z".into()),
        vec![SpanInput {
            id: "Q-LATER".into(),
            start: 0,
            end: LATER.len(),
            turn_id: "T-LATER".into(),
            speaker: ActorRole::User,
            turn_time: Some("2026-10-05T08:00:00Z".into()),
        }],
    )
    .unwrap();
    SourceSet::new(
        origin(),
        Scope::All,
        vec![first_document, later_document],
        vec![],
    )
    .unwrap()
}

fn tuple(anchor: usize, quote: &str, kind: &str, speech: &str, status: &str) -> Value {
    json!([
        anchor,
        quote,
        kind,
        [anchor],
        [
            if anchor == 0 { "user" } else { "assistant" },
            "speaker",
            null
        ],
        [null, "unknown", "unknown", "unknown", null],
        speech,
        status,
        null
    ])
}

fn fixture() -> Fixture {
    let range = period();
    let packet = sources(FIRST, ActorRole::User, "2026-10-03T08:00:00Z", false);
    let spans = packet.spans().take(2).collect::<Vec<_>>();
    let user = super::super::claim_prompt::payload(QUESTION, "en", &range, &spans).unwrap();
    let prepared = PreparedFocusQa::prepare(&user).unwrap();
    let mut third_party = tuple(
        0,
        "The maintainer repaired the synthetic fixture on 2026-10-01.",
        "asserted_occurrence",
        "report",
        "reported_completed",
    );
    third_party[4] = json!(["source", "explicit_subject", 0]);
    third_party[5] = json!(["2026-10-01", "explicit", "day", "specified", 0]);
    let wire = json!({"version":"WikiSourceFocusClaimsQaV1",
        "packetSha256":prepared.decoder().packet_sha256(),"outcome":"claims","claims":[
        tuple(0,"Please repair the synthetic fixture.","intention","request","requested"),
        tuple(0,"I have not repaired it.","explicit_nonoccurrence","report","unknown"),
        third_party,
        tuple(0,"I plan to check the synthetic fixture.","intention","plan","planned"),
        tuple(1,"I finished drafting a repair plan.","asserted_occurrence","report","reported_completed"),
        tuple(1,"I cannot independently confirm the repair.","record_or_verification_limit","report","unknown"),
        tuple(1,"The repair outcome is uncertain.","uncertain","question","unknown")
    ]});
    let projection = prepared.expand(&wire.to_string()).unwrap();
    let mut claims = packet
        .validate(projection.canonical(), &origin(), Scope::All)
        .unwrap();
    let later = json!({"outcome":"claims","claims":[{
        "action":LATER,"anchorSpanId":"Q-LATER","supportSpanIds":["Q-LATER"],
        "actor":{"role":"user","basis":"speaker","subjectSpanId":null},
        "eventTime":{"value":null,"basis":"unknown","precision":"unknown","uncertainty":"unknown","supportSpanId":null},
        "speechAct":"report","status":"reported_completed","verificationId":null}]});
    claims.claims.extend(
        packet
            .validate(&later.to_string(), &origin(), Scope::All)
            .unwrap()
            .claims,
    );
    Fixture {
        range,
        packet,
        extraction: Extraction {
            claims,
            eligible_spans: 3,
            processed_spans: 3,
            omitted_spans: 0,
            batches: 2,
            processed_span_ids: vec!["Q-FIRST".into(), "Q-SECOND".into(), "Q-LATER".into()],
            reviews: vec![], // This fixture issues no production review receipt.
            focus_reviews: vec![],
            focus_claim_count: projection.proposal_count(),
            focus_projections: vec![projection],
            review_correction_used: false,
        },
    }
}

fn base(fixture: &Fixture, selected: &[&CheckedClaim]) -> Value {
    let closure = fixture.packet.spans().collect::<Vec<_>>();
    let mut pages = Vec::new();
    for span in &closure {
        if !pages.contains(&span.selection_path()) {
            pages.push(span.selection_path());
        }
    }
    json!({"question":QUESTION,"language":"en","activityPeriod":period_value(&fixture.range),
        "sources":pages.iter().enumerate().map(|(ordinal,page)|json!({
            "id":format!("S{}",ordinal+1),"path":page,"title":"Synthetic originals",
            "originalSpans":closure.iter().filter(|span|span.selection_path()==*page).collect::<Vec<_>>()
        })).collect::<Vec<_>>(),
        "allowed_source_ids":(1..=pages.len()).map(|ordinal|format!("S{ordinal}")).collect::<Vec<_>>(),
        "claimProposals":selected.iter().map(|claim|&claim.proposal).collect::<Vec<_>>(),
        "recordPeriodContext":period_context::annotate(&fixture.range,closure.iter().copied()).unwrap(),
        "currentStateIndependentlyVerified":false,"sourceAndStructureChecked":true,
        "semanticReviewRequired":true,"independentVerificationReceipts":[],
        "automatedClaimReviewInputRevisions":["11".repeat(32),"22".repeat(32)],
        "coverage":{"eligibleSpans":fixture.extraction.eligible_spans,
            "processedSpans":fixture.extraction.processed_spans,
            "omittedSpans":fixture.extraction.omitted_spans,
            "proposedClaims":fixture.extraction.claims.claims.len(),
            "selectedClaims":selected.len()},
        "resolutionWindow":null,"resolutionCoverage":null})
}

fn capture(fixture: &Fixture, ordinals: &[usize]) -> FocusAnswerQa {
    let selected = ordinals
        .iter()
        .map(|ordinal| &fixture.extraction.claims.claims[*ordinal])
        .collect::<Vec<_>>();
    FocusAnswerQa::capture(
        &base(fixture, &selected),
        QUESTION,
        "en",
        &fixture.range,
        &fixture.packet.spans().cloned().collect::<Vec<_>>(),
        &fixture.extraction,
        &selected,
    )
    .unwrap()
    .unwrap()
}

fn capture_result(fixture: &Fixture, payload: &Value) -> Result<Option<FocusAnswerQa>, String> {
    let selected = fixture.extraction.claims.claims.iter().collect::<Vec<_>>();
    FocusAnswerQa::capture(
        payload,
        QUESTION,
        "en",
        &fixture.range,
        &fixture.packet.spans().cloned().collect::<Vec<_>>(),
        &fixture.extraction,
        &selected,
    )
}

#[test]
fn slim_payload_preserves_every_native_field_and_all_declared_kinds() {
    let fixture = fixture();
    let captured = capture(&fixture, &[0, 1, 2, 3, 4, 5, 6, 7]);
    let mut expected_base = base(
        &fixture,
        &fixture.extraction.claims.claims.iter().collect::<Vec<_>>(),
    );
    let mut model = captured.model_payload().unwrap();
    let kinds = model["sourceFocusInterpretations"].as_array().unwrap();
    assert_eq!(kinds.len(), 7);
    for (ordinal, mapping) in kinds.iter().enumerate() {
        assert_eq!(mapping["selectedProposalOrdinal"], ordinal);
        assert_eq!(mapping.as_object().unwrap().len(), 2);
    }
    assert_eq!(kinds[1]["assertionKind"], "explicit_nonoccurrence");
    assert_eq!(kinds[2]["assertionKind"], "asserted_occurrence");
    assert_eq!(kinds[5]["assertionKind"], "record_or_verification_limit");
    assert_eq!(kinds[6]["assertionKind"], "uncertain");
    assert_eq!(model["claimProposals"][2]["actor"]["role"], "source");
    assert_eq!(
        model["claimProposals"][2]["eventTime"]["value"],
        "2026-10-01"
    );
    assert_eq!(model["claimProposals"][1]["status"], "unknown");
    assert_eq!(
        model["sourceFocusInterpretationRevision"],
        captured.revision()
    );
    assert!(!model
        .as_object()
        .unwrap()
        .contains_key("sourceFocusInterpretationRevisions"));
    assert!(!model
        .as_object()
        .unwrap()
        .contains_key("automatedClaimReviewInputRevisions"));
    expected_base
        .as_object_mut()
        .unwrap()
        .remove("automatedClaimReviewInputRevisions");
    for source in expected_base["sources"].as_array_mut().unwrap() {
        for original in source["originalSpans"].as_array_mut().unwrap() {
            for field in PROOF_SPAN_FIELDS {
                original.as_object_mut().unwrap().remove(field);
            }
        }
    }
    for key in &MODEL_FIELDS[..3] {
        model.as_object_mut().unwrap().remove(*key);
    }
    assert_eq!(model, expected_base);
    let rendered = captured.model_payload().unwrap().to_string();
    captured
        .verify_prompt(QUESTION, "en", &rendered, &fixture.packet)
        .unwrap();
    assert_eq!(captured.revision().len(), 64);
}

#[test]
fn full_private_witnesses_are_unchanged_and_later_claims_gain_no_kind() {
    let fixture = fixture();
    let captured = capture(&fixture, &[7, 2, 0]);
    let initial = fixture.extraction.claims.claims[..7]
        .iter()
        .map(|claim| &claim.proposal)
        .collect::<Vec<_>>();
    let original = fixture.extraction.focus_projections[0]
        .ordered_answer_witnesses(&initial)
        .unwrap();
    let mut second = original[2].clone();
    second["selectedProposalOrdinal"] = json!(1);
    let mut third = original[0].clone();
    third["selectedProposalOrdinal"] = json!(2);
    assert_eq!(captured.full_witnesses(), &[second, third]);
    let model = captured.model_payload().unwrap();
    assert_eq!(
        model["sourceFocusInterpretations"],
        json!([
        {"selectedProposalOrdinal":1,"assertionKind":"asserted_occurrence"},
        {"selectedProposalOrdinal":2,"assertionKind":"intention"}])
    );
    assert_eq!(model["claimProposals"][0]["anchorSpanId"], "Q-LATER");
    assert!(captured.full_witnesses()[0]["focusSha256"]
        .as_str()
        .is_some());
    assert!(captured.full_witnesses()[0]["start"].as_u64().unwrap() > "선행 원문\n".len() as u64);
}

#[test]
fn capture_rejects_equal_but_foreign_and_duplicate_selected_pointers() {
    let fixture = fixture();
    let original = &fixture.extraction.claims.claims[0];
    let foreign = original.clone();
    for selected in [vec![&foreign], vec![original, original]] {
        assert!(FocusAnswerQa::capture(
            &base(&fixture, &selected),
            QUESTION,
            "en",
            &fixture.range,
            &fixture.packet.spans().cloned().collect::<Vec<_>>(),
            &fixture.extraction,
            &selected
        )
        .is_err());
    }
}

#[test]
fn capture_rejects_changed_initial_count_proposal_order_and_native_flags() {
    for change in 0..4 {
        let mut fixture = fixture();
        match change {
            0 => fixture.extraction.focus_claim_count -= 1,
            1 => fixture.extraction.claims.claims.swap(0, 1),
            2 => fixture.extraction.claims.claims[0].structure_checked = false,
            _ => fixture.extraction.claims.claims[0].semantic_review_required = false,
        }
        let selected = fixture.extraction.claims.claims.iter().collect::<Vec<_>>();
        assert!(capture_result(&fixture, &base(&fixture, &selected)).is_err());
    }
}

#[test]
fn capture_rejects_source_body_metadata_missing_duplicate_and_order_changes() {
    let fixture = fixture();
    let original = base(
        &fixture,
        &fixture.extraction.claims.claims.iter().collect::<Vec<_>>(),
    );
    for field in [
        "text",
        "speaker",
        "turnTime",
        "recordTime",
        "sourceRevision",
        "sourcePhase",
        "id",
    ] {
        let mut changed = original.clone();
        changed["sources"][0]["originalSpans"][0][field] = json!("changed");
        assert!(capture_result(&fixture, &changed).is_err(), "{field}");
    }
    for change in 0..5 {
        let mut changed = original.clone();
        match change {
            0 => {
                changed["sources"][0]["originalSpans"]
                    .as_array_mut()
                    .unwrap()
                    .remove(0);
            }
            1 => {
                let duplicate = changed["sources"][0]["originalSpans"][0].clone();
                changed["sources"][0]["originalSpans"]
                    .as_array_mut()
                    .unwrap()
                    .push(duplicate);
            }
            2 => changed["sources"][0]["originalSpans"]
                .as_array_mut()
                .unwrap()
                .reverse(),
            3 => changed["sources"][0]["path"] = json!("sessions/foreign.md"),
            _ => {
                let duplicate = changed["sources"][0].clone();
                changed["sources"].as_array_mut().unwrap().push(duplicate);
            }
        }
        assert!(
            capture_result(&fixture, &changed).is_err(),
            "source change {change}"
        );
    }
}

#[test]
fn capture_rejects_changed_typed_proposals_context_and_preexisting_sidecars() {
    let fixture = fixture();
    let original = base(
        &fixture,
        &fixture.extraction.claims.claims.iter().collect::<Vec<_>>(),
    );
    for field in [
        "action",
        "actor",
        "eventTime",
        "status",
        "speechAct",
        "supportSpanIds",
        "verificationId",
    ] {
        let mut changed = original.clone();
        changed["claimProposals"][0][field] = json!("changed");
        assert!(capture_result(&fixture, &changed).is_err(), "{field}");
    }
    for change in 0..8 {
        let mut changed = original.clone();
        match change {
            0 => changed["question"] = json!("Different question"),
            1 => changed["language"] = json!("ko"),
            2 => changed["activityPeriod"]["endEpoch"] = json!(1),
            3 => changed["recordPeriodContext"]["counts"]["inPeriodSpans"] = json!(999),
            4 => changed["claimProposals"].as_array_mut().unwrap().reverse(),
            5 => {
                changed["claimProposals"].as_array_mut().unwrap().pop();
            }
            6 => changed["sources"] = Value::Null,
            _ => changed["sourceFocusInterpretationRevision"] = json!("forged"),
        }
        assert!(
            capture_result(&fixture, &changed).is_err(),
            "context change {change}"
        );
    }
}

#[test]
fn verify_rejects_modified_missing_duplicate_or_reordered_model_mapping() {
    let fixture = fixture();
    let captured = capture(&fixture, &[0, 1, 2, 3, 4, 5, 6, 7]);
    for change in 0..10 {
        let mut changed = captured.model_payload().unwrap();
        match change {
            0 => changed["sourceFocusInterpretations"]
                .as_array_mut()
                .unwrap()
                .reverse(),
            1 => {
                changed["sourceFocusInterpretations"]
                    .as_array_mut()
                    .unwrap()
                    .pop();
            }
            2 => {
                let duplicate = changed["sourceFocusInterpretations"][0].clone();
                changed["sourceFocusInterpretations"]
                    .as_array_mut()
                    .unwrap()
                    .push(duplicate);
            }
            3 => changed["sourceFocusInterpretations"][0]["selectedProposalOrdinal"] = json!(7),
            4 => {
                changed["sourceFocusInterpretations"][0]["assertionKind"] =
                    json!("asserted_occurrence")
            }
            5 => changed["sourceFocusInterpretationRevision"] = json!("0".repeat(64)),
            6 => {
                changed
                    .as_object_mut()
                    .unwrap()
                    .remove("sourceFocusRepresentation");
            }
            7 => changed["claimProposals"][0]["actor"]["role"] = json!("assistant"),
            8 => changed["sources"][0]["originalSpans"][0]["text"] = json!("replaced source"),
            _ => changed["activityPeriod"]["start"] = json!("2026-10-02"),
        }
        assert!(
            captured
                .verify_prompt(QUESTION, "en", &changed.to_string(), &fixture.packet)
                .is_err(),
            "mapping change {change}"
        );
    }
    assert!(captured
        .verify_prompt(QUESTION, "en", "{", &fixture.packet)
        .is_err());
    assert!(captured
        .verify_prompt(
            "Different question",
            "en",
            &captured.model_payload().unwrap().to_string(),
            &fixture.packet
        )
        .is_err());
    assert!(captured
        .verify_prompt(
            QUESTION,
            "ko",
            &captured.model_payload().unwrap().to_string(),
            &fixture.packet
        )
        .is_err());
}

#[test]
fn verify_rejects_current_original_body_speaker_time_and_global_order_changes() {
    let fixture = fixture();
    let captured = capture(&fixture, &[0, 1, 2]);
    let rendered = captured.model_payload().unwrap().to_string();
    for changed in [
        sources(
            &format!("{FIRST} Added bytes."),
            ActorRole::User,
            "2026-10-03T08:00:00Z",
            false,
        ),
        sources(FIRST, ActorRole::Assistant, "2026-10-03T08:00:00Z", false),
        sources(FIRST, ActorRole::User, "2026-10-03T09:00:00Z", false),
        sources(FIRST, ActorRole::User, "2026-10-03T08:00:00Z", true),
    ] {
        assert!(captured
            .verify_prompt(QUESTION, "en", &rendered, &changed)
            .is_err());
    }
    let missing = fixture
        .packet
        .retained(|span| span.id() != "Q-LATER")
        .unwrap();
    assert!(captured
        .verify_prompt(QUESTION, "en", &rendered, &missing)
        .is_err());
}

#[test]
fn capture_rejects_missing_duplicate_or_reordered_full_original_closure() {
    let fixture = fixture();
    let selected = fixture.extraction.claims.claims.iter().collect::<Vec<_>>();
    let payload = base(&fixture, &selected);
    let original = fixture.packet.spans().cloned().collect::<Vec<_>>();
    for change in 0..3 {
        let mut closure = original.clone();
        match change {
            0 => {
                closure.pop();
            }
            1 => closure.push(closure[0].clone()),
            _ => closure.swap(0, 1),
        }
        assert!(FocusAnswerQa::capture(
            &payload,
            QUESTION,
            "en",
            &fixture.range,
            &closure,
            &fixture.extraction,
            &selected
        )
        .is_err());
    }
}

#[test]
fn false_meaning_that_passes_shape_is_preserved_as_unapproved_without_repair() {
    let mut fixture = fixture();
    let original = fixture.packet.spans().take(2).collect::<Vec<_>>();
    let prepared = PreparedFocusQa::prepare(
        &super::super::claim_prompt::payload(QUESTION, "en", &fixture.range, &original).unwrap(),
    )
    .unwrap();
    // A real exact negative quotation is deliberately given a false positive
    // meaning. This boundary must not guess, correct or approve that meaning.
    let projection=prepared.expand(&json!({"version":"WikiSourceFocusClaimsQaV1",
        "packetSha256":prepared.decoder().packet_sha256(),"outcome":"claims","claims":[
        tuple(0,"I have not repaired it.","asserted_occurrence","report","reported_completed")]
    }).to_string()).unwrap();
    assert_eq!(
        serde_json::to_value(&projection).unwrap()["semanticAccepted"],
        false
    );
    fixture.extraction.claims = fixture
        .packet
        .validate(projection.canonical(), &origin(), Scope::All)
        .unwrap();
    fixture.extraction.focus_claim_count = 1;
    fixture.extraction.focus_projections = vec![projection];
    let captured = capture(&fixture, &[0]);
    let payload = captured.model_payload().unwrap();
    assert_eq!(
        payload["claimProposals"][0]["action"],
        "I have not repaired it."
    );
    assert_eq!(payload["claimProposals"][0]["status"], "reported_completed");
    assert_eq!(
        payload["sourceFocusInterpretations"][0]["assertionKind"],
        "asserted_occurrence"
    );
    assert_eq!(payload["semanticReviewRequired"], true);
    assert_eq!(payload["currentStateIndependentlyVerified"], false);
    captured
        .verify_prompt(QUESTION, "en", &payload.to_string(), &fixture.packet)
        .unwrap();
}

#[test]
fn private_witness_proposal_and_revision_mutations_fail_without_repair() {
    let fixture = fixture();
    let captured = capture(&fixture, &[0, 1, 2]);
    for change in 0..7 {
        let mut changed = captured.clone();
        match change {
            0 => changed.full_witnesses[0]["start"] = json!(0),
            1 => changed.full_witnesses[0]["focusSha256"] = json!("0".repeat(64)),
            2 => changed.full_witnesses[0]["assertionKind"] = json!("asserted_occurrence"),
            3 => changed.selected_ordinals.reverse(),
            4 => changed.claims[0].proposal.action = "Changed claim".into(),
            5 => changed.revision = "0".repeat(64),
            _ => changed.projections.clear(),
        }
        assert!(changed.model_payload().is_err(), "private change {change}");
    }
}

#[test]
fn exact_rendering_rejects_duplicate_json_members_and_revision_is_deterministic() {
    let fixture = fixture();
    let first = capture(&fixture, &[0, 1]);
    let second = capture(&fixture, &[0, 1]);
    assert_eq!(first.revision(), second.revision());
    assert_ne!(first.revision(), capture(&fixture, &[1, 0]).revision());
    let rendered = first.model_payload().unwrap().to_string();
    let duplicate = format!("{{\"question\":{},{}", json!(QUESTION), &rendered[1..]);
    assert_eq!(
        serde_json::from_str::<Value>(&duplicate).unwrap(),
        first.model_payload().unwrap()
    );
    assert!(first
        .verify_prompt(QUESTION, "en", &duplicate, &fixture.packet)
        .is_err());
}

#[test]
fn empty_initial_focus_has_private_binding_but_no_fabricated_later_kind() {
    let mut fixture = fixture();
    let initial = fixture.packet.spans().take(2).collect::<Vec<_>>();
    let prepared = PreparedFocusQa::prepare(
        &super::super::claim_prompt::payload(QUESTION, "en", &fixture.range, &initial).unwrap(),
    )
    .unwrap();
    let projection=prepared.expand(&json!({"version":"WikiSourceFocusClaimsQaV1", "packetSha256":prepared.decoder().packet_sha256(),"outcome":"insufficient_evidence","claims":[]}).to_string()).unwrap();
    fixture.extraction.claims.claims = vec![fixture.extraction.claims.claims[7].clone()];
    fixture.extraction.focus_claim_count = 0;
    fixture.extraction.focus_projections = vec![projection];
    let captured = capture(&fixture, &[0]);
    assert!(captured.full_witnesses().is_empty());
    assert_eq!(
        captured.model_payload().unwrap()["sourceFocusInterpretations"],
        json!([])
    );
    let rendered = captured.model_payload().unwrap().to_string();
    captured
        .verify_prompt(QUESTION, "en", &rendered, &fixture.packet)
        .unwrap();
    fixture.extraction.focus_projections.clear();
    let selected = fixture.extraction.claims.claims.iter().collect::<Vec<_>>();
    assert!(capture_result(&fixture, &base(&fixture, &selected))
        .unwrap()
        .is_none());
    fixture.extraction.focus_claim_count = 1;
    let selected = fixture.extraction.claims.claims.iter().collect::<Vec<_>>();
    assert!(capture_result(&fixture, &base(&fixture, &selected)).is_err());
}

#[test]
fn interleaved_full_closure_keeps_page_grouping_and_global_native_order() {
    fn document(
        id: &str,
        path: &str,
        text: &str,
        start: usize,
        end: usize,
        span: &str,
    ) -> SourceDocument {
        SourceDocument::bind(
            id.into(),
            path.into(),
            path.into(),
            text,
            Some("2026-10-04".into()),
            vec![SpanInput {
                id: span.into(),
                start,
                end,
                turn_id: format!("T-{span}"),
                speaker: ActorRole::User,
                turn_time: Some("2026-10-03T08:00:00Z".into()),
            }],
        )
        .unwrap()
    }
    let a = "Please repair A. I reopened A.";
    let split = a.find("I reopened").unwrap();
    let b = "I cancelled B.";
    let documents = vec![
        document("S-A1", "sessions/a.md", a, 0, split, "Q-A1"),
        document("S-B", "sessions/b.md", b, 0, b.len(), "Q-B"),
        document("S-A2", "sessions/a.md", a, split, a.len(), "Q-A2"),
    ];
    let packet = SourceSet::new(origin(), Scope::All, documents.clone(), vec![]).unwrap();
    let range = period();
    let originals = packet.spans().collect::<Vec<_>>();
    let prepared = PreparedFocusQa::prepare(
        &super::super::claim_prompt::payload(QUESTION, "en", &range, &originals[..1]).unwrap(),
    )
    .unwrap();
    let projection=prepared.expand(&json!({"version":"WikiSourceFocusClaimsQaV1","packetSha256":prepared.decoder().packet_sha256(),"outcome":"claims","claims":[tuple(0,"Please repair A.","intention","request","requested")]}).to_string()).unwrap();
    let claims = packet
        .validate(projection.canonical(), &origin(), Scope::All)
        .unwrap();
    let fixture = Fixture {
        range,
        packet,
        extraction: Extraction {
            claims,
            eligible_spans: 3,
            processed_spans: 1,
            omitted_spans: 2,
            batches: 1,
            processed_span_ids: vec!["Q-A1".into()],
            reviews: vec![],
            focus_reviews: vec![],
            focus_claim_count: 1,
            focus_projections: vec![projection],
            review_correction_used: false,
        },
    };
    let captured = capture(&fixture, &[0]);
    let model = captured.model_payload().unwrap();
    assert_eq!(model["sources"][0]["originalSpans"][0]["id"], "Q-A1");
    assert_eq!(model["sources"][0]["originalSpans"][1]["id"], "Q-A2");
    assert_eq!(model["sources"][1]["originalSpans"][0]["id"], "Q-B");
    let global = captured.model_original_spans().unwrap();
    assert_eq!(
        global
            .iter()
            .map(|span| span["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["Q-A1", "Q-B", "Q-A2"]
    );
    captured
        .verify_prompt(QUESTION, "en", &model.to_string(), &fixture.packet)
        .unwrap();
    let reordered = SourceSet::new(
        origin(),
        Scope::All,
        vec![
            documents[0].clone(),
            documents[2].clone(),
            documents[1].clone(),
        ],
        vec![],
    )
    .unwrap();
    assert!(captured
        .verify_prompt(QUESTION, "en", &model.to_string(), &reordered)
        .is_err());
}

#[cfg(test)]
#[path = "focus_answer_metadata_tests.rs"]
mod metadata;
