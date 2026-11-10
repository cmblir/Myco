//! Constructed drafts isolate actual reviewer behavior; no production promotion.
use super::*;

const REVIEW_CONTROLS: &str =
    include_str!("../../../docs/research/2026-11-11-selected-note-review-controls-v2.json");
const GUIDANCE: &str = " Citation IDs, original source IDs and span IDs are different namespaces. Resolve each answer sourceIds entry through citations.id to citations.path, then read originals whose selectionPath equals that path. Do not require citations.id to equal an original sourceId or span id. Source Markdown may explicitly state relations using wikilinks; interpret a link target using the supplied original path and title, without inventing additional relations. Judge the factual prose against those original statements. Inspect all supplied originals for contradictions and judge whether the answer covers every part of the actual question. A partial answer can be factually supported yet inadequate. Empty missingSpanIds alone does not establish coverage or support. Return a complete short reason tied to the supplied evidence; never approve a claim merely because citation metadata matches.";

#[test]
fn reviewer_controls_include_supported_invented_and_incomplete_answers() {
    let controls: Value = serde_json::from_str(REVIEW_CONTROLS).unwrap();
    let cases = controls["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 4);
    assert_eq!(
        cases
            .iter()
            .filter(|case| case["expectedAccepted"] == true)
            .count(),
        1
    );
    assert!(cases.iter().any(|case| case["id"] == "missing_west"));
    assert!(cases
        .iter()
        .all(|case| !case["goldReason"].as_str().unwrap().is_empty()));
    for case in cases {
        let (request, evidence, sources) = selected_note_fixture();
        let mut reviews = 0;
        let result = run(
            &request,
            &evidence,
            &sources,
            request.origin.as_ref().unwrap(),
            |_, _| Ok(100),
            |_, _, _, _, schema| match schema {
                GenerationSchema::AskAnswerV1 => {
                    Ok(json!({"answer":case["answer"],"sources":["S1"]}).to_string())
                }
                GenerationSchema::AskAnswerReviewV1 => {
                    reviews += 1;
                    Ok(
                        json!({"version":"AskAnswerReviewV1","answerDisposition":"unsupported",
                        "taskResponse":"inadequate","sourceCoverage":"covered","missingSpanIds":[],
                        "reason":"Constructed rejection verifies reviewer reachability only."})
                        .to_string(),
                    )
                }
                _ => panic!("unexpected schema"),
            },
        );
        assert_eq!(
            reviews, 1,
            "control never reached review: {} {result:?}",
            case["id"]
        );
    }
}

#[test]
#[ignore = "requires cached 4B weights and MYCO_QA_GENERATION=1; eight actual reviewer calls"]
fn cached_model_compares_citation_namespace_guidance() {
    assert_eq!(std::env::var("MYCO_QA_GENERATION").as_deref(), Ok("1"));
    let manifest = crate::local_model::manifest_for(Some("qwen3.5-4b-q4_k_m")).unwrap();
    let directory =
        std::env::var_os("MYCO_SESSION_PACKET_MODEL_DIR").expect("explicit artifact directory");
    let artifact =
        crate::local_model::resolve_verified_artifact(std::path::Path::new(&directory), manifest)
            .unwrap();
    let mut host = LocalLlm::load_embed_host().unwrap();
    host.ensure_chat_model(&artifact).unwrap();
    let controls: Value = serde_json::from_str(REVIEW_CONTROLS).unwrap();
    println!(
        "{}",
        json!({"phase":"selected_note_preflight","reviewControlsSha256":source_revision(REVIEW_CONTROLS),
        "sourceControlsSha256":source_revision(CONTROLS),"guidance":GUIDANCE,"model":manifest,
        "drafts":"constructed gold controls, not generated","semanticAccepted":false})
    );
    let cancelled = AtomicBool::new(false);
    let mut calls = 0;
    let mut generation_failures = 0;
    for case in controls["cases"].as_array().unwrap() {
        for arm in ["baseline", "citation-namespace-guidance"] {
            let (request, evidence, sources) = selected_note_fixture();
            let result = run(
                &request,
                &evidence,
                &sources,
                request.origin.as_ref().unwrap(),
                |system, user| {
                    let system =
                        if arm != "baseline" && system.starts_with("Review the complete answer") {
                            format!("{system}{GUIDANCE}")
                        } else {
                            system.to_owned()
                        };
                    host.chat_token_count(&system, user)
                },
                |system, user, output_tokens, context_tokens, schema| match schema {
                    GenerationSchema::AskAnswerV1 => {
                        Ok(json!({"answer":case["answer"],"sources":["S1"]}).to_string())
                    }
                    GenerationSchema::AskAnswerReviewV1 => {
                        let system = if arm == "baseline" {
                            system.to_owned()
                        } else {
                            format!("{system}{GUIDANCE}")
                        };
                        calls += 1;
                        println!(
                            "{}",
                            json!({"phase":"selected_note_input","call":calls,"case":case["id"],"arm":arm,
                            "system":system,"user":user,"outputTokens":output_tokens,"contextTokens":context_tokens,"expectedAccepted":case["expectedAccepted"]})
                        );
                        let attempt = host.generate_structured_cancellable_measured(
                            &system,
                            user,
                            output_tokens,
                            context_tokens,
                            schema,
                            &cancelled,
                        );
                        let telemetry = attempt.telemetry().clone();
                        let output = attempt.into_result();
                        generation_failures += usize::from(output.is_err());
                        println!(
                            "{}",
                            json!({"phase":"selected_note_output","call":calls,"case":case["id"],"arm":arm,"result":output,"telemetry":telemetry})
                        );
                        output
                    }
                    _ => panic!("unexpected ordinary review schema"),
                },
            );
            println!(
                "{}",
                json!({"phase":"selected_note_result","case":case["id"],"arm":arm,
                "expectedAccepted":case["expectedAccepted"],"accepted":result.is_ok(),"result":format!("{result:?}"),"semanticAccepted":false})
            );
        }
    }
    drop(host);
    assert_eq!(calls, 8);
    assert_eq!(generation_failures, 0, "retain failed model calls");
}
