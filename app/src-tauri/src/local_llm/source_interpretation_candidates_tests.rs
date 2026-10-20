//! Controlled candidate decoder/budget checks do not grade source meaning.

use super::*;
use crate::retrieval::Scope;
use crate::vault_session::AgentVaultSession;
use crate::wiki_claims::source_interpretation_qa::{
    prepare_candidate, CandidateQa, PreparedCandidateQa,
};
use crate::wiki_claims::{ActorRole, SourceDocument, SourceSet, SpanInput};
use generation_telemetry::{AttemptTerminal, GenerationPhase, TelemetrySchema};
use llama_cpp_2::token::{data::LlamaTokenData, data_array::LlamaTokenDataArray, LlamaToken};

const ORIGINAL: &str = "I plan to draft the synthetic report; no completion is recorded.";
const CANDIDATES: [CandidateQa; 2] = [CandidateQa::FacetsV2, CandidateQa::OrdinalV3];

fn origin() -> AgentVaultSession {
    AgentVaultSession {
        vault_path: "/synthetic/interpretation-candidate-qa".into(),
        opening_token: "candidate-opening".into(),
    }
}

fn prepared(variant: CandidateQa, units: usize, text: &str) -> PreparedCandidateQa {
    let documents = (0..units)
        .map(|ordinal| {
            let path = format!("sessions/candidate-{ordinal}.md");
            SourceDocument::bind(
                format!("S{ordinal}"),
                path.clone(),
                path,
                text,
                None,
                vec![SpanInput {
                    id: format!("Q{ordinal}"),
                    start: 0,
                    end: text.len(),
                    turn_id: format!("T{ordinal}"),
                    speaker: ActorRole::Assistant,
                    turn_time: None,
                }],
            )
            .unwrap()
        })
        .collect();
    let sources = SourceSet::new(origin(), Scope::Sessions, documents, vec![]).unwrap();
    prepare_candidate(&sources, &origin(), Scope::Sessions, variant).unwrap()
}

fn schema(input: &PreparedCandidateQa) -> GenerationSchema {
    GenerationSchema::NativeSourceInterpretationCandidateQa(input.count())
}

fn expected_telemetry(variant: CandidateQa) -> TelemetrySchema {
    match variant {
        CandidateQa::FacetsV2 => TelemetrySchema::NativeSourceInterpretationFacetsQaV2,
        CandidateQa::OrdinalV3 => TelemetrySchema::NativeSourceInterpretationOrdinalQaV3,
    }
}

#[test]
fn interpretation_candidates_separate_schema_hashes_and_telemetry_without_changing_limits() {
    let mut hashes = Vec::new();
    for variant in CANDIDATES {
        for count in [1, 2, 16] {
            let input = prepared(variant, count, ORIGINAL);
            let selected = schema(&input);
            assert_eq!(input.count().units(), count);
            assert_eq!(input.count().variant(), variant);
            assert_eq!(selected.grammar(), input.count().grammar());
            let hash = selected.qa_grammar_sha256();
            assert!(!hashes.contains(&hash));
            hashes.push(hash);
            assert_eq!(
                TelemetrySchema::from(Some(selected)),
                expected_telemetry(variant)
            );
            assert_eq!(schema_output_limit(Some(selected)), 768);
            assert_eq!(GENERATION_SAFETY_TOKENS, 8);
            assert!(validate_generation_budget(3320, 768, 4096, Some(selected)).is_ok());
            assert!(validate_generation_budget(3321, 768, 4096, Some(selected)).is_err());
            assert!(validate_generation_budget(1, 769, 4096, Some(selected)).is_err());
            assert!(validate_generation_budget(1, 768, 8192, Some(selected)).is_err());
            assert_eq!(selected.claim_review_decisions(), None);
        }
    }
}

#[test]
fn interpretation_candidate_cancellation_and_invalid_limits_precede_model_access() {
    let host = LocalLlm::load_embed_host().unwrap();
    for variant in CANDIDATES {
        let input = prepared(variant, 1, ORIGINAL);
        for (cancelled, output, context, terminal, phase) in [
            (
                true,
                769,
                8192,
                AttemptTerminal::Cancelled,
                GenerationPhase::Admission,
            ),
            (
                false,
                769,
                4096,
                AttemptTerminal::Failed,
                GenerationPhase::Budget,
            ),
            (
                false,
                0,
                4096,
                AttemptTerminal::Failed,
                GenerationPhase::Budget,
            ),
            (
                false,
                768,
                8192,
                AttemptTerminal::Failed,
                GenerationPhase::Budget,
            ),
            (
                false,
                768,
                4096,
                AttemptTerminal::Failed,
                GenerationPhase::Template,
            ),
        ] {
            let attempt = host.generate_structured_cancellable_measured(
                input.system(),
                input.user(),
                output,
                context,
                schema(&input),
                &AtomicBool::new(cancelled),
            );
            let observed = attempt.telemetry();
            assert_eq!(observed.schema, expected_telemetry(variant));
            assert_eq!(observed.profile, SamplerProfile::ExistingGroundedV1);
            assert_eq!(observed.terminal, terminal);
            assert_eq!(observed.terminal_phase, phase);
            assert_eq!(observed.prefill_completed_tokens, None);
            assert_eq!(observed.sampled_tokens, None);
            assert_eq!(observed.decoded_output_tokens, None);
            assert!(attempt.into_result().is_err());
            assert!(!host.chat_model_loaded());
        }
    }
}

fn interpretation(variant: CandidateQa, focus: &str, id: &str) -> String {
    let assertion = match variant {
        CandidateQa::FacetsV2 => r#""assertionKinds":["intention","record_or_verification_limit"]"#,
        CandidateQa::OrdinalV3 => r#""assertionKind":"intention""#,
    };
    format!(
        r#"{{"focusQuote":{focus},"supportSpanIds":["{id}"],"actor":{{"role":"assistant","basis":"speaker","subjectSpanId":null}},"eventTime":{{"value":null,"basis":"unknown","precision":"unknown","uncertainty":"unknown","supportSpanId":null}},"speechAct":"plan","status":"planned",{assertion},"verificationId":null}}"#
    )
}

fn relevant(variant: CandidateQa, ordinal: usize, focus: &str) -> String {
    let ordinal_field = match variant {
        CandidateQa::FacetsV2 => String::new(),
        CandidateQa::OrdinalV3 => format!(r#""unitOrdinal":{ordinal},"#),
    };
    format!(
        r#"{{{ordinal_field}"relevance":"relevant","interpretations":[{}]}}"#,
        interpretation(variant, focus, &format!("Q{ordinal}"))
    )
}

fn irrelevant(variant: CandidateQa, ordinal: usize) -> String {
    let ordinal_field = match variant {
        CandidateQa::FacetsV2 => String::new(),
        CandidateQa::OrdinalV3 => format!(r#""unitOrdinal":{ordinal},"#),
    };
    format!(r#"{{{ordinal_field}"relevance":"not_relevant","interpretations":[]}}"#)
}

fn document(variant: CandidateQa, rows: &[String]) -> String {
    format!(
        r#"{{"version":"{}","units":[{}]}}"#,
        variant.output_version(),
        rows.join(",")
    )
}

#[test]
fn interpretation_candidate_incremental_guards_preserve_original_dialogue_and_repetition() {
    let focus =
        serde_json::to_string("draft Q0; draft Q0; draft Q0.\nUser:\nAssistant:\n질문:").unwrap();
    for variant in CANDIDATES {
        let input = prepared(variant, 1, ORIGINAL);
        let raw = document(variant, &[relevant(variant, 0, &focus)]);
        let mut observed = String::new();
        for scalar in raw.chars() {
            observed.push(scalar);
            assert_eq!(
                output_guard::apply_with_reason(&mut observed, Some(schema(&input))),
                None
            );
        }
        assert_eq!(observed.as_bytes(), raw.as_bytes());
    }
}

fn assert_mask(model: &LlamaModel, ends: &[LlamaToken], grammar: &str, text: &str, expected: bool) {
    let mut sampler = LlamaSampler::grammar(model, grammar, "root").unwrap();
    for token in model.str_to_token(text, AddBos::Never).unwrap() {
        let mut choices =
            LlamaTokenDataArray::new(vec![LlamaTokenData::new(token, 0.0, 0.0)], false);
        sampler.apply(&mut choices);
        if !choices.data[0].logit().is_finite() {
            assert!(!expected, "unexpected grammar rejection: {text}");
            return;
        }
        sampler.accept(token);
    }
    for end in ends {
        let mut choices =
            LlamaTokenDataArray::new(vec![LlamaTokenData::new(*end, 0.0, 0.0)], false);
        sampler.apply(&mut choices);
        assert_eq!(
            choices.data[0].logit().is_finite(),
            expected,
            "EOG admission: {text}"
        );
    }
}

#[test]
#[ignore = "requires verified MYCO_CHAT_MODEL_PATH; cached vocabulary only, no forward inference"]
fn interpretation_candidate_vocabulary_enforces_separate_fields_and_fixed_ordinals() {
    let path =
        PathBuf::from(std::env::var_os("MYCO_CHAT_MODEL_PATH").expect("verified cached model"));
    let mut host = LocalLlm::load_embed_host().unwrap();
    host.ensure_chat_model(&path).unwrap();
    let model = host.chat_model().unwrap();
    let ends: Vec<_> = (0..model.n_vocab())
        .map(LlamaToken::new)
        .filter(|t| model.is_eog_token(*t))
        .collect();
    assert!(!ends.is_empty());
    for variant in CANDIDATES {
        for count in [1, 2, 16] {
            let input = prepared(variant, count, ORIGINAL);
            let grammar = input.count().grammar();
            assert!(grounded_sampler(model, schema(&input)).is_ok());
            let rows: Vec<_> = (0..count).map(|n| irrelevant(variant, n)).collect();
            assert_mask(model, &ends, &grammar, &document(variant, &rows), true);
            assert_mask(
                model,
                &ends,
                &grammar,
                &document(variant, &rows[..count - 1]),
                false,
            );
            let mut extra = rows.clone();
            extra.push(irrelevant(variant, count));
            assert_mask(model, &ends, &grammar, &document(variant, &extra), false);
            if variant == CandidateQa::OrdinalV3 {
                for ordinal in 0..count {
                    let mut altered = rows.clone();
                    altered[ordinal] = irrelevant(variant, (ordinal + 1) % (count + 1));
                    assert_mask(model, &ends, &grammar, &document(variant, &altered), false);
                }
            }
        }
        let input = prepared(variant, 1, ORIGINAL);
        let grammar = input.count().grammar();
        let body = document(
            variant,
            &[relevant(
                variant,
                0,
                &serde_json::to_string(ORIGINAL).unwrap(),
            )],
        );
        assert_mask(model, &ends, &grammar, &body, true);
        assert!(input.validate(&body, &origin(), Scope::Sessions).is_ok());
        let common_bad = [
            body.replace(variant.output_version(), "NativeSourceInterpretationQaV1"),
            body.replace("\"focusQuote\":", "\"action\":"),
            body.replace("\"verificationId\":null", "\"verificationId\":\"V1\""),
            body.replace(
                "\"status\":\"planned\"",
                "\"status\":\"reported_completed\"",
            ),
            body.replace("\"supportSpanIds\":[\"Q0\"]", "\"supportSpanIds\":[]"),
            body.replace(
                "\"relevance\":\"relevant\"",
                "\"relevance\":\"not_relevant\"",
            ),
        ];
        for raw in common_bad {
            assert_mask(model, &ends, &grammar, &raw, false);
        }
        match variant {
            CandidateQa::FacetsV2 => {
                for fields in [
                    r#""assertionKinds":[]"#,
                    r#""assertionKinds":["unknown_kind"]"#,
                    r#""assertionKind":"intention""#,
                ] {
                    let raw = body.replace(
                        r#""assertionKinds":["intention","record_or_verification_limit"]"#,
                        fields,
                    );
                    assert_mask(model, &ends, &grammar, &raw, false);
                }
                let duplicate = body.replace("\"record_or_verification_limit\"", "\"intention\"");
                assert_mask(model, &ends, &grammar, &duplicate, true);
                assert!(input
                    .validate(&duplicate, &origin(), Scope::Sessions)
                    .is_err());
                let ordinal = body.replace("\"relevance\":", "\"unitOrdinal\":0,\"relevance\":");
                assert_mask(model, &ends, &grammar, &ordinal, false);
            }
            CandidateQa::OrdinalV3 => {
                for ordinal in ["1", "-1", "null", "\"0\""] {
                    assert_mask(
                        model,
                        &ends,
                        &grammar,
                        &body.replace("\"unitOrdinal\":0", &format!("\"unitOrdinal\":{ordinal}")),
                        false,
                    );
                }
                assert_mask(
                    model,
                    &ends,
                    &grammar,
                    &body.replace("\"unitOrdinal\":0,", ""),
                    false,
                );
                let facets = body.replace(
                    "\"assertionKind\":\"intention\"",
                    r#""assertionKinds":["intention"]"#,
                );
                assert_mask(model, &ends, &grammar, &facets, false);
            }
        }
        for supports in [r#"["Q9"]"#, r#"["Q0","Q0"]"#] {
            let raw = body.replace(r#"["Q0"]"#, supports);
            assert_mask(model, &ends, &grammar, &raw, true);
            assert!(input.validate(&raw, &origin(), Scope::Sessions).is_err());
        }
        let prompt_tokens = host.chat_token_count(input.system(), input.user()).unwrap();
        assert!(validate_generation_budget(prompt_tokens, 768, 4096, Some(schema(&input))).is_ok());
        for literal in [
            r#""A\u0000B\nC\tD""#,
            r#""한글😀é \"인용\" \\ \uD83D\uDE00""#,
            r#""A\u2028\u2029B""#,
        ] {
            let text: String = serde_json::from_str(literal).unwrap();
            let input = prepared(variant, 1, &text);
            let raw = document(variant, &[relevant(variant, 0, literal)]);
            assert_mask(model, &ends, &grammar, &raw, true);
            assert!(input.validate(&raw, &origin(), Scope::Sessions).is_ok());
        }
        for literal in [r#""\uD800""#, r#""\uDC00""#, r#""\uD800\u0041""#] {
            assert_mask(
                model,
                &ends,
                &grammar,
                &document(variant, &[relevant(variant, 0, literal)]),
                false,
            );
        }
        for count in [1, 64, 65, 2048, 2049] {
            let text = "가😀".chars().cycle().take(count).collect::<String>();
            let literal = serde_json::to_string(&text).unwrap();
            let input = prepared(variant, 1, &text);
            let raw = document(variant, &[relevant(variant, 0, &literal)]);
            assert_mask(model, &ends, &grammar, &raw, count <= 2048);
            assert_eq!(
                input.validate(&raw, &origin(), Scope::Sessions).is_ok(),
                count <= 2048
            );
        }
    }
}
