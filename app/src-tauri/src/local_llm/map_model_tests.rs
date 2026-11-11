//! Synthetic exact-input replay; does not issue native opening or publication grants.
use super::*;
use crate::importers::wikify::source_revision;
use serde_json::{json, Value};

const CONTROLS: &str = include_str!("../../../docs/research/2026-11-11-map-model-controls.json");
const CANDIDATE: &str =
    include_str!("../../../docs/research/2026-11-11-map-model-candidate-controls.json");
const FACT_CANDIDATE: &str =
    include_str!("../../../docs/research/2026-11-11-map-model-fact-controls.json");
const EXAMPLE_CANDIDATE: &str =
    include_str!("../../../docs/research/2026-11-11-map-model-example-controls.json");
const ROLE_CANDIDATE: &str =
    include_str!("../../../docs/research/2026-11-11-map-model-role-controls.json");
const EXISTING_CLUSTER: &str =
    include_str!("../../../docs/research/2026-11-11-map-existing-cluster-control.json");

fn existing_cluster_comparison(candidate: &str, candidate_name: &str) -> Vec<Value> {
    let supplemental: Value = serde_json::from_str(EXISTING_CLUSTER).unwrap();
    [ROLE_CANDIDATE, candidate]
        .into_iter()
        .zip(["existing-cluster-baseline", candidate_name])
        .map(|(source, arm)| {
            check_frozen_controls(source);
            check_comparison_controls(source);
            let mut controls: Value = serde_json::from_str(source).unwrap();
            controls["separateRoles"] = json!(true);
            controls["candidate"] = json!(arm);
            let prompt = format!(
                "{}\n\n{}",
                controls["system"].as_str().unwrap(),
                supplemental["user"].as_str().unwrap()
            );
            controls["cases"].as_array_mut().unwrap().push(json!({
                "id": supplemental["id"], "cluster": "Synthetic pipeline",
                "documents": supplemental["documents"], "user": supplemental["user"],
                "requiredClaims": supplemental["requiredClaims"],
                "forbiddenClaims": supplemental["forbiddenClaims"],
                "localPromptSha256": source_revision(&prompt), "localPrompt": prompt,
            }));
            check_frozen_controls(&controls.to_string());
            controls
        })
        .collect()
}

#[test]
fn existing_cluster_comparison_preserves_frozen_sources_and_labels() {
    for (candidate, name) in [
        (FACT_CANDIDATE, "existing-cluster-fact-boundary"),
        (EXAMPLE_CANDIDATE, "existing-cluster-example-native-roles"),
    ] {
        let groups = existing_cluster_comparison(candidate, name);
        let frozen: Value = serde_json::from_str(candidate).unwrap();
        assert_eq!(groups[1]["system"], frozen["system"]);
        check_existing_cluster_comparison(&groups);
    }
}

fn check_existing_cluster_comparison(groups: &[Value]) {
    assert_eq!(groups[0]["separateRoles"], true);
    let supplemental: Value = serde_json::from_str(EXISTING_CLUSTER).unwrap();
    assert_eq!(
        source_revision(&format!(
            "{}\n\n{}",
            supplemental["system"].as_str().unwrap(),
            supplemental["user"].as_str().unwrap()
        )),
        supplemental["promptSha256"]
    );
    assert_eq!(groups[0]["cases"].as_array().unwrap().len(), 3);
    for field in [
        "modelId",
        "outputTokens",
        "contextTokens",
        "repeats",
        "acceptance",
        "separateRoles",
    ] {
        assert_eq!(groups[0][field], groups[1][field], "{field}");
    }
    for (baseline, candidate) in groups[0]["cases"]
        .as_array()
        .unwrap()
        .iter()
        .zip(groups[1]["cases"].as_array().unwrap())
    {
        for field in [
            "id",
            "cluster",
            "documents",
            "requiredClaims",
            "forbiddenClaims",
            "user",
        ] {
            assert_eq!(baseline[field], candidate[field], "{field}");
        }
    }
    let packet: Value = serde_json::from_str(
        supplemental["user"]
            .as_str()
            .unwrap()
            .lines()
            .nth(1)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(packet["cluster"], "Synthetic pipeline");
    assert_eq!(packet["partialMemberCoverage"], false);
    assert_eq!(packet["members"].as_array().unwrap().len(), 2);
}

#[test]
#[ignore = "requires explicit offline synthetic QA and verified cached local weights"]
fn cached_model_compares_existing_map_prompts() {
    run_existing_cluster_comparison(existing_cluster_comparison(
        FACT_CANDIDATE,
        "existing-cluster-fact-boundary",
    ));
}

#[test]
#[ignore = "requires explicit offline synthetic QA and verified cached local weights"]
fn cached_model_compares_existing_map_example_with_native_roles() {
    run_existing_cluster_comparison(existing_cluster_comparison(
        EXAMPLE_CANDIDATE,
        "existing-cluster-example-native-roles",
    ));
}

fn run_existing_cluster_comparison(groups: Vec<Value>) {
    assert_eq!(std::env::var("MYCO_QA_GENERATION").as_deref(), Ok("1"));
    check_existing_cluster_comparison(&groups);
    let manifest = crate::local_model::manifest_for(groups[0]["modelId"].as_str()).unwrap();
    let directory = std::env::var_os("MYCO_SESSION_PACKET_MODEL_DIR")
        .expect("explicit cached artifact directory");
    let artifact =
        crate::local_model::resolve_verified_artifact(Path::new(&directory), manifest).unwrap();
    println!(
        "{}",
        json!({"phase":"map_model_verified", "model":manifest,
        "supplementSha256":source_revision(EXISTING_CLUSTER), "semanticAccepted":false})
    );
    let mut host = LocalLlm::load_embed_host().unwrap();
    host.ensure_chat_model(&artifact).unwrap();
    for controls in groups {
        println!(
            "{}",
            json!({"phase":"map_model_arm", "candidate":controls["candidate"],
            "controlsSha256":source_revision(&controls.to_string()), "controls":controls})
        );
        replay_map_controls(&mut host, &controls);
    }
}

#[test]
fn frozen_map_prompts_have_exact_original_and_prompt_revisions() {
    for source in [
        CONTROLS,
        CANDIDATE,
        FACT_CANDIDATE,
        EXAMPLE_CANDIDATE,
        ROLE_CANDIDATE,
    ] {
        check_frozen_controls(source);
    }
}

#[test]
fn map_candidate_preserves_sources_and_acceptance_controls() {
    for source in [CANDIDATE, FACT_CANDIDATE, EXAMPLE_CANDIDATE, ROLE_CANDIDATE] {
        check_comparison_controls(source);
    }
}

#[test]
fn role_candidate_changes_only_message_transport() {
    let baseline: Value = serde_json::from_str(CONTROLS).unwrap();
    let mut candidate: Value = serde_json::from_str(ROLE_CANDIDATE).unwrap();
    let fields = candidate.as_object_mut().unwrap();
    assert_eq!(fields.remove("separateRoles"), Some(json!(true)));
    assert_eq!(fields.remove("candidate"), Some(json!("native-roles-v1")));
    assert_eq!(candidate, baseline);
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
        Ok("example-boundary-v3") => EXAMPLE_CANDIDATE,
        Ok("native-roles-v1") => ROLE_CANDIDATE,
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
    replay_map_controls(&mut host, &controls);
}

fn replay_map_controls(host: &mut LocalLlm, controls: &Value) {
    for repetition in 1..=controls["repeats"].as_u64().unwrap() {
        for case in controls["cases"].as_array().unwrap() {
            let (system, user) = if controls["separateRoles"] == true {
                (
                    controls["system"].as_str().unwrap(),
                    case["user"].as_str().unwrap(),
                )
            } else {
                ("", case["localPrompt"].as_str().unwrap())
            };
            let tokens = host.chat_token_count(system, user).unwrap();
            let budget = controls["outputTokens"].as_i64().unwrap() as i32;
            assert!(tokens + budget as usize + 8 <= 4096);
            println!(
                "{}",
                json!({"phase":"map_model_input", "case":case["id"], "repetition":repetition,
                "candidate":controls["candidate"],
                "system":system, "user":user, "promptTokens":tokens, "outputTokens":budget, "contextTokens":4096})
            );
            let started = std::time::Instant::now();
            let result =
                host.generate_text_cancellable(system, user, budget, &AtomicBool::new(false));
            println!(
                "{}",
                json!({"phase":"map_model_output", "case":case["id"], "repetition":repetition,
                "candidate":controls["candidate"],
                "result":result, "seconds":started.elapsed().as_secs_f64(), "semanticAccepted":false})
            );
            assert!(result.is_ok(), "local map generation failed: {result:?}");
        }
    }
}
