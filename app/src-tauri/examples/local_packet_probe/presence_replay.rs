//! One explicit QA profile pair; admission and decoder failures keep both arms.

use super::contract::{hash, model, preflight, ExecutionRegistrationOptions, Options, Packet};
use super::presence_contract::{read, Registration};
use myco_lib::local_llm::{LocalLlm, WikiClaimsSamplerQaProfile};
use myco_lib::local_model::resolve_verified_artifact;
use serde_json::{json, Value};
use std::sync::atomic::AtomicBool;
use std::time::Instant;

#[derive(Default)]
struct Counters {
    api_started: usize,
    api_observed: usize,
    sampling_loops: usize,
}

pub(super) fn run(
    options: &Options,
    execution: &ExecutionRegistrationOptions,
) -> Result<(), String> {
    let (registration, packet) = read(
        &execution.path,
        &execution.sha256,
        &options.packet_path,
        &options.packet_sha256,
        &options.model_id,
    )?;
    println!(
        "{}",
        json!({"phase":"presence_registration","registrationSha256":execution.sha256,
        "packetSha256":options.packet_sha256,"registeredArms":registration.arm_ids,
        "profiles":registration.profiles,"model":packet.model,"originalSource":packet.source,
        "originalRuntime":packet.runtime,"originalSampler":packet.sampler,
        "treatment":registration.treatment,
        "executionRuntime":registration.execution_runtime,
        "originalOutputTokens":packet.original_output_tokens,
        "outputTokens":registration.output_tokens,"contextTokens":registration.context_tokens,
        "systemSha256":packet.system_sha256,"userSha256":packet.user_sha256,
        "grammarPinOrigin":"frozenSourceSchemaMapping",
        "originalSamplerParametersOrigin":"frozenSamplerSource",
        "semanticAccepted":false,"productionAccepted":false})
    );
    let started = Instant::now();
    let path = match resolve_verified_artifact(&options.model_dir, model(&options.model_id)?) {
        Ok(path) => path,
        Err(error) => return unstarted(&registration, "artifact", error),
    };
    println!(
        "{}",
        json!({"phase":"presence_artifact_verified",
        "treatment":registration.treatment,
        "elapsedMs":started.elapsed().as_secs_f64()*1000.0})
    );
    let mut host = match LocalLlm::load_embed_host() {
        Ok(host) => host,
        Err(error) => return unstarted(&registration, "host_creation", error),
    };
    let result = (|| {
        let started = Instant::now();
        if let Err(error) = host.ensure_chat_model(&path) {
            return unstarted_arms(&registration, "model_load", error);
        }
        println!(
            "{}",
            json!({"phase":"presence_host_loaded",
            "treatment":registration.treatment,
            "elapsedMs":started.elapsed().as_secs_f64()*1000.0})
        );
        let prompt_tokens = match host.chat_token_count(&packet.system, &packet.user) {
            Ok(tokens) => tokens,
            Err(error) => return unstarted_arms(&registration, "tokenize", error),
        };
        replay_pair(&host, &registration, &packet, prompt_tokens)
    })();
    drop(host);
    println!(
        "{}",
        json!({"phase":"presence_host_lifecycle","hostCreated":true,
        "treatment":registration.treatment,
        "disposition":"dropped","ownedHostDropCompleted":true,
        "processGlobalBackendReleaseObserved":false,"gpuMemoryReturnObserved":false})
    );
    result
}

fn unstarted(registration: &Registration, stage: &str, error: String) -> Result<(), String> {
    let result = unstarted_arms(registration, stage, error);
    println!(
        "{}",
        json!({"phase":"presence_host_lifecycle","hostCreated":false,
        "treatment":registration.treatment,
        "disposition":"not_created","ownedHostDropCompleted":false,
        "processGlobalBackendReleaseObserved":false,"gpuMemoryReturnObserved":false})
    );
    result
}

fn unstarted_records(registration: &Registration, stage: &str, error: &str) -> Vec<Value> {
    registration
        .arm_ids
        .iter()
        .zip(&registration.profiles)
        .map(|(id, profile)| {
            json!({"phase":"presence_arm_terminal","armId":id,"profile":profile,
            "treatment":registration.treatment,
            "state":"not_started","stage":stage,"error":error,"telemetry":null,
            "jsonComplete":false,"meaningEvaluation":"not_run",
            "sourceSetValidation":"not_run","semanticAccepted":false,
            "productionAccepted":false})
        })
        .collect()
}

fn unstarted_arms(registration: &Registration, stage: &str, error: String) -> Result<(), String> {
    for record in unstarted_records(registration, stage, &error) {
        println!("{record}");
    }
    emit_pair(registration, &Counters::default());
    Err(error)
}

fn profile(name: &str) -> Result<WikiClaimsSamplerQaProfile, String> {
    match name {
        "existingGroundedV1" => Ok(WikiClaimsSamplerQaProfile::ExistingGroundedV1),
        "existingGroundedNoPresenceQaV1" => {
            Ok(WikiClaimsSamplerQaProfile::ExistingGroundedNoPresenceQaV1)
        }
        "gemmaInstructionFamilyQaV1" => Ok(WikiClaimsSamplerQaProfile::GemmaInstructionFamilyQaV1),
        _ => Err("unregistered presence QA profile".into()),
    }
}

fn replay_pair(
    host: &LocalLlm,
    registration: &Registration,
    packet: &Packet,
    prompt_tokens: usize,
) -> Result<(), String> {
    let mut counters = Counters::default();
    let mut failures = Vec::new();
    for (id, name) in registration.arm_ids.iter().zip(&registration.profiles) {
        let started = Instant::now();
        let selected = profile(name)?;
        let mut telemetry = None;
        let admitted = preflight(packet, prompt_tokens, registration.output_tokens);
        let state;
        let result = match admitted {
            Err(error) => {
                state = "preflight_failed";
                Err(error)
            }
            Ok(()) => {
                counters.api_started += 1;
                println!(
                    "{}",
                    json!({"phase":"presence_api_started","armId":id,"profile":name,
                    "treatment":registration.treatment,
                    "outputTokens":registration.output_tokens,"promptTokens":prompt_tokens,
                    "contextTokens":registration.context_tokens,
                    "selectedExecutionSampler":selected.qa_parameters()})
                );
                let attempt = host.generate_wiki_claims_cancellable_measured_qa(
                    &packet.system,
                    &packet.user,
                    registration.output_tokens,
                    registration.context_tokens,
                    selected,
                    &AtomicBool::new(false),
                );
                let observed = attempt.telemetry().clone();
                counters.api_observed += 1;
                counters.sampling_loops +=
                    usize::from(observed.elapsed_micros.sampling_loop.is_some());
                telemetry = Some(observed);
                let result = attempt.into_result();
                state = if result.is_ok() {
                    "returned"
                } else {
                    "generation_failed"
                };
                result
            }
        };
        let parsed = result
            .as_ref()
            .ok()
            .map(|text| serde_json::from_str::<Value>(text));
        let complete = parsed.as_ref().is_some_and(Result::is_ok);
        let parse_error = parsed
            .as_ref()
            .and_then(|r| r.as_ref().err())
            .map(ToString::to_string);
        println!(
            "{}",
            json!({"phase":"presence_arm_terminal","armId":id,"profile":name,"state":state,
            "treatment":registration.treatment,
            "outputTokens":registration.output_tokens,"contextTokens":registration.context_tokens,
            "promptTokens":prompt_tokens,"selectedExecutionSampler":selected.qa_parameters(),
            "telemetry":telemetry,"output":result.as_ref().ok(),
            "outputSha256":result.as_ref().ok().map(|text|hash(text.as_bytes())),
            "error":result.as_ref().err(),"jsonComplete":complete,"jsonParseError":parse_error,
            "systemSha256":hash(packet.system.as_bytes()),"userSha256":hash(packet.user.as_bytes()),
            "grammarSha256":registration.execution_runtime.runtime.grammar_sha256,
            "elapsedMs":started.elapsed().as_secs_f64()*1000.0,
            "sourceSetValidation":"not_run","meaningEvaluation":"not_run",
            "semanticAccepted":false,"productionAccepted":false})
        );
        if !complete {
            failures.push(format!(
                "{id}: {}",
                result
                    .err()
                    .or(parse_error)
                    .unwrap_or_else(|| "incomplete JSON".into())
            ));
        }
    }
    emit_pair(registration, &counters);
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

fn emit_pair(registration: &Registration, counters: &Counters) {
    println!(
        "{}",
        json!({"phase":"presence_pair_observed","scheduledArms":2,"terminalArmRecords":2,
        "treatment":registration.treatment,
        "measuredApiAttemptsStarted":counters.api_started,
        "measuredApiAttemptsObserved":counters.api_observed,
        "samplingLoopsEntered":counters.sampling_loops,
        "timingScope":"ordered same-host decoder stages; not product answer means"})
    );
}
