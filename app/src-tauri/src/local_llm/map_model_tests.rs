//! Synthetic exact-input replay; does not issue native opening or publication grants.
use super::*;
use crate::importers::wikify::source_revision;
use serde_json::{json, Value};

const CONTROLS: &str = include_str!("../../../docs/research/2026-11-11-map-model-controls.json");
const CANDIDATE: &str =
    include_str!("../../../docs/research/2026-11-11-map-model-candidate-controls.json");
const FACT_CANDIDATE: &str =
    include_str!("../../../docs/research/2026-11-11-map-model-fact-controls.json");

#[test]
fn frozen_map_prompts_have_exact_original_and_prompt_revisions() {
    for source in [CONTROLS, CANDIDATE, FACT_CANDIDATE] {
        check_frozen_controls(source);
    }
}

#[test]
fn map_candidate_preserves_sources_and_acceptance_controls() {
    for source in [CANDIDATE, FACT_CANDIDATE] {
        check_comparison_controls(source);
    }
}

fn check_comparison_controls(source: &str) {
    let baseline: Value = serde_json::from_str(CONTROLS).unwrap();
    let candidate: Value = serde_json::from_str(source).unwrap();
    for field in [
        "modelId",
        "outputTokens",
        "contextTokens",
        "repeats",
        "acceptance",
    ] {
        assert_eq!(baseline[field], candidate[field], "{field}");
    }
    let originals = baseline["cases"].as_array().unwrap();
    let candidates = candidate["cases"].as_array().unwrap();
    assert_eq!(originals.len(), candidates.len());
    for (original, candidate) in originals.iter().zip(candidates) {
        for field in [
            "id",
            "cluster",
            "documents",
            "requiredClaims",
            "forbiddenClaims",
            "user",
        ] {
            assert_eq!(original[field], candidate[field], "{field}");
        }
    }
}

fn check_frozen_controls(source: &str) {
    let controls: Value = serde_json::from_str(source).unwrap();
    for case in controls["cases"].as_array().unwrap() {
        for document in case["documents"].as_array().unwrap() {
            assert_eq!(
                source_revision(document["raw"].as_str().unwrap()),
                document["sha256"]
            );
        }
        assert_eq!(
            source_revision(case["localPrompt"].as_str().unwrap()),
            case["localPromptSha256"]
        );
        assert_eq!(
            case["localPrompt"],
            format!(
                "{}\n\n{}",
                controls["system"].as_str().unwrap(),
                case["user"].as_str().unwrap()
            )
        );
    }
}

#[test]
#[ignore = "requires explicit offline synthetic QA and verified cached local weights"]
fn cached_model_repeats_exact_map_prompts() {
    assert_eq!(std::env::var("MYCO_QA_GENERATION").as_deref(), Ok("1"));
    let source = match std::env::var("MYCO_MAP_QA_VARIANT").as_deref() {
        Ok("metadata-boundary-v1") => CANDIDATE,
        Ok("fact-boundary-v2") => FACT_CANDIDATE,
        Ok("baseline") | Err(_) => CONTROLS,
        Ok(other) => panic!("unknown map QA variant: {other}"),
    };
    check_frozen_controls(source);
    check_comparison_controls(source);
    let controls: Value = serde_json::from_str(source).unwrap();
    let manifest = crate::local_model::manifest_for(controls["modelId"].as_str()).unwrap();
    let directory = std::env::var_os("MYCO_SESSION_PACKET_MODEL_DIR")
        .expect("explicit cached artifact directory");
    let artifact =
        crate::local_model::resolve_verified_artifact(Path::new(&directory), manifest).unwrap();
    println!(
        "{}",
        json!({"phase":"map_model_verified", "model":manifest,
        "controlsSha256":source_revision(source), "semanticAccepted":false})
    );
    let mut host = LocalLlm::load_embed_host().unwrap();
    host.ensure_chat_model(&artifact).unwrap();
    for repetition in 1..=controls["repeats"].as_u64().unwrap() {
        for case in controls["cases"].as_array().unwrap() {
            let prompt = case["localPrompt"].as_str().unwrap();
            let tokens = host.chat_token_count("", prompt).unwrap();
            let budget = controls["outputTokens"].as_i64().unwrap() as i32;
            assert!(tokens + budget as usize + 8 <= 4096);
            println!(
                "{}",
                json!({"phase":"map_model_input", "case":case["id"], "repetition":repetition,
                "system":"", "user":prompt, "promptTokens":tokens, "outputTokens":budget, "contextTokens":4096})
            );
            let started = std::time::Instant::now();
            let result =
                host.generate_text_cancellable("", prompt, budget, &AtomicBool::new(false));
            println!(
                "{}",
                json!({"phase":"map_model_output", "case":case["id"], "repetition":repetition,
                "result":result, "seconds":started.elapsed().as_secs_f64(), "semanticAccepted":false})
            );
        }
    }
}
