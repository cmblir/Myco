//! Direct compact-claim development QA, without product authority or review.

use super::{require, sha};
use crate::commands::DateRange;
use crate::local_llm::generation_telemetry::LoopStop;
use crate::local_llm::{GenerationSchema, LocalLlm, WikiClaimsSamplerQaProfile};
use crate::local_synthesis::claim_prompt::{activity_system, payload};
use crate::retrieval::Scope;
use crate::vault_session::AgentVaultSession;
use crate::wiki_claims::compact_qa::PreparedCompactQa;
use crate::wiki_claims::{
    ActorRole, CheckedClaims, ClaimOutcome, SourceDocument, SourceSet, SpanInput,
};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::time::Instant;

const GOLD: &str = include_str!("../../eval/local-wiki-development-meaning-v1.json");
const GOLD_MANIFEST: &str =
    include_str!("../../eval/local-wiki-development-meaning-v1.manifest.json");
const NATIVE_MANIFEST: &str =
    include_str!("../../eval/local-wiki-native-activity-development-v1/manifest.json");
pub(super) const GOLD_SHA: &str =
    "d697b33b60d555615a8e921158f3baeda1c003c6cac3c4a69d5cbe5d000f348c";
pub(super) const GOLD_MANIFEST_SHA: &str =
    "a27e437a81bb4ad4acbe569044191f3d82964df890d119d2005914fd3f958ba5";
pub(super) const NATIVE_MANIFEST_SHA: &str =
    "910f1db7741b6d78cd4155225142c372d8bf2d0d818a14909a44cc48cba29135";
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

pub(super) fn emit(value: Value) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(&value).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    let mut output = std::io::stdout().lock();
    output
        .write_all(&bytes)
        .and_then(|_| output.flush())
        .map_err(|error| format!("compact suite record output failed: {error}"))
}

pub(super) fn fixture() -> Result<Vec<Value>, String> {
    require(
        GOLD.len() == 20_012
            && sha(GOLD.as_bytes()) == GOLD_SHA
            && GOLD_MANIFEST.len() == 830
            && sha(GOLD_MANIFEST.as_bytes()) == GOLD_MANIFEST_SHA
            && NATIVE_MANIFEST.len() == 9760
            && sha(NATIVE_MANIFEST.as_bytes()) == NATIVE_MANIFEST_SHA,
        "compact suite frozen source or manifest SHA changed",
    )?;
    let corpus: Value = serde_json::from_str(GOLD).map_err(|error| error.to_string())?;
    let gold_manifest: Value =
        serde_json::from_str(GOLD_MANIFEST).map_err(|error| error.to_string())?;
    let native: Value = serde_json::from_str(NATIVE_MANIFEST).map_err(|error| error.to_string())?;
    require(
        corpus["syntheticOnly"] == true
            && corpus["split"] == "development"
            && corpus["id"] == "local-wiki-development-meaning-v1"
            && gold_manifest["syntheticOnly"] == true
            && gold_manifest["labelStatus"] == "frozen_before_inference"
            && gold_manifest["artifact"]["sha256"] == GOLD_SHA
            && gold_manifest["artifact"]["bytes"] == GOLD.len()
            && native["syntheticOnly"] == true
            && native["split"] == "development"
            && native["sourceArtifact"]["sha256"] == GOLD_SHA
            && native["sourceManifest"]["sha256"] == GOLD_MANIFEST_SHA,
        "compact suite lacks unchanged synthetic development source identity",
    )?;
    let cases = corpus["cases"]
        .as_array()
        .ok_or("compact suite cases are missing")?;
    let mut ids = HashSet::new();
    let mut turns = 0;
    let mut facts = 0;
    let mut claims = 0;
    for case in cases {
        let id = string(case, "id")?;
        require(
            case["syntheticOnly"] == true && ids.insert(id),
            "compact suite case is not uniquely synthetic",
        )?;
        turns += case["source"]["turns"]
            .as_array()
            .ok_or("compact suite turns are missing")?
            .len();
        facts += case["gold"]["requiredFacts"]
            .as_array()
            .ok_or("compact suite reference facts are missing")?
            .len();
        claims += case["gold"]["expectedClaims"]
            .as_array()
            .ok_or("compact suite reference claims are missing")?
            .len();
    }
    require(
        cases.len() == 4 && turns == 9 && facts == 15 && claims == 14,
        "compact suite full source reference counts changed",
    )?;
    Ok(cases.clone())
}

fn string<'a>(value: &'a Value, field: &str) -> Result<&'a str, String> {
    value[field]
        .as_str()
        .ok_or_else(|| format!("compact suite {field} is not a string"))
}

fn ordinal_identity(prefix: &str, case_id: &str, turn_id: &str) -> String {
    format!(
        "{prefix}-{}",
        &sha(format!("{case_id}:{turn_id}").as_bytes())[..32]
    )
}

pub(super) fn historical_range(case: &Value) -> Result<DateRange, String> {
    let period = &case["activityPeriod"];
    let start = string(period, "start")?;
    let end = string(period, "end")?;
    let midnight = |day: &str| -> Result<i64, String> {
        if day.len() != 10 {
            return Err("compact suite historical day is invalid".into());
        }
        crate::importers::parse_iso8601(&format!("{day}T00:00:00+09:00"))
            .ok_or_else(|| "compact suite historical KST midnight is invalid".into())
    };
    let start_epoch = midnight(start)?;
    let end_epoch = midnight(end)?
        .checked_add(86_400)
        .ok_or("compact suite period overflow")?;
    require(
        start <= end && start_epoch < end_epoch,
        "compact suite historical period is reversed",
    )?;
    Ok(DateRange {
        start: start.into(),
        end: end.into(),
        start_epoch: Some(start_epoch),
        end_epoch: Some(end_epoch),
    })
}

pub(super) fn bind_case(
    case: &Value,
    origin: &AgentVaultSession,
) -> Result<(SourceSet, Value), String> {
    require(
        case["syntheticOnly"] == true,
        "compact suite source case is not synthetic",
    )?;
    let case_id = string(case, "id")?;
    let source = &case["source"];
    let original = string(source, "original")?;
    require(
        source["bytes"] == original.len() && source["sha256"] == sha(original.as_bytes()),
        "compact suite complete original bytes or SHA changed",
    )?;
    let native: Value = serde_json::from_str(NATIVE_MANIFEST).map_err(|error| error.to_string())?;
    let container = native["containers"]
        .as_array()
        .ok_or("compact suite native containers are missing")?
        .iter()
        .find(|container| container["caseId"] == case_id)
        .ok_or("compact suite case lacks native manifest reference")?;
    let turns = source["turns"]
        .as_array()
        .ok_or("compact suite original turns are missing")?;
    require(
        container["fullOriginalSourceSha256"] == source["sha256"]
            && container["originalSourceBytes"] == original.len()
            && container["originalSourcePath"] == source["path"]
            && container["recordTime"] == source["recordTime"]
            && container["turnCount"] == turns.len()
            && container["originalActivityPeriod"] == case["activityPeriod"],
        "compact suite native reference differs from complete original",
    )?;
    let mut ids = HashSet::new();
    let mut inputs = Vec::new();
    let mut phases = Vec::new();
    let mut mapping = Vec::new();
    let mut previous_end = 0;
    for turn in turns {
        let id = string(turn, "id")?;
        let turn_id = string(turn, "turnId")?;
        let start = turn["start"]
            .as_u64()
            .and_then(|value| usize::try_from(value).ok())
            .ok_or("compact suite turn start is invalid")?;
        let end = turn["end"]
            .as_u64()
            .and_then(|value| usize::try_from(value).ok())
            .ok_or("compact suite turn end is invalid")?;
        let text = original
            .get(start..end)
            .ok_or("compact suite turn exceeds original UTF-8 coordinates")?;
        require(
            start < end
                && start >= previous_end
                && id == turn_id
                && ids.insert(turn_id)
                && turn["text"] == text
                && turn["sha256"] == sha(text.as_bytes()),
            "compact suite turn bytes, SHA or identity changed",
        )?;
        previous_end = end;
        let span_id = ordinal_identity("Q", case_id, turn_id);
        let native_turn_id = ordinal_identity("T", case_id, turn_id);
        let speaker: ActorRole =
            serde_json::from_value(turn["speaker"].clone()).map_err(|error| error.to_string())?;
        let turn_time: Option<String> =
            serde_json::from_value(turn["turnTime"].clone()).map_err(|error| error.to_string())?;
        let phase: Option<String> = serde_json::from_value(turn["sourcePhase"].clone())
            .map_err(|error| error.to_string())?;
        mapping.push(
            json!({"referenceTurnId":id,"referenceMessageId":turn_id,"spanId":span_id,
            "nativeTurnId":native_turn_id,"start":start,"end":end,"sha256":turn["sha256"]}),
        );
        phases.push((native_turn_id.clone(), phase));
        inputs.push(SpanInput {
            id: span_id,
            start,
            end,
            turn_id: native_turn_id,
            speaker,
            turn_time,
        });
    }
    let record_time: Option<String> =
        serde_json::from_value(source["recordTime"].clone()).map_err(|error| error.to_string())?;
    let document = SourceDocument::bind(
        ordinal_identity("S", case_id, "complete-original"),
        string(source, "path")?.into(),
        string(source, "selectionPath")?.into(),
        original,
        record_time,
        inputs,
    )?
    .with_turn_phases(&phases)?;
    Ok((
        SourceSet::new(origin.clone(), Scope::All, vec![document], vec![])?,
        json!(mapping),
    ))
}

fn prepare_case(
    case: &Value,
    origin: &AgentVaultSession,
) -> Result<(SourceSet, PreparedCompactQa, Value), String> {
    let (sources, mapping) = bind_case(case, origin)?;
    let range = historical_range(case)?;
    let spans: Vec<_> = sources.spans().collect();
    let original_user = payload(
        string(case, "question")?,
        string(case, "language")?,
        &range,
        &spans,
    )?;
    let prepared = PreparedCompactQa::prepare(&activity_system(), &original_user)?;
    Ok((sources, prepared, mapping))
}

fn observe_case(
    case: &Value,
    origin: &AgentVaultSession,
    host: Option<&LocalLlm>,
    setup_error: Option<&str>,
    counts: &mut Counts,
) -> Value {
    let started = Instant::now();
    let mut record = json!({"phase":"compact_suite_case","caseId":case["id"],"attemptOrdinal":1,
        "retryCount":0,"outputTokens":OUTPUT_TOKENS,"contextTokens":CONTEXT_TOKENS,
        "sampler":WikiClaimsSamplerQaProfile::ExistingGroundedV1.qa_parameters(),
        "semanticAccepted":false,"productionAccepted":false,"installedAcceptance":false,
        "nativeIoAuthenticated":false,"productRoleAuthorized":false,"automatedSemanticReview":"not_run",
        "meaningEvaluation":"requires_independent_original_source_review","modelEgress":"not_observed",
        "sourceSetValidation":{"status":"not_run"},"failureStage":"source_preparation",
        "completeOriginalSha256":case["source"]["sha256"],"completeOriginalBytes":case["source"]["bytes"],
        "historicalPeriodPolicy":{"source":"unchanged development case helper","timeZone":"Asia/Seoul",
            "offsetSeconds":32400,"endBoundary":"exclusive_next_local_day","realPlannerExecuted":false},
        "originalSystem":activity_system(),"originalSystemSha256":sha(activity_system().as_bytes()),
        "nativeStructureValid":false,"completePositiveExtraction":false,"decoderAttemptStarted":false,"decoderAttemptObserved":false});
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
        let schema = GenerationSchema::WikiClaimsCompactQaV1(prepared.decoder());
        record["grammarSha256"] = json!(schema.qa_grammar_sha256());
        record["failureStage"] = json!("model_setup");
        let host = host.ok_or_else(|| {
            setup_error
                .unwrap_or("compact suite host unavailable")
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
            "compact suite complete originals do not fit unchanged context budget",
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
        counts.attempts_observed += 1;
        record["decoderAttemptObserved"] = json!(true);
        let stop = attempt.telemetry().loop_stop;
        let raw = attempt.into_result()?;
        record["rawCompact"] = json!(raw);
        record["rawCompactSha256"] = json!(sha(raw.as_bytes()));
        record["failureStage"] = json!("compact_expansion");
        let expanded = prepared.expand(&raw)?;
        record["expandedNative"] = json!(expanded);
        record["expandedNativeSha256"] = json!(sha(expanded.as_bytes()));
        record["failureStage"] = json!("native_source_structure");
        let checked = match sources.validate(&expanded, origin, Scope::All) {
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
        require_positive_extraction(stop, &checked)?;
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

fn require_positive_extraction(
    stop: Option<LoopStop>,
    checked: &CheckedClaims,
) -> Result<(), String> {
    require(
        stop == Some(LoopStop::Eog),
        "compact suite decoder did not terminate with EOG",
    )?;
    require(
        checked.outcome == ClaimOutcome::Claims && !checked.claims.is_empty(),
        "compact suite positive original activity was discarded",
    )
}

fn execute(control: PathBuf, counts: &mut Counts) -> Result<(), String> {
    require(
        control.is_absolute(),
        "compact suite control artifact must be an explicit absolute path",
    )?;
    let cases = fixture()?;
    let temporary = tempfile::Builder::new()
        .prefix("myco-compact-claim-qa-")
        .tempdir()
        .map_err(|error| error.to_string())?;
    let data = temporary.path().join("data");
    let models = data.join("models");
    std::fs::create_dir_all(&models).map_err(|error| error.to_string())?;
    // This standalone QA process owns its environment before creating backend
    // threads. It never resolves installed app data or creates vault files.
    std::env::set_var("MYCO_DATA_DIR", &data);
    std::env::remove_var("MEMEX_DATA_DIR");
    require(
        crate::local_model::model_dir()? == models,
        "compact suite model directory escaped isolated profile",
    )?;
    let origin = AgentVaultSession {
        vault_path: temporary.path().to_string_lossy().into_owned(),
        opening_token: ordinal_identity("QA", &temporary.path().to_string_lossy(), "opening"),
    };
    let mut host = None;
    let setup = (|| {
        let receipt = super::artifact::seed_artifact(&control, &crate::local_model::MODEL)?;
        emit(
            json!({"phase":"compact_suite_artifact_verified","receipt":receipt,"nativeIoAuthenticated":false}),
        )?;
        let path =
            crate::local_model::resolve_verified_artifact(&models, &crate::local_model::MODEL)?;
        host = Some(LocalLlm::load_embed_host()?);
        counts.host_created = true;
        host.as_mut()
            .ok_or("compact suite host was not created")?
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
                counts,
            ))?;
        }
        Ok::<(), String>(())
    })();
    drop(host.take());
    counts.host_drop_completed = counts.host_created;
    emit(
        json!({"phase":"compact_suite_host_dropped","ownedHostCreated":counts.host_created,
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

/// Run each unchanged synthetic case once. This is a direct representation QA
/// entry point, not a native role-granted, planner, review or installed workflow.
pub fn run(control_artifact: PathBuf) -> Result<(), String> {
    let mut counts = Counts::default();
    let started = Instant::now();
    let result = execute(control_artifact, &mut counts);
    emit(
        json!({"phase":"compact_suite_terminal","scheduledCases":4,"observedCases":counts.observed,
        "decoderAttemptsStarted":counts.attempts_started,"decoderAttemptsObserved":counts.attempts_observed,
        "nativeStructureValidCases":counts.native_structure_valid,
        "completePositiveExtractionCases":counts.complete_positive_cases,"referenceOriginalTurns":9,
        "referenceFacts":15,"referenceExpectedClaims":14,"retryCount":0,"error":result.as_ref().err(),
        "hostCreated":counts.host_created,"ownedHostDropCompleted":counts.host_drop_completed,
        "goldSha256":GOLD_SHA,"goldManifestSha256":GOLD_MANIFEST_SHA,"nativeManifestSha256":NATIVE_MANIFEST_SHA,
        "model":crate::local_model::MODEL,"modelEgress":"not_observed","privateVaultRead":false,
        "paidProviderUse":false,"roleAuthority":"unauthenticated_direct_qa",
        "nativeIoAuthenticated":false,"productRoleAuthorized":false,"semanticAccepted":false,
        "productionAccepted":false,"installedAcceptance":false,"modelAdoption":false,
        "automatedSemanticReview":"not_run","realPlannerExecuted":false,"nativeTranscriptParserExecuted":false,
        "timingScope":"serial same-host direct complete-original extraction; not whole-question latency or user means",
        "elapsedMs":started.elapsed().as_secs_f64()*1000.0}),
    )?;
    result
}

#[cfg(test)]
#[path = "compact_suite_tests.rs"]
mod tests;
