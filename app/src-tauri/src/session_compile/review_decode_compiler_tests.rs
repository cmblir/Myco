//! Synthetic production-path binding controls, not model meaning evidence.
//! The legacy five-argument test shim is deliberately not used here.

use super::*;
use crate::session_compile::review_decode::SessionReviewDecode;

const REQUEST: &str = "---\nsource: codex\nconversation_id: synthetic-session\n---\n**User:**\nPlease request the synthetic report.\n";
const HEADING: &str =
    "---\nsource: codex\nconversation_id: synthetic-session\n---\n# Synthetic session\n";

fn assert_decode(
    schema: CompilerSchema,
    system: &str,
    user: &str,
    decode: Option<&SessionReviewDecode>,
) {
    if schema != CompilerSchema::Review {
        assert!(
            decode.is_none(),
            "non-review stages must not receive a review contract"
        );
        return;
    }
    let decode = decode.expect("production review requires a native-issued contract");
    assert_eq!(decode.system(), review::SYSTEM);
    assert_eq!(decode.system(), system);
    assert_eq!(decode.user(), user);
    assert!(decode.matches_input(system, user));
    assert!(!decode.matches_input(&format!("{system} "), user));
    assert!(!decode.matches_input(system, &format!("{user} ")));
    assert_eq!(decode.grammar_sha256(), source_revision(decode.grammar()));
    assert_ne!(
        decode.grammar_sha256(),
        source_revision(review::SESSION_REVIEW_JSON_GRAMMAR),
        "the production callback must not silently use the legacy generic grammar"
    );
    let input: Value = serde_json::from_str(user).unwrap();
    for id in input["requiredClaimIds"]
        .as_array()
        .unwrap()
        .iter()
        .chain(input["requiredExpressionIds"].as_array().unwrap())
        .chain(
            input["originalSpans"]
                .as_array()
                .unwrap()
                .iter()
                .map(|span| &span["id"]),
        )
    {
        let terminal = serde_json::to_string(&serde_json::to_string(id).unwrap()).unwrap();
        assert!(
            decode.grammar().contains(&terminal),
            "missing native literal {id}"
        );
    }
    assert_eq!(input["independentVerificationReceipts"], json!([]));
    assert_eq!(
        input["compilation"]["version"],
        json!(materializer::MATERIALIZED_VERSION)
    );
}

fn saved_request() -> (PacketPlan, CompilerProgress, String, String) {
    let plan = plan(REQUEST);
    assert_eq!(plan.windows.len(), 1);
    let original = CompilationOriginal::verify(REQUEST, &plan.source.source_revision).unwrap();
    let mut first = CompilerRun::new("attempt-a", "signature-a");
    let mut progress = first.initial_progress(&plan);
    let mut user_input = String::new();
    let mut grammar_sha = String::new();
    first
        .step_with_decode(
            &plan,
            &original,
            &origin("process-a:1"),
            "en",
            &mut progress,
            |_, _| Ok(800),
            |system, user, _, _, schema, decode| {
                assert_decode(schema, system, user, decode);
                if let Some(decode) = decode {
                    user_input = decode.user().into();
                    grammar_sha = decode.grammar_sha256();
                }
                model(schema, user, false)
            },
        )
        .unwrap();
    assert!(first.completed(&plan, &progress).unwrap().is_some());
    (plan, progress, user_input, grammar_sha)
}

#[test]
fn production_compiler_passes_exact_contract_only_to_review() {
    let plan = plan(REQUEST);
    let original = CompilationOriginal::verify(REQUEST, &plan.source.source_revision).unwrap();
    let mut run = CompilerRun::new("attempt-a", "signature-a");
    let mut progress = run.initial_progress(&plan);
    let mut calls = Vec::new();
    let receipt = run
        .step_with_decode(
            &plan,
            &original,
            &origin("process-a:1"),
            "en",
            &mut progress,
            |_, _| Ok(800),
            |system, user, output, context, schema, decode| {
                assert_eq!((output, context), (OUTPUT_TOKENS, CONTEXT_TOKENS));
                assert_decode(schema, system, user, decode);
                calls.push(schema);
                if schema == CompilerSchema::Review {
                    let input: Value = serde_json::from_str(user).unwrap();
                    assert_eq!(input["requiredClaimIds"].as_array().unwrap().len(), 1);
                    assert_eq!(input["requiredExpressionIds"].as_array().unwrap().len(), 2);
                    assert_eq!(
                        input["originalSpans"][0]["text"],
                        json!("Please request the synthetic report.\n")
                    );
                    assert_eq!(input["originalSpans"][0]["speaker"], json!("user"));
                }
                model(schema, user, false)
            },
        )
        .unwrap();
    assert_eq!(
        calls,
        [
            CompilerSchema::Claims,
            CompilerSchema::Compilation,
            CompilerSchema::Review
        ]
    );
    assert!(receipt.review_accepted);
    assert!(receipt.all_packets_seen);
    let artifact = run.completed(&plan, &progress).unwrap().unwrap();
    assert!(!artifact.release_ground_truth);
    assert_eq!(artifact.independent_verification_receipts, 0);
}

#[test]
fn empty_packet_review_gets_empty_native_groups_without_structure_decode() {
    let plan = plan(HEADING);
    assert_eq!(plan.windows.len(), 1);
    let original = CompilationOriginal::verify(HEADING, &plan.source.source_revision).unwrap();
    let mut run = CompilerRun::new("attempt-a", "signature-a");
    let mut progress = run.initial_progress(&plan);
    let mut calls = Vec::new();
    let receipt = run
        .step_with_decode(
            &plan,
            &original,
            &origin("process-a:1"),
            "en",
            &mut progress,
            |_, _| Ok(800),
            |system, user, _, _, schema, decode| {
                assert_decode(schema, system, user, decode);
                calls.push(schema);
                if schema == CompilerSchema::Review {
                    let input: Value = serde_json::from_str(user).unwrap();
                    assert_eq!(input["claims"], json!([]));
                    assert_eq!(input["requiredClaimIds"], json!([]));
                    assert_eq!(input["requiredExpressionIds"], json!([]));
                    assert_eq!(
                        input["originalSpans"][0]["text"],
                        json!("# Synthetic session\n")
                    );
                }
                model(schema, user, false)
            },
        )
        .unwrap();
    assert_eq!(calls, [CompilerSchema::Claims, CompilerSchema::Review]);
    assert!(receipt.review_accepted);
    assert_eq!(
        progress.batches[0].compilation_output,
        structure::empty_output().unwrap()
    );
}

#[test]
fn fresh_run_reissues_review_contract_and_cannot_reuse_stored_acceptance() {
    let (plan, progress, old_user, old_grammar_sha) = saved_request();
    let mut resumed: CompilerProgress =
        serde_json::from_slice(&serde_json::to_vec(&progress).unwrap()).unwrap();
    resumed.batches[0].review_output = Some("{\"invented_saved_acceptance\":true}".into());
    let old_claims = resumed.batches[0].extraction_output.clone();
    let old_structure = resumed.batches[0].compilation_output.clone();
    let original = CompilationOriginal::verify(REQUEST, &plan.source.source_revision).unwrap();
    let mut fresh = CompilerRun::new("attempt-b", "signature-a");
    assert!(fresh.completed(&plan, &resumed).unwrap().is_none());
    let mut review_calls = 0;
    let receipt = fresh
        .step_with_decode(
            &plan,
            &original,
            &origin("process-b:1"),
            "en",
            &mut resumed,
            |_, _| Ok(800),
            |system, user, _, _, schema, decode| {
                assert_eq!(schema, CompilerSchema::Review);
                assert_decode(schema, system, user, decode);
                let decode = decode.unwrap();
                assert_eq!(decode.user(), old_user);
                assert_eq!(decode.grammar_sha256(), old_grammar_sha);
                review_calls += 1;
                // A new valid rejection must replace the old accepted review.
                model(schema, user, true)
            },
        )
        .unwrap();
    assert_eq!(review_calls, 1);
    assert!(!receipt.review_accepted);
    assert!(receipt.all_packets_seen);
    assert_eq!(resumed.next_packet, 1);
    assert_eq!(resumed.batches.len(), 1);
    assert_eq!(resumed.batches[0].extraction_output, old_claims);
    assert_eq!(resumed.batches[0].compilation_output, old_structure);
    assert!(resumed.batches[0]
        .review_output
        .as_ref()
        .unwrap()
        .contains("unsupported"));
    assert!(fresh.completed(&plan, &resumed).unwrap().is_none());
}

#[test]
fn invalid_stored_structure_is_rejected_before_tokenization_or_generation() {
    let (plan, progress, _, _) = saved_request();
    let original = CompilationOriginal::verify(REQUEST, &plan.source.source_revision).unwrap();
    for mutation in ["foreign_id", "legacy_version", "extra_summary"] {
        let mut changed = progress.clone();
        let mut structure: Value =
            serde_json::from_str(&changed.batches[0].compilation_output).unwrap();
        match mutation {
            "foreign_id" => structure["titleClaimIds"] = json!(["C-foreign"]),
            "legacy_version" => structure["version"] = json!("SessionCompilationV1"),
            _ => structure["summaries"] = json!([]),
        }
        changed.batches[0].compilation_output = structure.to_string();
        let before = serde_json::to_vec(&changed).unwrap();
        let mut fresh = CompilerRun::new("attempt-b", "signature-a");
        let error = fresh
            .step_with_decode(
                &plan,
                &original,
                &origin("process-b:1"),
                "en",
                &mut changed,
                |_, _| panic!("invalid stored structure must fail before tokenization"),
                |_, _, _, _, _, _| panic!("invalid stored structure must fail before generation"),
            )
            .unwrap_err();
        assert!(
            error.contains("structure") || error.contains("SessionStructureV1"),
            "{error}"
        );
        assert_eq!(serde_json::to_vec(&changed).unwrap(), before);
        assert!(fresh
            .unavailable_checkpoint(&plan, &changed)
            .unwrap()
            .is_none());
        assert!(fresh.completed(&plan, &changed).unwrap().is_none());
    }
}

#[test]
fn wrong_original_or_progress_source_fails_before_contract_or_model_callbacks() {
    let (plan, progress, _, _) = saved_request();
    let revised = REQUEST.replace("synthetic report", "revised synthetic report");
    let old_original = CompilationOriginal::verify(REQUEST, &plan.source.source_revision).unwrap();
    let revised_original =
        CompilationOriginal::verify(&revised, &source_revision(&revised)).unwrap();
    for wrong_original in [false, true] {
        let mut changed = progress.clone();
        if !wrong_original {
            changed.source_revision = "b".repeat(64);
        }
        let before = serde_json::to_vec(&changed).unwrap();
        let mut fresh = CompilerRun::new("attempt-b", "signature-a");
        assert!(fresh
            .step_with_decode(
                &plan,
                if wrong_original {
                    &revised_original
                } else {
                    &old_original
                },
                &origin("process-b:1"),
                "en",
                &mut changed,
                |_, _| panic!("source mismatch must fail before tokenization"),
                |_, _, _, _, _, _| panic!("source mismatch must fail before generation"),
            )
            .is_err());
        assert_eq!(serde_json::to_vec(&changed).unwrap(), before);
    }
}

#[test]
fn invalid_returned_review_remains_invalid_and_never_becomes_an_unreviewed_draft() {
    let plan = plan(HEADING);
    let original = CompilationOriginal::verify(HEADING, &plan.source.source_revision).unwrap();
    let mut run = CompilerRun::new("attempt-a", "signature-a");
    let mut progress = run.initial_progress(&plan);
    let before = serde_json::to_vec(&progress).unwrap();
    let error = run
        .step_with_decode(
            &plan,
            &original,
            &origin("process-a:1"),
            "en",
            &mut progress,
            |_, _| Ok(800),
            |system, user, _, _, schema, decode| {
                assert_decode(schema, system, user, decode);
                if schema == CompilerSchema::Review {
                    let input: Value = serde_json::from_str(user).unwrap();
                    assert_eq!(input["requiredClaimIds"], json!([]));
                    // Mocks can bypass vocabulary masking; the native validator
                    // must still reject an original span used as a claim ID.
                    Ok(json!({"version":"SessionReviewV1","claims":[{
                        "id":input["originalSpans"][0]["id"],"disposition":"unsupported",
                        "reason":"Synthetic invalid decision; not model-quality evidence."
                    }],"expressions":[],"missingSpanIds":[],"sourceCoverage":"covered"})
                    .to_string())
                } else {
                    model(schema, user, false)
                }
            },
        )
        .unwrap_err();
    assert!(error.contains("omitted or invented"), "{error}");
    assert_eq!(serde_json::to_vec(&progress).unwrap(), before);
    assert!(run
        .unavailable_checkpoint(&plan, &progress)
        .unwrap()
        .is_none());
    assert!(run.unavailable_checks(&plan).is_none());
    assert!(run.completed(&plan, &progress).unwrap().is_none());
}

#[test]
fn returned_reason_controls_remain_invalid_without_progress_or_draft_authority() {
    // The first reason is preserved from the v6 Gemma call-8 raw output.
    // These callbacks deliberately bypass grammar; they are native guards,
    // not an actual-model replay or a source-meaning acceptance test.
    let retained_lf = "The original text states, \"I plan to draft the synthetic report; no completion is recorded.\"\nAction: \"Draft the synthetic report";
    assert_eq!(retained_lf.chars().count(), 128);
    assert_eq!(retained_lf.chars().nth(92), Some('\n'));
    let (plan, stored, _, _) = saved_request();
    let original = CompilationOriginal::verify(REQUEST, &plan.source.source_revision).unwrap();
    for reason in [
        retained_lf,
        "\0",
        "\u{1f}",
        "\u{7f}",
        "\u{80}",
        "\u{9f}",
        "",
        " ",
    ]
    .into_iter()
    .map(str::to_owned)
    .chain(std::iter::once("가".repeat(129)))
    {
        let mut progress = stored.clone();
        let before = serde_json::to_vec(&progress).unwrap();
        let mut fresh = CompilerRun::new("attempt-b", "signature-a");
        let mut calls = 0;
        let error = fresh
            .step_with_decode(
                &plan,
                &original,
                &origin("process-b:1"),
                "en",
                &mut progress,
                |_, _| Ok(800),
                |system, user, _, _, schema, decode| {
                    assert_eq!(schema, CompilerSchema::Review);
                    assert_decode(schema, system, user, decode);
                    calls += 1;
                    let mut review: Value =
                        serde_json::from_str(&model(schema, user, false)?).unwrap();
                    review["claims"][0]["reason"] = json!(reason);
                    Ok(review.to_string())
                },
            )
            .unwrap_err();
        assert!(error.contains("omitted or invented"), "{error}");
        assert_eq!(calls, 1);
        assert_eq!(serde_json::to_vec(&progress).unwrap(), before);
        assert!(fresh
            .unavailable_checkpoint(&plan, &progress)
            .unwrap()
            .is_none());
        assert!(fresh.unavailable_checks(&plan).is_none());
        assert!(fresh.completed(&plan, &progress).unwrap().is_none());
    }
}

#[test]
fn malformed_reason_surrogates_remain_invalid_without_progress_or_draft_authority() {
    let (plan, stored, _, _) = saved_request();
    let original = CompilationOriginal::verify(REQUEST, &plan.source.source_revision).unwrap();
    for invalid in [r#""\uD800""#, r#""\uDC00""#, r#""\uD800\u0041""#] {
        let mut progress = stored.clone();
        let before = serde_json::to_vec(&progress).unwrap();
        let mut fresh = CompilerRun::new("attempt-b", "signature-a");
        let error = fresh
            .step_with_decode(
                &plan,
                &original,
                &origin("process-b:1"),
                "en",
                &mut progress,
                |_, _| Ok(800),
                |system, user, _, _, schema, decode| {
                    assert_eq!(schema, CompilerSchema::Review);
                    assert_decode(schema, system, user, decode);
                    let mut review: Value =
                        serde_json::from_str(&model(schema, user, false)?).unwrap();
                    review["claims"][0]["reason"] = json!("__invalid_reason__");
                    let raw = review.to_string();
                    assert_eq!(raw.matches(r#""__invalid_reason__""#).count(), 1);
                    // Do not deserialize or normalize the malformed return.
                    Ok(raw.replacen(r#""__invalid_reason__""#, invalid, 1))
                },
            )
            .unwrap_err();
        assert!(error.contains("invalid SessionReviewV1"), "{error}");
        assert_eq!(serde_json::to_vec(&progress).unwrap(), before);
        assert!(fresh
            .unavailable_checkpoint(&plan, &progress)
            .unwrap()
            .is_none());
        assert!(fresh.unavailable_checks(&plan).is_none());
        assert!(fresh.completed(&plan, &progress).unwrap().is_none());
    }
}

#[test]
fn valid_unicode_rejection_replaces_stored_acceptance_without_completion_authority() {
    let (plan, stored, _, _) = saved_request();
    let original = CompilationOriginal::verify(REQUEST, &plan.source.source_revision).unwrap();
    for disposition in ["unsupported", "uncertain"] {
        for reason in [
            "a".repeat(128),
            "가".repeat(128),
            "🧭".repeat(128),
            "합성 \"인용\" \\ 경로/".to_owned(),
        ] {
            assert!(!reason.chars().any(char::is_control));
            assert!(reason.chars().count() <= 128);
            let mut progress = stored.clone();
            let old_claims = progress.batches[0].extraction_output.clone();
            let old_structure = progress.batches[0].compilation_output.clone();
            let mut fresh = CompilerRun::new("attempt-b", "signature-a");
            let mut returned = String::new();
            let receipt = fresh
                .step_with_decode(
                    &plan,
                    &original,
                    &origin("process-b:1"),
                    "en",
                    &mut progress,
                    |_, _| Ok(800),
                    |system, user, _, _, schema, decode| {
                        assert_eq!(schema, CompilerSchema::Review);
                        assert_decode(schema, system, user, decode);
                        let mut review: Value =
                            serde_json::from_str(&model(schema, user, false)?).unwrap();
                        review["claims"][0]["disposition"] = json!(disposition);
                        review["claims"][0]["reason"] = json!(reason);
                        // Covered source does not override an unsupported claim.
                        assert_eq!(review["sourceCoverage"], json!("covered"));
                        returned = review.to_string();
                        Ok(returned.clone())
                    },
                )
                .unwrap();
            assert!(!receipt.review_accepted);
            assert!(receipt.all_packets_seen);
            assert_eq!(progress.next_packet, 1);
            assert_eq!(progress.batches.len(), 1);
            assert_eq!(progress.batches[0].extraction_output, old_claims);
            assert_eq!(progress.batches[0].compilation_output, old_structure);
            assert_eq!(
                progress.batches[0].review_output.as_deref(),
                Some(returned.as_str())
            );
            assert!(progress.unreviewed_batch.is_none());
            assert!(fresh.unavailable_checks(&plan).is_none());
            assert!(fresh.completed(&plan, &progress).unwrap().is_none());
        }
    }
}

#[test]
fn unavailable_review_keeps_raw_tail_without_serializing_decode_authority() {
    let plan = plan(REQUEST);
    let original = CompilationOriginal::verify(REQUEST, &plan.source.source_revision).unwrap();
    let mut run = CompilerRun::new("attempt-a", "signature-a");
    let mut progress = run.initial_progress(&plan);
    let before = serde_json::to_vec(&progress).unwrap();
    let mut raw_claims = String::new();
    let mut raw_structure = String::new();
    let error = run
        .step_with_decode(
            &plan,
            &original,
            &origin("process-a:1"),
            "en",
            &mut progress,
            |_, _| Ok(800),
            |system, user, _, _, schema, decode| {
                assert_decode(schema, system, user, decode);
                match schema {
                    CompilerSchema::Claims => {
                        raw_claims = format!(" \n{}\n ", model(schema, user, false)?);
                        Ok(raw_claims.clone())
                    }
                    CompilerSchema::Compilation => {
                        raw_structure = format!(" \n{}\n ", model(schema, user, false)?);
                        Ok(raw_structure.clone())
                    }
                    CompilerSchema::Review => Err("synthetic unavailable transport".into()),
                }
            },
        )
        .unwrap_err();
    assert_eq!(error, "synthetic unavailable transport");
    assert_eq!(serde_json::to_vec(&progress).unwrap(), before);
    let checkpoint = run
        .unavailable_checkpoint(&plan, &progress)
        .unwrap()
        .unwrap();
    assert_eq!(checkpoint.next_packet, 0);
    assert!(checkpoint.batches.is_empty());
    let tail = checkpoint.unreviewed_batch.as_ref().unwrap();
    assert_eq!(tail.extraction_output, raw_claims);
    assert_eq!(tail.compilation_output, raw_structure);
    assert!(tail.review_output.is_none());
    let persisted = serde_json::to_value(&checkpoint).unwrap();
    assert!(persisted.get("reviewDecode").is_none());
    assert!(persisted["unreviewedBatch"].get("reviewDecode").is_none());
    assert_eq!(
        run.unavailable_checks(&plan).unwrap().semantic_review,
        CheckState::Unavailable
    );
    assert!(run.completed(&plan, &checkpoint).unwrap().is_none());
}
