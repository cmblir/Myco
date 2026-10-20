use super::*;
use serde_json::{json, Value};

fn origin() -> AgentVaultSession {
    AgentVaultSession {
        vault_path: "/synthetic/wiki-a".into(),
        opening_token: "17".into(),
    }
}

fn source(text: &str, speaker: ActorRole, turn_time: Option<&str>) -> SourceDocument {
    SourceDocument::bind(
        "S1".into(),
        "sessions/synthetic.md".into(),
        "sessions/synthetic.md".into(),
        text,
        Some("2026-10-08".into()),
        vec![SpanInput {
            id: "Q1".into(),
            start: 0,
            end: text.len(),
            turn_id: "T1".into(),
            speaker,
            turn_time: turn_time.map(str::to_owned),
        }],
    )
    .unwrap()
}

fn evidence(text: &str, speaker: ActorRole, turn_time: Option<&str>) -> SourceSet {
    SourceSet::new(
        origin(),
        Scope::Sessions,
        vec![source(text, speaker, turn_time)],
        vec![],
    )
    .unwrap()
}

fn claim() -> Value {
    json!({
        "action": "The synthetic export button was requested; no outcome was recorded.",
        "anchorSpanId": "Q1", "supportSpanIds": ["Q1"],
        "actor": {"role": "user", "basis": "speaker", "subjectSpanId": null},
        "eventTime": {"value": null, "basis": "unknown", "precision": "unknown", "uncertainty": "unknown", "supportSpanId": null},
        "speechAct": "request", "status": "requested", "verificationId": null,
    })
}

fn validate(set: &SourceSet, claim: Value) -> Result<CheckedClaims, String> {
    set.validate(
        &json!({"outcome": "claims", "claims": [claim]}).to_string(),
        &origin(),
        Scope::Sessions,
    )
}

#[test]
fn valid_quote_preserves_app_speaker_hash_offsets_and_requires_semantic_review() {
    let text = "User request: Add a synthetic export button. No outcome was recorded.";
    let set = evidence(text, ActorRole::User, Some("2026-10-07T08:00:00Z"));
    let checked = validate(&set, claim()).unwrap();
    let bound = &checked.claims[0];
    assert!(bound.structure_checked && bound.semantic_review_required);
    assert_eq!(bound.provenance[0].speaker, ActorRole::User);
    assert_eq!(bound.provenance[0].source_revision, sha256(text.as_bytes()));
    assert_eq!(bound.provenance[0].sha256, sha256(text.as_bytes()));
    assert_eq!(
        (bound.provenance[0].start, bound.provenance[0].end),
        (0, text.len())
    );
    assert_eq!(bound.provenance[0].text, text);
}

#[test]
fn refuses_assistant_report_reassigned_to_user_by_speaker_basis() {
    let set = evidence(
        "Assistant report: Fixed duplicate synthetic search results; eight tests passed.",
        ActorRole::Assistant,
        None,
    );
    let mut proposed = claim();
    proposed["speechAct"] = json!("report");
    proposed["status"] = json!("reported_completed");
    assert!(validate(&set, proposed).unwrap_err().contains("speaker"));
}

#[test]
fn user_request_cannot_be_completed_by_status_change() {
    let set = evidence(
        "User request: Add a synthetic export button. No outcome was recorded.",
        ActorRole::User,
        None,
    );
    let mut proposed = claim();
    proposed["status"] = json!("reported_completed");
    assert!(validate(&set, proposed).unwrap_err().contains("speech act"));
}

#[test]
fn model_mistagging_request_as_report_never_becomes_semantic_proof() {
    let set = evidence(
        "User request: Add a synthetic export button. No outcome was recorded.",
        ActorRole::User,
        None,
    );
    let mut proposed = claim();
    proposed["action"] = json!("The synthetic export button was completed.");
    proposed["speechAct"] = json!("report");
    proposed["status"] = json!("reported_completed");
    let checked = validate(&set, proposed).unwrap();
    assert!(checked.claims[0].semantic_review_required);
    assert_eq!(
        checked.claims[0].proposal.status,
        ClaimStatus::ReportedCompleted
    );
}

#[test]
fn negative_assistant_report_keeps_unknown_status_and_requires_semantic_review() {
    let text =
        "Implementation and verification of the synthetic parser repair have not been performed.";
    let set = evidence(text, ActorRole::Assistant, None);
    let mut proposed = claim();
    proposed["action"] = json!(text);
    proposed["actor"]["role"] = json!("assistant");
    proposed["speechAct"] = json!("report");
    proposed["status"] = json!("unknown");
    let checked = validate(&set, proposed.clone()).unwrap();
    let bound = &checked.claims[0];
    assert_eq!(checked.outcome, ClaimOutcome::Claims);
    assert!(bound.structure_checked && bound.semantic_review_required);
    assert_eq!(bound.proposal.action, text);
    assert_eq!(bound.proposal.actor.role, ActorRole::Assistant);
    assert_eq!(bound.proposal.actor.basis, ActorBasis::Speaker);
    assert_eq!(bound.proposal.actor.subject_span_id, None);
    assert_eq!(bound.proposal.speech_act, SpeechAct::Report);
    assert_eq!(bound.proposal.status, ClaimStatus::Unknown);
    assert!(!bound.proposal.status.is_verified());
    assert_eq!(bound.proposal.verification_id, None);
    assert_eq!(bound.provenance[0].text, text);
    assert_eq!(bound.provenance[0].speaker, ActorRole::Assistant);

    // Structure checks preserve proposals; they do not certify status meaning.
    proposed["status"] = json!("reported_completed");
    let misleading = validate(&set, proposed).unwrap();
    assert_eq!(
        misleading.claims[0].proposal.status,
        ClaimStatus::ReportedCompleted
    );
    assert!(misleading.claims[0].semantic_review_required);
    assert!(!misleading.claims[0].proposal.status.is_verified());
    assert_eq!(misleading.claims[0].proposal.verification_id, None);
}

#[test]
fn unknown_speaker_can_bind_unknown_actor_by_speaker_without_semantic_proof() {
    let text = "The synthetic parser repair is mentioned without an identified speaker or outcome.";
    let set = evidence(text, ActorRole::Unknown, None);
    let mut proposed = claim();
    proposed["action"] = json!(text);
    proposed["actor"] = json!({"role": "unknown", "basis": "speaker", "subjectSpanId": null});
    proposed["speechAct"] = json!("unknown");
    proposed["status"] = json!("unknown");
    let checked = validate(&set, proposed).unwrap();
    let bound = &checked.claims[0];
    assert!(bound.structure_checked && bound.semantic_review_required);
    assert_eq!(bound.proposal.actor.role, ActorRole::Unknown);
    assert_eq!(bound.proposal.actor.basis, ActorBasis::Speaker);
    assert_eq!(bound.proposal.actor.subject_span_id, None);
    assert_eq!(bound.provenance[0].speaker, ActorRole::Unknown);
}

#[test]
fn known_speaker_cannot_be_reassigned_to_unknown_by_speaker_basis() {
    let mut proposed = claim();
    proposed["actor"] = json!({"role": "unknown", "basis": "speaker", "subjectSpanId": null});
    for speaker in [
        ActorRole::User,
        ActorRole::Assistant,
        ActorRole::System,
        ActorRole::Tool,
        ActorRole::Source,
    ] {
        let set = evidence("A synthetic parser repair is mentioned.", speaker, None);
        assert!(validate(&set, proposed.clone())
            .unwrap_err()
            .contains("speaker"));
    }
}

#[test]
fn unknown_speech_act_does_not_supply_completion() {
    let set = evidence(
        "A synthetic connector is mentioned without its author or outcome.",
        ActorRole::Unknown,
        None,
    );
    let mut proposed = claim();
    proposed["actor"] = json!({"role": "unknown", "basis": "unknown", "subjectSpanId": null});
    proposed["speechAct"] = json!("unknown");
    proposed["status"] = json!("reported_completed");
    assert!(validate(&set, proposed).unwrap_err().contains("speech act"));
}

#[test]
fn record_time_cannot_be_used_as_an_absent_turn_time() {
    let set = evidence(
        "The old plan proposed a synthetic connector; completion has not been confirmed.",
        ActorRole::User,
        None,
    );
    let mut proposed = claim();
    proposed["eventTime"] = json!({"value": "2026-10-08", "basis": "inferred_from_turn", "precision": "day", "uncertainty": "inferred", "supportSpanId": "Q1"});
    assert!(validate(&set, proposed).unwrap_err().contains("turn time"));
}

#[test]
fn record_time_is_not_a_model_time_basis() {
    let set = evidence(
        "A synthetic old plan with an unknown action date.",
        ActorRole::User,
        None,
    );
    let mut proposed = claim();
    proposed["eventTime"]["basis"] = json!("record_time");
    assert!(validate(&set, proposed)
        .unwrap_err()
        .contains("invalid claim proposal JSON"));
}

#[test]
fn an_inferred_message_date_is_not_promoted_to_specified_action_time() {
    let set = evidence(
        "User request: Add a synthetic export button.",
        ActorRole::User,
        Some("2026-10-07T08:00:00Z"),
    );
    let mut proposed = claim();
    proposed["eventTime"] = json!({"value": "2026-10-07", "basis": "inferred_from_turn", "precision": "day", "uncertainty": "specified", "supportSpanId": "Q1"});
    assert!(validate(&set, proposed)
        .unwrap_err()
        .contains("uncertainty"));
}

#[test]
fn explicit_action_date_requires_its_own_original_span() {
    let set = evidence(
        "User request: Add a synthetic export button.",
        ActorRole::User,
        Some("2026-10-07T08:00:00Z"),
    );
    let mut proposed = claim();
    proposed["eventTime"] = json!({"value": "2026-10-08", "basis": "explicit", "precision": "day", "uncertainty": "specified", "supportSpanId": "Q1"});
    assert!(validate(&set, proposed)
        .unwrap_err()
        .contains("explicit date"));
}

#[test]
fn unknown_time_is_preserved_and_insufficient_evidence_is_a_normal_outcome() {
    let set = evidence(
        "A synthetic connector is mentioned without its date or outcome.",
        ActorRole::Unknown,
        None,
    );
    let checked = set
        .validate(
            r#"{"outcome":"insufficient_evidence","claims":[]}"#,
            &origin(),
            Scope::Sessions,
        )
        .unwrap();
    assert_eq!(checked.outcome, ClaimOutcome::InsufficientEvidence);
    assert!(checked.claims.is_empty());
    let mut proposed = claim();
    proposed["actor"] = json!({"role": "unknown", "basis": "unknown", "subjectSpanId": null});
    proposed["speechAct"] = json!("unknown");
    proposed["status"] = json!("unknown");
    assert_eq!(
        validate(&set, proposed).unwrap().claims[0]
            .proposal
            .event_time
            .value,
        None
    );
}

#[test]
fn transcript_verification_words_do_not_supply_independent_receipt() {
    for speaker in [ActorRole::Tool, ActorRole::User, ActorRole::Assistant] {
        let set = evidence(
            "The synthetic test runner says twelve tests passed.",
            speaker,
            None,
        );
        let mut proposed = claim();
        proposed["actor"]["role"] = serde_json::to_value(speaker).unwrap();
        proposed["speechAct"] = json!("verification");
        proposed["status"] = json!("verified_completed");
        assert!(validate(&set, proposed)
            .unwrap_err()
            .contains("verification receipt"));
    }
}

#[test]
fn independent_receipt_cannot_verify_a_different_action() {
    let text = "Tool report: The synthetic source hash matched.";
    let set = SourceSet::new(
        origin(),
        Scope::Sessions,
        vec![source(text, ActorRole::Tool, None)],
        vec![AppVerifiedFact {
            id: "V1".into(),
            canonical_statement: "The synthetic source hash matched.".into(),
            status: ClaimStatus::VerifiedCompleted,
            support_span_ids: vec!["Q1".into()],
        }],
    )
    .unwrap();
    let mut proposed = claim();
    proposed["actor"]["role"] = json!("tool");
    proposed["action"] = json!("The synthetic export feature was deployed.");
    proposed["speechAct"] = json!("verification");
    proposed["status"] = json!("verified_completed");
    proposed["verificationId"] = json!("V1");
    assert!(validate(&set, proposed)
        .unwrap_err()
        .contains("verification receipt"));
    let mut exact = claim();
    exact["actor"]["role"] = json!("tool");
    exact["action"] = json!("The synthetic source hash matched.");
    exact["speechAct"] = json!("verification");
    exact["status"] = json!("verified_completed");
    exact["verificationId"] = json!("V1");
    assert!(validate(&set, exact).unwrap().claims[0].semantic_review_required);
}

#[test]
fn byte_offsets_cannot_cut_hangul_or_extend_beyond_the_source() {
    for (start, end) in [(1, 3), (0, 99), (3, 3)] {
        let result = SourceDocument::bind(
            "S1".into(),
            "sessions/a.md".into(),
            "sessions/a.md".into(),
            "가나다",
            None,
            vec![SpanInput {
                id: "Q1".into(),
                start,
                end,
                turn_id: "T1".into(),
                speaker: ActorRole::User,
                turn_time: None,
            }],
        );
        assert!(result.is_err());
    }
}

#[test]
fn revision_changes_even_when_the_selected_span_is_unchanged() {
    let bind = |text: &str| {
        SourceDocument::bind(
            "S1".into(),
            "sessions/a.md".into(),
            "sessions/a.md".into(),
            text,
            None,
            vec![SpanInput {
                id: "Q1".into(),
                start: 0,
                end: 3,
                turn_id: "T1".into(),
                speaker: ActorRole::User,
                turn_time: None,
            }],
        )
        .unwrap()
    };
    let first = bind("one\nrevision one");
    let second = bind("one\nrevision two");
    assert_ne!(first.revision, second.revision);
    assert_eq!(first.spans[0].sha256, second.spans[0].sha256);
    assert_ne!(
        first.spans[0].source_revision,
        second.spans[0].source_revision
    );
}

#[test]
fn rejects_unselected_duplicate_and_nonanchored_supports() {
    let set = evidence(
        "User request: Add a synthetic export button.",
        ActorRole::User,
        None,
    );
    for supports in [json!(["Q2"]), json!(["Q1", "Q1"]), json!(["Q1", "Q2"])] {
        let mut proposed = claim();
        proposed["supportSpanIds"] = supports;
        assert!(validate(&set, proposed).is_err());
    }
}

#[test]
fn duplicate_global_span_ids_are_not_source_identity() {
    let first = source("User request: synthetic first.", ActorRole::User, None);
    let mut second = source("User request: synthetic second.", ActorRole::User, None);
    second.id = "S2".into();
    assert!(
        SourceSet::new(origin(), Scope::Sessions, vec![first, second], vec![])
            .unwrap_err()
            .contains("span identity")
    );
}

#[test]
fn changed_native_opening_vault_and_scope_cannot_reuse_source_set() {
    let set = evidence(
        "User request: Add a synthetic export button.",
        ActorRole::User,
        None,
    );
    let output = json!({"outcome":"claims","claims":[claim()]}).to_string();
    let mut reopening = origin();
    reopening.opening_token = "18".into();
    assert!(set.validate(&output, &reopening, Scope::Sessions).is_err());
    let mut other_vault = origin();
    other_vault.vault_path = "/synthetic/wiki-b".into();
    assert!(set
        .validate(&output, &other_vault, Scope::Sessions)
        .is_err());
    assert!(set.validate(&output, &origin(), Scope::Wiki).is_err());
    assert!(SourceSet::new(
        origin(),
        Scope::Wiki,
        vec![source("Synthetic session.", ActorRole::User, None)],
        vec![]
    )
    .is_err());
}

#[test]
fn wiki_raw_lineage_keeps_selection_scope_distinct_from_backing_source() {
    let document = SourceDocument::bind(
        "S1".into(),
        "raw/conversations/synthetic.md".into(),
        "wiki/synthetic.md".into(),
        "Synthetic original quote.",
        None,
        vec![SpanInput {
            id: "Q1".into(),
            start: 0,
            end: 25,
            turn_id: "T1".into(),
            speaker: ActorRole::Assistant,
            turn_time: None,
        }],
    )
    .unwrap();
    let set = SourceSet::new(origin(), Scope::Wiki, vec![document], vec![]).unwrap();
    let span = set.spans().next().unwrap();
    assert_eq!(span.selection_path, "wiki/synthetic.md");
    assert_eq!(span.source_path, "raw/conversations/synthetic.md");
}

#[test]
fn rejects_model_forged_app_provenance_and_unbounded_output() {
    let set = evidence(
        "User request: Add a synthetic export button.",
        ActorRole::User,
        None,
    );
    let mut forged = claim();
    forged["sourceRevision"] = json!("fake-sha");
    assert!(validate(&set, forged).is_err());
    assert!(set
        .validate(
            &" ".repeat(MAX_OUTPUT_BYTES + 1),
            &origin(),
            Scope::Sessions
        )
        .is_err());
}

#[test]
fn source_limits_paths_and_invalid_metadata_fail_closed() {
    for path in [
        "../outside.md",
        "/absolute.md",
        "sessions\\outside.md",
        "sessions/./a.md",
    ] {
        let result = SourceDocument::bind(
            "S1".into(),
            path.into(),
            path.into(),
            "Synthetic",
            None,
            vec![SpanInput {
                id: "Q1".into(),
                start: 0,
                end: 9,
                turn_id: "T1".into(),
                speaker: ActorRole::User,
                turn_time: None,
            }],
        );
        assert!(result.is_err(), "{path}");
    }
    assert!(SourceDocument::bind(
        "S1".into(),
        "sessions/a.md".into(),
        "sessions/a.md".into(),
        &"x".repeat(MAX_SOURCE_BYTES + 1),
        None,
        vec![]
    )
    .is_err());
    assert!(SourceDocument::bind(
        "S1".into(),
        "sessions/a.md".into(),
        "sessions/a.md".into(),
        "Synthetic",
        Some("2026-02-30".into()),
        vec![]
    )
    .is_err());
}

#[test]
fn an_explicit_subject_can_differ_from_the_speaker_but_remains_a_proposal() {
    let set = evidence(
        "User request: The assistant should add a synthetic export button.",
        ActorRole::User,
        None,
    );
    let mut proposed = claim();
    proposed["actor"] = json!({"role":"assistant","basis":"explicit_subject","subjectSpanId":"Q1"});
    assert!(validate(&set, proposed).unwrap().claims[0].semantic_review_required);
    let mut forged_subject = claim();
    forged_subject["actor"] =
        json!({"role":"assistant","basis":"explicit_subject","subjectSpanId":"Q2"});
    assert!(validate(&set, forged_subject).is_err());
}

#[test]
fn event_time_keeps_precision_uncertainty_and_original_support() {
    let set = evidence(
        "User report: On 2026-10-06 I drafted the synthetic report. Yesterday I reviewed it.",
        ActorRole::User,
        Some("2026-10-07T08:00:00Z"),
    );
    let mut proposed = claim();
    proposed["speechAct"] = json!("report");
    proposed["status"] = json!("reported_completed");
    for time in [
        json!({"value":"2026-10-06","basis":"explicit","precision":"day","uncertainty":"specified","supportSpanId":"Q1"}),
        json!({"value":"2026-10-07","basis":"inferred_from_turn","precision":"day","uncertainty":"inferred","supportSpanId":"Q1"}),
        json!({"value":"2026-10-06","basis":"date_reference","precision":"day","uncertainty":"inferred","supportSpanId":"Q1"}),
    ] {
        proposed["eventTime"] = time;
        let checked = validate(&set, proposed.clone()).unwrap();
        assert_eq!(
            checked.claims[0]
                .proposal
                .event_time
                .support_span_id
                .as_deref(),
            Some("Q1")
        );
        assert!(checked.claims[0].semantic_review_required);
    }
    proposed["eventTime"]["uncertainty"] = json!("specified");
    assert!(validate(&set, proposed).is_err());
}

#[test]
fn no_source_can_abstain_but_cannot_accept_a_claim_or_hide_claim_count() {
    let empty = SourceSet::new(origin(), Scope::Sessions, vec![], vec![]).unwrap();
    assert!(empty
        .validate(
            r#"{"outcome":"insufficient_evidence","claims":[]}"#,
            &origin(),
            Scope::Sessions
        )
        .is_ok());
    assert!(validate(&empty, claim()).is_err());
    let set = evidence("User request: synthetic button.", ActorRole::User, None);
    assert!(set
        .validate(
            r#"{"outcome":"claims","claims":[]}"#,
            &origin(),
            Scope::Sessions
        )
        .is_err());
    let wrong_outcome = json!({"outcome":"insufficient_evidence","claims":[claim()]}).to_string();
    assert!(set
        .validate(&wrong_outcome, &origin(), Scope::Sessions)
        .is_err());
    let too_many = json!({"outcome":"claims","claims":vec![claim();MAX_CLAIMS+1]}).to_string();
    assert!(set.validate(&too_many, &origin(), Scope::Sessions).is_err());
}
