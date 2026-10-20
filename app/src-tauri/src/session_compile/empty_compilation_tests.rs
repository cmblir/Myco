//! Mocked controls for app-owned empty structure, not model meaning acceptance.

use super::*;

const REQUEST: &str = "---\nsource: codex\nconversation_id: synthetic-session\n---\n**User:**\nPlease request the synthetic report.\n";

fn empty_structure_output() -> Value {
    json!({"version":"SessionStructureV1","title":"","titleClaimIds":[],
        "entities":[]})
}

fn empty_materialized_view() -> Value {
    json!({"version":"CanonicalSessionMaterializationV1","title":"","titleClaimIds":[],
        "entities":[],"summaries":[]})
}

#[test]
fn empty_claims_use_app_structure_and_review_the_entire_original() {
    let plan = plan(REQUEST);
    assert_eq!(plan.windows.len(), 1);
    let original = CompilationOriginal::verify(REQUEST, &plan.source.source_revision).unwrap();
    let packet = plan.packet(0, &original, &origin("process-a:1")).unwrap();
    let expected_spans = serde_json::to_value(packet.spans().collect::<Vec<_>>()).unwrap();
    let mut run = CompilerRun::new("attempt-a", "signature-a");
    let mut progress = run.initial_progress(&plan);
    let mut calls = Vec::new();
    let receipt = run
        .step(
            &plan,
            &original,
            &origin("process-a:1"),
            "en",
            &mut progress,
            |_, _| Ok(800),
            |_, user, _, _, schema| {
                calls.push(schema);
                match schema {
                    CompilerSchema::Claims => {
                        Ok(json!({"outcome":"insufficient_evidence","claims":[]}).to_string())
                    }
                    CompilerSchema::Compilation => {
                        panic!("empty structure must not be model generated")
                    }
                    CompilerSchema::Review => {
                        let input: Value = serde_json::from_str(user).unwrap();
                        assert_eq!(input["originalSpans"], expected_spans);
                        assert_eq!(input["compilation"], empty_materialized_view());
                        assert_eq!(input["claims"], json!([]));
                        assert_eq!(input["requiredClaimIds"], json!([]));
                        assert_eq!(input["requiredExpressionIds"], json!([]));
                        assert!(input.get("completed").is_none());
                        assert_eq!(input["independentVerificationReceipts"], json!([]));
                        model(schema, user, false)
                    }
                }
            },
        )
        .unwrap();
    assert_eq!(calls, vec![CompilerSchema::Claims, CompilerSchema::Review]);
    assert!(receipt.review_accepted);
    assert_eq!(
        serde_json::from_str::<Value>(&progress.batches[0].compilation_output).unwrap(),
        empty_structure_output()
    );
    let completed = run.completed(&plan, &progress).unwrap().unwrap();
    assert_eq!(completed.checks().omitted_units, 0);
    assert!(!completed.release_ground_truth);
}

#[test]
fn omitted_request_still_requires_review_and_cannot_complete() {
    let plan = plan(REQUEST);
    let original = CompilationOriginal::verify(REQUEST, &plan.source.source_revision).unwrap();
    for coverage in ["missing", "uncertain"] {
        let mut run = CompilerRun::new("attempt-a", "signature-a");
        let mut progress = run.initial_progress(&plan);
        let receipt = run.step(
            &plan, &original, &origin("process-a:1"), "en", &mut progress,
            |_, _| Ok(800),
            |_, user, _, _, schema| match schema {
                CompilerSchema::Claims => Ok(json!({"outcome":"insufficient_evidence","claims":[]}).to_string()),
                CompilerSchema::Compilation => panic!("empty structure must not be model generated"),
                CompilerSchema::Review => {
                    let input: Value = serde_json::from_str(user).unwrap();
                    assert!(input["originalSpans"][0]["text"].as_str().unwrap().contains("Please request"));
                    Ok(json!({"version":"SessionReviewV1","claims":[],"expressions":[],
                        "missingSpanIds":[input["originalSpans"][0]["id"]],"sourceCoverage":coverage}).to_string())
                }
            },
        ).unwrap();
        assert!(!receipt.review_accepted);
        assert!(receipt.all_packets_seen);
        assert_eq!(progress.next_packet, 1);
        assert_eq!(progress.batches.len(), 1);
        assert!(run.completed(&plan, &progress).unwrap().is_none());
    }
}

#[test]
fn empty_claims_overflow_or_review_error_preserves_progress() {
    let plan = plan(REQUEST);
    let original = CompilationOriginal::verify(REQUEST, &plan.source.source_revision).unwrap();
    for failure in ["claims-overflow", "review-overflow", "review-error"] {
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
                |_, user| {
                    let input: Value = serde_json::from_str(user).unwrap();
                    let review = input.get("requiredExpressionIds").is_some();
                    Ok(
                        if (failure == "claims-overflow" && !review)
                            || (failure == "review-overflow" && review)
                        {
                            3321
                        } else {
                            800
                        },
                    )
                },
                |_, user, _, _, schema| {
                    calls.push(schema);
                    match schema {
                        CompilerSchema::Claims => {
                            Ok(json!({"outcome":"insufficient_evidence","claims":[]}).to_string())
                        }
                        CompilerSchema::Compilation => {
                            panic!("empty structure must not be model generated")
                        }
                        CompilerSchema::Review => {
                            assert_eq!(failure, "review-error");
                            assert!(
                                serde_json::from_str::<Value>(user).unwrap()["originalSpans"]
                                    .is_array()
                            );
                            Err("synthetic empty review unavailable".into())
                        }
                    }
                },
            )
            .unwrap_err();
        assert!(
            error.contains("cannot fit")
                || error.contains("smaller exact-source packet")
                || error.contains("unavailable"),
            "{error}"
        );
        let expected = match failure {
            "claims-overflow" => vec![],
            "review-overflow" => vec![CompilerSchema::Claims],
            _ => vec![CompilerSchema::Claims, CompilerSchema::Review],
        };
        assert_eq!(calls, expected);
        assert_eq!(serde_json::to_string(&progress).unwrap(), before);
        assert!(run.completed(&plan, &progress).unwrap().is_none());
    }
}

#[test]
fn stored_invalid_empty_structure_is_not_normalized_or_reviewed() {
    let plan = plan(REQUEST);
    let original = CompilationOriginal::verify(REQUEST, &plan.source.source_revision).unwrap();
    let mut run = CompilerRun::new("attempt-a", "signature-a");
    let mut progress = run.initial_progress(&plan);
    run.step(
        &plan,
        &original,
        &origin("process-a:1"),
        "en",
        &mut progress,
        |_, _| Ok(800),
        |_, user, _, _, schema| {
            if schema == CompilerSchema::Claims {
                Ok(json!({"outcome":"insufficient_evidence","claims":[]}).to_string())
            } else {
                model(schema, user, false)
            }
        },
    )
    .unwrap();
    let mut invalid = empty_structure_output();
    invalid["title"] = json!("No Claims Provided");
    progress.batches[0].compilation_output = invalid.to_string();
    let before = serde_json::to_string(&progress).unwrap();
    let mut fresh = CompilerRun::new("attempt-a", "signature-a");
    let error = fresh
        .step(
            &plan,
            &original,
            &origin("process-a:1"),
            "en",
            &mut progress,
            |_, _| panic!("invalid stored structure must fail before tokenization"),
            |_, _, _, _, _| panic!("invalid stored structure must fail before generation"),
        )
        .unwrap_err();
    assert!(error.contains("identity, title or coverage"), "{error}");
    assert_eq!(serde_json::to_string(&progress).unwrap(), before);
    assert!(fresh.completed(&plan, &progress).unwrap().is_none());
}

#[test]
fn nonempty_claims_still_generate_and_validate_compilation() {
    let plan = plan(REQUEST);
    let original = CompilationOriginal::verify(REQUEST, &plan.source.source_revision).unwrap();
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
            |_, user, _, _, schema| {
                calls.push(schema);
                match schema {
                    CompilerSchema::Claims => model(schema, user, false),
                    CompilerSchema::Compilation => Ok(empty_structure_output().to_string()),
                    CompilerSchema::Review => {
                        panic!("invalid nonempty compilation must not reach review")
                    }
                }
            },
        )
        .unwrap_err();
    assert!(error.contains("identity, title or coverage"), "{error}");
    assert_eq!(
        calls,
        vec![CompilerSchema::Claims, CompilerSchema::Compilation]
    );
    assert_eq!(serde_json::to_string(&progress).unwrap(), before);
}
