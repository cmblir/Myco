//! QA-only source-bound claim review; no native IO, grants or publication.

use super::{ActivityFlowFailure, Request};
use crate::local_llm::GenerationSchema;
use crate::vault_session::AgentVaultSession;
use crate::wiki_claim_review::{self, AskReviewContext, ReviewFailure};
use crate::wiki_claims::SourceSet;
use serde_json::{json, Value};

/// Observe the current production reviewer with explicit synthetic bindings.
/// The host must separately authenticate real openings, roles and raw bytes.
/// Coverage includes every original span in the supplied packet; binding a raw
/// file's revision does not assert that all its turns were supplied for review.
pub fn run(
    request: &Request,
    sources: &SourceSet,
    current_origin: &AgentVaultSession,
    proposal_json: &str,
    token_count: impl FnMut(&str, &str) -> Result<usize, String>,
    mut generate: impl FnMut(&str, &str, i32, u32, GenerationSchema) -> Result<String, String>,
) -> Result<Value, ActivityFlowFailure> {
    if request.activity_overview
        || request.resolution.is_some()
        || request.expected_vault != current_origin.vault_path
        || request.origin.as_ref().map_or(true, |origin| {
            origin.vault_path != current_origin.vault_path
                || origin.opening_token != current_origin.opening_token
        })
    {
        return Err(failure(
            "source_verification_failed",
            "claim review probe requires its unchanged opening and request kind",
        ));
    }
    let role = request.role_snapshot.as_ref().ok_or_else(|| {
        failure(
            "source_verification_failed",
            "claim review probe requires its captured selection",
        )
    })?;
    let context = AskReviewContext::for_question(
        current_origin,
        role,
        &request.request_id,
        &request.question,
        request.previous_question.as_deref(),
        &request.lang,
        request.scope,
        request.range.as_ref(),
        request.paths.as_deref(),
    )
    .map_err(reviewed_failure)?;
    sources
        .validate(
            r#"{"outcome":"insufficient_evidence","claims":[]}"#,
            current_origin,
            request.scope,
        )
        .map_err(|detail| failure("source_verification_failed", detail))?;
    let claims = sources
        .validate(proposal_json, current_origin, request.scope)
        .map_err(|detail| failure("claim_extraction_failed", detail))?;
    let review = wiki_claim_review::run(
        &context,
        sources,
        &claims,
        token_count,
        |system, user, output, context, decisions| {
            generate(
                system,
                user,
                output,
                context,
                GenerationSchema::WikiClaimReviewV1(decisions),
            )
        },
    )
    .map_err(reviewed_failure)?;
    if !review.binds(&context, sources, &claims) {
        return Err(failure(
            "review_invalid",
            "claim review input binding changed",
        ));
    }
    let acceptance = review.require_accepted();
    let acceptance_failure = acceptance
        .as_ref()
        .err()
        .map(|error| json!({"code":error.code(),"detail":error.to_string()}));
    Ok(json!({
        "review":review,"automatedReviewAccepted":acceptance.is_ok(),
        "acceptanceFailure":acceptance_failure,
        "claimSourceAndStructureChecked":true,"proposedClaims":claims.claims.len(),
        "suppliedOriginalSpans":sources.spans().count(),"reviewBindsInput":true,
        "native_io_authenticated":false,"product_role_authorized":false,
        "semantic_accepted":false,"production_accepted":false,
    }))
}

fn failure(code: &'static str, detail: impl Into<String>) -> ActivityFlowFailure {
    ActivityFlowFailure {
        code,
        detail: detail.into(),
    }
}

fn reviewed_failure(error: ReviewFailure) -> ActivityFlowFailure {
    failure(error.code(), error.to_string())
}

#[cfg(test)]
#[path = "review_probe_tests.rs"]
mod tests;
