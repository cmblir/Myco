//! Exactly two actual extraction calls, without review or compiler acceptance.

use super::*;
use crate::local_llm::LocalLlm;
use std::sync::atomic::AtomicBool;

#[test]
#[ignore = "requires pinned cached weights and MYCO_QA_GENERATION=1; two actual extraction calls"]
fn cached_model_compares_frozen_request_prompts_once_per_arm() {
    assert_eq!(std::env::var("MYCO_QA_GENERATION").as_deref(), Ok("1"));
    assert_eq!(
        std::env::var("MYCO_SESSION_PACKET_MODEL_ID").as_deref(),
        Ok(MODEL_ID)
    );
    let receipt = frozen_receipt(RECEIPT).unwrap();
    let directory = std::env::var_os("MYCO_SESSION_PACKET_MODEL_DIR")
        .expect("existing model directory is required");
    let manifest = crate::local_model::manifest_for(Some(MODEL_ID)).unwrap();
    let artifact =
        crate::local_model::resolve_verified_artifact(std::path::Path::new(&directory), manifest)
            .unwrap();
    let mut host = LocalLlm::load_embed_host().unwrap();
    host.ensure_chat_model(&artifact).unwrap();
    let prepared = prepare(&receipt, |system, user| host.chat_token_count(system, user)).unwrap();
    let grammar_sha256 = GenerationSchema::WikiClaimsV1.qa_grammar_sha256();
    let sampler = sampler_parameters().unwrap();
    println!(
        "{}",
        json!({"phase":"request_prompt_qa_preflight",
        "receiptSha256":RECEIPT_SHA256,"model":manifest,"packetIndex":PACKET_INDEX,
        "originalSha256":prepared.original_sha256,"planRevision":prepared.plan_revision,
        "userSha256":source_revision(&prepared.user),"grammarSha256":grammar_sha256,
        "baselineSystemSha256":source_revision(&prepared.baseline_system),
        "productionExtractionSystemSha256":source_revision(&crate::local_synthesis::claim_prompt::extraction_reading_system()),
        "productionExtractionSystemMatchesBaseline":prepared.production_system_matches,
        "sampler":sampler,"outputTokens":768,"contextTokens":4096,
        "frozenExpectedProposal":expected_proposal(),"frozenExpectedSpeaker":"user",
        "expectationScope":"single frozen request; exact fields and action after whitespace/case/trailing-period normalization, not general semantic equivalence",
        "observedBaselineReview":"uncertain; recorded only, no review inference in this comparison",
        "nativeSourceBound":true,"modelInference":false,"semanticAccepted":false,"productionAccepted":false})
    );
    let cancelled = AtomicBool::new(false);
    let mut api_calls = 0;
    let mut inference_calls = 0;
    let mut candidate_matched = false;
    let mut decoder_contracts_valid = true;
    for (index, (arm, system)) in [
        ("baseline", prepared.baseline_system.as_str()),
        (
            "imperative-request-guidance",
            prepared.candidate_system.as_str(),
        ),
    ]
    .into_iter()
    .enumerate()
    {
        println!(
            "{}",
            json!({"phase":"request_prompt_qa_input","arm":arm,"call":index+1,
            "system":system,"user":prepared.user,"systemSha256":source_revision(system),
            "userSha256":source_revision(&prepared.user),"promptTokens":prepared.prompt_tokens[index],
            "outputTokens":768,"contextTokens":4096,"schema":"WikiClaimsV1",
            "grammarSha256":grammar_sha256,"sampler":sampler,
            "semanticAccepted":false,"productionAccepted":false})
        );
        api_calls += 1;
        let attempt = host.generate_structured_cancellable_measured(
            system,
            &prepared.user,
            sources::OUTPUT_TOKENS,
            sources::CONTEXT_TOKENS,
            GenerationSchema::WikiClaimsV1,
            &cancelled,
        );
        let telemetry = attempt.telemetry().clone();
        let inferred = telemetry
            .prefill_completed_tokens
            .is_some_and(|tokens| tokens > 0)
            || telemetry.sampled_tokens.is_some_and(|tokens| tokens > 0);
        inference_calls += usize::from(inferred);
        let result = attempt.into_result();
        // Preserve both raw outputs even when an earlier arm fails native checks.
        println!(
            "{}",
            json!({"phase":"request_prompt_qa_generation_result","arm":arm,"call":index+1,
            "result":result,"telemetry":telemetry,"modelInference":inferred,
            "semanticAccepted":false,"productionAccepted":false})
        );
        let telemetry = serde_json::to_value(telemetry).unwrap();
        decoder_contracts_valid &= telemetry["profile"] == "existingGroundedV1"
            && telemetry["schema"] == "wikiClaimsV1"
            && telemetry["requestedOutputTokens"] == 768
            && telemetry["requestedContextTokens"] == 4096;
        let verdict = result.as_ref().ok().map(|output| judge(output, &prepared));
        if index == 1 {
            candidate_matched = verdict
                .as_ref()
                .is_some_and(|value| value["frozenExpectationMatched"] == true);
        }
        println!(
            "{}",
            json!({"phase":"request_prompt_qa_native_result","arm":arm,"call":index+1,
            "verdict":verdict,"generationError":result.err(),"semanticReview":"not_run",
            "semanticAccepted":false,"productionAccepted":false})
        );
    }
    drop(host);
    println!(
        "{}",
        json!({"phase":"request_prompt_qa_terminal","scheduledCalls":2,"apiCalls":api_calls,
        "inferenceCalls":inference_calls,"candidateFrozenExpectationMatched":candidate_matched,
        "decoderContractsValid":decoder_contracts_valid,"wholeCompilerAttempts":0,
        "structureCalls":0,"reviewCalls":0,"ownedHostDropCompleted":true,
        "semanticAccepted":false,"productionAccepted":false,"installedAcceptance":false})
    );
    assert!(
        decoder_contracts_valid,
        "recorded extraction decoder contract changed"
    );
    assert_eq!(api_calls, 2);
    assert_eq!(
        inference_calls, 2,
        "retain both outputs: one arm did not perform inference"
    );
    assert!(candidate_matched, "retain both outputs: request candidate failed native binding or the narrow frozen expectation; inspect raw output for meaning");
}
