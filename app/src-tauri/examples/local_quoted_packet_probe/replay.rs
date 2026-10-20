//! Preserve both registered arms, raw outputs, structural checks and real counters.

use super::contract::{self, Options, ParsedPackage, Registration};
use super::original_contract::{hash, model};
use myco_lib::local_llm::{GenerationSchema, LocalLlm};
use myco_lib::local_model::resolve_verified_artifact;
use myco_lib::wiki_claims::quoted_qa::{
    occurrence_time_qa_system, validate_quoted_qa, QUOTED_CLAIMS_QA_SYSTEM,
};
use serde_json::{json, Value};
use std::sync::atomic::AtomicBool;
use std::time::Instant;

#[derive(Default)]
struct Counters {
    started: usize,
    observed: usize,
    loops: usize,
}

pub(super) fn run(options: Options) -> Result<(), String> {
    let (registration, package) = contract::read(
        &options.registration_path,
        &options.registration_sha256,
        &options.packet_path,
        &options.packet_sha256,
        &options.model_id,
    )?;
    println!(
        "{}",
        json!({"phase":"quoted_registration","registrationSha256":options.registration_sha256,
        "packetSha256":options.packet_sha256,"registeredArms":registration.arm_ids,"arms":registration.arms,
        "model":package.packet.model,"originalRuntime":package.packet.runtime,"executionRuntime":registration.execution_runtime,
        "originalSampler":package.packet.sampler,"originalSource":package.packet.source,
        "originalPromptTokens":package.packet.original_prompt_tokens,"originalOutputTokens":package.packet.original_output_tokens,
        "originalSystemSha256":package.packet.system_sha256,"userSha256":package.packet.user_sha256,
        "sources":package.sources,"sourceAdmission":"compiledSyntheticOriginalEquality",
        "semanticAccepted":false,"productionAccepted":false,"nativeIoAuthenticated":false})
    );
    let started = Instant::now();
    let path = match resolve_verified_artifact(&options.model_dir, model(&options.model_id)?) {
        Ok(path) => path,
        Err(error) => return unstarted(&registration, "artifact", error),
    };
    println!(
        "{}",
        json!({"phase":"quoted_artifact_verified","elapsedMs":started.elapsed().as_secs_f64()*1000.0})
    );
    let mut host = match LocalLlm::load_embed_host() {
        Ok(host) => host,
        Err(error) => return unstarted(&registration, "host_creation", error),
    };
    let started = Instant::now();
    let result = match host.ensure_chat_model(&path) {
        Ok(()) => {
            println!(
                "{}",
                json!({"phase":"quoted_host_loaded","elapsedMs":started.elapsed().as_secs_f64()*1000.0})
            );
            replay_pair(&host, &registration, &package)
        }
        Err(error) => unstarted_arms(&registration, "model_load", error),
    };
    drop(host);
    println!(
        "{}",
        json!({"phase":"quoted_host_lifecycle","hostCreated":true,"disposition":"dropped",
        "ownedHostDropCompleted":true,"processGlobalBackendReleaseObserved":false,"gpuMemoryReturnObserved":false})
    );
    result
}

fn unstarted(registration: &Registration, stage: &str, error: String) -> Result<(), String> {
    let result = unstarted_arms(registration, stage, error);
    println!(
        "{}",
        json!({"phase":"quoted_host_lifecycle","hostCreated":false,"disposition":"not_created",
        "ownedHostDropCompleted":false,"processGlobalBackendReleaseObserved":false,"gpuMemoryReturnObserved":false})
    );
    result
}

fn unstarted_records(registration: &Registration, stage: &str, error: &str) -> Vec<Value> {
    registration
        .arm_ids
        .iter()
        .zip(&registration.arms)
        .map(|(id, arm)| {
            json!({"phase":"quoted_arm_terminal",
        "armId":id,"arm":arm,"state":"not_started","stage":stage,"error":error,"telemetry":null,
        "jsonComplete":false,"sourceSetValidation":"not_run","meaningEvaluation":"not_run",
        "semanticAccepted":false,"productionAccepted":false})
        })
        .collect()
}

fn unstarted_arms(registration: &Registration, stage: &str, error: String) -> Result<(), String> {
    for record in unstarted_records(registration, stage, &error) {
        println!("{record}");
    }
    emit_pair(&Counters::default());
    Err(error)
}

fn selected(arm: &str) -> Result<GenerationSchema, String> {
    match arm {
        "baseline" => Ok(GenerationSchema::WikiClaimsV1),
        "quoted" | "quoted_control" | "quoted_interpretation" => {
            Ok(GenerationSchema::WikiQuotedClaimsQaV1)
        }
        _ => Err("unregistered quote arm".into()),
    }
}

fn preflight(original_prompt_tokens: usize, arm: &str, tokens: usize) -> Result<(), String> {
    selected(arm)?;
    if tokens == 0
        || tokens
            .checked_add(contract::OUTPUT_TOKENS as usize)
            .and_then(|n| n.checked_add(8))
            .map_or(true, |n| n > contract::CONTEXT_TOKENS as usize)
    {
        return Err("complete quote input and output reserve do not fit".into());
    }
    if arm == "baseline" && tokens != original_prompt_tokens {
        return Err("baseline tokenizer/template differs from original observation".into());
    }
    Ok(())
}

fn replay_pair(
    host: &LocalLlm,
    registration: &Registration,
    package: &ParsedPackage,
) -> Result<(), String> {
    let mut counters = Counters::default();
    let mut failures = Vec::new();
    for (id, arm) in registration.arm_ids.iter().zip(&registration.arms) {
        let started = Instant::now();
        let schema = selected(arm)?;
        let system = match arm.as_str() {
            "baseline" => package.packet.system.clone(),
            "quoted" | "quoted_control" => QUOTED_CLAIMS_QA_SYSTEM.into(),
            "quoted_interpretation" => occurrence_time_qa_system(),
            _ => return Err("unregistered quoted replay SYSTEM".into()),
        };
        let token_result = host.chat_token_count(&system, &package.packet.user);
        let prompt_tokens = token_result.as_ref().ok().copied();
        let mut telemetry = None;
        let admitted = token_result
            .and_then(|tokens| preflight(package.packet.original_prompt_tokens, arm, tokens));
        let result=admitted.and_then(|()| {
            counters.started+=1;
            println!("{}",json!({"phase":"quoted_api_started","armId":id,"arm":arm,"promptTokens":prompt_tokens,
                "outputTokens":contract::OUTPUT_TOKENS,"contextTokens":contract::CONTEXT_TOKENS,
                "systemSha256":hash(system.as_bytes()),"userSha256":package.packet.user_sha256,
                "grammarSha256":schema.qa_grammar_sha256(),"selectedExecutionSampler":package.packet.sampler}));
            let attempt=host.generate_structured_cancellable_measured(&system,&package.packet.user,contract::OUTPUT_TOKENS,
                contract::CONTEXT_TOKENS,schema,&AtomicBool::new(false));
            counters.observed+=1; counters.loops+=usize::from(attempt.telemetry().elapsed_micros.sampling_loop.is_some());
            telemetry=Some(attempt.telemetry().clone()); attempt.into_result()
        });
        let parsed = result
            .as_ref()
            .ok()
            .map(|text| serde_json::from_str::<Value>(text));
        let complete = parsed.as_ref().is_some_and(Result::is_ok);
        let parse_error = parsed
            .as_ref()
            .and_then(|value| value.as_ref().err())
            .map(ToString::to_string);
        let checked = result.as_ref().map_err(Clone::clone).and_then(|output| {
            if arm == "baseline" {
                package
                    .sources
                    .validate(output, &package.origin, package.scope)
                    .and_then(|claims| {
                        serde_json::to_value(json!({"claims":claims,"quotes":[]}))
                            .map_err(|e| e.to_string())
                    })
            } else {
                validate_quoted_qa(&package.sources, output, &package.origin, package.scope)
                    .and_then(|claims| serde_json::to_value(claims).map_err(|e| e.to_string()))
            }
        });
        let state = if telemetry.is_none() {
            "preflight_failed"
        } else if result.is_err() {
            "generation_failed"
        } else if checked.is_err() {
            "returned_structurally_rejected"
        } else {
            "returned_structurally_bound"
        };
        println!(
            "{}",
            json!({"phase":"quoted_arm_terminal","armId":id,"arm":arm,"state":state,
            "promptTokens":prompt_tokens,"outputTokens":contract::OUTPUT_TOKENS,"contextTokens":contract::CONTEXT_TOKENS,
            "telemetry":telemetry,"output":result.as_ref().ok(),"outputSha256":result.as_ref().ok().map(|text|hash(text.as_bytes())),
            "error":result.as_ref().err(),"jsonComplete":complete,"jsonParseError":parse_error,
            "sourceSetValidation":if checked.is_ok(){"pureSyntheticStructureBound"}else{"not_bound"},
            "structuralError":checked.as_ref().err(),"checkedProposals":checked.as_ref().ok(),
            "systemSha256":hash(system.as_bytes()),"userSha256":package.packet.user_sha256,"grammarSha256":schema.qa_grammar_sha256(),
            "selectedExecutionSampler":package.packet.sampler,"elapsedMs":started.elapsed().as_secs_f64()*1000.0,
            "meaningEvaluation":"not_run","semanticAccepted":false,"productionAccepted":false,"nativeIoAuthenticated":false})
        );
        if !complete || checked.is_err() {
            failures.push(format!(
                "{id}: {}",
                result
                    .err()
                    .or(parse_error)
                    .or(checked.err())
                    .unwrap_or_else(|| "incomplete JSON".into())
            ));
        }
    }
    emit_pair(&counters);
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

fn emit_pair(counters: &Counters) {
    println!(
        "{}",
        json!({"phase":"quoted_pair_observed","scheduledArms":2,"terminalArmRecords":2,
        "measuredApiAttemptsStarted":counters.started,"measuredApiAttemptsObserved":counters.observed,
        "samplingLoopsEntered":counters.loops,"timingScope":"ordered same-host decoder stages; not product answer means"})
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interpretation_arms_keep_quoted_schema_and_reserve_the_complete_input() {
        for arm in ["quoted_control", "quoted_interpretation"] {
            assert_eq!(
                selected(arm).unwrap().qa_grammar_sha256(),
                GenerationSchema::WikiQuotedClaimsQaV1.qa_grammar_sha256()
            );
            assert!(preflight(2213, arm, 1619).is_ok());
            assert!(preflight(2228, arm, 1597).is_ok());
            assert!(preflight(2213, arm, 2552).is_ok());
            for tokens in [0, 2553, usize::MAX] {
                assert!(preflight(2213, arm, tokens).is_err());
            }
        }
    }

    #[test]
    fn both_arms_reserve_complete_input_and_baseline_keeps_exact_original_count() {
        assert!(preflight(2213, "baseline", 2213).is_ok());
        assert!(preflight(2213, "baseline", 2214).is_err());
        assert!(preflight(2213, "quoted", 2552).is_ok());
        for arm in ["baseline", "quoted"] {
            for tokens in [0, 2553, usize::MAX] {
                assert!(preflight(tokens, arm, tokens).is_err());
            }
        }
        assert!(preflight(2213, "presence0", 2213).is_err());
    }

    #[test]
    fn premodel_failure_retains_both_registered_arms_without_fake_execution() {
        let runtime = contract::execution_runtime();
        let registration:Registration=serde_json::from_value(json!({"version":1,"treatment":"quote-first-contract",
            "originalPacketSha256":"a".repeat(64),"originalInputProvenanceReceiptSha256":"b".repeat(64),
            "originalRuntime":runtime.runtime,"executionRuntime":runtime,
            "executionSourceReceiptSha256":"c".repeat(64),"executionBuildReceiptSha256":"d".repeat(64),
            "executionBinarySha256":"e".repeat(64),"approvedSourceDeltaReceiptSha256":"f".repeat(64),
            "arms":["baseline","quoted"],"outputTokens":1536,"contextTokens":4096,
            "modelId":myco_lib::local_model::MODEL.id,"armIds":["closed-baseline","closed-quoted"]})).unwrap();
        for stage in ["artifact", "host_creation", "model_load"] {
            let rows = unstarted_records(&registration, stage, "synthetic failure");
            assert_eq!(rows.len(), 2);
            for (row, id) in rows.iter().zip(&registration.arm_ids) {
                assert_eq!(row["armId"], *id);
                assert_eq!(row["state"], "not_started");
                assert_eq!(row["stage"], stage);
                assert_eq!(row["telemetry"], Value::Null);
                assert_eq!(row["semanticAccepted"], false);
                assert_eq!(row["productionAccepted"], false);
                assert_eq!(row["sourceSetValidation"], "not_run");
            }
        }
    }
}
