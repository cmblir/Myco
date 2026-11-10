//! Explicit model replay of synthetic native-app inputs, not a Wry authority test.
#[path = "ordinary_selected_note_review_model_tests.rs"]
mod reviewer_comparison;

use super::*;
use crate::importers::wikify::source_revision;
use crate::local_llm::LocalLlm;
use std::sync::atomic::AtomicBool;

const CONTROLS: &str =
    include_str!("../../../docs/research/2026-11-11-selected-note-controls.json");

fn selected_note_fixture() -> (Request, Vec<Evidence>, SourceSet) {
    selected_note_fixture_with_tail(None)
}

fn selected_note_fixture_with_tail(tail: Option<&str>) -> (Request, Vec<Evidence>, SourceSet) {
    let controls: Value = serde_json::from_str(CONTROLS).unwrap();
    let (mut request, _, _) = fixture();
    request.question = controls["question"].as_str().unwrap().into();
    request.previous_question = None;
    request.lang = controls["language"].as_str().unwrap().into();
    let mut documents = Vec::new();
    let mut evidence = Vec::new();
    for (index, document) in controls["documents"].as_array().unwrap().iter().enumerate() {
        let original = document["original"].as_str().unwrap();
        assert_eq!(source_revision(original), document["sha256"]);
        let original = if index == 0 {
            format!("{original}{}", tail.unwrap_or_default())
        } else {
            original.to_owned()
        };
        let path = document["path"].as_str().unwrap();
        documents.push(
            SourceDocument::bind(
                format!("S-selected-{index}"),
                path.into(),
                path.into(),
                &original,
                None,
                vec![SpanInput {
                    id: format!("Q-selected-{index}"),
                    start: 0,
                    end: original.len(),
                    turn_id: "T0".into(),
                    speaker: ActorRole::Unknown,
                    turn_time: None,
                }],
            )
            .unwrap(),
        );
        evidence.push(Evidence {
            page: path.into(),
            stem: document["title"].as_str().unwrap().into(),
            title: None,
            section: 0,
            text: original,
            compiled: None,
        });
    }
    request.paths = Some(evidence.iter().map(|hit| hit.page.clone()).collect());
    request.hits = evidence.clone();
    let sources = SourceSet::new(
        request.origin.clone().unwrap(),
        Scope::Wiki,
        documents,
        vec![],
    )
    .unwrap();
    (request, evidence, sources)
}

#[test]
fn selected_note_controls_keep_originals_and_explicit_paths() {
    let (request, evidence, sources) = selected_note_fixture();
    assert_eq!(request.paths.as_ref().unwrap().len(), 3);
    assert_eq!(sources.spans().count(), 3);
    assert!(evidence[0]
        .text
        .contains("[[synthetic-graph-east]] and [[synthetic-graph-west]]"));
    assert!(request.previous_question.is_none());
}

#[test]
#[ignore = "requires cached 4B weights and explicit MYCO_QA_GENERATION=1; actual draft/review calls"]
fn cached_model_captures_selected_note_draft_and_review() {
    assert_eq!(std::env::var("MYCO_QA_GENERATION").as_deref(), Ok("1"));
    let manifest = crate::local_model::manifest_for(Some("qwen3.5-4b-q4_k_m")).unwrap();
    let directory = std::env::var_os("MYCO_SESSION_PACKET_MODEL_DIR")
        .expect("explicit cached artifact directory");
    let artifact =
        crate::local_model::resolve_verified_artifact(std::path::Path::new(&directory), manifest)
            .unwrap();
    let mut host = LocalLlm::load_embed_host().unwrap();
    host.ensure_chat_model(&artifact).unwrap();
    let (request, evidence, sources) = selected_note_fixture();
    println!(
        "{}",
        json!({"phase":"selected_note_preflight","controlsSha256":source_revision(CONTROLS),
        "model":manifest,"authority":"synthetic helper context; no native grant acceptance","semanticAccepted":false})
    );
    let cancelled = AtomicBool::new(false);
    let mut calls = 0;
    let result = run(
        &request,
        &evidence,
        &sources,
        request.origin.as_ref().unwrap(),
        |system, user| host.chat_token_count(system, user),
        |system, user, output_tokens, context_tokens, schema| {
            calls += 1;
            println!(
                "{}",
                json!({"phase":"selected_note_input","call":calls,"system":system,"user":user,
                "outputTokens":output_tokens,"contextTokens":context_tokens})
            );
            let attempt = host.generate_structured_cancellable_measured(
                system,
                user,
                output_tokens,
                context_tokens,
                schema,
                &cancelled,
            );
            let telemetry = attempt.telemetry().clone();
            let output = attempt.into_result();
            println!(
                "{}",
                json!({"phase":"selected_note_output","call":calls,"result":output,"telemetry":telemetry})
            );
            output
        },
    );
    println!(
        "{}",
        json!({"phase":"selected_note_result","result":format!("{result:?}"),"calls":calls,"semanticAccepted":false})
    );
    drop(host);
    assert_eq!(
        calls, 2,
        "retain failed outputs; expected draft and separate review"
    );
}
