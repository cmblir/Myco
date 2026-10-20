use super::*;
use crate::local_llm::generation_telemetry::{AttemptTerminal, GenerationPhase};
use crate::local_llm::{check_measured_cancelled, LocalLlm};
use std::sync::atomic::Ordering;

const OPEN: LlamaToken = LlamaToken(101);
const CLOSE: LlamaToken = LlamaToken(102);
const TEXT: LlamaToken = LlamaToken(103);
const EOG: LlamaToken = LlamaToken(104);

#[test]
fn exact_pinned_gguf_marker_ids_and_classes_are_admitted() {
    // GGUF token_type 3 maps to CONTROL; 4 maps to USER_DEFINED in 0.1.150.
    let observed = [
        (THINK_MARKER, "<|think|>", 98, LlamaTokenAttr::Control),
        (OPEN_MARKER, "<|channel>", 100, LlamaTokenAttr::UserDefined),
        (CLOSE_MARKER, "<channel|>", 101, LlamaTokenAttr::UserDefined),
    ];
    assert_eq!(PINNED_VOCABULARY_SIZE, 262_144);
    for (marker, text, token_id, class) in observed {
        assert_eq!(marker.text, text);
        assert_eq!(marker.token_id, token_id);
        assert_eq!(marker.class, class);
        assert_eq!(
            validate_marker_metadata(
                marker,
                262_144,
                &[LlamaToken(token_id)],
                class as u32,
                false,
                text.as_bytes()
            )
            .unwrap(),
            LlamaToken(token_id)
        );
    }
}

#[test]
fn marker_admission_rejects_wrong_class_or_combined_special_classes() {
    for marker in [THINK_MARKER, OPEN_MARKER, CLOSE_MARKER] {
        for wrong in [
            LlamaTokenAttr::Normal,
            LlamaTokenAttr::Byte,
            LlamaTokenAttr::Unknown,
            LlamaTokenAttr::Unused,
        ] {
            assert!(validate_marker_metadata(
                marker,
                262_144,
                &[LlamaToken(marker.token_id)],
                wrong as u32,
                false,
                marker.text.as_bytes()
            )
            .is_err());
        }
        let other = if marker.class == LlamaTokenAttr::Control {
            LlamaTokenAttr::UserDefined
        } else {
            LlamaTokenAttr::Control
        };
        assert!(validate_marker_metadata(
            marker,
            262_144,
            &[LlamaToken(marker.token_id)],
            other as u32,
            false,
            marker.text.as_bytes()
        )
        .is_err());
        assert!(validate_marker_metadata(
            marker,
            262_144,
            &[LlamaToken(marker.token_id)],
            (LlamaTokenAttr::Control as u32) | (LlamaTokenAttr::UserDefined as u32),
            false,
            marker.text.as_bytes()
        )
        .is_err());
    }
}

#[test]
fn marker_admission_rejects_wrong_ids_token_lengths_and_vocabulary_size() {
    for marker in [THINK_MARKER, OPEN_MARKER, CLOSE_MARKER] {
        for tokens in [
            vec![],
            vec![LlamaToken(marker.token_id + 1)],
            vec![LlamaToken(marker.token_id), LlamaToken(0)],
        ] {
            assert!(validate_marker_metadata(
                marker,
                262_144,
                &tokens,
                marker.class as u32,
                false,
                marker.text.as_bytes()
            )
            .is_err());
        }
        for size in [0, 262_143, 262_145] {
            assert!(validate_marker_metadata(
                marker,
                size,
                &[LlamaToken(marker.token_id)],
                marker.class as u32,
                false,
                marker.text.as_bytes()
            )
            .is_err());
        }
    }
}

#[test]
fn marker_admission_rejects_eog_and_non_exact_special_piece_without_trimming() {
    for marker in [THINK_MARKER, OPEN_MARKER, CLOSE_MARKER] {
        assert!(validate_marker_metadata(
            marker,
            262_144,
            &[LlamaToken(marker.token_id)],
            marker.class as u32,
            true,
            marker.text.as_bytes()
        )
        .is_err());
        for piece in [
            Vec::new(),
            format!(" {}", marker.text).into_bytes(),
            format!("{}\n", marker.text).into_bytes(),
            b"<|other>".to_vec(),
        ] {
            assert!(validate_marker_metadata(
                marker,
                262_144,
                &[LlamaToken(marker.token_id)],
                marker.class as u32,
                false,
                &piece
            )
            .is_err());
        }
    }
}

fn controller() -> Controller {
    Controller::new(
        Protocol {
            open: OPEN,
            close: CLOSE,
            expected_header: vec![101, 103],
        },
        20,
    )
}

fn sample_decode(
    controller: &mut Controller,
    token: LlamaToken,
    control: bool,
    bytes: &[u8],
) -> bool {
    controller.before_sample().unwrap();
    controller.sampled(token, false, control, bytes).unwrap();
    let position = controller.prompt_tokens
        + controller.receipt.thought_decoded_tokens
        + controller.receipt.final_decoded_tokens;
    controller.decoded(token, position).unwrap()
}

fn begin_thought(controller: &mut Controller) {
    assert!(!sample_decode(controller, OPEN, true, b""));
    assert!(!sample_decode(controller, TEXT, false, b"thought\n"));
    assert_eq!(controller.phase, Phase::Thought);
}

fn close_thought(controller: &mut Controller) {
    assert!(sample_decode(controller, CLOSE, true, b""));
    // The runtime creates the final grammar sampler only after this decode.
    controller.final_sampler_ready().unwrap();
}

#[test]
fn fixed_budgets_reserve_both_phases_and_safety_without_trimming() {
    assert_eq!(
        (THOUGHT_TOKENS, FINAL_TOKENS, CONTEXT_TOKENS),
        (1024, 192, 4096)
    );
    let limit = 4096 - 1024 - 192 - 8;
    assert!(validate_budget(limit).is_ok());
    assert!(validate_budget(limit + 1).is_err());
    assert!(validate_budget(0).is_err());
    assert!(validate_budget(usize::MAX).is_err());
}

#[test]
fn actual_sampled_close_is_not_a_transition_until_decoded_at_next_kv_position() {
    let mut controller = controller();
    begin_thought(&mut controller);
    sample_decode(&mut controller, TEXT, false, b"private synthetic thought");
    assert_eq!(
        controller.sampled(CLOSE, false, true, b"").unwrap(),
        Action::DecodeClose
    );
    assert_eq!(controller.phase, Phase::Closing);
    assert_eq!(controller.receipt.closing_sample_ordinal, Some(4));
    assert_eq!(controller.receipt.closing_decoded_kv_position, None);
    assert_eq!(
        controller.receipt.final_grammar_activation_sample_ordinal,
        None
    );
    assert!(controller.decoded(CLOSE, 23).unwrap());
    assert_eq!(controller.phase, Phase::FinalReady);
    assert_eq!(controller.receipt.thought_decoded_tokens, 4);
    assert_eq!(controller.receipt.final_first_kv_position, None);
    assert_eq!(controller.receipt.closing_decoded_kv_position, Some(23));
    assert!(controller.final_text.is_empty());
    assert!(!controller.receipt.final_sampler_fresh);
    controller.final_sampler_ready().unwrap();
    sample_decode(&mut controller, TEXT, false, b"{");
    assert_eq!(controller.receipt.final_first_kv_position, Some(24));
}

#[test]
fn forced_or_wrong_close_decode_and_double_decode_are_rejected() {
    let mut unsampled = controller();
    begin_thought(&mut unsampled);
    assert_eq!(
        unsampled.decoded(CLOSE, 22),
        Err(ThinkingQaFailure::MalformedChannel)
    );
    let mut wrong_position = controller();
    begin_thought(&mut wrong_position);
    wrong_position.sampled(CLOSE, false, true, b"").unwrap();
    assert_eq!(
        wrong_position.decoded(CLOSE, 99),
        Err(ThinkingQaFailure::MalformedChannel)
    );
    let mut double = controller();
    begin_thought(&mut double);
    close_thought(&mut double);
    assert_eq!(
        double.decoded(CLOSE, 23),
        Err(ThinkingQaFailure::MalformedChannel)
    );
}

#[test]
fn final_sampling_requires_sampler_creation_after_real_close_decode() {
    let mut early = controller();
    begin_thought(&mut early);
    assert_eq!(
        early.final_sampler_ready(),
        Err(ThinkingQaFailure::MalformedChannel)
    );
    assert!(!early.receipt.final_sampler_fresh);
    let mut not_created = controller();
    begin_thought(&mut not_created);
    not_created.sampled(CLOSE, false, true, b"").unwrap();
    assert!(not_created.decoded(CLOSE, 22).unwrap());
    assert_eq!(not_created.phase, Phase::FinalReady);
    assert_eq!(
        not_created.before_sample(),
        Err(ThinkingQaFailure::MalformedChannel)
    );
    assert_eq!(not_created.receipt.final_sampled_tokens, 0);
    assert_eq!(not_created.receipt.final_first_kv_position, None);
    assert_eq!(
        not_created.receipt.final_grammar_activation_sample_ordinal,
        None
    );
    assert!(!not_created.receipt.final_sampler_fresh);
}

#[test]
fn header_is_sampled_exactly_and_accepts_incremental_header_bytes() {
    let mut controller = controller();
    sample_decode(&mut controller, OPEN, true, b"");
    sample_decode(&mut controller, TEXT, false, b"th");
    assert_eq!(controller.phase, Phase::Header);
    sample_decode(&mut controller, TEXT, false, b"ought\nbody");
    assert_eq!(controller.phase, Phase::Thought);
    assert_eq!(controller.receipt.sampled_header_token_ids, [101, 103, 103]);
    assert_eq!(controller.receipt.opener_sample_ordinal, Some(1));
    assert_eq!(controller.receipt.thought_body_bytes, 4);
    assert_eq!(controller.receipt.parsed_header_bytes, 8);
    assert_eq!(
        controller.receipt.parsed_header_sha256,
        Some(format!("{:x}", Sha256::digest(b"thought\n")))
    );
    assert!(controller.final_text.is_empty());
}

#[test]
fn direct_final_wrong_channel_nested_open_and_premature_close_fail() {
    for bytes in [b"final\n".as_slice(), b"analysis\n", b"thought ", b""] {
        let mut controller = controller();
        sample_decode(&mut controller, OPEN, true, b"");
        assert_eq!(
            controller.sampled(TEXT, false, false, bytes),
            Err(ThinkingQaFailure::MalformedChannel)
        );
    }
    let mut direct = controller();
    assert_eq!(
        direct.sampled(
            TEXT,
            false,
            false,
            b"{\"answer\":\"supported\",\"sources\":[\"S1\"]}"
        ),
        Err(ThinkingQaFailure::MalformedChannel)
    );
    let mut nested = controller();
    begin_thought(&mut nested);
    assert_eq!(
        nested.sampled(OPEN, false, true, b""),
        Err(ThinkingQaFailure::MalformedChannel)
    );
    let mut early_close = controller();
    sample_decode(&mut early_close, OPEN, true, b"");
    assert_eq!(
        early_close.sampled(CLOSE, false, true, b""),
        Err(ThinkingQaFailure::MalformedChannel)
    );
}

#[test]
fn eog_before_actual_close_never_returns_a_complete_verdict() {
    for phase in 0..3 {
        let mut controller = controller();
        if phase > 0 {
            sample_decode(&mut controller, OPEN, true, b"");
        }
        if phase > 1 {
            sample_decode(&mut controller, TEXT, false, b"thought\n");
        }
        assert_eq!(
            controller.sampled(EOG, true, true, b""),
            Err(ThinkingQaFailure::PrematureEog)
        );
        assert_eq!(controller.receipt.final_eog_sample_ordinal, None);
        assert!(!controller.receipt.final_json_valid);
        assert_eq!(controller.receipt.final_sampled_tokens, 0);
    }
}

#[test]
fn thought_budget_counts_protocol_tokens_and_requires_real_close_before_limit() {
    let mut exhausted = controller();
    begin_thought(&mut exhausted);
    for _ in 2..THOUGHT_TOKENS {
        sample_decode(&mut exhausted, TEXT, false, b"x");
    }
    assert_eq!(
        exhausted.before_sample(),
        Err(ThinkingQaFailure::ThoughtBudget)
    );
    assert_eq!(exhausted.receipt.thought_sampled_tokens, 1024);
    assert_eq!(exhausted.receipt.final_sampled_tokens, 0);
    assert_eq!(exhausted.receipt.closing_sample_ordinal, None);

    let mut exact_close = controller();
    begin_thought(&mut exact_close);
    for _ in 2..THOUGHT_TOKENS - 1 {
        sample_decode(&mut exact_close, TEXT, false, b"x");
    }
    close_thought(&mut exact_close);
    assert_eq!(exact_close.receipt.closing_sample_ordinal, Some(1024));
    assert!(exact_close.before_sample().is_ok());
}

#[test]
fn final_budget_does_not_accept_even_complete_json_without_final_eog() {
    let mut controller = controller();
    begin_thought(&mut controller);
    close_thought(&mut controller);
    sample_decode(
        &mut controller,
        TEXT,
        false,
        b"{\"answer\":\"supported\",\"sources\":[\"S1\"]}",
    );
    for _ in 1..FINAL_TOKENS {
        sample_decode(&mut controller, TEXT, false, b" ");
    }
    assert!(valid_final(&controller.final_text));
    assert_eq!(
        controller.before_sample(),
        Err(ThinkingQaFailure::FinalBudget)
    );
    assert!(!controller.receipt.final_json_valid);
    assert_eq!(controller.receipt.final_eog_sample_ordinal, None);
}

#[test]
fn final_eog_at_last_budget_sample_accepts_only_strict_ask_json() {
    let mut controller = controller();
    begin_thought(&mut controller);
    close_thought(&mut controller);
    sample_decode(
        &mut controller,
        TEXT,
        false,
        b"{\"answer\":\"uncertain\",\"sources\":[\"S1\"]}",
    );
    for _ in 1..FINAL_TOKENS - 1 {
        sample_decode(&mut controller, TEXT, false, b" ");
    }
    controller.before_sample().unwrap();
    assert_eq!(
        controller.sampled(EOG, true, true, b"").unwrap(),
        Action::Complete
    );
    assert_eq!(controller.receipt.final_sampled_tokens, 192);
    assert_eq!(controller.receipt.final_decoded_tokens, 191);
    assert_eq!(controller.receipt.final_eog_sample_ordinal, Some(195));
    assert!(controller.receipt.final_json_valid);
    for invalid in [
        "{}",
        "{\"answer\":\"supported\",\"sources\":[\"S13\"]}",
        "{\"answer\":\"supported\",\"sources\":[],\"extra\":true}",
        "{\"answer\":\"<bad>\",\"sources\":[]}",
    ] {
        assert!(!valid_final(invalid));
    }
}

#[test]
fn incomplete_and_invalid_utf8_fail_at_close_or_final_eog_without_replacement() {
    let mut thought = controller();
    begin_thought(&mut thought);
    sample_decode(&mut thought, TEXT, false, &[0xed, 0x95]);
    assert_eq!(thought.receipt.thought_pending_utf8_bytes, 2);
    assert_eq!(
        thought.sampled(CLOSE, false, true, b""),
        Err(ThinkingQaFailure::InvalidUtf8)
    );
    let mut valid = controller();
    begin_thought(&mut valid);
    sample_decode(&mut valid, TEXT, false, &[0xed, 0x95]);
    sample_decode(&mut valid, TEXT, false, &[0x9c]);
    assert_eq!(valid.receipt.thought_pending_utf8_bytes, 0);
    close_thought(&mut valid);
    sample_decode(&mut valid, TEXT, false, b"{\"answer\":\"");
    sample_decode(&mut valid, TEXT, false, &[0xed, 0x95]);
    assert_eq!(
        valid.sampled(EOG, true, true, b""),
        Err(ThinkingQaFailure::InvalidUtf8)
    );
    let mut invalid = controller();
    begin_thought(&mut invalid);
    assert_eq!(
        invalid.sampled(TEXT, false, false, &[0xff]),
        Err(ThinkingQaFailure::InvalidUtf8)
    );
}

#[test]
fn phase_metadata_has_counts_hashes_and_no_private_thought_or_final_body() {
    let mut controller = controller();
    begin_thought(&mut controller);
    let thought = b"private-synthetic-thought";
    sample_decode(&mut controller, TEXT, false, thought);
    close_thought(&mut controller);
    sample_decode(
        &mut controller,
        TEXT,
        false,
        b"{\"answer\":\"supported\",\"sources\":[\"S1\"]}",
    );
    controller.sampled(EOG, true, true, b"").unwrap();
    let receipt = controller.receipt();
    assert_eq!(
        receipt.thought_body_sha256,
        Some(format!("{:x}", Sha256::digest(thought)))
    );
    assert_eq!(
        receipt.final_grammar_sha256,
        GenerationSchema::AskAnswerV1.qa_grammar_sha256()
    );
    assert_eq!(receipt.final_grammar_activation_sample_ordinal, Some(5));
    assert_eq!(receipt.thought_sampled_tokens, 4);
    assert_eq!(receipt.thought_decoded_tokens, 4);
    assert_eq!(receipt.final_sampled_tokens, 2);
    assert_eq!(receipt.final_decoded_tokens, 1);
    let serialized = serde_json::to_string(&receipt).unwrap();
    assert!(!serialized.contains("private-synthetic-thought"));
    assert!(!serialized.contains("supported"));
    assert!(!serialized.contains("S1"));
}

#[test]
fn cancellation_at_each_protocol_boundary_does_not_advance_to_final_result() {
    for boundary in 0..5 {
        let mut controller = controller();
        let mut recorder = Recorder::new(
            Some(GenerationSchema::AskAnswerV1),
            FINAL_TOKENS,
            CONTEXT_TOKENS,
        );
        recorder.thinking_qa(GemmaThinkingQaTelemetry::new());
        recorder.phase(GenerationPhase::SamplingLoop);
        let cancelled = AtomicBool::new(false);
        if boundary > 0 {
            sample_decode(&mut controller, OPEN, true, b"");
        }
        if boundary > 1 {
            sample_decode(&mut controller, TEXT, false, b"thought\n");
        }
        if boundary > 2 {
            controller.sampled(CLOSE, false, true, b"").unwrap();
        }
        if boundary > 3 {
            controller.decoded(CLOSE, 22).unwrap();
        }
        cancelled.store(true, Ordering::Release);
        let result = check_measured_cancelled(&mut recorder, &cancelled);
        assert!(result.is_err());
        assert_eq!(controller.receipt.final_sampled_tokens, 0);
        assert!(!controller.receipt.final_json_valid);
        assert_eq!(
            recorder
                .finish(result.map(|()| "unexpected".into()))
                .telemetry()
                .terminal,
            AttemptTerminal::Cancelled
        );
    }
}

#[test]
fn public_qa_entry_cancels_before_model_access_and_missing_model_is_measured() {
    let host = LocalLlm::load_embed_host().unwrap();
    for (cancelled, terminal, code) in [
        (true, AttemptTerminal::Cancelled, None),
        (
            false,
            AttemptTerminal::Failed,
            Some(GenerationErrorCode::ModelMissing),
        ),
    ] {
        let attempt = host.generate_gemma_bounded_thinking_qa_measured(
            "Synthetic policy",
            "Synthetic source",
            &AtomicBool::new(cancelled),
        );
        let telemetry = attempt.telemetry();
        assert_eq!(telemetry.requested_output_tokens, 192);
        assert_eq!(telemetry.requested_context_tokens, 4096);
        assert_eq!(telemetry.error_code, code);
        assert_eq!(telemetry.terminal, terminal);
        assert_eq!(telemetry.prompt_tokens, None);
        assert_eq!(telemetry.sampled_tokens, None);
        assert_eq!(
            telemetry
                .gemma_thinking_qa
                .as_ref()
                .unwrap()
                .context_creation_count,
            0
        );
        assert_eq!(
            telemetry.gemma_thinking_qa.as_ref().unwrap().failure,
            Some(if cancelled {
                ThinkingQaFailure::Cancelled
            } else {
                ThinkingQaFailure::AdmissionFailed
            })
        );
        assert!(attempt.into_result().is_err());
    }
    assert!(!host.chat_model_loaded());
}

#[test]
fn qa_receipt_does_not_change_off_telemetry_serialization() {
    let ordinary = Recorder::new(Some(GenerationSchema::AskAnswerV1), 192, 4096)
        .finish(Err("synthetic".into()));
    assert!(serde_json::to_value(ordinary.telemetry())
        .unwrap()
        .get("gemmaThinkingQa")
        .is_none());
    let mut recorder = Recorder::new(Some(GenerationSchema::AskAnswerV1), 192, 4096);
    recorder.thinking_qa(GemmaThinkingQaTelemetry::new());
    recorder.thinking_qa_prompt("synthetic prompt");
    recorder.thinking_qa_context_created();
    recorder.phase(GenerationPhase::Prefill);
    recorder.prefill_completed(20);
    recorder.phase(GenerationPhase::SamplingLoop);
    recorder.sampled(false);
    recorder.output_decoded();
    recorder.sampled(true);
    let receipt = recorder.thinking_qa_receipt();
    assert_eq!(receipt.context_creation_count, 1);
    assert_eq!(receipt.prefill_pass_count, 1);
    assert_eq!(
        receipt.effective_prompt_sha256,
        Some(format!("{:x}", Sha256::digest(b"synthetic prompt")))
    );
    let telemetry = recorder.finish(Err("synthetic".into()));
    assert_eq!(telemetry.telemetry().sampled_tokens, Some(2));
    assert_eq!(telemetry.telemetry().decoded_output_tokens, Some(1));
}
