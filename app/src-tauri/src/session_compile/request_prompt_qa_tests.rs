//! Model-free source/budget and false-positive controls, not actual inference.

use super::*;

fn fake_tokens(system: &str, _: &str) -> Result<usize, String> {
    // The opt-in harness separately requires the real selected-model tokenizer.
    Ok(if system.contains(REQUEST_GUIDANCE) {
        1926
    } else {
        1826
    })
}

#[test]
fn frozen_request_receipt_rebinds_exact_input_and_keeps_observed_omission() {
    let receipt = frozen_receipt(RECEIPT).unwrap();
    let prepared = prepare(&receipt, fake_tokens).unwrap();
    let input = record(&receipt, "native_compiler_generation_input", Some(3)).unwrap();
    assert_eq!(prepared.user, input["user"]);
    assert_eq!(source_revision(&prepared.user), input["userSha256"]);
    assert_eq!(
        prepared.packet.spans().next().unwrap().speaker(),
        ActorRole::User
    );
    let output = record(&receipt, "native_compiler_generation_result", Some(3)).unwrap();
    let verdict = judge(output["result"]["Ok"].as_str().unwrap(), &prepared);
    assert_eq!(verdict["nativeBound"], true);
    assert_eq!(verdict["claims"], json!([]));
    assert_eq!(verdict["frozenExpectationMatched"], false);
    assert_eq!(verdict["semanticAccepted"], false);
}

#[test]
fn receipt_bytes_and_source_decoder_contract_cannot_drift() {
    assert!(frozen_receipt(&(RECEIPT.to_owned() + "\n")).is_err());
    let baseline = frozen_receipt(RECEIPT).unwrap();
    let mutations = [
        (
            "native_compiler_original",
            None,
            "original",
            json!("changed original"),
        ),
        (
            "native_compiler_generation_input",
            Some(3),
            "user",
            json!("{}"),
        ),
        (
            "native_compiler_generation_input",
            Some(3),
            "systemSha256",
            json!("foreign"),
        ),
        (
            "native_compiler_generation_input",
            Some(3),
            "userSha256",
            json!("foreign"),
        ),
        (
            "native_compiler_generation_input",
            Some(3),
            "grammarSha256",
            json!("foreign"),
        ),
        (
            "native_compiler_generation_input",
            Some(3),
            "model",
            json!({"id":"foreign"}),
        ),
        (
            "native_compiler_generation_input",
            Some(3),
            "outputTokens",
            json!(1536),
        ),
        (
            "native_compiler_generation_input",
            Some(3),
            "contextTokens",
            json!(8192),
        ),
        (
            "native_compiler_generation_input",
            Some(3),
            "packetIndex",
            json!(2),
        ),
        (
            "native_compiler_generation_result",
            Some(3),
            "result",
            json!({"Ok":"{}"}),
        ),
        (
            "native_compiler_generation_result",
            Some(4),
            "result",
            json!({"Ok":"{\"sourceCoverage\":\"covered\"}"}),
        ),
    ];
    for (phase, call, field, value) in mutations {
        let mut altered = baseline.clone();
        let record = altered["records"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|record| record["phase"] == phase && record["call"].as_u64() == call)
            .unwrap();
        record[field] = value;
        assert!(
            prepare(&altered, fake_tokens).is_err(),
            "accepted changed {phase}/{field}"
        );
    }
}

#[test]
fn exact_baseline_token_count_and_both_fixed_context_limits_are_required() {
    let receipt = frozen_receipt(RECEIPT).unwrap();
    assert!(prepare(&receipt, |_, _| Ok(1827)).is_err());
    assert!(prepare(&receipt, |system, user| {
        if system.contains(REQUEST_GUIDANCE) {
            Ok(sources::MAX_INPUT_TOKENS + 1)
        } else {
            fake_tokens(system, user)
        }
    })
    .is_err());
}

#[test]
fn candidate_adds_only_request_guidance_without_fixture_specific_answer() {
    let prepared = prepare(&frozen_receipt(RECEIPT).unwrap(), fake_tokens).unwrap();
    assert_eq!(
        prepared
            .candidate_system
            .replace(&format!(" {REQUEST_GUIDANCE}"), ""),
        prepared.baseline_system
    );
    assert!(!REQUEST_GUIDANCE.contains("synthetic"));
    assert!(!REQUEST_GUIDANCE.contains(SPAN_ID));
    assert!(prepared.candidate_system.contains("Do not summarize generic policy, inventories, test-harness chatter or coordination as the person's performed work"));
    assert!(REQUEST_GUIDANCE.contains(
        "Standing rules and metadata alone are not concrete task requests or performed work."
    ));
    // Synthetic shape control only; model inference never substitutes this output.
    let output = json!({"outcome":"claims","claims":[expected_proposal()]});
    let verdict = judge(&output.to_string(), &prepared);
    assert_eq!(verdict["nativeBound"], true);
    assert_eq!(verdict["frozenExpectationMatched"], true);
    assert_eq!(verdict["semanticAccepted"], false);
    assert_eq!(
        verdict["claims"][0]["claim"]["provenance"][0]["speaker"],
        "user"
    );
    let mut normalized = output;
    normalized["claims"][0]["action"] = json!("  request   the synthetic report.  ");
    assert_eq!(
        judge(&normalized.to_string(), &prepared)["frozenExpectationMatched"],
        true
    );
}

#[test]
fn standing_rule_control_still_allows_empty_claims_without_forcing_request_output() {
    // Non-generated shape control, not evidence that the model recognizes rules.
    let original = "---\nsource: codex\nconversation_id: synthetic-rule\ncreated: 2026-10-01\n---\n**User:**\nAlways use ISO dates in report filenames.\n";
    let source = SourceBinding {
        key: "codex:synthetic-rule".into(),
        raw_path: "raw/conversations/codex/synthetic-rule.md".into(),
        source_revision: source_revision(original),
    };
    let origin = AgentVaultSession {
        vault_path: "/synthetic/request-rule-control".into(),
        opening_token: "synthetic-request-rule-control-opening".into(),
    };
    let plan = sources::prepare(&source, original, &origin, "en", fake_tokens).unwrap();
    assert_eq!(plan.windows.len(), 1);
    let verified = CompilationOriginal::verify(original, &source.source_revision).unwrap();
    let packet = plan.packet(0, &verified, &origin).unwrap();
    assert!(compiler::bind_claims(
        &packet,
        r#"{"outcome":"insufficient_evidence","claims":[]}"#,
        &origin,
        0
    )
    .unwrap()
    .is_empty());
}

#[test]
fn native_rejection_and_narrow_semantic_mismatches_remain_separate() {
    let prepared = prepare(&frozen_receipt(RECEIPT).unwrap(), fake_tokens).unwrap();
    let original = expected_proposal();
    let cases = [
        ("anchorSpanId", json!("FOREIGN"), false),
        (
            "actor",
            json!({"role":"assistant","basis":"speaker","subjectSpanId":null}),
            false,
        ),
        (
            "actor",
            json!({"role":"user","basis":"speaker","subjectSpanId":null}),
            true,
        ),
        ("action", json!("Draft the synthetic report"), true),
        (
            "action",
            json!("Request the synthetic report from the assistant"),
            true,
        ),
        ("status", json!("unknown"), true),
        ("speechAct", json!("plan"), false),
        ("verificationId", json!("INVENTED"), false),
        (
            "eventTime",
            json!({"value":"2026-10-01","basis":"explicit","precision":"day","uncertainty":"specified","supportSpanId":SPAN_ID}),
            false,
        ),
    ];
    for (field, value, native_bound) in cases {
        let mut proposal = original.clone();
        proposal[field] = value;
        let verdict = judge(
            &json!({"outcome":"claims","claims":[proposal]}).to_string(),
            &prepared,
        );
        assert_eq!(
            verdict["nativeBound"], native_bound,
            "native check for {field}"
        );
        assert_eq!(
            verdict["frozenExpectationMatched"], false,
            "expectation for {field}"
        );
        assert_eq!(verdict["semanticAccepted"], false);
    }
    assert_eq!(
        judge(
            &json!({"outcome":"claims","claims":[original.clone(),original]}).to_string(),
            &prepared
        )["frozenExpectationMatched"],
        false
    );
}

#[test]
fn frozen_control_labels_bind_to_fresh_originals_without_semantic_approval() {
    let bytes = include_str!("../../../docs/research/2026-11-10-request-extraction-controls.json");
    assert_eq!(
        source_revision(bytes),
        "44d8142b0f6f0abe2019be95dc1cbfac20cccb830c8d242504b1c01defdc8269"
    );
    let controls: Value = serde_json::from_str(bytes).unwrap();
    assert_eq!(controls["inferenceExecuted"], false);
    let cases = controls["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 7);
    for case in cases {
        let id = case["id"].as_str().unwrap();
        let text = case["original"].as_str().unwrap();
        assert_eq!(source_revision(text), case["originalSha256"]);
        let speaker = match case["speaker"].as_str().unwrap() {
            "user" => "User",
            "assistant" => "Assistant",
            _ => panic!("unsupported control speaker"),
        };
        let original = format!("---\nsource: codex\nconversation_id: synthetic-{id}\ncreated: 2026-10-01\n---\n**{speaker}:**\n{text}\n");
        let source = SourceBinding {
            key: format!("codex:synthetic-{id}"),
            raw_path: format!("raw/conversations/codex/synthetic-{id}.md"),
            source_revision: source_revision(&original),
        };
        let origin = AgentVaultSession {
            vault_path: format!("/synthetic/request-controls/{id}"),
            opening_token: format!("synthetic-opening-{id}"),
        };
        let plan = sources::prepare(&source, &original, &origin, "en", fake_tokens).unwrap();
        assert_eq!(plan.windows.len(), 1, "{id}");
        let verified = CompilationOriginal::verify(&original, &source.source_revision).unwrap();
        let packet = plan.packet(0, &verified, &origin).unwrap();
        let span = packet
            .spans()
            .find(|span| span.text().contains(text))
            .unwrap();
        let span_id = span.id();
        let proposals: Vec<Value> = case["expected"]["claims"]
            .as_array()
            .unwrap()
            .iter()
            .map(|label| {
                let mut proposal = expected_proposal();
                for field in ["action", "speechAct", "status", "actor"] {
                    proposal[field] = label[field].clone();
                }
                proposal["anchorSpanId"] = json!(span_id);
                proposal["supportSpanIds"] = json!([span_id]);
                proposal["actor"]["subjectSpanId"] =
                    if label["actor"]["basis"] == "explicit_subject" {
                        json!(span_id)
                    } else {
                        Value::Null
                    };
                proposal
            })
            .collect();
        // These are constructed gold proposals, never generated model results.
        let output = json!({"outcome":case["expected"]["outcome"],"claims":proposals});
        let bound = compiler::bind_claims(&packet, &output.to_string(), &origin, 0).unwrap();
        assert_eq!(bound.len(), proposals.len(), "{id}");
        for claim in bound {
            assert!(claim.claim.semantic_review_required, "{id}");
            assert_eq!(claim.claim.provenance.len(), 1);
            assert!(claim.claim.provenance[0].text().contains(text));
        }
    }
}
