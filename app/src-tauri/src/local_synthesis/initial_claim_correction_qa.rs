//! One source-grounded replacement, never a native semantic repair or approval.

use crate::local_llm::GenerationSchema;
use crate::retrieval::Scope;
use crate::vault_session::AgentVaultSession;
use crate::wiki_claim_review::focus_qa::NativeFocusClaimReviewQa;
use crate::wiki_claim_review::{self, AskReviewContext, ReviewFailure};
use crate::wiki_claims::focus_claims_qa::{FocusProjectionQa, PreparedFocusQa};
use crate::wiki_claims::{CheckedClaims, SourceSet};

pub(super) struct InitialAttemptQa<'a> {
    pub(super) prepared: &'a PreparedFocusQa,
    pub(super) raw: &'a str,
    pub(super) projection: &'a FocusProjectionQa,
    pub(super) claims: &'a CheckedClaims,
    pub(super) review: &'a NativeFocusClaimReviewQa,
}

pub(super) struct CorrectedInitialClaimsQa {
    pub(super) claims: CheckedClaims,
    pub(super) projection: FocusProjectionQa,
    pub(super) review: NativeFocusClaimReviewQa,
}

#[allow(clippy::too_many_arguments)] // Reuses the captured source/role generation boundary.
pub(super) fn correct(
    attempt: InitialAttemptQa<'_>,
    context: &AskReviewContext,
    packet: &SourceSet,
    origin: &AgentVaultSession,
    scope: Scope,
    output_tokens: i32,
    correction_used: &mut bool,
    token_count: &mut dyn FnMut(&str, &str) -> Result<usize, String>,
    generate: &mut impl FnMut(&str, &str, i32, u32, GenerationSchema) -> Result<String, String>,
) -> Result<CorrectedInitialClaimsQa, String> {
    if context.ordinal_activity_qa_enabled() {
        return Err("review_invalid: Ordinal activity initial correction is unsupported".into());
    }
    if !context.review_correction_qa_enabled() || *correction_used {
        return Err("review_invalid: initial correction is disabled or exhausted".into());
    }
    if !(1..=768).contains(&output_tokens) {
        return Err("review_invalid: initial correction output budget changed".into());
    }
    packet.validate(
        r#"{"outcome":"insufficient_evidence","claims":[]}"#,
        origin,
        scope,
    )?;
    let feedback = attempt
        .review
        .correction_feedback(context, packet, attempt.claims, attempt.projection)
        .map_err(|error| error.to_string())?
        .ok_or("review_invalid: initial correction requires a bound negative review")?;
    attempt.projection.verify_model_result(attempt.raw)?;
    let previous = attempt.prepared.expand(attempt.raw)?;
    if previous.canonical() != attempt.projection.canonical()
        || previous.revision() != attempt.projection.revision()
    {
        return Err("review_invalid: initial correction previous result changed".into());
    }
    attempt
        .projection
        .review_value(packet, attempt.claims, context.payload())?;
    if attempt.prepared.encoding() != context.source_focus_qa_encoding()
        || attempt.projection.encoding() != Some(context.source_focus_qa_encoding())
    {
        return Err("review_invalid: initial correction source-focus encoding changed".into());
    }
    let prepared = match attempt.prepared.encoding() {
        crate::wiki_claims::focus_claims_qa::Encoding::TupleV1 => {
            PreparedFocusQa::prepare_correction(
                attempt.prepared.original_user(),
                attempt.raw,
                &feedback,
            )?
        }
        crate::wiki_claims::focus_claims_qa::Encoding::NamedV1 => {
            PreparedFocusQa::prepare_correction_for(
                attempt.prepared.original_user(),
                attempt.raw,
                &feedback,
                attempt.prepared.encoding(),
            )?
        }
    };
    let count = token_count(prepared.system(), prepared.user())
        .map_err(ReviewFailure::generation)
        .map_err(|error| error.to_string())?;
    if count > 4096 - output_tokens as usize - 8 {
        return Err("review_not_fit: full initial correction packet cannot fit".into());
    }
    // Preparation and fit errors do not consume an actual generation allowance.
    // The captured native callback still rechecks role/Stop/source on this call.
    *correction_used = true;
    let raw = generate(
        prepared.system(),
        prepared.user(),
        output_tokens,
        4096,
        GenerationSchema::WikiSourceFocusClaimsQaV1(prepared.decoder()),
    )?;
    let projection = prepared.expand(&raw)?;
    let claims = packet.validate(projection.canonical(), origin, scope)?;
    let review = wiki_claim_review::focus_qa::run(
        context,
        packet,
        &claims,
        &projection,
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
    .map_err(|error| error.to_string())?;
    if !review.binds(context, packet, &claims, &projection) {
        return Err("review_invalid: corrected initial review binding changed".into());
    }
    review
        .require_accepted()
        .map_err(|error| error.to_string())?;
    Ok(CorrectedInitialClaimsQa {
        claims,
        projection,
        review,
    })
}

#[cfg(test)]
#[path = "initial_claim_correction_qa_tests.rs"]
mod tests;
