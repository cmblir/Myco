//! Canonical compilation contract controls using synthetic generation hooks.
//! These checks do not establish actual-model meaning or release acceptance.

use super::*;

const W03_11_REQUEST: &str = "---\nsource: codex\nconversation_id: synthetic-session\n---\n**User:**\nPlease request the synthetic report.\n";

fn w03_11_structure_reply(user: &str) -> String {
    let input: Value = serde_json::from_str(user).unwrap();
    let claims = input["claims"].as_array().unwrap();
    let proposal = json!({
        "version":"SessionStructureV1",
        "title":if claims.is_empty(){""}else{"Synthetic report"},
        "titleClaimIds":claims.iter().take(1)
            .map(|claim| claim["id"].clone()).collect::<Vec<_>>(),
        "entities":[]
    });
    // Exact raw checkpoint bytes must survive harmless JSON whitespace.
    format!(" \n{proposal}\n ")
}

fn legacy_freeform_reply(user: &str, summary: &str) -> String {
    let input: Value = serde_json::from_str(user).unwrap();
    json!({
        "version":"SessionCompilationV1", "title":"Synthetic report",
        "titleClaimIds":[input["claims"][0]["id"]], "entities":[],
        "summaries":[{"claimId":input["claims"][0]["id"],"text":summary}]
    })
    .to_string()
}

#[test]
fn current_compiler_accepts_closed_structure_and_reviews_canonical_rows() {
    let plan = plan(W03_11_REQUEST);
    assert_eq!(plan.windows.len(), 1);
    let original =
        CompilationOriginal::verify(W03_11_REQUEST, &plan.source.source_revision).unwrap();
    let mut run = CompilerRun::new("attempt-a", "signature-a");
    let mut progress = run.initial_progress(&plan);
    let mut calls = Vec::new();
    let mut raw_structure = None;
    let mut reviewed_view = None;
    run.step(
        &plan,
        &original,
        &origin("process-a:1"),
        "en",
        &mut progress,
        |_, _| Ok(800),
        |_, user, _, _, schema| {
            calls.push(schema);
            if schema == CompilerSchema::Compilation {
                let raw = w03_11_structure_reply(user);
                raw_structure = Some(raw.clone());
                Ok(raw)
            } else {
                if schema == CompilerSchema::Review {
                    let input: Value = serde_json::from_str(user).unwrap();
                    assert_eq!(
                        input["compilation"]["version"],
                        "CanonicalSessionMaterializationV1"
                    );
                    assert_eq!(
                        input["compilation"]["summaries"].as_array().unwrap().len(),
                        input["claims"].as_array().unwrap().len()
                    );
                    assert_eq!(
                        input["claims"][0]["proposal"]["action"],
                        "Please request the synthetic report."
                    );
                    reviewed_view = Some(input["compilation"].clone());
                }
                model(schema, user, false)
            }
        },
    )
    .unwrap();
    assert_eq!(
        calls,
        vec![
            CompilerSchema::Claims,
            CompilerSchema::Compilation,
            CompilerSchema::Review
        ]
    );
    assert_eq!(
        progress.batches[0].compilation_output,
        raw_structure.unwrap()
    );
    let completed = run.completed(&plan, &progress).unwrap().unwrap();
    assert_eq!(
        serde_json::to_value(&completed).unwrap()["packets"][0]["compilation"],
        reviewed_view.unwrap()
    );
    assert!(!completed.release_ground_truth);
    assert_eq!(completed.independent_verification_receipts, 0);
}

#[test]
fn stored_closed_structure_is_rematerialized_before_fresh_review() {
    let plan = plan(W03_11_REQUEST);
    assert_eq!(plan.windows.len(), 1);
    let original =
        CompilationOriginal::verify(W03_11_REQUEST, &plan.source.source_revision).unwrap();
    let mut first = CompilerRun::new("attempt-a", "signature-a");
    let mut progress = first.initial_progress(&plan);
    first
        .step(
            &plan,
            &original,
            &origin("process-a:1"),
            "en",
            &mut progress,
            |_, _| Ok(800),
            |_, user, _, _, schema| model(schema, user, false),
        )
        .unwrap();
    let old: Value = serde_json::from_str(&progress.batches[0].compilation_output).unwrap();
    progress.batches[0].compilation_output = json!({
        "version":"SessionStructureV1", "title":old["title"],
        "titleClaimIds":old["titleClaimIds"], "entities":old["entities"]
    })
    .to_string();
    progress.batches[0].review_output = Some("{\"passed\":true}".into());
    let raw_before = progress.batches[0].compilation_output.clone();
    let mut fresh = CompilerRun::new("attempt-b", "signature-a");
    assert!(fresh.completed(&plan, &progress).unwrap().is_none());
    let mut calls = Vec::new();
    fresh
        .step(
            &plan,
            &original,
            &origin("process-b:1"),
            "en",
            &mut progress,
            |_, _| Ok(800),
            |_, user, _, _, schema| {
                calls.push(schema);
                assert_eq!(schema, CompilerSchema::Review);
                let input: Value = serde_json::from_str(user).unwrap();
                assert_eq!(
                    input["compilation"]["version"],
                    "CanonicalSessionMaterializationV1"
                );
                model(schema, user, false)
            },
        )
        .unwrap();
    assert_eq!(calls, vec![CompilerSchema::Review]);
    assert_eq!(progress.batches[0].compilation_output, raw_before);
    assert_eq!(
        fresh
            .completed(&plan, &progress)
            .unwrap()
            .unwrap()
            .attempt_id(),
        "attempt-b"
    );
}

#[test]
fn compilation_never_flattens_the_bound_nested_request_action() {
    // This mock reproduces the observed second-rewrite failure. It is not an
    // actual-model meaning gate; the exact action assertion never changes.
    const ACTION: &str = "request the synthetic report";
    const FLAT_SUMMARY: &str = "The user requested the synthetic report.";
    let plan = plan(W03_11_REQUEST);
    assert_eq!(plan.windows.len(), 1);
    let original =
        CompilationOriginal::verify(W03_11_REQUEST, &plan.source.source_revision).unwrap();
    let mut run = CompilerRun::new("attempt-a", "signature-a");
    let mut progress = run.initial_progress(&plan);
    let mut calls = Vec::new();
    let mut review_input = None;
    run.step(
        &plan,
        &original,
        &origin("process-a:1"),
        "en",
        &mut progress,
        |_, _| Ok(800),
        |system, user, _, _, stage| {
            calls.push(stage);
            match stage {
                CompilerSchema::Claims => {
                    let mut output: Value =
                        serde_json::from_str(&model(stage, user, false)?).unwrap();
                    output["claims"][0]["action"] = json!(ACTION);
                    Ok(output.to_string())
                }
                CompilerSchema::Compilation => {
                    let input: Value = serde_json::from_str(user).unwrap();
                    assert_eq!(input["claims"][0]["proposal"]["action"], ACTION);
                    if system == schema::SYSTEM {
                        Ok(legacy_freeform_reply(user, FLAT_SUMMARY))
                    } else {
                        assert!(system.contains("SessionStructureV1"));
                        Ok(w03_11_structure_reply(user))
                    }
                }
                CompilerSchema::Review => {
                    review_input = Some(serde_json::from_str::<Value>(user).unwrap());
                    model(stage, user, false)
                }
            }
        },
    )
    .unwrap();
    assert_eq!(
        calls,
        vec![
            CompilerSchema::Claims,
            CompilerSchema::Compilation,
            CompilerSchema::Review
        ]
    );
    let reviewed = review_input.unwrap();
    assert_eq!(reviewed["claims"][0]["proposal"]["action"], ACTION);
    let completed = run.completed(&plan, &progress).unwrap().unwrap();
    assert_eq!(
        completed.packets()[0].claims[0]
            .claim
            .proposal
            .action
            .as_bytes(),
        ACTION.as_bytes()
    );
    let row = reviewed["compilation"]["summaries"][0]["text"]
        .as_str()
        .unwrap();
    let expected_action_group = format!("Action: {}", serde_json::to_string(ACTION).unwrap());
    assert_eq!(
        row.split(" · ").next(),
        Some(expected_action_group.as_str())
    );
    assert!(!completed.release_ground_truth);
    assert_eq!(completed.independent_verification_receipts, 0);
}

#[test]
fn fresh_legacy_freeform_output_is_rejected_before_review_without_normalization() {
    let plan = plan(W03_11_REQUEST);
    let original =
        CompilationOriginal::verify(W03_11_REQUEST, &plan.source.source_revision).unwrap();
    let mut run = CompilerRun::new("attempt-a", "signature-a");
    let mut progress = run.initial_progress(&plan);
    let before = serde_json::to_string(&progress).unwrap();
    let mut calls = Vec::new();
    let error = run
        .step(
            &plan,
            &original,
            &origin("process-a:1"),
            "en",
            &mut progress,
            |_, _| Ok(800),
            |_, user, _, _, stage| {
                calls.push(stage);
                match stage {
                    CompilerSchema::Compilation => Ok(legacy_freeform_reply(
                        user,
                        "The user requested the synthetic report.",
                    )),
                    CompilerSchema::Review => panic!("legacy output must not reach review"),
                    CompilerSchema::Claims => model(stage, user, false),
                }
            },
        )
        .unwrap_err();
    assert!(error.contains("invalid SessionStructureV1"), "{error}");
    assert_eq!(
        calls,
        vec![CompilerSchema::Claims, CompilerSchema::Compilation]
    );
    assert_eq!(serde_json::to_string(&progress).unwrap(), before);
    assert!(run.completed(&plan, &progress).unwrap().is_none());
}

#[test]
fn stored_legacy_freeform_output_is_rejected_before_any_new_model_call() {
    let plan = plan(W03_11_REQUEST);
    let original =
        CompilationOriginal::verify(W03_11_REQUEST, &plan.source.source_revision).unwrap();
    let mut first = CompilerRun::new("attempt-a", "signature-a");
    let mut progress = first.initial_progress(&plan);
    let mut legacy_output = None;
    first
        .step(
            &plan,
            &original,
            &origin("process-a:1"),
            "en",
            &mut progress,
            |_, _| Ok(800),
            |_, user, _, _, stage| {
                if stage == CompilerSchema::Compilation {
                    legacy_output = Some(legacy_freeform_reply(
                        user,
                        "The user requested the synthetic report.",
                    ));
                }
                model(stage, user, false)
            },
        )
        .unwrap();
    let legacy_output = legacy_output.unwrap();
    // The old schema still accepts its own bounded wire contract. Resume must
    // reject those bytes, rather than stripping summaries into the new DTO.
    let legacy_claims = &first.packets.get(&0).unwrap().claims;
    assert!(schema::validate(&legacy_output, legacy_claims).is_ok());
    progress.batches[0].compilation_output = legacy_output;
    let before = serde_json::to_string(&progress).unwrap();
    let mut fresh = CompilerRun::new("attempt-b", "signature-a");
    let error = fresh
        .step(
            &plan,
            &original,
            &origin("process-b:1"),
            "en",
            &mut progress,
            |_, _| panic!("stored legacy output must fail before tokenization"),
            |_, _, _, _, _| panic!("stored legacy output must fail before generation"),
        )
        .unwrap_err();
    assert!(error.contains("invalid SessionStructureV1"), "{error}");
    assert_eq!(serde_json::to_string(&progress).unwrap(), before);
    assert!(fresh.completed(&plan, &progress).unwrap().is_none());
}

#[test]
fn stored_structure_is_rebound_to_current_native_claim_bytes_before_review() {
    let plan = plan(W03_11_REQUEST);
    let original =
        CompilationOriginal::verify(W03_11_REQUEST, &plan.source.source_revision).unwrap();
    let mut first = CompilerRun::new("attempt-a", "signature-a");
    let mut progress = first.initial_progress(&plan);
    first
        .step(
            &plan,
            &original,
            &origin("process-a:1"),
            "en",
            &mut progress,
            |_, _| Ok(800),
            |_, user, _, _, stage| model(stage, user, false),
        )
        .unwrap();
    let raw_structure = progress.batches[0].compilation_output.clone();
    let mut extraction: Value =
        serde_json::from_str(&progress.batches[0].extraction_output).unwrap();
    extraction["claims"][0]["action"] = json!("A changed synthetic request.");
    progress.batches[0].extraction_output = extraction.to_string();
    let before = serde_json::to_string(&progress).unwrap();
    let mut fresh = CompilerRun::new("attempt-b", "signature-a");
    let error = fresh
        .step(
            &plan,
            &original,
            &origin("process-b:1"),
            "en",
            &mut progress,
            |_, _| panic!("stale structure must fail before tokenization"),
            |_, _, _, _, _| panic!("stale structure must fail before review"),
        )
        .unwrap_err();
    assert!(error.contains("identity, title or coverage"), "{error}");
    assert_eq!(progress.batches[0].compilation_output, raw_structure);
    assert_eq!(serde_json::to_string(&progress).unwrap(), before);
    assert!(fresh.completed(&plan, &progress).unwrap().is_none());
}

#[test]
fn wrapper_view_review_binding_and_completed_serialization_use_identical_bytes() {
    let plan = plan(W03_11_REQUEST);
    let original =
        CompilationOriginal::verify(W03_11_REQUEST, &plan.source.source_revision).unwrap();
    let mut run = CompilerRun::new("attempt-a", "signature-a");
    let mut progress = run.initial_progress(&plan);
    let mut reviewed_view = None;
    run.step(
        &plan,
        &original,
        &origin("process-a:1"),
        "en",
        &mut progress,
        |_, _| Ok(800),
        |_, user, _, _, stage| {
            if stage == CompilerSchema::Review {
                reviewed_view =
                    Some(serde_json::from_str::<Value>(user).unwrap()["compilation"].clone());
            }
            model(stage, user, false)
        },
    )
    .unwrap();
    let packet = run.packets.get(&0).unwrap();
    let wrapper_bytes = serde_json::to_vec(&packet.compilation).unwrap();
    let view_bytes = serde_json::to_vec(packet.compilation.as_view()).unwrap();
    assert_eq!(wrapper_bytes, view_bytes);
    let view_revision = source_revision(std::str::from_utf8(&view_bytes).unwrap());
    assert!(run.reviews.get(&0).unwrap().binds(
        &plan.source.source_revision,
        "signature-a",
        &plan.packet_revision(0).unwrap(),
        &view_revision
    ));
    assert!(!run.reviews.get(&0).unwrap().binds(
        &plan.source.source_revision,
        "signature-a",
        &plan.packet_revision(0).unwrap(),
        &source_revision(&progress.batches[0].compilation_output)
    ));
    let completed = run.completed(&plan, &progress).unwrap().unwrap();
    assert_eq!(
        serde_json::to_vec(&completed.packets()[0].compilation).unwrap(),
        view_bytes
    );
    assert_eq!(
        serde_json::to_value(&completed).unwrap()["packets"][0]["compilation"],
        reviewed_view.unwrap()
    );
    assert!(!completed.release_ground_truth);
    assert_eq!(completed.independent_verification_receipts, 0);
}
