//! Decoder syntax and admission checks, not source meaning or publication authority.

use super::*;
use crate::retrieval::Scope;
use crate::vault_session::AgentVaultSession;
use crate::wiki_claims::source_interpretation_qa::{self, PreparedQa};
use crate::wiki_claims::{ActorRole, SourceDocument, SourceSet, SpanInput};
use generation_telemetry::{AttemptTerminal, GenerationPhase, TelemetrySchema};
use llama_cpp_2::token::{data::LlamaTokenData, data_array::LlamaTokenDataArray, LlamaToken};

const ORIGINAL: &str = "I plan to draft the synthetic report; no completion is recorded.";

fn origin() -> AgentVaultSession {
    AgentVaultSession {
        vault_path: "/synthetic/source-interpretation-qa".into(),
        opening_token: "source-interpretation-qa-opening".into(),
    }
}

fn prepared(units: usize) -> PreparedQa {
    prepared_with_text(units, ORIGINAL)
}

fn prepared_with_text(units: usize, text: &str) -> PreparedQa {
    let documents = (1..=units)
        .map(|ordinal| {
            let path = format!("sessions/interpretation-{ordinal}.md");
            SourceDocument::bind(
                format!("S{ordinal}"),
                path.clone(),
                path,
                text,
                Some("2026-10-01T00:00:00Z".into()),
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
    source_interpretation_qa::prepare(&sources, &origin(), Scope::Sessions).unwrap()
}

fn schema(prepared: &PreparedQa) -> GenerationSchema {
    GenerationSchema::NativeSourceInterpretationQaV1(prepared.count())
}

#[test]
fn source_interpretation_schema_hash_binds_the_actual_exact_unit_count() {
    let existing = [
        GenerationSchema::WikiClaimsV1,
        GenerationSchema::WikiQuotedClaimsQaV1,
        GenerationSchema::SessionStructureV1,
        GenerationSchema::SessionReviewV1,
    ];
    let mut hashes = Vec::new();
    for units in [1, 2, 16] {
        let input = prepared(units);
        let selected = schema(&input);
        assert_eq!(input.count().units(), units);
        assert_eq!(selected.grammar(), input.count().grammar());
        let expected = crate::importers::wikify::source_revision(selected.grammar().as_ref());
        let observed = selected.qa_grammar_sha256();
        assert_eq!(observed, expected);
        for other in existing {
            assert_ne!(observed, other.qa_grammar_sha256());
        }
        assert!(!hashes.contains(&observed));
        hashes.push(observed);
        assert_eq!(selected.claim_review_decisions(), None);
    }
}

#[test]
fn source_interpretation_keeps_768_output_and_the_exact_eight_token_reserve() {
    let input = prepared(1);
    let selected = Some(schema(&input));
    assert_eq!(schema_output_limit(selected), 768);
    assert_eq!(GENERATION_SAFETY_TOKENS, 8);
    assert!(validate_generation_budget(3320, 768, 4096, selected).is_ok());
    assert!(validate_generation_budget(3321, 768, 4096, selected).is_err());
    for context in [2048, 4096] {
        for output in [1, 768] {
            let boundary = context as usize - output as usize - GENERATION_SAFETY_TOKENS;
            assert!(validate_generation_budget(boundary, output, context, selected).is_ok());
            let error =
                validate_generation_budget(boundary + 1, output, context, selected).unwrap_err();
            assert!(error.contains("context budget exceeded"), "{error}");
        }
        assert!(validate_generation_budget(1, 769, context, selected).is_err());
    }
    for (prompt, output, context) in [
        (0, 768, 4096),
        (1, 0, 4096),
        (1, -1, 4096),
        (1, 1536, 4096),
        (1, i32::MAX, 4096),
        (1, 768, 0),
        (1, 768, 4095),
        (1, 768, 8192),
    ] {
        assert!(validate_generation_budget(prompt, output, context, selected).is_err());
    }
}

fn assert_no_sampling(attempt: &GenerationAttempt) {
    let observed = attempt.telemetry();
    assert_eq!(
        observed.schema,
        TelemetrySchema::NativeSourceInterpretationQaV1
    );
    assert_eq!(observed.profile, SamplerProfile::ExistingGroundedV1);
    assert_eq!(observed.prompt_tokens, None);
    assert_eq!(observed.prefill_completed_tokens, None);
    assert_eq!(observed.prefill_completed_batches, None);
    assert_eq!(observed.sampled_tokens, None);
    assert_eq!(observed.sampled_output_tokens, None);
    assert_eq!(observed.decoded_output_tokens, None);
    assert_eq!(observed.loop_stop, None);
    assert_eq!(observed.elapsed_micros.tokenize, None);
    assert_eq!(observed.elapsed_micros.context_create, None);
    assert_eq!(observed.elapsed_micros.prefill, None);
    assert_eq!(observed.elapsed_micros.sampler_create, None);
    assert_eq!(observed.elapsed_micros.sampling_loop, None);
}

#[test]
fn source_interpretation_cancellation_precedes_limits_template_and_model_access() {
    let input = prepared(1);
    let host = LocalLlm::load_embed_host().unwrap();
    let attempt = host.generate_structured_cancellable_measured(
        input.system(),
        input.user(),
        769,
        8192,
        schema(&input),
        &AtomicBool::new(true),
    );
    assert_no_sampling(&attempt);
    assert_eq!(attempt.telemetry().terminal, AttemptTerminal::Cancelled);
    assert_eq!(
        attempt.telemetry().terminal_phase,
        GenerationPhase::Admission
    );
    assert_eq!(attempt.telemetry().error_code, None);
    assert_eq!(attempt.telemetry().elapsed_micros.budget, None);
    assert_eq!(attempt.telemetry().elapsed_micros.template, None);
    assert_eq!(
        attempt.into_result().unwrap_err(),
        "local generation cancelled"
    );
    assert!(!host.chat_model_loaded());
}

#[test]
fn source_interpretation_invalid_limits_fail_before_template_without_loading_weights() {
    let input = prepared(1);
    let host = LocalLlm::load_embed_host().unwrap();
    for (output, context) in [(769, 4096), (0, 4096), (768, 8192)] {
        let attempt = host.generate_structured_cancellable_measured(
            input.system(),
            input.user(),
            output,
            context,
            schema(&input),
            &AtomicBool::new(false),
        );
        assert_no_sampling(&attempt);
        assert_eq!(attempt.telemetry().requested_output_tokens, output);
        assert_eq!(attempt.telemetry().requested_context_tokens, context);
        assert_eq!(attempt.telemetry().terminal, AttemptTerminal::Failed);
        assert_eq!(attempt.telemetry().terminal_phase, GenerationPhase::Budget);
        assert_eq!(
            attempt.telemetry().error_code,
            Some(GenerationErrorCode::InvalidLimits)
        );
        assert_eq!(attempt.telemetry().elapsed_micros.template, None);
        assert_eq!(
            attempt.into_result().unwrap_err(),
            "invalid generation limits"
        );
        assert!(!host.chat_model_loaded());
    }
}

#[test]
fn source_interpretation_missing_model_records_its_schema_without_substitution() {
    let input = prepared(1);
    let host = LocalLlm::load_embed_host().unwrap();
    let attempt = host.generate_structured_cancellable_measured(
        input.system(),
        input.user(),
        768,
        4096,
        schema(&input),
        &AtomicBool::new(false),
    );
    assert_no_sampling(&attempt);
    assert_eq!(attempt.telemetry().requested_output_tokens, 768);
    assert_eq!(attempt.telemetry().requested_context_tokens, 4096);
    assert_eq!(attempt.telemetry().terminal, AttemptTerminal::Failed);
    assert_eq!(
        attempt.telemetry().terminal_phase,
        GenerationPhase::Template
    );
    assert_eq!(
        attempt.telemetry().error_code,
        Some(GenerationErrorCode::ModelMissing)
    );
    assert_eq!(
        serde_json::to_value(attempt.telemetry().schema).unwrap(),
        serde_json::json!("nativeSourceInterpretationQaV1")
    );
    assert!(attempt
        .into_result()
        .unwrap_err()
        .starts_with(CHAT_MODEL_MISSING));
    assert!(!host.chat_model_loaded());
}

fn interpretation_literal(focus: &str) -> String {
    format!(
        r#"{{"focusQuote":{focus},"supportSpanIds":["Q1"],"actor":{{"role":"unknown","basis":"unknown","subjectSpanId":null}},"eventTime":{{"value":null,"basis":"unknown","precision":"unknown","uncertainty":"unknown","supportSpanId":null}},"speechAct":"report","status":"unknown","assertionKind":"record_or_verification_limit","verificationId":null}}"#
    )
}

fn relevant_literal(focus: &str) -> String {
    format!(
        r#"{{"relevance":"relevant","interpretations":[{}]}}"#,
        interpretation_literal(focus)
    )
}

fn document(units: &[String]) -> String {
    format!(
        r#"{{"version":"NativeSourceInterpretationQaV1","units":[{}]}}"#,
        units.join(",")
    )
}

fn focus_document(focus: &str) -> String {
    document(&[relevant_literal(focus)])
}

#[test]
fn source_interpretation_separator_only_focus_is_blank_but_wrapped_original_is_valid() {
    for literal in [r#""\u2028\u2029""#, r#""A\u2028\u2029B""#] {
        let decoded: String = serde_json::from_str(literal).unwrap();
        let input = prepared_with_text(1, &decoded);
        let result = input.validate(&focus_document(literal), &origin(), Scope::Sessions);
        if decoded.trim().is_empty() {
            assert!(result
                .unwrap_err()
                .contains("focus or support bounds are invalid"));
        } else {
            assert!(result.is_ok(), "literal {literal:?}: {result:?}");
        }
    }
}

#[test]
fn source_interpretation_incremental_guard_preserves_repeated_fields_and_legacy_markers() {
    let input = prepared(1);
    let focus =
        "Q1 reported draft; Q1 reported draft; Q1 reported draft.\nUser:\nAssistant:\nQ:\n질문:";
    let serialized = focus_document(&serde_json::to_string(focus).unwrap());
    // The second input isolates the text guard even on a malformed decoder prefix.
    // Syntax, source binding and meaning remain separate admission boundaries.
    for original in [
        serialized.clone(),
        format!("{serialized}\nUser:\nAssistant:\nQ:\n질문:"),
    ] {
        let mut assembled = String::new();
        for scalar in original.chars() {
            assembled.push(scalar);
            assert_eq!(
                output_guard::apply_with_reason(&mut assembled, Some(schema(&input))),
                None
            );
        }
        assert_eq!(assembled.as_bytes(), original.as_bytes());
    }
}

fn permits(sampler: &mut LlamaSampler, token: LlamaToken) -> bool {
    let mut choices = LlamaTokenDataArray::new(vec![LlamaTokenData::new(token, 0.0, 0.0)], false);
    sampler.apply(&mut choices);
    choices.data[0].logit().is_finite()
}

fn assert_mask(model: &LlamaModel, ends: &[LlamaToken], grammar: &str, text: &str, expected: bool) {
    let mut sampler = LlamaSampler::grammar(model, grammar, "root").unwrap();
    for token in model.str_to_token(text, AddBos::Never).unwrap() {
        if !permits(&mut sampler, token) {
            assert!(!expected, "unexpected grammar rejection: {text}");
            return;
        }
        sampler.accept(token);
    }
    for end in ends {
        assert_eq!(
            permits(&mut sampler, *end),
            expected,
            "EOG admission: {text}"
        );
    }
}

fn vocabulary_host() -> LocalLlm {
    let path = PathBuf::from(
        std::env::var_os("MYCO_CHAT_MODEL_PATH").expect("MYCO_CHAT_MODEL_PATH is required"),
    );
    let mut host = LocalLlm::load_embed_host().unwrap();
    host.ensure_chat_model(&path).unwrap();
    host
}

fn eog_tokens(model: &LlamaModel) -> Vec<LlamaToken> {
    let ends = (0..model.n_vocab())
        .map(LlamaToken::new)
        .filter(|token| model.is_eog_token(*token))
        .collect::<Vec<_>>();
    assert!(!ends.is_empty());
    ends
}

#[test]
#[ignore = "requires a verified GGUF via MYCO_CHAT_MODEL_PATH; vocabulary masking only, no inference"]
fn source_interpretation_vocabulary_masks_exact_units_and_closed_proposal_fields() {
    let host = vocabulary_host();
    let model = host.chat_model().unwrap();
    let ends = eog_tokens(model);
    let irrelevant = r#"{"relevance":"not_relevant","interpretations":[]}"#.to_owned();
    let uncertain = r#"{"relevance":"uncertain","interpretations":[]}"#.to_owned();
    for units in [1, 2, 16] {
        let input = prepared(units);
        let grammar = schema(&input).grammar();
        assert!(grounded_sampler(model, schema(&input)).is_ok());
        let rows = vec![irrelevant.clone(); units];
        assert_mask(model, &ends, &grammar, &document(&rows), true);
        assert_mask(model, &ends, &grammar, &document(&rows[..units - 1]), false);
        assert_mask(
            model,
            &ends,
            &grammar,
            &document(&vec![irrelevant.clone(); units + 1]),
            false,
        );
    }
    let input = prepared(1);
    let grammar = schema(&input).grammar();
    let focus = serde_json::to_string("no completion is recorded").unwrap();
    let body = focus_document(&focus);
    assert!(input.validate(&body, &origin(), Scope::Sessions).is_ok());
    for (output, expected) in [
        (body.clone(), true),
        (document(std::slice::from_ref(&irrelevant)), true),
        (document(&[uncertain]), true),
        (
            body.replace("NativeSourceInterpretationQaV1", "WikiQuotedClaimsQaV1"),
            false,
        ),
        (body.replace("\"focusQuote\":", "\"action\":"), false),
        (
            body.replace("\"relevance\":\"relevant\"", "\"relevance\":\"uncertain\""),
            false,
        ),
        (
            body.replace(
                "\"relevance\":\"relevant\"",
                "\"relevance\":\"not_relevant\"",
            ),
            false,
        ),
        (
            document(&[r#"{"relevance":"relevant","interpretations":[]}"#.into()]),
            false,
        ),
        (
            body.replace("\"supportSpanIds\":[\"Q1\"]", "\"supportSpanIds\":[]"),
            false,
        ),
        (body.replace("\"Q1\"", "\"unsafe ID\""), false),
        (body.replace("\"Q1\"", "\"\""), false),
        (
            body.replace("\"Q1\"", &serde_json::to_string(&"Q".repeat(65)).unwrap()),
            false,
        ),
        (
            body.replace(r#"["Q1"]"#, &format!("[{}]", ["\"Q1\""; 9].join(","))),
            false,
        ),
        (
            body.replace(
                "\"status\":\"unknown\"",
                "\"status\":\"verified_completed\"",
            ),
            false,
        ),
        (
            body.replace("\"verificationId\":null", "\"verificationId\":\"V1\""),
            false,
        ),
        (body.replace(",\"verificationId\":null", ""), false),
        (body.replace(",\"subjectSpanId\":null", ""), false),
        (body.replace(",\"supportSpanId\":null", ""), false),
        (
            body.replace("\"value\":null", "\"value\":\"2026-10-01\""),
            false,
        ),
        (
            body.replace("\"precision\":\"unknown\"", "\"precision\":\"day\""),
            false,
        ),
        (
            body.replace(
                "\"basis\":\"unknown\",\"subjectSpanId\":null",
                "\"basis\":\"explicit_subject\",\"subjectSpanId\":null",
            ),
            false,
        ),
        (
            body.replace(
                "\"focusQuote\":",
                "\"sourcePath\":\"sessions/forged.md\",\"focusQuote\":",
            ),
            false,
        ),
        (
            body.replace("\"relevance\":", "\"unitId\":\"Q1\",\"relevance\":"),
            false,
        ),
        (
            body.replace("\"version\":", "\"semanticAccepted\":true,\"version\":"),
            false,
        ),
        (body[..body.len() - 1].to_owned(), false),
    ] {
        assert_mask(model, &ends, &grammar, &output, expected);
    }
    // IDs and unique support membership are binder checks, not grammar receipts.
    for supports in [r#"["Q9"]"#, r#"["Q1","Q1"]"#] {
        let output = body.replace(r#"["Q1"]"#, supports);
        assert_mask(model, &ends, &grammar, &output, true);
        assert!(input.validate(&output, &origin(), Scope::Sessions).is_err());
    }
    let request = body
        .replace("\"speechAct\":\"report\"", "\"speechAct\":\"request\"")
        .replace("\"status\":\"unknown\"", "\"status\":\"requested\"");
    assert_mask(model, &ends, &grammar, &request, true);
    assert_mask(
        model,
        &ends,
        &grammar,
        &request.replace(
            "\"status\":\"requested\"",
            "\"status\":\"reported_completed\"",
        ),
        false,
    );
    let tokens = host.chat_token_count(input.system(), input.user()).unwrap();
    assert!(validate_generation_budget(tokens, 768, 4096, Some(schema(&input))).is_ok());
}

#[test]
#[ignore = "requires a verified GGUF via MYCO_CHAT_MODEL_PATH; vocabulary masking only, no inference"]
fn source_interpretation_vocabulary_preserves_exact_control_quotes_and_scalar_limits() {
    let host = vocabulary_host();
    let model = host.chat_model().unwrap();
    let ends = eog_tokens(model);
    let grammar = schema(&prepared(1)).grammar();
    let accepts_literal = |literal: &str| {
        assert_mask(model, &ends, &grammar, &focus_document(literal), true);
        let decoded: String = serde_json::from_str(literal).unwrap();
        let input = prepared_with_text(1, &decoded);
        input
            .validate(&focus_document(literal), &origin(), Scope::Sessions)
            .unwrap_or_else(|error| panic!("literal {literal:?}: {error}"));
    };

    // Quoted originals may contain decoded controls; exact source binding still
    // decides whether they exist. Raw C0 is invalid JSON, even inside a quote.
    for code in (0x00_u32..=0x1f).chain(0x7f..=0x9f) {
        for escaped in [
            format!(r#""A\u{code:04x}B""#),
            format!(r#""A\u{code:04X}B""#),
        ] {
            accepts_literal(&escaped);
        }
        let scalar = char::from_u32(code).unwrap();
        if code >= 0x7f {
            accepts_literal(&format!("\"A{scalar}B\""));
        } else if code != 0 {
            let raw = format!("\"A{scalar}B\"");
            assert!(serde_json::from_str::<String>(&raw).is_err());
            assert_mask(model, &ends, &grammar, &focus_document(&raw), false);
        }
    }
    // The tokenizer's CString interface cannot observe raw NUL here. Escaped
    // NUL is covered above; no raw-NUL vocabulary observation is claimed.

    for literal in [
        r#""A\bB\fC\nD\rE\tF""#,
        r#""한국어 \"인용\" \\ 경로 \/ 자료""#,
        r#""한글😀é Ω""#,
        r#""\uAC00\u03A9\u4E2D""#,
        r#""\uD83D\uDE00""#,
        r#""\ud800\udc00""#,
        r#""\uDBFF\uDFFF""#,
        r#""A\u2028\u2029B""#,
    ] {
        accepts_literal(literal);
    }
    for literal in [
        r#""\uD800""#,
        r#""\uDC00""#,
        r#""\uD800\uD800""#,
        r#""\uDC00\uD800""#,
        r#""\uD800\u0041""#,
        r#""\u0041\uDC00""#,
        r#""\uD83D\uDE00\uD800""#,
        r#""\uD83D\uDE00\uDC00""#,
    ] {
        assert!(serde_json::from_str::<String>(literal).is_err());
        assert_mask(model, &ends, &grammar, &focus_document(literal), false);
    }
    // A surrogate pair and every JSON escape count as one decoded scalar,
    // not as JSON bytes or UTF-16 code units. This is not an inference fit test.
    for unit in [
        "A",
        "가",
        "😀",
        r#"\""#,
        r"\\",
        r"\/",
        r"\uAC00",
        r"\uD83D\uDE00",
    ] {
        for count in [1, 63, 64, 65, 1983, 1984, 1985, 2047, 2048, 2049] {
            let literal = format!("\"{}\"", unit.repeat(count));
            let decoded: String = serde_json::from_str(&literal).unwrap();
            assert_eq!(decoded.chars().count(), count);
            assert_mask(
                model,
                &ends,
                &grammar,
                &focus_document(&literal),
                count <= 2048,
            );
            let input = prepared_with_text(1, &decoded);
            assert_eq!(
                input
                    .validate(&focus_document(&literal), &origin(), Scope::Sessions)
                    .is_ok(),
                count <= 2048,
            );
        }
    }
    assert_mask(model, &ends, &grammar, &focus_document(r#""""#), false);
    assert_mask(
        model,
        &ends,
        &grammar,
        &focus_document(r#""\u2028\u2029""#),
        true,
    );
    assert!(prepared_with_text(1, "\u{2028}\u{2029}")
        .validate(
            &focus_document(r#""\u2028\u2029""#),
            &origin(),
            Scope::Sessions,
        )
        .unwrap_err()
        .contains("focus or support bounds are invalid"));
    assert_mask(model, &ends, &grammar, &focus_document(r#"" ""#), true);
    assert!(prepared_with_text(1, " ")
        .validate(&focus_document(r#"" ""#), &origin(), Scope::Sessions)
        .is_err());
}
