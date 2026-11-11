//! Repeat the frozen candidate and distinguish constructed from generated drafts.
use super::*;

#[test]
fn repeated_candidate_matches_the_previous_actual_positive_review_input() {
    let receipt: Value = serde_json::from_str(include_str!(
        "../../../docs/research/2026-11-11-selected-note-coverage-review.json"
    ))
    .unwrap();
    let previous = receipt["records"]
        .as_array()
        .unwrap()
        .iter()
        .find(|record| {
            record["phase"] == "selected_note_input"
                && record["case"] == "supported_pair"
                && record["arm"] == "grouped-coverage-guidance"
        })
        .unwrap();
    let controls: Value = serde_json::from_str(COVERAGE_CONTROLS).unwrap();
    let (request, evidence, sources) = selected_note_fixture();
    let mut reviews = 0;
    let _ = run(
        &request,
        &evidence,
        &sources,
        request.origin.as_ref().unwrap(),
        |_, _| Ok(100),
        |system, user, _, _, schema| match schema {
            GenerationSchema::AskAnswerV1 => {
                Ok(json!({"answer":controls["cases"][0]["answer"],"sources":["S1"]}).to_string())
            }
            GenerationSchema::AskAnswerReviewV1 => {
                let (system, user) = grouped_coverage_input(true, system, user)?;
                assert_eq!(system, previous["system"]);
                assert_eq!(user, previous["user"]);
                reviews += 1;
                Err("deliberate model-free stop after checking the exact input".into())
            }
            _ => panic!("unexpected schema"),
        },
    );
    assert_eq!(reviews, 1);
}

#[test]
#[ignore = "requires cached 4B weights and MYCO_QA_GENERATION=1; up to 27 actual calls"]
fn cached_model_repeats_coverage_candidate() {
    assert_eq!(std::env::var("MYCO_QA_GENERATION").as_deref(), Ok("1"));
    let manifest = crate::local_model::manifest_for(Some("qwen3.5-4b-q4_k_m")).unwrap();
    let directory =
        std::env::var_os("MYCO_SESSION_PACKET_MODEL_DIR").expect("explicit artifact directory");
    let artifact =
        crate::local_model::resolve_verified_artifact(std::path::Path::new(&directory), manifest)
            .unwrap();
    let mut host = LocalLlm::load_embed_host().unwrap();
    host.ensure_chat_model(&artifact).unwrap();
    let controls: Value = serde_json::from_str(COVERAGE_CONTROLS).unwrap();
    println!(
        "{}",
        json!({"phase":"selected_note_preflight","reviewControlsSha256":source_revision(COVERAGE_CONTROLS),
        "sourceControlsSha256":source_revision(CONTROLS),"guidanceSha256":source_revision(COVERAGE_GUIDANCE),"model":manifest,
        "repetitions":3,"constructedCasesPerRepetition":5,"freshDraftCasesPerRepetition":2,
        "freshGold":{"supported_pair":"Names East and West as the two linked notes, citing Center.",
            "omitted_withdrawal":"Explains that the links were withdrawn and the earlier two-link description is obsolete, citing Center; does not present them as current links."},
        "semanticAccepted":false,"nativeAuthorityAccepted":false})
    );
    let cancelled = AtomicBool::new(false);
    let mut calls = 0;
    let mut generation_failures = 0;
    for repetition in 1..=3 {
        for mode in ["constructed", "fresh"] {
            for case in controls["cases"].as_array().unwrap() {
                if mode == "fresh"
                    && case["id"] != "supported_pair"
                    && case["id"] != "omitted_withdrawal"
                {
                    continue;
                }
                let (request, evidence, sources) =
                    selected_note_fixture_with_tail(case["appendToCenter"].as_str());
                let result = run(
                    &request,
                    &evidence,
                    &sources,
                    request.origin.as_ref().unwrap(),
                    |system, user| {
                        let (system, user) = if system.starts_with("Review the complete answer") {
                            grouped_coverage_input(true, system, user)?
                        } else {
                            (system.to_owned(), user.to_owned())
                        };
                        host.chat_token_count(&system, &user)
                    },
                    |system, user, output_tokens, context_tokens, schema| {
                        let (stage, system, user) = match schema {
                            GenerationSchema::AskAnswerV1 if mode == "constructed" => {
                                return Ok(
                                    json!({"answer":case["answer"],"sources":["S1"]}).to_string()
                                )
                            }
                            GenerationSchema::AskAnswerV1 => {
                                ("draft", system.to_owned(), user.to_owned())
                            }
                            GenerationSchema::AskAnswerReviewV1 => {
                                let (system, user) = grouped_coverage_input(true, system, user)?;
                                ("review", system, user)
                            }
                            _ => panic!("unexpected schema"),
                        };
                        calls += 1;
                        println!(
                            "{}",
                            json!({"phase":"selected_note_input","call":calls,"repetition":repetition,
                            "mode":mode,"case":case["id"],"stage":stage,"system":system,"user":user,
                            "outputTokens":output_tokens,"contextTokens":context_tokens})
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
                            json!({"phase":"selected_note_output","call":calls,"repetition":repetition,
                            "mode":mode,"case":case["id"],"stage":stage,"result":output,"telemetry":telemetry})
                        );
                        output
                    },
                );
                println!(
                    "{}",
                    json!({"phase":"selected_note_result","repetition":repetition,"mode":mode,"case":case["id"],
                    "expectedAccepted":if mode=="constructed" {case["expectedAccepted"].clone()} else {json!(true)},
                    "accepted":result.is_ok(),"result":format!("{result:?}"),"semanticAccepted":false})
                );
            }
        }
    }
    drop(host);
    assert_eq!(
        calls, 27,
        "retain failures when fresh drafts do not reach review"
    );
    assert_eq!(generation_failures, 0);
}
