use super::*;
use crate::retrieval::Scope;
use crate::role_authorization::{RoleId, RoleSnapshot, RoleUsage};
use crate::wiki_claims::{ActorRole, SourceDocument, SpanInput};
use std::cell::{Cell, RefCell};

fn request(origin: &AgentVaultSession) -> Request {
    // Synthetic DTO only: no native registry grant or installed model authority.
    let role: RoleSnapshot = serde_json::from_value(json!({
        "snapshotId":"synthetic-review-probe-role","origin":origin,
        "role":"ask","usage":"foreground","authorizationRevision":"synthetic-revision",
        "routeSignature":{"role":"ask","providerId":"builtin-local",
            "modelId":"synthetic-model-independent-review","effort":"(default)",
            "executionLocation":"in-process","artifactRevision":null,"artifactSha256":null,
            "runtimeContract":"synthetic-only","signature":"synthetic-signature"}
    }))
    .unwrap();
    Request {
        model_id: None,
        request_id: "synthetic-review-probe-request".into(),
        question: "Check the proposed claims against the supplied originals.".into(),
        previous_question: None,
        lang: "en".into(),
        hits: vec![],
        expected_vault: origin.vault_path.clone(),
        origin: Some(origin.clone()),
        role_snapshot: Some(role),
        scope: Scope::All,
        range: None,
        paths: None,
        max_tokens: None,
        activity_overview: false,
        resolution: None,
    }
}

fn fixture() -> (Request, SourceSet, AgentVaultSession, Value) {
    let origin = AgentVaultSession {
        vault_path: "/synthetic/review-probe-vault".into(),
        opening_token: "synthetic-review-probe-opening".into(),
    };
    let header = "# Synthetic original\n";
    let asked = "2026-10-01T08:00:00Z User: Please add the synthetic export button.\n";
    let caveat = "Assistant: Completion and installed-app verification have not been reported.\n";
    let original = format!("{header}{asked}{caveat}Unselected unrelated plan.\n");
    let document = SourceDocument::bind(
        "synthetic_source".into(),
        "raw/synthetic-review.md".into(),
        "wiki/synthetic-review.md".into(),
        &original,
        Some("2026-10-08T01:00:00Z".into()),
        vec![
            SpanInput {
                id: "Q0".into(),
                start: header.len(),
                end: header.len() + asked.len(),
                turn_id: "T0".into(),
                speaker: ActorRole::User,
                turn_time: Some("2026-10-01T08:00:00Z".into()),
            },
            SpanInput {
                id: "Q1".into(),
                start: header.len() + asked.len(),
                end: header.len() + asked.len() + caveat.len(),
                turn_id: "T1".into(),
                speaker: ActorRole::Assistant,
                turn_time: None,
            },
        ],
    )
    .unwrap();
    let sources = SourceSet::new(origin.clone(), Scope::All, vec![document], vec![]).unwrap();
    let proposal = json!({"outcome":"claims","claims":[{
        "action":"Add the synthetic export button","anchorSpanId":"Q0","supportSpanIds":["Q0"],
        "actor":{"role":"user","basis":"speaker","subjectSpanId":null},
        "eventTime":{"value":"2026-10-01T08:00:00Z","basis":"explicit",
            "precision":"instant","uncertainty":"specified","supportSpanId":"Q0"},
        "speechAct":"request","status":"requested","verificationId":null
    }]});
    (request(&origin), sources, origin, proposal)
}

fn mock_verdict(user: &str, disposition: &str, coverage: &str, missing: &[&str]) -> String {
    // This mock tests native transport and verdict handling, not reviewer accuracy.
    let input: Value = serde_json::from_str(user).unwrap();
    json!({"version":"WikiClaimReviewV1",
        "claims":input["requiredClaimIds"].as_array().unwrap().iter().map(|id| {
            json!({"id":id,"disposition":disposition,"reason":"Explicitly mocked plumbing verdict."})
        }).collect::<Vec<_>>(),"missingSpanIds":missing,"sourceCoverage":coverage}).to_string()
}

fn assert_no_authority(observation: &Value) {
    for field in [
        "native_io_authenticated",
        "product_role_authorized",
        "semantic_accepted",
        "production_accepted",
    ] {
        assert_eq!(observation[field], false, "{field}");
    }
}

#[test]
fn production_reviewer_receives_exact_packet_proposal_and_issued_decode_contract() {
    let (request, sources, origin, proposal) = fixture();
    let counted = RefCell::new(None::<(String, String)>);
    let calls = Cell::new(0);
    let expected_spans = serde_json::to_value(sources.spans().collect::<Vec<_>>()).unwrap();
    let observation = run(
        &request,
        &sources,
        &origin,
        &proposal.to_string(),
        |system, user| {
            *counted.borrow_mut() = Some((system.into(), user.into()));
            Ok(3320)
        },
        |system, user, output, context, schema| {
            calls.set(calls.get() + 1);
            assert_eq!(
                counted.borrow().as_ref(),
                Some(&(system.into(), user.into()))
            );
            assert_eq!((output, context), (768, 4096));
            match schema {
                GenerationSchema::WikiClaimReviewV1(decisions) => assert_eq!(decisions.count(), 1),
                other => panic!("wrong reviewer schema: {other:?}"),
            }
            let input: Value = serde_json::from_str(user).unwrap();
            assert_eq!(input["originalSpans"], expected_spans);
            assert_eq!(input["coverageRequiredSpanIds"], json!(["Q0", "Q1"]));
            assert_eq!(input["referenceSpanIds"], json!([]));
            assert_eq!(input["requiredClaimIds"], json!(["C0"]));
            assert_eq!(input["claims"][0]["proposal"], proposal["claims"][0]);
            assert_eq!(input["context"]["activityPeriod"], Value::Null);
            assert_eq!(input["independentVerificationReceipts"], json!([]));
            assert!(input.get("variant").is_none() && input.get("label").is_none());
            Ok(mock_verdict(user, "supported", "covered", &[]))
        },
    )
    .unwrap();
    assert_eq!(calls.get(), 1);
    assert_eq!(observation["automatedReviewAccepted"], true);
    assert_eq!(observation["acceptanceFailure"], Value::Null);
    assert_eq!(observation["proposedClaims"], 1);
    assert_eq!(observation["suppliedOriginalSpans"], 2);
    assert_eq!(observation["claimSourceAndStructureChecked"], true);
    assert_eq!(observation["reviewBindsInput"], true);
    assert_no_authority(&observation);
}

#[test]
fn valid_rejection_uncertainty_and_missing_coverage_are_observations_not_authority() {
    let (request, sources, origin, proposal) = fixture();
    for (disposition, coverage, missing, code) in [
        ("unsupported", "covered", vec![], "review_rejected"),
        ("uncertain", "covered", vec![], "review_uncertain"),
        ("supported", "missing", vec!["Q1"], "review_missing"),
        ("supported", "uncertain", vec![], "review_uncertain"),
    ] {
        let calls = Cell::new(0);
        let observation = run(
            &request,
            &sources,
            &origin,
            &proposal.to_string(),
            |_, _| Ok(1000),
            |_, user, _, _, _| {
                calls.set(calls.get() + 1);
                Ok(mock_verdict(user, disposition, coverage, &missing))
            },
        )
        .unwrap();
        assert_eq!(calls.get(), 1);
        assert_eq!(observation["automatedReviewAccepted"], false);
        assert_eq!(observation["acceptanceFailure"]["code"], code);
        assert!(!observation["acceptanceFailure"]["detail"]
            .as_str()
            .unwrap()
            .is_empty());
        assert_eq!(
            observation["review"]["proposal"]["sourceCoverage"],
            coverage
        );
        assert_no_authority(&observation);
    }
}

fn rejected_before_callbacks(
    request: &Request,
    sources: &SourceSet,
    origin: &AgentVaultSession,
    proposal: &Value,
) -> ActivityFlowFailure {
    run(
        request,
        sources,
        origin,
        &proposal.to_string(),
        |_, _| panic!("invalid input reached tokenizer"),
        |_, _, _, _, _| panic!("invalid input reached model"),
    )
    .unwrap_err()
}

#[test]
fn changed_opening_missing_role_and_invalid_request_shape_fail_before_callbacks() {
    for mutation in 0..11 {
        let (mut request, sources, origin, proposal) = fixture();
        let code = match mutation {
            0 => {
                request.origin = None;
                "source_verification_failed"
            }
            1 => {
                request.origin.as_mut().unwrap().opening_token = "changed".into();
                "source_verification_failed"
            }
            2 => {
                request.expected_vault = "/synthetic/other-vault".into();
                "source_verification_failed"
            }
            3 => {
                request.role_snapshot = None;
                "source_verification_failed"
            }
            4 => {
                request.role_snapshot.as_mut().unwrap().role = RoleId::Compilation;
                "review_invalid"
            }
            5 => {
                request.role_snapshot.as_mut().unwrap().route_signature.role = RoleId::Compilation;
                "review_invalid"
            }
            6 => {
                request.role_snapshot.as_mut().unwrap().usage = RoleUsage::Automatic;
                "review_invalid"
            }
            7 => {
                request.role_snapshot.as_mut().unwrap().origin.opening_token = "changed".into();
                "review_invalid"
            }
            8 => {
                request.question.clear();
                "review_invalid"
            }
            9 => {
                request.lang = "unsupported".into();
                "review_invalid"
            }
            _ => {
                request.activity_overview = true;
                "source_verification_failed"
            }
        };
        assert_eq!(
            rejected_before_callbacks(&request, &sources, &origin, &proposal).code,
            code,
            "request mutation {mutation}"
        );
    }
    let (mut request, sources, origin, proposal) = fixture();
    request.scope = Scope::Wiki;
    assert_eq!(
        rejected_before_callbacks(&request, &sources, &origin, &proposal).code,
        "source_verification_failed"
    );
    let mut reopened = origin.clone();
    reopened.opening_token = "synthetic-reopened-token".into();
    assert_eq!(
        rejected_before_callbacks(&self::request(&reopened), &sources, &reopened, &proposal).code,
        "source_verification_failed"
    );
}

#[test]
fn native_invalid_proposals_are_precheck_failures_not_model_reviewed_rejections() {
    let (request, sources, origin, proposal) = fixture();
    for mutation in 0..7 {
        let mut invalid = proposal.clone();
        match mutation {
            0 => invalid["claims"][0]["anchorSpanId"] = json!("unknown_span"),
            1 => invalid["claims"][0]["actor"]["role"] = json!("assistant"),
            2 => invalid["claims"][0]["eventTime"]["value"] = json!("2026-10-02T08:00:00Z"),
            3 => invalid["claims"][0]["status"] = json!("reported_completed"),
            4 => invalid["claims"][0]["verificationId"] = json!("fabricated_receipt"),
            5 => invalid["semanticAccepted"] = json!(true),
            _ => invalid["outcome"] = json!("insufficient_evidence"),
        }
        assert_eq!(
            rejected_before_callbacks(&request, &sources, &origin, &invalid).code,
            "claim_extraction_failed",
            "proposal mutation {mutation}"
        );
    }
}

#[test]
fn absent_coverage_and_full_packet_overflow_do_not_call_the_model() {
    let (request, sources, origin, proposal) = fixture();
    let empty = SourceSet::new(origin.clone(), Scope::All, vec![], vec![]).unwrap();
    assert_eq!(
        rejected_before_callbacks(
            &request,
            &empty,
            &origin,
            &json!({"outcome":"insufficient_evidence","claims":[]})
        )
        .code,
        "review_invalid"
    );
    let error = run(
        &request,
        &sources,
        &origin,
        &proposal.to_string(),
        |_, user| {
            let input: Value = serde_json::from_str(user).unwrap();
            assert_eq!(input["originalSpans"].as_array().unwrap().len(), 2);
            Ok(3321)
        },
        |_, _, _, _, _| panic!("oversized packet reached model"),
    )
    .unwrap_err();
    assert_eq!(error.code, "review_not_fit");
}

#[test]
fn empty_proposals_still_review_every_supplied_original_with_zero_issued_decisions() {
    let (request, sources, origin, _) = fixture();
    let calls = Cell::new(0);
    let observation = run(
        &request,
        &sources,
        &origin,
        r#"{"outcome":"insufficient_evidence","claims":[]}"#,
        |_, _| Ok(1000),
        |_, user, output, context, schema| {
            calls.set(calls.get() + 1);
            assert_eq!((output, context), (768, 4096));
            match schema {
                GenerationSchema::WikiClaimReviewV1(decisions) => assert_eq!(decisions.count(), 0),
                other => panic!("wrong reviewer schema: {other:?}"),
            }
            let input: Value = serde_json::from_str(user).unwrap();
            assert_eq!(input["coverageRequiredSpanIds"], json!(["Q0", "Q1"]));
            assert_eq!(input["originalSpans"].as_array().unwrap().len(), 2);
            assert_eq!(input["requiredClaimIds"], json!([]));
            Ok(mock_verdict(user, "supported", "missing", &["Q0", "Q1"]))
        },
    )
    .unwrap();
    assert_eq!(calls.get(), 1);
    assert_eq!(observation["automatedReviewAccepted"], false);
    assert_eq!(observation["acceptanceFailure"]["code"], "review_missing");
    assert_eq!(observation["proposedClaims"], 0);
    assert_no_authority(&observation);
}

#[test]
fn malformed_generated_coverage_and_unavailable_generation_remain_technical_failures() {
    let (request, sources, origin, proposal) = fixture();
    for mutation in 0..4 {
        let calls = Cell::new(0);
        let error = run(
            &request,
            &sources,
            &origin,
            &proposal.to_string(),
            |_, _| Ok(1000),
            |_, user, _, _, _| {
                calls.set(calls.get() + 1);
                let mut verdict: Value =
                    serde_json::from_str(&mock_verdict(user, "supported", "covered", &[])).unwrap();
                match mutation {
                    0 => {
                        verdict["sourceCoverage"] = json!("missing");
                        verdict["missingSpanIds"] = json!(["invented"]);
                    }
                    1 => verdict["missingSpanIds"] = json!(["Q1"]),
                    2 => verdict["claims"][0]["id"] = json!("C999"),
                    _ => {
                        verdict["claims"] =
                            json!([verdict["claims"][0].clone(), verdict["claims"][0].clone()])
                    }
                }
                Ok(verdict.to_string())
            },
        )
        .unwrap_err();
        assert_eq!(calls.get(), 1);
        assert_eq!(error.code, "review_invalid");
    }
    for (detail, expected) in [
        ("model unavailable", "review_unavailable"),
        ("stopped", "review_stopped"),
    ] {
        let error = run(
            &request,
            &sources,
            &origin,
            &proposal.to_string(),
            |_, _| Ok(1000),
            |_, _, _, _, _| Err(detail.into()),
        )
        .unwrap_err();
        assert_eq!(error.code, expected);
        assert!(error.detail.contains(detail));
    }
}

#[test]
fn all_frozen_development_variants_reach_native_review_without_label_leakage() {
    // Frozen synthetic cases and mocked verdicts prove admission/transport only.
    // Meaning labels are never consulted to generate or accept a verdict here.
    let pairs: Value =
        serde_json::from_str(include_str!("../../eval/local-wiki-v1/review-pairs.json")).unwrap();
    let corpus: Value =
        serde_json::from_str(include_str!("../../eval/local-wiki-v1/corpus.json")).unwrap();
    let (_, _, origin, _) = fixture();
    let request = request(&origin);
    let mut scheduled = 0;
    for pair in pairs["pairs"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|pair| pair["split"] == "development")
    {
        let raw = corpus["sources"]
            .as_array()
            .unwrap()
            .iter()
            .find(|source| source["id"] == pair["source"]["originalSourceId"])
            .unwrap();
        let span = &pair["originalSpan"];
        let document = SourceDocument::bind(
            pair["source"]["id"].as_str().unwrap().into(),
            pair["source"]["path"].as_str().unwrap().into(),
            "wiki/synthetic-review-pair.md".into(),
            raw["text"].as_str().unwrap(),
            Some(pair["source"]["importedAt"].as_str().unwrap().into()),
            vec![SpanInput {
                id: span["id"].as_str().unwrap().into(),
                start: span["startByte"].as_u64().unwrap() as usize,
                end: span["endByte"].as_u64().unwrap() as usize,
                turn_id: "synthetic-frozen-turn".into(),
                speaker: serde_json::from_value(span["speakerRole"].clone()).unwrap(),
                turn_time: Some(span["turnTime"].as_str().unwrap().into()),
            }],
        )
        .unwrap();
        let sources = SourceSet::new(origin.clone(), Scope::All, vec![document], vec![]).unwrap();
        let native_span = serde_json::to_value(sources.spans().next().unwrap()).unwrap();
        assert_eq!(native_span["sourceRevision"], pair["source"]["sha256"]);
        assert_eq!(native_span["sha256"], span["sha256"]);
        assert_eq!(native_span["text"], span["text"]);
        for case in pair["cases"].as_array().unwrap() {
            scheduled += 1;
            let calls = Cell::new(0);
            let observation = run(
                &request,
                &sources,
                &origin,
                &case["proposal"].to_string(),
                |_, _| Ok(1000),
                |_, user, output, context, schema| {
                    calls.set(calls.get() + 1);
                    assert_eq!((output, context), (768, 4096));
                    match schema {
                        GenerationSchema::WikiClaimReviewV1(decisions) => {
                            assert_eq!(decisions.count(), 1)
                        }
                        other => panic!("wrong reviewer schema: {other:?}"),
                    }
                    let input: Value = serde_json::from_str(user).unwrap();
                    assert_eq!(input["originalSpans"], json!([native_span]));
                    assert_eq!(input["coverageRequiredSpanIds"], json!([span["id"]]));
                    assert_eq!(
                        input["claims"][0]["proposal"],
                        case["proposal"]["claims"][0]
                    );
                    assert!(input.get("label").is_none() && input.get("variant").is_none());
                    assert!(input.get("expectedVerdict").is_none());
                    Ok(mock_verdict(user, "unsupported", "covered", &[]))
                },
            )
            .unwrap();
            assert_eq!(calls.get(), 1, "{}", case["id"]);
            assert_eq!(observation["acceptanceFailure"]["code"], "review_rejected");
            assert_no_authority(&observation);
        }
    }
    assert_eq!(
        scheduled, 32,
        "every frozen development verdict remains scheduled"
    );
}
