use super::*;
use crate::wiki_claims::{ActorRole, SourceDocument, SpanInput};
use serde_json::{json, Value};

fn context(question: &str) -> AskReviewContext {
    crate::wiki_claim_review::tests::context(question, "en", Scope::Sessions, &range(), &origin())
}

fn origin() -> AgentVaultSession {
    AgentVaultSession {
        vault_path: "/synthetic/vault".into(),
        opening_token: "7".into(),
    }
}

fn range() -> DateRange {
    DateRange {
        start: "2026-10-03".into(),
        end: "2026-10-04".into(),
        start_epoch: None,
        end_epoch: None,
    }
}

fn source_set(count: usize) -> SourceSet {
    let mut documents = Vec::new();
    for ordinal in 0..count {
        let text =
            format!("User request: Add synthetic export button {ordinal}. No outcome recorded.");
        documents.push(
            SourceDocument::bind(
                format!("S{ordinal}"),
                format!("sessions/synthetic-{ordinal}.md"),
                format!("sessions/synthetic-{ordinal}.md"),
                &text,
                Some("2026-10-08".into()),
                vec![SpanInput {
                    id: format!("Q{ordinal}"),
                    start: 0,
                    end: text.len(),
                    turn_id: format!("T{ordinal}"),
                    speaker: ActorRole::User,
                    turn_time: Some("2026-10-03T08:00:00Z".into()),
                }],
            )
            .unwrap(),
        );
    }
    SourceSet::new(origin(), Scope::Sessions, documents, vec![]).unwrap()
}

#[test]
fn source_reading_rejects_future_or_missing_activity_packet_fields() {
    let packet = source_set(1);
    let private = payload(
        "Synthetic recent work",
        "en",
        &range(),
        &packet.spans().collect::<Vec<_>>(),
    )
    .unwrap();
    let original: Value = serde_json::from_str(&private).unwrap();
    assert!(reading_inputs(&private).is_ok());
    let mut added = original.clone();
    added["futureContext"] = json!("must not disappear");
    assert!(reading_inputs(&added.to_string()).is_err());
    for key in original.as_object().unwrap().keys() {
        let mut missing = original.clone();
        missing.as_object_mut().unwrap().remove(key);
        assert!(
            reading_inputs(&missing.to_string()).is_err(),
            "missing {key}"
        );
    }
}

fn proposal(id: &str) -> Value {
    json!({"action":"The synthetic export button was requested; outcome is unknown.",
        "anchorSpanId":id,"supportSpanIds":[id],
        "actor":{"role":"user","basis":"speaker","subjectSpanId":null},
        "eventTime":{"value":null,"basis":"unknown","precision":"unknown","uncertainty":"unknown","supportSpanId":null},
        "speechAct":"request","status":"requested","verificationId":null})
}

#[test]
fn production_extraction_uses_closed_schema_and_keeps_period_and_source_metadata() {
    let set = source_set(2);
    let extracted = extract(
        "Summarize my synthetic recent work.",
        "en",
        &range(),
        &set,
        &origin(),
        Scope::Sessions,
        768,
        |_, _| Ok(1500),
        |system, user, tokens, context, schema| {
            if matches!(schema, GenerationSchema::WikiClaimReviewV1(_)) {
                return Ok(crate::wiki_claim_review::tests::accepting_review(user));
            }
            assert_eq!(schema, GenerationSchema::WikiClaimsV1);
            assert_eq!((tokens, context), (768, 4096));
            assert!(
                system.contains("not semantic")
                    || system.contains("separate source-based semantic review")
            );
            let payload: Value = serde_json::from_str(user).unwrap();
            assert_eq!(
                payload["recordPeriodContext"]["version"],
                "RecordPeriodContextV1"
            );
            assert_eq!(payload["recordPeriodContext"]["spans"][0]["spanId"], "Q0");
            assert_eq!(
                payload["recordPeriodContext"]["spans"][0]["recordPeriodRelation"],
                "in_period"
            );
            assert_eq!(
                payload["recordPeriodContext"]["spans"][0]["recordTimeBasis"],
                "turn"
            );
            assert_eq!(payload["activityPeriod"]["start"], "2026-10-03");
            assert_eq!(payload["activityPeriod"]["end"], "2026-10-04");
            assert_eq!(payload["originalSpans"][0]["speaker"], "user");
            assert_eq!(
                payload["originalSpans"][0]["sourceContext"]["turnTime"],
                "2026-10-03T08:00:00Z"
            );
            assert_eq!(
                payload["originalSpans"][0]["sourceContext"]["recordTime"],
                "2026-10-08"
            );
            assert!(
                payload["originalSpans"][0]["provenance"]["sourceRevision"]
                    .as_str()
                    .unwrap()
                    .len()
                    == 64
            );
            Ok(json!({"outcome":"claims","claims":[proposal("Q0"),proposal("Q1")]}).to_string())
        },
        &context("Summarize my synthetic recent work."),
    )
    .unwrap();
    assert_eq!(
        (
            extracted.eligible_spans,
            extracted.processed_spans,
            extracted.omitted_spans,
            extracted.batches
        ),
        (2, 2, 0, 1)
    );
    assert!(extracted
        .claims
        .claims
        .iter()
        .all(|claim| claim.semantic_review_required));
}

#[test]
fn one_span_fit_keeps_batch_membership_and_rejects_off_packet_claims() {
    let set = source_set(3);
    let error = extract(
        "Synthetic work",
        "en",
        &range(),
        &set,
        &origin(),
        Scope::Sessions,
        768,
        |_, user| {
            let value: Value = serde_json::from_str(user).unwrap();
            Ok(if value["originalSpans"].as_array().unwrap().len() > 1 {
                5000
            } else {
                1500
            })
        },
        |_, _, _, _, _| Ok(json!({"outcome":"claims","claims":[proposal("Q2")]}).to_string()),
        &context("Synthetic work"),
    )
    .err()
    .unwrap();
    assert!(error.contains("outside its current batch"));
}

#[test]
fn insufficient_evidence_is_explicit_and_does_not_claim_quality_or_coverage() {
    let set = source_set(2);
    let extracted = extract(
        "Synthetic work",
        "en",
        &range(),
        &set,
        &origin(),
        Scope::Sessions,
        768,
        |_, _| Ok(1000),
        |_, user, _, _, schema| {
            if matches!(schema, GenerationSchema::WikiClaimReviewV1(_)) {
                Ok(crate::wiki_claim_review::tests::accepting_review(user))
            } else {
                Ok(r#"{"outcome":"insufficient_evidence","claims":[]}"#.into())
            }
        },
        &context("Synthetic work"),
    )
    .unwrap();
    assert_eq!(extracted.claims.outcome, ClaimOutcome::InsufficientEvidence);
    assert_eq!(extracted.processed_spans, 2);
    assert!(extracted.claims.claims.is_empty());
}

#[test]
fn batch_cap_reports_omission_instead_of_full_completion() {
    let set = source_set(25);
    let extracted = extract(
        "Synthetic work",
        "en",
        &range(),
        &set,
        &origin(),
        Scope::Sessions,
        768,
        |_, _| Ok(1000),
        |_, user, _, _, schema| {
            if matches!(schema, GenerationSchema::WikiClaimReviewV1(_)) {
                Ok(crate::wiki_claim_review::tests::accepting_review(user))
            } else {
                Ok(r#"{"outcome":"insufficient_evidence","claims":[]}"#.into())
            }
        },
        &context("Synthetic work"),
    )
    .unwrap();
    assert_eq!(
        (
            extracted.eligible_spans,
            extracted.processed_spans,
            extracted.omitted_spans,
            extracted.batches
        ),
        (25, 24, 1, 12)
    );
}

#[test]
fn missing_context_and_generation_failure_remain_errors() {
    let set = source_set(1);
    let oversized = extract(
        "Synthetic work",
        "en",
        &range(),
        &set,
        &origin(),
        Scope::Sessions,
        768,
        |_, _| Ok(5000),
        |_, _, _, _, _| panic!("oversized source must not generate"),
        &context("Synthetic work"),
    );
    assert!(oversized.err().unwrap().contains("byte-preserving"));
    let failed = extract(
        "Synthetic work",
        "en",
        &range(),
        &set,
        &origin(),
        Scope::Sessions,
        768,
        |_, _| Ok(1000),
        |_, _, _, _, _| Err("synthetic cancelled".into()),
        &context("Synthetic work"),
    );
    assert_eq!(failed.err().unwrap(), "synthetic cancelled");
}

#[test]
fn context_windows_preserve_every_original_byte_and_each_returned_packet_fits() {
    let set = source_set(1);
    let token_count = |system: &str, user: &str| -> Result<usize, String> {
        assert_eq!(system, activity_system());
        let packet: Value = serde_json::from_str(user).unwrap();
        let text = packet["originalSpans"][0]["text"].as_str().unwrap();
        Ok(3280 + text.chars().count())
    };
    let windows = window_sources("Synthetic work", "en", &range(), &set, 768, token_count).unwrap();
    assert_eq!(
        windows.spans().map(|span| span.text()).collect::<String>(),
        set.spans().map(|span| span.text()).collect::<String>()
    );
    assert!(windows.spans().count() > 1);
    for span in windows.spans() {
        let user = payload("Synthetic work", "en", &range(), &[span]).unwrap();
        assert!(token_count(&activity_system(), &user).unwrap() <= 4096 - 768 - 8);
        assert_eq!(span.turn_time(), Some("2026-10-03T08:00:00Z"));
        assert_eq!(span.speaker(), ActorRole::User);
    }
}

#[test]
fn source_bound_but_wrong_meaning_cannot_skip_separate_claim_review() {
    let set = source_set(1);
    let result = extract(
        "Synthetic work",
        "en",
        &range(),
        &set,
        &origin(),
        Scope::Sessions,
        768,
        |_, _| Ok(1000),
        |_, user, _, _, _| {
            let input: Value = serde_json::from_str(user).unwrap();
            if input.get("requiredClaimIds").is_some() {
                Ok(json!({"version":"WikiClaimReviewV1","claims":[{
                    "id":input["requiredClaimIds"][0],"disposition":"unsupported",
                    "reason":"Original asks for work, not completion."}],
                    "missingSpanIds":[],"sourceCoverage":"covered"})
                .to_string())
            } else {
                let mut wrong = proposal("Q0");
                wrong["action"] = json!("A different synthetic button was requested.");
                Ok(json!({"outcome":"claims","claims":[wrong]}).to_string())
            }
        },
        &context("Synthetic work"),
    );
    assert!(
        result
            .err()
            .is_some_and(|error| error.contains("review_rejected")),
        "valid original IDs must not bypass the separate mocked meaning review"
    );
}

#[test]
fn empty_proposals_still_review_original_positive_coverage() {
    let set = source_set(1);
    let result = extract(
        "Synthetic work",
        "en",
        &range(),
        &set,
        &origin(),
        Scope::Sessions,
        768,
        |_, _| Ok(1000),
        |_, user, _, _, _| {
            let input: Value = serde_json::from_str(user).unwrap();
            if input.get("requiredClaimIds").is_some() {
                Ok(json!({"version":"WikiClaimReviewV1","claims":[],
                    "missingSpanIds":["Q0"],"sourceCoverage":"missing"})
                .to_string())
            } else {
                Ok(json!({"outcome":"insufficient_evidence","claims":[]}).to_string())
            }
        },
        &context("Synthetic work"),
    );
    assert!(
        result
            .err()
            .is_some_and(|error| error.contains("review_missing")),
        "empty proposals are not proof that the positive original has no activity"
    );
}

// Synthetic token counts and verdicts exercise scheduling/binding, not model meaning.
#[test]
fn long_first_original_cannot_exhaust_extraction_before_a_distinct_later_turn() {
    use std::cell::RefCell;

    let first = "가".repeat(1000);
    let later = "Request the synthetic box.";
    let documents = [
        (
            "S-long",
            "sessions/long.md",
            "Q-long",
            "T-long",
            first.as_str(),
        ),
        ("S-later", "sessions/later.md", "Q-later", "T-later", later),
    ]
    .into_iter()
    .map(|(source, path, id, turn, text)| {
        SourceDocument::bind(
            source.into(),
            path.into(),
            path.into(),
            text,
            Some("2026-10-04T09:00:00Z".into()),
            vec![SpanInput {
                id: id.into(),
                start: 0,
                end: text.len(),
                turn_id: turn.into(),
                speaker: ActorRole::User,
                turn_time: Some("2026-10-03T08:00:00Z".into()),
            }],
        )
        .unwrap()
    })
    .collect();
    let original = SourceSet::new(origin(), Scope::Sessions, documents, vec![]).unwrap();
    let original_snapshot = serde_json::to_value(original.spans().collect::<Vec<_>>()).unwrap();
    // Real byte-preserving window_sources; this deterministic tokenizer stand-in
    // admits at most 40 Unicode scalars per packet, not real model token counts.
    let count = |_: &str, user: &str| -> Result<usize, String> {
        let input: Value = serde_json::from_str(user).unwrap();
        Ok(3280
            + input["originalSpans"]
                .as_array()
                .unwrap()
                .iter()
                .map(|span| span["text"].as_str().unwrap().chars().count())
                .sum::<usize>())
    };
    let windows = window_sources("Synthetic work", "en", &range(), &original, 768, count).unwrap();
    let before = serde_json::to_value(windows.spans().collect::<Vec<_>>()).unwrap();
    assert_eq!(windows.spans().count(), 26);
    for source in original.spans() {
        let reconstructed = windows
            .spans()
            .filter(|window| window.same_original_turn(source))
            .map(|window| window.text())
            .collect::<String>();
        assert_eq!(reconstructed, source.text());
    }
    let later_id = windows
        .spans()
        .find(|span| span.text() == later)
        .unwrap()
        .id()
        .to_owned();
    let served = RefCell::new(Vec::new());
    let extracted = extract(
        "Synthetic work", "en", &range(), &windows, &origin(), Scope::Sessions, 768, count,
        |_, user, _, _, schema| {
            if matches!(schema, GenerationSchema::WikiClaimReviewV1(_)) {
                return Ok(crate::wiki_claim_review::tests::accepting_review(user));
            }
            assert_eq!(schema, GenerationSchema::WikiClaimsV1);
            let input: Value = serde_json::from_str(user).unwrap();
            let spans = input["originalSpans"].as_array().unwrap();
            served.borrow_mut().extend(spans.iter().map(|span| span["id"].as_str().unwrap().to_owned()));
            let claims: Vec<_> = spans.iter().filter(|span| span["id"] == later_id)
                .map(|span| {
                    let mut claim = proposal(span["id"].as_str().unwrap());
                    claim["action"] = json!(later);
                    claim
                }).collect();
            Ok(json!({"outcome":if claims.is_empty() {"insufficient_evidence"} else {"claims"},"claims":claims}).to_string())
        }, &context("Synthetic work"),
    ).unwrap();
    assert!(served.borrow().contains(&later_id),
        "a long first turn must not consume every extraction batch before a distinct original is visited");
    assert!(extracted.processed_span_ids.contains(&later_id));
    assert_eq!(extracted.claims.claims.len(), 1);
    assert_eq!(
        (
            extracted.eligible_spans,
            extracted.processed_spans,
            extracted.omitted_spans,
            extracted.batches
        ),
        (26, 12, 14, 12)
    );
    assert_eq!(
        serde_json::to_value(windows.spans().collect::<Vec<_>>()).unwrap(),
        before
    );
    assert_eq!(
        serde_json::to_value(original.spans().collect::<Vec<_>>()).unwrap(),
        original_snapshot
    );
    let evidence: Vec<_> = original
        .spans()
        .map(|span| crate::local_synthesis::Evidence {
            page: span.selection_path().into(),
            stem: "Synthetic original".into(),
            section: 0,
            text: span.text().into(),
            title: None,
            compiled: None,
        })
        .collect();
    // This fit callback admits construction solely to inspect closure. It does
    // not assert that this long final packet fits a real 4096-token context.
    let answer = prepare_answer(
        "Synthetic work",
        "en",
        &range(),
        &evidence,
        &windows,
        &extracted,
        |_, _| Ok(true),
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(&answer.selected_originals).unwrap(),
        before,
        "fair extraction must not drop unprocessed backing from final answer/review context"
    );
    let packet: Value = serde_json::from_str(&answer.prompt.user).unwrap();
    assert_eq!(packet["coverage"]["eligibleSpans"], 26);
    assert_eq!(packet["coverage"]["processedSpans"], 12);
    assert_eq!(packet["coverage"]["omittedSpans"], 14);
    let served: std::collections::HashSet<_> = extracted
        .processed_span_ids
        .iter()
        .map(String::as_str)
        .collect();
    assert!(
        answer
            .selected_originals
            .iter()
            .any(|span| !served.contains(span.id())),
        "an unprocessed tail remains mandatory original context"
    );
}

#[test]
fn fair_extraction_keeps_each_batch_in_exact_native_order_for_projection_and_review() {
    use std::cell::RefCell;

    let original = source_set(3);
    let windows = original
        .windowed(|span| {
            let middle = span.text().len() / 2; // This fixture is ASCII.
            Ok(vec![
                span.text()[..middle].into(),
                span.text()[middle..].into(),
            ])
        })
        .unwrap();
    let before: Vec<_> = windows
        .spans()
        .map(|span| serde_json::to_value(span).unwrap())
        .collect();
    let native_ids: Vec<_> = windows.spans().map(|span| span.id().to_owned()).collect();
    for crossing_fits in [true, false] {
        let current_batch = RefCell::new(Vec::<String>::new());
        let served_batches = RefCell::new(Vec::<Vec<String>>::new());
        let extracted = extract(
            "Synthetic work", "en", &range(), &windows, &origin(), Scope::Sessions, 768,
            |_, user| {
                let input: Value = serde_json::from_str(user).unwrap();
                let spans = input["originalSpans"].as_array().unwrap();
                // Exercise both the fitting cross-round pair and singleton fallback.
                // Scheduled C0/A1 must be native A1/C0 when both fit, but a failed
                // pair must fall back to scheduled C0, not sorted-prefix A1.
                Ok(if !crossing_fits && spans.len() > 1 && spans.iter().any(|span| span["id"] == native_ids[4]) {
                    5000
                } else { 1000 })
            },
            |_, user, _, _, schema| {
                let input: Value = serde_json::from_str(user).unwrap();
                let ids: Vec<_> = input["originalSpans"].as_array().unwrap().iter()
                    .map(|span| span["id"].as_str().unwrap().to_owned()).collect();
                if matches!(schema, GenerationSchema::WikiClaimReviewV1(_)) {
                    assert_eq!(ids, *current_batch.borrow(),
                        "the model batch must have the retained native packet's exact ordered originals");
                    return Ok(crate::wiki_claim_review::tests::accepting_review(user));
                }
                let positions: Vec<_> = ids.iter().map(|id| native_ids.iter().position(|native| native == id).unwrap()).collect();
                assert!(positions.windows(2).all(|pair| pair[0] < pair[1]));
                *current_batch.borrow_mut() = ids.clone();
                served_batches.borrow_mut().push(ids);
                Ok(r#"{"outcome":"insufficient_evidence","claims":[]}"#.into())
            }, &context("Synthetic work"),
        ).unwrap();
        // Native [A0,A1,B0,B1,C0,C1] becomes visits A0,B0,C0,A1,B1,C1;
        // selected pairs retain native order, including after singleton fallback.
        let expected = if crossing_fits {
            vec![
                vec![native_ids[0].clone(), native_ids[2].clone()],
                vec![native_ids[1].clone(), native_ids[4].clone()],
                vec![native_ids[3].clone(), native_ids[5].clone()],
            ]
        } else {
            vec![
                vec![native_ids[0].clone(), native_ids[2].clone()],
                vec![native_ids[4].clone()],
                vec![native_ids[1].clone(), native_ids[3].clone()],
                vec![native_ids[5].clone()],
            ]
        };
        assert_eq!(
            *served_batches.borrow(),
            expected,
            "crossing_fits={crossing_fits}"
        );
        let served: Vec<_> = served_batches.borrow().iter().flatten().cloned().collect();
        let unique: std::collections::HashSet<_> = served.iter().map(String::as_str).collect();
        assert_eq!(served.len(), native_ids.len());
        assert_eq!(
            unique.len(),
            native_ids.len(),
            "no scheduled window may be repeated or skipped"
        );
        assert!(native_ids.iter().all(|id| unique.contains(id.as_str())));
        assert_eq!(extracted.processed_span_ids, served);
        assert_eq!(
            (
                extracted.eligible_spans,
                extracted.processed_spans,
                extracted.omitted_spans,
                extracted.batches
            ),
            (6, 6, 0, if crossing_fits { 3 } else { 4 })
        );
        assert_eq!(
            windows
                .spans()
                .map(|span| serde_json::to_value(span).unwrap())
                .collect::<Vec<_>>(),
            before
        );
    }
}
