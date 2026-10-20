//! Synthetic generation/verdicts test control and custody only, never semantic quality.

use super::*;
use crate::commands::DateRange;
use crate::local_generation::{ResolutionMode, ResolutionRequest};
use crate::local_model::GEMMA12B_CANDIDATE;
use crate::retrieval::Scope;
use crate::wiki_claims::{ActorRole, SourceDocument, SpanInput};
use std::cell::{Cell, RefCell};

fn fixture() -> (Request, Vec<Evidence>, SourceSet) {
    let origin = AgentVaultSession {
        vault_path: "/synthetic/direct-reading".into(),
        opening_token: "synthetic-custody-not-native-authority".into(),
    };
    let role = serde_json::from_value(json!({"snapshotId":"synthetic-reading-role",
        "origin":origin,"role":"ask","usage":"foreground","authorizationRevision":"synthetic",
        "routeSignature":{"role":"ask","providerId":"builtin-local","modelId":GEMMA12B_CANDIDATE.id,
        "effort":"none","executionLocation":"in-process","artifactRevision":GEMMA12B_CANDIDATE.revision,
        "artifactSha256":GEMMA12B_CANDIDATE.sha256,"runtimeContract":"synthetic-diagnostic-only",
        "signature":"synthetic-not-a-native-grant"}})).unwrap();
    let first =
        "A curator reports preparing a synthetic exhibit plan; implementation is not recorded.\n";
    let second = "The assistant cannot verify that report. This note contains no later outcome.";
    let raw = format!("{first}{second}");
    let doc = SourceDocument::bind(
        "S-reading".into(),
        "sessions/synthetic.md".into(),
        "sessions/synthetic.md".into(),
        &raw,
        Some("2026-10-04T09:00:00Z".into()),
        vec![
            SpanInput {
                id: "Q-first".into(),
                start: 0,
                end: first.len(),
                turn_id: "T-first".into(),
                speaker: ActorRole::User,
                turn_time: Some("2026-10-03T10:00:00Z".into()),
            },
            SpanInput {
                id: "Q-second".into(),
                start: first.len(),
                end: raw.len(),
                turn_id: "T-second".into(),
                speaker: ActorRole::Assistant,
                turn_time: Some("2026-10-04T08:00:00Z".into()),
            },
        ],
    )
    .unwrap();
    let evidence = vec![Evidence {
        page: "sessions/synthetic.md".into(),
        stem: "Synthetic".into(),
        section: 0,
        text: "Generated summary must never become original evidence".into(),
        title: None,
        compiled: None,
    }];
    let request = Request {
        model_id: Some(GEMMA12B_CANDIDATE.id.into()),
        request_id: "qa-reading-control".into(),
        question: QUESTIONS[0].into(),
        previous_question: None,
        lang: "ko".into(),
        hits: evidence.clone(),
        expected_vault: origin.vault_path.clone(),
        origin: Some(origin.clone()),
        role_snapshot: Some(role),
        scope: Scope::All,
        range: Some(DateRange {
            start: "2026-10-01".into(),
            end: "2026-10-04".into(),
            start_epoch: Some(1790780400),
            end_epoch: Some(1791126000),
        }),
        paths: Some(vec!["sessions/synthetic.md".into()]),
        max_tokens: Some(768),
        activity_overview: true,
        resolution: Some(ResolutionRequest {
            mode: ResolutionMode::HistoricalAsOf,
            as_of_epoch: 1791125999,
            captured_query_epoch: 1792173935,
        }),
    };
    (
        request,
        evidence,
        SourceSet::new(origin, Scope::All, vec![doc], vec![]).unwrap(),
    )
}

fn draft() -> String {
    json!({"answer":"합성 기록에는 전시 계획 준비 보고와 검증 한정이 있으며, 이 메모에 후속 결과가 없다는 범위에서 읽어야 합니다.","sources":["S1"]}).to_string()
}

fn review(disposition: &str) -> String {
    json!({"version":"AskAnswerReviewV1","answerDisposition":disposition,"taskResponse":"adequate",
        "sourceCoverage":"covered","missingSpanIds":[],"reason":"Synthetic control verdict, not semantic proof."}).to_string()
}

#[test]
fn diagnostic_retains_activity_context_and_full_originals_without_product_authority() {
    let (request, evidence, sources) = fixture();
    let expected = serde_json::to_value(sources.spans().collect::<Vec<_>>()).unwrap();
    let mut stages = Vec::new();
    let output = run(
        &request,
        &evidence,
        &sources,
        request.origin.as_ref().unwrap(),
        |_, _| Ok(600),
        |_, user, output, context, schema| {
            assert_eq!((output, context), (768, 4096));
            let payload: Value = serde_json::from_str(user).unwrap();
            assert_eq!(payload["context"]["question"], request.question);
            assert_eq!(payload["context"]["activityPeriod"]["start"], "2026-10-01");
            assert_eq!(
                payload["context"]["resolutionWindow"]["asOfEpoch"],
                1791125999_i64
            );
            let actual = if schema == GenerationSchema::AskAnswerV1 {
                assert!(!user.contains("Generated summary"));
                payload["sources"][0]["originalSpans"].clone()
            } else {
                payload["originalSpans"].clone()
            };
            assert_eq!(actual, expected);
            stages.push(schema);
            Ok(if schema == GenerationSchema::AskAnswerV1 {
                draft()
            } else {
                review("supported")
            })
        },
    )
    .unwrap();
    assert_eq!(
        stages,
        vec![
            GenerationSchema::AskAnswerV1,
            GenerationSchema::AskAnswerReviewV1
        ]
    );
    assert_eq!(output["native_io_authenticated"], false);
    assert_eq!(output["product_role_authorized"], false);
    assert_eq!(output["activityContractAccepted"], false);
    assert_eq!(output["automatedWholeAnswerReviewAccepted"], true);
    assert!(output.get("activityReceipt").is_none());
}

#[test]
fn ordinary_path_still_refuses_the_same_activity_before_generation() {
    let (request, evidence, sources) = fixture();
    let calls = Cell::new(0);
    let error = ordinary_flow::run(
        &request,
        &evidence,
        &sources,
        request.origin.as_ref().unwrap(),
        |_, _| Ok(1),
        |_, _, _, _, _| {
            calls.set(calls.get() + 1);
            Ok(draft())
        },
    )
    .unwrap_err();
    assert_eq!(error.code, "source_verification_failed");
    assert_eq!(calls.get(), 0);
}

#[test]
fn rejected_review_preserves_observed_raw_draft_and_cannot_return_an_answer() {
    let (request, evidence, sources) = fixture();
    let raw = RefCell::new(Vec::new());
    let error = run(
        &request,
        &evidence,
        &sources,
        request.origin.as_ref().unwrap(),
        |_, _| Ok(600),
        |_, _, _, _, schema| {
            let text = if schema == GenerationSchema::AskAnswerV1 {
                draft()
            } else {
                review("unsupported")
            };
            raw.borrow_mut().push(text.clone());
            Ok(text)
        },
    )
    .unwrap_err();
    assert_eq!(error.code, "review_rejected");
    assert_eq!(raw.borrow().len(), 2);
    assert_eq!(raw.borrow()[0], draft());
}

#[test]
fn complete_draft_overflow_has_no_generation_and_review_overflow_keeps_raw_draft() {
    let (request, evidence, sources) = fixture();
    let calls = Cell::new(0);
    let error = run(
        &request,
        &evidence,
        &sources,
        request.origin.as_ref().unwrap(),
        |_, _| Ok(3321),
        |_, _, _, _, _| {
            calls.set(calls.get() + 1);
            Ok(draft())
        },
    )
    .unwrap_err();
    assert_eq!(error.code, "review_not_fit");
    assert_eq!(calls.get(), 0);
    let counts = Cell::new(0);
    let observed = RefCell::new(Vec::new());
    let error = run(
        &request,
        &evidence,
        &sources,
        request.origin.as_ref().unwrap(),
        |_, _| {
            counts.set(counts.get() + 1);
            Ok(if counts.get() == 1 { 600 } else { 3321 })
        },
        |_, _, _, _, _| {
            observed.borrow_mut().push(draft());
            Ok(draft())
        },
    )
    .unwrap_err();
    assert_eq!(error.code, "review_not_fit");
    assert_eq!(observed.borrow().as_slice(), [draft()]);
}

#[test]
fn changed_origin_role_or_unregistered_question_is_rejected_before_generation() {
    for change in 0..3 {
        let (mut request, evidence, sources) = fixture();
        let origin = request.origin.clone().unwrap();
        match change {
            0 => request
                .origin
                .as_mut()
                .unwrap()
                .opening_token
                .push_str("-changed"),
            1 => request
                .role_snapshot
                .as_mut()
                .unwrap()
                .origin
                .opening_token
                .push_str("-changed"),
            _ => request.question = "An unregistered question".into(),
        }
        let calls = Cell::new(0);
        assert!(run(
            &request,
            &evidence,
            &sources,
            &origin,
            |_, _| Ok(1),
            |_, _, _, _, _| {
                calls.set(calls.get() + 1);
                Ok(draft())
            }
        )
        .is_err());
        assert_eq!(calls.get(), 0);
    }
}
