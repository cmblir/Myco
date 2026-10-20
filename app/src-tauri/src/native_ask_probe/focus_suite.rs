//! One-shot complete-original source-focus QA, without native role authority.

use super::compact_suite::{
    bind_case, emit, fixture, historical_range, GOLD_MANIFEST_SHA, GOLD_SHA, NATIVE_MANIFEST_SHA,
};
use super::{require, sha};
use crate::local_llm::generation_telemetry::LoopStop;
use crate::local_llm::{GenerationSchema, LocalLlm, WikiClaimsSamplerQaProfile};
use crate::local_model::{ModelManifest, GEMMA_CANDIDATE, MODEL};
use crate::local_synthesis::claim_prompt::payload;
use crate::retrieval::Scope;
use crate::vault_session::AgentVaultSession;
use crate::wiki_claims::focus_claims_qa::PreparedFocusQa;
use crate::wiki_claims::{CheckedClaims, ClaimOutcome, SourceSet};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::Instant;

const OUTPUT_TOKENS: i32 = 768;
const CONTEXT_TOKENS: u32 = 4096;
const SAFETY_TOKENS: usize = 8;

#[derive(Default)]
struct Counts {
    observed: usize,
    attempts_started: usize,
    attempts_observed: usize,
    native_structure_valid: usize,
    complete_positive_cases: usize,
    host_created: bool,
    host_drop_completed: bool,
    failures: Vec<String>,
}

fn selected_manifest(model_id: Option<&str>) -> Result<&'static ModelManifest, String> {
    if let Some(id) = model_id {
        require(
            id == MODEL.id || id == GEMMA_CANDIDATE.id,
            "unsupported source focus suite model ID",
        )?;
    }
    crate::local_model::manifest_for(model_id)
}

fn validate_control(control: &Path, manifest: &ModelManifest) -> Result<(), String> {
    require(
        control.is_absolute(),
        "source focus suite control artifact must be an explicit absolute path",
    )?;
    let metadata = std::fs::symlink_metadata(control).map_err(|error| error.to_string())?;
    require(
        metadata.is_file() && !metadata.file_type().is_symlink(),
        "source focus suite control artifact is not a regular non-symlink file",
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        require(
            metadata.nlink() == 1,
            "source focus suite control artifact is hardlinked",
        )?;
    }
    require(
        metadata.len() == manifest.bytes,
        "source focus suite control artifact size does not match selected manifest",
    )
}

fn prepare_case(
    case: &Value,
    origin: &AgentVaultSession,
) -> Result<(SourceSet, PreparedFocusQa, Value), String> {
    let (sources, mapping) = bind_case(case, origin)?;
    let range = historical_range(case)?;
    let question = case["question"]
        .as_str()
        .ok_or("source focus case question is missing")?;
    let language = case["language"]
        .as_str()
        .ok_or("source focus case language is missing")?;
    let user = payload(
        question,
        language,
        &range,
        &sources.spans().collect::<Vec<_>>(),
    )?;
    let prepared = PreparedFocusQa::prepare(&user)?;
    Ok((sources, prepared, mapping))
}

fn require_positive_extraction(
    stop: Option<LoopStop>,
    pending_utf8_bytes: Option<usize>,
    checked: &CheckedClaims,
) -> Result<(), String> {
    require(
        stop == Some(LoopStop::Eog),
        "source focus suite decoder did not terminate with EOG",
    )?;
    require(
        pending_utf8_bytes == Some(0),
        "source focus suite decoder has an incomplete UTF-8 tail",
    )?;
    require(
        checked.outcome == ClaimOutcome::Claims && !checked.claims.is_empty(),
        "source focus suite positive original activity was discarded",
    )
}

fn observe_case(
    case: &Value,
    origin: &AgentVaultSession,
    host: Option<&LocalLlm>,
    setup_error: Option<&str>,
    manifest: &'static ModelManifest,
    model_id_explicit: bool,
    counts: &mut Counts,
) -> Value {
    let started = Instant::now();
    let mut record = json!({
        "phase":"source_focus_suite_case","caseId":case["id"],"attemptOrdinal":1,
        "retryCount":0,"outputTokens":OUTPUT_TOKENS,"contextTokens":CONTEXT_TOKENS,
        "safetyReserveTokens":SAFETY_TOKENS,
        "model":manifest,"modelIdExplicit":model_id_explicit,
        "sampler":WikiClaimsSamplerQaProfile::ExistingGroundedV1.qa_parameters(),
        "completeOriginalSha256":case["source"]["sha256"],"completeOriginalBytes":case["source"]["bytes"],
        "historicalPeriodPolicy":{"source":"unchanged development case helper","timeZone":"Asia/Seoul",
            "offsetSeconds":32400,"endBoundary":"exclusive_next_local_day","realPlannerExecuted":false},
        "decoderAttemptStarted":false,"decoderAttemptObserved":false,
        "nativeStructureValid":false,"completePositiveExtraction":false,
        "sourceSetValidation":{"status":"not_run"},"failureStage":"source_preparation",
        "meaningEvaluation":"requires_independent_original_source_review",
        "automatedSemanticReview":"not_run","answerGeneration":"not_run","finalAnswerReview":"not_run",
        "nativeIoAuthenticated":false,"productRoleAuthorized":false,"semanticAccepted":false,
        "productionAccepted":false,"installedAcceptance":false,"modelAdoption":false,
        "modelEgress":"not_observed","privateVaultRead":false,"paidProviderUse":false,
    });
    let result = (|| {
        let (sources, prepared, mapping) = prepare_case(case, origin)?;
        record["sourceMapping"] = mapping;
        record["originalUser"] = json!(prepared.original_user());
        record["originalUserSha256"] = json!(sha(prepared.original_user().as_bytes()));
        record["system"] = json!(prepared.system());
        record["systemSha256"] = json!(sha(prepared.system().as_bytes()));
        record["user"] = json!(prepared.user());
        record["userSha256"] = json!(sha(prepared.user().as_bytes()));
        record["packetSha256"] = json!(prepared.decoder().packet_sha256());
        record["originalSpanCount"] = json!(prepared.decoder().span_count());
        let schema = GenerationSchema::WikiSourceFocusClaimsQaV1(prepared.decoder());
        record["grammarSha256"] = json!(schema.qa_grammar_sha256());
        record["failureStage"] = json!("model_setup");
        let host = host.ok_or_else(|| {
            setup_error
                .unwrap_or("source focus suite host unavailable")
                .to_owned()
        })?;
        record["failureStage"] = json!("prompt_tokenization");
        let prompt_tokens = host.chat_token_count(prepared.system(), prepared.user())?;
        record["promptTokens"] = json!(prompt_tokens);
        record["failureStage"] = json!("context_fit");
        require(
            prompt_tokens
                .checked_add(OUTPUT_TOKENS as usize + SAFETY_TOKENS)
                .is_some_and(|required| required <= CONTEXT_TOKENS as usize),
            "source focus suite complete originals do not fit unchanged context budget",
        )?;
        counts.attempts_started += 1;
        record["decoderAttemptStarted"] = json!(true);
        record["failureStage"] = json!("generation");
        let attempt = host.generate_structured_cancellable_measured(
            prepared.system(),
            prepared.user(),
            OUTPUT_TOKENS,
            CONTEXT_TOKENS,
            schema,
            &AtomicBool::new(false),
        );
        record["telemetry"] =
            serde_json::to_value(attempt.telemetry()).map_err(|error| error.to_string())?;
        let stop = attempt.telemetry().loop_stop;
        let pending_utf8_bytes = attempt.telemetry().pending_utf8_bytes;
        counts.attempts_observed += 1;
        record["decoderAttemptObserved"] = json!(true);
        let raw = attempt.into_result()?;
        record["rawSourceFocus"] = json!(raw);
        record["rawSourceFocusSha256"] = json!(sha(raw.as_bytes()));
        record["failureStage"] = json!("source_focus_projection");
        let projection = prepared.expand(&raw)?;
        record["expandedNative"] = json!(projection.canonical());
        record["expandedNativeSha256"] = json!(sha(projection.canonical().as_bytes()));
        record["interpretationRevision"] = json!(projection.revision());
        record["sourceFocusInterpretations"] =
            serde_json::to_value(&projection).map_err(|error| error.to_string())?;
        record["failureStage"] = json!("native_source_structure");
        let checked = match sources.validate(projection.canonical(), origin, Scope::All) {
            Ok(checked) => checked,
            Err(error) => {
                record["sourceSetValidation"] = json!({"status":"failed","error":error});
                return Err(error);
            }
        };
        record["sourceSetValidation"] =
            json!({"status":"passed","checkedClaims":checked,"semanticAccepted":false});
        record["nativeStructureValid"] = json!(true);
        counts.native_structure_valid += 1;
        record["failureStage"] = json!("decoder_terminal_and_positive_activity");
        require_positive_extraction(stop, pending_utf8_bytes, &checked)?;
        record["completePositiveExtraction"] = json!(true);
        counts.complete_positive_cases += 1;
        record["failureStage"] = Value::Null;
        Ok::<(), String>(())
    })();
    if let Err(error) = result {
        counts.failures.push(format!("{}: {error}", case["id"]));
        record["error"] = json!(error);
    }
    counts.observed += 1;
    record["elapsedMs"] = json!(started.elapsed().as_secs_f64() * 1000.0);
    record
}

fn execute(
    control: PathBuf,
    manifest: &'static ModelManifest,
    model_id_explicit: bool,
    counts: &mut Counts,
) -> Result<(), String> {
    validate_control(&control, manifest)?;
    let cases = fixture()?;
    let temporary = tempfile::Builder::new()
        .prefix("myco-source-focus-qa-")
        .tempdir()
        .map_err(|error| error.to_string())?;
    let data = temporary.path().join("data");
    let models = data.join("models");
    std::fs::create_dir_all(&models).map_err(|error| error.to_string())?;
    // This standalone process owns its environment before starting backend
    // threads. It never resolves installed data, reads a user vault or grants roles.
    std::env::set_var("MYCO_DATA_DIR", &data);
    std::env::remove_var("MEMEX_DATA_DIR");
    require(
        crate::local_model::model_dir()? == models,
        "source focus suite model directory escaped its isolated profile",
    )?;
    let origin = AgentVaultSession {
        vault_path: temporary.path().to_string_lossy().into_owned(),
        opening_token: format!(
            "QA-{}",
            &sha(temporary.path().to_string_lossy().as_bytes())[..32]
        ),
    };
    let mut host = None;
    let setup = (|| {
        let receipt = super::artifact::seed_artifact(&control, manifest)?;
        emit(
            json!({"phase":"source_focus_suite_artifact_verified","receipt":receipt,
            "model":manifest,"modelIdExplicit":model_id_explicit,
            "nativeIoAuthenticated":false,"productRoleAuthorized":false}),
        )?;
        let path = crate::local_model::resolve_verified_artifact(&models, manifest)?;
        host = Some(LocalLlm::load_embed_host()?);
        counts.host_created = true;
        host.as_mut()
            .ok_or("source focus suite host was not created")?
            .ensure_chat_model(&path)?;
        Ok::<(), String>(())
    })();
    let observations = (|| {
        for case in &cases {
            emit(observe_case(
                case,
                &origin,
                host.as_ref().filter(|_| setup.is_ok()),
                setup.as_ref().err().map(String::as_str),
                manifest,
                model_id_explicit,
                counts,
            ))?;
        }
        Ok::<(), String>(())
    })();
    drop(host.take());
    counts.host_drop_completed = counts.host_created;
    emit(
        json!({"phase":"source_focus_suite_host_dropped","ownedHostCreated":counts.host_created,
        "ownedHostDropCompleted":counts.host_drop_completed,"processGlobalBackendReleaseObserved":false,
        "gpuMemoryReturnObserved":false}),
    )?;
    observations?;
    if counts.failures.is_empty() {
        Ok(())
    } else {
        Err(counts.failures.join("; "))
    }
}

/// Complete-original development extraction only. A clean positive extraction
/// does not authenticate native IO, execute review/answer, or accept a model.
pub fn run(control_artifact: PathBuf) -> Result<(), String> {
    run_selected(control_artifact, None)
}

/// Explicit pinned candidate comparison with unchanged extraction controls.
pub fn run_for(control_artifact: PathBuf, model_id: &str) -> Result<(), String> {
    run_selected(control_artifact, Some(model_id))
}

fn run_selected(control_artifact: PathBuf, model_id: Option<&str>) -> Result<(), String> {
    let mut counts = Counts::default();
    let started = Instant::now();
    let manifest = selected_manifest(model_id);
    let result = match &manifest {
        Ok(manifest) => execute(control_artifact, manifest, model_id.is_some(), &mut counts),
        Err(error) => Err(error.clone()),
    };
    emit(
        json!({"phase":"source_focus_suite_terminal","scheduledCases":4,"observedCases":counts.observed,
        "decoderAttemptsStarted":counts.attempts_started,"decoderAttemptsObserved":counts.attempts_observed,
        "nativeStructureValidCases":counts.native_structure_valid,
        "completePositiveExtractionCases":counts.complete_positive_cases,"referenceOriginalTurns":9,
        "referenceFacts":15,"referenceExpectedClaims":14,"retryCount":0,"error":result.as_ref().err(),
        "hostCreated":counts.host_created,"ownedHostDropCompleted":counts.host_drop_completed,
        "goldSha256":GOLD_SHA,"goldManifestSha256":GOLD_MANIFEST_SHA,"nativeManifestSha256":NATIVE_MANIFEST_SHA,
        "model":manifest.as_ref().ok(),"modelIdExplicit":model_id.is_some(),
        "requestedModelId":model_id,"modelEgress":"not_observed","privateVaultRead":false,
        "paidProviderUse":false,"roleAuthority":"unauthenticated_direct_qa","nativeIoAuthenticated":false,
        "productRoleAuthorized":false,"semanticAccepted":false,"productionAccepted":false,
        "installedAcceptance":false,"modelAdoption":false,"automatedSemanticReview":"not_run",
        "answerGeneration":"not_run","finalAnswerReview":"not_run","realPlannerExecuted":false,
        "nativeTranscriptParserExecuted":false,"meaningEvaluation":"requires_independent_original_source_review",
        "timingScope":"serial same-host direct complete-original extraction; not whole-question latency or user means",
        "elapsedMs":started.elapsed().as_secs_f64() * 1000.0}),
    )?;
    result
}

#[cfg(test)]
#[path = "focus_suite_tests.rs"]
mod tests;
