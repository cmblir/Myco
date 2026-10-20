use super::*;
use llama_cpp_2::token::{data::LlamaTokenData, data_array::LlamaTokenDataArray, LlamaToken};
use serde_json::json;

#[test]
fn family_descriptor_preserves_every_parameter_except_the_registered_three() {
    let mut expected =
        serde_json::to_value(WikiClaimsSamplerQaProfile::ExistingGroundedV1.qa_parameters())
            .unwrap();
    expected["profile"] = json!("gemmaInstructionFamilyQaV1");
    expected["topK"] = json!(64);
    expected["topP"] = json!(0.95_f32);
    expected["temperature"] = json!(1.0_f32);
    assert_eq!(
        serde_json::to_value(
            WikiClaimsSamplerQaProfile::GemmaInstructionFamilyQaV1.qa_parameters(),
        )
        .unwrap(),
        expected
    );
}

#[test]
fn family_entry_retains_qa_label_on_cancel_and_missing_model_without_decoding() {
    let host = LocalLlm::load_embed_host().unwrap();
    for cancelled in [true, false] {
        let attempt = host.generate_wiki_claims_cancellable_measured_qa(
            "Synthetic policy",
            "Synthetic original",
            1536,
            4096,
            WikiClaimsSamplerQaProfile::GemmaInstructionFamilyQaV1,
            &AtomicBool::new(cancelled),
        );
        let t = attempt.telemetry();
        assert_eq!(t.profile, SamplerProfile::GemmaInstructionFamilyQaV1);
        assert_eq!(t.prompt_tokens, None);
        assert_eq!(t.sampled_tokens, None);
        assert_eq!(t.elapsed_micros.sampler_create, None);
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
}

#[test]
fn gemma_activity_entry_retains_typed_schema_profile_and_early_failure_guards() {
    use crate::retrieval::Scope;
    use crate::vault_session::AgentVaultSession;
    use crate::wiki_claims::focus_claims_qa::PreparedOrdinalActivityQa;
    use crate::wiki_claims::{ActorRole, SourceDocument, SourceSet, SpanInput};
    use generation_telemetry::{AttemptTerminal, TelemetrySchema};

    let origin = AgentVaultSession {
        vault_path: "/synthetic/gemma-activity-sampler".into(),
        opening_token: "synthetic-opening".into(),
    };
    let text = "The synthetic maintainer completed a draft.";
    let document = SourceDocument::bind(
        "S1".into(),
        "sessions/sampler.md".into(),
        "sessions/sampler.md".into(),
        text,
        Some("2026-10-03".into()),
        vec![SpanInput {
            id: "Q1".into(),
            start: 0,
            end: text.len(),
            turn_id: "T1".into(),
            speaker: ActorRole::User,
            turn_time: None,
        }],
    )
    .unwrap();
    let sources = SourceSet::new(origin.clone(), Scope::All, vec![document], vec![]).unwrap();
    let range = crate::commands::DateRange {
        start: "2026-10-01".into(),
        end: "2026-10-04".into(),
        start_epoch: None,
        end_epoch: None,
    };
    let user = crate::local_synthesis::claim_prompt::payload(
        "Summarize recent work",
        "en",
        &range,
        &sources.spans().collect::<Vec<_>>(),
    )
    .unwrap();
    let mut context: serde_json::Value = serde_json::from_str(&user).unwrap();
    context["sourceFocusQaEncoding"] = json!("ordinal_activity_v3");
    let prepared = PreparedOrdinalActivityQa::prepare(
        &user,
        &sources,
        &origin,
        Scope::All,
        &context,
        &"0".repeat(64),
    )
    .unwrap();
    let decoder = prepared.decoder();
    let schema = GenerationSchema::NativeActivityTypesQaV2(decoder);
    let grammar = decoder.grammar();
    let grammar_sha256 = schema.qa_grammar_sha256();
    let host = LocalLlm::load_embed_host().unwrap();
    for (cancelled, output, context_tokens, error, error_code, phase, terminal) in [
        (
            true,
            768,
            4096,
            "local generation cancelled",
            None,
            GenerationPhase::Admission,
            AttemptTerminal::Cancelled,
        ),
        (
            true,
            0,
            16384,
            "local generation cancelled",
            None,
            GenerationPhase::Admission,
            AttemptTerminal::Cancelled,
        ),
        (
            false,
            768,
            4096,
            CHAT_MODEL_MISSING,
            Some(GenerationErrorCode::ModelMissing),
            GenerationPhase::Template,
            AttemptTerminal::Failed,
        ),
        (
            false,
            0,
            4096,
            "invalid generation limits",
            Some(GenerationErrorCode::InvalidLimits),
            GenerationPhase::Budget,
            AttemptTerminal::Failed,
        ),
        (
            false,
            769,
            4096,
            "invalid generation limits",
            Some(GenerationErrorCode::InvalidLimits),
            GenerationPhase::Budget,
            AttemptTerminal::Failed,
        ),
        (
            false,
            768,
            16384,
            "invalid generation limits",
            Some(GenerationErrorCode::InvalidLimits),
            GenerationPhase::Budget,
            AttemptTerminal::Failed,
        ),
    ] {
        let attempt = host.generate_gemma_activity_types_cancellable_measured_qa(
            prepared.system(),
            prepared.user(),
            output,
            context_tokens,
            decoder,
            &AtomicBool::new(cancelled),
        );
        let telemetry = attempt.telemetry();
        assert_eq!(telemetry.schema, TelemetrySchema::NativeActivityTypesQaV2);
        assert_eq!(
            telemetry.profile,
            SamplerProfile::GemmaInstructionFamilyQaV1
        );
        assert_eq!(telemetry.requested_output_tokens, output);
        assert_eq!(telemetry.requested_context_tokens, context_tokens);
        assert_eq!(telemetry.error_code, error_code);
        assert_eq!(telemetry.terminal_phase, phase);
        assert_eq!(telemetry.terminal, terminal);
        assert_eq!(telemetry.prompt_tokens, None);
        assert_eq!(telemetry.prefill_completed_tokens, None);
        assert_eq!(telemetry.sampled_tokens, None);
        assert_eq!(telemetry.elapsed_micros.context_create, None);
        assert_eq!(telemetry.elapsed_micros.sampler_create, None);
        assert_eq!(attempt.into_result().unwrap_err(), error);
        assert!(!host.chat_model_loaded());
    }
    // The regular entry stays grounded even for the identical activity schema.
    let ordinary = host.generate_structured_cancellable_measured(
        prepared.system(),
        prepared.user(),
        768,
        4096,
        schema,
        &AtomicBool::new(true),
    );
    assert_eq!(
        ordinary.telemetry().schema,
        TelemetrySchema::NativeActivityTypesQaV2
    );
    assert_eq!(
        ordinary.telemetry().profile,
        SamplerProfile::ExistingGroundedV1
    );
    assert_eq!(ordinary.telemetry().sampled_tokens, None);
    assert_eq!(
        ordinary.into_result().unwrap_err(),
        "local generation cancelled"
    );
    assert_eq!(decoder.grammar(), grammar);
    assert_eq!(schema.qa_grammar_sha256(), grammar_sha256);
    for (cancelled, output, context_tokens, expected_error) in [
        (true, 0, 16384, "local generation cancelled"),
        (false, 0, 4096, "invalid generation limits"),
        (false, 768, 4096, CHAT_MODEL_MISSING),
    ] {
        let attempt = host.generate_gemma12b_ordinal_cancellable_measured_qa(
            prepared.system(),
            prepared.user(),
            output,
            context_tokens,
            schema,
            &AtomicBool::new(cancelled),
        );
        assert_eq!(
            attempt.telemetry().profile,
            SamplerProfile::Gemma12BOrdinalQaV1
        );
        assert_eq!(
            attempt.telemetry().schema,
            TelemetrySchema::NativeActivityTypesQaV2
        );
        assert_eq!(attempt.telemetry().elapsed_micros.context_create, None);
        assert_eq!(attempt.telemetry().elapsed_micros.sampler_create, None);
        assert_eq!(attempt.telemetry().sampled_tokens, None);
        assert_eq!(attempt.into_result().unwrap_err(), expected_error);
    }
    assert_eq!(decoder.grammar(), grammar);
    assert_eq!(schema.qa_grammar_sha256(), grammar_sha256);
    assert!(!host.chat_model_loaded());
}

#[test]
fn gemma12b_ordinal_descriptor_has_project_inert_penalties_and_fixed_family_values() {
    let mut expected =
        serde_json::to_value(WikiClaimsSamplerQaProfile::ExistingGroundedV1.qa_parameters())
            .unwrap();
    expected["profile"] = json!("gemma12BOrdinalQaV1");
    expected["topK"] = json!(64);
    expected["topP"] = json!(0.95_f32);
    expected["temperature"] = json!(1.0_f32);
    expected["presencePenalty"] = json!(0.0_f32);
    let parameters = WikiClaimsSamplerQaProfile::Gemma12BOrdinalQaV1.qa_parameters();
    assert_eq!(serde_json::to_value(parameters).unwrap(), expected);
    assert_eq!(
        grounded_sampling::structured_parameters(SamplerProfile::Gemma12BOrdinalQaV1).unwrap(),
        parameters
    );
    let mut penalties = grounded_sampling::penalty_sampler(&parameters);
    penalties.accept(LlamaToken::new(0));
    let mut candidates = logits(2, 10.0);
    penalties.apply(&mut candidates);
    assert_eq!(candidates.data[0].logit(), 10.0);
    assert_eq!(candidates.data[1].logit(), 10.0);
    assert_eq!(LlamaSampler::dist(parameters.seed).get_seed(), 42);
}

#[test]
fn gemma12b_ordinal_stage_entries_keep_profile_and_limits_before_model_access() {
    use generation_telemetry::AttemptTerminal;
    let host = LocalLlm::load_embed_host().unwrap();
    for (stage, schema, output, context) in [
        ("planner", GenerationSchema::AskAnswerV1, 64, 2048),
        (
            "claim_review",
            GenerationSchema::WikiClaimReviewV1(ReviewDecisions::new(1).unwrap()),
            768,
            4096,
        ),
        ("later", GenerationSchema::WikiClaimsV1, 768, 4096),
        ("writer", GenerationSchema::AskAnswerV1, 768, 4096),
        ("final", GenerationSchema::AskAnswerReviewV1, 768, 4096),
    ] {
        for (cancelled, actual_output, actual_context, error, error_code, phase, terminal) in [
            (
                true,
                0,
                16384,
                "local generation cancelled",
                None,
                GenerationPhase::Admission,
                AttemptTerminal::Cancelled,
            ),
            (
                false,
                0,
                context,
                "invalid generation limits",
                Some(GenerationErrorCode::InvalidLimits),
                GenerationPhase::Budget,
                AttemptTerminal::Failed,
            ),
            (
                false,
                output,
                16384,
                "invalid generation limits",
                Some(GenerationErrorCode::InvalidLimits),
                GenerationPhase::Budget,
                AttemptTerminal::Failed,
            ),
            (
                false,
                output,
                context,
                CHAT_MODEL_MISSING,
                Some(GenerationErrorCode::ModelMissing),
                GenerationPhase::Template,
                AttemptTerminal::Failed,
            ),
        ] {
            let attempt = host.generate_gemma12b_ordinal_cancellable_measured_qa(
                "Synthetic policy",
                "Synthetic original",
                actual_output,
                actual_context,
                schema,
                &AtomicBool::new(cancelled),
            );
            let telemetry = attempt.telemetry();
            assert_eq!(
                telemetry.profile,
                SamplerProfile::Gemma12BOrdinalQaV1,
                "{stage}"
            );
            assert_eq!(
                telemetry.schema,
                generation_telemetry::TelemetrySchema::from(Some(schema)),
                "{stage}"
            );
            assert_eq!(telemetry.requested_output_tokens, actual_output);
            assert_eq!(telemetry.requested_context_tokens, actual_context);
            assert_eq!(telemetry.error_code, error_code);
            assert_eq!(telemetry.terminal_phase, phase);
            assert_eq!(telemetry.terminal, terminal);
            assert_eq!(telemetry.prompt_tokens, None);
            assert_eq!(telemetry.sampled_tokens, None);
            assert_eq!(telemetry.elapsed_micros.context_create, None);
            assert_eq!(telemetry.elapsed_micros.sampler_create, None);
            assert_eq!(attempt.into_result().unwrap_err(), error, "{stage}");
        }
    }
    assert!(!host.chat_model_loaded());
}

#[test]
fn gemma12b_ordinal_entry_rejects_unrelated_schemas_before_model_access() {
    let host = LocalLlm::load_embed_host().unwrap();
    for schema in [
        GenerationSchema::WikiQuotedClaimsQaV1,
        GenerationSchema::WikiClaimReviewReasonFirstQaV1(ReviewDecisions::new(1).unwrap()),
        GenerationSchema::WikiClaimFieldReviewQaV1,
        GenerationSchema::WikiSourceCoverageQaV1,
        GenerationSchema::SessionCompilationV1,
        GenerationSchema::SessionStructureV1,
        GenerationSchema::SessionReviewV1,
    ] {
        let attempt = host.generate_gemma12b_ordinal_cancellable_measured_qa(
            "Synthetic policy",
            "Synthetic original",
            64,
            2048,
            schema,
            &AtomicBool::new(false),
        );
        assert_eq!(
            attempt.telemetry().profile,
            SamplerProfile::Gemma12BOrdinalQaV1
        );
        assert_eq!(
            attempt.telemetry().error_code,
            Some(GenerationErrorCode::InvalidGemma12BOrdinalQaContract)
        );
        assert_eq!(
            attempt.telemetry().terminal_phase,
            GenerationPhase::Admission
        );
        assert_eq!(attempt.telemetry().elapsed_micros.context_create, None);
        assert_eq!(
            attempt.into_result().unwrap_err(),
            "Gemma 12B ordinal QA rejects this schema"
        );
    }
    assert!(!host.chat_model_loaded());
}

#[test]
fn gemma12b_ordinal_template_policy_requires_exact_architecture_and_digest() {
    assert!(gemma12b_ordinal_qa_template(
        "gemma4",
        gemma4::DENSE_12B_TEMPLATE_SHA256
    ));
    for (architecture, digest) in [
        ("qwen35", gemma4::DENSE_12B_TEMPLATE_SHA256),
        ("gemma4 ", gemma4::DENSE_12B_TEMPLATE_SHA256),
        (
            "gemma4",
            "0a2c8073c878ab1da004bee933a998606537bbb62016310352c7285c3f01c5b5",
        ),
        ("gemma4", "unverified"),
        ("gemma4", ""),
    ] {
        assert!(!gemma12b_ordinal_qa_template(architecture, digest));
    }
}

#[test]
#[ignore = "requires the exact pinned MYCO_CHAT_MODEL_PATH; vocabulary only, no context/forward"]
fn gemma12b_ordinal_entry_binds_actual_loaded_and_cached_templates_before_context() {
    let manifest = crate::local_model::GEMMA12B_CANDIDATE;
    let path = PathBuf::from(
        std::env::var_os("MYCO_CHAT_MODEL_PATH").expect("explicit pinned artifact path required"),
    );
    assert!(path.is_absolute());
    assert_eq!(path.file_name(), Some(std::ffi::OsStr::new(manifest.file)));
    let metadata = std::fs::symlink_metadata(&path).unwrap();
    assert!(metadata.is_file());
    assert_eq!(metadata.len(), manifest.bytes);
    assert_eq!(path.canonicalize().unwrap(), path);
    assert_eq!(embed_model_fingerprint(&path).unwrap(), manifest.sha256);
    let params = LlamaModelParams::default()
        .with_vocab_only(true)
        .with_n_gpu_layers(0);
    assert!(params.vocab_only());
    assert_eq!(params.n_gpu_layers(), 0);
    let model = LlamaModel::load_from_file(shared_backend().unwrap(), &path, &params).unwrap();
    let template = model.chat_template(None).unwrap();
    let mut host = LocalLlm::load_embed_host().unwrap();
    host.chat = Some(ResidentChat::new(model, None).unwrap());
    host.template = Some(template);
    host.require_gemma12b_ordinal_qa_model().unwrap();
    let actual_template = host.template.take().unwrap();
    for (cached, error) in [
        (
            LlamaChatTemplate::new("unverified cached template").unwrap(),
            "Gemma 12B ordinal QA requires the pinned loaded template",
        ),
        (actual_template, "empty user prompt"),
    ] {
        host.template = Some(cached);
        // Empty user input stops after the template gate, before token/context work.
        let attempt = host.generate_gemma12b_ordinal_cancellable_measured_qa(
            "Synthetic policy",
            "",
            64,
            2048,
            GenerationSchema::AskAnswerV1,
            &AtomicBool::new(false),
        );
        assert_eq!(
            attempt.telemetry().profile,
            SamplerProfile::Gemma12BOrdinalQaV1
        );
        assert_eq!(
            attempt.telemetry().error_code,
            Some(GenerationErrorCode::TemplateFailed)
        );
        assert_eq!(
            attempt.telemetry().terminal_phase,
            GenerationPhase::Template
        );
        assert_eq!(attempt.telemetry().prompt_tokens, None);
        assert_eq!(attempt.telemetry().elapsed_micros.context_create, None);
        assert_eq!(attempt.telemetry().elapsed_micros.sampler_create, None);
        assert_eq!(attempt.telemetry().sampled_tokens, None);
        assert_eq!(attempt.into_result().unwrap_err(), error);
    }
    drop(host.chat.take());
    host.template = None;
    assert!(!host.chat_model_loaded());
}

fn logits(count: i32, value: f32) -> LlamaTokenDataArray {
    LlamaTokenDataArray::from_iter(
        (0..count).map(|id| LlamaTokenData::new(LlamaToken::new(id), value, 0.0)),
        false,
    )
}

#[test]
fn registered_family_values_change_installed_numeric_sampler_effects() {
    for (profile, kept_k, kept_p, temperature_logit) in [
        (
            WikiClaimsSamplerQaProfile::ExistingGroundedV1,
            20,
            4,
            3.0 / 0.7_f32,
        ),
        (
            WikiClaimsSamplerQaProfile::GemmaInstructionFamilyQaV1,
            64,
            5,
            3.0,
        ),
    ] {
        let p = profile.qa_parameters();
        let mut candidates = logits(65, 1.0);
        LlamaSampler::top_k(p.top_k).apply(&mut candidates);
        assert_eq!(candidates.data.len(), kept_k);
        let mut candidates = logits(5, 1.0);
        LlamaSampler::top_p(p.top_p, p.min_keep).apply(&mut candidates);
        assert_eq!(candidates.data.len(), kept_p);
        let mut candidates = logits(2, 3.0);
        LlamaSampler::temp(p.temperature).apply(&mut candidates);
        assert!((candidates.data[0].logit() - temperature_logit).abs() < 1e-6);
        let mut penalty = grounded_sampling::penalty_sampler(&p);
        penalty.accept(LlamaToken::new(0));
        let mut candidates = logits(2, 10.0);
        penalty.apply(&mut candidates);
        assert_eq!(candidates.data[0].logit(), 8.5);
        assert_eq!(candidates.data[1].logit(), 10.0);
        assert_eq!(LlamaSampler::dist(p.seed).get_seed(), 42);
    }
}
