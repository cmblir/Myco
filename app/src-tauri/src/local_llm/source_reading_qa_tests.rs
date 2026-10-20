use super::*;
use generation_telemetry::{AttemptTerminal, LoopStop, TelemetrySchema};
use llama_cpp_2::token::{data::LlamaTokenData, data_array::LlamaTokenDataArray, LlamaToken};
use serde_json::json;

#[test]
fn prose_reading_entry_keeps_fixed_limits_and_truthful_early_failure_telemetry() {
    let host = LocalLlm::load_embed_host().unwrap();
    for cancelled in [true, false] {
        let attempt = host.generate_source_reading_qa_measured(
            "Synthetic private policy",
            "Synthetic private original",
            &AtomicBool::new(cancelled),
        );
        let telemetry = attempt.telemetry();
        assert_eq!(telemetry.schema, TelemetrySchema::Freeform);
        assert_eq!(
            telemetry.profile,
            SamplerProfile::ExistingGroundedGrammarFreeQaV1
        );
        assert_eq!(telemetry.requested_output_tokens, 768);
        assert_eq!(telemetry.requested_context_tokens, 4096);
        assert_eq!(telemetry.prompt_tokens, None);
        assert_eq!(telemetry.sampled_tokens, None);
        assert_eq!(telemetry.elapsed_micros.context_create, None);
        assert_eq!(telemetry.elapsed_micros.sampler_create, None);
        assert!(telemetry.gemma_thinking_qa.is_none());
        assert_eq!(
            telemetry.terminal,
            if cancelled {
                AttemptTerminal::Cancelled
            } else {
                AttemptTerminal::Failed
            }
        );
        assert_eq!(
            telemetry.error_code,
            if cancelled {
                None
            } else {
                Some(GenerationErrorCode::ModelMissing)
            }
        );
        let serialized = serde_json::to_string(telemetry).unwrap();
        assert!(!serialized.contains("Synthetic private"));
        assert_eq!(
            attempt.into_result().unwrap_err(),
            if cancelled {
                "local generation cancelled"
            } else {
                CHAT_MODEL_MISSING
            }
        );
    }
    assert!(!host.chat_model_loaded());
    assert!(validate_generation_budget(3320, 768, 4096, None).is_ok());
    assert_eq!(
        validate_generation_budget(3321, 768, 4096, None).unwrap_err(),
        "context budget exceeded: prompt has 3321 tokens, limit is 3320"
    );
}

#[test]
fn prose_descriptor_omits_only_grammar_and_keeps_every_existing_numeric_value() {
    let existing = WikiClaimsSamplerQaProfile::ExistingGroundedV1.qa_parameters();
    let baseline = serde_json::to_value(existing).unwrap();
    assert_eq!(
        baseline,
        json!({
            "profile":"existingGroundedV1",
            "order":["grammar","penalties","top_k","top_p","temperature","dist"],
            "penaltyLastN":256,"repeatPenalty":1.0,"frequencyPenalty":0.0,
            "presencePenalty":1.5,"topK":20,"topP":0.8_f32,"minKeep":1,
            "temperature":0.7_f32,"seed":42
        })
    );
    let mut expected = baseline;
    expected["profile"] = json!("existingGroundedGrammarFreeQaV1");
    expected["order"].as_array_mut().unwrap().remove(0);
    assert_eq!(
        serde_json::to_value(LocalLlm::source_reading_qa_sampler_parameters()).unwrap(),
        expected
    );
    assert_eq!(
        Recorder::new(None, 768, 4096).sampler_profile(),
        SamplerProfile::ExistingFreeformV1
    );
}

fn logits(count: i32, value: f32) -> LlamaTokenDataArray {
    LlamaTokenDataArray::from_iter(
        (0..count).map(|id| LlamaTokenData::new(LlamaToken::new(id), value, 0.0)),
        false,
    )
}

// Installed sampler operations over synthetic logits; no model forward inference.
#[test]
fn prose_sampler_uses_the_registered_numeric_operations_without_a_model() {
    let parameters = LocalLlm::source_reading_qa_sampler_parameters();
    let mut candidates = logits(65, 1.0);
    LlamaSampler::top_k(parameters.top_k).apply(&mut candidates);
    assert_eq!(candidates.data.len(), 20);
    let mut candidates = logits(5, 1.0);
    LlamaSampler::top_p(parameters.top_p, parameters.min_keep).apply(&mut candidates);
    assert_eq!(candidates.data.len(), 4);
    let mut sampler = grounded_sampling::thinking_qa_sampler();
    assert_eq!(sampler.get_seed(), parameters.seed);
    sampler.accept(LlamaToken::new(0));
    let mut candidates = logits(2, 10.0);
    sampler.apply(&mut candidates);
    assert_eq!(candidates.data.len(), 1);
    assert_eq!(candidates.data[0].id(), LlamaToken::new(1));
    assert!((candidates.data[0].logit() - 10.0 / parameters.temperature).abs() < 1e-6);
}

#[test]
fn general_structured_sampler_rejects_the_prose_profile() {
    assert_eq!(
        grounded_sampling::structured_parameters(SamplerProfile::ExistingGroundedGrammarFreeQaV1,)
            .unwrap_err(),
        "structured sampler rejects grammar-free QA profile"
    );
    assert_eq!(
        grounded_sampling::structured_parameters(SamplerProfile::ExistingFreeformV1,).unwrap_err(),
        "grounded sampler requires a grounded profile"
    );
    for profile in [
        WikiClaimsSamplerQaProfile::ExistingGroundedV1,
        WikiClaimsSamplerQaProfile::ExistingGroundedNoPresenceQaV1,
        WikiClaimsSamplerQaProfile::GemmaInstructionFamilyQaV1,
    ] {
        let expected = profile.qa_parameters();
        assert_eq!(
            grounded_sampling::structured_parameters(expected.profile).unwrap(),
            expected
        );
    }
}

fn guarded_prefixes(
    text: &str,
    decode: Option<StructuredDecode<'_>>,
) -> (String, Option<LoopStop>) {
    let mut output = String::new();
    for character in text.chars() {
        output.push(character);
        if let Some(reason) = apply_generation_output_guard(&mut output, decode) {
            return (output, Some(reason));
        }
    }
    (output, None)
}

#[test]
fn prose_preserves_dialogue_and_repetition_while_existing_guards_keep_their_cutoffs() {
    let prose = Some(StructuredDecode::GroundedProseReadingQa);
    assert!(StructuredDecode::GroundedProseReadingQa.schema().is_none());
    for marker in ["\nUser:", "\nAssistant:", "\nQ:", "\n질문:"] {
        let text = format!("한국어🙂 evidence.{marker} quoted source text");
        assert_eq!(guarded_prefixes(&text, prose), (text.clone(), None));
        assert_eq!(
            guarded_prefixes(&text, None),
            (
                "한국어🙂 evidence.".into(),
                Some(LoopStop::LegacyDialogueMarker),
            )
        );
        let schema = GenerationSchema::WikiClaimsV1;
        assert_eq!(
            guarded_prefixes(&text, Some(StructuredDecode::Product(&schema))),
            (text, None)
        );
    }
    let prefix = "A synthetic record distinguishes a request from execution; a later record is not independent implementation verification. ";
    let sentence = "repeat synthetic phrase.";
    let text = format!("{prefix}{}", sentence.repeat(6));
    assert_eq!(guarded_prefixes(&text, prose), (text.clone(), None));
    assert_eq!(
        guarded_prefixes(&text, None),
        (
            format!("{prefix}{sentence}"),
            Some(LoopStop::LegacyRepetition),
        )
    );
    let schema = GenerationSchema::AskAnswerV1;
    assert_eq!(StructuredDecode::Product(&schema).schema(), Some(schema));
    assert_eq!(
        guarded_prefixes(&text, Some(StructuredDecode::Product(&schema))),
        (text, None)
    );
    assert_eq!(
        StructuredDecode::GemmaBoundedThinkingQa.schema(),
        Some(schema)
    );
}
