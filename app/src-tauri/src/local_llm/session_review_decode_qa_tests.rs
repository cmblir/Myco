use super::super::generation_telemetry::{
    AttemptTerminal, GenerationErrorCode, GenerationPhase, TelemetrySchema,
};
use super::*;
use crate::session_compile::review_decode_qa::tests::{fixture_contract, output};

#[test]
#[ignore = "requires a verified cached GGUF; vocabulary masking only, no inference"]
fn session_review_decode_cannot_mix_claim_and_expression_ids() {
    let path = PathBuf::from(
        std::env::var_os("MYCO_CHAT_MODEL_PATH").expect("MYCO_CHAT_MODEL_PATH is required"),
    );
    let mut host = LocalLlm::load_embed_host().unwrap();
    host.ensure_chat_model(&path).unwrap();
    let model = host.chat_model().unwrap();
    let mixed = r#"{"version":"SessionReviewV1","claims":[{"id":"C-1-0-synthetic","disposition":"supported","reason":"Synthetic claim."},{"id":"entity-0","disposition":"supported","reason":"Invented claim-group decision."}],"expressions":[{"id":"title","disposition":"supported","reason":"Synthetic title."},{"id":"entity-0","disposition":"supported","reason":"Synthetic entity."},{"id":"summary-0","disposition":"supported","reason":"Synthetic summary."}],"missingSpanIds":[],"sourceCoverage":"covered"}"#;
    assert!(vocabulary_accepts(
        model,
        &GenerationSchema::SessionReviewV1.grammar(),
        mixed
    ));
    let contract = fixture_contract(1, 1);
    let input: serde_json::Value = serde_json::from_str(contract.user()).unwrap();
    let mixed = mixed.replace(
        "C-1-0-synthetic",
        input["requiredClaimIds"][0].as_str().unwrap(),
    );
    assert!(vocabulary_accepts(
        model,
        &GenerationSchema::SessionReviewV1.grammar(),
        &mixed
    ));
    assert!(
        !vocabulary_accepts(model, contract.grammar(), &mixed),
        "a source-bound review must not decode an expression ID as an extra claim decision"
    );
    for (claims, entities) in [(0, 0), (1, 1), (1, 3), (16, 8)] {
        let contract = fixture_contract(claims, entities);
        for disposition in ["supported", "unsupported", "uncertain"] {
            for coverage in ["covered", "missing", "uncertain"] {
                for missing in [false, true] {
                    let candidate = output(
                        &contract,
                        disposition,
                        coverage,
                        missing,
                        "합성 확인: \"인용\" \\ 경로",
                    );
                    assert_eq!(
                        vocabulary_accepts(model, contract.grammar(), &candidate),
                        !(coverage == "covered" && missing)
                    );
                }
            }
        }
        let valid = output(&contract, "uncertain", "uncertain", false, "S");
        let ends = (0..model.n_vocab())
            .map(llama_cpp_2::token::LlamaToken::new)
            .filter(|token| model.is_eog_token(*token))
            .collect::<Vec<_>>();
        assert!(!ends.is_empty());
        for end in ends {
            assert!(vocabulary_accepts_terminated_by(
                model,
                contract.grammar(),
                &valid,
                end
            ));
            for partial in [
                r#"{"version":"SessionReviewV1","claims":["#,
                valid.strip_suffix('}').unwrap(),
            ] {
                assert!(!vocabulary_accepts_terminated_by(
                    model,
                    contract.grammar(),
                    partial,
                    end
                ));
            }
        }
        if claims == 0 {
            assert!(!valid.contains("\"reason\""));
            assert_eq!(
                output(&contract, "supported", "covered", false, ""),
                output(&contract, "supported", "covered", false, &"S".repeat(129))
            );
        } else {
            for reason in ["", &"S".repeat(129), &"한".repeat(129)] {
                assert!(!vocabulary_accepts(
                    model,
                    contract.grammar(),
                    &output(&contract, "supported", "covered", false, reason)
                ));
            }
            for reason in [&"S".repeat(128), &"한".repeat(128)] {
                assert!(vocabulary_accepts(
                    model,
                    contract.grammar(),
                    &output(&contract, "supported", "covered", false, reason)
                ));
            }
        }
        assert!(!vocabulary_accepts(
            model,
            contract.grammar(),
            &output(&contract, "supported", "accepted", false, "S")
        ));
        if claims > 0 {
            assert!(!vocabulary_accepts(
                model,
                contract.grammar(),
                &output(&contract, "accepted", "covered", false, "S")
            ));
        }
        let mut bad: serde_json::Value = serde_json::from_str(&valid).unwrap();
        bad["missingSpanIds"] = serde_json::json!(["Q-foreign"]);
        // Serialize again in grammar field order when mutating decision groups.
        let serialize = |value: &serde_json::Value| {
            let group = |name: &str| {
                format!(
                    "[{}]",
                    value[name]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|decision| format!(
                            r#"{{"id":{},"disposition":{},"reason":{}}}"#,
                            decision["id"], decision["disposition"], decision["reason"]
                        ))
                        .collect::<Vec<_>>()
                        .join(",")
                )
            };
            format!(
                r#"{{"version":"SessionReviewV1","claims":{},"expressions":{},"missingSpanIds":{},"sourceCoverage":{}}}"#,
                group("claims"),
                group("expressions"),
                value["missingSpanIds"],
                value["sourceCoverage"]
            )
        };
        assert!(vocabulary_accepts(
            model,
            contract.grammar(),
            &serialize(&serde_json::from_str(&valid).unwrap())
        ));
        assert!(!vocabulary_accepts(
            model,
            contract.grammar(),
            &serialize(&bad)
        ));
        let input: serde_json::Value = serde_json::from_str(contract.user()).unwrap();
        bad["missingSpanIds"] = serde_json::json!([
            input["originalSpans"][0]["id"],
            input["originalSpans"][0]["id"]
        ]);
        assert!(!vocabulary_accepts(
            model,
            contract.grammar(),
            &serialize(&bad)
        ));
        for group in ["claims", "expressions"] {
            let correct: serde_json::Value = serde_json::from_str(&valid).unwrap();
            let decisions = correct[group].as_array().unwrap();
            if decisions.is_empty() {
                let mut bad = correct.clone();
                bad[group] = serde_json::json!([{
                    "id":"foreign", "disposition":"uncertain", "reason":"S"
                }]);
                assert!(!vocabulary_accepts(
                    model,
                    contract.grammar(),
                    &serialize(&bad)
                ));
            } else {
                let mut bad = correct.clone();
                bad[group]
                    .as_array_mut()
                    .unwrap()
                    .push(decisions[0].clone());
                assert!(!vocabulary_accepts(
                    model,
                    contract.grammar(),
                    &serialize(&bad)
                ));
                let mut bad = correct.clone();
                bad[group].as_array_mut().unwrap().remove(0);
                assert!(!vocabulary_accepts(
                    model,
                    contract.grammar(),
                    &serialize(&bad)
                ));
                if decisions.len() > 1 {
                    let mut bad = correct.clone();
                    bad[group].as_array_mut().unwrap().swap(0, 1);
                    assert!(!vocabulary_accepts(
                        model,
                        contract.grammar(),
                        &serialize(&bad)
                    ));
                    let mut bad = correct.clone();
                    bad[group][1] = decisions[0].clone();
                    assert!(!vocabulary_accepts(
                        model,
                        contract.grammar(),
                        &serialize(&bad)
                    ));
                }
            }
        }
        if claims > 0 {
            let mut invalid = valid.clone();
            let input: serde_json::Value = serde_json::from_str(contract.user()).unwrap();
            let claim_id = input["requiredClaimIds"][0].as_str().unwrap();
            invalid = invalid.replacen(claim_id, "title", 1);
            assert!(!vocabulary_accepts(model, contract.grammar(), &invalid));
            let wrong = valid.replacen(claim_id, "C-foreign", 1);
            assert!(!vocabulary_accepts(model, contract.grammar(), &wrong));
            let missing_expression = valid.replacen("\"title\"", &format!("\"{claim_id}\""), 1);
            assert!(!vocabulary_accepts(
                model,
                contract.grammar(),
                &missing_expression
            ));
        }
    }
}

#[test]
fn session_review_qa_admission_precedes_template_model_and_sampling() {
    let host = LocalLlm::load_embed_host().unwrap();
    let contract = fixture_contract(1, 1);
    let stopped = host.generate_session_review_cancellable_measured_qa(
        "stale",
        "stale",
        0,
        8192,
        &contract,
        &AtomicBool::new(true),
    );
    assert_eq!(stopped.telemetry().terminal, AttemptTerminal::Cancelled);
    assert_eq!(
        stopped.telemetry().terminal_phase,
        GenerationPhase::Admission
    );
    assert!(stopped.telemetry().prompt_tokens.is_none());
    assert!(stopped.telemetry().prefill_completed_tokens.is_none());
    assert!(stopped.telemetry().sampled_tokens.is_none());
    for (system, user) in [
        (
            contract.system().to_owned(),
            format!("{} ", contract.user()),
        ),
        (
            format!("{} ", contract.system()),
            contract.user().to_owned(),
        ),
    ] {
        let stale = host.generate_session_review_cancellable_measured_qa(
            &system,
            &user,
            768,
            4096,
            &contract,
            &AtomicBool::new(false),
        );
        assert_eq!(
            stale.telemetry().error_code,
            Some(GenerationErrorCode::InvalidSessionReviewQaContract)
        );
        assert_eq!(stale.telemetry().terminal_phase, GenerationPhase::Admission);
        assert!(stale.telemetry().prompt_tokens.is_none());
        assert!(stale.telemetry().prefill_completed_tokens.is_none());
        assert!(stale.telemetry().sampled_tokens.is_none());
        assert!(!host.chat_model_loaded());
    }
    for (output, context) in [(0, 4096), (769, 4096), (768, 8192)] {
        let attempt = host.generate_session_review_cancellable_measured_qa(
            contract.system(),
            contract.user(),
            output,
            context,
            &contract,
            &AtomicBool::new(false),
        );
        assert_eq!(
            attempt.telemetry().error_code,
            Some(GenerationErrorCode::InvalidLimits)
        );
        assert_eq!(
            attempt.telemetry().schema,
            TelemetrySchema::SessionReviewCorrelatedQaV1
        );
        assert!(attempt.telemetry().prompt_tokens.is_none());
        assert!(attempt.telemetry().prefill_completed_tokens.is_none());
        assert!(attempt.telemetry().sampled_tokens.is_none());
        assert!(!host.chat_model_loaded());
    }
    let missing = host.generate_session_review_cancellable_measured_qa(
        contract.system(),
        contract.user(),
        768,
        4096,
        &contract,
        &AtomicBool::new(false),
    );
    assert_eq!(
        missing.telemetry().error_code,
        Some(GenerationErrorCode::ModelMissing)
    );
    assert_eq!(
        missing.telemetry().terminal_phase,
        GenerationPhase::Template
    );
    assert!(missing.telemetry().prefill_completed_tokens.is_none());
    assert!(missing.telemetry().sampled_tokens.is_none());
    assert!(!host.chat_model_loaded());
    assert!(
        validate_generation_budget(3320, 768, 4096, Some(GenerationSchema::SessionReviewV1))
            .is_ok()
    );
    assert!(
        validate_generation_budget(3321, 768, 4096, Some(GenerationSchema::SessionReviewV1))
            .is_err()
    );
    assert_eq!(
        GenerationSchema::SessionReviewV1.qa_grammar_sha256(),
        "526bdcd149adcf30c86ea1adc45a83f0aea821a09f029a197f2006fef79a5ac8"
    );
    let first = GenerationSchema::SessionReviewV1;
    let copy = first;
    assert_eq!(first, copy);
}
