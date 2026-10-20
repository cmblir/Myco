//! Fixed recorded inputs rebound through native source/claim/compilation checks.
//! Review-only replay cannot establish whole compilation or installed acceptance.

use super::*;
use crate::local_llm::{GenerationSchema, LocalLlm};
use crate::session_compile::{compiler, review, schema, sources, SourceBinding};
use crate::vault_session::AgentVaultSession;
use crate::wiki_claims::{CompilationOriginal, SourceSet};
use serde_json::{json, Value};
use std::sync::atomic::AtomicBool;

#[test]
#[ignore = "requires pinned cached weights, frozen replay data and MYCO_QA_GENERATION=1"]
fn cached_model_replays_native_bound_session_reviews_once_per_arm() {
    replay(true);
}

#[test]
#[ignore = "requires pinned cached weights; tokenization and native rebind only, no inference"]
fn cached_model_preflights_native_bound_session_reviews_without_generation() {
    replay(false);
}

struct PreparedReview<'a> {
    case: &'a Value,
    index: usize,
    contract: SessionReviewDecodeQa,
    packet: SourceSet,
    claims: Vec<schema::NativeClaim>,
    compilation: schema::SessionCompilationV1,
    tokens: usize,
}

fn prepare_reviews<'a>(
    host: &LocalLlm,
    plan: &sources::PacketPlan,
    original: &CompilationOriginal<'_>,
    origin: &AgentVaultSession,
    cases: &'a [Value],
) -> Vec<PreparedReview<'a>> {
    cases
        .iter()
        .map(|case| {
            let index = case["packetIndex"].as_u64().unwrap() as usize;
            let extraction = case["extraction"].as_str().unwrap();
            let compilation = case["compilation"].as_str().unwrap();
            assert_eq!(source_revision(extraction), case["extractionSha256"]);
            assert_eq!(source_revision(compilation), case["compilationSha256"]);
            let contract = SessionReviewDecodeQa::issue(
                plan,
                index,
                original,
                origin,
                extraction,
                compilation,
            )
            .unwrap();
            assert_eq!(contract.system(), case["system"].as_str().unwrap());
            assert_eq!(contract.user(), case["user"].as_str().unwrap());
            assert_eq!(source_revision(contract.system()), case["systemSha256"]);
            assert_eq!(source_revision(contract.user()), case["userSha256"]);
            let packet = plan.packet(index, original, origin).unwrap();
            let claims = compiler::bind_claims(&packet, extraction, origin, index).unwrap();
            let compilation = schema::validate(compilation, &claims).unwrap();
            let tokens = host
                .chat_token_count(contract.system(), contract.user())
                .unwrap();
            assert!(tokens <= sources::MAX_INPUT_TOKENS);
            PreparedReview {
                case,
                index,
                contract,
                packet,
                claims,
                compilation,
                tokens,
            }
        })
        .collect()
}

fn replay(should_generate: bool) {
    if should_generate {
        assert_eq!(std::env::var("MYCO_QA_GENERATION").as_deref(), Ok("1"));
    } else {
        assert_ne!(std::env::var("MYCO_QA_GENERATION").as_deref(), Ok("1"));
    }
    let id = std::env::var("MYCO_SESSION_PACKET_MODEL_ID").unwrap();
    let expected_calls = match id.as_str() {
        "gemma-4-e4b-it-qat-q4_0" => 4,
        "qwen3.5-4b-q4_k_m" => 6,
        _ => panic!("unregistered review replay model"),
    };
    let directory = std::env::var_os("MYCO_SESSION_PACKET_MODEL_DIR").unwrap();
    let manifest = crate::local_model::manifest_for(Some(&id)).unwrap();
    let path =
        crate::local_model::resolve_verified_artifact(std::path::Path::new(&directory), manifest)
            .unwrap();
    let replay_bytes =
        std::fs::read(std::env::var_os("MYCO_SESSION_REVIEW_REPLAY_PATH").unwrap()).unwrap();
    assert_eq!(
        source_revision(std::str::from_utf8(&replay_bytes).unwrap()),
        "1a12ab1d3670944d8ad1f83ba6fbdcb2ba6ed63116c2d6c7e47159501f626a6e"
    );
    let replay: Value = serde_json::from_slice(&replay_bytes).unwrap();
    assert_eq!(replay["version"], json!(1));
    let original = replay["original"].as_str().unwrap();
    assert_eq!(source_revision(original), replay["originalSha256"]);
    let cases = replay["cases"].as_array().unwrap();
    let registered = [
        ("gemma-0", "gemma-4-e4b-it-qat-q4_0", 0),
        ("gemma-1", "gemma-4-e4b-it-qat-q4_0", 1),
        ("qwen-0", "qwen3.5-4b-q4_k_m", 0),
        ("qwen-1", "qwen3.5-4b-q4_k_m", 1),
        ("qwen-2", "qwen3.5-4b-q4_k_m", 2),
    ];
    assert_eq!(cases.len(), registered.len());
    for (case, (case_id, model_id, index)) in cases.iter().zip(registered) {
        assert_eq!(case["id"], case_id);
        assert_eq!(case["modelId"], model_id);
        assert_eq!(case["packetIndex"], index);
    }
    let mut host = LocalLlm::load_embed_host().unwrap();
    host.ensure_chat_model(&path).unwrap();
    let origin = AgentVaultSession {
        vault_path: "/synthetic/session-review-replay".into(),
        opening_token: "synthetic-review-replay-opening".into(),
    };
    let binding = SourceBinding {
        key: "codex:synthetic-native".into(),
        raw_path: "raw/conversations/codex/synthetic-native.md".into(),
        source_revision: source_revision(original),
    };
    let plan = sources::prepare(&binding, original, &origin, "en", |system, user| {
        host.chat_token_count(system, user)
    })
    .unwrap();
    assert_eq!(plan.revision, replay["planRevision"]);
    let original = CompilationOriginal::verify(original, &binding.source_revision).unwrap();
    let prepared = prepare_reviews(&host, &plan, &original, &origin, cases);
    for review in &prepared {
        println!(
            "{}",
            json!({"phase":"session_review_replay_preflight",
            "caseId":review.case["id"],"tokenizerModelId":id,
            "systemSha256":source_revision(review.contract.system()),
            "userSha256":source_revision(review.contract.user()),
            "baselineGrammarSha256":GenerationSchema::SessionReviewV1.qa_grammar_sha256(),
            "correlatedGrammarSha256":review.contract.grammar_sha256(),
            "promptTokens":review.tokens,"outputTokens":768,"contextTokens":4096,
            "nativeBound":true,"modelInference":false,"meaningAccepted":false,"productionAccepted":false})
        );
    }
    if !should_generate {
        return;
    }
    let flag = AtomicBool::new(false);
    let mut scheduled_calls = 0;
    let mut api_calls = 0;
    let mut inference_calls = 0;
    let mut correlated_valid = 0;
    for PreparedReview {
        case,
        index,
        contract,
        packet,
        claims,
        compilation,
        tokens,
    } in prepared
    {
        if case["modelId"] != id {
            continue;
        }
        for arm in ["baseline", "correlated"] {
            scheduled_calls += 1;
            println!(
                "{}",
                json!({"phase":"session_review_replay_input","caseId":case["id"],"model":manifest,
                "arm":arm,"call":scheduled_calls,"packetIndex":index,"system":contract.system(),"user":contract.user(),
                "systemSha256":source_revision(contract.system()),"userSha256":source_revision(contract.user()),
                "grammarSha256":if arm=="baseline"{GenerationSchema::SessionReviewV1.qa_grammar_sha256()}else{contract.grammar_sha256()},
                "promptTokens":tokens,"outputTokens":768,"contextTokens":4096,"meaningAccepted":false,"productionAccepted":false})
            );
            let mut result = None;
            let verdict = review::run(
                &plan,
                index,
                "qa-review-only-not-compilation",
                "en",
                &packet,
                &claims,
                &compilation,
                |system, user| host.chat_token_count(system, user),
                |system, user, output, context, _| {
                    api_calls += 1;
                    let attempt = if arm == "baseline" {
                        host.generate_structured_cancellable_measured(
                            system,
                            user,
                            output,
                            context,
                            GenerationSchema::SessionReviewV1,
                            &flag,
                        )
                    } else {
                        host.generate_session_review_cancellable_measured_qa(
                            system, user, output, context, &contract, &flag,
                        )
                    };
                    let telemetry = attempt.telemetry().clone();
                    let model_inference = telemetry
                        .prefill_completed_tokens
                        .is_some_and(|count| count > 0)
                        || telemetry.sampled_tokens.is_some_and(|count| count > 0);
                    inference_calls += usize::from(model_inference);
                    let raw = attempt.into_result();
                    println!(
                        "{}",
                        json!({"phase":"session_review_replay_generation_result","caseId":case["id"],"arm":arm,"call":scheduled_calls,"apiCall":api_calls,
                        "result":raw,"telemetry":telemetry,"modelInference":model_inference,
                        "meaningAccepted":false,"productionAccepted":false})
                    );
                    result = Some(raw.clone());
                    raw
                },
            );
            if arm == "correlated" && verdict.is_ok() {
                correlated_valid += 1;
            }
            println!(
                "{}",
                json!({"phase":"session_review_replay_native_result","caseId":case["id"],"arm":arm,"call":scheduled_calls,
                "rawObserved":result.is_some(),"structureValid":verdict.is_ok(),"nativeAccepted":verdict.as_ref().is_ok_and(|review|review.accepted()),
                "error":verdict.err(),"meaningAccepted":false,"productionAccepted":false})
            );
        }
    }
    println!(
        "{}",
        json!({"phase":"session_review_replay_terminal","scheduledCalls":scheduled_calls,
            "apiCalls":api_calls,"inferenceCalls":inference_calls,"wholeCompilerAttempts":0,"productionAccepted":false})
    );
    assert_eq!(scheduled_calls, expected_calls);
    assert_eq!(api_calls, expected_calls);
    assert_eq!(inference_calls, expected_calls);
    assert_eq!(
        correlated_valid,
        expected_calls / 2,
        "retain all outputs: a correlated decode still failed native review structure"
    );
}
