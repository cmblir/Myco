use super::*;
use crate::local_llm::{
    check_measured_cancelled, decode_error_code, validate_measured_budget, LocalLlm,
};
use serde_json::Value;
use std::sync::atomic::AtomicBool;

fn sampling_recorder(schema: Option<GenerationSchema>) -> Recorder {
    let mut recorder = Recorder::new(schema, 256, 4096);
    recorder.phase(GenerationPhase::Tokenize);
    recorder.prompt_tokens(257);
    recorder.phase(GenerationPhase::Prefill);
    recorder.prefill_completed(128);
    recorder.prefill_completed(128);
    recorder.prefill_completed(1);
    recorder.phase(GenerationPhase::SamplingLoop);
    recorder
}

// Recorder events are model-free accounting evidence, not backend inference.
#[test]
fn recorder_eog_counts_samples_separately_from_successful_decode() {
    let mut recorder = sampling_recorder(Some(GenerationSchema::WikiClaimsV1));
    for _ in 0..3 {
        recorder.sampled(false);
        recorder.output_decoded();
    }
    recorder.output("  한국어🙂  ", 0, true);
    recorder.sampled(true);
    recorder.exhausted_budget();
    recorder.phase(GenerationPhase::Finalize);
    let attempt = recorder.finish(Ok("한국어🙂".into()));
    let observed = attempt.telemetry();
    assert_eq!(observed.prompt_tokens, Some(257));
    assert_eq!(observed.prefill_completed_tokens, Some(257));
    assert_eq!(observed.prefill_completed_batches, Some(3));
    assert_eq!(observed.sampled_tokens, Some(4));
    assert_eq!(observed.sampled_output_tokens, Some(3));
    assert_eq!(observed.decoded_output_tokens, Some(3));
    assert_eq!(observed.assembled_chars, Some(8));
    assert_eq!(observed.returned_chars, Some(4));
    assert_eq!(observed.loop_stop, Some(LoopStop::Eog));
    assert_eq!(observed.terminal, AttemptTerminal::ReturnedText);
    assert!(observed.elapsed_micros.first_output_piece.is_some());
    assert_eq!(attempt.into_result().unwrap(), "한국어🙂");
}

#[test]
fn recorder_budget_does_not_imply_complete_utf8_or_valid_json() {
    let mut recorder = Recorder::new(Some(GenerationSchema::WikiClaimsV1), 1, 4096);
    recorder.phase(GenerationPhase::SamplingLoop);
    recorder.sampled(false);
    recorder.output("{", 2, true);
    recorder.output_decoded();
    recorder.exhausted_budget();
    recorder.phase(GenerationPhase::Finalize);
    let attempt = recorder.finish(Ok("{".into()));
    assert_eq!(attempt.telemetry().sampled_tokens, Some(1));
    assert_eq!(attempt.telemetry().requested_output_tokens, 1);
    assert_eq!(attempt.telemetry().loop_stop, Some(LoopStop::OutputBudget));
    assert_eq!(attempt.telemetry().pending_utf8_bytes, Some(2));
    assert_eq!(attempt.telemetry().terminal, AttemptTerminal::ReturnedText);
    assert!(serde_json::from_str::<Value>(&attempt.into_result().unwrap()).is_err());
}

#[test]
fn recorder_late_cancel_preserves_observed_eog_and_discards_returned_text() {
    let mut recorder = sampling_recorder(None);
    recorder.sampled(true);
    recorder.phase(GenerationPhase::Finalize);
    let result = check_measured_cancelled(&mut recorder, &AtomicBool::new(true));
    let attempt = recorder.finish(result.map(|()| "must not return".into()));
    assert_eq!(attempt.telemetry().loop_stop, Some(LoopStop::Eog));
    assert_eq!(attempt.telemetry().terminal, AttemptTerminal::Cancelled);
    assert_eq!(attempt.telemetry().returned_chars, None);
    assert_eq!(
        attempt.into_result().unwrap_err(),
        "local generation cancelled"
    );
}

#[test]
fn recorder_late_cancel_preserves_exhausted_budget_and_successful_decode_count() {
    let mut recorder = Recorder::new(None, 1, 4096);
    recorder.phase(GenerationPhase::SamplingLoop);
    recorder.sampled(false);
    recorder.output_decoded();
    recorder.exhausted_budget();
    recorder.phase(GenerationPhase::Finalize);
    let result = check_measured_cancelled(&mut recorder, &AtomicBool::new(true));
    let attempt = recorder.finish(result.map(|()| "must not return".into()));
    assert_eq!(attempt.telemetry().loop_stop, Some(LoopStop::OutputBudget));
    assert_eq!(attempt.telemetry().decoded_output_tokens, Some(1));
    assert_eq!(attempt.telemetry().terminal, AttemptTerminal::Cancelled);
    assert_eq!(attempt.telemetry().returned_chars, None);
    assert_eq!(
        attempt.into_result().unwrap_err(),
        "local generation cancelled"
    );
}

#[test]
fn recorder_cancel_after_last_decode_does_not_invent_a_budget_stop() {
    let mut recorder = Recorder::new(None, 1, 4096);
    recorder.phase(GenerationPhase::Tokenize);
    recorder.prompt_tokens(1);
    recorder.phase(GenerationPhase::Prefill);
    recorder.prefill_completed(1);
    recorder.phase(GenerationPhase::SamplingLoop);
    recorder.sampled(false);
    recorder.output("a", 0, true);
    recorder.output_decoded();
    // The loop checks cancellation after decode, before observing exhaustion.
    let result = check_measured_cancelled(&mut recorder, &AtomicBool::new(true));
    let attempt = recorder.finish(result.map(|()| "must not return".into()));
    let observed = attempt.telemetry();
    assert_eq!(observed.requested_output_tokens, 1);
    assert_eq!(observed.prefill_completed_tokens, Some(1));
    assert_eq!(observed.sampled_tokens, Some(1));
    assert_eq!(observed.decoded_output_tokens, Some(1));
    assert_eq!(observed.loop_stop, None);
    assert_eq!(observed.terminal, AttemptTerminal::Cancelled);
    assert_eq!(observed.terminal_phase, GenerationPhase::SamplingLoop);
    assert_eq!(observed.returned_chars, None);
    assert_eq!(
        attempt.into_result().unwrap_err(),
        "local generation cancelled"
    );
}

#[test]
fn recorder_failed_prefill_counts_only_successfully_returned_batches() {
    let mut recorder = Recorder::new(Some(GenerationSchema::AskAnswerV1), 256, 4096);
    recorder.prompt_tokens(300);
    recorder.phase(GenerationPhase::Prefill);
    recorder.prefill_completed(128);
    recorder.decode_elapsed(Instant::now(), true);
    recorder.fail(decode_error_code(&llama_cpp_2::DecodeError::NoKvCacheSlot));
    let attempt = recorder.finish(Err("decode prompt: synthetic error".into()));
    assert_eq!(attempt.telemetry().prefill_completed_tokens, Some(128));
    assert_eq!(attempt.telemetry().prefill_completed_batches, Some(1));
    assert_eq!(attempt.telemetry().sampled_tokens, None);
    assert_eq!(attempt.telemetry().loop_stop, None);
    assert_eq!(attempt.telemetry().terminal_phase, GenerationPhase::Prefill);
    assert_eq!(
        attempt.telemetry().error_code,
        Some(GenerationErrorCode::DecodeNoKvSlot)
    );
    assert!(attempt
        .telemetry()
        .elapsed_micros
        .prefill_decode_calls
        .is_some());
    assert_eq!(attempt.telemetry().elapsed_micros.output_decode_calls, None);
    assert!(attempt
        .into_result()
        .unwrap_err()
        .contains("synthetic error"));
}

#[test]
fn recorder_failed_piece_or_decode_keeps_sample_but_not_successful_decode() {
    for code in [
        GenerationErrorCode::TokenPieceFailed,
        GenerationErrorCode::DecodeUnknown,
    ] {
        let mut recorder = sampling_recorder(None);
        recorder.sampled(false);
        recorder.fail(code);
        let attempt = recorder.finish(Err("private original error".into()));
        assert_eq!(attempt.telemetry().sampled_tokens, Some(1));
        assert_eq!(attempt.telemetry().sampled_output_tokens, Some(1));
        assert_eq!(attempt.telemetry().decoded_output_tokens, Some(0));
        assert_eq!(attempt.telemetry().loop_stop, None);
        assert_eq!(attempt.telemetry().terminal, AttemptTerminal::Failed);
        assert_eq!(attempt.telemetry().error_code, Some(code));
    }
}

#[test]
fn recorder_split_utf8_tail_does_not_invent_a_character() {
    let mut recorder = sampling_recorder(None);
    recorder.output("", 2, false);
    assert_eq!(recorder.telemetry.assembled_chars, Some(0));
    assert_eq!(recorder.telemetry.pending_utf8_bytes, Some(2));
    assert_eq!(recorder.telemetry.elapsed_micros.first_output_piece, None);
    recorder.output("한🙂", 0, true);
    let attempt = recorder.finish(Ok("한🙂".into()));
    assert_eq!(attempt.telemetry().assembled_chars, Some(2));
    assert_eq!(attempt.telemetry().returned_chars, Some(2));
    assert_eq!(attempt.telemetry().pending_utf8_bytes, Some(0));
    assert!(attempt
        .telemetry()
        .elapsed_micros
        .first_output_piece
        .is_some());
}

#[test]
fn recorder_actual_guard_reports_legacy_cutoff_without_decoding_last_sample() {
    let mut recorder = sampling_recorder(None);
    recorder.sampled(false);
    let mut out = "한국어🙂\nUser: invented".to_string();
    let reason = crate::local_llm::output_guard::apply_with_reason(&mut out, None).unwrap();
    recorder.output(&out, 0, true);
    recorder.stopped(reason);
    recorder.exhausted_budget();
    let attempt = recorder.finish(Ok(out));
    assert_eq!(
        attempt.telemetry().loop_stop,
        Some(LoopStop::LegacyDialogueMarker)
    );
    assert_eq!(attempt.telemetry().assembled_chars, Some(4));
    assert_eq!(attempt.telemetry().returned_chars, Some(4));
    assert_eq!(attempt.telemetry().sampled_output_tokens, Some(1));
    assert_eq!(attempt.telemetry().decoded_output_tokens, Some(0));
    assert_eq!(attempt.into_result().unwrap(), "한국어🙂");
}

#[test]
fn recorder_actual_repetition_guard_preserves_original_first_occurrence_cutoff() {
    let prefix = "The original synthetic note distinguishes a request, an assistant report, and a later cancellation; nothing here independently verifies implementation. ";
    let sentence = "repeat synthetic phrase.";
    let mut out = format!("{prefix}{}", sentence.repeat(6));
    let mut recorder = sampling_recorder(None);
    recorder.sampled(false);
    let reason = crate::local_llm::output_guard::apply_with_reason(&mut out, None).unwrap();
    recorder.output(&out, 0, true);
    recorder.stopped(reason);
    recorder.exhausted_budget();
    let attempt = recorder.finish(Ok(out));
    assert_eq!(
        attempt.telemetry().loop_stop,
        Some(LoopStop::LegacyRepetition)
    );
    assert_eq!(attempt.telemetry().decoded_output_tokens, Some(0));
    assert_eq!(
        attempt.into_result().unwrap(),
        format!("{prefix}{sentence}")
    );
}

#[test]
fn measured_entry_cancel_precedes_invalid_limits_and_missing_model() {
    let host = LocalLlm::load_embed_host().unwrap();
    let cancelled = AtomicBool::new(true);
    let attempt = host.generate_structured_cancellable_measured(
        "private policy",
        "private source",
        0,
        16384,
        GenerationSchema::WikiClaimsV1,
        &cancelled,
    );
    let observed = attempt.telemetry();
    assert_eq!(observed.terminal, AttemptTerminal::Cancelled);
    assert_eq!(observed.terminal_phase, GenerationPhase::Admission);
    assert_eq!(observed.error_code, None);
    assert_eq!(observed.prompt_tokens, None);
    assert_eq!(observed.prefill_completed_tokens, None);
    assert_eq!(observed.sampled_tokens, None);
    assert_eq!(observed.elapsed_micros.template, None);
    assert_eq!(observed.elapsed_micros.budget, None);
    let original = host.generate_structured_cancellable(
        "private policy",
        "private source",
        0,
        16384,
        GenerationSchema::WikiClaimsV1,
        &cancelled,
    );
    assert_eq!(attempt.into_result(), original);
    assert_eq!(original.unwrap_err(), "local generation cancelled");
    assert!(!host.chat_model_loaded());
}

#[test]
fn measured_entry_invalid_limits_precede_template_and_have_no_fake_prompt_count() {
    let host = LocalLlm::load_embed_host().unwrap();
    for (output, context, schema) in [
        (0, 4096, GenerationSchema::WikiClaimsV1),
        (1537, 4096, GenerationSchema::WikiClaimsV1),
        (769, 4096, GenerationSchema::AskAnswerV1),
        (1, 16384, GenerationSchema::WikiClaimsV1),
    ] {
        let cancelled = AtomicBool::new(false);
        let attempt = host.generate_structured_cancellable_measured(
            "private policy",
            "private source",
            output,
            context,
            schema,
            &cancelled,
        );
        assert_eq!(
            attempt.telemetry().error_code,
            Some(GenerationErrorCode::InvalidLimits)
        );
        assert_eq!(attempt.telemetry().terminal_phase, GenerationPhase::Budget);
        assert_eq!(attempt.telemetry().prompt_tokens, None);
        assert_eq!(attempt.telemetry().sampled_tokens, None);
        assert_eq!(attempt.telemetry().elapsed_micros.template, None);
        let original = host.generate_structured_cancellable(
            "private policy",
            "private source",
            output,
            context,
            schema,
            &cancelled,
        );
        assert_eq!(attempt.into_result(), original);
        assert_eq!(original.unwrap_err(), "invalid generation limits");
    }
    assert!(!host.chat_model_loaded());
}

#[test]
fn measured_entry_missing_model_retains_original_error_and_null_decode_metrics() {
    let host = LocalLlm::load_embed_host().unwrap();
    let cancelled = AtomicBool::new(false);
    let attempt = host.generate_structured_cancellable_measured(
        "private policy",
        "private source",
        256,
        4096,
        GenerationSchema::AskAnswerV1,
        &cancelled,
    );
    assert_eq!(
        attempt.telemetry().error_code,
        Some(GenerationErrorCode::ModelMissing)
    );
    assert_eq!(
        attempt.telemetry().terminal_phase,
        GenerationPhase::Template
    );
    assert_eq!(attempt.telemetry().terminal, AttemptTerminal::Failed);
    assert_eq!(attempt.telemetry().prompt_tokens, None);
    assert_eq!(attempt.telemetry().prefill_completed_batches, None);
    assert_eq!(attempt.telemetry().sampled_tokens, None);
    assert_eq!(attempt.telemetry().elapsed_micros.context_create, None);
    assert_eq!(
        attempt.telemetry().elapsed_micros.prefill_decode_calls,
        None
    );
    assert_eq!(attempt.telemetry().elapsed_micros.output_decode_calls, None);
    let original = host.generate_structured_cancellable(
        "private policy",
        "private source",
        256,
        4096,
        GenerationSchema::AskAnswerV1,
        &cancelled,
    );
    assert_eq!(attempt.into_result(), original);
    assert_eq!(original.unwrap_err(), crate::local_llm::CHAT_MODEL_MISSING);
}

#[test]
fn measured_budget_preserves_rejections_with_static_error_codes() {
    for (prompt, output, context, code) in [
        (0, 256, 4096, GenerationErrorCode::EmptyPrompt),
        (4000, 256, 4096, GenerationErrorCode::PromptDoesNotFit),
        (1, 769, 4096, GenerationErrorCode::InvalidLimits),
    ] {
        let mut recorder = Recorder::new(None, output, context);
        recorder.phase(GenerationPhase::Budget);
        let expected = crate::local_llm::validate_generation_budget(prompt, output, context, None);
        let actual = validate_measured_budget(&mut recorder, prompt, output, context, None);
        assert_eq!(actual, expected);
        let attempt = recorder.finish(actual.map(|()| "unexpected".into()));
        assert_eq!(attempt.telemetry().error_code, Some(code));
        assert_eq!(attempt.telemetry().prompt_tokens, None);
    }
}

#[test]
fn telemetry_serialization_excludes_private_result_and_uses_explicit_nulls() {
    let private = "private-prompt private-output /synthetic/vault/note.md private-request private-grant secret-error";
    let recorder = Recorder::new(Some(GenerationSchema::WikiClaimsV1), 256, 4096);
    let attempt = recorder.finish(Err(private.into()));
    let value = serde_json::to_value(attempt.telemetry()).unwrap();
    let serialized = value.to_string();
    for canary in private.split_whitespace() {
        assert!(!serialized.contains(canary));
    }
    let object = value.as_object().unwrap();
    let expected = [
        "version",
        "schema",
        "profile",
        "requestedOutputTokens",
        "requestedContextTokens",
        "promptTokens",
        "prefillCompletedTokens",
        "prefillCompletedBatches",
        "sampledTokens",
        "sampledOutputTokens",
        "decodedOutputTokens",
        "pendingUtf8Bytes",
        "assembledChars",
        "returnedChars",
        "loopStop",
        "terminal",
        "terminalPhase",
        "errorCode",
        "elapsedMicros",
    ];
    assert_eq!(object.len(), expected.len());
    for key in expected {
        assert!(object.contains_key(key), "missing allowlisted key {key}");
    }
    for key in ["promptTokens", "sampledTokens", "returnedChars", "loopStop"] {
        assert!(value[key].is_null());
    }
    assert!(value["elapsedMicros"]["admission"].is_u64());
    assert!(value["elapsedMicros"]["samplingLoop"].is_null());
    assert_eq!(attempt.into_result().unwrap_err(), private);
}

#[test]
fn recorder_wall_times_are_measured_and_unentered_phases_remain_null() {
    let outer_started = Instant::now();
    let mut recorder = Recorder::new(None, 256, 4096);
    recorder.phase(GenerationPhase::Tokenize);
    std::thread::sleep(std::time::Duration::from_millis(1));
    recorder.phase(GenerationPhase::Finalize);
    let attempt = recorder.finish(Ok("literal result".into()));
    let times = &attempt.telemetry().elapsed_micros;
    assert!(times.tokenize.unwrap() >= 1000);
    assert!(times.attempt_total >= times.tokenize.unwrap());
    assert!(times.attempt_total <= micros(outer_started));
    assert_eq!(times.prefill, None);
    assert_eq!(times.prefill_decode_calls, None);
    assert_eq!(times.output_decode_calls, None);
}

#[test]
fn default_recorder_keeps_grounded_and_freeform_profiles() {
    for schema in [
        GenerationSchema::AskAnswerV1,
        GenerationSchema::WikiClaimsV1,
        GenerationSchema::WikiClaimReviewV1(crate::local_llm::ReviewDecisions::new(2).unwrap()),
        GenerationSchema::AskAnswerReviewV1,
        GenerationSchema::SessionCompilationV1,
        GenerationSchema::SessionStructureV1,
        GenerationSchema::SessionReviewV1,
    ] {
        let attempt = Recorder::new(Some(schema), 768, 4096).finish(Err("synthetic".into()));
        assert_eq!(
            attempt.telemetry().profile,
            SamplerProfile::ExistingGroundedV1
        );
    }
    let attempt = Recorder::new(None, 768, 4096).finish(Err("synthetic".into()));
    assert_eq!(
        attempt.telemetry().profile,
        SamplerProfile::ExistingFreeformV1
    );
}

#[cfg(feature = "native-index-probe")]
#[test]
fn qa_presence_descriptor_changes_only_the_closed_profile_and_presence_value() {
    use crate::local_llm::WikiClaimsSamplerQaProfile;
    use serde_json::json;

    let baseline =
        serde_json::to_value(WikiClaimsSamplerQaProfile::ExistingGroundedV1.qa_parameters())
            .unwrap();
    assert_eq!(
        baseline,
        json!({
            "profile":"existingGroundedV1",
            "order":["grammar","penalties","top_k","top_p","temperature","dist"],
            "penaltyLastN":256,"repeatPenalty":1.0,"frequencyPenalty":0.0,
            "presencePenalty":1.5,"topK":20,"topP":0.8_f32,"minKeep":1,
            "temperature":0.7_f32,"seed":42,
        })
    );
    let candidate = serde_json::to_value(
        WikiClaimsSamplerQaProfile::ExistingGroundedNoPresenceQaV1.qa_parameters(),
    )
    .unwrap();
    let mut expected = baseline;
    expected["profile"] = json!("existingGroundedNoPresenceQaV1");
    expected["presencePenalty"] = json!(0.0);
    assert_eq!(candidate, expected);
}

#[cfg(feature = "native-index-probe")]
#[test]
fn qa_presence_entry_keeps_selected_profile_and_null_unentered_decode_metrics() {
    use crate::local_llm::WikiClaimsSamplerQaProfile;

    let host = LocalLlm::load_embed_host().unwrap();
    for (profile, label) in [
        (
            WikiClaimsSamplerQaProfile::ExistingGroundedV1,
            "existingGroundedV1",
        ),
        (
            WikiClaimsSamplerQaProfile::ExistingGroundedNoPresenceQaV1,
            "existingGroundedNoPresenceQaV1",
        ),
    ] {
        for (output, context, cancelled, terminal, phase, code, error) in [
            (
                0,
                16384,
                true,
                AttemptTerminal::Cancelled,
                GenerationPhase::Admission,
                None,
                "local generation cancelled",
            ),
            (
                1537,
                4096,
                false,
                AttemptTerminal::Failed,
                GenerationPhase::Budget,
                Some(GenerationErrorCode::InvalidLimits),
                "invalid generation limits",
            ),
            (
                1536,
                4096,
                false,
                AttemptTerminal::Failed,
                GenerationPhase::Template,
                Some(GenerationErrorCode::ModelMissing),
                crate::local_llm::CHAT_MODEL_MISSING,
            ),
        ] {
            let attempt = host.generate_wiki_claims_cancellable_measured_qa(
                "Synthetic policy",
                "Synthetic original",
                output,
                context,
                profile,
                &AtomicBool::new(cancelled),
            );
            let observed = attempt.telemetry();
            assert_eq!(serde_json::to_value(observed.profile).unwrap(), label);
            assert_eq!(observed.schema, TelemetrySchema::WikiClaimsV1);
            assert_eq!(observed.requested_output_tokens, output);
            assert_eq!(observed.requested_context_tokens, context);
            assert_eq!(observed.terminal, terminal);
            assert_eq!(observed.terminal_phase, phase);
            assert_eq!(observed.error_code, code);
            assert_eq!(observed.prompt_tokens, None);
            assert_eq!(observed.prefill_completed_tokens, None);
            assert_eq!(observed.sampled_tokens, None);
            assert_eq!(observed.elapsed_micros.context_create, None);
            assert_eq!(observed.elapsed_micros.sampler_create, None);
            assert_eq!(observed.elapsed_micros.output_decode_calls, None);
            assert_eq!(attempt.into_result().unwrap_err(), error);
        }
    }
    assert!(!host.chat_model_loaded());
}

#[cfg(feature = "native-index-probe")]
#[test]
fn qa_presence_penalty_applies_actual_installed_sampler_logits_without_weights() {
    use crate::local_llm::grounded_sampling::penalty_sampler;
    use crate::local_llm::WikiClaimsSamplerQaProfile;
    use llama_cpp_2::token::{data::LlamaTokenData, data_array::LlamaTokenDataArray, LlamaToken};

    let repeated = LlamaToken::new(1);
    let unseen = LlamaToken::new(2);
    for (profile, expected_repeated) in [
        (WikiClaimsSamplerQaProfile::ExistingGroundedV1, 8.5),
        (
            WikiClaimsSamplerQaProfile::ExistingGroundedNoPresenceQaV1,
            10.0,
        ),
    ] {
        let mut sampler = penalty_sampler(&profile.qa_parameters());
        sampler.accept(repeated);
        let mut logits = LlamaTokenDataArray::new(
            vec![
                LlamaTokenData::new(repeated, 10.0, 0.0),
                LlamaTokenData::new(unseen, 10.0, 0.0),
            ],
            false,
        );
        sampler.apply(&mut logits);
        assert_eq!(
            logits
                .data
                .iter()
                .find(|token| token.id() == repeated)
                .unwrap()
                .logit(),
            expected_repeated
        );
        assert_eq!(
            logits
                .data
                .iter()
                .find(|token| token.id() == unseen)
                .unwrap()
                .logit(),
            10.0
        );
    }
}
