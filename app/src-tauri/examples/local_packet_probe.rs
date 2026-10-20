//! QA-only exact recorded-message replay, without product publication authority.

#[path = "local_packet_probe/contract.rs"]
mod contract;

#[path = "local_packet_probe/presence_contract.rs"]
mod presence_contract;

#[path = "local_packet_probe/presence_replay.rs"]
mod presence_replay;

use contract::{hash, model, options, preflight, read, Options, Packet, OUTPUT_BUDGETS};
use myco_lib::local_llm::{GenerationSchema, LocalLlm};
use myco_lib::local_model::resolve_verified_artifact;
use serde_json::{json, Value};
use std::sync::atomic::AtomicBool;
use std::time::Instant;

fn main() {
    let result = options(std::env::args().skip(1)).and_then(run);
    println!(
        "{}",
        json!({"phase":"replay_terminal","error":result.as_ref().err(),
        "semanticAccepted":false,"productionAccepted":false,"nativeIoAuthenticated":false,
        "productRoleAuthorized":false,"plannerRecallReviewIpcInstalled":"not_run"})
    );
    if result.is_err() {
        std::process::exit(1);
    }
}

fn run(options: Options) -> Result<(), String> {
    if let Some(execution) = &options.execution_registration {
        return presence_replay::run(&options, execution);
    }
    // The messages are read once and retained. Metadata and prior outputs never
    // enter the decoder, and old native grants confer no replay authority.
    let packet = read(
        &options.packet_path,
        &options.packet_sha256,
        &options.model_id,
    )?;
    let selected = model(&options.model_id)?;
    println!(
        "{}",
        json!({"phase":"replay_registration","packetSha256":options.packet_sha256,
        "model":packet.model,"source":packet.source,"runtime":packet.runtime,"sampler":packet.sampler,
        "systemSha256":packet.system_sha256,"userSha256":packet.user_sha256,
        "originalPromptTokens":packet.original_prompt_tokens,"originalOutputTokens":packet.original_output_tokens,
        "originalLoopStop":packet.original_loop_stop,"contextTokens":packet.context_tokens,
        "outputBudgets":OUTPUT_BUDGETS,"semanticAccepted":false,"productionAccepted":false})
    );
    let started = Instant::now();
    let path = resolve_verified_artifact(&options.model_dir, selected)?;
    println!(
        "{}",
        json!({"phase":"replay_artifact_verified","model":selected,
        "elapsedMs":started.elapsed().as_secs_f64()*1000.0})
    );
    let mut host = LocalLlm::load_embed_host()?;
    let result = (|| {
        let started = Instant::now();
        host.ensure_chat_model(&path)?;
        println!(
            "{}",
            json!({"phase":"replay_host_loaded","elapsedMs":started.elapsed().as_secs_f64()*1000.0})
        );
        replay(&host, &packet)
    })();
    drop(host);
    println!(
        "{}",
        json!({"phase":"replay_host_dropped","ownedHostDropCompleted":true,
        "processGlobalBackendReleaseObserved":false,"gpuMemoryReturnObserved":false})
    );
    result
}

fn replay(host: &LocalLlm, packet: &Packet) -> Result<(), String> {
    let prompt_tokens = host.chat_token_count(&packet.system, &packet.user)?;
    let mut failures = Vec::new();
    let mut decoder_attempts_started = 0;
    let mut decoder_attempts_observed = 0;
    for output_tokens in OUTPUT_BUDGETS {
        let started = Instant::now();
        let mut telemetry = None;
        let result = preflight(packet, prompt_tokens, output_tokens).and_then(|_| {
            decoder_attempts_started += 1;
            println!(
                "{}",
                json!({"phase":"replay_generation_started","outputTokens":output_tokens,
                "promptTokens":prompt_tokens,"contextTokens":packet.context_tokens})
            );
            let attempt = host.generate_structured_cancellable_measured(
                &packet.system,
                &packet.user,
                output_tokens,
                packet.context_tokens,
                GenerationSchema::WikiClaimsV1,
                &AtomicBool::new(false),
            );
            telemetry = Some(attempt.telemetry().clone());
            decoder_attempts_observed += 1;
            attempt.into_result()
        });
        let parsed = result
            .as_ref()
            .ok()
            .map(|output| serde_json::from_str::<Value>(output));
        let complete_json = parsed.as_ref().is_some_and(Result::is_ok);
        let parse_error = parsed
            .as_ref()
            .and_then(|parsed| parsed.as_ref().err())
            .map(ToString::to_string);
        println!(
            "{}",
            json!({"phase":"replay_generation_observed","outputTokens":output_tokens,
            "contextTokens":packet.context_tokens,"promptTokens":prompt_tokens,"telemetry":telemetry,
            "systemSha256":hash(packet.system.as_bytes()),"userSha256":hash(packet.user.as_bytes()),
            "grammarSha256":packet.runtime.grammar_sha256,"sampler":packet.sampler,
            "output":result.as_ref().ok(),"outputSha256":result.as_ref().ok().map(|value|hash(value.as_bytes())),
            "error":result.as_ref().err(),"jsonComplete":complete_json,"jsonParseError":parse_error,
            "elapsedMs":started.elapsed().as_secs_f64()*1000.0,
            "sourceSetValidation":"not_run","meaningEvaluation":"not_run",
            "semanticAccepted":false,"productionAccepted":false})
        );
        if !complete_json {
            failures.push(format!(
                "output budget {output_tokens}: {}",
                result
                    .err()
                    .or(parse_error)
                    .unwrap_or_else(|| "no complete JSON".into())
            ));
        }
    }
    println!(
        "{}",
        json!({"phase":"replay_pair_observed","scheduled":OUTPUT_BUDGETS.len(),
        "resultObservations":OUTPUT_BUDGETS.len(),"decoderAttemptsStarted":decoder_attempts_started,
        "decoderAttemptsObserved":decoder_attempts_observed,"failures":failures,
        "timingScope":"ordered same-host packet stages; not user-answer means"})
    );
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}
