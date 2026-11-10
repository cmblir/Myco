//! Fresh draft comparison: preserve corrections without inventing history.
use super::*;

const WRITER_CONTROLS: &str =
    include_str!("../../../docs/research/2026-11-11-selected-note-writer-controls.json");
const CORRECTION_GUIDANCE: &str = " If the supplied original explicitly corrects or withdraws a statement relevant to the question, explain that correction and its effect on the current answer. Identify the earlier description as superseded when the source says so, rather than returning only a bare current-state negation. Cite the source containing the correction. Do not invent a correction, withdrawal, or historical change when the originals do not state one.";

fn writer_input(
    candidate: bool,
    review: bool,
    system: &str,
    user: &str,
) -> Result<(String, String), String> {
    if review {
        return grouped_coverage_input(true, system, user);
    }
    Ok((
        if candidate {
            format!("{system}{CORRECTION_GUIDANCE}")
        } else {
            system.to_owned()
        },
        user.to_owned(),
    ))
}

#[test]
fn writer_candidate_keeps_original_packet_and_reviewer_unchanged() {
    let controls: Value = serde_json::from_str(WRITER_CONTROLS).unwrap();
    for case in controls["cases"].as_array().unwrap() {
        let (request, evidence, sources) =
            selected_note_fixture_with_tail(case["appendToCenter"].as_str());
        let mut stages = 0;
        let _ = run(
            &request,
            &evidence,
            &sources,
            request.origin.as_ref().unwrap(),
            |_, _| Ok(100),
            |system, user, _, _, schema| {
                stages += 1;
                let review = matches!(schema, GenerationSchema::AskAnswerReviewV1);
                let baseline = writer_input(false, review, system, user)?;
                let candidate = writer_input(true, review, system, user)?;
                assert_eq!(baseline.1, candidate.1);
                if review {
                    assert_eq!(baseline, candidate);
                    return Err(
                        "deliberate model-free stop after verifying unchanged review".into(),
                    );
                }
                assert_eq!(candidate.0, format!("{}{CORRECTION_GUIDANCE}", baseline.0));
                let payload: Value = serde_json::from_str(&candidate.1).unwrap();
                assert_eq!(
                    payload["sources"][0]["originalSpans"][0]["text"],
                    evidence[0].text
                );
                Ok(json!({"answer":"Synthetic Graph Center는 Synthetic Graph East와 Synthetic Graph West에 링크됩니다.","sources":["S1"]}).to_string())
            },
        );
        assert_eq!(stages, 2);
    }
}

#[test]
#[ignore = "requires cached 4B weights and MYCO_QA_GENERATION=1; up to eight actual calls"]
fn cached_model_compares_correction_writer() {
    assert_eq!(std::env::var("MYCO_QA_GENERATION").as_deref(), Ok("1"));
    let manifest = crate::local_model::manifest_for(Some("qwen3.5-4b-q4_k_m")).unwrap();
    let directory =
        std::env::var_os("MYCO_SESSION_PACKET_MODEL_DIR").expect("explicit artifact directory");
    let artifact =
        crate::local_model::resolve_verified_artifact(std::path::Path::new(&directory), manifest)
            .unwrap();
    let mut host = LocalLlm::load_embed_host().unwrap();
    host.ensure_chat_model(&artifact).unwrap();
    let controls: Value = serde_json::from_str(WRITER_CONTROLS).unwrap();
    println!(
        "{}",
        json!({"phase":"selected_note_preflight","writerControlsSha256":source_revision(WRITER_CONTROLS),
        "sourceControlsSha256":source_revision(CONTROLS),"guidanceSha256":source_revision(CORRECTION_GUIDANCE),
        "model":manifest,"drafts":"actual fresh generation","semanticAccepted":false,"nativeAuthorityAccepted":false})
    );
    let cancelled = AtomicBool::new(false);
    let mut calls = 0;
    let mut failures = 0;
    for case in controls["cases"].as_array().unwrap() {
        for arm in ["baseline", "preserve-correction"] {
            let (request, evidence, sources) =
                selected_note_fixture_with_tail(case["appendToCenter"].as_str());
            let result = run(
                &request,
                &evidence,
                &sources,
                request.origin.as_ref().unwrap(),
                |system, user| {
                    let (system, user) = writer_input(
                        arm != "baseline",
                        system.starts_with("Review the complete answer"),
                        system,
                        user,
                    )?;
                    host.chat_token_count(&system, &user)
                },
                |system, user, output_tokens, context_tokens, schema| {
                    let review = match schema {
                        GenerationSchema::AskAnswerV1 => false,
                        GenerationSchema::AskAnswerReviewV1 => true,
                        _ => panic!("unexpected schema"),
                    };
                    let stage = if review { "review" } else { "draft" };
                    let (system, user) = writer_input(arm != "baseline", review, system, user)?;
                    calls += 1;
                    println!(
                        "{}",
                        json!({"phase":"selected_note_input","call":calls,"case":case["id"],"arm":arm,"stage":stage,
                        "system":system,"user":user,"outputTokens":output_tokens,"contextTokens":context_tokens})
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
                    failures += usize::from(output.is_err());
                    println!(
                        "{}",
                        json!({"phase":"selected_note_output","call":calls,"case":case["id"],"arm":arm,"stage":stage,"result":output,"telemetry":telemetry})
                    );
                    output
                },
            );
            println!(
                "{}",
                json!({"phase":"selected_note_result","case":case["id"],"arm":arm,"expectedAccepted":case["expectedAccepted"],
                "accepted":result.is_ok(),"result":format!("{result:?}"),"semanticAccepted":false})
            );
        }
    }
    drop(host);
    assert_eq!(calls, 8, "retain failures when drafts do not reach review");
    assert_eq!(failures, 0);
}
