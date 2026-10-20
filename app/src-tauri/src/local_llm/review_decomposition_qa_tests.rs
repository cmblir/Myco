// QA decoding and accounting contracts only; no semantic or publication authority.

use super::*;
use llama_cpp_2::token::{data::LlamaTokenData, data_array::LlamaTokenDataArray};
use serde_json::Value;

const REASON: &str =
    "The original reports nonperformance; repeated references do not verify completion.";

fn schemas() -> [GenerationSchema; 2] {
    [
        GenerationSchema::WikiClaimFieldReviewQaV1,
        GenerationSchema::WikiSourceCoverageQaV1,
    ]
}

fn ids(count: usize) -> String {
    (0..count)
        .map(|index| format!("\"Q{index}\""))
        .collect::<Vec<_>>()
        .join(",")
}

fn field_output(claim_id: &str, disposition: &str, reason: &str, count: usize) -> String {
    let claim_id = serde_json::to_string(claim_id).unwrap();
    let reason = serde_json::to_string(reason).unwrap();
    let decision = format!(
        r#"{{"disposition":"{disposition}","reason":{reason},"evidenceSpanIds":[{}]}}"#,
        ids(count)
    );
    format!(
        r#"{{"version":"WikiClaimFieldReviewQaV1","claimId":{claim_id},"actor":{decision},"action":{decision},"eventTime":{decision},"speechAct":{decision},"status":{decision},"reason":{reason}}}"#
    )
}

fn coverage_output(coverage: &str, reason: &str, count: usize) -> String {
    let reason = serde_json::to_string(reason).unwrap();
    format!(
        r#"{{"version":"WikiSourceCoverageQaV1","sourceCoverage":"{coverage}","missingSpanIds":[{}],"reason":{reason}}}"#,
        ids(count)
    )
}

#[test]
fn decomposition_qa_schemas_are_static_distinct_and_issue_no_claim_decisions() {
    let [field, coverage] = schemas();
    assert_eq!(field.claim_review_decisions(), None);
    assert_eq!(coverage.claim_review_decisions(), None);
    assert_eq!(
        field.grammar(),
        review_decomposition_qa::FIELD_REVIEW_JSON_GRAMMAR
    );
    assert_eq!(
        coverage.grammar(),
        review_decomposition_qa::SOURCE_COVERAGE_JSON_GRAMMAR
    );
    assert_ne!(field.qa_grammar_sha256(), coverage.qa_grammar_sha256());
    for schema in schemas() {
        assert_eq!(
            schema.qa_grammar_sha256(),
            format!("{:x}", Sha256::digest(schema.grammar().as_bytes()))
        );
    }
}

#[test]
fn decomposition_qa_preserves_existing_production_grammar_bytes() {
    assert_eq!(
        GenerationSchema::AskAnswerV1.qa_grammar_sha256(),
        "924174ca8f00e348868c89f43fd622b5508dc940cd898366e2476b05e9bdd043"
    );
    assert_eq!(
        GenerationSchema::WikiClaimReviewV1(ReviewDecisions::new(0).unwrap()).qa_grammar_sha256(),
        "431f34add80e0342e0c0348a6d1ae8267873db7554f647a601fae7b00d2487e5"
    );
}

#[test]
fn decomposition_qa_telemetry_distinguishes_stages_without_claiming_validation() {
    for (schema, name) in schemas()
        .into_iter()
        .zip(["wikiClaimFieldReviewQaV1", "wikiSourceCoverageQaV1"])
    {
        let attempt = Recorder::new(Some(schema), 768, 4096)
            .finish(Err("Synthetic accounting failure only.".into()));
        let observed = serde_json::to_value(attempt.telemetry()).unwrap();
        assert_eq!(observed["schema"], name);
        assert_eq!(observed["profile"], "existingGroundedV1");
        assert_eq!(observed["terminal"], "failed");
        assert_eq!(observed["requestedOutputTokens"], 768);
        assert_eq!(observed["requestedContextTokens"], 4096);
        assert!(!observed.to_string().contains("Synthetic accounting"));
        for authority in [
            "accepted",
            "sourceValidated",
            "semanticAccepted",
            "published",
        ] {
            assert!(observed.get(authority).is_none());
        }
    }
}

#[test]
fn decomposition_qa_keeps_the_existing_budget_and_full_prompt_reserve() {
    for schema in schemas() {
        assert_eq!(schema_output_limit(Some(schema)), 768);
        assert!(validate_generation_budget(3320, 768, 4096, Some(schema)).is_ok());
        assert!(validate_generation_budget(3321, 768, 4096, Some(schema)).is_err());
        assert!(validate_generation_budget(1272, 768, 2048, Some(schema)).is_ok());
        assert!(validate_generation_budget(1273, 768, 2048, Some(schema)).is_err());
        for (prompt, output, context) in
            [(0, 768, 4096), (1, 0, 4096), (1, 769, 4096), (1, 768, 8192)]
        {
            assert!(validate_generation_budget(prompt, output, context, Some(schema)).is_err());
        }
    }
}

#[test]
fn decomposition_qa_limits_and_cancellation_precede_chat_weight_loading() {
    let host = LocalLlm::load_embed_host().unwrap();
    for schema in schemas() {
        for (output, context) in [(0, 4096), (769, 4096), (768, 8192)] {
            let error = host
                .generate_structured_cancellable(
                    "QA policy",
                    "Synthetic original",
                    output,
                    context,
                    schema,
                    &AtomicBool::new(false),
                )
                .unwrap_err();
            assert!(error.contains("invalid generation limits"), "{error}");
            assert!(!host.chat_model_loaded());
        }
        let attempt = host.generate_structured_cancellable_measured(
            "QA policy",
            "Synthetic original",
            768,
            4096,
            schema,
            &AtomicBool::new(true),
        );
        assert_eq!(
            serde_json::to_value(attempt.telemetry()).unwrap()["terminal"],
            "cancelled"
        );
        assert!(attempt.into_result().unwrap_err().contains("cancelled"));
        assert!(!host.chat_model_loaded());
    }
}

#[test]
fn decomposition_qa_guard_keeps_repeated_ids_and_negative_original_text() {
    for (schema, original) in schemas().into_iter().zip([
        field_output("C0", "uncertain", REASON, 8),
        coverage_output("missing", REASON, 512),
    ]) {
        let expected: Value = serde_json::from_str(&original).unwrap();
        let mut assembled = String::new();
        for character in original.chars() {
            assembled.push(character);
            assert!(output_guard::apply_with_reason(&mut assembled, Some(schema)).is_none());
        }
        assert_eq!(assembled, original);
        assert_eq!(serde_json::from_str::<Value>(&assembled).unwrap(), expected);
    }
}

#[test]
fn decomposition_qa_raw_shapes_cannot_admit_a_production_claim_review() {
    let (packet, claims, context) = crate::wiki_claim_review::tests::fixture();
    for raw in [
        field_output("C0", "supported", "Explicitly synthetic field decision.", 0),
        coverage_output("covered", "Explicitly synthetic coverage decision.", 0),
    ] {
        let error = crate::wiki_claim_review::run(
            &context,
            &packet,
            &claims,
            |_, _| Ok(1000),
            |_, _, _, _, _| Ok(raw.clone()),
        )
        .unwrap_err();
        assert_eq!(error.code(), "review_invalid");
    }
}

// Real vocabulary masking, without inference. Every actual EOG token is checked.
fn vocabulary_accepts(model: &LlamaModel, grammar: &str, output: &str) -> bool {
    let mut sampler = LlamaSampler::grammar(model, grammar, "root").unwrap();
    for token in model.str_to_token(output, AddBos::Never).unwrap() {
        let mut choice =
            LlamaTokenDataArray::new(vec![LlamaTokenData::new(token, 0.0, 0.0)], false);
        sampler.apply(&mut choice);
        if !choice.data[0].logit().is_finite() {
            return false;
        }
        sampler.accept(token);
    }
    let ends = (0..model.n_vocab())
        .map(llama_cpp_2::token::LlamaToken::new)
        .filter(|token| model.is_eog_token(*token))
        .collect::<Vec<_>>();
    assert!(!ends.is_empty());
    ends.into_iter().all(|token| {
        let mut choice =
            LlamaTokenDataArray::new(vec![LlamaTokenData::new(token, 0.0, 0.0)], false);
        sampler.apply(&mut choice);
        choice.data[0].logit().is_finite()
    })
}

fn vocabulary_host() -> LocalLlm {
    let path =
        PathBuf::from(std::env::var_os("MYCO_CHAT_MODEL_PATH").expect("verified GGUF required"));
    let mut host = LocalLlm::load_embed_host().unwrap();
    host.ensure_chat_model(&path).unwrap();
    host
}

#[test]
#[ignore = "requires verified GGUF via MYCO_CHAT_MODEL_PATH; vocabulary masking only, no inference"]
fn decomposition_qa_field_grammar_closes_fields_ids_reasons_and_evidence_bounds() {
    let host = vocabulary_host();
    let model = host.chat_model().unwrap();
    let grammar = GenerationSchema::WikiClaimFieldReviewQaV1.grammar();
    for disposition in ["supported", "unsupported", "uncertain"] {
        for count in [0, 8] {
            assert!(vocabulary_accepts(
                model,
                &grammar,
                &field_output("C0", disposition, "합성 검사: \"미수행\" \\ path", count,)
            ));
        }
    }
    assert!(vocabulary_accepts(
        model,
        &grammar,
        &field_output(&"C".repeat(64), "supported", &"x".repeat(128), 8)
    ));
    for (id, disposition, reason, count) in [
        ("", "supported", "Reason", 0),
        ("C.0", "supported", "Reason", 0),
        ("C0", "accepted", "Reason", 0),
        ("C0", "supported", "", 0),
        ("C0", "supported", "Reason", 9),
    ] {
        assert!(!vocabulary_accepts(
            model,
            &grammar,
            &field_output(id, disposition, reason, count)
        ));
    }
    for raw in [
        field_output(&"C".repeat(65), "supported", "Reason", 0),
        field_output("C0", "supported", &"x".repeat(129), 0),
    ] {
        assert!(!vocabulary_accepts(model, &grammar, &raw));
    }
    let complete = field_output("C0", "supported", "Reason", 0);
    for missing in [
        "actor",
        "action",
        "eventTime",
        "speechAct",
        "status",
        "reason",
    ] {
        let removed = if missing == "reason" {
            complete.replace(",\"reason\":\"Reason\"}", "}")
        } else {
            complete.replace(
                &format!(r#""{missing}":{{"disposition":"supported","reason":"Reason","evidenceSpanIds":[]}},"#),
                "",
            )
        };
        assert_ne!(removed, complete);
        assert!(!vocabulary_accepts(model, &grammar, &removed));
    }
    assert!(!vocabulary_accepts(
        model,
        &grammar,
        complete.strip_suffix('}').unwrap()
    ));
    assert!(!vocabulary_accepts(
        model,
        &grammar,
        &complete.replace("\"claimId\":\"C0\"", "\"claimId\":0")
    ));
    assert!(!vocabulary_accepts(
        model,
        &grammar,
        &complete.replace("\"version\":", "\"published\":true,\"version\":")
    ));
    assert!(!vocabulary_accepts(
        model,
        &grammar,
        &complete.replace("\"evidenceSpanIds\":[]", "\"evidenceSpanIds\":[\"Q.1\"]")
    ));
    assert!(grounded_sampler(model, GenerationSchema::WikiClaimFieldReviewQaV1).is_ok());
}

#[test]
#[ignore = "requires verified GGUF via MYCO_CHAT_MODEL_PATH; vocabulary masking only, no inference"]
fn decomposition_qa_coverage_grammar_closes_enums_reasons_and_512_missing_ids() {
    let host = vocabulary_host();
    let model = host.chat_model().unwrap();
    let grammar = GenerationSchema::WikiSourceCoverageQaV1.grammar();
    for coverage in ["covered", "missing", "uncertain"] {
        for count in [0, 8, 512] {
            // Cross-field coverage meaning and admitted IDs are checked by the QA adapter.
            assert!(vocabulary_accepts(
                model,
                &grammar,
                &coverage_output(coverage, "Reason", count)
            ));
        }
    }
    assert!(vocabulary_accepts(
        model,
        &grammar,
        &coverage_output("uncertain", &"x".repeat(128), 0)
    ));
    for raw in [
        coverage_output("complete", "Reason", 0),
        coverage_output("covered", "", 0),
        coverage_output("covered", &"x".repeat(129), 0),
        coverage_output("missing", "Reason", 513),
    ] {
        assert!(!vocabulary_accepts(model, &grammar, &raw));
    }
    let complete = coverage_output("uncertain", "Reason", 0);
    assert!(!vocabulary_accepts(
        model,
        &grammar,
        complete.strip_suffix('}').unwrap()
    ));
    assert!(!vocabulary_accepts(
        model,
        &grammar,
        &complete.replace("\"reason\":", "\"approved\":true,\"reason\":")
    ));
    assert!(!vocabulary_accepts(
        model,
        &grammar,
        &complete.replace("\"missingSpanIds\":[]", "\"missingSpanIds\":[\"Q.1\"]")
    ));
    assert!(grounded_sampler(model, GenerationSchema::WikiSourceCoverageQaV1).is_ok());
}
