//! Seven known development cases, separate from the historical two-question D3 mode.

use super::*;

pub(super) fn run_with_wire_format(directory: PathBuf, format: QaWireFormat) -> Result<(), String> {
    // Source/schema binding precedes model resolution. No private vault is read.
    let prepared = direct_reading_qa::development::prepare_all()?;
    emit(
        json!({"phase":"development_reading_admission","wireFormat":format,"model":GEMMA12B_CANDIDATE,
        "cases":direct_reading_qa::development::CASE_IDS,
        "compiledSources":direct_reading_qa::development::corpus_manifest(),
        "questionReferencesSha256":direct_reading_qa::development::REFERENCES_SHA256,
        "scheduledCases":7,"maximumGenerations":14,"maximumGenerationsPerCase":2,
        "corrections":0,"retries":0,"referenceCriteriaServedToModel":false,
        "sourceIdentity":"synthetic-new-identities; not historical D3 USER or native grants",
        "periodContext":"explicit historical recorded context; no planner or fresh current-state evidence",
        "native_io_authenticated":false,"product_role_authorized":false,
        "activityClaimReview":"not_run","activityContractAccepted":false,
        "semantic_accepted":false,"production_accepted":false}),
    )?;
    let model = resolve_verified_artifact(&directory, &GEMMA12B_CANDIDATE)?;
    let mut host = LocalLlm::load_embed_host()?;
    let result = (|| {
        host.ensure_chat_model(&model)?;
        let mut failures = Vec::new();
        let mut total_calls = 0;
        for (index, case) in prepared.iter().enumerate() {
            let request = case.request();
            let mut calls = 0;
            let result = case.run_with_wire_format_qa(
                format,
                |system, user| {
                    let counted = host.chat_token_count(system, user);
                    emit(json!({"phase":"development_reading_count","wireFormat":format,"caseIndex":index,"caseId":case.id(),"questionIndex":case.question_index(),
                        "system":system,"user":user,"systemSha256":fixture::hash(system),"userSha256":fixture::hash(user),
                        "tokenCount":counted.as_ref().ok(),"error":counted.as_ref().err(),
                        "contextTokens":4096,"outputTokens":768,"reserve":8}))?;
                    counted
                },
                |system, user, output, context, schema| {
                    calls += 1;
                    if calls > 2
                        || (output, context) != (768, 4096)
                        || !matches!(
                            schema,
                            GenerationSchema::AskAnswerV1 | GenerationSchema::AskAnswerReviewV1
                        )
                    {
                        return Err("direct-reading stage/budget contract changed".into());
                    }
                    let started = Instant::now();
                    let attempt = host.generate_gemma12b_ordinal_cancellable_measured_qa(
                        system,
                        user,
                        output,
                        context,
                        schema,
                        &AtomicBool::new(false),
                    );
                    let telemetry =
                        serde_json::to_value(attempt.telemetry()).map_err(|e| e.to_string());
                    let generated = attempt.into_result();
                    let expected_schema = if schema == GenerationSchema::AskAnswerV1 {
                        "askAnswerV1"
                    } else {
                        "askAnswerReviewV1"
                    };
                    let clean = telemetry.as_ref().is_ok_and(|t| {
                        t["profile"] == "gemma12BOrdinalQaV1"
                            && t["schema"] == expected_schema
                            && t["requestedOutputTokens"] == 768
                            && t["requestedContextTokens"] == 4096
                            && t["loopStop"] == "eog"
                            && t["terminal"] == "returnedText"
                            && t["pendingUtf8Bytes"] == 0
                            && t["errorCode"].is_null()
                    });
                    // Observe raw output before parsing, draft validation, or the next review.
                    emit(
                        json!({"phase":"development_reading_generation","wireFormat":format,"caseIndex":index,"caseId":case.id(),"questionIndex":case.question_index(),"call":calls,
                        "system":system,"user":user,"systemSha256":fixture::hash(system),"userSha256":fixture::hash(user),
                        "grammarSha256":schema.qa_grammar_sha256(),"telemetry":telemetry.as_ref().ok(),
                        "telemetryError":telemetry.as_ref().err(),"rawOutput":generated.as_ref().ok(),
                        "rawOutputSha256":generated.as_ref().ok().map(|s|fixture::hash(s)),"error":generated.as_ref().err(),
                        "cleanObservedDecode":clean,"elapsedSeconds":started.elapsed().as_secs_f64(),
                        "native_io_authenticated":false,"product_role_authorized":false,"semantic_accepted":false,"production_accepted":false}),
                    )?;
                    if !clean {
                        return Err("direct-reading decode telemetry was not clean EOG".into());
                    }
                    generated
                },
            );
            emit(
                json!({"phase":"development_reading_case_terminal","wireFormat":format,"caseIndex":index,"caseId":case.id(),"questionIndex":case.question_index(),
                "question":request.question,"generationCalls":calls,"suppliedOriginalSpans":case.original_count(),"diagnostic":result.as_ref().ok(),
                "error":result.as_ref().err().map(|e|json!({"code":e.code,"detail":e.detail})),
                "meaningReview":"independent audit required; same-model approval is not truth",
                "activityContractAccepted":false,"semantic_accepted":false,"production_accepted":false}),
            )?;
            total_calls += calls;
            if let Err(error) = result {
                failures.push(format!(
                    "case {}: {}: {}",
                    case.id(),
                    error.code,
                    error.detail
                ));
            }
        }
        emit(
            json!({"phase":"development_reading_schedule_terminal","wireFormat":format,
            "scheduledCases":7,"observedCaseTerminals":prepared.len(),"generationCalls":total_calls,
            "failedDiagnosticCases":failures.len(),"referenceMeaningAcceptance":"not_assessed",
            "native_io_authenticated":false,"product_role_authorized":false,
            "activityContractAccepted":false,"semantic_accepted":false,"production_accepted":false}),
        )?;
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("; "))
        }
    })();
    drop(host);
    emit(
        json!({"phase":"development_reading_host_dropped","wireFormat":format,"ownedHostDropCompleted":true,
        "gpuMemoryReturnObserved":false,"processGlobalBackendReleaseObserved":false}),
    )?;
    result
}
