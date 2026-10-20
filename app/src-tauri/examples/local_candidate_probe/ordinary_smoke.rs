//! Actual ordinary two-stage algorithm; synthetic custody, never native grants.

use super::activity_smoke;
use super::ProbeHost;
use myco_lib::local_generation::ordinary_probe;
use myco_lib::local_llm::GenerationSchema;
use myco_lib::local_synthesis::Evidence;
use myco_lib::retrieval::Scope;
use myco_lib::wiki_claims::{ActorRole, SourceDocument, SourceSet, SpanInput};
use serde_json::{json, Value};
use std::time::Instant;

pub(super) fn run(probe: ProbeHost<'_>) -> Result<(), String> {
    let previous = "연결 포트는 4117입니다.";
    let correction = "정정: 사용할 연결 포트는 4119입니다.";
    let port_note = format!("{previous}\n{correction}");
    let plan =
        "다음 주에 내보내기 파서를 수정할 계획이야. 실제 구현 결과는 이 메모에 기록하지 않았어.";
    let documents = vec![
        SourceDocument::bind(
            "synthetic-port".into(),
            "wiki/synthetic-port.md".into(),
            "wiki/synthetic-port.md".into(),
            &port_note,
            None,
            vec![
                SpanInput {
                    id: "port-old".into(),
                    start: 0,
                    end: previous.len(),
                    turn_id: "note-1".into(),
                    speaker: ActorRole::Unknown,
                    turn_time: None,
                },
                SpanInput {
                    id: "port-correction".into(),
                    start: previous.len() + 1,
                    end: port_note.len(),
                    turn_id: "note-2".into(),
                    speaker: ActorRole::Unknown,
                    turn_time: None,
                },
            ],
        )?,
        SourceDocument::bind(
            "synthetic-plan".into(),
            "raw/synthetic-plan.md".into(),
            "wiki/synthetic-plan.md".into(),
            plan,
            None,
            vec![SpanInput {
                id: "plan-only".into(),
                start: 0,
                end: plan.len(),
                turn_id: "user-1".into(),
                speaker: ActorRole::User,
                turn_time: Some("2026-10-01T12:00:00Z".into()),
            }],
        )?,
    ];
    let evidence = vec![
        Evidence {
            page: "wiki/synthetic-port.md".into(),
            stem: "Synthetic port note".into(),
            section: 0,
            title: None,
            compiled: None,
            text: "Generated false port 9999.".into(),
        },
        Evidence {
            page: "wiki/synthetic-plan.md".into(),
            stem: "Synthetic plan note".into(),
            section: 0,
            title: None,
            compiled: None,
            text: "Generated false user implementation completed.".into(),
        },
    ];
    let mut request = activity_smoke::request(
        probe.model,
        "synthetic-ordinary-compatibility",
        "사용할 연결 포트와 내보내기 파서 계획을 알려줘. 구현 완료 여부도 기록에 있는 범위로 설명해줘.",
        &evidence,
        false,
    )?;
    request.paths = Some(evidence.iter().map(|source| source.page.clone()).collect());
    let origin = request
        .origin
        .as_ref()
        .ok_or("synthetic source binding unavailable")?;
    let sources = SourceSet::new(origin.clone(), Scope::Wiki, documents, vec![])?;
    let expected = serde_json::to_value(sources.spans().collect::<Vec<_>>())
        .map_err(|error| error.to_string())?
        .as_array()
        .cloned()
        .ok_or("invalid fixture spans")?;
    let mut schemas = Vec::new();
    let mut draft = None;
    let started = Instant::now();
    let result = ordinary_probe::run(
        &request,
        &evidence,
        &sources,
        origin,
        |system, user| probe.host.chat_token_count(system, user),
        |system, user, output, context, schema| {
            schemas.push(schema);
            let payload: Value = serde_json::from_str(user).map_err(|error| error.to_string())?;
            if !payload["context"]["activityPeriod"].is_null()
                || !payload["context"]["requestedPeriod"].is_null()
                || !payload["context"]["resolutionWindow"].is_null()
                || !payload["context"]["previousQuestion"].is_null()
                || payload["context"]["question"] != request.question
                || (schema == GenerationSchema::AskAnswerV1 && user.contains("Generated false"))
                || !matches!(
                    schema,
                    GenerationSchema::AskAnswerV1 | GenerationSchema::AskAnswerReviewV1
                )
            {
                return Err("ordinary fixture inherited a period/prior/generated evidence or changed its question/schema".into());
            }
            let generated = activity_smoke::decode(
                probe,
                (system, user),
                (output, context),
                schema,
                "unknown_note_and_user_plan",
                &expected,
                false,
            );
            if schema == GenerationSchema::AskAnswerV1 {
                if let Ok(text) = &generated {
                    draft = Some(
                        serde_json::from_str::<Value>(text).map_err(|error| error.to_string())?,
                    );
                }
            }
            generated
        },
    );
    let gold = gold_checks(draft.as_ref(), &schemas, result.as_ref().ok());
    let failure = result
        .as_ref()
        .err()
        .map(|error| format!("ordinary smoke {}: {}", error.code, error.detail))
        .or_else(|| {
            gold.as_object()
                .filter(|checks| checks.values().any(|value| value != &Value::Bool(true)))
                .map(|_| {
                    "ordinary smoke failed fixed fixture assertions; inspect actual outputs"
                        .to_string()
                })
        });
    println!(
        "{}",
        json!({"phase":"ordinary_flow","model":probe.model.metadata(),"case":"unknown_note_and_user_plan",
        "generation_calls":schemas.len(),"elapsed_ms":started.elapsed().as_secs_f64()*1000.0,
        "result":result.as_ref().ok(),"failure":failure,"gold_checks":gold,
        "gold_scope":"fixed synthetic assertions; lexical checks are not complete semantic grading",
        "manual_meaning_review_required":true,"native_io_authenticated":false,
        "product_role_authorized":false,"semantic_accepted":false,"production_accepted":false})
    );
    match failure {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

fn gold_checks(
    draft: Option<&Value>,
    schemas: &[GenerationSchema],
    result: Option<&Value>,
) -> Value {
    // Inspect model prose, never appended navigation labels, for bounded gold.
    let answer = draft
        .and_then(|draft| draft["answer"].as_str())
        .unwrap_or("");
    let compact = answer.split_whitespace().collect::<String>();
    // Bounded fixture checks, not a Korean entailment classifier. Absence must
    // qualify the implementation result; an unrelated "없다" is insufficient.
    let result_unknown = compact.split(['.', '!', '?', '。']).any(|sentence| {
        (sentence.contains("구현") || sentence.contains("완료여부"))
            && [
                "기록되지않",
                "기록하지않",
                "기록이없",
                "기록은없",
                "미기록",
                "미상",
                "알수없",
                "확인되지",
            ]
            .iter()
            .any(|term| sentence.contains(term))
    });
    // Affirmative statements are different from "완료 여부는 기록이 없다".
    let unsupported_completion = [
        "구현은완료되었습니다",
        "구현이완료되었습니다",
        "구현을완료했습니다",
        "구현을마쳤습니다",
        "독립적으로검증되었습니다",
        "독립적으로검증했습니다",
        "독립검증을통과했습니다",
    ]
    .iter()
    .any(|term| compact.contains(term));
    // Preserve the old-port history while rejecting instructions to use it.
    let obsolete_port_directed = [
        "4117로연결하세요",
        "4117로연결하십시오",
        "4117을사용하세요",
        "4117포트를사용하세요",
        "현재연결포트는4117",
    ]
    .iter()
    .any(|term| compact.contains(term));
    let mut used = result
        .and_then(|result| result["usedSources"].as_array())
        .map(|paths| paths.iter().filter_map(Value::as_str).collect::<Vec<_>>())
        .unwrap_or_default();
    used.sort();
    json!({
        "two_actual_stages":schemas==[GenerationSchema::AskAnswerV1,GenerationSchema::AskAnswerReviewV1],
        "corrected_port":answer.contains("4119") && !answer.contains("9999") && !obsolete_port_directed,
        "plan_preserved":answer.contains("계획") || answer.contains("예정"),
        "implementation_result_unknown":result_unknown && !unsupported_completion,
        "no_unconditional_current_noncompletion":(["현재미완료","현재미완성","현재진행중","아직완료되지않았습니다",
            "구현되지않았습니다"].iter().all(|term|!compact.contains(term))),
        "both_original_citations":used==["wiki/synthetic-plan.md","wiki/synthetic-port.md"],
        "entire_review_receipt":result.is_some_and(|result|result["answerReceipt"]["answerOriginalSpans"]==3
            && result["answerReceipt"]["automatedAnswerReviewInputRevision"].as_str().is_some_and(|value|value.len()==64)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const CITATIONS: &[&str] = &["wiki/synthetic-port.md", "wiki/synthetic-plan.md"];
    const KNOWN_POSITIVE: &str = "사용할 연결 포트는 4119이며, 내보내기 파서를 수정할 계획입니다. 실제 구현 결과의 기록은 없습니다.";

    fn checks(answer: &str, citations: &[&str]) -> Value {
        let draft = json!({"answer":answer,"sources":["S1","S2"]});
        // Helper-only shaped JSON, not a native receipt or model-quality proof.
        // A same-model supported verdict cannot correct contradictory prose.
        let result = json!({"usedSources":citations,
            "answerReceipt":{"answerOriginalSpans":3,
                "automatedAnswerReviewInputRevision":"0".repeat(64)},
            "sameModelReview":{"answerDisposition":"supported","taskResponse":"adequate",
                "sourceCoverage":"covered","missingSpanIds":[]}});
        gold_checks(
            Some(&draft),
            &[
                GenerationSchema::AskAnswerV1,
                GenerationSchema::AskAnswerReviewV1,
            ],
            Some(&result),
        )
    }

    fn passes(checks: &Value) -> bool {
        checks
            .as_object()
            .unwrap()
            .values()
            .all(|value| value == &Value::Bool(true))
    }

    #[test]
    fn gold_helper_preserves_existing_record_absence_control() {
        let checks = checks(KNOWN_POSITIVE, CITATIONS);
        assert!(passes(&checks), "{checks}");
    }

    #[test]
    fn gold_helper_accepts_record_not_written_from_actual_model_output() {
        let checks = checks(
            "사용할 연결 포트는 4119이며, 내보내기 파서는 다음 주에 수정할 계획이지만 실제 구현 결과는 기록되지 않았습니다.",
            CITATIONS,
        );
        assert_eq!(checks["implementation_result_unknown"], true, "{checks}");
        assert!(passes(&checks), "{checks}");
    }

    #[test]
    fn gold_helper_accepts_not_written_in_the_note() {
        let checks = checks(
            "사용할 연결 포트는 4119이며, 내보내기 파서를 수정할 계획입니다. 실제 구현 결과는 이 메모에 기록하지 않았습니다.",
            CITATIONS,
        );
        assert_eq!(checks["implementation_result_unknown"], true, "{checks}");
        assert!(passes(&checks), "{checks}");
    }

    #[test]
    fn gold_helper_preserves_obsolete_port_history_and_its_correction() {
        let checks = checks(
            "과거에는 연결에 4117을 사용했지만 메모에서 4119로 정정했습니다. 내보내기 파서는 수정할 계획이며 실제 구현 결과의 기록은 없습니다.",
            CITATIONS,
        );
        assert_eq!(checks["corrected_port"], true, "{checks}");
        assert!(passes(&checks), "{checks}");
    }

    #[test]
    fn gold_helper_allows_unknown_completion_without_keyword_rejection() {
        let checks = checks(
            "사용할 연결 포트는 4119이며, 내보내기 파서는 수정할 계획입니다. 실제 구현 완료 여부는 기록이 없습니다.",
            CITATIONS,
        );
        assert_eq!(checks["implementation_result_unknown"], true, "{checks}");
        assert!(passes(&checks), "{checks}");
    }

    #[test]
    fn gold_helper_rejects_old_port_as_active_despite_mentioning_the_correction() {
        let checks = checks(
            "사용할 연결 포트는 4117입니다. 4119라는 정정 메모도 있지만 4117로 연결하세요. 내보내기 파서를 수정할 계획이며 실제 구현 결과의 기록은 없습니다.",
            CITATIONS,
        );
        assert_eq!(checks["corrected_port"], false, "{checks}");
        assert!(!passes(&checks), "{checks}");
    }

    #[test]
    fn gold_helper_rejects_current_noncompletion_inferred_from_absence() {
        let answer = format!("{KNOWN_POSITIVE} 따라서 파서는 현재 미완료 상태입니다.");
        let checks = checks(&answer, CITATIONS);
        assert_eq!(
            checks["no_unconditional_current_noncompletion"], false,
            "{checks}"
        );
        assert!(!passes(&checks), "{checks}");
    }

    #[test]
    fn gold_helper_rejects_omitted_plan() {
        let checks = checks(
            "사용할 연결 포트는 4119입니다. 실제 구현 결과의 기록은 없습니다.",
            CITATIONS,
        );
        assert_eq!(checks["plan_preserved"], false, "{checks}");
        assert!(!passes(&checks), "{checks}");
    }

    #[test]
    fn gold_helper_rejects_missing_plan_citation_despite_supported_stamp() {
        let checks = checks(KNOWN_POSITIVE, &CITATIONS[..1]);
        assert_eq!(checks["both_original_citations"], false, "{checks}");
        assert!(!passes(&checks), "{checks}");
    }

    #[test]
    fn gold_helper_rejects_fabricated_completion_after_record_absence() {
        let answer = format!("{KNOWN_POSITIVE} 다만 내보내기 파서의 실제 구현은 완료되었습니다.");
        let checks = checks(&answer, CITATIONS);
        assert!(
            !passes(&checks),
            "supported stamp cannot justify invented completion: {checks}"
        );
    }

    #[test]
    fn gold_helper_rejects_fabricated_independent_verification_after_record_absence() {
        let answer = format!("{KNOWN_POSITIVE} 내보내기 파서의 구현은 독립적으로 검증되었습니다.");
        let checks = checks(&answer, CITATIONS);
        assert!(
            !passes(&checks),
            "same-model verdict is not independent verification: {checks}"
        );
    }
}
