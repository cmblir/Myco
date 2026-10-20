//! One closed recorded Ordinal replay and an independent prose-reading call.

#[path = "local_reading_probe/contract.rs"]
mod contract;

use contract::{hash, options, preflight, Prepared, CONTEXT, OUTPUT};
use myco_lib::local_llm::{GenerationSchema, LocalLlm};
use myco_lib::local_model::{resolve_verified_artifact, MODEL};
use serde_json::{json, Value};
use std::sync::atomic::AtomicBool;
use std::time::Instant;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Arm {
    Typed,
    Prose,
}

fn main() {
    let result = options(std::env::args().skip(1)).and_then(run);
    println!(
        "{}",
        json!({"phase":"reading_terminal","error":result.as_ref().err(),
        "semanticAccepted":false,"productionAccepted":false,"nativeIoAuthenticated":false,
        "productRoleAuthorized":false,"activityNativeValidation":"not_run",
        "plannerRecallMandatoryReviewWriterFinalReviewIpcInstalled":"not_run"})
    );
    if result.is_err() {
        std::process::exit(1);
    }
}

fn run(options: contract::Options) -> Result<(), String> {
    let prepared = contract::read(&options)?;
    let packet = &prepared.packet;
    println!(
        "{}",
        json!({"phase":"reading_admission","packetSha256":options.packet_sha256,
        "captureSha256":packet.source.capture_sha256,"observationOrdinal":2,
        "model":packet.model,"typedSystemSha256":packet.system_sha256,
        "proseSystemSha256":packet.prose_system_sha256,"userSha256":packet.user_sha256,
        "grammarSha256":packet.grammar_sha256,"typedSampler":packet.typed_sampler,
        "proseSampler":packet.prose_sampler,"sourceCount":prepared.sources.spans().count(),
        "arms":["typed","prose"],"callsPerArm":1,"outerRetries":0,
        "semanticAccepted":false,"productRoleAuthorized":false})
    );
    let started = Instant::now();
    let model = resolve_verified_artifact(&options.model_dir, &MODEL)?;
    println!(
        "{}",
        json!({"phase":"reading_model_verified","model":MODEL,
        "elapsedMs":started.elapsed().as_secs_f64()*1000.0})
    );
    let mut host = LocalLlm::load_embed_host()?;
    let result = (|| {
        let started = Instant::now();
        host.ensure_chat_model(&model)?;
        println!(
            "{}",
            json!({"phase":"reading_host_loaded","elapsedMs":started.elapsed().as_secs_f64()*1000.0})
        );
        run_pair(
            &prepared,
            |system, user| host.chat_token_count(system, user),
            |arm, system, user| {
                let cancelled = AtomicBool::new(false);
                let attempt = match arm {
                    Arm::Typed => host.generate_structured_cancellable_measured(
                        system,
                        user,
                        OUTPUT,
                        CONTEXT,
                        GenerationSchema::NativeSourceInterpretationCandidateQa(prepared.decoder),
                        &cancelled,
                    ),
                    Arm::Prose => {
                        host.generate_source_reading_qa_measured(system, user, &cancelled)
                    }
                };
                let telemetry =
                    serde_json::to_value(attempt.telemetry()).map_err(|e| e.to_string());
                (telemetry, attempt.into_result())
            },
        )
    })();
    drop(host);
    println!(
        "{}",
        json!({"phase":"reading_host_dropped","ownedHostDropCompleted":true,
        "processGlobalBackendReleaseObserved":false,"gpuMemoryReturnObserved":false})
    );
    result
}

fn run_pair(
    prepared: &Prepared,
    mut count: impl FnMut(&str, &str) -> Result<usize, String>,
    mut generate: impl FnMut(Arm, &str, &str) -> (Result<Value, String>, Result<String, String>),
) -> Result<(), String> {
    let p = &prepared.packet;
    let typed = count(&p.system, &p.user)?;
    let prose = count(&p.prose_system, &p.user)?;
    preflight(p.original_prompt_tokens, typed, prose)?;
    println!(
        "{}",
        json!({"phase":"reading_pair_fit","typedPromptTokens":typed,
        "prosePromptTokens":prose,"outputTokens":OUTPUT,"contextTokens":CONTEXT,"reserve":8})
    );
    let mut failures = Vec::new();
    for (arm, label, system, prompt_tokens) in [
        (Arm::Typed, "typed", p.system.as_str(), typed),
        (Arm::Prose, "prose", p.prose_system.as_str(), prose),
    ] {
        let started = Instant::now();
        println!(
            "{}",
            json!({"phase":"reading_generation_started","arm":label,
            "systemSha256":hash(system.as_bytes()),"userSha256":p.user_sha256,
            "promptTokens":prompt_tokens,"outputTokens":OUTPUT,"contextTokens":CONTEXT})
        );
        let (telemetry, result) = generate(arm, system, &p.user);
        let expected_schema = if arm == Arm::Typed {
            "nativeSourceInterpretationOrdinalQaV3"
        } else {
            "freeform"
        };
        let expected_profile = if arm == Arm::Typed {
            "existingGroundedV1"
        } else {
            "existingGroundedGrammarFreeQaV1"
        };
        let telemetry_matches = telemetry.as_ref().is_ok_and(|t| {
            t["schema"] == expected_schema
                && t["profile"] == expected_profile
                && t["promptTokens"].as_u64() == Some(prompt_tokens as u64)
                && t["requestedOutputTokens"] == OUTPUT
                && t["requestedContextTokens"] == CONTEXT
                && t["loopStop"] == "eog"
                && t["terminal"] == "returnedText"
                && t["errorCode"].is_null()
                && t["pendingUtf8Bytes"] == 0
        });
        let output_valid = result.as_ref().is_ok_and(|s| {
            !s.trim().is_empty() && (arm == Arm::Prose || serde_json::from_str::<Value>(s).is_ok())
        });
        println!(
            "{}",
            json!({"phase":"reading_generation_observed","arm":label,
            "systemSha256":hash(system.as_bytes()),"userSha256":p.user_sha256,
            "grammarSha256":if arm==Arm::Typed {Some(&p.grammar_sha256)} else {None},
            "telemetry":telemetry.as_ref().ok(),"telemetryError":telemetry.as_ref().err(),
            "output":result.as_ref().ok(),"outputSha256":result.as_ref().ok().map(|s|hash(s.as_bytes())),
            "error":result.as_ref().err(),"cleanObservedDecode":telemetry_matches && output_valid,
            "elapsedMs":started.elapsed().as_secs_f64()*1000.0,
            "activityNativeValidation":"not_run","mandatoryReview":"not_run",
            "meaningEvaluation":"not_run","semanticAccepted":false,"productionAccepted":false})
        );
        if !telemetry_matches || !output_valid {
            failures.push(format!(
                "{label}: {}",
                result
                    .err()
                    .or_else(|| telemetry.err())
                    .unwrap_or_else(|| "decoder observations or complete output differ".into())
            ));
        }
    }
    println!(
        "{}",
        json!({"phase":"reading_pair_observed","scheduled":2,"callsStarted":2,
        "callsObserved":2,"outerRetries":0,"feedbackBetweenArms":false,"failures":failures,
        "semanticAccepted":false,"productionAccepted":false})
    );
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

#[cfg(test)]
#[path = "local_reading_probe/tests.rs"]
mod tests;
