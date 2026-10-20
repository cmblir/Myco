use super::*;
use crate::retrieval::Scope;
use crate::vault_session::AgentVaultSession;
use crate::wiki_claims::{ActorRole, SourceDocument, SpanInput};
use serde_json::{json, Value};

#[cfg(feature = "native-index-probe")]
#[path = "claim_answer_focus_tests.rs"]
mod focus_tests;

fn fixture() -> (DateRange, Vec<Evidence>, SourceSet, Extraction) {
    let text = "Synthetic export was requested.\nSynthetic export draft was reported complete.";
    let split = text.find('\n').unwrap() + 1;
    let source = SourceDocument::bind(
        "S0".into(),
        "sessions/synthetic.md".into(),
        "sessions/synthetic.md".into(),
        text,
        Some("2026-10-08".into()),
        vec![
            SpanInput {
                id: "Q1".into(),
                start: 0,
                end: split,
                turn_id: "T1".into(),
                speaker: ActorRole::User,
                turn_time: Some("2026-10-03T08:00:00Z".into()),
            },
            SpanInput {
                id: "Q2".into(),
                start: split,
                end: text.len(),
                turn_id: "T2".into(),
                speaker: ActorRole::Assistant,
                turn_time: Some("2026-10-04T08:00:00Z".into()),
            },
        ],
    )
    .unwrap();
    let origin = AgentVaultSession {
        vault_path: "/synthetic/vault".into(),
        opening_token: "7".into(),
    };
    let set = SourceSet::new(origin.clone(), Scope::Sessions, vec![source], vec![]).unwrap();
    let proposal = |id: &str, role: &str, act: &str, status: &str| {
        json!({"action":format!("Synthetic action from {id}"),
        "anchorSpanId":id,"supportSpanIds":[id],"actor":{"role":role,"basis":"speaker","subjectSpanId":null},
        "eventTime":{"value":null,"basis":"unknown","precision":"unknown","uncertainty":"unknown","supportSpanId":null},
        "speechAct":act,"status":status,"verificationId":null})
    };
    let claims = set
        .validate(
            &json!({"outcome":"claims","claims":[proposal("Q1","user","request","requested"),
        proposal("Q2","assistant","report","reported_completed")]})
            .to_string(),
            &origin,
            Scope::Sessions,
        )
        .unwrap();
    let extraction = Extraction {
        claims,
        eligible_spans: 2,
        processed_spans: 2,
        omitted_spans: 0,
        batches: 1,
        processed_span_ids: vec!["Q1".into(), "Q2".into()],
        reviews: vec![], // Pure packet fixture, not a production review receipt.
        #[cfg(feature = "native-index-probe")]
        focus_reviews: vec![],
        #[cfg(feature = "native-index-probe")]
        focus_projections: vec![],
        #[cfg(feature = "native-index-probe")]
        focus_claim_count: 0,
        #[cfg(feature = "native-index-probe")]
        review_correction_used: false,
    };
    let evidence = vec![Evidence {
        page: "sessions/synthetic.md".into(),
        stem: "Synthetic session".into(),
        section: 0,
        text: "This generated preview is not original evidence.".into(),
        title: Some("Synthetic export".into()),
        compiled: Some(crate::local_synthesis::CompiledSession {
            work: vec!["INJECTED_COMPILED_COMPLETION".into()],
            remaining: vec![],
        }),
    }];
    let range = DateRange {
        start: "2026-10-03".into(),
        end: "2026-10-04".into(),
        start_epoch: None,
        end_epoch: None,
    };
    (range, evidence, set, extraction)
}

#[test]
fn answer_packet_has_original_roles_period_and_unreviewed_proposals_not_compiled_prose() {
    let (range, evidence, set, extraction) = fixture();
    let prepared = prepare_answer(
        "Summarize my work.",
        "en",
        &range,
        &evidence,
        &set,
        &extraction,
        |_, _| Ok(true),
    )
    .unwrap();
    let packet: Value = serde_json::from_str(&prepared.prompt.user).unwrap();
    assert_eq!(packet["activityPeriod"]["start"], "2026-10-03");
    assert!(packet["resolutionWindow"].is_null());
    assert_eq!(packet["semanticReviewRequired"], true);
    assert_eq!(packet["currentStateIndependentlyVerified"], false);
    assert_eq!(packet["sources"][0]["originalSpans"][0]["speaker"], "user");
    assert_eq!(
        packet["sources"][0]["originalSpans"][1]["speaker"],
        "assistant"
    );
    assert_eq!(packet["claimProposals"][0]["status"], "requested");
    assert_eq!(packet["claimProposals"][1]["status"], "reported_completed");
    assert!(!prepared
        .prompt
        .user
        .contains("INJECTED_COMPILED_COMPLETION"));
    assert!(!prepared.prompt.user.contains("generated preview"));
    assert_eq!(
        (
            prepared.proposed_claims,
            prepared.selected_claims,
            prepared.omitted_claims,
            prepared.original_spans
        ),
        (2, 2, 0, 2)
    );
    let reply = r#"{"answer":"The synthetic export was requested, and the assistant reported a completed draft. The actual final outcome remains unknown.","sources":["S1"]}"#;
    let (rendered, sources) =
        crate::local_synthesis::validate_answer(reply, &prepared.prompt, "en").unwrap();
    assert_eq!(sources, vec!["sessions/synthetic.md"]);
    assert!(rendered.contains("[[sessions/synthetic|Synthetic session]]"));
}

#[test]
fn fit_cannot_drop_the_later_same_page_report_while_keeping_the_request() {
    let (range, evidence, set, extraction) = fixture();
    let result = prepare_answer(
        "Summarize my work.",
        "en",
        &range,
        &evidence,
        &set,
        &extraction,
        |_, user| Ok(!user.contains("draft was reported complete")),
    );
    assert!(result
        .err()
        .unwrap()
        .contains("no complete original activity group"));
}

#[test]
fn answer_packet_rejects_missing_citation_admission_and_insufficient_evidence() {
    let (range, _, set, mut extraction) = fixture();
    assert!(prepare_answer(
        "Synthetic work",
        "en",
        &range,
        &[],
        &set,
        &extraction,
        |_, _| Ok(true)
    )
    .err()
    .unwrap()
    .contains("admitted citation"));
    extraction.claims.claims.clear();
    extraction.claims.outcome = ClaimOutcome::InsufficientEvidence;
    assert!(prepare_answer(
        "Synthetic work",
        "en",
        &range,
        &[],
        &set,
        &extraction,
        |_, _| Ok(true)
    )
    .err()
    .unwrap()
    .contains("insufficient"));
}

#[test]
fn advice_keeps_current_outcome_unknown_and_requires_a_conditional_useful_action() {
    let (range, evidence, set, extraction) = fixture();
    let prepared = prepare_answer(
        "What should I work on next?",
        "en",
        &range,
        &evidence,
        &set,
        &extraction,
        |_, _| Ok(true),
    )
    .unwrap();
    assert!(prepared.prompt.system.contains("conditional next action"));
    assert!(prepared
        .prompt
        .system
        .contains("do not prove work remains unfinished today"));
    assert!(prepared
        .prompt
        .system
        .contains("never independently verified facts"));
}

#[test]
fn answer_original_closure_retains_unclaimed_same_page_retraction() {
    let (range, evidence, _, mut extraction) = fixture();
    let first = "Synthetic export was requested.\n";
    let second = "Synthetic export draft was reported complete.\n";
    let third = "The reported draft completion was withdrawn; final outcome remains unknown.";
    let original = format!("{first}{second}{third}");
    let source = SourceDocument::bind(
        "S0".into(),
        "sessions/synthetic.md".into(),
        "sessions/synthetic.md".into(),
        &original,
        None,
        vec![
            SpanInput {
                id: "Q1".into(),
                start: 0,
                end: first.len(),
                turn_id: "T1".into(),
                speaker: ActorRole::User,
                turn_time: Some("2026-10-03T08:00:00Z".into()),
            },
            SpanInput {
                id: "Q2".into(),
                start: first.len(),
                end: first.len() + second.len(),
                turn_id: "T2".into(),
                speaker: ActorRole::Assistant,
                turn_time: Some("2026-10-04T08:00:00Z".into()),
            },
            SpanInput {
                id: "Q3".into(),
                start: first.len() + second.len(),
                end: original.len(),
                turn_id: "T3".into(),
                speaker: ActorRole::Assistant,
                turn_time: Some("2026-10-04T09:00:00Z".into()),
            },
        ],
    )
    .unwrap();
    let origin = AgentVaultSession {
        vault_path: "/synthetic/vault".into(),
        opening_token: "7".into(),
    };
    let set = SourceSet::new(origin.clone(), Scope::Sessions, vec![source], vec![]).unwrap();
    extraction.claims = set
        .validate(
            &json!({"outcome":"claims","claims":
        extraction.claims.claims.iter().map(|claim|&claim.proposal).collect::<Vec<_>>()})
            .to_string(),
            &origin,
            Scope::Sessions,
        )
        .unwrap();
    extraction.eligible_spans = 3;
    extraction.processed_spans = 3;
    extraction.processed_span_ids.push("Q3".into());
    let prepared = prepare_answer(
        "Summarize my work.",
        "en",
        &range,
        &evidence,
        &set,
        &extraction,
        |_, _| Ok(true),
    )
    .unwrap();
    assert!(
        prepared
            .selected_originals
            .iter()
            .any(|span| span.id() == "Q3"),
        "contrary original cannot disappear because extraction omitted its claim"
    );
    let partial = prepare_answer(
        "Summarize my work.",
        "en",
        &range,
        &evidence,
        &set,
        &extraction,
        |_, user| Ok(!user.contains("completion was withdrawn")),
    );
    assert!(
        partial
            .err()
            .is_some_and(|error| error.starts_with("review_not_fit:")),
        "token fit must not silently drop the unclaimed contrary original"
    );
    extraction.processed_spans = 2;
    extraction.omitted_spans = 1;
    extraction.processed_span_ids.pop();
    let unprocessed = prepare_answer(
        "Summarize my work.",
        "en",
        &range,
        &evidence,
        &set,
        &extraction,
        |_, _| Ok(true),
    )
    .unwrap();
    assert!(
        unprocessed
            .selected_originals
            .iter()
            .any(|span| span.id() == "Q3"),
        "unprocessed contrary original remains required final-answer context"
    );
    assert!(prepare_answer(
        "Summarize my work.",
        "en",
        &range,
        &evidence,
        &set,
        &extraction,
        |_, user| Ok(!user.contains("completion was withdrawn")),
    )
    .err()
    .is_some_and(|error| error.starts_with("review_not_fit:")));
}
