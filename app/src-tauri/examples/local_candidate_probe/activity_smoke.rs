//! Actual-model shared-flow compatibility, not native IO or semantic acceptance.

use super::{ProbeHost, ProbeModel};
use myco_lib::local_generation::{activity_synthesis_steps, Request};
use myco_lib::local_llm::GenerationSchema;
use myco_lib::local_synthesis::Evidence;
use myco_lib::retrieval::Scope;
use myco_lib::wiki_claims::{ActorRole, SourceDocument, SourceSet, SpanInput};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

pub(super) fn request(
    model: &ProbeModel,
    id: &str,
    question: &str,
    evidence: &[Evidence],
    activity: bool,
) -> Result<Request, String> {
    let candidate = model.manifest;
    // These DTOs bind synthetic helper inputs; they are NOT native-issued grants.
    serde_json::from_value(json!({
        "modelId":candidate.id,"requestId":id, "expectedVault":"/synthetic-local-candidate-probe",
        "origin":{"vaultPath":"/synthetic-local-candidate-probe","openingToken":"synthetic-source-binding-only"},
        "roleSnapshot":{"snapshotId":"synthetic-candidate-role",
            "origin":{"vaultPath":"/synthetic-local-candidate-probe","openingToken":"synthetic-source-binding-only"},
            "role":"ask","usage":"foreground","authorizationRevision":"synthetic-no-native-admission",
            "routeSignature":{"role":"ask","providerId":"builtin-local",
                "modelId":candidate.id,"effort":"none","executionLocation":"in-process",
                "artifactRevision":candidate.revision,"artifactSha256":myco_lib::local_model::artifact_identity(&candidate),
                "runtimeContract":"synthetic-candidate-only","signature":"not-a-native-issued-grant"}},
        "question":question, "lang":"ko", "scope":"wiki",
        "range":if activity {json!({"start":"2026-10-01","end":"2026-10-04"})} else {Value::Null},
        "activityOverview":activity, "hits":evidence, "maxTokens":768,
    })).map_err(|error| format!("synthetic request: {error}"))
}

fn fixture(
    model: &ProbeModel,
    turns: [(&str, &str, ActorRole); 2],
    id: &str,
    question: &str,
    title: &str,
) -> Result<(Request, Vec<Evidence>, SourceSet), String> {
    let original = format!("{}\n{}", turns[0].1, turns[1].1);
    let document = SourceDocument::bind(
        "synthetic-record".into(),
        "raw/synthetic-record.md".into(),
        "wiki/synthetic-record.md".into(),
        &original,
        None,
        vec![
            SpanInput {
                id: turns[0].0.into(),
                start: 0,
                end: turns[0].1.len(),
                turn_id: if turns[0].2 == ActorRole::Assistant {
                    "assistant-1"
                } else {
                    "user-1"
                }
                .into(),
                speaker: turns[0].2,
                turn_time: Some("2026-10-01T12:00:00Z".into()),
            },
            SpanInput {
                id: turns[1].0.into(),
                start: turns[0].1.len() + 1,
                end: original.len(),
                turn_id: if turns[1].2 == ActorRole::User {
                    "user-1"
                } else {
                    "assistant-1"
                }
                .into(),
                speaker: turns[1].2,
                turn_time: Some("2026-10-02T12:00:00Z".into()),
            },
        ],
    )?;
    let evidence = vec![Evidence {
        page: "wiki/synthetic-record.md".into(),
        stem: title.into(),
        section: 0,
        text: original,
        title: None,
        compiled: None,
    }];
    let request = request(model, id, question, &evidence, true)?;
    let origin = request
        .origin
        .clone()
        .ok_or("synthetic source binding unavailable")?;
    Ok((
        request,
        evidence,
        SourceSet::new(origin, Scope::Wiki, vec![document], vec![])?,
    ))
}

pub(super) fn packet_matches(
    user: &str,
    expected: &[Value],
    window_ids: bool,
) -> Result<(), String> {
    let payload: Value = serde_json::from_str(user).map_err(|error| error.to_string())?;
    let mut actual = if let Some(spans) = payload["originalSpans"].as_array() {
        spans.clone()
    } else {
        payload["sources"]
            .as_array()
            .ok_or("missing original citation packet")?
            .iter()
            .map(|source| {
                source["originalSpans"]
                    .as_array()
                    .cloned()
                    .ok_or("missing original spans")
            })
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .flatten()
            .collect()
    };
    let mut expected = expected.to_vec();
    if window_ids {
        // Native context windows reissue only span IDs in these short fixtures.
        // Every byte, offset, SHA, path, actor, phase and time must remain exact.
        for span in actual.iter_mut().chain(expected.iter_mut()) {
            span.as_object_mut()
                .ok_or("invalid original span object")?
                .remove("id");
        }
    }
    if actual != expected {
        return Err("fixture original bytes/lineage/actor/time were omitted or changed".into());
    }
    Ok(())
}

pub(super) fn decode(
    probe: ProbeHost<'_>,
    prompt: (&str, &str),
    budget: (i32, u32),
    schema: GenerationSchema,
    case: &str,
    expected: &[Value],
    window_ids: bool,
) -> Result<String, String> {
    let phase = match schema {
        GenerationSchema::WikiClaimsV1 => "claims",
        GenerationSchema::AskAnswerV1 => "answer",
        GenerationSchema::WikiClaimReviewV1(_) => "claim_review",
        #[cfg(feature = "native-index-probe")]
        GenerationSchema::WikiClaimReviewReasonFirstQaV1(_) => "claim_review",
        GenerationSchema::AskAnswerReviewV1 => "answer_review",
        _ => return Err("compatibility probe received a session schema".into()),
    };
    let effective_budget = decode_budget(budget, schema, probe.claim_output_tokens)?;
    let checked = packet_matches(prompt.1, expected, window_ids).and_then(|_| {
        if budget != (768, 4096) {
            Err("compatibility stage budget changed".into())
        } else if let Some(decisions) = schema.claim_review_decisions() {
            let input: Value = serde_json::from_str(prompt.1).map_err(|error| error.to_string())?;
            let expected_ids: Vec<_> = (0..decisions.count())
                .map(|index| json!(format!("C{index}")))
                .collect();
            if input["requiredClaimIds"] != json!(expected_ids) {
                Err("app-issued decode decisions differ from the original review packet".into())
            } else {
                Ok(())
            }
        } else {
            Ok(())
        }
    });
    let packet_checked = checked.is_ok();
    #[cfg(feature = "native-index-probe")]
    let grammar_sha = Some(schema.qa_grammar_sha256());
    #[cfg(not(feature = "native-index-probe"))]
    let grammar_sha: Option<String> = None;
    let started = Instant::now();
    let mut telemetry = None;
    let generated = checked.and_then(|_| {
        let attempt = probe.host.generate_structured_cancellable_measured(
            prompt.0,
            prompt.1,
            effective_budget.0,
            effective_budget.1,
            schema,
            &AtomicBool::new(false),
        );
        telemetry = Some(attempt.telemetry().clone());
        attempt.into_result()
    });
    println!(
        "{}",
        json!({"phase":if window_ids {"activity_decode"} else {"ordinary_decode"},
        "model":probe.model.metadata(),
        "recordVersion":4,"case":case,"schema":phase,"grammarSha256":grammar_sha,
        "claimReviewDecisionCount":schema.claim_review_decisions().map(|issued|issued.count()),
        "pipelineRequestedOutputTokens":budget.0,"requestedOutputTokens":effective_budget.0,
        "context_tokens":effective_budget.1,"explicitClaimOutputTokens":probe.claim_output_tokens,
        "systemSha256":format!("{:x}",Sha256::digest(prompt.0.as_bytes())),
        "userSha256":format!("{:x}",Sha256::digest(prompt.1.as_bytes())),
        "generationTelemetry":telemetry,
        "elapsed_ms":started.elapsed().as_secs_f64()*1000.0,"complete_fixture_packet_checked":packet_checked,
        "output":generated.as_ref().ok(),"error":generated.as_ref().err(),
        "native_io_authenticated":false,"product_role_authorized":false,"semantic_accepted":false})
    );
    generated
}

pub(super) fn decode_budget(
    budget: (i32, u32),
    schema: GenerationSchema,
    claim_output_tokens: Option<i32>,
) -> Result<(i32, u32), String> {
    if budget != (768, 4096) || !matches!(claim_output_tokens, None | Some(768 | 1536)) {
        return Err("compatibility stage budget changed".into());
    }
    Ok((
        if schema == GenerationSchema::WikiClaimsV1 {
            claim_output_tokens.unwrap_or(budget.0)
        } else {
            budget.0
        },
        budget.1,
    ))
}

fn request_plan_fixture(model: &ProbeModel) -> Result<(Request, Vec<Evidence>, SourceSet), String> {
    let requested = "Please repair the synthetic export parser. I am requesting work; I have not implemented it.";
    let planned = "I prepared a plan to repair the synthetic export parser. Implementation and verification have not been performed.";
    fixture(
        model,
        [
            ("requested", requested, ActorRole::User),
            ("planned", planned, ActorRole::Assistant),
        ],
        "synthetic-activity-compatibility",
        "최근 활동을 정리하고 합성 내보내기 수정이 완료됐는지 설명해줘",
        "Synthetic export request",
    )
}

pub(super) fn run(probe: ProbeHost<'_>) -> Result<(), String> {
    run_case(probe, request_plan_fixture(probe.model)?, false, false)
}

pub(super) fn positive(probe: ProbeHost<'_>) -> Result<(), String> {
    run_case(probe, positive_fixture(probe.model)?, true, false)
}

pub(super) fn contract_experiment(probe: ProbeHost<'_>) -> Result<(), String> {
    run_case(probe, positive_fixture(probe.model)?, true, true)
}

fn positive_fixture(model: &ProbeModel) -> Result<(Request, Vec<Evidence>, SourceSet), String> {
    fixture(model,
        [("performed","내보내기 파서를 변경해서 따옴표 안의 구분자가 보존되도록 했습니다.",ActorRole::Assistant),
         ("cancelled","내보내기 파서 변경을 되돌렸어. 입력 데이터가 잘려서 이 변경을 배포하지 않기로 했어.",ActorRole::User)],
        "synthetic-activity-positive-compatibility",
        "최근 내보내기 파서에 어떤 작업이 있었는지 정리하고, 이후 상태도 기록에 있는 범위로 알려줘.",
        "Synthetic parser change and rollback")
}

fn experiment_system(system: &str, experiment: bool) -> String {
    if !experiment {
        return system.into();
    }
    let clarification = if system.starts_with("Extract atomic activity claims") {
        "WikiClaimsV1 has exactly two outcomes: claims and insufficient_evidence. Relevant requests, plans, action reports and withdrawals are activity even without independent verification or a known event date. When such activity is present, return outcome=claims with nonempty atomic claims; preserve unknowns and reported status. Use insufficient_evidence with an empty list only when no activity relevant to the question exists. "
    } else if system.starts_with("Inspect the ENTIRE supplied original packet") {
        "Check original coverage before considering proposed claim IDs. A relevant request, plan, action report or withdrawal must not disappear because it is unverified or lacks an event date. If relevant original activity has no proposed claim, return sourceCoverage=missing and include its actual coverageRequiredSpanId in missingSpanIds. Empty claim IDs do not make positive original coverage complete. "
    } else {
        ""
    };
    format!("{clarification}{system}")
}

fn run_case(
    probe: ProbeHost<'_>,
    (request, evidence, sources): (Request, Vec<Evidence>, SourceSet),
    positive: bool,
    experiment: bool,
) -> Result<(), String> {
    let origin = request
        .origin
        .as_ref()
        .ok_or("synthetic source binding unavailable")?;
    let expected = serde_json::to_value(sources.spans().collect::<Vec<_>>())
        .map_err(|error| error.to_string())?
        .as_array()
        .cloned()
        .ok_or("invalid fixture spans")?;
    let mut schemas = Vec::new();
    let mut outputs = Vec::new();
    let case = if experiment {
        "performed_report_then_cancel_explicit_contract"
    } else if positive {
        "performed_report_then_cancel"
    } else {
        "request_plan_only"
    };
    let started = Instant::now();
    let result = activity_synthesis_steps(
        &request,
        &evidence,
        &sources,
        origin,
        |system, user| {
            probe
                .host
                .chat_token_count(&experiment_system(system, experiment), user)
        },
        |system, user, output, context, schema| {
            schemas.push(schema);
            let system = experiment_system(system, experiment);
            let generated = decode(
                probe,
                (&system, user),
                (output, context),
                schema,
                case,
                &expected,
                true,
            );
            if let Ok(text) = &generated {
                outputs.push((
                    schema,
                    serde_json::from_str::<Value>(text).map_err(|error| error.to_string())?,
                ));
            }
            generated
        },
    );
    let gold = positive.then(|| positive_gold(&outputs, &schemas));
    let failure=result.as_ref().err().map(|error|format!("activity smoke {}: {}",error.code,error.detail))
        .or_else(||gold.as_ref().filter(|checks|checks.as_object().map_or(true,|checks|checks.values().any(|value|value!=&Value::Bool(true))))
            .map(|_|"positive activity smoke failed fixed fixture assertions; inspect actual outputs".to_string()));
    println!(
        "{}",
        json!({"phase":"activity_flow","model":probe.model.metadata(),"case":case,"generation_calls":schemas.len(),
        "prompt_variant":if experiment {"qa-explicit-outcome-coverage-v1"} else {"production"},
        "experimental_prompt_override":experiment,
        "elapsed_ms":started.elapsed().as_secs_f64()*1000.0,
        "answer":result.as_ref().ok().map(|value|&value.answer),"receipt":result.as_ref().ok().map(|value|&value.receipt),
        "failure":failure,"gold_checks":gold,"gold_scope":"fixed synthetic assertions, not complete semantic grading",
        "manual_meaning_review_required":true,"native_io_authenticated":false,"product_role_authorized":false,"semantic_accepted":false,
        "production_accepted":false,"scope":"actual model with shared production helpers; synthetic compatibility only"})
    );
    match failure {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

fn positive_gold(outputs: &[(GenerationSchema, Value)], schemas: &[GenerationSchema]) -> Value {
    let claims = outputs
        .iter()
        .find(|(schema, _)| *schema == GenerationSchema::WikiClaimsV1)
        .and_then(|(_, output)| output["claims"].as_array());
    let answer = outputs
        .iter()
        .find(|(schema, _)| *schema == GenerationSchema::AskAnswerV1)
        .and_then(|(_, output)| output["answer"].as_str())
        .unwrap_or("");
    json!({
        "four_actual_stages":matches!(schemas,[GenerationSchema::WikiClaimsV1,GenerationSchema::WikiClaimReviewV1(_),
            GenerationSchema::AskAnswerV1,GenerationSchema::AskAnswerReviewV1]),
        "assistant_report_claim":claims.is_some_and(|claims|claims.iter().any(|claim|
            claim["actor"]["role"]=="assistant" && claim["speechAct"]=="report" && claim["status"]=="reported_completed")),
        "user_rollback_claim":claims.is_some_and(|claims|claims.iter().any(|claim|claim["actor"]["role"]=="user"
            && matches!(claim["status"].as_str(),Some("reported_rolled_back"|"reported_cancelled"|"retracted")))),
        "no_independent_verification_claim":claims.is_some_and(|claims|claims.iter().all(|claim|
            claim["verificationId"].is_null() && !claim["status"].as_str().unwrap_or("").starts_with("verified_"))),
        "reported_actor_in_answer":answer.contains("어시스턴트") || answer.to_lowercase().contains("assistant"),
        "rollback_in_answer":answer.contains("되돌") || answer.contains("롤백"),
        "deployment_cancellation_in_answer":answer.contains("배포") && ["취소","않기로","안 하","중단","철회"].iter().any(|term|answer.contains(term)),
        "no_independent_current_completion":!["독립적으로 검증되었습니다","현재 완료되었습니다","현재 완료된 상태입니다"].iter().any(|term|answer.contains(term))
    })
}

pub(super) fn cancel_and_recover(probe: ProbeHost<'_>) -> Result<(), String> {
    let flag = AtomicBool::new(false);
    let started = Instant::now();
    let result =
        std::thread::scope(|threads| {
            threads.spawn(|| {
                std::thread::sleep(Duration::from_millis(100));
                flag.store(true, Ordering::Release);
            });
            probe.host.generate_structured_cancellable(
            "Answer from the synthetic note only. Return AskAnswerV1 JSON.",
            "[S1] The synthetic batch contains 128 tokens. Explain the supplied fact carefully.",
            768, 4096, GenerationSchema::AskAnswerV1, &flag,
        )
        });
    let cancelled = result
        .as_ref()
        .is_err_and(|error| error == "local generation cancelled");
    println!(
        "{}",
        serde_json::json!({"phase":"host_cancellation","model":probe.model.metadata(),"cancel_after_ms":100,
        "elapsed_ms":started.elapsed().as_secs_f64()*1000.0,"cancelled":cancelled,
        "error":result.as_ref().err(),"scope":"flag during actual host call, not a native Stop/UI or decode-phase claim"})
    );
    if !cancelled {
        return Err("actual host cancellation did not reject its output".into());
    }
    let recovered = probe.host.generate_structured_cancellable(
        "Return AskAnswerV1 JSON. Answer only from S1.",
        "[S1] A synthetic batch contains 128 tokens. How many tokens?",
        192,
        4096,
        GenerationSchema::AskAnswerV1,
        &AtomicBool::new(false),
    )?;
    let decoded: serde_json::Value =
        serde_json::from_str(&recovered).map_err(|error| error.to_string())?;
    let valid = decoded["sources"] == serde_json::json!(["S1"])
        && decoded["answer"]
            .as_str()
            .is_some_and(|answer| answer.contains("128"));
    println!(
        "{}",
        serde_json::json!({"phase":"host_recovery","model":probe.model.metadata(),"output":recovered,"fact_and_reference_checked":valid,
        "semantic_accepted":false,"native_io_authenticated":false})
    );
    if !valid {
        return Err("host recovery lost the synthetic fact/reference".into());
    }
    Ok(())
}

#[cfg(test)]
mod qa_selected_request_tests {
    use super::*;

    #[test]
    fn selected_qa_request_binds_exact_model_revision_and_sha_without_native_grant() {
        for id in [crate::CANDIDATE.id, crate::MODEL.id] {
            let model = ProbeModel::select(Some(id)).unwrap();
            let request = request(
                &model,
                "synthetic-selected-request",
                "Same synthetic question",
                &[],
                false,
            )
            .unwrap();
            assert_eq!(request.model_id.as_deref(), Some(id));
            let snapshot = request.role_snapshot.as_ref().unwrap();
            assert_eq!(snapshot.route_signature.model_id, model.manifest.id);
            assert_eq!(
                snapshot.route_signature.artifact_revision.as_deref(),
                Some(model.manifest.revision)
            );
            assert_eq!(
                snapshot.route_signature.artifact_sha256.as_deref(),
                Some(myco_lib::local_model::artifact_identity(&model.manifest).as_str())
            );
            assert_eq!(snapshot.route_signature.provider_id, "builtin-local");
            assert_eq!(
                snapshot.route_signature.signature(),
                "not-a-native-issued-grant"
            );
            assert_eq!(
                snapshot.authorization_revision,
                "synthetic-no-native-admission"
            );
            assert_eq!(request.max_tokens, Some(768));
            assert!(request.range.is_none());
            assert!(request.previous_question.is_none());
        }
    }

    fn assert_same_originals(positive: bool) {
        let gemma = ProbeModel::select(Some(crate::CANDIDATE.id)).unwrap();
        let qwen = ProbeModel::select(Some(crate::MODEL.id)).unwrap();
        let (gemma_request, gemma_evidence, gemma_sources) = if positive {
            positive_fixture(&gemma)
        } else {
            request_plan_fixture(&gemma)
        }
        .unwrap();
        let (qwen_request, qwen_evidence, qwen_sources) = if positive {
            positive_fixture(&qwen)
        } else {
            request_plan_fixture(&qwen)
        }
        .unwrap();
        assert_eq!(gemma_request.question, qwen_request.question);
        assert_eq!(gemma_request.request_id, qwen_request.request_id);
        assert_eq!(gemma_request.max_tokens, qwen_request.max_tokens);
        assert_eq!(gemma_request.lang, qwen_request.lang);
        assert!(gemma_request.activity_overview && qwen_request.activity_overview);
        let gemma_range = gemma_request.range.as_ref().unwrap();
        let qwen_range = qwen_request.range.as_ref().unwrap();
        assert_eq!(gemma_range.start, qwen_range.start);
        assert_eq!(gemma_range.end, qwen_range.end);
        assert_eq!(gemma_range.start_epoch, qwen_range.start_epoch);
        assert_eq!(gemma_range.end_epoch, qwen_range.end_epoch);
        assert_eq!(gemma_range.start, "2026-10-01");
        assert_eq!(gemma_range.end, "2026-10-04");
        assert_eq!(
            serde_json::to_value(&gemma_evidence).unwrap(),
            serde_json::to_value(&qwen_evidence).unwrap()
        );
        let gemma_spans = serde_json::to_value(gemma_sources.spans().collect::<Vec<_>>()).unwrap();
        let qwen_spans = serde_json::to_value(qwen_sources.spans().collect::<Vec<_>>()).unwrap();
        // The full native-bound span JSON includes exact bytes, SHA, offsets,
        // IDs, roles, turn times and selection paths. Only the model may vary.
        assert_eq!(gemma_spans, qwen_spans);
        assert_eq!(gemma_spans.as_array().unwrap().len(), 2);
        assert_ne!(gemma_request.model_id, qwen_request.model_id);
    }

    #[test]
    fn qa_request_plan_control_keeps_identical_original_packet_across_models() {
        assert_same_originals(false);
    }

    #[test]
    fn qa_positive_control_keeps_identical_original_packet_across_models() {
        assert_same_originals(true);
    }
}
