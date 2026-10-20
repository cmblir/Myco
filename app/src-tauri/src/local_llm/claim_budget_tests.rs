//! Schema-specific extraction limits do not expand other generation contracts.

use super::generation_telemetry::{AttemptTerminal, GenerationErrorCode, GenerationPhase};
use super::*;

fn other_schemas() -> Vec<Option<GenerationSchema>> {
    let mut schemas = vec![
        None,
        Some(GenerationSchema::AskAnswerV1),
        Some(GenerationSchema::AskAnswerReviewV1),
        Some(GenerationSchema::SessionCompilationV1),
        Some(GenerationSchema::SessionStructureV1),
        Some(GenerationSchema::SessionReviewV1),
    ];
    schemas.extend((0..=16).map(|count| {
        Some(GenerationSchema::WikiClaimReviewV1(
            ReviewDecisions::new(count).unwrap(),
        ))
    }));
    schemas
}

#[test]
fn explicit_claim_output_preserves_exact_context_boundary_and_safety_reserve() {
    for context in [2048, 4096] {
        for output in [1, 768, 769, 1024, 1536] {
            let budget = context as usize - output as usize - GENERATION_SAFETY_TOKENS;
            assert!(validate_generation_budget(
                budget,
                output,
                context,
                Some(GenerationSchema::WikiClaimsV1),
            )
            .is_ok());
            let error = validate_generation_budget(
                budget + 1,
                output,
                context,
                Some(GenerationSchema::WikiClaimsV1),
            )
            .unwrap_err();
            assert!(error.contains("context budget exceeded"), "{error}");
        }
    }
}

#[test]
fn larger_claim_output_rejects_empty_input_and_unbounded_limits() {
    for (prompt, output, context) in [
        (0, 1536, 4096),
        (1, -1, 4096),
        (1, 0, 4096),
        (1, 1537, 4096),
        (1, i32::MAX, 4096),
        (1, 1536, 0),
        (1, 1536, 1024),
        (1, 1536, 4095),
        (1, 1536, 8192),
    ] {
        assert!(validate_generation_budget(
            prompt,
            output,
            context,
            Some(GenerationSchema::WikiClaimsV1),
        )
        .is_err());
    }
}

#[test]
fn extraction_extension_never_expands_review_answer_compilation_or_freeform() {
    for schema in other_schemas() {
        for context in [2048, 4096] {
            let boundary = context as usize - 768 - GENERATION_SAFETY_TOKENS;
            assert!(validate_generation_budget(boundary, 768, context, schema).is_ok());
            assert!(validate_generation_budget(boundary + 1, 768, context, schema).is_err());
            for output in [769, 1024, 1536] {
                let error = validate_generation_budget(1, output, context, schema).unwrap_err();
                assert!(
                    error.contains("invalid generation limits"),
                    "{schema:?}: {error}"
                );
            }
        }
    }
}

#[test]
fn ordinary_generation_keeps_its_existing_768_token_clamp() {
    for requested in [769, 1024, 1536, i32::MAX] {
        assert_eq!(generation_output_tokens(requested), 768);
    }
}

#[test]
fn explicit_claim_limit_is_admitted_without_loading_missing_chat_weights() {
    let host = LocalLlm::load_embed_host().unwrap();
    let attempt = host.generate_structured_cancellable_measured(
        "Synthetic policy",
        "Synthetic original",
        1536,
        4096,
        GenerationSchema::WikiClaimsV1,
        &AtomicBool::new(false),
    );
    assert_eq!(attempt.telemetry().requested_output_tokens, 1536);
    assert_eq!(attempt.telemetry().requested_context_tokens, 4096);
    assert_eq!(
        attempt.telemetry().error_code,
        Some(GenerationErrorCode::ModelMissing)
    );
    assert_eq!(
        attempt.telemetry().terminal_phase,
        GenerationPhase::Template
    );
    assert_eq!(attempt.telemetry().prompt_tokens, None);
    let error = attempt.into_result().unwrap_err();
    assert!(error.contains("no local chat model is bundled"), "{error}");
    assert!(!host.chat_model_loaded());
}

#[test]
fn invalid_extended_limit_fails_before_template_or_model_access() {
    let host = LocalLlm::load_embed_host().unwrap();
    for (output, context, schema) in [
        (1537, 4096, GenerationSchema::WikiClaimsV1),
        (1536, 8192, GenerationSchema::WikiClaimsV1),
        (769, 4096, GenerationSchema::AskAnswerV1),
        (
            769,
            4096,
            GenerationSchema::WikiClaimReviewV1(ReviewDecisions::new(16).unwrap()),
        ),
    ] {
        let attempt = host.generate_structured_cancellable_measured(
            "Synthetic policy",
            "Synthetic original",
            output,
            context,
            schema,
            &AtomicBool::new(false),
        );
        assert_eq!(attempt.telemetry().terminal, AttemptTerminal::Failed);
        assert_eq!(attempt.telemetry().terminal_phase, GenerationPhase::Budget);
        assert_eq!(
            attempt.telemetry().error_code,
            Some(GenerationErrorCode::InvalidLimits)
        );
        assert_eq!(attempt.telemetry().prompt_tokens, None);
        let error = attempt.into_result().unwrap_err();
        assert!(error.contains("invalid generation limits"), "{error}");
        assert!(!host.chat_model_loaded());
    }
}

#[test]
fn cancelled_extended_claim_request_never_reaches_template_or_model_access() {
    let host = LocalLlm::load_embed_host().unwrap();
    let attempt = host.generate_structured_cancellable_measured(
        "Synthetic policy",
        "Synthetic original",
        1536,
        4096,
        GenerationSchema::WikiClaimsV1,
        &AtomicBool::new(true),
    );
    assert_eq!(attempt.telemetry().terminal, AttemptTerminal::Cancelled);
    assert_eq!(
        attempt.telemetry().terminal_phase,
        GenerationPhase::Admission
    );
    assert_eq!(attempt.telemetry().error_code, None);
    assert_eq!(attempt.telemetry().prompt_tokens, None);
    let error = attempt.into_result().unwrap_err();
    assert!(error.contains("cancelled"), "{error}");
    assert!(!host.chat_model_loaded());
}
