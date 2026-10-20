use super::*;

fn cases() -> Vec<Case> {
    let pairs =
        serde_json::from_str(include_str!("../../eval/local-wiki-v1/review-pairs.json")).unwrap();
    let corpus =
        serde_json::from_str(include_str!("../../eval/local-wiki-v1/corpus.json")).unwrap();
    crate::review_smoke::build_cases(&pairs, &corpus).unwrap()
}

#[test]
fn actor_contract_preserves_historical_baseline_and_only_appends_the_frozen_clause() {
    let control = selected_system(false);
    assert_eq!(control, SYSTEM);
    assert_eq!(
        hash(control.as_bytes()),
        "83f6d9756e0da4a68394eba925341629a5bdfbfca672e9220a29fc96e92d34b6"
    );
    let candidate = selected_system(true);
    assert_eq!(
        candidate.strip_prefix(&control),
        Some(format!("\n\n{ACTOR_CONTRACT}").as_str())
    );
    assert_eq!(
        hash(candidate.as_bytes()),
        "d45f9734a3c1d4762f6d47a51e05f4a80dde767a5bb8dd3cd33960f437364c18"
    );
    assert_eq!(
        hash(ACTOR_CONTRACT.as_bytes()),
        "d2c788fd2699a40c084ff5e1be243c4f9befa50aa459d1c70f5f1a5fa33321e3"
    );
    assert_eq!((OUTPUT_TOKENS, CONTEXT_TOKENS), (192, 4096));
}

#[test]
fn bounded_thinking_keeps_the_control_final_budget_and_context() {
    use myco_lib::local_llm::gemma_thinking_qa;
    assert_eq!(gemma_thinking_qa::THOUGHT_TOKENS, 1024);
    assert_eq!(gemma_thinking_qa::FINAL_TOKENS, OUTPUT_TOKENS);
    assert_eq!(gemma_thinking_qa::CONTEXT_TOKENS, CONTEXT_TOKENS);
    assert!(
        gemma_thinking_qa::THOUGHT_TOKENS + OUTPUT_TOKENS as usize + 8 < CONTEXT_TOKENS as usize
    );
}

#[test]
fn compact_input_preserves_all_32_originals_and_proposals_without_labels() {
    let cases = cases();
    assert_eq!(cases.len(), 32);
    for case in cases {
        let user = input(&case).unwrap();
        let value: Value = serde_json::from_str(&user).unwrap();
        let source = case.sources.spans().next().unwrap();
        let proposal: Value = serde_json::from_str(&case.proposal).unwrap();
        assert_eq!(value["original"]["text"], source.text());
        assert_eq!(value["original"]["id"], source.id());
        assert_eq!(value["original"]["speaker"], json!(source.speaker()));
        assert_eq!(value["original"]["turnTime"], json!(source.turn_time()));
        assert_eq!(value["original"]["citationId"], "S1");
        assert_eq!(value["proposal"], proposal["claims"][0]);
        assert_eq!(value["independentVerificationReceipts"], json!([]));
        assert!(!user.contains(&case.id));
        assert!(!user.contains("expectedVerdict"));
        assert!(!user.contains("mutationKind"));
        assert_eq!(value.as_object().unwrap().len(), 3);
    }
}

#[test]
fn compact_input_keeps_wrong_meaning_for_model_judgment_and_rejects_bad_binding() {
    let mut cases = cases();
    for case in cases
        .iter()
        .filter(|case| case.expected_verdict == "reject")
    {
        assert!(
            input(case).is_ok(),
            "QA must not replace the model verdict with gold"
        );
    }
    let case = cases.first_mut().unwrap();
    let mut proposal: Value = serde_json::from_str(&case.proposal).unwrap();
    proposal["claims"][0]["anchorSpanId"] = json!("foreign-original");
    case.proposal = proposal.to_string();
    assert!(input(case).is_err());
}

#[test]
fn compact_input_rejects_empty_and_multiple_proposals_instead_of_trimming() {
    let mut cases = cases();
    let case = cases.first_mut().unwrap();
    let original: Value = serde_json::from_str(&case.proposal).unwrap();
    case.proposal = json!({"outcome":"insufficient_evidence","claims":[]}).to_string();
    assert!(input(case).is_err());
    case.proposal =
        json!({"outcome":"claims","claims":[original["claims"][0],original["claims"][0]]})
            .to_string();
    assert!(input(case).is_err());
}

#[test]
fn compact_output_preserves_supported_unsupported_and_uncertain_as_distinct() {
    for (label, expected) in [
        ("supported", Verdict::Supported),
        ("unsupported", Verdict::Unsupported),
        ("uncertain", Verdict::Uncertain),
    ] {
        let raw = json!({"answer":label,"sources":["S1"]}).to_string();
        assert_eq!(verdict(&raw).unwrap(), expected);
    }
}

#[test]
fn compact_output_budget_and_legacy_stops_are_not_completed_verdicts() {
    let raw = r#"{"answer":"unsupported","sources":["S1"]}"#;
    assert_eq!(
        completed_verdict(raw, Some(LoopStop::Eog)).unwrap(),
        Verdict::Unsupported
    );
    for stop in [
        None,
        Some(LoopStop::OutputBudget),
        Some(LoopStop::LegacyDialogueMarker),
        Some(LoopStop::LegacyRepetition),
    ] {
        assert!(completed_verdict(raw, stop).is_err());
    }
}

#[test]
fn compact_output_rejects_unbound_citations_extra_fields_and_nonverdict_text() {
    for sources in [
        json!([]),
        json!(["S2"]),
        json!(["S1", "S1"]),
        json!(["span_native_id"]),
    ] {
        assert!(verdict(&json!({"answer":"unsupported","sources":sources}).to_string()).is_err());
    }
    for raw in [
        r#"{"answer":"supported","sources":["S1"],"reason":"Invented."}"#,
        r#"{"answer":"accept","sources":["S1"]}"#,
        r#"{"answer":"Supported","sources":["S1"]}"#,
        r#"{"answer":"supported because it looks right","sources":["S1"]}"#,
        r#"{"answer":"supported","sources":["S1"]} trailing"#,
        r#"{"answer":"supported","answer":"unsupported","sources":["S1"]}"#,
    ] {
        assert!(verdict(raw).is_err(), "{raw}");
    }
}
