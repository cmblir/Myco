//! Model-free admission and unchanged-validator controls, not meaning gold.

use super::*;

fn fake_tokens(system: &str, _: &str) -> Result<usize, String> {
    // Only the recorded baseline count is asserted here. Real tokenizer counts
    // are required separately before the opt-in model comparison can run.
    Ok(if system.contains(EMPTY_GUIDANCE) {
        655
    } else {
        720
    })
}

#[test]
fn frozen_structure_receipt_rebinds_exact_native_input_and_keeps_observed_failure() {
    let receipt = frozen_receipt(RECEIPT).unwrap();
    let prepared = prepare(&receipt, fake_tokens).unwrap();
    assert_eq!(prepared.claims[0].id, "C-2-0-1a7e5f8260c2aa7d");
    assert_eq!(
        prepared.claims[0].claim.proposal.action,
        "Draft the synthetic report"
    );
    let input = record(&receipt, "native_compiler_generation_input", Some(6)).unwrap();
    assert_eq!(prepared.user, input["user"]);
    assert_eq!(source_revision(&prepared.user), input["userSha256"]);
    let output = record(&receipt, "native_compiler_generation_result", Some(6)).unwrap();
    let verdict = judge(output["result"]["Ok"].as_str().unwrap(), &prepared.claims);
    assert_eq!(verdict["structureValid"], false);
    assert_eq!(verdict["materialized"], false);
    assert_eq!(
        verdict["structureError"],
        "session structure identity, title or coverage is invalid"
    );
}

#[test]
fn frozen_receipt_rejects_byte_changes_and_rebinding_rejects_changed_evidence() {
    assert!(frozen_receipt(&(RECEIPT.to_owned() + "\n")).is_err());
    let original = frozen_receipt(RECEIPT).unwrap();
    let mutations = [
        (
            "native_compiler_original",
            None,
            "original",
            json!("changed original"),
        ),
        (
            "native_compiler_generation_input",
            Some(5),
            "user",
            json!("{}"),
        ),
        (
            "native_compiler_generation_result",
            Some(5),
            "result",
            json!({"Ok":"{\"outcome\":\"insufficient_evidence\",\"claims\":[]}"}),
        ),
        (
            "native_compiler_generation_input",
            Some(6),
            "userSha256",
            json!("foreign"),
        ),
        (
            "native_compiler_generation_input",
            Some(6),
            "grammarSha256",
            json!("foreign"),
        ),
        (
            "native_compiler_generation_input",
            Some(6),
            "model",
            json!({"id":"foreign"}),
        ),
        (
            "native_compiler_generation_input",
            Some(6),
            "outputTokens",
            json!(1536),
        ),
        (
            "native_compiler_generation_input",
            Some(6),
            "contextTokens",
            json!(8192),
        ),
    ];
    for (phase, call, field, value) in mutations {
        let mut altered = original.clone();
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
fn replay_requires_original_token_count_and_both_arms_fit_without_budget_expansion() {
    let receipt = frozen_receipt(RECEIPT).unwrap();
    assert!(prepare(&receipt, |_, _| Ok(656)).is_err());
    assert!(prepare(&receipt, |system, user| {
        if system.contains(NONEMPTY_GUIDANCE) {
            Ok(sources::MAX_INPUT_TOKENS + 1)
        } else {
            fake_tokens(system, user)
        }
    })
    .is_err());
}

#[test]
fn candidate_changes_only_nonempty_guidance_and_retains_native_materializer_checks() {
    let prepared = prepare(&frozen_receipt(RECEIPT).unwrap(), fake_tokens).unwrap();
    assert_eq!(
        prepared
            .candidate_system
            .replace(NONEMPTY_GUIDANCE, EMPTY_GUIDANCE),
        prepared.baseline_system
    );
    assert!(!prepared.candidate_system.contains(EMPTY_GUIDANCE));
    // Synthetic shape control only. The model harness never substitutes this output.
    let mut proposal = json!({"version":"SessionStructureV1","title":"Assistant report drafting plan",
        "titleClaimIds":[prepared.claims[0].id],"entities":[]});
    let accepted = judge(&proposal.to_string(), &prepared.claims);
    assert_eq!(accepted["structureValid"], true);
    assert_eq!(accepted["materialized"], true);
    let row = accepted["materialization"]["summaries"][0]["text"]
        .as_str()
        .unwrap();
    assert!(row.contains("Draft the synthetic report"));
    assert!(row.contains("Status: \"planned\""));
    assert!(row.contains("Original speaker: \"assistant\""));
    proposal["titleClaimIds"] = json!(["FOREIGN"]);
    assert_eq!(
        judge(&proposal.to_string(), &prepared.claims)["materialized"],
        false
    );
    proposal["titleClaimIds"] = json!([prepared.claims[0].id]);
    proposal["title"] = json!("");
    assert_eq!(
        judge(&proposal.to_string(), &prepared.claims)["structureValid"],
        false
    );
}
