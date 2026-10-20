use super::*;
use crate::wiki_claims::{ActorRole, SourceDocument, SpanInput};

pub(crate) fn context(
    question: &str,
    language: &str,
    scope: Scope,
    period: &DateRange,
    origin: &AgentVaultSession,
) -> AskReviewContext {
    // DTO shape only: no native registry grant or semantic authority is issued.
    let role:RoleSnapshot=serde_json::from_value(json!({"snapshotId":"synthetic-review-role",
        "origin":origin,"role":"ask","usage":"foreground","authorizationRevision":"synthetic-revision",
        "routeSignature":{"role":"ask","providerId":"builtin-local","modelId":crate::local_model::MODEL.id,
            "effort":"(default)","executionLocation":"in-process","artifactRevision":null,"artifactSha256":null,
            "runtimeContract":"synthetic-only","signature":"synthetic-signature"}})).unwrap();
    AskReviewContext::new(
        origin,
        &role,
        "synthetic-review-request",
        question,
        language,
        scope,
        period,
        None,
        None,
    )
    .unwrap()
}
pub(crate) fn accepting_review(user: &str) -> String {
    let input: Value = serde_json::from_str(user).unwrap();
    json!({"version":"WikiClaimReviewV1","claims":input["requiredClaimIds"].as_array().unwrap().iter()
        .map(|id|json!({"id":id,"disposition":"supported","reason":"Synthetic plumbing verdict, not semantic proof."})).collect::<Vec<_>>(),
        "missingSpanIds":[],"sourceCoverage":"covered"}).to_string()
}
pub(crate) fn fixture() -> (SourceSet, CheckedClaims, AskReviewContext) {
    let origin = AgentVaultSession {
        vault_path: "/synthetic/review-vault".into(),
        opening_token: "synthetic-opening".into(),
    };
    let text = "Please add the synthetic export button. Completion has not been reported.";
    let document = SourceDocument::bind(
        "source".into(),
        "sessions/review.md".into(),
        "sessions/review.md".into(),
        text,
        None,
        vec![SpanInput {
            id: "Q0".into(),
            start: 0,
            end: text.len(),
            turn_id: "T0".into(),
            speaker: ActorRole::User,
            turn_time: None,
        }],
    )
    .unwrap();
    let packet = SourceSet::new(origin.clone(), Scope::Sessions, vec![document], vec![]).unwrap();
    let claims=packet.validate(&json!({"outcome":"claims","claims":[{"action":"The synthetic export button was requested.",
        "anchorSpanId":"Q0","supportSpanIds":["Q0"],"actor":{"role":"user","basis":"speaker","subjectSpanId":null},
        "eventTime":{"value":null,"basis":"unknown","precision":"unknown","uncertainty":"unknown","supportSpanId":null},
        "speechAct":"request","status":"requested","verificationId":null}]}).to_string(),&origin,Scope::Sessions).unwrap();
    let period = DateRange {
        start: "2026-10-01".into(),
        end: "2026-10-04".into(),
        start_epoch: None,
        end_epoch: None,
    };
    let context = context("Synthetic work", "en", Scope::Sessions, &period, &origin);
    (packet, claims, context)
}
#[test]
fn separate_mock_review_binds_full_originals_without_semantic_verification() {
    let (packet, claims, context) = fixture();
    let review = run(
        &context,
        &packet,
        &claims,
        |_, _| Ok(1000),
        |system, user, output, tokens, decisions| {
            assert!(system.contains("ENTIRE"));
            assert_eq!((output, tokens), (768, 4096));
            assert_eq!(decisions.count(), 1);
            let input: Value = serde_json::from_str(user).unwrap();
            assert_eq!(input["originalSpans"][0]["speaker"], "user");
            assert!(input["originalSpans"][0]["text"]
                .as_str()
                .unwrap()
                .contains("Completion has not"));
            Ok(accepting_review(user))
        },
    )
    .unwrap();
    assert!(review.require_accepted().is_ok());
    assert!(review.binds(&context, &packet, &claims));
    assert_eq!(review.input_revision().len(), 64);
    let mut changed = claims.clone();
    changed.claims[0].proposal.action = "Different synthetic action".into();
    assert!(!review.binds(&context, &packet, &changed));
}
#[test]
fn unsupported_uncertain_and_missing_verdicts_remain_distinct() {
    let (packet, claims, context) = fixture();
    for (disposition, coverage, missing, code) in [
        ("unsupported", "covered", vec![], "review_rejected"),
        ("uncertain", "covered", vec![], "review_uncertain"),
        ("supported", "missing", vec!["Q0"], "review_missing"),
        ("supported", "uncertain", vec![], "review_uncertain"),
    ] {
        let review=run(&context,&packet,&claims,|_,_|Ok(1000),|_,_,_,_,_|Ok(json!({"version":"WikiClaimReviewV1",
            "claims":[{"id":"C0","disposition":disposition,"reason":"Synthetic review disposition."}],
            "missingSpanIds":missing,"sourceCoverage":coverage}).to_string())).unwrap();
        assert_eq!(review.require_accepted().unwrap_err().code(), code);
    }
}
#[test]
fn missing_duplicate_invented_or_forged_decisions_fail_closed() {
    let (packet, claims, context) = fixture();
    for mutation in 0..7 {
        let error = run(
            &context,
            &packet,
            &claims,
            |_, _| Ok(1000),
            |_, user, _, _, _| {
                let mut value: Value = serde_json::from_str(&accepting_review(user)).unwrap();
                match mutation {
                    0 => value["claims"] = json!([]),
                    1 => {
                        value["claims"] =
                            json!([value["claims"][0].clone(), value["claims"][0].clone()])
                    }
                    2 => value["claims"][0]["id"] = json!("C999"),
                    3 => value["semanticPassed"] = json!(true),
                    4 => value["claims"][0]["reason"] = json!("escaped\u{0000}control"),
                    5 => value["missingSpanIds"] = json!(["Q0"]),
                    _ => value["version"] = json!("SessionReviewV1"),
                }
                Ok(value.to_string())
            },
        )
        .unwrap_err();
        assert_eq!(error.code(), "review_invalid");
    }
}

#[test]
fn two_claim_review_preserves_actual_statuses_and_missing_qualifications() {
    // Packet/validator regression with mocked verdicts, not reviewer accuracy.
    let (_, _, context) = fixture();
    let requested = "Please prepare the synthetic catalog outline.\n";
    let reported = "I prepared the synthetic catalog outline. Publication and verification have not been performed.";
    let text = format!("{requested}{reported}");
    let document = SourceDocument::bind(
        "catalog".into(),
        "sessions/catalog.md".into(),
        "sessions/catalog.md".into(),
        &text,
        None,
        vec![
            SpanInput {
                id: "Q0".into(),
                start: 0,
                end: requested.len(),
                turn_id: "T0".into(),
                speaker: ActorRole::User,
                turn_time: None,
            },
            SpanInput {
                id: "Q1".into(),
                start: requested.len(),
                end: text.len(),
                turn_id: "T1".into(),
                speaker: ActorRole::Assistant,
                turn_time: None,
            },
        ],
    )
    .unwrap();
    let packet = SourceSet::new(
        context.origin.clone(),
        context.scope,
        vec![document],
        vec![],
    )
    .unwrap();
    let proposed = [
        ("Q0", "user", "request", "requested"),
        ("Q1", "assistant", "report", "reported_completed"),
    ]
    .into_iter()
    .map(|(span, role, speech, status)| {
        json!({
            "action":"Prepare the synthetic catalog outline",
            "anchorSpanId":span,"supportSpanIds":[span],
            "actor":{"role":role,"basis":"speaker","subjectSpanId":null},
            "eventTime":{"value":null,"basis":"unknown","precision":"unknown",
                "uncertainty":"unknown","supportSpanId":null},
            "speechAct":speech,"status":status,"verificationId":null,
        })
    })
    .collect::<Vec<_>>();
    let claims = packet
        .validate(
            &json!({"outcome":"claims","claims":proposed}).to_string(),
            &context.origin,
            context.scope,
        )
        .unwrap();
    for omit_second in [false, true] {
        let result = run(
            &context,
            &packet,
            &claims,
            |_, _| Ok(1000),
            |_, user, _, _, _| {
                let input: Value = serde_json::from_str(user).unwrap();
                assert_eq!(input["requiredClaimIds"], json!(["C0", "C1"]));
                assert_eq!(input["claims"][0]["proposal"]["speechAct"], "request");
                assert_eq!(input["claims"][0]["proposal"]["status"], "requested");
                assert_eq!(input["claims"][1]["proposal"]["speechAct"], "report");
                assert_eq!(
                    input["claims"][1]["proposal"]["status"],
                    "reported_completed"
                );
                assert!(input["originalSpans"][1]["text"]
                    .as_str()
                    .unwrap()
                    .contains("Publication and verification have not been performed"));
                assert_eq!(input["independentVerificationReceipts"], json!([]));
                let mut verdict: Value = serde_json::from_str(&accepting_review(user)).unwrap();
                verdict["sourceCoverage"] = json!("missing");
                verdict["missingSpanIds"] = json!(["Q1"]);
                if omit_second {
                    verdict["claims"].as_array_mut().unwrap().pop();
                }
                Ok(verdict.to_string())
            },
        );
        if omit_second {
            assert_eq!(result.unwrap_err().code(), "review_invalid");
        } else {
            assert_eq!(
                result.unwrap().require_accepted().unwrap_err().code(),
                "review_missing"
            );
        }
    }
}
#[test]
fn empty_claims_still_read_full_packet_and_do_not_hide_missing_work() {
    let (packet, _, context) = fixture();
    let empty = packet
        .validate(
            r#"{"outcome":"insufficient_evidence","claims":[]}"#,
            &context.origin,
            context.scope,
        )
        .unwrap();
    let review=run(&context,&packet,&empty,|_,_|Ok(1000),|_,user,_,_,decisions| {
        let input:Value=serde_json::from_str(user).unwrap();
        assert_eq!(input["originalSpans"].as_array().unwrap().len(),1);
        assert_eq!(input["requiredClaimIds"],json!([]));
        assert_eq!(decisions.count(), 0);
        Ok(json!({"version":"WikiClaimReviewV1","claims":[],"missingSpanIds":["Q0"],"sourceCoverage":"missing"}).to_string())
    }).unwrap();
    assert_eq!(
        review.require_accepted().unwrap_err().code(),
        "review_missing"
    );
}

#[test]
fn decode_contract_is_issued_from_checked_claims_not_request_text() {
    // Repeated synthetic claims test the shape boundary, not meaning quality.
    let (packet, original, context) = fixture();
    for count in [0, 1, 2, 16] {
        let mut claims = original.clone();
        claims.claims = vec![original.claims[0].clone(); count];
        claims.outcome = if count == 0 {
            crate::wiki_claims::ClaimOutcome::InsufficientEvidence
        } else {
            crate::wiki_claims::ClaimOutcome::Claims
        };
        run(
            &context,
            &packet,
            &claims,
            |_, _| Ok(1000),
            |_, user, _, _, decisions| {
                assert_eq!(decisions.count(), count);
                let input: Value = serde_json::from_str(user).unwrap();
                assert_eq!(
                    input["requiredClaimIds"],
                    json!((0..count)
                        .map(|index| format!("C{index}"))
                        .collect::<Vec<_>>())
                );
                assert_eq!(input["originalSpans"].as_array().unwrap().len(), 1);
                Ok(accepting_review(user))
            },
        )
        .unwrap();
    }
    let mut too_many = original.clone();
    too_many.claims = vec![original.claims[0].clone(); 17];
    assert_eq!(
        run(
            &context,
            &packet,
            &too_many,
            |_, _| panic!("invalid decision count must not tokenize"),
            |_, _, _, _, _| panic!("invalid decision count must not generate")
        )
        .unwrap_err()
        .code(),
        "review_invalid"
    );
}
#[test]
fn no_fit_unavailable_cancelled_and_invalid_outputs_create_no_receipt() {
    let (packet, claims, context) = fixture();
    assert_eq!(
        run(
            &context,
            &packet,
            &claims,
            |_, _| Ok(5000),
            |_, _, _, _, _| panic!("must not generate")
        )
        .unwrap_err()
        .code(),
        "review_not_fit"
    );
    for (output, code) in [
        (Err("model missing".into()), "review_unavailable"),
        (Err("local generation cancelled".into()), "review_stopped"),
        (Ok("{}".into()), "review_invalid"),
    ] {
        assert_eq!(
            run(
                &context,
                &packet,
                &claims,
                |_, _| Ok(1000),
                |_, _, _, _, _| output.clone()
            )
            .unwrap_err()
            .code(),
            code
        );
    }
}

#[test]
fn later_coverage_reads_initial_reference_without_requiring_its_activity_twice() {
    let (_, _, context) = fixture();
    let initial = "Please add the synthetic export button.\n";
    let later = "No additional outcome is reported in this later original.";
    let text = format!("{initial}{later}");
    let document = SourceDocument::bind(
        "relation".into(),
        "sessions/review.md".into(),
        "sessions/review.md".into(),
        &text,
        None,
        vec![
            SpanInput {
                id: "I0".into(),
                start: 0,
                end: initial.len(),
                turn_id: "T0".into(),
                speaker: ActorRole::User,
                turn_time: None,
            },
            SpanInput {
                id: "L0".into(),
                start: initial.len(),
                end: text.len(),
                turn_id: "T1".into(),
                speaker: ActorRole::Assistant,
                turn_time: None,
            },
        ],
    )
    .unwrap();
    let packet = SourceSet::new(
        context.origin.clone(),
        context.scope,
        vec![document],
        vec![],
    )
    .unwrap();
    let empty = packet
        .validate(
            r#"{"outcome":"insufficient_evidence","claims":[]}"#,
            &context.origin,
            context.scope,
        )
        .unwrap();
    let required = vec!["L0".to_owned()];
    let review = run_with_coverage(
        &context,
        &packet,
        &empty,
        &required,
        |_, _| Ok(1000),
        |_, user, _, _, _| {
            let input: Value = serde_json::from_str(user).unwrap();
            assert_eq!(input["originalSpans"].as_array().unwrap().len(), 2);
            assert_eq!(input["referenceSpanIds"], json!(["I0"]));
            assert_eq!(input["coverageRequiredSpanIds"], json!(["L0"]));
            Ok(accepting_review(user))
        },
    )
    .unwrap();
    assert!(review.require_accepted().is_ok());
    assert!(review.binds_with_coverage(&context, &packet, &empty, &required));
    assert!(!review.binds(&context, &packet, &empty));
    assert!(!review.binds_with_coverage(&context, &packet, &empty, &["I0".into()]));
    for invalid in [
        vec![],
        vec!["L0".to_owned(), "L0".to_owned()],
        vec!["outside".to_owned()],
    ] {
        assert_eq!(
            run_with_coverage(
                &context,
                &packet,
                &empty,
                &invalid,
                |_, _| Ok(1000),
                |_, _, _, _, _| panic!("invalid coverage must not generate")
            )
            .unwrap_err()
            .code(),
            "review_invalid"
        );
    }
    let invalid=run_with_coverage(&context,&packet,&empty,&required,|_,_|Ok(1000),|_,_,_,_,_|Ok(json!({
        "version":"WikiClaimReviewV1","claims":[],"missingSpanIds":["I0"],"sourceCoverage":"missing"}).to_string())).unwrap_err();
    assert_eq!(invalid.code(), "review_invalid");
}

fn question_context_inputs() -> (AgentVaultSession, RoleSnapshot) {
    let origin = AgentVaultSession {
        vault_path: "/synthetic/review-vault".into(),
        opening_token: "synthetic-opening".into(),
    };
    // Synthetic DTO only: no actual native execution authority is issued.
    let role = serde_json::from_value(json!({
        "snapshotId": "synthetic-question-role",
        "origin": origin,
        "role": "ask",
        "usage": "foreground",
        "authorizationRevision": "synthetic-revision",
        "routeSignature": {
            "role": "ask",
            "providerId": "builtin-local",
            "modelId": crate::local_model::MODEL.id,
            "effort": "(default)",
            "executionLocation": "in-process",
            "artifactRevision": null,
            "artifactSha256": null,
            "runtimeContract": "synthetic-only",
            "signature": "synthetic-signature",
        },
    }))
    .unwrap();
    (origin, role)
}

#[test]
fn ordinary_question_has_no_invented_period_or_previous_date_inheritance() {
    let (origin, role) = question_context_inputs();
    let previous = "What happened on 2026-01-03?";
    let context = AskReviewContext::for_question(
        &origin,
        &role,
        "synthetic-question",
        "Why does that matter?",
        Some(previous),
        "en",
        Scope::Sessions,
        None,
        None,
    )
    .unwrap();
    assert_eq!(context.payload()["activityPeriod"], Value::Null);
    assert_eq!(context.payload()["requestedPeriod"], Value::Null);
    assert_eq!(context.payload()["resolutionWindow"], Value::Null);
    assert_eq!(
        context.payload()["previousQuestion"],
        json!({"kind": "topic_only", "question": previous})
    );
    assert!(context.payload().get("previousAnswer").is_none());
    assert!(context.matches_question_request(
        &origin,
        &role,
        "synthetic-question",
        "Why does that matter?",
        Some(previous),
        "en",
        Scope::Sessions,
        None,
        None,
    ));
}

#[test]
fn ordinary_explicit_period_is_a_distinct_retrieval_binding() {
    let (origin, role) = question_context_inputs();
    let period = DateRange {
        start: "2026-10-01".into(),
        end: "2026-10-04".into(),
        start_epoch: Some(1790794800),
        end_epoch: Some(1791140400),
    };
    let undated = AskReviewContext::for_question(
        &origin,
        &role,
        "synthetic-question",
        "What does the note say?",
        None,
        "en",
        Scope::Sessions,
        None,
        None,
    )
    .unwrap();
    let dated = AskReviewContext::for_question(
        &origin,
        &role,
        "synthetic-question",
        "What does the note say?",
        None,
        "en",
        Scope::Sessions,
        Some(&period),
        None,
    )
    .unwrap();
    assert_eq!(dated.payload()["activityPeriod"], Value::Null);
    assert_eq!(dated.payload()["requestedPeriod"], period_value(&period));
    assert_ne!(dated.revision(), undated.revision());
    assert_ne!(dated.period_revision, undated.period_revision);
    assert!(dated.matches_question_request(
        &origin,
        &role,
        "synthetic-question",
        "What does the note say?",
        None,
        "en",
        Scope::Sessions,
        Some(&period),
        None,
    ));
    assert!(!dated.matches_question_request(
        &origin,
        &role,
        "synthetic-question",
        "What does the note say?",
        None,
        "en",
        Scope::Sessions,
        None,
        None,
    ));
    assert!(!dated.matches(
        "What does the note say?",
        "en",
        &period,
        &origin,
        Scope::Sessions,
    ));
}

#[test]
fn ordinary_period_rejects_invalid_civil_days_or_unpaired_epoch_bounds() {
    let (origin, role) = question_context_inputs();
    for (start, end, start_epoch, end_epoch) in [
        ("2026-02-30", "2026-03-01", None, None),
        ("2026-10-04", "2026-10-01", None, None),
        ("2026-10-01", "2026-10-04", Some(1), None),
        ("2026-10-01", "2026-10-04", None, Some(2)),
        ("2026-10-01", "2026-10-04", Some(2), Some(2)),
        ("2026-10-01", "2026-10-04", Some(3), Some(2)),
    ] {
        let period = DateRange {
            start: start.into(),
            end: end.into(),
            start_epoch,
            end_epoch,
        };
        let error = AskReviewContext::for_question(
            &origin,
            &role,
            "synthetic-question",
            "What does the note say?",
            None,
            "en",
            Scope::Sessions,
            Some(&period),
            None,
        )
        .unwrap_err();
        assert_eq!(error.code(), "review_invalid");
    }
}

#[test]
fn ordinary_topic_is_bounded_and_blank_topics_match_prepare_normalization() {
    let (origin, role) = question_context_inputs();
    let absent = AskReviewContext::for_question(
        &origin,
        &role,
        "synthetic-question",
        "What does the note say?",
        None,
        "en",
        Scope::Sessions,
        None,
        None,
    )
    .unwrap();
    assert_eq!(absent.payload()["previousQuestion"], Value::Null);
    assert!(absent.matches_question_request(
        &origin,
        &role,
        "synthetic-question",
        "What does the note say?",
        Some(" \n\t "),
        "en",
        Scope::Sessions,
        None,
        None,
    ));
    let long_topic = "가".repeat(2001);
    let error = AskReviewContext::for_question(
        &origin,
        &role,
        "synthetic-question",
        "What does the note say?",
        Some(&long_topic),
        "en",
        Scope::Sessions,
        None,
        None,
    )
    .unwrap_err();
    assert_eq!(error.code(), "review_invalid");
    let maximum_topic = "가".repeat(2000);
    let bounded = AskReviewContext::for_question(
        &origin,
        &role,
        "synthetic-question",
        "What does the note say?",
        Some(&maximum_topic),
        "en",
        Scope::Sessions,
        None,
        None,
    )
    .unwrap();
    assert_eq!(
        bounded.payload()["previousQuestion"]["question"],
        json!(maximum_topic)
    );
}

#[test]
fn ordinary_request_match_binds_attempt_role_question_language_scope_period_and_paths() {
    let (origin, role) = question_context_inputs();
    let paths = ["sessions/review.md".to_owned()];
    let context = AskReviewContext::for_question(
        &origin,
        &role,
        "synthetic-question",
        "Why does that matter?",
        Some("The synthetic export button"),
        "en",
        Scope::Sessions,
        None,
        Some(&paths),
    )
    .unwrap();
    let exact_matches = |candidate: &AskReviewContext| {
        candidate.matches_question_request(
            &origin,
            &role,
            "synthetic-question",
            "Why does that matter?",
            Some("The synthetic export button"),
            "en",
            Scope::Sessions,
            None,
            Some(&paths),
        )
    };
    assert!(exact_matches(&context));
    for mutation in 0..13 {
        let mut changed_origin = origin.clone();
        let mut changed_role = role.clone();
        let mut request_id = "synthetic-question";
        let mut question = "Why does that matter?";
        let mut previous = Some("The synthetic export button");
        let mut language = "en";
        let mut scope = Scope::Sessions;
        let mut changed_paths = Some(paths.as_slice());
        let period = DateRange {
            start: "2026-10-01".into(),
            end: "2026-10-04".into(),
            start_epoch: None,
            end_epoch: None,
        };
        let mut changed_period = None;
        match mutation {
            0 => request_id = "synthetic-other-attempt",
            1 => question = "What happened instead?",
            2 => previous = Some("A different synthetic topic"),
            3 => language = "ko",
            4 => scope = Scope::All,
            5 => changed_paths = None,
            6 => changed_period = Some(&period),
            7 => changed_role.snapshot_id = "synthetic-other-grant".into(),
            8 => changed_role.authorization_revision = "synthetic-new-revision".into(),
            9 => {
                changed_origin.opening_token = "synthetic-reopened".into();
                changed_role.origin = changed_origin.clone();
            }
            10 => changed_role.route_signature.model_id = "synthetic-other-model".into(),
            11 => changed_role.route_signature.provider_id = "synthetic-other-provider".into(),
            _ => changed_role.route_signature.effort = "synthetic-other-effort".into(),
        }
        let changed = AskReviewContext::for_question(
            &changed_origin,
            &changed_role,
            request_id,
            question,
            previous,
            language,
            scope,
            changed_period,
            changed_paths,
        )
        .unwrap();
        assert!(!exact_matches(&changed), "mutation {mutation}");
        assert_ne!(changed.revision(), context.revision());
    }
}

#[test]
fn ordinary_shape_rejects_other_roles_automatic_usage_origin_and_invalid_request_ids() {
    let (origin, role) = question_context_inputs();
    let oversized_id = "r".repeat(97);
    for mutation in 0..9 {
        let mut changed = role.clone();
        let mut request_id = "synthetic-question";
        let mut question = "What does the note say?";
        let mut language = "en";
        match mutation {
            0 => changed.role = RoleId::Compilation,
            1 => changed.route_signature.role = RoleId::Compilation,
            2 => changed.usage = RoleUsage::Automatic,
            3 => changed.origin.opening_token = "synthetic-other-opening".into(),
            4 => request_id = "",
            5 => request_id = "synthetic invalid id",
            6 => question = " ",
            7 => language = "unsupported-language",
            _ => request_id = &oversized_id,
        }
        let error = AskReviewContext::for_question(
            &origin,
            &changed,
            request_id,
            question,
            None,
            language,
            Scope::Sessions,
            None,
            None,
        )
        .unwrap_err();
        assert_eq!(error.code(), "review_invalid", "mutation {mutation}");
    }
}

#[test]
fn activity_context_versions_its_period_purpose_and_keeps_period_match_contract() {
    let (origin, role) = question_context_inputs();
    let period = DateRange {
        start: "2026-10-01".into(),
        end: "2026-10-04".into(),
        start_epoch: None,
        end_epoch: None,
    };
    let context = AskReviewContext::new(
        &origin,
        &role,
        "synthetic-activity",
        "Synthetic work",
        "en",
        Scope::Sessions,
        &period,
        None,
        None,
    )
    .unwrap();
    assert_eq!(
        context.payload(),
        &json!({"question": "Synthetic work", "language": "en", "scope": "sessions",
            "activityPeriod": period_value(&period), "resolutionWindow": null,
            "recordPeriodContextVersion":period_context::VERSION})
    );
    assert!(context.matches("Synthetic work", "en", &period, &origin, Scope::Sessions));
    assert!(!context.matches_question_request(
        &origin,
        &role,
        "synthetic-activity",
        "Synthetic work",
        None,
        "en",
        Scope::Sessions,
        Some(&period),
        None,
    ));
}

#[test]
fn ordinary_period_does_not_activate_activity_sidecar_or_change_review_system() {
    let (packet, claims, activity) = fixture();
    let (_, mut role) = question_context_inputs();
    role.origin = activity.origin.clone();
    let period = DateRange {
        start: "2026-10-01".into(),
        end: "2026-10-04".into(),
        start_epoch: None,
        end_epoch: None,
    };
    for selected_period in [None, Some(&period)] {
        let context = AskReviewContext::for_question(
            &activity.origin,
            &role,
            "synthetic-question",
            "Synthetic work",
            None,
            "en",
            Scope::Sessions,
            selected_period,
            None,
        )
        .unwrap();
        let mut payload = json!({"ordinary":"retain this exact object"});
        let before = payload.clone();
        context
            .add_record_period_context(&mut payload, &packet)
            .unwrap();
        assert_eq!(payload, before);
        assert!(context
            .payload()
            .get("recordPeriodContextVersion")
            .is_none());
        let tokenized = std::cell::RefCell::new(None);
        let review = run(
            &context,
            &packet,
            &claims,
            |system, user| {
                assert_eq!(system, SYSTEM);
                *tokenized.borrow_mut() = Some((system.to_owned(), user.to_owned()));
                Ok(1000)
            },
            |system, user, _, _, _| {
                assert_eq!(system, SYSTEM);
                assert_eq!(
                    tokenized.borrow().as_ref().unwrap(),
                    &(system.to_owned(), user.to_owned())
                );
                assert!(!user.contains("\"recordPeriodContext\""));
                Ok(accepting_review(user))
            },
        )
        .unwrap();
        review.require_accepted().unwrap();
    }
}

#[test]
fn invalid_activity_period_is_rejected_when_constructing_the_review_context() {
    let (origin, role) = question_context_inputs();
    let mut period = DateRange {
        start: "2026-02-30".into(),
        end: "2026-10-04".into(),
        start_epoch: None,
        end_epoch: None,
    };
    for mutation in 0..3 {
        if mutation == 1 {
            period.start = "2026-10-01".into();
            period.start_epoch = Some(1);
        }
        if mutation == 2 {
            period.end_epoch = Some(1);
        }
        let error = AskReviewContext::new(
            &origin,
            &role,
            "synthetic-activity",
            "Synthetic work",
            "en",
            Scope::Sessions,
            &period,
            None,
            None,
        )
        .unwrap_err();
        assert_eq!(error.code(), "review_invalid");
    }
}

#[test]
fn ordinary_review_rejects_wrong_original_packet_before_counting_or_generation() {
    let (origin, role) = question_context_inputs();
    let (_, claims, _) = fixture();
    let context = AskReviewContext::for_question(
        &origin,
        &role,
        "synthetic-question",
        "Synthetic work",
        None,
        "en",
        Scope::Sessions,
        None,
        None,
    )
    .unwrap();
    for mutation in 0..3 {
        let mut changed_origin = origin.clone();
        let mut changed_scope = Scope::Sessions;
        match mutation {
            0 => changed_origin.vault_path = "/synthetic/other-vault".into(),
            1 => changed_origin.opening_token = "synthetic-other-opening".into(),
            _ => changed_scope = Scope::All,
        }
        let packet = SourceSet::new(changed_origin, changed_scope, vec![], vec![]).unwrap();
        let error = run(
            &context,
            &packet,
            &claims,
            |_, _| panic!("wrong packet must fail before token counting"),
            |_, _, _, _, _| panic!("wrong packet must fail before generation"),
        )
        .unwrap_err();
        assert_eq!(error.code(), "review_invalid");
    }
}

#[test]
fn ordinary_mock_receipt_cannot_bind_another_topic_or_source_revision() {
    let (packet, claims, _) = fixture();
    let (origin, role) = question_context_inputs();
    let context = AskReviewContext::for_question(
        &origin,
        &role,
        "synthetic-question",
        "Synthetic work",
        None,
        "en",
        Scope::Sessions,
        None,
        None,
    )
    .unwrap();
    let review = run(
        &context,
        &packet,
        &claims,
        |_, _| Ok(1000),
        |_, user, _, _, _| Ok(accepting_review(user)),
    )
    .unwrap();
    assert!(review.require_accepted().is_ok());
    assert!(review.binds(&context, &packet, &claims));
    let changed_context = AskReviewContext::for_question(
        &origin,
        &role,
        "synthetic-question",
        "Synthetic work",
        Some("An unrelated synthetic topic"),
        "en",
        Scope::Sessions,
        None,
        None,
    )
    .unwrap();
    assert!(!review.binds(&changed_context, &packet, &claims));
    let changed_text = "Different synthetic original body; completion still has no report.";
    let changed_document = SourceDocument::bind(
        "source".into(),
        "sessions/review.md".into(),
        "sessions/review.md".into(),
        changed_text,
        None,
        vec![SpanInput {
            id: "Q0".into(),
            start: 0,
            end: changed_text.len(),
            turn_id: "T0".into(),
            speaker: ActorRole::User,
            turn_time: None,
        }],
    )
    .unwrap();
    let changed_packet =
        SourceSet::new(origin, Scope::Sessions, vec![changed_document], vec![]).unwrap();
    assert!(!review.binds(&context, &changed_packet, &claims));
    let error = run(
        &context,
        &changed_packet,
        &claims,
        |_, _| panic!("changed original must fail before token counting"),
        |_, _, _, _, _| panic!("changed original must fail before generation"),
    )
    .unwrap_err();
    assert_eq!(error.code(), "review_invalid");
}
