//! Explicit synthetic activity-reading diagnostic; never activity acceptance or native authority.

use super::{ordinary_flow, ActivityFlowFailure, Request};
use crate::local_llm::GenerationSchema;
use crate::local_model::GEMMA12B_CANDIDATE;
use crate::local_synthesis::original_groups_qa::QaWireFormat;
use crate::local_synthesis::Evidence;
use crate::retrieval::Scope;
use crate::vault_session::AgentVaultSession;
use crate::wiki_claim_review::AskReviewContext;
use crate::wiki_claims::SourceSet;
use serde_json::{json, Value};

pub mod development;
pub use super::ordinary_flow::KoAdvicePolicyQa;

/// The two fixed user questions admitted by this isolated diagnostic.
pub const QUESTIONS: [&str; 2] = [
    "내가 최근에 한 일들에 대해서 정리해줘",
    "내가 앞으로 어떤 작업을 하는게 좋을까?",
];

/// Diagnostic synthetic bindings do not establish a live opening or execution grant.
/// The caller retains exact raw generation observations even when this returns Err.
pub fn run(
    request: &Request,
    evidence: &[Evidence],
    sources: &SourceSet,
    current_origin: &AgentVaultSession,
    token_count: impl Fn(&str, &str) -> Result<usize, String>,
    generate: impl FnMut(&str, &str, i32, u32, GenerationSchema) -> Result<String, String>,
) -> Result<Value, ActivityFlowFailure> {
    run_bound(
        request,
        evidence,
        sources,
        current_origin,
        2,
        QaWireFormat::Flat,
        None,
        token_count,
        generate,
    )
}

#[allow(clippy::too_many_arguments)] // Shared diagnostic boundary; no new native grant.
fn run_bound(
    request: &Request,
    evidence: &[Evidence],
    sources: &SourceSet,
    current_origin: &AgentVaultSession,
    expected_spans: usize,
    format: QaWireFormat,
    advice_policy: Option<KoAdvicePolicyQa>,
    token_count: impl Fn(&str, &str) -> Result<usize, String>,
    generate: impl FnMut(&str, &str, i32, u32, GenerationSchema) -> Result<String, String>,
) -> Result<Value, ActivityFlowFailure> {
    let invalid = |detail: &str| ActivityFlowFailure {
        code: "source_verification_failed",
        detail: detail.into(),
    };
    if advice_policy.is_some() && (request.question != QUESTIONS[1] || request.lang != "ko") {
        return Err(invalid(
            "KO advice policy QA requires its fixed advice question and language",
        ));
    }
    if !request.activity_overview
        || request.previous_question.is_some()
        || request.model_id.as_deref() != Some(GEMMA12B_CANDIDATE.id)
        || !QUESTIONS.contains(&request.question.as_str())
        || request.lang != "ko"
        || request.scope != Scope::All
        || request.max_tokens != Some(768)
        || request.expected_vault != current_origin.vault_path
        || request.origin.as_ref().map_or(true, |origin| {
            origin.vault_path != current_origin.vault_path
                || origin.opening_token != current_origin.opening_token
        })
        || sources.spans().count() != expected_spans
    {
        return Err(invalid(
            "direct reading requires the explicit two-original synthetic activity contract",
        ));
    }
    let role = request
        .role_snapshot
        .as_ref()
        .ok_or_else(|| invalid("direct reading requires its synthetic captured role binding"))?;
    if role.route_signature.model_id != GEMMA12B_CANDIDATE.id
        || role.route_signature.artifact_revision.as_deref() != Some(GEMMA12B_CANDIDATE.revision)
        || role.route_signature.artifact_sha256.as_deref() != Some(GEMMA12B_CANDIDATE.sha256)
    {
        return Err(invalid(
            "direct reading synthetic role model identity changed",
        ));
    }
    let range = request
        .range
        .as_ref()
        .ok_or_else(|| invalid("direct reading period is absent"))?;
    let resolution = request
        .resolution
        .as_ref()
        .ok_or_else(|| invalid("direct reading resolution context is absent"))?;
    let window = resolution
        .checked_window(range, resolution.captured_query_epoch)
        .map_err(|error| invalid(&error))?;
    let context = AskReviewContext::new(
        current_origin,
        role,
        &request.request_id,
        &request.question,
        &request.lang,
        request.scope,
        range,
        Some(&window),
        request.paths.as_deref(),
    )
    .map_err(|error| invalid(&error.to_string()))?;
    sources
        .validate(
            r#"{"outcome":"insufficient_evidence","claims":[]}"#,
            current_origin,
            request.scope,
        )
        .map_err(|error| invalid(&error))?;
    let answer = match advice_policy {
        Some(policy) => ordinary_flow::run_with_advice_policy_qa(
            request,
            evidence,
            sources,
            &context,
            (format, policy),
            token_count,
            generate,
        ),
        None => ordinary_flow::run_with_wire_format_qa(
            request,
            evidence,
            sources,
            &context,
            format,
            token_count,
            generate,
        ),
    }?;
    Ok(
        json!({"diagnosticAnswer":answer.answer,"usedSources":answer.used_sources,
        "automatedAnswerReviewInputRevision":answer.receipt.automated_answer_review_input_revision,
        "suppliedOriginalSpans":sources.spans().count(),"automatedWholeAnswerReviewAccepted":true,
        "native_io_authenticated":false,"product_role_authorized":false,
        "semantic_accepted":false,"production_accepted":false,
        "activityClaimReview":"not_run","activityContractAccepted":false}),
    )
}

#[cfg(test)]
#[path = "direct_reading_qa_tests.rs"]
mod tests;
