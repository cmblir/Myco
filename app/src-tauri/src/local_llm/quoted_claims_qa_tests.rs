use super::*;
use generation_telemetry::{AttemptTerminal, TelemetrySchema};
use llama_cpp_2::token::{data::LlamaTokenData, data_array::LlamaTokenDataArray, LlamaToken};

const BODY: &str = r#"{"version":"WikiQuotedClaimsQaV1","outcome":"claims","claims":[{"quote":"I have not deployed the synthetic adapter.","anchorSpanId":"Q1","supportSpanIds":["Q1"],"actor":{"role":"user","basis":"speaker","subjectSpanId":null},"eventTime":{"value":null,"basis":"unknown","precision":"unknown","uncertainty":"unknown","supportSpanId":null},"speechAct":"report","status":"unknown","verificationId":null}]}"#;

#[test]
fn quote_schema_uses_its_own_grammar_and_retains_bounded_original_reserve() {
    let schema = GenerationSchema::WikiQuotedClaimsQaV1;
    assert_eq!(
        schema.grammar(),
        crate::wiki_claims::quoted_qa::QUOTED_CLAIMS_QA_JSON_GRAMMAR
    );
    assert_ne!(
        schema.qa_grammar_sha256(),
        GenerationSchema::WikiClaimsV1.qa_grammar_sha256()
    );
    assert!(validate_generation_budget(2552, 1536, 4096, Some(schema)).is_ok());
    assert!(validate_generation_budget(2553, 1536, 4096, Some(schema)).is_err());
    for (output, context) in [(0, 4096), (1537, 4096), (1536, 8192)] {
        assert!(validate_generation_budget(1, output, context, Some(schema)).is_err());
    }
    assert!(validate_generation_budget(1, 769, 4096, Some(GenerationSchema::AskAnswerV1)).is_err());
}

#[test]
fn quote_schema_early_failures_record_actual_selection_without_loading_weights() {
    let host = LocalLlm::load_embed_host().unwrap();
    for (tokens, cancelled, terminal, error) in [
        (1536, true, AttemptTerminal::Cancelled, None),
        (
            1537,
            false,
            AttemptTerminal::Failed,
            Some(GenerationErrorCode::InvalidLimits),
        ),
        (
            1536,
            false,
            AttemptTerminal::Failed,
            Some(GenerationErrorCode::ModelMissing),
        ),
    ] {
        let attempt = host.generate_structured_cancellable_measured(
            "Synthetic quotation policy",
            "Synthetic original",
            tokens,
            4096,
            GenerationSchema::WikiQuotedClaimsQaV1,
            &AtomicBool::new(cancelled),
        );
        assert_eq!(
            attempt.telemetry().schema,
            TelemetrySchema::WikiQuotedClaimsQaV1
        );
        assert_eq!(
            attempt.telemetry().profile,
            SamplerProfile::ExistingGroundedV1
        );
        assert_eq!(attempt.telemetry().terminal, terminal);
        assert_eq!(attempt.telemetry().error_code, error);
        assert_eq!(attempt.telemetry().prompt_tokens, None);
        assert_eq!(attempt.telemetry().sampled_tokens, None);
        assert!(attempt.into_result().is_err());
        assert!(!host.chat_model_loaded());
    }
}

fn assert_mask(model: &LlamaModel, ends: &[LlamaToken], text: &str, expected: bool) {
    let mut sampler = LlamaSampler::grammar(
        model,
        &GenerationSchema::WikiQuotedClaimsQaV1.grammar(),
        "root",
    )
    .unwrap();
    let allowed = |sampler: &mut LlamaSampler, token| {
        let mut choices =
            LlamaTokenDataArray::new(vec![LlamaTokenData::new(token, 0.0, 0.0)], false);
        sampler.apply(&mut choices);
        choices.data[0].logit().is_finite()
    };
    for token in model.str_to_token(text, AddBos::Never).unwrap() {
        if !allowed(&mut sampler, token) {
            assert!(!expected, "unexpected quote grammar rejection: {text}");
            return;
        }
        sampler.accept(token);
    }
    for end in ends {
        assert_eq!(
            allowed(&mut sampler, *end),
            expected,
            "EOG admission: {text}"
        );
    }
}

#[test]
#[ignore = "requires a verified GGUF via MYCO_CHAT_MODEL_PATH; vocabulary masking only, no inference"]
fn quoted_claims_vocabulary_masks_closed_shape_without_certifying_meaning() {
    let path = PathBuf::from(
        std::env::var_os("MYCO_CHAT_MODEL_PATH").expect("MYCO_CHAT_MODEL_PATH is required"),
    );
    let mut host = LocalLlm::load_embed_host().unwrap();
    host.ensure_chat_model(&path).unwrap();
    let model = host.chat_model().unwrap();
    let ends: Vec<_> = (0..model.n_vocab())
        .map(LlamaToken::new)
        .filter(|token| model.is_eog_token(*token))
        .collect();
    assert!(!ends.is_empty());
    for (text, expected) in [
        (BODY.into(), true),
        (
            BODY.replace(
                "I have not deployed the synthetic adapter.",
                r#"한글\nquoted \"text\""#,
            ),
            true,
        ),
        (
            BODY.replace(
                "\"unknown\",\"verificationId\":null",
                "\"verified_completed\",\"verificationId\":null",
            ),
            false,
        ),
        (
            BODY.replace("\"verificationId\":null", "\"verificationId\":\"V1\""),
            false,
        ),
        (
            BODY.replace("\"speechAct\":\"report\"", "\"speechAct\":\"request\"")
                .replace("\"status\":\"unknown\"", "\"status\":\"requested\""),
            true,
        ),
        (
            BODY.replace("\"speechAct\":\"report\"", "\"speechAct\":\"request\"")
                .replace(
                    "\"status\":\"unknown\"",
                    "\"status\":\"reported_completed\"",
                ),
            false,
        ),
        (BODY.replace("\"quote\":", "\"action\":"), false),
        (BODY.replace("WikiQuotedClaimsQaV1", "WikiClaimsV1"), false),
        (BODY[..BODY.len() - 2].into(), false),
        (
            r#"{"version":"WikiQuotedClaimsQaV1","outcome":"insufficient_evidence","claims":[]}"#
                .into(),
            true,
        ),
    ] {
        assert_mask(model, &ends, &text, expected);
    }
}
