//! Exact-input admission and vocabulary controls, not model-meaning acceptance.

use super::*;
use crate::local_llm::generation_telemetry::{AttemptTerminal, GenerationPhase, TelemetrySchema};
use crate::session_compile::review_decode::tests::{fixture_contract, output};
use llama_cpp_2::token::{data::LlamaTokenData, data_array::LlamaTokenDataArray, LlamaToken};

fn assert_no_generation(attempt: &GenerationAttempt) {
    let observed = attempt.telemetry();
    assert_eq!(observed.schema, TelemetrySchema::SessionReviewV1);
    assert_eq!(observed.profile, SamplerProfile::ExistingGroundedV1);
    assert_eq!(observed.prompt_tokens, None);
    assert_eq!(observed.prefill_completed_tokens, None);
    assert_eq!(observed.prefill_completed_batches, None);
    assert_eq!(observed.sampled_tokens, None);
    assert_eq!(observed.sampled_output_tokens, None);
    assert_eq!(observed.decoded_output_tokens, None);
    assert_eq!(observed.elapsed_micros.template, None);
    assert_eq!(observed.elapsed_micros.context_create, None);
    assert_eq!(observed.elapsed_micros.prefill, None);
    assert_eq!(observed.elapsed_micros.sampler_create, None);
    assert_eq!(observed.elapsed_micros.sampling_loop, None);
}

#[test]
fn product_session_review_stop_precedes_contract_limits_and_model_access() {
    let host = LocalLlm::load_embed_host().unwrap();
    let contract = fixture_contract(1, 1);
    let cancelled = AtomicBool::new(true);
    let attempt = host.generate_session_review_cancellable_measured(
        "stale", "stale", 0, 8192, &contract, &cancelled,
    );
    assert_no_generation(&attempt);
    assert_eq!(attempt.telemetry().terminal, AttemptTerminal::Cancelled);
    assert_eq!(
        attempt.telemetry().terminal_phase,
        GenerationPhase::Admission
    );
    assert_eq!(attempt.telemetry().error_code, None);
    assert_eq!(attempt.telemetry().elapsed_micros.budget, None);
    assert_eq!(
        attempt.into_result().unwrap_err(),
        "local generation cancelled"
    );
    assert!(!host.chat_model_loaded());
}

#[test]
fn product_session_review_exact_input_denial_precedes_limits_template_and_sampling() {
    let host = LocalLlm::load_embed_host().unwrap();
    let contract = fixture_contract(1, 1);
    let other = fixture_contract(0, 0);
    let active = AtomicBool::new(false);
    for (system, user) in [
        (
            contract.system().to_owned(),
            format!("{} ", contract.user()),
        ),
        (
            format!("{} ", contract.system()),
            contract.user().to_owned(),
        ),
        (String::new(), contract.user().to_owned()),
        (contract.system().to_owned(), String::new()),
        (contract.user().to_owned(), contract.system().to_owned()),
        (other.system().to_owned(), other.user().to_owned()),
    ] {
        for (output, context) in [(768, 4096), (0, 8192)] {
            let attempt = host.generate_session_review_cancellable_measured(
                &system, &user, output, context, &contract, &active,
            );
            assert_no_generation(&attempt);
            assert_eq!(attempt.telemetry().terminal, AttemptTerminal::Failed);
            assert_eq!(
                attempt.telemetry().terminal_phase,
                GenerationPhase::Admission
            );
            assert_eq!(
                attempt.telemetry().error_code,
                Some(GenerationErrorCode::InvalidSessionReviewContract)
            );
            assert_eq!(attempt.telemetry().elapsed_micros.budget, None);
            let measured = attempt.into_result();
            assert_eq!(
                measured,
                host.generate_session_review_cancellable(
                    &system, &user, output, context, &contract, &active,
                )
            );
            assert_eq!(
                measured.unwrap_err(),
                "session-review contract does not match exact input"
            );
            assert!(!host.chat_model_loaded());
        }
    }
}

#[test]
fn product_session_review_preserves_limits_and_does_not_load_missing_weights() {
    let host = LocalLlm::load_embed_host().unwrap();
    let contract = fixture_contract(1, 1);
    let active = AtomicBool::new(false);
    for (output, context) in [(0, 4096), (769, 4096), (768, 8192)] {
        let attempt = host.generate_session_review_cancellable_measured(
            contract.system(),
            contract.user(),
            output,
            context,
            &contract,
            &active,
        );
        assert_no_generation(&attempt);
        assert_eq!(attempt.telemetry().terminal_phase, GenerationPhase::Budget);
        assert_eq!(
            attempt.telemetry().error_code,
            Some(GenerationErrorCode::InvalidLimits)
        );
        assert_eq!(
            attempt.into_result().unwrap_err(),
            "invalid generation limits"
        );
    }
    let missing = host.generate_session_review_cancellable_measured(
        contract.system(),
        contract.user(),
        768,
        4096,
        &contract,
        &active,
    );
    assert_eq!(missing.telemetry().schema, TelemetrySchema::SessionReviewV1);
    assert_eq!(
        missing.telemetry().profile,
        SamplerProfile::ExistingGroundedV1
    );
    assert_eq!(
        missing.telemetry().error_code,
        Some(GenerationErrorCode::ModelMissing)
    );
    assert_eq!(
        missing.telemetry().terminal_phase,
        GenerationPhase::Template
    );
    assert_eq!(missing.telemetry().prompt_tokens, None);
    assert_eq!(missing.telemetry().prefill_completed_tokens, None);
    assert_eq!(missing.telemetry().sampled_tokens, None);
    let measured = missing.into_result();
    assert_eq!(
        measured,
        host.generate_session_review_cancellable(
            contract.system(),
            contract.user(),
            768,
            4096,
            &contract,
            &active,
        )
    );
    assert!(measured.unwrap_err().starts_with(CHAT_MODEL_MISSING));
    assert!(!host.chat_model_loaded());
    assert!(
        validate_generation_budget(3320, 768, 4096, Some(GenerationSchema::SessionReviewV1))
            .is_ok()
    );
    assert!(
        validate_generation_budget(3321, 768, 4096, Some(GenerationSchema::SessionReviewV1))
            .is_err()
    );
}

fn vocabulary_accepts(model: &LlamaModel, grammar: &str, output: &str, end: LlamaToken) -> bool {
    let mut sampler = LlamaSampler::grammar(model, grammar, "root").unwrap();
    for token in model
        .str_to_token(output, AddBos::Never)
        .unwrap()
        .into_iter()
        .chain([end])
    {
        let mut choices =
            LlamaTokenDataArray::new(vec![LlamaTokenData::new(token, 0.0, 0.0)], false);
        sampler.apply(&mut choices);
        if !choices.data[0].logit().is_finite() {
            return false;
        }
        if !model.is_eog_token(token) {
            sampler.accept(token);
        }
    }
    true
}

fn field_ordered_output(value: &serde_json::Value) -> String {
    let decisions = |name: &str| {
        format!(
            "[{}]",
            value[name]
                .as_array()
                .unwrap()
                .iter()
                .map(|decision| {
                    format!(
                        r#"{{"id":{},"disposition":{},"reason":{}}}"#,
                        decision["id"], decision["disposition"], decision["reason"]
                    )
                })
                .collect::<Vec<_>>()
                .join(",")
        )
    };
    format!(
        r#"{{"version":"SessionReviewV1","claims":{},"expressions":{},"missingSpanIds":{},"sourceCoverage":{}}}"#,
        decisions("claims"),
        decisions("expressions"),
        value["missingSpanIds"],
        value["sourceCoverage"]
    )
}

#[test]
#[ignore = "requires a verified cached GGUF; vocabulary masking only, no inference"]
fn product_session_review_native_grammar_keeps_exact_decision_groups_and_eog() {
    let path = PathBuf::from(
        std::env::var_os("MYCO_CHAT_MODEL_PATH").expect("MYCO_CHAT_MODEL_PATH is required"),
    );
    let mut host = LocalLlm::load_embed_host().unwrap();
    host.ensure_chat_model(&path).unwrap();
    let model = host.chat_model().unwrap();
    let ends = (0..model.n_vocab())
        .map(LlamaToken::new)
        .filter(|token| model.is_eog_token(*token))
        .collect::<Vec<_>>();
    assert!(!ends.is_empty());
    let empty = fixture_contract(0, 0);
    let empty_input: serde_json::Value = serde_json::from_str(empty.user()).unwrap();
    assert_eq!(empty_input["requiredClaimIds"], serde_json::json!([]));
    assert_eq!(empty_input["requiredExpressionIds"], serde_json::json!([]));
    // Preserve the exact successful decoder text from actual-w03-11, before
    // native validation rejected its source-span ID in a decision group.
    for (name, raw, sha256) in [
        (
            "Gemma",
            r#"{"version":"SessionReviewV1","claims":[{"id":"Q-3b058f9db9ff27c4d37df69142ae0d89","disposition":"unsupported","reason":"No actor, action, status, or time is expressed."}],"expressions":[],"missingSpanIds":[],"sourceCoverage":"covered"}"#,
            "b977e83e7da5ab226545c70e205451a4a01366526d677b3398747852762c3509",
        ),
        (
            "Qwen",
            r#"{"version":"SessionReviewV1","claims":[],"expressions":[{"id":"Q-3b058f9db9ff27c4d37df69142ae0d89","disposition":"unsupported","reason":"The original span contains only a header '# Synthetic conversation' and no substantive text to support specific claims, entities"}],"missingSpanIds":[],"sourceCoverage":"uncertain"}"#,
            "d518baef341c9e1527ec935fb511c325bffb75db0a78bf32ae9d8827424c412b",
        ),
    ] {
        assert_eq!(crate::importers::wikify::source_revision(raw), sha256);
        assert!(
            vocabulary_accepts(
                model,
                crate::session_compile::review::SESSION_REVIEW_JSON_GRAMMAR,
                raw,
                model.token_eos(),
            ),
            "{name} raw output must remain accepted by the preserved static grammar"
        );
        assert!(
            !vocabulary_accepts(model, empty.grammar(), raw, model.token_eos()),
            "{name} raw output must be rejected when both native decision groups are empty"
        );
    }
    for (claims, entities) in [(0, 0), (1, 1), (16, 8)] {
        let contract = fixture_contract(claims, entities);
        assert!(grounded_sampling::session_review_sampler(model, &contract).is_ok());
        let input: serde_json::Value = serde_json::from_str(contract.user()).unwrap();
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
                        vocabulary_accepts(
                            model,
                            contract.grammar(),
                            &candidate,
                            model.token_eos()
                        ),
                        !(coverage == "covered" && missing)
                    );
                }
            }
        }
        let valid = output(&contract, "uncertain", "uncertain", false, "S");
        for end in &ends {
            assert!(vocabulary_accepts(model, contract.grammar(), &valid, *end));
            assert!(!vocabulary_accepts(
                model,
                contract.grammar(),
                valid.strip_suffix('}').unwrap(),
                *end
            ));
        }
        let correct: serde_json::Value = serde_json::from_str(&valid).unwrap();
        for missing in [
            serde_json::json!(["Q-foreign"]),
            serde_json::json!([
                input["originalSpans"][0]["id"],
                input["originalSpans"][0]["id"]
            ]),
        ] {
            let mut bad = correct.clone();
            bad["missingSpanIds"] = missing;
            assert!(!vocabulary_accepts(
                model,
                contract.grammar(),
                &field_ordered_output(&bad),
                model.token_eos()
            ));
        }
        let (prefix, tail) = valid.split_once("\"claims\":").unwrap();
        let (claim_rows, tail) = tail.split_once(",\"expressions\":").unwrap();
        let (expression_rows, tail) = tail.split_once(",\"missingSpanIds\":").unwrap();
        let groups_reordered = format!(
            "{prefix}\"expressions\":{expression_rows},\"claims\":{claim_rows},\"missingSpanIds\":{tail}"
        );
        assert!(!vocabulary_accepts(
            model,
            contract.grammar(),
            &groups_reordered,
            model.token_eos()
        ));
        for group in ["claims", "expressions"] {
            let mut invented = correct.clone();
            invented[group]
                .as_array_mut()
                .unwrap()
                .push(serde_json::json!({
                    "id":input["originalSpans"][0]["id"], "disposition":"unsupported", "reason":"S"
                }));
            assert!(!vocabulary_accepts(
                model,
                contract.grammar(),
                &field_ordered_output(&invented),
                model.token_eos()
            ));
            let foreign_decision = serde_json::json!({
                "id":"foreign", "disposition":"uncertain", "reason":"S"
            });
            let mut foreign = correct.clone();
            if foreign[group].as_array().unwrap().is_empty() {
                foreign[group]
                    .as_array_mut()
                    .unwrap()
                    .push(foreign_decision);
            } else {
                foreign[group][0] = foreign_decision;
            }
            assert!(!vocabulary_accepts(
                model,
                contract.grammar(),
                &field_ordered_output(&foreign),
                model.token_eos()
            ));
            if !correct[group].as_array().unwrap().is_empty() {
                let mut omitted = correct.clone();
                omitted[group].as_array_mut().unwrap().remove(0);
                assert!(!vocabulary_accepts(
                    model,
                    contract.grammar(),
                    &field_ordered_output(&omitted),
                    model.token_eos()
                ));
                let mut swapped = correct.clone();
                swapped[group][0]["id"] = if group == "claims" {
                    correct["expressions"][0]["id"].clone()
                } else {
                    correct["claims"][0]["id"].clone()
                };
                assert!(!vocabulary_accepts(
                    model,
                    contract.grammar(),
                    &field_ordered_output(&swapped),
                    model.token_eos()
                ));
                let mut duplicated = correct.clone();
                duplicated[group]
                    .as_array_mut()
                    .unwrap()
                    .push(correct[group][0].clone());
                assert!(!vocabulary_accepts(
                    model,
                    contract.grammar(),
                    &field_ordered_output(&duplicated),
                    model.token_eos()
                ));
                if correct[group].as_array().unwrap().len() > 1 {
                    let mut repeated = correct.clone();
                    repeated[group][1] = correct[group][0].clone();
                    assert!(!vocabulary_accepts(
                        model,
                        contract.grammar(),
                        &field_ordered_output(&repeated),
                        model.token_eos()
                    ));
                    let mut order_changed = correct.clone();
                    order_changed[group].as_array_mut().unwrap().swap(0, 1);
                    assert!(!vocabulary_accepts(
                        model,
                        contract.grammar(),
                        &field_ordered_output(&order_changed),
                        model.token_eos()
                    ));
                }
            }
        }
    }
}

#[test]
#[ignore = "requires the verified cached Qwen GGUF; vocabulary masking only, no inference"]
fn product_session_review_native_grammar_rejects_retained_v6_lf_reason() {
    let path = PathBuf::from(
        std::env::var_os("MYCO_CHAT_MODEL_PATH").expect("MYCO_CHAT_MODEL_PATH is required"),
    );
    assert_eq!(path.file_name().unwrap(), "Qwen3.5-4B-Q4_K_M.gguf");
    let mut host = LocalLlm::load_embed_host().unwrap();
    host.ensure_chat_model(&path).unwrap();
    let model = host.chat_model().unwrap();
    let contract = fixture_contract(2, 0);
    let input: serde_json::Value = serde_json::from_str(contract.user()).unwrap();
    assert_eq!(input["requiredClaimIds"].as_array().unwrap().len(), 2);
    assert_eq!(
        input["requiredExpressionIds"],
        serde_json::json!(["title", "summary-0", "summary-1"])
    );
    // Retain the complete synthetic Gemma v6 call-8 decoder output, including
    // its LF reason. Rebind only claim IDs to this native-issued test packet;
    // foreign-ID rejection must not conceal the reason/validator mismatch.
    let retained = r#"{"version":"SessionReviewV1","claims":[{"id":"C-2-0-1a7e5f8260c2aa7d","disposition":"supported","reason":"The original text states, \"I plan to draft the synthetic report; no completion is recorded.\"\nAction: \"Draft the synthetic report"},{"id":"C-2-1-3d6755057f2d3226","disposition":"unsupported","reason":"The claim suggests that 'Complete the synthetic report' was reported. The original text only mentions planning to 'draft' it and"}],"expressions":[{"id":"title","disposition":"supported","reason":"The original text mentions drafting the synthetic report, which supports the title."},{"id":"summary-0","disposition":"supported","reason":"The summary correctly reflects the original statement: \"I plan to draft the synthetic report; no completion is recorded.\" with a"},{"id":"summary-1","disposition":"unsupported","reason":"The summary claims 'Complete the synthetic report' was reported, but the original text only mentioned planning to 'draft' it and"}],"missingSpanIds":[],"sourceCoverage":"covered"}"#;
    assert_eq!(retained.len(), 1015);
    assert_eq!(
        crate::importers::wikify::source_revision(retained),
        "9ab20370189fbdf4284ead7f9c001714ce9b3a3bba464f3035c297cec1a2da3e"
    );
    let raw = retained
        .replace(
            "C-2-0-1a7e5f8260c2aa7d",
            input["requiredClaimIds"][0].as_str().unwrap(),
        )
        .replace(
            "C-2-1-3d6755057f2d3226",
            input["requiredClaimIds"][1].as_str().unwrap(),
        );
    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
    for group in ["claims", "expressions"] {
        let required = if group == "claims" {
            &input["requiredClaimIds"]
        } else {
            &input["requiredExpressionIds"]
        };
        let actual = parsed[group]
            .as_array()
            .unwrap()
            .iter()
            .map(|decision| decision["id"].clone())
            .collect::<Vec<_>>();
        assert_eq!(&serde_json::json!(actual), required);
        for decision in parsed[group].as_array().unwrap() {
            assert!(decision["reason"].as_str().unwrap().chars().count() <= 128);
        }
    }
    assert!(parsed["claims"][0]["reason"]
        .as_str()
        .unwrap()
        .contains('\n'));
    let corrected = raw.replace(r"\n", " ");
    assert!(vocabulary_accepts(
        model,
        contract.grammar(),
        &corrected,
        model.token_eos()
    ));
    assert!(vocabulary_accepts(
        model,
        crate::session_compile::review::SESSION_REVIEW_JSON_GRAMMAR,
        &raw,
        model.token_eos()
    ));
    assert!(
        !vocabulary_accepts(model, contract.grammar(), &raw, model.token_eos()),
        "native-issued review grammar must reject the retained LF reason, with exact IDs and otherwise valid rejection decisions"
    );
}

#[cfg(feature = "native-index-probe")]
fn reason_literal_output(
    contract: &crate::session_compile::review_decode::SessionReviewDecode,
    reason_literal: &str,
) -> String {
    let baseline = output(contract, "unsupported", "covered", false, "REASON_PROBE");
    let input: serde_json::Value = serde_json::from_str(contract.user()).unwrap();
    let decisions = input["requiredClaimIds"].as_array().unwrap().len()
        + input["requiredExpressionIds"].as_array().unwrap().len();
    assert_eq!(
        baseline.matches(r#""reason":"REASON_PROBE""#).count(),
        decisions
    );
    baseline.replace(
        r#""reason":"REASON_PROBE""#,
        &format!(r#""reason":{reason_literal}"#),
    )
}

#[cfg(feature = "native-index-probe")]
fn single_byte_vocabulary_piece(model: &LlamaModel, token: LlamaToken) -> Option<u8> {
    use std::ffi::{c_char, c_void};
    use std::ptr::NonNull;

    // These signatures match the pinned llama-cpp-sys-2 0.1.150 llama.h.
    // The optional sys dependency is not activated by this QA feature.
    extern "C" {
        fn llama_model_get_vocab(model: *const c_void) -> *const c_void;
        fn llama_token_to_piece(
            vocab: *const c_void,
            token: i32,
            buffer: *mut c_char,
            length: i32,
            lstrip: i32,
            special: bool,
        ) -> i32;
    }
    assert!((0..model.n_vocab()).contains(&token.0));
    assert_eq!(
        std::mem::size_of::<LlamaModel>(),
        std::mem::size_of::<NonNull<c_void>>()
    );
    assert_eq!(
        std::mem::align_of::<LlamaModel>(),
        std::mem::align_of::<NonNull<c_void>>()
    );
    // SAFETY: pinned llama-cpp-2 0.1.150 declares LlamaModel repr(transparent)
    // with one NonNull<llama_model> field. Copy only the borrowed pointer;
    // never reconstruct, own or drop the model. It outlives both C calls.
    let native_model = unsafe { *(model as *const LlamaModel).cast::<NonNull<c_void>>() };
    // SAFETY: the live model pointer and signature are pinned above.
    let vocab = unsafe { llama_model_get_vocab(native_model.as_ptr()) };
    assert!(!vocab.is_null());
    let mut byte = [0_u8; 1];
    // SAFETY: valid vocabulary/token and an initialized one-byte buffer.
    // The C API returns an explicit byte length without a null terminator;
    // unlike CString::from_raw, this preserves a literal NUL without changing
    // allocation ownership. Negative lengths simply denote larger pieces.
    let length =
        unsafe { llama_token_to_piece(vocab, token.0, byte.as_mut_ptr().cast(), 1, 0, false) };
    (length == 1).then_some(byte[0])
}

#[cfg(feature = "native-index-probe")]
#[test]
#[ignore = "requires the verified cached Qwen GGUF; vocabulary masking only, no inference"]
fn product_session_review_native_grammar_bounds_reason_controls_and_unicode_scalars() {
    let path = PathBuf::from(
        std::env::var_os("MYCO_CHAT_MODEL_PATH").expect("MYCO_CHAT_MODEL_PATH is required"),
    );
    assert_eq!(path.file_name().unwrap(), "Qwen3.5-4B-Q4_K_M.gguf");
    let mut host = LocalLlm::load_embed_host().unwrap();
    host.ensure_chat_model(&path).unwrap();
    let model = host.chat_model().unwrap();
    let contract = fixture_contract(1, 0);
    let accepts = |literal: &str| {
        vocabulary_accepts(
            model,
            contract.grammar(),
            &reason_literal_output(&contract, literal),
            model.token_eos(),
        )
    };

    // Rust's native reason guard rejects all 65 C0/DEL/C1 control scalars.
    // Test both their literal UTF-8 form and a legal JSON Unicode escape;
    // JSON syntax alone must not conceal an invalid decoded reason.
    let controls = (0x00_u32..=0x1f).chain(0x7f..=0x9f).collect::<Vec<_>>();
    assert_eq!(controls.len(), 65);
    // The pinned tokenizer rejects NUL through CString, so probe the exact
    // one-byte vocabulary piece rather than treating tokenizer failure as
    // evidence that the grammar masks this scalar.
    let nul_token = (0..model.n_vocab())
        .map(LlamaToken::new)
        .find(|token| single_byte_vocabulary_piece(model, *token) == Some(0))
        .expect("the pinned Qwen vocabulary must contain an exact NUL byte piece");
    assert!(!model.is_eog_token(nul_token));
    assert_eq!(single_byte_vocabulary_piece(model, nul_token), Some(0));
    for code in controls {
        let scalar = char::from_u32(code).unwrap();
        assert!(scalar.is_control());
        let raw = format!("\"A{scalar}B\"");
        let escaped = format!(r#""A\u{code:04x}B""#);
        let escaped_upper = format!(r#""A\u{code:04X}B""#);
        let decoded: String = serde_json::from_str(&escaped).unwrap();
        assert_eq!(decoded, format!("A{scalar}B"));
        assert_eq!(
            serde_json::from_str::<String>(&escaped_upper).unwrap(),
            decoded
        );
        if code == 0 {
            let raw_output = reason_literal_output(&contract, &raw);
            let (prefix, _) = raw_output.split_once('\0').unwrap();
            let mut sampler = LlamaSampler::grammar(model, contract.grammar(), "root").unwrap();
            for token in model.str_to_token(prefix, AddBos::Never).unwrap() {
                let mut choices =
                    LlamaTokenDataArray::new(vec![LlamaTokenData::new(token, 0.0, 0.0)], false);
                sampler.apply(&mut choices);
                assert!(
                    choices.data[0].logit().is_finite(),
                    "NUL probe prefix must be valid"
                );
                sampler.accept(token);
            }
            let mut choices =
                LlamaTokenDataArray::new(vec![LlamaTokenData::new(nul_token, 0.0, 0.0)], false);
            sampler.apply(&mut choices);
            assert!(
                !choices.data[0].logit().is_finite(),
                "raw NUL must be masked"
            );
        } else {
            assert!(!accepts(&raw), "raw control U+{code:04X} must be masked");
        }
        assert!(
            !accepts(&escaped),
            "escaped control U+{code:04X} must be masked"
        );
        assert!(
            !accepts(&escaped_upper),
            "uppercase escaped control U+{code:04X} must be masked"
        );
    }
    for (literal, scalar) in [
        (r#""A\bB""#, '\u{0008}'),
        (r#""A\fB""#, '\u{000c}'),
        (r#""A\nB""#, '\n'),
        (r#""A\rB""#, '\r'),
        (r#""A\tB""#, '\t'),
    ] {
        let decoded: String = serde_json::from_str(literal).unwrap();
        assert_eq!(decoded, format!("A{scalar}B"));
        assert!(
            !accepts(literal),
            "simple control escape {literal} must be masked"
        );
    }

    for literal in [
        r#""\uD800""#,
        r#""\uDBFF""#,
        r#""\uDC00""#,
        r#""\uDFFF""#,
        r#""\uD800\uD800""#,
        r#""\uDC00\uD800""#,
        r#""\uD800\u0041""#,
        r#""\u0041\uDC00""#,
        r#""\uD83D\uDE00\uD800""#,
        r#""\uD83D\uDE00\uDC00""#,
    ] {
        assert!(serde_json::from_str::<String>(literal).is_err());
        assert!(
            !accepts(literal),
            "invalid surrogate form {literal} must be masked"
        );
    }

    for literal in [
        r#""quote: \" backslash: \\ slash: \/""#,
        r#""한국어 근거""#,
        r#""é Ω 漢字""#,
        r#""😀""#,
        r#""\uAC00\u03A9\u4E2D""#,
        r#""\uD83D\uDE00""#,
        r#""\ud800\udc00""#,
        r#""\uDBFF\uDFFF""#,
        r#""A\uD83D\uDE00한국어""#,
        r#""\u0020\u007e\u00a0\ud7ff\ue000\uffff""#,
    ] {
        let decoded: String = serde_json::from_str(literal).unwrap();
        assert!(!decoded.trim().is_empty());
        assert!(!decoded.chars().any(char::is_control));
        assert!(decoded.chars().count() <= 128);
        assert!(
            accepts(literal),
            "legal Unicode reason {literal} must remain available"
        );
    }

    // Each escape, surrogate pair and literal scalar counts as one decoded
    // character. The 128 limit is neither JSON byte length nor UTF-16 units.
    for (name, unit) in [
        ("ASCII", "A"),
        ("Korean scalar", "가"),
        ("literal supplementary scalar", "😀"),
        ("escaped quote", r#"\""#),
        ("escaped backslash", r"\\"),
        ("escaped slash", r"\/"),
        ("escaped BMP scalar", r"\uAC00"),
        ("escaped surrogate pair", r"\uD83D\uDE00"),
    ] {
        for length in [128, 129] {
            let literal = format!("\"{}\"", unit.repeat(length));
            let decoded: String = serde_json::from_str(&literal).unwrap();
            assert_eq!(decoded.chars().count(), length);
            assert_eq!(
                accepts(&literal),
                length == 128,
                "{name}: {length} decoded scalars must use the native length bound"
            );
        }
    }
    assert!(!accepts(r#""""#), "an empty reason must remain masked");

    for disposition in ["supported", "unsupported", "uncertain"] {
        for coverage in ["covered", "missing", "uncertain"] {
            let raw = output(
                &contract,
                disposition,
                coverage,
                coverage == "missing",
                "근거가 부족합니다 😀",
            );
            assert!(vocabulary_accepts(
                model,
                contract.grammar(),
                &raw,
                model.token_eos()
            ));
        }
    }

    // Whitespace-only text has no control scalar and may pass syntax masking.
    // review::decisions_match still owns the separate trim/nonempty guard;
    // grammar acceptance is not a universal native-review validity claim.
    let whitespace_literal = r#"" ""#;
    let whitespace: String = serde_json::from_str(whitespace_literal).unwrap();
    assert!(whitespace.trim().is_empty());
    assert!(accepts(whitespace_literal));
}
