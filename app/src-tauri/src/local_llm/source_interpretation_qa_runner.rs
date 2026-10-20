//! Draft for a `cfg(all(test, feature = "native-index-probe"))` local_llm child.
//! No product route, native IO authentication, review, answer or publication.
//!
//! Proposed coordinator interface, not an existing preregistration schema:
//! MYCO_SOURCE_INTERPRETATION_QA_MODE = admit | generate (required).
//! MYCO_SOURCE_INTERPRETATION_QA_ARTIFACT_DIR = existing isolated directory.
//! MYCO_SOURCE_INTERPRETATION_QA_REGISTRATION = frozen coordinator JSON path.
//! MYCO_SESSION_PACKET_MODEL_ID / MYCO_SESSION_PACKET_MODEL_DIR retain the
//! existing cached-model runner's names. Only the two IDs below are admitted.
//! Admit requires MYCO_QA_GENERATION absent or 0; generate requires exactly 1.
//!
//! Coordinator JSON has the closed Registration/ModelPin fields below. Before
//! admission each admissionSha256 is null. Before inference the coordinator
//! freezes both exact admission-file SHAs (including the trailing newline),
//! registration, source baseline, compiled binary, scripts, model bytes and
//! templates. Only admissionSha256 changes between these two registrations.
//! The runner verifies manifests/templates/admission equality. It records the
//! supplied source/binary pins, but DOES NOT verify the actual source tree or
//! executing binary: those gates and their receipts belong to the coordinator.
//! No criterion text or gold output is read or passed to the model here.
//!
//! Every emitted file uses create_new(true). A per-model mode reservation is
//! created before model loading. A failed generation admission consumes that
//! scheduled attempt too; no retry, overwrite, repair call or prefix recovery.
//! Decoder raw result/telemetry is exclusively persisted before JSON/binding.
//! This changes SYSTEM, USER envelope, grammar and grouping together. Only the
//! original span graph matches v6; neither USER bytes nor the whole native
//! compiler are claimed identical. Title/summary criterion 6 is not_assessed.

#![cfg(all(test, feature = "native-index-probe"))]

#[path = "source_interpretation_candidates_runner.rs"]
mod candidates;

use super::*;
use crate::importers::wikify::source_revision;
use crate::retrieval::Scope;
use crate::vault_session::AgentVaultSession;
use crate::wiki_claims::source_interpretation_qa::{self, PreparedQa};
use crate::wiki_claims::{ActorRole, CompilationOriginal, SourceDocument, SourceSet, SpanInput};
use generation_telemetry::{AttemptTerminal, GenerationPhase, LoopStop};
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs::OpenOptions;
use std::io::Write;

const ORIGINAL: &str = "---\nsource: codex\nconversation_id: synthetic-native\ncreated: 2026-10-01\n---\n# Synthetic conversation\n\n**User:**\nPlease request the synthetic report.\n\n**Assistant:**\nI plan to draft the synthetic report; no completion is recorded.\n";
const ORIGINAL_SHA: &str = "f95f310d45a6347224480fac2b57e2a134aa5c477bfbc29afbeef3805f356400";
const CRITERIA_SHA: &str = "34ddb1721ef312a298728cd259e738c81ee6851415de2a3f6d14006fe089f908";
const RAW_PATH: &str = "raw/conversations/codex/synthetic-native.md";
const SOURCE_ID: &str = "S-f95f310d45a6347224480fac2b57e2a1";
const OUTPUT: i32 = 768;
const CONTEXT: u32 = 4096;
const RESERVE: usize = 8;
const INPUT_LIMIT: usize = 3320;

const UNITS: [(&str, usize, usize, &str, ActorRole, &str); 3] = [
    (
        "Q-3b058f9db9ff27c4d37df69142ae0d89",
        76,
        102,
        "T-preamble",
        ActorRole::Unknown,
        "af2c7289612a89e53fa34ab1deb4c96a1f248128e9d1be6c20009d71db2bfae7",
    ),
    (
        "Q-54a71ed85fd0aa800597cf3bee4220b3",
        112,
        150,
        "T0",
        ActorRole::User,
        "16d43002cbfab0cb38ec6842d1b606344650d6720afb65a6600e8567b1046412",
    ),
    (
        "Q-fb114fbef5c587a1fc962906aa3f2492",
        165,
        230,
        "T1",
        ActorRole::Assistant,
        "d2aa537eedbaefdc12924889cf0d407f2eb659ba99579ed0c078c1cf09d963de",
    ),
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Registration {
    version: String,
    source_baseline_sha256: String,
    binary_sha256: String,
    original_sha256: String,
    criteria_sha256: String,
    models: Vec<ModelPin>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModelPin {
    id: String,
    revision: String,
    file: String,
    bytes: u64,
    sha256: String,
    path: String,
    architecture: String,
    chat_template_sha256: String,
    #[serde(deserialize_with = "required_nullable")]
    admission_sha256: Option<String>,
}

fn required_nullable<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Admit,
    Generate,
}

impl Mode {
    fn name(self) -> &'static str {
        match self {
            Self::Admit => "admit",
            Self::Generate => "generate",
        }
    }
}

struct Run {
    mode: Mode,
    arm: &'static str,
    model_id: String,
    model_dir: PathBuf,
    artifact: PathBuf,
    registration: PathBuf,
}

#[derive(Default)]
struct Observation {
    generation_calls: usize,
    model_inference: bool,
    raw_persisted: bool,
    binding_checked: bool,
    raw_observation: Option<Value>,
}

fn closed_model(id: &str) -> Result<(&'static str, &'static str, &'static str), String> {
    match id {
        "gemma-4-e4b-it-qat-q4_0" => Ok((
            "gemma",
            "gemma4",
            "0a2c8073c878ab1da004bee933a998606537bbb62016310352c7285c3f01c5b5",
        )),
        "qwen3.5-4b-q4_k_m" => Ok((
            "qwen",
            "qwen35",
            "a4aee8afcf2e0711942cf848899be66016f8d14a889ff9ede07bca099c28f715",
        )),
        _ => Err("source interpretation QA requires one of the two registered model IDs".into()),
    }
}

fn env(name: &str) -> Result<String, String> {
    std::env::var(name).map_err(|_| format!("required QA environment is missing: {name}"))
}

impl Run {
    fn read() -> Result<Self, String> {
        let mode = match env("MYCO_SOURCE_INTERPRETATION_QA_MODE")?.as_str() {
            "admit" => Mode::Admit,
            "generate" => Mode::Generate,
            _ => return Err("QA mode must be admit or generate".into()),
        };
        let generation = match std::env::var("MYCO_QA_GENERATION") {
            Ok(value) => Some(value),
            Err(std::env::VarError::NotPresent) => None,
            Err(std::env::VarError::NotUnicode(_)) => {
                return Err("QA generation permission must be UTF-8".into())
            }
        };
        if (mode == Mode::Generate && generation.as_deref() != Some("1"))
            || (mode == Mode::Admit && !matches!(generation.as_deref(), None | Some("0")))
        {
            return Err("QA generation permission does not match its explicit mode".into());
        }
        let model_id = env("MYCO_SESSION_PACKET_MODEL_ID")?;
        let (arm, _, _) = closed_model(&model_id)?;
        let artifact = PathBuf::from(env("MYCO_SOURCE_INTERPRETATION_QA_ARTIFACT_DIR")?)
            .canonicalize()
            .map_err(|error| format!("QA artifact directory: {error}"))?;
        if !artifact.is_dir() {
            return Err("QA artifact directory must already exist".into());
        }
        Ok(Self {
            mode,
            arm,
            model_id,
            model_dir: PathBuf::from(env("MYCO_SESSION_PACKET_MODEL_DIR")?),
            artifact,
            registration: PathBuf::from(env("MYCO_SOURCE_INTERPRETATION_QA_REGISTRATION")?),
        })
    }

    fn path(&self, name: &str) -> PathBuf {
        self.artifact.join(format!("{}-{name}.json", self.arm))
    }
}

fn read_json(path: &Path) -> Result<(Vec<u8>, Value), String> {
    let metadata =
        std::fs::metadata(path).map_err(|error| format!("read QA receipt metadata: {error}"))?;
    if !metadata.is_file() || metadata.len() > 1024 * 1024 {
        return Err("QA receipt must be a bounded regular file".into());
    }
    let bytes = std::fs::read(path).map_err(|error| format!("read QA receipt: {error}"))?;
    let value =
        serde_json::from_slice(&bytes).map_err(|error| format!("parse QA receipt: {error}"))?;
    Ok((bytes, value))
}

fn exclusive_json(path: &Path, value: &Value) -> Result<(), String> {
    let mut bytes =
        serde_json::to_vec(value).map_err(|error| format!("serialize QA receipt: {error}"))?;
    bytes.push(b'\n');
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| format!("exclusive QA receipt creation: {error}"))?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("persist QA receipt: {error}"))?;
    Ok(())
}

fn origin() -> AgentVaultSession {
    AgentVaultSession {
        vault_path: "/synthetic/source-interpretation-qa".into(),
        opening_token: "synthetic-native-opening".into(),
    }
}

fn fixture() -> Result<(SourceSet, PreparedQa), String> {
    if ORIGINAL.len() != 230 || source_revision(ORIGINAL) != ORIGINAL_SHA {
        return Err("canonical 230-byte QA original changed".into());
    }
    let verified = CompilationOriginal::verify(ORIGINAL, ORIGINAL_SHA)?;
    let inputs = UNITS
        .iter()
        .map(|(id, start, end, turn, speaker, _)| SpanInput {
            id: (*id).into(),
            start: *start,
            end: *end,
            turn_id: (*turn).into(),
            speaker: *speaker,
            turn_time: None,
        })
        .collect();
    let phases = UNITS
        .iter()
        .map(|(_, _, _, turn, _, _)| ((*turn).into(), None))
        .collect::<Vec<_>>();
    let document = SourceDocument::bind_compilation_packet(
        SOURCE_ID.into(),
        RAW_PATH.into(),
        &verified,
        ORIGINAL_SHA,
        Some("2026-10-01".into()),
        inputs,
    )?
    .with_turn_phases(&phases)?;
    let sources = SourceSet::new(origin(), Scope::All, vec![document], vec![])?;
    let prepared = source_interpretation_qa::prepare(&sources, &origin(), Scope::All)?;
    Ok((sources, prepared))
}

fn retained_v6_spans() -> Value {
    json!(UNITS
        .iter()
        .map(|(id, start, end, turn, speaker, sha)| json!({
            "id": id, "sourceId": SOURCE_ID, "sourcePath": RAW_PATH, "selectionPath": RAW_PATH,
            "sourceRevision": ORIGINAL_SHA, "start": start, "end": end, "sha256": sha,
            "text": &ORIGINAL[*start..*end], "turnId": turn, "speaker": speaker,
            "recordTime": "2026-10-01", "turnTime": null, "sourcePhase": null,
        }))
        .collect::<Vec<_>>())
}

fn sampler() -> Result<Value, String> {
    serde_json::to_value(WikiClaimsSamplerQaProfile::ExistingGroundedV1.qa_parameters())
        .map_err(|error| format!("serialize existing sampler: {error}"))
}

fn is_sha(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn registration(run: &Run) -> Result<Registration, String> {
    let (_, value) = read_json(&run.registration)?;
    let registration: Registration = serde_json::from_value(value)
        .map_err(|error| format!("invalid coordinator QA registration: {error}"))?;
    if registration.version != "NativeSourceInterpretationQaRegistrationV1"
        || registration.original_sha256 != ORIGINAL_SHA
        || registration.criteria_sha256 != CRITERIA_SHA
        || !is_sha(&registration.source_baseline_sha256)
        || !is_sha(&registration.binary_sha256)
        || registration.models.len() != 2
    {
        return Err("coordinator QA pins or unchanged original/criteria differ".into());
    }
    let mut ids = std::collections::HashSet::new();
    for pin in &registration.models {
        let (_, architecture, template) = closed_model(&pin.id)?;
        let manifest = crate::local_model::manifest_for(Some(&pin.id))?;
        if !ids.insert(&pin.id)
            || pin.revision != manifest.revision
            || pin.file != manifest.file
            || pin.bytes != manifest.bytes
            || pin.sha256 != manifest.sha256
            || pin.architecture != architecture
            || pin.chat_template_sha256 != template
            || !Path::new(&pin.path).is_absolute()
            || pin
                .admission_sha256
                .as_deref()
                .is_some_and(|sha| !is_sha(sha))
        {
            return Err(
                "coordinator model pins differ from the exact cached-model contract".into(),
            );
        }
    }
    Ok(registration)
}

fn admission(
    run: &Run,
    registration: &Registration,
    host: &LocalLlm,
    prepared: &PreparedQa,
    path: &Path,
) -> Result<Value, String> {
    let pin = registration
        .models
        .iter()
        .find(|pin| pin.id == run.model_id)
        .ok_or("selected QA model is not registered")?;
    let actual_path = path.to_str().ok_or("QA model path is not UTF-8")?;
    let model = host.chat_model()?;
    let architecture = model
        .meta_val_str("general.architecture")
        .map_err(|error| format!("QA model architecture: {error}"))?;
    let template = host
        .template
        .as_ref()
        .ok_or("QA chat template is absent")?
        .to_str()
        .map_err(|error| format!("QA chat template UTF-8: {error}"))?;
    let template_sha = source_revision(template);
    if actual_path != pin.path
        || architecture != pin.architecture
        || template_sha != pin.chat_template_sha256
    {
        return Err(
            "actual cached model path, architecture or template differs from registration".into(),
        );
    }
    let input: Value = serde_json::from_str(prepared.user())
        .map_err(|error| format!("parse prepared QA input: {error}"))?;
    if input["originalSpans"] != retained_v6_spans() || prepared.count().units() != 3 {
        return Err("prepared QA input differs from the retained v6 native original graph".into());
    }
    let schema = GenerationSchema::NativeSourceInterpretationQaV1(prepared.count());
    let grammar = prepared.count().grammar();
    let (prompt, _) = host.format_chat(prepared.system(), prepared.user())?;
    let prompt_tokens = host.chat_token_count(prepared.system(), prepared.user())?;
    validate_generation_budget(prompt_tokens, OUTPUT, CONTEXT, Some(schema))?;
    if prompt_tokens == 0
        || prompt_tokens > INPUT_LIMIT
        || GENERATION_SAFETY_TOKENS != RESERVE
        || schema.qa_grammar_sha256() != source_revision(&grammar)
    {
        return Err("QA exact prompt, grammar or reserve differs".into());
    }
    Ok(json!({
        "version": "NativeSourceInterpretationQaAdmissionV1", "phase": "source_interpretation_qa_admission",
        "arm": run.arm, "manifest": crate::local_model::manifest_for(Some(&run.model_id))?,
        "modelPath": actual_path, "architecture": architecture, "chatTemplateSha256": template_sha,
        "sourceBaselineSha256": registration.source_baseline_sha256, "binarySha256": registration.binary_sha256,
        "coordinatorSourceBinaryVerificationRequired": true, "runnerSourceBinaryVerified": false,
        "original": ORIGINAL, "originalBytes": 230, "originalSha256": ORIGINAL_SHA, "criteriaSha256": CRITERIA_SHA,
        "system": prepared.system(), "user": prepared.user(), "grammar": grammar,
        "systemSha256": source_revision(prepared.system()), "userSha256": source_revision(prepared.user()),
        "grammarSha256": schema.qa_grammar_sha256(), "effectivePromptSha256": source_revision(&prompt),
        "promptTokens": prompt_tokens, "outputTokens": OUTPUT, "contextTokens": CONTEXT, "reserveTokens": RESERVE,
        "sampler": sampler()?, "nonThinking": true, "exactUnitCount": 3, "scope": "all",
        "nativeIoAuthenticated": false, "modelInference": false, "generationCalls": 0,
        "semanticAccepted": false, "productionAccepted": false, "criterion6": "not_assessed",
        "compositeIntervention": "new SYSTEM, USER envelope, grammar and grouping; unchanged original span graph",
    }))
}

fn perform(run: &Run, observation: &mut Observation) -> Result<&'static str, String> {
    let registration = registration(run)?;
    let pin = registration
        .models
        .iter()
        .find(|pin| pin.id == run.model_id)
        .unwrap();
    let manifest = crate::local_model::manifest_for(Some(&run.model_id))?;
    let path = crate::local_model::resolve_verified_artifact(&run.model_dir, manifest)?;
    let mut host = LocalLlm::load_embed_host()?;
    host.ensure_chat_model(&path)?;
    let (_, prepared) = fixture()?;
    let current = admission(run, &registration, &host, &prepared, &path)?;
    if run.mode == Mode::Admit {
        if pin.admission_sha256.is_some() {
            return Err("admit requires its unsealed null admission SHA".into());
        }
        exclusive_json(&run.path("admission"), &current)?;
        println!("{current}");
        return Ok("admitted_without_inference");
    }
    // All frozen inputs are compared before the sole generation call. No model
    // output can revise admission, instructions, budgets or expected metadata.
    let expected_sha = pin
        .admission_sha256
        .as_deref()
        .ok_or("generate requires its frozen admission SHA")?;
    let (bytes, frozen) = read_json(&run.path("admission"))?;
    if format!("{:x}", Sha256::digest(&bytes)) != expected_sha || frozen != current {
        return Err("frozen QA admission bytes or complete input/pin equality changed".into());
    }
    let admitted_prompt_tokens = current["promptTokens"]
        .as_u64()
        .ok_or("frozen QA admission lacks its measured prompt token count")?
        as usize;
    exclusive_json(
        &run.path("generation-input"),
        &json!({
            "version": "NativeSourceInterpretationQaInputObservationV1", "phase": "source_interpretation_qa_input",
            "admissionSha256": expected_sha, "admission": current, "scheduledCalls": 1, "retries": 0,
            "modelInference": false, "semanticAccepted": false, "productionAccepted": false,
        }),
    )?;
    observation.generation_calls = 1;
    let attempt = host.generate_structured_cancellable_measured(
        prepared.system(),
        prepared.user(),
        OUTPUT,
        CONTEXT,
        GenerationSchema::NativeSourceInterpretationQaV1(prepared.count()),
        &AtomicBool::new(false),
    );
    let telemetry = attempt.telemetry().clone();
    observation.model_inference = telemetry
        .prefill_completed_tokens
        .is_some_and(|count| count > 0)
        || telemetry.sampled_tokens.is_some_and(|count| count > 0);
    let raw = attempt.into_result();
    let result = json!({
        "version": "NativeSourceInterpretationQaRawResultV1", "phase": "source_interpretation_qa_raw_result",
        "call": 1, "rawResult": raw, "telemetry": telemetry, "modelInference": observation.model_inference,
        "semanticAccepted": false, "productionAccepted": false,
    });
    println!("{result}");
    observation.raw_observation = Some(result.clone());
    exclusive_json(&run.path("generation-result"), &result)?;
    observation.raw_persisted = true;
    let raw = raw?;
    if telemetry.terminal != AttemptTerminal::ReturnedText
        || telemetry.terminal_phase != GenerationPhase::Finalize
        || telemetry.loop_stop != Some(LoopStop::Eog)
        || telemetry.error_code.is_some()
        || telemetry.pending_utf8_bytes != Some(0)
        || telemetry.profile != generation_telemetry::SamplerProfile::ExistingGroundedV1
        || telemetry.schema != generation_telemetry::TelemetrySchema::NativeSourceInterpretationQaV1
        || telemetry.prompt_tokens != Some(admitted_prompt_tokens)
        || telemetry.requested_output_tokens != OUTPUT
        || telemetry.requested_context_tokens != CONTEXT
    {
        return Err(
            "actual QA generation did not finish with clean EOG and the frozen decoder contract"
                .into(),
        );
    }
    let _: Value =
        serde_json::from_str(&raw).map_err(|error| format!("QA full structured JSON: {error}"))?;
    let bound = prepared.validate(&raw, &origin(), Scope::All)?;
    let bound = serde_json::to_value(bound)
        .map_err(|error| format!("serialize QA bound proposals: {error}"))?;
    if bound["bindingChecked"] != true
        || bound["nativeIoAuthenticated"] != false
        || bound["semanticAccepted"] != false
        || bound["productionAccepted"] != false
        || bound["semanticReviewRequired"] != true
    {
        return Err("QA source binding unexpectedly claims review or authority".into());
    }
    let binding = json!({
        "version": "NativeSourceInterpretationQaBindingObservationV1", "phase": "source_interpretation_qa_binding",
        "bound": bound, "nativeIoAuthenticated": false, "semanticAccepted": false, "productionAccepted": false,
        "reviewInvoked": false, "answerInvoked": false, "publicationInvoked": false, "criterion6": "not_assessed",
    });
    observation.binding_checked = true;
    println!("{binding}");
    exclusive_json(&run.path("binding"), &binding)?;
    Ok("bound_unreviewed_proposals_only")
}

#[test]
#[ignore = "requires explicit admit/generate mode, frozen coordinator pins and cached model; generate does actual inference"]
fn cached_model_observes_source_interpretation_qa_once() {
    // Invalid environment or an existing reservation is a runner admission
    // failure, reported by the outer coordinator; it cannot trigger inference.
    let run = Run::read().expect("explicit QA runner environment");
    exclusive_json(&run.path(&format!("{}-reservation", run.mode.name())), &json!({
        "version": "NativeSourceInterpretationQaReservationV1", "mode": run.mode.name(), "arm": run.arm,
        "scheduledCalls": if run.mode == Mode::Generate { 1 } else { 0 }, "retries": 0,
        "modelInference": false, "semanticAccepted": false, "productionAccepted": false,
    })).expect("exclusive mode reservation; no repeated attempt");
    let mut observation = Observation::default();
    let result = perform(&run, &mut observation);
    let failure_receipt_error = if result.is_err()
        && run.mode == Mode::Generate
        && !observation.raw_persisted
    {
        exclusive_json(&run.path("pre-output-error"), &json!({
            "version": "NativeSourceInterpretationQaPreOutputFailureV1", "phase": "source_interpretation_qa_pre_output_error",
            "error": result.as_ref().err(), "rawObservation": observation.raw_observation,
            "failureStage": if observation.raw_observation.is_some() { "raw_persistence" } else { "before_raw_observation" },
            "generationCalls": observation.generation_calls,
            "rawPersisted": false, "modelInference": observation.model_inference,
            "semanticAccepted": false, "productionAccepted": false,
        })).err()
    } else {
        None
    };
    let terminal = json!({
        "version": "NativeSourceInterpretationQaTerminalV1", "phase": "source_interpretation_qa_terminal",
        "mode": run.mode.name(), "arm": run.arm, "protocolResult": result,
        "generationCalls": observation.generation_calls, "modelInference": observation.model_inference,
        "rawPersisted": observation.raw_persisted, "bindingChecked": observation.binding_checked,
        "rawObservationIfUnpersisted": if observation.raw_persisted { None } else { observation.raw_observation.as_ref() },
        "failureReceiptPersistenceError": failure_receipt_error,
        "nativeIoAuthenticated": false, "semanticAccepted": false, "productionAccepted": false,
        "reviewInvoked": false, "answerInvoked": false, "publicationInvoked": false,
        "independentMeaningGrade": "not_assessed", "criterion6": "not_assessed",
        "coordinatorSourceBinaryVerificationRequired": true, "runnerSourceBinaryVerified": false,
    });
    println!("{terminal}");
    let terminal_persistence = exclusive_json(
        &run.path(&format!("{}-terminal", run.mode.name())),
        &terminal,
    );
    if let Err(error) = &terminal_persistence {
        println!(
            "{}",
            json!({"phase":"source_interpretation_qa_terminal_persistence_error", "error":error,
            "protocolError":result.as_ref().err(), "semanticAccepted":false, "productionAccepted":false})
        );
    }
    result.expect("QA protocol failed; raw/terminal observations precede this assertion");
    terminal_persistence.expect("retain terminal protocol observation");
}

#[test]
fn canonical_230_byte_qa_fixture_preserves_v6_native_span_metadata() {
    let (sources, prepared) = fixture().unwrap();
    assert_eq!(ORIGINAL.len(), 230);
    assert_eq!(source_revision(ORIGINAL), ORIGINAL_SHA);
    let spans = sources
        .spans()
        .map(serde_json::to_value)
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(json!(spans), retained_v6_spans());
    for (id, start, end, _, _, sha) in UNITS {
        assert_eq!(source_revision(&ORIGINAL[start..end]), sha);
        assert_eq!(
            id,
            format!(
                "Q-{}",
                &source_revision(&format!("{ORIGINAL_SHA}:{start}:{end}"))[..32]
            )
        );
    }
    let user: Value = serde_json::from_str(prepared.user()).unwrap();
    assert_eq!(user["originalSpans"], retained_v6_spans());
    assert_eq!(user["version"], "NativeSourceInterpretationQaInputV1");
    assert_eq!(user["independentVerificationReceipts"], json!([]));
    assert!(user.get("question").is_none());
    assert!(user.get("criteria").is_none());
    assert_eq!(prepared.count().units(), 3);
}

#[test]
fn canonical_qa_units_share_one_document_and_keep_the_full_selected_context() {
    let (sources, _) = fixture().unwrap();
    assert_eq!(sources.documents().len(), 1);
    assert_eq!(sources.spans().count(), 3);
    assert_eq!(
        sources.spans().map(|span| span.text().len()).sum::<usize>(),
        129
    );
    let source: Value = serde_json::to_value(sources).unwrap();
    assert_eq!(source["scope"], "all");
    assert_eq!(source["sources"][0]["id"], SOURCE_ID);
    assert_eq!(source["sources"][0]["revision"], ORIGINAL_SHA);
    assert_eq!(source["sources"][0]["spans"], retained_v6_spans());
    assert_eq!(CONTEXT as usize - OUTPUT as usize - RESERVE, INPUT_LIMIT);
    assert_eq!(
        sampler().unwrap(),
        json!({
            "profile":"existingGroundedV1", "order":["grammar","penalties","top_k","top_p","temperature","dist"],
            "penaltyLastN":256, "repeatPenalty":1.0_f32, "frequencyPenalty":0.0_f32, "presencePenalty":1.5_f32,
            "topK":20, "topP":0.8_f32, "minKeep":1, "temperature":0.7_f32, "seed":42,
        })
    );
}
