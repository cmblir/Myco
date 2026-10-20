use super::*;
use crate::wiki_claims::{self, AppVerifiedFact, ClaimStatus, SourceDocument, SpanInput};
use serde_json::{json, Value};

#[test]
fn quoted_schema_requires_explicit_nullable_fields_including_nested_objects() {
    let set = evidence("I have not deployed the synthetic adapter.");
    for (object, key) in [
        ("claim", "verificationId"),
        ("actor", "subjectSpanId"),
        ("eventTime", "value"),
        ("eventTime", "supportSpanId"),
    ] {
        let mut claim = proposal("I have not deployed the synthetic adapter.");
        if object == "claim" {
            claim.as_object_mut().unwrap().remove(key);
        } else {
            claim[object].as_object_mut().unwrap().remove(key);
        }
        assert!(
            validate(&set, batch(vec![claim])).is_err(),
            "missing {object}.{key} was admitted"
        );
    }
}

fn origin() -> AgentVaultSession {
    AgentVaultSession {
        vault_path: "/synthetic/quotation-qa".into(),
        opening_token: "quotation-opening".into(),
    }
}

fn source(text: &str, start: usize, end: usize, id: &str) -> SourceDocument {
    SourceDocument::bind(
        format!("S-{id}"),
        format!("sessions/{id}.md"),
        format!("sessions/{id}.md"),
        text,
        Some("2024-06-15T12:00:00Z".into()),
        vec![SpanInput {
            id: id.into(),
            start,
            end,
            turn_id: format!("T-{id}"),
            speaker: ActorRole::User,
            turn_time: Some("2024-06-14T09:00:00Z".into()),
        }],
    )
    .unwrap()
}

fn evidence(text: &str) -> SourceSet {
    SourceSet::new(
        origin(),
        Scope::Sessions,
        vec![source(text, 0, text.len(), "Q1")],
        vec![],
    )
    .unwrap()
}

fn proposal(quote: &str) -> Value {
    json!({"quote":quote,"anchorSpanId":"Q1","supportSpanIds":["Q1"],
        "actor":{"role":"user","basis":"speaker","subjectSpanId":null},
        "eventTime":{"value":null,"basis":"unknown","precision":"unknown",
            "uncertainty":"unknown","supportSpanId":null},
        "speechAct":"report","status":"reported_completed","verificationId":null})
}

fn batch(claims: Vec<Value>) -> Value {
    json!({"version":"WikiQuotedClaimsQaV1","outcome":"claims","claims":claims})
}

fn validate(set: &SourceSet, value: Value) -> Result<CheckedQuotedClaimsQa, String> {
    validate_quoted_qa(set, &value.to_string(), &origin(), Scope::Sessions)
}

fn reject(set: &SourceSet, value: Value, expected: &str) {
    let error = validate(set, value).unwrap_err();
    assert!(
        error.contains(expected),
        "expected {expected:?}, got {error:?}"
    );
}

#[test]
fn unique_unicode_quote_issues_absolute_bytes_and_original_metadata() {
    let prefix = "기록 머리말\n";
    let text = "I saved the 자료 🧵. Nothing was published.";
    let original = format!("{prefix}{text}\nfooter");
    let set = SourceSet::new(
        origin(),
        Scope::Sessions,
        vec![source(
            &original,
            prefix.len(),
            prefix.len() + text.len(),
            "Q1",
        )],
        vec![],
    )
    .unwrap();
    let quote = "자료 🧵";
    let checked = validate(&set, batch(vec![proposal(quote)])).unwrap();
    let bound = &checked.quotes[0];
    let relative = text.find(quote).unwrap();
    assert_eq!(checked.claims.claims[0].proposal.action, quote);
    assert_eq!(bound.quote, quote);
    assert_eq!(
        (bound.start, bound.end),
        (
            prefix.len() + relative,
            prefix.len() + relative + quote.len()
        )
    );
    assert_eq!(
        (bound.span_start, bound.span_end),
        (prefix.len(), prefix.len() + text.len())
    );
    assert_eq!(&original[bound.start..bound.end], quote);
    assert_eq!(bound.sha256, wiki_claims::sha256(quote.as_bytes()));
    assert_eq!(bound.span_sha256, wiki_claims::sha256(text.as_bytes()));
    assert_eq!(
        bound.source_revision,
        wiki_claims::sha256(original.as_bytes())
    );
    assert_eq!(bound.anchor_span_id, "Q1");
    assert_eq!(bound.source_id, "S-Q1");
    assert_eq!(bound.source_path, "sessions/Q1.md");
    assert_eq!(bound.selection_path, "sessions/Q1.md");
    assert_eq!(bound.turn_id, "T-Q1");
    assert_eq!(bound.speaker, ActorRole::User);
    assert_eq!(bound.record_time.as_deref(), Some("2024-06-15T12:00:00Z"));
    assert_eq!(bound.turn_time.as_deref(), Some("2024-06-14T09:00:00Z"));
    assert!(bound.source_phase.is_none());
    assert!(bound.quote_bound && bound.semantic_review_required);
    assert!(checked.claims.claims[0].structure_checked);
    assert!(checked.claims.claims[0].semantic_review_required);
}

#[test]
fn preserves_decoded_json_quotes_newlines_and_whitespace_exactly() {
    let text = "I saved \"draft\".\n  No release.  ";
    let checked = validate(&evidence(text), batch(vec![proposal(text)])).unwrap();
    assert_eq!(checked.claims.claims[0].proposal.action, text);
    assert_eq!(checked.quotes[0].quote, text);
    assert_eq!(
        (checked.quotes[0].start, checked.quotes[0].end),
        (0, text.len())
    );
}

#[test]
fn refuses_empty_and_whitespace_only_quotes() {
    let set = evidence("Activity. \t\n");
    for quote in ["", " ", "\t\n"] {
        reject(&set, batch(vec![proposal(quote)]), "quote bounds");
    }
}

#[test]
fn refuses_unmatched_and_unicode_normalized_quotes() {
    let set = evidence("I saved cafe\u{301} notes.");
    for quote in ["absent activity", "café"] {
        reject(&set, batch(vec![proposal(quote)]), "exactly once");
    }
}

#[test]
fn refuses_nonoverlapping_duplicate_quotes() {
    reject(
        &evidence("saved and saved"),
        batch(vec![proposal("saved")]),
        "exactly once",
    );
}

#[test]
fn refuses_overlapping_duplicate_quotes() {
    for (text, quote) in [("aaa", "aa"), ("가가가", "가가")] {
        reject(
            &evidence(text),
            batch(vec![proposal(quote)]),
            "exactly once",
        );
    }
}

#[test]
fn scalar_limit_accepts_512_multibyte_scalars() {
    let text = "가".repeat(512);
    let checked = validate(&evidence(&text), batch(vec![proposal(&text)])).unwrap();
    assert_eq!(checked.quotes[0].quote.chars().count(), 512);
    assert_eq!(checked.quotes[0].end, text.len());
}

#[test]
fn scalar_limit_rejects_513_scalars() {
    let text = "가".repeat(513);
    reject(
        &evidence(&text),
        batch(vec![proposal(&text)]),
        "quote bounds",
    );
}

#[test]
fn returns_one_quote_per_claim_in_original_proposal_order() {
    let text = "I saved a sketch. I cancelled the exhibition.";
    let mut second = proposal("I cancelled the exhibition.");
    second["status"] = json!("reported_cancelled");
    let checked = validate(
        &evidence(text),
        batch(vec![second, proposal("I saved a sketch.")]),
    )
    .unwrap();
    assert_eq!(checked.quotes.len(), 2);
    assert_eq!(checked.claims.claims.len(), 2);
    for (bound, claim) in checked.quotes.iter().zip(&checked.claims.claims) {
        assert_eq!(bound.quote, claim.proposal.action);
        assert_eq!(bound.anchor_span_id, claim.proposal.anchor_span_id);
    }
    assert!(checked.quotes[0].start > checked.quotes[1].start);
}

#[test]
fn same_text_in_distinct_anchors_is_bound_by_anchor_identity() {
    let text = "I saved a sketch.";
    let set = SourceSet::new(
        origin(),
        Scope::Sessions,
        vec![
            source(text, 0, text.len(), "Q1"),
            source(text, 0, text.len(), "Q2"),
        ],
        vec![],
    )
    .unwrap();
    let mut second = proposal(text);
    second["anchorSpanId"] = json!("Q2");
    second["supportSpanIds"] = json!(["Q2"]);
    let checked = validate(&set, batch(vec![proposal(text), second])).unwrap();
    assert_eq!(checked.quotes[0].source_id, "S-Q1");
    assert_eq!(checked.quotes[1].source_id, "S-Q2");
}

#[test]
fn quote_must_match_anchor_not_only_another_support() {
    let one = "I saved a sketch.";
    let two = "I cancelled the exhibition.";
    let set = SourceSet::new(
        origin(),
        Scope::Sessions,
        vec![
            source(one, 0, one.len(), "Q1"),
            source(two, 0, two.len(), "Q2"),
        ],
        vec![],
    )
    .unwrap();
    let mut value = proposal(two);
    value["supportSpanIds"] = json!(["Q1", "Q2"]);
    reject(&set, batch(vec![value]), "exactly once");
}

#[test]
fn rejects_changed_opening_vault_and_current_scope() {
    let text = "I saved a sketch.";
    let set = evidence(text);
    let output = batch(vec![proposal(text)]).to_string();
    for changed in [
        AgentVaultSession {
            opening_token: "other-opening".into(),
            ..origin()
        },
        AgentVaultSession {
            vault_path: "/synthetic/other".into(),
            ..origin()
        },
    ] {
        assert!(validate_quoted_qa(&set, &output, &changed, Scope::Sessions)
            .unwrap_err()
            .contains("different vault opening or scope"));
    }
    assert!(validate_quoted_qa(&set, &output, &origin(), Scope::Wiki)
        .unwrap_err()
        .contains("different vault opening or scope"));
}

#[test]
fn rejects_foreign_anchor_support_and_subject_ids() {
    let text = "I saved a sketch.";
    let set = evidence(text);
    let mut anchor = proposal(text);
    anchor["anchorSpanId"] = json!("FOREIGN");
    reject(&set, batch(vec![anchor]), "anchor");
    let mut support = proposal(text);
    support["supportSpanIds"] = json!(["Q1", "FOREIGN"]);
    reject(&set, batch(vec![support]), "unselected original span");
    let mut subject = proposal(text);
    subject["actor"] =
        json!({"role":"source","basis":"explicit_subject","subjectSpanId":"FOREIGN"});
    reject(&set, batch(vec![subject]), "subject span");
}

#[test]
fn rejects_unknown_fields_including_model_owned_provenance_and_action() {
    let text = "I saved a sketch.";
    let set = evidence(text);
    let mut outer = batch(vec![proposal(text)]);
    outer["gold"] = json!("not admitted");
    reject(&set, outer, "invalid quoted claim JSON");
    for field in [
        "action",
        "start",
        "end",
        "sha256",
        "sourceRevision",
        "quoteBound",
    ] {
        let mut claim = proposal(text);
        claim[field] = json!("model-owned");
        reject(&set, batch(vec![claim]), "invalid quoted claim JSON");
    }
    for field in ["actor", "eventTime"] {
        let mut claim = proposal(text);
        claim[field]["extra"] = json!(true);
        reject(&set, batch(vec![claim]), "invalid quoted claim JSON");
    }
}

#[test]
fn rejects_missing_or_wrong_version() {
    let text = "I saved a sketch.";
    let set = evidence(text);
    let mut missing = batch(vec![proposal(text)]);
    missing.as_object_mut().unwrap().remove("version");
    reject(&set, missing, "invalid quoted claim JSON");
    let mut wrong = batch(vec![proposal(text)]);
    wrong["version"] = json!("WikiClaimsV1");
    reject(&set, wrong, "quoted claim version");
}

#[test]
fn rejects_verified_even_with_valid_app_receipt_and_any_nonnull_verification_id() {
    let text = "I saved a sketch.";
    let set = SourceSet::new(
        origin(),
        Scope::Sessions,
        vec![source(text, 0, text.len(), "Q1")],
        vec![AppVerifiedFact {
            id: "V1".into(),
            canonical_statement: text.into(),
            status: ClaimStatus::VerifiedCompleted,
            support_span_ids: vec!["Q1".into()],
        }],
    )
    .unwrap();
    for status in ["verified_completed", "verified_failed"] {
        let mut value = proposal(text);
        value["speechAct"] = json!("verification");
        value["status"] = json!(status);
        value["verificationId"] = json!("V1");
        reject(&set, batch(vec![value]), "QA verification");
    }
    let mut nonnull = proposal(text);
    nonnull["verificationId"] = json!("V1");
    reject(&set, batch(vec![nonnull]), "QA verification");
}

#[test]
fn insufficient_evidence_is_empty_and_origin_checked() {
    let set = evidence("No relevant activity.");
    let value =
        json!({"version":"WikiQuotedClaimsQaV1","outcome":"insufficient_evidence","claims":[]});
    let checked = validate(&set, value.clone()).unwrap();
    assert!(checked.quotes.is_empty() && checked.claims.claims.is_empty());
    assert_eq!(
        checked.claims.outcome,
        wiki_claims::ClaimOutcome::InsufficientEvidence
    );
    assert!(validate_quoted_qa(
        &set,
        &value.to_string(),
        &AgentVaultSession {
            opening_token: "changed".into(),
            ..origin()
        },
        Scope::Sessions
    )
    .unwrap_err()
    .contains("different vault opening or scope"));
}

#[test]
fn delegates_existing_outcome_support_actor_time_and_status_rules() {
    let text = "I saved a sketch.";
    let set = evidence(text);
    let mut empty = batch(vec![]);
    reject(&set, empty.clone(), "outcome and claim count");
    empty["outcome"] = json!("insufficient_evidence");
    empty["claims"] = json!([proposal(text)]);
    reject(&set, empty, "outcome and claim count");
    reject(
        &set,
        batch(vec![proposal(text); 17]),
        "outcome and claim count",
    );
    let mut duplicates = proposal(text);
    duplicates["supportSpanIds"] = json!(["Q1", "Q1"]);
    reject(&set, batch(vec![duplicates]), "support span bounds");
    let mut speaker = proposal(text);
    speaker["actor"]["role"] = json!("assistant");
    reject(&set, batch(vec![speaker]), "speaker");
    let mut date = proposal(text);
    date["eventTime"] = json!({"value":"2024-06-13","basis":"explicit","precision":"day","uncertainty":"specified","supportSpanId":"Q1"});
    reject(&set, batch(vec![date]), "explicit date is absent");
    let mut status = proposal(text);
    status["speechAct"] = json!("request");
    reject(&set, batch(vec![status]), "speech act and status");
}

#[test]
fn source_actor_and_unknown_event_date_preserve_typed_proposal_and_original() {
    let text = "The curator saved the sketch because the frame was fragile.";
    let mut value = proposal(text);
    value["actor"] = json!({"role":"source","basis":"explicit_subject","subjectSpanId":"Q1"});
    let checked = validate(&evidence(text), batch(vec![value])).unwrap();
    let claim = &checked.claims.claims[0];
    assert_eq!(claim.proposal.actor.role, ActorRole::Source);
    assert_eq!(
        claim.proposal.actor.basis,
        wiki_claims::ActorBasis::ExplicitSubject
    );
    assert!(claim.proposal.event_time.value.is_none());
    assert!(claim
        .proposal
        .action
        .contains("because the frame was fragile"));
    assert_eq!(claim.provenance[0].text(), text);
    assert!(claim.semantic_review_required);
}

#[test]
fn wrong_explicit_actor_can_be_shape_legal_but_never_semantically_accepted() {
    let text = "I saved a sketch.";
    let mut value = proposal(text);
    value["actor"] = json!({"role":"assistant","basis":"explicit_subject","subjectSpanId":"Q1"});
    let checked = validate(&evidence(text), batch(vec![value])).unwrap();
    assert_eq!(
        checked.claims.claims[0].proposal.actor.role,
        ActorRole::Assistant
    );
    assert_eq!(checked.quotes[0].speaker, ActorRole::User);
    assert!(checked.claims.claims[0].semantic_review_required);
}

#[test]
fn unanchored_message_date_can_be_shape_legal_but_requires_whole_original_review() {
    let text = "I saved a sketch.";
    let mut value = proposal(text);
    value["eventTime"] = json!({"value":"2024-06-14","basis":"inferred_from_turn","precision":"day","uncertainty":"inferred","supportSpanId":"Q1"});
    let checked = validate(&evidence(text), batch(vec![value])).unwrap();
    assert_eq!(
        checked.claims.claims[0]
            .proposal
            .event_time
            .value
            .as_deref(),
        Some("2024-06-14")
    );
    assert!(checked.claims.claims[0].semantic_review_required);
}

#[test]
fn mistagged_request_and_partial_negative_quote_remain_only_proposals() {
    for (text, quote) in [
        ("Please save a sketch.", "Please save a sketch."),
        ("I have not completed the sketch.", "completed the sketch"),
    ] {
        let checked = validate(&evidence(text), batch(vec![proposal(quote)])).unwrap();
        assert_eq!(
            checked.claims.claims[0].proposal.status,
            ClaimStatus::ReportedCompleted
        );
        assert_eq!(checked.claims.claims[0].provenance[0].text(), text);
        assert!(checked.quotes[0].quote_bound && checked.quotes[0].semantic_review_required);
        assert!(checked.claims.claims[0].semantic_review_required);
    }
}

#[test]
fn qa_grammar_keeps_v1_couplings_and_quote_first_without_verified_branch() {
    validate(
        &evidence("I saved a sketch."),
        batch(vec![proposal("I saved a sketch.")]),
    )
    .unwrap();
    for rule in [
        "actor",
        "role",
        "known-role",
        "time",
        "day-value",
        "instant-value",
        "day-basis",
        "instant-basis",
        "inferred-basis",
        "speech-status",
        "unknown-status",
        "request-status",
        "plan-status",
        "report-status",
        "retraction-status",
        "unverified",
        "id",
        "char",
        "ws",
    ] {
        let prefix = format!("{rule} ::=");
        let old = wiki_claims::WIKI_CLAIMS_JSON_GRAMMAR
            .lines()
            .find(|line| line.starts_with(&prefix))
            .unwrap();
        let new = QUOTED_CLAIMS_QA_JSON_GRAMMAR
            .lines()
            .find(|line| line.starts_with(&prefix))
            .unwrap();
        assert_eq!(new, old);
    }
    assert!(QUOTED_CLAIMS_QA_JSON_GRAMMAR.contains("claim ::= \"{\\\"quote\\\":"));
    assert!(QUOTED_CLAIMS_QA_JSON_GRAMMAR.contains("WikiQuotedClaimsQaV1"));
    assert!(!QUOTED_CLAIMS_QA_JSON_GRAMMAR.contains("verified_completed"));
    assert!(!QUOTED_CLAIMS_QA_JSON_GRAMMAR.contains("verified_failed"));
    assert!(QUOTED_CLAIMS_QA_JSON_GRAMMAR.contains("char{1,512}"));
    assert!(QUOTED_CLAIMS_QA_SYSTEM.contains("whole original packet"));
    assert!(QUOTED_CLAIMS_QA_SYSTEM.contains("semantic acceptance"));
}

#[test]
fn pure_binder_preserves_all_original_turns_bytes_times_and_phase() {
    let first = format!(
        "Please file the cafe\u{301} catalogue.\n\n{}",
        "Synthetic detail. ".repeat(600)
    );
    let second = "I prepared a draft. Its independent review is unknown.";
    let original = format!("---\ncreated: 2024-06-15\nturn_metadata: [{{message_id: 'user-a', original_role: user, timestamp: '2024-06-14T09:00:00Z'}}, {{message_id: 'assistant-b', original_role: assistant, timestamp: '2024-06-14T10:00:00Z', phase: analysis}}]\n---\n\n**User:**\n\n{first}\n\n**Assistant:**\n\n{second}\n");
    assert!(crate::embeddings::chunk_page(&original).len() > 2);
    let document = bind_qa_original("sessions/parser-qa.md", &original).unwrap();
    let set = SourceSet::new(origin(), Scope::Sessions, vec![document], vec![]).unwrap();
    let spans: Vec<_> = set.spans().collect();
    assert_eq!(spans.len(), 2);
    assert_eq!(spans[0].speaker(), ActorRole::User);
    assert_eq!(spans[1].speaker(), ActorRole::Assistant);
    assert_eq!(spans[0].turn_time(), Some("2024-06-14T09:00:00Z"));
    assert_eq!(spans[1].turn_time(), Some("2024-06-14T10:00:00Z"));
    assert!(spans[0].text().contains("cafe\u{301}"));
    assert!(!spans[0].text().contains("café"));
    assert!(spans[0].text().contains(&first));
    assert!(spans[1].text().contains(second));
    for span in &spans {
        assert_eq!(original.get(span.start..span.end), Some(span.text()));
        assert_eq!(span.sha256, wiki_claims::sha256(span.text().as_bytes()));
        assert_eq!(
            span.source_revision(),
            wiki_claims::sha256(original.as_bytes())
        );
        assert_eq!(span.record_time.as_deref(), Some("2024-06-15"));
        assert!(!span.text().contains("turn_metadata"));
    }
    assert!(spans[0].source_phase.is_none());
    assert_eq!(spans[1].source_phase.as_deref(), Some("analysis"));
}

#[test]
fn pure_binder_document_body_does_not_invent_speaker_or_turn_time() {
    let original = "---\ncreated: 2024-06-15\ntitle: Synthetic document\n---\n\n# Sketch\nThe old proposal has an unknown outcome.\n";
    let document = bind_qa_original("wiki/parser-qa.md", original).unwrap();
    let set = SourceSet::new(origin(), Scope::Wiki, vec![document], vec![]).unwrap();
    let spans: Vec<_> = set.spans().collect();
    assert_eq!(spans.len(), 1);
    assert_eq!(spans[0].speaker(), ActorRole::Unknown);
    assert!(spans[0].turn_time().is_none());
    assert_eq!(spans[0].record_time.as_deref(), Some("2024-06-15"));
    assert!(!spans[0].text().contains("created:"));
    assert_eq!(
        original.get(spans[0].start..spans[0].end),
        Some(spans[0].text())
    );
}

#[test]
fn pure_binder_rejects_invalid_path_body_role_and_timestamp_metadata() {
    assert!(bind_qa_original("../outside.md", "A synthetic activity.").is_err());
    for original in ["", "  \n", "---\ncreated: 2024-06-15\n---\n"] {
        assert!(bind_qa_original("sessions/parser-qa.md", original).is_err());
    }
    for metadata in [
        "original_role: assistant, timestamp: '2024-06-14T09:00:00Z'",
        "original_role: user, timestamp: 'invalid-time'",
        "original_role: user, phase: 7",
    ] {
        let original = format!(
            "---\nturn_metadata: [{{{metadata}}}]\n---\n\n**User:**\nA synthetic request.\n"
        );
        assert!(bind_qa_original("sessions/parser-qa.md", &original).is_err());
    }
}

#[test]
fn pure_binder_retains_repeated_bodies_as_distinct_original_turns() {
    let body = "The synthetic draft is ready.";
    let original = format!("---\nturn_metadata: [{{timestamp: '2024-06-14T09:00:00Z'}}, {{timestamp: '2024-06-14T10:00:00Z'}}]\n---\n\n**User:**\n{body}\n\n**Assistant:**\n{body}\n");
    let document = bind_qa_original("sessions/repeated-qa.md", &original).unwrap();
    let set = SourceSet::new(origin(), Scope::Sessions, vec![document], vec![]).unwrap();
    let spans: Vec<_> = set.spans().collect();
    assert_eq!(spans.len(), 2);
    assert_ne!(spans[0].id(), spans[1].id());
    assert_ne!(spans[0].start, spans[1].start);
    assert_ne!(spans[0].speaker(), spans[1].speaker());
    assert_ne!(spans[0].turn_time(), spans[1].turn_time());
    assert!(spans.iter().all(|span| span.text().contains(body)));
}

#[test]
fn rejects_oversized_serialized_qa_output_before_projection() {
    let text = "I saved a sketch.";
    let mut output = batch(vec![proposal(text)]).to_string();
    output.push_str(&" ".repeat(wiki_claims::MAX_OUTPUT_BYTES));
    assert!(
        validate_quoted_qa(&evidence(text), &output, &origin(), Scope::Sessions)
            .unwrap_err()
            .contains("quoted claim output exceeds bounds")
    );
}
