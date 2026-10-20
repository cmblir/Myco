//! Named encoding preserves source proposals; shape is never a meaning grade.

use super::*;
use crate::commands::DateRange;
use crate::retrieval::Scope;
use crate::vault_session::AgentVaultSession;
use crate::wiki_claims::{SourceDocument, SpanInput};
use serde_json::json;

#[path = "focus_claims_named_qa_rejection_tests.rs"]
mod rejection;

const FIRST: &str = "The technician repaired the valve on 2026-10-01. I did not deploy the change because the preview was blank. I reopened the investigation.";
const SECOND: &str = "I finished drafting the repair plan. This message records no later repair result.  spaced focus  ";

fn origin() -> AgentVaultSession {
    AgentVaultSession {
        vault_path: "/synthetic/named-focus-qa".into(),
        opening_token: "named-focus-opening".into(),
    }
}

fn sources(first: &str, reversed: bool) -> SourceSet {
    let prefix = "한글 원문\n";
    let original = format!("{prefix}{first}\n{SECOND}");
    let mut spans = vec![
        SpanInput {
            id: "Q-FIRST".into(),
            start: prefix.len(),
            end: prefix.len() + first.len(),
            turn_id: "T-FIRST".into(),
            speaker: ActorRole::User,
            turn_time: Some("2026-10-03T08:00:00Z".into()),
        },
        SpanInput {
            id: "Q-SECOND".into(),
            start: prefix.len() + first.len() + 1,
            end: original.len(),
            turn_id: "T-SECOND".into(),
            speaker: ActorRole::Assistant,
            turn_time: Some("2026-10-04T09:00:00Z".into()),
        },
    ];
    if reversed {
        spans.reverse();
    }
    let document = SourceDocument::bind(
        "S-NAMED".into(),
        "sessions/named.md".into(),
        "sessions/named.md".into(),
        &original,
        Some("2026-10-04T09:00:00Z".into()),
        spans,
    )
    .unwrap()
    .with_turn_phases(&[
        ("T-FIRST".into(), Some("final".into())),
        ("T-SECOND".into(), None),
    ])
    .unwrap();
    SourceSet::new(origin(), Scope::Sessions, vec![document], vec![]).unwrap()
}

fn period() -> DateRange {
    DateRange {
        start: "2026-10-01".into(),
        end: "2026-10-04".into(),
        start_epoch: crate::importers::parse_iso8601("2026-09-30T15:00:00Z"),
        end_epoch: crate::importers::parse_iso8601("2026-10-04T15:00:00Z"),
    }
}

fn input(sources: &SourceSet) -> String {
    crate::local_synthesis::claim_prompt::payload(
        "Summarize recorded activity",
        "en",
        &period(),
        &sources.spans().collect::<Vec<_>>(),
    )
    .unwrap()
}

fn prepared(encoding: Encoding) -> (SourceSet, PreparedFocusQa) {
    let sources = sources(FIRST, false);
    let prepared = PreparedFocusQa::prepare_for(&input(&sources), encoding).unwrap();
    (sources, prepared)
}

fn claim(anchor: usize, focus: &str, kind: &str, speech: &str, status: &str) -> Value {
    json!([
        anchor,
        focus,
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

fn named_claim(tuple: &Value) -> Value {
    json!({"anchorOrdinal":tuple[0],"focusQuote":tuple[1],"assertionKind":tuple[2],
        "supportOrdinals":tuple[3],"actor":{"role":tuple[4][0],"basis":tuple[4][1],"subjectOrdinal":tuple[4][2]},
        "eventTime":{"value":tuple[5][0],"basis":tuple[5][1],"precision":tuple[5][2],
            "uncertainty":tuple[5][3],"timeSupportOrdinal":tuple[5][4]},
        "speechAct":tuple[6],"status":tuple[7],"verificationId":tuple[8]})
}

fn output(prepared: &PreparedFocusQa, claims: &[Value]) -> Value {
    let claims = claims
        .iter()
        .map(|claim| match prepared.encoding() {
            Encoding::TupleV1 => claim.clone(),
            Encoding::NamedV1 => named_claim(claim),
        })
        .collect::<Vec<_>>();
    json!({"version":prepared.decoder().wire_version(),"packetSha256":prepared.decoder().packet_sha256(),
        "outcome":if claims.is_empty(){"insufficient_evidence"}else{"claims"},"claims":claims})
}

fn sample() -> Vec<Value> {
    let mut third_party = claim(
        0,
        "The technician repaired the valve on 2026-10-01.",
        "asserted_occurrence",
        "report",
        "reported_completed",
    );
    third_party[4] = json!(["source", "explicit_subject", 0]);
    third_party[5] = json!(["2026-10-01", "explicit", "day", "specified", 0]);
    let mut unknown = claim(1, "  spaced focus  ", "uncertain", "question", "unknown");
    unknown[4] = json!(["unknown", "unknown", null]);
    vec![
        third_party,
        claim(
            0,
            "I did not deploy the change because the preview was blank.",
            "explicit_nonoccurrence",
            "report",
            "unknown",
        ),
        claim(
            0,
            "I reopened the investigation.",
            "asserted_occurrence",
            "report",
            "reported_completed",
        ),
        claim(
            1,
            "I finished drafting the repair plan.",
            "asserted_occurrence",
            "report",
            "reported_completed",
        ),
        claim(
            1,
            "This message records no later repair result.",
            "record_or_verification_limit",
            "report",
            "unknown",
        ),
        unknown,
    ]
}

fn feedback() -> Value {
    json!({"failureCode":"review_missing","review":{"version":"WikiClaimReviewV1","claims":[],
        "missingSpanIds":["Q-FIRST","Q-SECOND"],"sourceCoverage":"missing"},
        "untrustedModelJudgments":true,"sameModelReviewIsIndependent":false,"semanticAccepted":false,
        "nativeIoAuthenticated":false,"productionAccepted":false})
}

#[test]
fn named_and_tuple_proposals_preserve_identical_typed_fields_and_exact_originals() {
    let (sources, tuple) = prepared(Encoding::TupleV1);
    let named = PreparedFocusQa::prepare_for(tuple.original_user(), Encoding::NamedV1).unwrap();
    let default = PreparedFocusQa::prepare(tuple.original_user()).unwrap();
    assert_eq!(default.encoding(), Encoding::TupleV1);
    assert_eq!(default.system(), tuple.system());
    assert_eq!(default.user(), tuple.user());
    assert_eq!(named.user(), tuple.user());
    assert_eq!(named.original_user(), tuple.original_user());
    assert_eq!(
        named.decoder().packet_sha256(),
        tuple.decoder().packet_sha256()
    );
    assert_eq!(named.decoder().wire_version(), NAMED_VERSION);
    let a = tuple
        .expand(&output(&tuple, &sample()).to_string())
        .unwrap();
    let b = named
        .expand(&output(&named, &sample()).to_string())
        .unwrap();
    assert_eq!(a.canonical(), b.canonical());
    assert_eq!(a.original_spans, b.original_spans);
    assert_eq!(
        serde_json::to_value(&a.witnesses).unwrap(),
        serde_json::to_value(&b.witnesses).unwrap()
    );
    assert_ne!(a.revision(), b.revision());
    assert_eq!(b.encoding(), Some(Encoding::NamedV1));
    let checked = sources
        .validate(b.canonical(), &origin(), Scope::Sessions)
        .unwrap();
    let context: Value = serde_json::from_str(tuple.original_user()).unwrap();
    let view = b.model_review_value(&sources, &checked, &context).unwrap();
    assert_eq!(view["version"], NAMED_VERSION);
    assert_eq!(view["claims"].as_array().unwrap().len(), sample().len());
    assert_eq!(view["semanticAccepted"], false);
    assert_eq!(view["nativeIoAuthenticated"], false);
    assert_eq!(view["productionAccepted"], false);
    assert!(checked
        .claims
        .iter()
        .all(|claim| claim.structure_checked && claim.semantic_review_required));
    assert_eq!(checked.claims[0].proposal.actor.role, ActorRole::Source);
    assert_eq!(
        checked.claims[0].proposal.event_time.value.as_deref(),
        Some("2026-10-01")
    );
    assert_eq!(checked.claims[5].proposal.action, "  spaced focus  ");
    b.verify_answer_context(
        "Summarize recorded activity",
        "en",
        &period(),
        &sources.spans().cloned().collect::<Vec<_>>(),
    )
    .unwrap();
    b.ordered_answer_witnesses(
        &checked
            .claims
            .iter()
            .map(|claim| &claim.proposal)
            .collect::<Vec<_>>(),
    )
    .unwrap();
}

#[test]
fn named_changes_only_output_syntax_and_preserves_shared_semantic_policy() {
    let (_, tuple) = prepared(Encoding::TupleV1);
    let named = PreparedFocusQa::prepare_for(tuple.original_user(), Encoding::NamedV1).unwrap();
    let a = tuple.system().lines().collect::<Vec<_>>();
    let b = named.system().lines().collect::<Vec<_>>();
    assert_eq!(&a[2..5], &b[2..5]);
    assert!(named
        .system()
        .ends_with(crate::activity_recall::period_context::INSTRUCTIONS));
    assert!(named
        .system()
        .contains("All keys are required, including nullable keys"));
    assert!(!named.system().contains("Each claim is exactly ["));
    assert!(!named.system().contains(FIRST));
    assert!(!named.system().contains(SECOND));
    for key in [
        "question",
        "language",
        "activityPeriod",
        "recordPeriodContext",
        "originalSpans",
        "allowedSpanIds",
    ] {
        let a: Value = serde_json::from_str(tuple.user()).unwrap();
        let b: Value = serde_json::from_str(named.user()).unwrap();
        assert_eq!(a[key], b[key]);
    }
}

#[test]
fn fresh_tuple_revision_binds_actual_prompt_and_cannot_reuse_legacy_digest() {
    let (_, prepared) = prepared(Encoding::TupleV1);
    let projection = prepared
        .expand(&output(&prepared, &sample()).to_string())
        .unwrap();
    let legacy = serde_json::to_vec(&(
        VERSION,
        sha256(prepared.original_user().as_bytes()),
        projection.canonical(),
        &projection.witnesses,
    ))
    .unwrap();
    assert_ne!(projection.revision(), sha256(&legacy));
    assert_eq!(
        projection.revision(),
        projection_revision(
            prepared.original_user(),
            projection.canonical(),
            &projection.witnesses
        )
        .unwrap()
    );
}

#[test]
fn named_correction_retains_previous_raw_feedback_encoding_and_all_originals() {
    let (sources, base) = prepared(Encoding::NamedV1);
    let previous = format!("{} \n", output(&base, &[]));
    let corrected = PreparedFocusQa::prepare_correction_for(
        base.original_user(),
        &previous,
        &feedback(),
        Encoding::NamedV1,
    )
    .unwrap();
    assert_eq!(corrected.encoding(), Encoding::NamedV1);
    assert_eq!(corrected.decoder().wire_version(), NAMED_VERSION);
    assert!(corrected.system().starts_with(base.system()));
    let mut retained: Value = serde_json::from_str(corrected.original_user()).unwrap();
    let correction = retained
        .as_object_mut()
        .unwrap()
        .remove(correction::FIELD)
        .unwrap();
    assert_eq!(
        retained,
        serde_json::from_str::<Value>(base.original_user()).unwrap()
    );
    assert_eq!(correction["previousModelResult"], previous);
    assert_eq!(correction["automatedReviewFeedback"], feedback());
    let raw = output(&corrected, &sample()).to_string();
    let projection = corrected.expand(&raw).unwrap();
    projection.verify_model_result(&raw).unwrap();
    assert!(projection.verify_model_result(&(raw + " ")).is_err());
    let checked = sources
        .validate(projection.canonical(), &origin(), Scope::Sessions)
        .unwrap();
    projection
        .review_value(&sources, &checked, &retained)
        .unwrap();
    let view = serde_json::to_value(&projection).unwrap();
    assert!(view.get("generationSystem").is_none());
    assert!(view.get("generationUser").is_none());
    assert!(view.get("correction").is_none());
    assert_eq!(view["semanticAccepted"], false);
    assert!(PreparedFocusQa::prepare_for(corrected.original_user(), Encoding::NamedV1).is_err());
}

#[test]
fn named_empty_outcome_keeps_complete_originals_and_requires_meaning_review() {
    let (sources, prepared) = prepared(Encoding::NamedV1);
    let projection = prepared
        .expand(&output(&prepared, &[]).to_string())
        .unwrap();
    let canonical: Value = serde_json::from_str(projection.canonical()).unwrap();
    assert_eq!(
        canonical,
        json!({"outcome":"insufficient_evidence","claims":[]})
    );
    assert_eq!(projection.proposal_count(), 0);
    assert_eq!(projection.original_spans.len(), 2);
    assert_eq!(
        projection.ordered_answer_witnesses(&[]).unwrap(),
        Vec::<Value>::new()
    );
    let checked = sources
        .validate(projection.canonical(), &origin(), Scope::Sessions)
        .unwrap();
    let context: Value = serde_json::from_str(prepared.original_user()).unwrap();
    let view = projection
        .model_review_value(&sources, &checked, &context)
        .unwrap();
    assert_eq!(view["claims"], json!([]));
    assert_eq!(view["semanticReviewRequired"], true);
    assert_eq!(view["semanticAccepted"], false);
}

#[test]
fn named_grammar_retains_count_rule_size_and_iso_component_bounds() {
    for count in 1..=8 {
        let documents = (0..count)
            .map(|ordinal| {
                let path = format!("sessions/count-{ordinal}.md");
                SourceDocument::bind(
                    format!("S-{ordinal}"),
                    path.clone(),
                    path,
                    FIRST,
                    None,
                    vec![SpanInput {
                        id: format!("Q-{ordinal}"),
                        start: 0,
                        end: FIRST.len(),
                        turn_id: format!("T-{ordinal}"),
                        speaker: ActorRole::Unknown,
                        turn_time: None,
                    }],
                )
                .unwrap()
            })
            .collect();
        let sources = SourceSet::new(origin(), Scope::Sessions, documents, vec![]).unwrap();
        let user = input(&sources);
        let tuple = PreparedFocusQa::prepare_for(&user, Encoding::TupleV1).unwrap();
        let named = PreparedFocusQa::prepare_for(&user, Encoding::NamedV1).unwrap();
        let a = tuple.decoder().grammar();
        let b = named.decoder().grammar();
        assert_eq!(named.decoder().span_count(), count);
        assert_eq!(
            a.lines().filter(|line| line.contains(" ::= ")).count(),
            b.lines().filter(|line| line.contains(" ::= ")).count()
        );
        assert!(b.len() <= 1024 * 1024);
        assert!(b.lines().filter(|line| line.contains(" ::= ")).count() <= 3608);
        for rule in ["day-value ::= ", "instant-value ::= "] {
            assert_eq!(
                a.lines().find(|line| line.starts_with(rule)),
                b.lines().find(|line| line.starts_with(rule))
            );
        }
        assert!(b.contains("{1,43}"));
        assert!(b.contains("{1,38}"));
        assert!(b.contains(NAMED_VERSION));
        assert!(b.contains(&named.decoder().packet_sha256()));
    }
}
