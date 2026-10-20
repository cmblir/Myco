//! Fixed reviewer-only qualification; valid automated verdicts are not semantic truth.

#[path = "local_answer_review_probe/contract.rs"]
mod contract;

use myco_lib::local_generation::answer_review_qualification_qa as qualification;
use myco_lib::local_llm::{GenerationSchema, LocalLlm};
use myco_lib::local_model::{resolve_verified_artifact, GEMMA12B_CANDIDATE};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::cell::{Cell, RefCell};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::time::Instant;

fn hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}
fn emit(value: Value) -> Result<(), String> {
    let mut out = std::io::stdout().lock();
    serde_json::to_writer(&mut out, &value).map_err(|error| error.to_string())?;
    writeln!(&mut out).map_err(|error| error.to_string())?;
    out.flush().map_err(|error| error.to_string())
}

fn options(arguments: impl IntoIterator<Item = String>) -> Result<PathBuf, String> {
    let mut arguments = arguments.into_iter();
    let mut model = None;
    let mut directory = None;
    let mut mode = false;
    while let Some(flag) = arguments.next() {
        if flag == "--reviewer-qualification-qa" {
            if mode {
                return Err("repeated --reviewer-qualification-qa".into());
            }
            mode = true;
            continue;
        }
        let slot = match flag.as_str() {
            "--model-id" => &mut model,
            "--model-dir" => &mut directory,
            _ => {
                return Err(format!(
                    "unsupported reviewer-qualification argument: {flag}"
                ))
            }
        };
        let value = arguments
            .next()
            .filter(|value| !value.is_empty() && !value.starts_with("--"))
            .ok_or_else(|| format!("missing value for {flag}"))?;
        if slot.replace(value).is_some() {
            return Err(format!("repeated reviewer-qualification argument: {flag}"));
        }
    }
    if !mode || model.as_deref() != Some(GEMMA12B_CANDIDATE.id) {
        return Err(
            "explicit --reviewer-qualification-qa and pinned Gemma12B model ID required".into(),
        );
    }
    let path = PathBuf::from(directory.ok_or("explicit model directory required")?);
    if !path.is_absolute() {
        return Err("absolute model directory required".into());
    }
    Ok(path)
}

fn clean_telemetry(value: &Value) -> bool {
    value["profile"] == "gemma12BOrdinalQaV1"
        && value["schema"] == "askAnswerReviewV1"
        && value["requestedOutputTokens"] == 768
        && value["requestedContextTokens"] == 4096
        && value["loopStop"] == "eog"
        && value["terminal"] == "returnedText"
        && value["pendingUtf8Bytes"] == 0
        && value.get("errorCode") == Some(&Value::Null)
}

#[derive(Default)]
struct Progress {
    source_bound: Cell<bool>,
    host_loaded: Cell<bool>,
    observed_cases: Cell<usize>,
    host_attempts: Cell<usize>,
    valid_verdicts: Cell<usize>,
}

fn run(directory: PathBuf, progress: &Progress) -> Result<(), String> {
    // Native fixture and draft validation plus all prepared input checks precede model resolution.
    let cases = qualification::prepare_all()?;
    let inputs = contract::prepare_inputs(&cases)?;
    progress.source_bound.set(true);
    let schedule = cases
        .iter()
        .map(|case| {
            json!({"caseId":case.id(),"familyId":case.family_id(),
        "proposalId":case.proposal_id(),"fixedDraftSha256":hash(case.raw_draft()),
        "originalCount":case.original_count()})
        })
        .collect::<Vec<_>>();
    emit(
        json!({"phase":"answer_review_qualification_admission","model":GEMMA12B_CANDIDATE,
        "runtimeSha256":qualification::RUNTIME_SHA256,"corpusManifest":qualification::corpus_manifest(),
        "schedule":schedule,"scheduledCases":16,"families":8,"boundOriginalInstances":52,"uniqueOriginals":26,
        "wireFormat":"Flat","samplerProfile":"gemma12BOrdinalQaV1","seed":42,
        "reviewSchema":"askAnswerReviewV1","grammarSha256":GenerationSchema::AskAnswerReviewV1.qa_grammar_sha256(),
        "maximumReviewGenerations":16,"maximumGenerationsPerCase":1,"writerGenerations":0,"retries":0,"corrections":0,
        "allInputsPreparedBeforeModelResolution":true,"preparationTokenCounts":0,
        "newFrozenSourceCases":true,"heldOut":false,"humanQualified":false,"referenceCriteriaServedToModel":false,
        "expectedDispositionLabelsServedToModel":false,"native_io_authenticated":false,"product_role_authorized":false,
        "activityContractAccepted":false,"semantic_accepted":false,"production_accepted":false}),
    )?;
    let model = resolve_verified_artifact(&directory, &GEMMA12B_CANDIDATE)?;
    let mut host = LocalLlm::load_embed_host()?;
    progress.host_loaded.set(true);
    let result = (|| {
        host.ensure_chat_model(&model)?;
        let mut failures = Vec::new();
        for (index, (case, expected)) in cases.iter().zip(&inputs).enumerate() {
            let counts = Cell::new(0usize);
            let calls = Cell::new(0usize);
            let tokenizer_calls = Cell::new(0usize);
            let counted = RefCell::new(None::<contract::Wire>);
            let outcome = case.run(|system,user| {
                if counts.replace(counts.get()+1)!=0 || calls.get()!=0 {
                    return Err("qualification count repeated or reordered".into());
                }
                let wire = contract::Wire {system:system.into(),user:user.into()};
                contract::check_wire(case,&wire)?;
                if &wire!=expected { return Err("qualification actual review input changed after preparation".into()); }
                tokenizer_calls.set(tokenizer_calls.get()+1);
                let tokens = host.chat_token_count(system,user);
                emit(json!({"phase":"answer_review_qualification_count","caseIndex":index,"caseId":case.id(),
                    "familyId":case.family_id(),"proposalId":case.proposal_id(),"stage":"review","call":1,"schema":"askAnswerReviewV1",
                    "fixedDraftSha256":hash(case.raw_draft()),"system":system,"user":user,
                    "systemSha256":hash(system),"userSha256":hash(user),"tokenCount":tokens.as_ref().ok(),"error":tokens.as_ref().err(),
                    "contextTokens":4096,"outputTokens":768,"reserve":8,"inputAllowance":3320,
                    "suppliedOriginalSpans":case.original_count(),"writerGenerations":0,"referenceCriteriaServedToModel":false,
                    "native_io_authenticated":false,"product_role_authorized":false,"semantic_accepted":false,"production_accepted":false}))?;
                let tokens = tokens?;
                *counted.borrow_mut() = Some(wire);
                Ok(tokens)
            },|system,user,output,context,schema| {
                let actual = contract::Wire {system:system.into(),user:user.into()};
                if calls.get()!=0 || counts.get()!=1 || progress.host_attempts.get()>=contract::CASE_COUNT
                    || schema!=GenerationSchema::AskAnswerReviewV1 || (output,context)!=(768,4096)
                    || counted.borrow_mut().take().as_ref()!=Some(&actual) {
                    return Err("qualification generation schema, budget, count binding or limit changed".into());
                }
                calls.set(1);
                progress.host_attempts.set(progress.host_attempts.get()+1);
                let started = Instant::now();
                let attempt = host.generate_gemma12b_ordinal_cancellable_measured_qa(system,user,output,context,schema,&AtomicBool::new(false));
                let telemetry = serde_json::to_value(attempt.telemetry()).map_err(|error|error.to_string());
                let generated = attempt.into_result();
                let clean = generated.is_ok() && telemetry.as_ref().is_ok_and(clean_telemetry);
                // Retain raw model output before the existing native reviewer parses or accepts it.
                emit(json!({"phase":"answer_review_qualification_generation","caseIndex":index,"caseId":case.id(),
                    "familyId":case.family_id(),"proposalId":case.proposal_id(),"stage":"review","call":1,"schema":"askAnswerReviewV1",
                    "fixedDraftSha256":hash(case.raw_draft()),"system":system,"user":user,
                    "systemSha256":hash(system),"userSha256":hash(user),"grammarSha256":schema.qa_grammar_sha256(),
                    "requestedOutputTokens":output,"requestedContextTokens":context,"reserve":8,"inputAllowance":3320,
                    "telemetry":telemetry.as_ref().ok(),"telemetryError":telemetry.as_ref().err(),
                    "rawOutput":generated.as_ref().ok(),"rawOutputSha256":generated.as_ref().ok().map(|raw|hash(raw)),
                    "error":generated.as_ref().err(),"cleanObservedDecode":clean,"elapsedSeconds":started.elapsed().as_secs_f64(),
                    "writerGenerations":0,"native_io_authenticated":false,"product_role_authorized":false,
                    "semantic_accepted":false,"production_accepted":false}))?;
                if !clean { return Err("qualification decode telemetry was not clean EOG".into()); }
                generated
            });
            // A valid unsupported/uncertain verdict is an observation, not a technical failure.
            emit(
                json!({"phase":"answer_review_qualification_case_terminal","caseIndex":index,"caseId":case.id(),
                "familyId":case.family_id(),"proposalId":case.proposal_id(),"fixedDraftSha256":hash(case.raw_draft()),
                "countCallbackCalls":counts.get(),"tokenizerCalls":tokenizer_calls.get(),"reviewGenerations":calls.get(),
                "writerGenerations":0,"suppliedOriginalSpans":case.original_count(),"technicalObservationComplete":outcome.is_ok(),
                "diagnostic":outcome.as_ref().ok(),"error":outcome.as_ref().err().map(|error|json!({"code":error.code,"detail":error.detail})),
                "meaning":"not_assessed","expectedDispositionLabelsServedToModel":false,
                "native_io_authenticated":false,"product_role_authorized":false,"activityContractAccepted":false,
                "semantic_accepted":false,"production_accepted":false}),
            )?;
            progress
                .observed_cases
                .set(progress.observed_cases.get() + 1);
            if let Err(error) = outcome {
                failures.push(format!(
                    "case {}: {}: {}",
                    case.id(),
                    error.code,
                    error.detail
                ));
            } else {
                progress
                    .valid_verdicts
                    .set(progress.valid_verdicts.get() + 1);
            }
        }
        emit(
            json!({"phase":"answer_review_qualification_schedule_terminal","scheduledCases":16,
            "observedCaseTerminals":progress.observed_cases.get(),"validVerdictObservations":progress.valid_verdicts.get(),
            "technicalFailedCases":failures.len(),"reviewGenerations":progress.host_attempts.get(),"maximumReviewGenerations":16,
            "writerGenerations":0,"retries":0,"corrections":0,"meaning":"not_assessed","humanQualified":false,"heldOut":false,
            "native_io_authenticated":false,"product_role_authorized":false,"semantic_accepted":false,"production_accepted":false}),
        )?;
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("; "))
        }
    })();
    drop(host);
    let dropped = emit(
        json!({"phase":"answer_review_qualification_host_dropped","ownedHostDropCompleted":true,
        "gpuMemoryReturnObserved":false,"processGlobalBackendReleaseObserved":false,"writerGenerations":0,
        "reviewGenerations":progress.host_attempts.get(),"semantic_accepted":false,"production_accepted":false}),
    );
    match (result, dropped) {
        (Err(error), Err(log_error)) => Err(format!("{error}; host-drop log failed: {log_error}")),
        (result, Ok(())) => result,
        (Ok(()), Err(error)) => Err(error),
    }
}

fn main() {
    let progress = Progress::default();
    let result = options(std::env::args().skip(1)).and_then(|directory| run(directory, &progress));
    let terminal = emit(
        json!({"phase":"answer_review_qualification_terminal","error":result.as_ref().err(),
        "scheduledCases":16,"scheduledCaseIds":contract::expected_ids(),"sourceBound":progress.source_bound.get(),
        "hostLoaded":progress.host_loaded.get(),"observedCaseTerminals":progress.observed_cases.get(),
        "scheduledUnreachedCases":contract::CASE_COUNT-progress.observed_cases.get(),
        "reviewGenerations":progress.host_attempts.get(),"maximumReviewGenerations":16,"maximumGenerationsPerCase":1,
        "writerGenerations":0,"retries":0,"corrections":0,"validVerdictObservations":progress.valid_verdicts.get(),
        "meaning":"not_assessed","humanQualified":false,"heldOut":false,"expectedDispositionLabelsServedToModel":false,
        "native_io_authenticated":false,"product_role_authorized":false,"activityContractAccepted":false,
        "semantic_accepted":false,"production_accepted":false,"installedAcceptance":false}),
    );
    if result.is_err() || terminal.is_err() {
        std::process::exit(1);
    }
}

#[cfg(test)]
#[path = "local_answer_review_probe/tests.rs"]
mod tests;
