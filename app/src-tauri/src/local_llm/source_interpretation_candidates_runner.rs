//! Separate controlled QA arms reuse only the frozen original and runner IO.
//! Full native compiler, review, answer, publication and semantic acceptance
//! are deliberately absent. Select a candidate explicitly; use separate dirs.

use super::*;
use crate::wiki_claims::source_interpretation_qa::{
    prepare_candidate, CandidateQa, PreparedCandidateQa,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CandidateRegistration {
    version: String,
    candidate: String,
    source_baseline_sha256: String,
    binary_sha256: String,
    original_sha256: String,
    criteria_sha256: String,
    models: Vec<ModelPin>,
}

fn candidate() -> Result<CandidateQa, String> {
    match env("MYCO_SOURCE_INTERPRETATION_QA_CANDIDATE")?.as_str() {
        "facetsV2" => Ok(CandidateQa::FacetsV2),
        "ordinalV3" => Ok(CandidateQa::OrdinalV3),
        _ => Err("QA candidate must be facetsV2 or ordinalV3".into()),
    }
}

fn registered(run: &Run, selected: CandidateQa) -> Result<CandidateRegistration, String> {
    let (_, value) = read_json(&run.registration)?;
    let registration: CandidateRegistration = serde_json::from_value(value)
        .map_err(|error| format!("invalid candidate registration: {error}"))?;
    if registration.version != "NativeSourceInterpretationCandidateQaRegistrationV1"
        || registration.candidate != selected.output_version()
        || registration.original_sha256 != ORIGINAL_SHA
        || registration.criteria_sha256 != CRITERIA_SHA
        || !is_sha(&registration.source_baseline_sha256)
        || !is_sha(&registration.binary_sha256)
        || registration.models.len() != 2
    {
        return Err("candidate registration pins or original criteria differ".into());
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
            return Err("candidate model pin differs from the closed cached contract".into());
        }
    }
    Ok(registration)
}

fn prepared(selected: CandidateQa) -> Result<PreparedCandidateQa, String> {
    let (sources, _) = fixture()?;
    prepare_candidate(&sources, &origin(), Scope::All, selected)
}

fn original_graph(input: &Value, selected: CandidateQa) -> Result<Value, String> {
    match selected {
        CandidateQa::FacetsV2 => Ok(input["originalSpans"].clone()),
        CandidateQa::OrdinalV3 => {
            let rows = input["originalSpans"]
                .as_array()
                .ok_or("candidate ordinal input lacks its captured original rows")?;
            let mut originals = Vec::with_capacity(rows.len());
            for (ordinal, row) in rows.iter().enumerate() {
                if row["unitOrdinal"] != ordinal || row.as_object().map(|v| v.len()) != Some(2) {
                    return Err("candidate ordinal input changed its native row identity".into());
                }
                originals.push(row["original"].clone());
            }
            Ok(json!(originals))
        }
    }
}

fn candidate_admission(
    run: &Run,
    registration: &CandidateRegistration,
    host: &LocalLlm,
    prepared: &PreparedCandidateQa,
    path: &Path,
) -> Result<Value, String> {
    let pin = registration
        .models
        .iter()
        .find(|pin| pin.id == run.model_id)
        .ok_or("candidate model is not registered")?;
    let actual_path = path.to_str().ok_or("candidate model path is not UTF-8")?;
    let architecture = host
        .chat_model()?
        .meta_val_str("general.architecture")
        .map_err(|error| format!("candidate architecture: {error}"))?;
    let template = host
        .template
        .as_ref()
        .ok_or("candidate chat template is absent")?
        .to_str()
        .map_err(|error| format!("candidate template UTF-8: {error}"))?;
    let template_sha = source_revision(template);
    if actual_path != pin.path
        || architecture != pin.architecture
        || template_sha != pin.chat_template_sha256
    {
        return Err("candidate model path, architecture or template changed".into());
    }
    let input: Value = serde_json::from_str(prepared.user())
        .map_err(|error| format!("parse candidate input: {error}"))?;
    if input["version"] != prepared.variant().input_version()
        || original_graph(&input, prepared.variant())? != retained_v6_spans()
        || prepared.count().units() != 3
    {
        return Err("candidate input differs from the retained original graph".into());
    }
    let schema = GenerationSchema::NativeSourceInterpretationCandidateQa(prepared.count());
    let grammar = prepared.count().grammar();
    let (prompt, _) = host.format_chat(prepared.system(), prepared.user())?;
    let prompt_tokens = host.chat_token_count(prepared.system(), prepared.user())?;
    validate_generation_budget(prompt_tokens, OUTPUT, CONTEXT, Some(schema))?;
    if prompt_tokens == 0
        || prompt_tokens > INPUT_LIMIT
        || GENERATION_SAFETY_TOKENS != RESERVE
        || schema.qa_grammar_sha256() != source_revision(&grammar)
    {
        return Err("candidate prompt, grammar or reserve differs".into());
    }
    Ok(json!({
        "version":"NativeSourceInterpretationCandidateQaAdmissionV1", "candidate":registration.candidate,
        "phase":"source_interpretation_candidate_admission", "arm":run.arm,
        "manifest":crate::local_model::manifest_for(Some(&run.model_id))?, "modelPath":actual_path,
        "architecture":architecture, "chatTemplateSha256":template_sha,
        "sourceBaselineSha256":registration.source_baseline_sha256, "binarySha256":registration.binary_sha256,
        "coordinatorSourceBinaryVerificationRequired":true, "runnerSourceBinaryVerified":false,
        "original":ORIGINAL, "originalBytes":230, "originalSha256":ORIGINAL_SHA, "criteriaSha256":CRITERIA_SHA,
        "system":prepared.system(), "user":prepared.user(), "grammar":grammar,
        "systemSha256":source_revision(prepared.system()), "userSha256":source_revision(prepared.user()),
        "grammarSha256":schema.qa_grammar_sha256(), "effectivePromptSha256":source_revision(&prompt),
        "promptTokens":prompt_tokens, "outputTokens":OUTPUT, "contextTokens":CONTEXT, "reserveTokens":RESERVE,
        "sampler":sampler()?, "nonThinking":true, "exactUnitCount":3, "scope":"all",
        "nativeIoAuthenticated":false, "modelInference":false, "generationCalls":0,
        "semanticAccepted":false, "productionAccepted":false, "criterion6":"not_assessed",
        "intervention":match prepared.variant() {
            CandidateQa::FacetsV2 => "facet-set representation; positional association unchanged",
            CandidateQa::OrdinalV3 => "native fixed ordinal association; single assertion kind unchanged",
        },
    }))
}

fn forward_decode_attempted(telemetry: &generation_telemetry::GenerationTelemetry) -> bool {
    telemetry.elapsed_micros.prefill_decode_calls.is_some()
        || telemetry.elapsed_micros.output_decode_calls.is_some()
        || telemetry
            .prefill_completed_tokens
            .is_some_and(|count| count > 0)
        || telemetry.sampled_tokens.is_some_and(|count| count > 0)
}

fn perform_candidate(
    run: &Run,
    selected: CandidateQa,
    observed: &mut Observation,
) -> Result<&'static str, String> {
    let registration = registered(run, selected)?;
    let pin = registration
        .models
        .iter()
        .find(|pin| pin.id == run.model_id)
        .unwrap();
    let manifest = crate::local_model::manifest_for(Some(&run.model_id))?;
    let path = crate::local_model::resolve_verified_artifact(&run.model_dir, manifest)?;
    let mut host = LocalLlm::load_embed_host()?;
    host.ensure_chat_model(&path)?;
    let prepared = prepared(selected)?;
    let current = candidate_admission(run, &registration, &host, &prepared, &path)?;
    if run.mode == Mode::Admit {
        if pin.admission_sha256.is_some() {
            return Err("candidate admit requires null admission SHA".into());
        }
        exclusive_json(&run.path("admission"), &current)?;
        println!("{current}");
        return Ok("admitted_without_inference");
    }
    let expected_sha = pin
        .admission_sha256
        .as_deref()
        .ok_or("candidate generate requires frozen admission SHA")?;
    let (bytes, frozen) = read_json(&run.path("admission"))?;
    if format!("{:x}", Sha256::digest(&bytes)) != expected_sha || frozen != current {
        return Err("candidate frozen admission bytes or full equality changed".into());
    }
    let admitted_prompt_tokens = current["promptTokens"]
        .as_u64()
        .ok_or("candidate admission lacks measured token count")?
        as usize;
    exclusive_json(
        &run.path("generation-input"),
        &json!({
            "version":"NativeSourceInterpretationCandidateQaInputObservationV1", "candidate":selected.output_version(),
            "admissionSha256":expected_sha, "admission":current, "scheduledCalls":1, "retries":0,
            "modelInference":false, "semanticAccepted":false, "productionAccepted":false,
        }),
    )?;
    let schema = GenerationSchema::NativeSourceInterpretationCandidateQa(prepared.count());
    observed.generation_calls = 1;
    let attempt = host.generate_structured_cancellable_measured(
        prepared.system(),
        prepared.user(),
        OUTPUT,
        CONTEXT,
        schema,
        &AtomicBool::new(false),
    );
    let telemetry = attempt.telemetry().clone();
    observed.model_inference = forward_decode_attempted(&telemetry);
    let raw = attempt.into_result();
    let result = json!({
        "version":"NativeSourceInterpretationCandidateQaRawResultV1", "candidate":selected.output_version(),
        "call":1, "rawResult":raw, "telemetry":telemetry, "modelInference":observed.model_inference,
        "semanticAccepted":false, "productionAccepted":false,
    });
    println!("{result}");
    observed.raw_observation = Some(result.clone());
    exclusive_json(&run.path("generation-result"), &result)?;
    observed.raw_persisted = true;
    let raw = raw?;
    if telemetry.terminal != AttemptTerminal::ReturnedText
        || telemetry.terminal_phase != GenerationPhase::Finalize
        || telemetry.loop_stop != Some(LoopStop::Eog)
        || telemetry.error_code.is_some()
        || telemetry.pending_utf8_bytes != Some(0)
        || telemetry.profile != generation_telemetry::SamplerProfile::ExistingGroundedV1
        || telemetry.schema != generation_telemetry::TelemetrySchema::from(Some(schema))
        || telemetry.prompt_tokens != Some(admitted_prompt_tokens)
        || telemetry.requested_output_tokens != OUTPUT
        || telemetry.requested_context_tokens != CONTEXT
    {
        return Err(
            "candidate generation did not finish with clean EOG and registered decoder".into(),
        );
    }
    let bound = prepared.validate(&raw, &origin(), Scope::All)?;
    let bound = serde_json::to_value(bound)
        .map_err(|error| format!("serialize candidate binding: {error}"))?;
    if bound["bindingChecked"] != true
        || bound["nativeIoAuthenticated"] != false
        || bound["semanticAccepted"] != false
        || bound["productionAccepted"] != false
        || bound["semanticReviewRequired"] != true
    {
        return Err("candidate binding claims review or native authority".into());
    }
    let binding = json!({
        "version":"NativeSourceInterpretationCandidateQaBindingObservationV1", "candidate":selected.output_version(),
        "bound":bound, "nativeIoAuthenticated":false, "semanticAccepted":false, "productionAccepted":false,
        "reviewInvoked":false, "answerInvoked":false, "publicationInvoked":false, "criterion6":"not_assessed",
    });
    println!("{binding}");
    exclusive_json(&run.path("binding"), &binding)?;
    observed.binding_checked = true;
    Ok("bound_unreviewed_proposals_only")
}

#[test]
#[ignore = "requires explicit candidate, mode, frozen pins and cached model; generate does actual inference"]
fn cached_model_observes_source_interpretation_candidate_once() {
    let run = Run::read().expect("explicit QA runner environment");
    let selected = candidate().expect("explicit separate candidate");
    exclusive_json(&run.path(&format!("{}-reservation", run.mode.name())), &json!({
        "version":"NativeSourceInterpretationCandidateQaReservationV1", "candidate":selected.output_version(),
        "mode":run.mode.name(), "arm":run.arm,
        "scheduledCalls":if run.mode == Mode::Generate {1} else {0}, "retries":0,
        "modelInference":false, "semanticAccepted":false, "productionAccepted":false,
    })).expect("exclusive candidate reservation; no retry");
    let mut observed = Observation::default();
    let result = perform_candidate(&run, selected, &mut observed);
    let failure_receipt_error = if result.is_err()
        && run.mode == Mode::Generate
        && !observed.raw_persisted
    {
        exclusive_json(&run.path("pre-output-error"), &json!({
            "version":"NativeSourceInterpretationCandidateQaPreOutputFailureV1", "candidate":selected.output_version(),
            "error":result.as_ref().err(), "rawObservation":observed.raw_observation,
            "failureStage":if observed.raw_observation.is_some() {"raw_persistence"} else {"before_raw_observation"},
            "generationCalls":observed.generation_calls, "rawPersisted":false, "modelInference":observed.model_inference,
            "semanticAccepted":false, "productionAccepted":false,
        })).err()
    } else {
        None
    };
    let terminal = json!({
        "version":"NativeSourceInterpretationCandidateQaTerminalV1", "candidate":selected.output_version(),
        "mode":run.mode.name(), "arm":run.arm, "protocolResult":result,
        "generationCalls":observed.generation_calls, "modelInference":observed.model_inference,
        "rawPersisted":observed.raw_persisted, "bindingChecked":observed.binding_checked,
        "rawObservationIfUnpersisted":if observed.raw_persisted {None} else {observed.raw_observation.as_ref()},
        "failureReceiptPersistenceError":failure_receipt_error,
        "nativeIoAuthenticated":false, "semanticAccepted":false, "productionAccepted":false,
        "reviewInvoked":false, "answerInvoked":false, "publicationInvoked":false,
        "independentMeaningGrade":"not_assessed", "criterion6":"not_assessed",
        "coordinatorSourceBinaryVerificationRequired":true, "runnerSourceBinaryVerified":false,
    });
    println!("{terminal}");
    let persisted = exclusive_json(
        &run.path(&format!("{}-terminal", run.mode.name())),
        &terminal,
    );
    if let Err(error) = &persisted {
        println!(
            "{}",
            json!({"phase":"candidate_terminal_persistence_error", "error":error,
            "protocolError":result.as_ref().err(), "semanticAccepted":false, "productionAccepted":false})
        );
    }
    result.expect("candidate QA failed; raw and terminal precede this assertion");
    persisted.expect("candidate terminal persisted");
}

#[test]
fn candidate_decode_attempt_is_retained_when_no_tokens_complete() {
    let input = prepared(CandidateQa::FacetsV2).unwrap();
    let host = LocalLlm::load_embed_host().unwrap();
    let attempt = host.generate_structured_cancellable_measured(
        input.system(),
        input.user(),
        OUTPUT,
        CONTEXT,
        GenerationSchema::NativeSourceInterpretationCandidateQa(input.count()),
        &AtomicBool::new(false),
    );
    let baseline = attempt.telemetry().clone();
    assert!(attempt.into_result().is_err());
    assert!(!forward_decode_attempted(&baseline));
    for elapsed in [0, 1] {
        let mut prefill = baseline.clone();
        prefill.elapsed_micros.prefill_decode_calls = Some(elapsed);
        assert!(forward_decode_attempted(&prefill));
        let mut output = baseline.clone();
        output.elapsed_micros.output_decode_calls = Some(elapsed);
        assert!(forward_decode_attempted(&output));
    }
}

#[test]
fn candidate_preparation_preserves_exact_v1_prompt_grammar_and_original_graph() {
    let (_, legacy) = fixture().unwrap();
    assert_eq!(
        source_revision(legacy.system()),
        "281ce16cbda0fcc1ff55ffc2db363398309fe6e7ed8868a92c36618e2eb65976"
    );
    assert_eq!(
        source_revision(legacy.user()),
        "b1f8c62bb0c182d24c84664895bbcdc784e7a65c0742c91cb9f2208572e43d0d"
    );
    assert_eq!(
        source_revision(&legacy.count().grammar()),
        "6b824520000afa3f754e7a3b2e22e504a09da784481d8f1c4273f84a2b9f298d"
    );
    for selected in [CandidateQa::FacetsV2, CandidateQa::OrdinalV3] {
        let candidate = prepared(selected).unwrap();
        let input: Value = serde_json::from_str(candidate.user()).unwrap();
        assert_eq!(
            original_graph(&input, selected).unwrap(),
            retained_v6_spans()
        );
        assert_eq!(candidate.count().units(), 3);
        assert_eq!(candidate.variant(), selected);
        assert_eq!(candidate.count().variant(), selected);
    }
}
