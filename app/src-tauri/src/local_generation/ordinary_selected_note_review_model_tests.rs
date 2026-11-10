//! Constructed drafts isolate actual reviewer behavior; no production promotion.
#[cfg(feature = "native-index-probe")]
#[path = "ordinary_selected_note_stability_tests.rs"]
mod stability;

#[cfg(feature = "native-index-probe")]
#[path = "ordinary_selected_note_withdrawal_tests.rs"]
mod withdrawal;

use super::*;

const REVIEW_CONTROLS: &str =
    include_str!("../../../docs/research/2026-11-11-selected-note-review-controls-v2.json");
#[cfg(feature = "native-index-probe")]
const COVERAGE_CONTROLS: &str =
    include_str!("../../../docs/research/2026-11-11-selected-note-coverage-controls.json");
#[cfg(feature = "native-index-probe")]
const COVERAGE_GUIDANCE: &str = " Evaluate sourceCoverage separately from factual support and question adequacy. Read every supplied original span, including later corrections and uncited originals. Coverage is covered only when the answer retains the important question-relevant facts and qualifications; not every unrelated fact needs repetition. Coverage is missing when it omits an important relevant fact, withdrawal, contradiction, failure or qualification. Coverage is uncertain when you cannot establish whether such relevant information is retained. For missingSpanIds use only the id field of an originalSpans turn, never its document sourceId, a citation ID, path or title. Cite the span containing the omitted relevant information. Empty missingSpanIds does not by itself justify covered; a structurally complete packet does not by itself justify covered. Unsupported factual claims still require rejection even when coverage is otherwise complete.";

#[cfg(feature = "native-index-probe")]
#[test]
fn withdrawal_control_reaches_review_with_complete_revised_original() {
    let controls: Value = serde_json::from_str(COVERAGE_CONTROLS).unwrap();
    let original: Value = serde_json::from_str(REVIEW_CONTROLS).unwrap();
    assert_eq!(
        &controls["cases"].as_array().unwrap()[..4],
        original["cases"].as_array().unwrap()
    );
    let case = &controls["cases"][4];
    let tail = case["appendToCenter"].as_str().unwrap();
    let (request, evidence, sources) = selected_note_fixture_with_tail(Some(tail));
    assert!(evidence[0].text.ends_with(tail));
    let mut reviews = 0;
    let result = run(
        &request,
        &evidence,
        &sources,
        request.origin.as_ref().unwrap(),
        |_, _| Ok(100),
        |_, user, _, _, schema| match schema {
            GenerationSchema::AskAnswerV1 => {
                Ok(json!({"answer":case["answer"],"sources":["S1"]}).to_string())
            }
            GenerationSchema::AskAnswerReviewV1 => {
                reviews += 1;
                let payload: Value = serde_json::from_str(user).unwrap();
                assert!(payload["originalSpans"][0]["text"]
                    .as_str()
                    .unwrap()
                    .ends_with(tail));
                Ok(json!({"version":"AskAnswerReviewV1","answerDisposition":"unsupported","taskResponse":"inadequate",
                    "sourceCoverage":"missing","missingSpanIds":["Q-selected-0"],"reason":"Constructed test verdict, not a model judgment."}).to_string())
            }
            _ => panic!("unexpected schema"),
        },
    );
    assert_eq!(reviews, 1);
    assert_eq!(result.unwrap_err().code, "review_rejected");
}

#[cfg(feature = "native-index-probe")]
#[test]
#[ignore = "requires cached 4B weights and MYCO_QA_GENERATION=1; ten actual reviewer calls"]
fn cached_model_compares_grouped_coverage_guidance() {
    run_comparison(
        COVERAGE_CONTROLS,
        "grouped-coverage-guidance",
        grouped_coverage_input,
    );
}

#[cfg(feature = "native-index-probe")]
fn grouped_coverage_input(
    candidate: bool,
    system: &str,
    user: &str,
) -> Result<(String, String), String> {
    let mut system = system.to_owned();
    let mut user = user.to_owned();
    crate::local_synthesis::original_groups_qa::QaWireFormat::SourceDocumentGroupsQaV1
        .apply_review(&mut system, &mut user)?;
    if candidate {
        system.push_str(COVERAGE_GUIDANCE);
    }
    Ok((system, user))
}
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
    run_comparison(
        REVIEW_CONTROLS,
        "citation-namespace-guidance",
        |candidate, system, user| {
            if !candidate {
                return Ok((system.to_owned(), user.to_owned()));
            }
            Ok((format!("{system}{GUIDANCE}"), user.to_owned()))
        },
    );
}

#[cfg(feature = "native-index-probe")]
#[test]
fn grouped_selected_note_review_preserves_every_original_and_context_field() {
    use crate::local_synthesis::original_groups_qa::{decode, QaWireFormat};
    let receipt: Value = serde_json::from_str(include_str!(
        "../../../docs/research/2026-11-11-selected-note-model-replay.json"
    ))
    .unwrap();
    let input = receipt["records"]
        .as_array()
        .unwrap()
        .iter()
        .find(|record| record["phase"] == "selected_note_input" && record["call"] == 2)
        .unwrap();
    let original: Value = serde_json::from_str(input["user"].as_str().unwrap()).unwrap();
    let mut system = input["system"].as_str().unwrap().to_owned();
    let mut user = input["user"].as_str().unwrap().to_owned();
    QaWireFormat::SourceDocumentGroupsQaV1
        .apply_review(&mut system, &mut user)
        .unwrap();
    let mut restored: Value = serde_json::from_str(&user).unwrap();
    assert_eq!(
        restored["originalSpans"]["documents"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    restored["originalSpans"] = decode(&restored["originalSpans"].to_string()).unwrap();
    assert_eq!(restored, original);
}

#[cfg(feature = "native-index-probe")]
#[test]
#[ignore = "requires cached 4B weights and MYCO_QA_GENERATION=1; eight actual reviewer calls"]
fn cached_model_compares_grouped_originals() {
    run_comparison(
        REVIEW_CONTROLS,
        "grouped-originals",
        |candidate, system, user| {
            if !candidate {
                return Ok((system.to_owned(), user.to_owned()));
            }
            let mut system = system.to_owned();
            let mut user = user.to_owned();
            crate::local_synthesis::original_groups_qa::QaWireFormat::SourceDocumentGroupsQaV1
                .apply_review(&mut system, &mut user)?;
            Ok((system, user))
        },
    );
}

fn run_comparison(
    controls_bytes: &str,
    candidate_arm: &str,
    project: impl Fn(bool, &str, &str) -> Result<(String, String), String>,
) {
    assert_eq!(std::env::var("MYCO_QA_GENERATION").as_deref(), Ok("1"));
    let manifest = crate::local_model::manifest_for(Some("qwen3.5-4b-q4_k_m")).unwrap();
    let directory =
        std::env::var_os("MYCO_SESSION_PACKET_MODEL_DIR").expect("explicit artifact directory");
    let artifact =
        crate::local_model::resolve_verified_artifact(std::path::Path::new(&directory), manifest)
            .unwrap();
    let mut host = LocalLlm::load_embed_host().unwrap();
    host.ensure_chat_model(&artifact).unwrap();
    let controls: Value = serde_json::from_str(controls_bytes).unwrap();
    println!(
        "{}",
        json!({"phase":"selected_note_preflight","reviewControlsSha256":source_revision(controls_bytes),
        "sourceControlsSha256":source_revision(CONTROLS),"candidateArm":candidate_arm,"model":manifest,
        "drafts":"constructed gold controls, not generated","semanticAccepted":false})
    );
    let cancelled = AtomicBool::new(false);
    let mut calls = 0;
    let mut generation_failures = 0;
    for case in controls["cases"].as_array().unwrap() {
        for arm in ["baseline", candidate_arm] {
            let (request, evidence, sources) =
                selected_note_fixture_with_tail(case["appendToCenter"].as_str());
            let result = run(
                &request,
                &evidence,
                &sources,
                request.origin.as_ref().unwrap(),
                |system, user| {
                    let (system, user) = if system.starts_with("Review the complete answer") {
                        project(arm != "baseline", system, user)?
                    } else {
                        (system.to_owned(), user.to_owned())
                    };
                    host.chat_token_count(&system, &user)
                },
                |system, user, output_tokens, context_tokens, schema| match schema {
                    GenerationSchema::AskAnswerV1 => {
                        Ok(json!({"answer":case["answer"],"sources":["S1"]}).to_string())
                    }
                    GenerationSchema::AskAnswerReviewV1 => {
                        let (system, user) = project(arm != "baseline", system, user)?;
                        calls += 1;
                        println!(
                            "{}",
                            json!({"phase":"selected_note_input","call":calls,"case":case["id"],"arm":arm,
                            "system":system,"user":user,"outputTokens":output_tokens,"contextTokens":context_tokens,"expectedAccepted":case["expectedAccepted"]})
                        );
                        let attempt = host.generate_structured_cancellable_measured(
                            &system,
                            &user,
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
    assert_eq!(calls, controls["cases"].as_array().unwrap().len() * 2);
    assert_eq!(generation_failures, 0, "retain failed model calls");
}
