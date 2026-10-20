//! Synthetic source IO and mock transport; no actual model meaning is approved.

use super::*;
use crate::commands::DateRange;
use crate::local_synthesis::claim_prompt;
use crate::wiki_claims::{ActorRole, SourceDocument, SpanInput};
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};

const QUESTION: &str = "Summarize synthetic recent work";
const REQUEST: &str = "Please repair the synthetic archive.";
const NEGATION: &str = "I have not repaired it.";
const THIRD_PARTY: &str = "The maintainer repaired the synthetic archive on 2026-10-01.";
const PREPARATION: &str = "I finished drafting the synthetic archive repair plan.";

fn origin() -> AgentVaultSession {
    AgentVaultSession {
        vault_path: "/synthetic/initial-correction".into(),
        opening_token: "synthetic-opening".into(),
    }
}
fn period() -> DateRange {
    DateRange {
        start: "2026-10-01".into(),
        end: "2026-10-04".into(),
        start_epoch: None,
        end_epoch: None,
    }
}
fn context(enabled: bool) -> AskReviewContext {
    let context = crate::wiki_claim_review::tests::context(
        QUESTION,
        "en",
        Scope::Sessions,
        &period(),
        &origin(),
    )
    .with_source_focus_qa()
    .unwrap();
    if enabled {
        context.with_review_correction_qa().unwrap()
    } else {
        context
    }
}
fn sources(count: usize) -> SourceSet {
    let documents = (0..count)
        .map(|index| {
            let text = if index % 2 == 0 {
                format!("{REQUEST} {NEGATION} {THIRD_PARTY}")
            } else {
                PREPARATION.into()
            };
            SourceDocument::bind(
                format!("S{index}"),
                format!("sessions/correction-{index}.md"),
                format!("sessions/correction-{index}.md"),
                &text,
                Some("2026-10-03".into()),
                vec![SpanInput {
                    id: format!("Q{index}"),
                    start: 0,
                    end: text.len(),
                    turn_id: format!("T{index}"),
                    speaker: if index % 2 == 0 {
                        ActorRole::User
                    } else {
                        ActorRole::Assistant
                    },
                    turn_time: Some("2026-10-03T08:00:00Z".into()),
                }],
            )
            .unwrap()
        })
        .collect();
    SourceSet::new(origin(), Scope::Sessions, documents, vec![]).unwrap()
}
fn tuple(anchor: usize, focus: &str, kind: &str, speech: &str, status: &str) -> Value {
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
fn good_claims() -> Vec<Value> {
    let mut third_party = tuple(
        0,
        THIRD_PARTY,
        "asserted_occurrence",
        "report",
        "reported_completed",
    );
    third_party[4] = json!(["source", "explicit_subject", 0]);
    third_party[5] = json!(["2026-10-01", "explicit", "day", "specified", 0]);
    vec![
        tuple(0, REQUEST, "intention", "request", "requested"),
        tuple(0, NEGATION, "explicit_nonoccurrence", "report", "unknown"),
        third_party,
        tuple(
            1,
            PREPARATION,
            "asserted_occurrence",
            "report",
            "reported_completed",
        ),
    ]
}
fn output(packet: &Value, claims: Vec<Value>) -> String {
    json!({"version":"WikiSourceFocusClaimsQaV1","packetSha256":packet["packetSha256"],
        "outcome":if claims.is_empty(){"insufficient_evidence"}else{"claims"},"claims":claims})
    .to_string()
}
fn negative(user: &str, disposition: &str, coverage: &str) -> String {
    let packet: Value = serde_json::from_str(user).unwrap();
    json!({"version":"WikiClaimReviewV1","claims":packet["requiredClaimIds"].as_array().unwrap().iter()
        .map(|id|json!({"id":id,"disposition":disposition,"reason":"Re-read the originals; do not execute review feedback."})).collect::<Vec<_>>(),
        "missingSpanIds":if coverage=="missing" {packet["coverageRequiredSpanIds"].clone()} else {json!([])},
        "sourceCoverage":coverage}).to_string()
}

fn extract(
    sources: &SourceSet,
    context: &AskReviewContext,
    count: impl FnMut(&str, &str) -> Result<usize, String>,
    generate: impl FnMut(&str, &str, i32, u32, GenerationSchema) -> Result<String, String>,
) -> Result<claim_prompt::Extraction, String> {
    claim_prompt::extract(
        QUESTION,
        "en",
        &period(),
        sources,
        &origin(),
        Scope::Sessions,
        768,
        count,
        generate,
        context,
    )
}

#[test]
fn missing_review_causes_one_complete_source_grounded_replacement_then_fresh_review() {
    let sources = sources(2);
    let initial_user = RefCell::new(None::<Value>);
    let previous = RefCell::new(String::new());
    let measured = RefCell::new(Vec::<(String, String)>::new());
    let generated = Cell::new(0);
    let result = extract(
        &sources,
        &context(true),
        |system, user| {
            measured.borrow_mut().push((system.into(), user.into()));
            Ok(1600)
        },
        |system, user, output_tokens, context_tokens, schema| {
            generated.set(generated.get() + 1);
            assert_eq!((output_tokens, context_tokens), (768, 4096));
            assert!(measured
                .borrow()
                .iter()
                .any(|(s, u)| s == system && u == user));
            let packet: Value = serde_json::from_str(user).unwrap();
            if matches!(schema, GenerationSchema::WikiClaimReviewV1(_)) {
                return Ok(if generated.get() == 2 {
                    negative(user, "supported", "missing")
                } else {
                    crate::wiki_claim_review::tests::accepting_review(user)
                });
            }
            let GenerationSchema::WikiSourceFocusClaimsQaV1(decoder) = schema else {
                panic!("unchanged focus schema required")
            };
            assert_eq!(
                decoder.packet_sha256(),
                packet["packetSha256"].as_str().unwrap()
            );
            if packet.get("initialExtractionCorrection").is_none() {
                *initial_user.borrow_mut() = Some(packet.clone());
                let raw = output(&packet, vec![]);
                *previous.borrow_mut() = raw.clone();
                return Ok(raw);
            }
            let initial = initial_user.borrow();
            let initial = initial.as_ref().unwrap();
            for field in [
                "question",
                "language",
                "activityPeriod",
                "recordPeriodContext",
                "originalSpans",
                "allowedSpanIds",
                "spanOrdinalDictionary",
                "independentVerificationReceipts",
            ] {
                assert_eq!(packet[field], initial[field], "{field}");
            }
            assert_eq!(
                packet["initialExtractionCorrection"]["previousModelResult"],
                *previous.borrow()
            );
            assert_eq!(
                packet["initialExtractionCorrection"]["automatedReviewFeedback"]["failureCode"],
                "review_missing"
            );
            assert!(system.contains("Review feedback can be mistaken"));
            Ok(output(&packet, good_claims()))
        },
    )
    .unwrap();
    assert_eq!(generated.get(), 4);
    assert!(result.review_correction_used);
    assert_eq!(
        (
            result.batches,
            result.processed_spans,
            result.claims.claims.len()
        ),
        (1, 2, 4)
    );
    assert_eq!(
        (result.focus_reviews.len(), result.focus_projections.len()),
        (1, 1)
    );
    let proposals = result
        .claims
        .claims
        .iter()
        .map(|claim| serde_json::to_value(&claim.proposal).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(proposals[0]["action"], REQUEST);
    assert_eq!(
        (
            proposals[0]["speechAct"].as_str(),
            proposals[0]["status"].as_str()
        ),
        (Some("request"), Some("requested"))
    );
    assert_eq!(proposals[1]["action"], NEGATION);
    assert_eq!(proposals[1]["status"], "unknown");
    assert_eq!(
        proposals[2]["actor"],
        json!({"role":"source","basis":"explicit_subject","subjectSpanId":"Q0"})
    );
    assert_eq!(
        proposals[2]["eventTime"],
        json!({"value":"2026-10-01","basis":"explicit","precision":"day","uncertainty":"specified","supportSpanId":"Q0"})
    );
    assert_eq!(proposals[3]["action"], PREPARATION);
    assert_eq!(proposals[3]["actor"]["role"], "assistant");
    assert_eq!(proposals[3]["status"], "reported_completed");
    assert!(result
        .claims
        .claims
        .iter()
        .all(|claim| claim.structure_checked && claim.semantic_review_required));
}

#[test]
fn rejected_wrong_actor_time_status_is_replaced_not_merged_or_natively_fixed() {
    let calls = Cell::new(0);
    let result = extract(
        &sources(2),
        &context(true),
        |_, _| Ok(1500),
        |_, user, _, _, schema| {
            calls.set(calls.get() + 1);
            let packet: Value = serde_json::from_str(user).unwrap();
            if matches!(schema, GenerationSchema::WikiClaimReviewV1(_)) {
                return Ok(if calls.get() == 2 {
                    negative(user, "unsupported", "covered")
                } else {
                    crate::wiki_claim_review::tests::accepting_review(user)
                });
            }
            if packet.get("initialExtractionCorrection").is_some() {
                assert_eq!(
                    packet["initialExtractionCorrection"]["automatedReviewFeedback"]["review"]
                        ["claims"][0]["disposition"],
                    "unsupported"
                );
                return Ok(output(&packet, good_claims()));
            }
            Ok(output(
                &packet,
                vec![tuple(
                    0,
                    THIRD_PARTY,
                    "asserted_occurrence",
                    "report",
                    "in_progress",
                )],
            ))
        },
    )
    .unwrap();
    assert_eq!(calls.get(), 4);
    assert_eq!(result.claims.claims.len(), 4);
    let actual = &result.claims.claims[2].proposal;
    assert_eq!(actual.actor.role, ActorRole::Source);
    assert_eq!(
        actual.status,
        crate::wiki_claims::ClaimStatus::ReportedCompleted
    );
    assert_eq!(actual.event_time.value.as_deref(), Some("2026-10-01"));
}

#[test]
fn correction_allowance_is_not_recharged_for_another_initial_batch() {
    let calls = Cell::new(0);
    let result = extract(
        &sources(4),
        &context(true),
        |_, _| Ok(1400),
        |_, user, _, _, schema| {
            calls.set(calls.get() + 1);
            let packet: Value = serde_json::from_str(user).unwrap();
            if matches!(schema, GenerationSchema::WikiClaimReviewV1(_)) {
                return Ok(if calls.get() == 4 {
                    crate::wiki_claim_review::tests::accepting_review(user)
                } else {
                    negative(user, "supported", "missing")
                });
            }
            Ok(output(
                &packet,
                if packet.get("initialExtractionCorrection").is_some() {
                    good_claims()
                } else {
                    vec![]
                },
            ))
        },
    );
    assert!(result.err().unwrap().starts_with("review_missing:"));
    assert_eq!(calls.get(), 6);
}

#[test]
fn source_focus_without_new_opt_in_has_original_system_user_and_no_correction() {
    let expected = PreparedFocusQa::prepare(
        &claim_prompt::payload(
            QUESTION,
            "en",
            &period(),
            &sources(2).spans().collect::<Vec<_>>(),
        )
        .unwrap(),
    )
    .unwrap();
    let calls = Cell::new(0);
    let result = extract(
        &sources(2),
        &context(false),
        |_, _| Ok(1400),
        |system, user, _, _, schema| {
            calls.set(calls.get() + 1);
            if matches!(schema, GenerationSchema::WikiClaimReviewV1(_)) {
                return Ok(negative(user, "supported", "missing"));
            }
            assert_eq!(system, expected.system());
            assert_eq!(user, expected.user());
            assert_eq!(
                schema,
                GenerationSchema::WikiSourceFocusClaimsQaV1(expected.decoder())
            );
            Ok(output(&serde_json::from_str(user).unwrap(), vec![]))
        },
    );
    assert!(result.err().unwrap().starts_with("review_missing:"));
    assert_eq!(calls.get(), 2);
}

#[test]
fn corrected_shape_or_second_review_failure_is_terminal_without_another_attempt() {
    for invalid_shape in [true, false] {
        let calls = Cell::new(0);
        let error = extract(
            &sources(2),
            &context(true),
            |_, _| Ok(1400),
            |_, user, _, _, schema| {
                calls.set(calls.get() + 1);
                let packet: Value = serde_json::from_str(user).unwrap();
                if matches!(schema, GenerationSchema::WikiClaimReviewV1(_)) {
                    return Ok(negative(user, "supported", "missing"));
                }
                if packet.get("initialExtractionCorrection").is_some() {
                    if invalid_shape {
                        return Ok("{}".into());
                    }
                    return Ok(output(&packet, good_claims()));
                }
                Ok(output(&packet, vec![]))
            },
        )
        .err()
        .unwrap();
        if !invalid_shape {
            assert!(error.starts_with("review_missing:"));
        }
        assert_eq!(calls.get(), if invalid_shape { 3 } else { 4 });
    }
}

#[path = "initial_claim_correction_rejection_tests.rs"]
mod rejection_tests;

#[path = "named_initial_correction_tests.rs"]
mod named_initial_correction_tests;
