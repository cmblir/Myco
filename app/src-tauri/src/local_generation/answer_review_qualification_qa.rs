//! Fixed-answer, whole-original review QA; no writer inference or product authority.

use super::{ordinary_flow, ActivityFlowFailure, Request};
use crate::importers::wikify::source_revision;
use crate::local_llm::GenerationSchema;
use crate::local_model::GEMMA12B_CANDIDATE;
use crate::local_synthesis::{answer_draft, answer_review, Evidence, Prompt};
use crate::retrieval::Scope;
use crate::vault_session::AgentVaultSession;
use crate::wiki_claim_review::{self, AskReviewContext, ReviewFailure};
use crate::wiki_claims::SourceSet;
use serde_json::{json, Value};

mod inputs;

/// Exact runtime-only source/draft bytes; references and verdict labels are absent.
pub const RUNTIME_SHA256: &str = "e4c91504befb91caceed75ac90b1f6342e21fa5104cfe8a6e8051e1bcd36139c";
const RUNTIME: &str =
    include_str!("../../eval/local-wiki-answer-review-qualification-v1/runtime-inputs.json");

fn invalid(detail: impl Into<String>) -> ActivityFlowFailure {
    ActivityFlowFailure {
        code: "source_verification_failed",
        detail: detail.into(),
    }
}
fn reviewed(error: ReviewFailure) -> ActivityFlowFailure {
    ActivityFlowFailure {
        code: error.code(),
        detail: error.to_string(),
    }
}

/// One immutable fixed draft and its complete synthetic source/context binding.
/// These custody labels are not a live opening, grant or semantic approval.
pub struct PreparedReviewCase {
    id: String,
    family_id: String,
    proposal_id: String,
    request: Request,
    origin: AgentVaultSession,
    sources: SourceSet,
    evidence: Vec<Evidence>,
    declared: Value,
    original_spans: Value,
    raw_draft: String,
    fixed_draft_sha: String,
    source_packet_revision: String,
    context: AskReviewContext,
    prompt_revision: String,
}

impl PreparedReviewCase {
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn family_id(&self) -> &str {
        &self.family_id
    }
    pub fn proposal_id(&self) -> &str {
        &self.proposal_id
    }
    pub fn original_count(&self) -> usize {
        self.sources.spans().count()
    }
    pub fn raw_draft(&self) -> &str {
        &self.raw_draft
    }

    /// Inspection-only metadata, never native authorization or expected labels.
    pub fn metadata(&self) -> Value {
        json!({"caseId":self.id,"familyId":self.family_id,"proposalId":self.proposal_id,
            "fixedDraftSha256":self.fixed_draft_sha,"originalSpans":self.original_spans,
            "context":self.context.payload(),"contextRevision":self.context.revision(),
            "declaredRecordPeriodContext":self.declared,"sourcePacketRevision":self.source_packet_revision,
            "native_io_authenticated":false,"product_role_authorized":false,
            "semantic_accepted":false,"production_accepted":false,"activityContractAccepted":false})
    }

    fn checked_inputs(
        &self,
    ) -> Result<(AskReviewContext, Prompt, answer_draft::ValidatedAnswerDraft), ActivityFlowFailure>
    {
        if self.id != format!("{}-{}", self.family_id, self.proposal_id)
            || self.request.model_id.as_deref() != Some(GEMMA12B_CANDIDATE.id)
            || self.request.activity_overview
            || self.request.resolution.is_some()
            || self.request.previous_question.is_some()
            || self.request.max_tokens != Some(768)
            || self.request.scope != Scope::All
            || self.request.expected_vault != self.origin.vault_path
            || self.request.origin.as_ref().map_or(true, |origin| {
                origin.vault_path != self.origin.vault_path
                    || origin.opening_token != self.origin.opening_token
            })
            || json!(self.request.hits) != json!(self.evidence)
            || self.request.paths.as_deref()
                != Some(
                    self.evidence
                        .iter()
                        .map(|e| e.page.clone())
                        .collect::<Vec<_>>()
                        .as_slice(),
                )
            || source_revision(&self.raw_draft) != self.fixed_draft_sha
            || wiki_claim_review::revision(&self.sources).map_err(reviewed)?
                != self.source_packet_revision
            || json!(self.sources.spans().collect::<Vec<_>>()) != self.original_spans
        {
            return Err(invalid(
                "fixed review case source/request/draft binding changed",
            ));
        }
        let role = self
            .request
            .role_snapshot
            .as_ref()
            .ok_or_else(|| invalid("fixed review synthetic role absent"))?;
        if role.route_signature.model_id != GEMMA12B_CANDIDATE.id
            || role.route_signature.artifact_revision.as_deref()
                != Some(GEMMA12B_CANDIDATE.revision)
            || role.route_signature.artifact_sha256.as_deref() != Some(GEMMA12B_CANDIDATE.sha256)
        {
            return Err(invalid("fixed review synthetic model identity changed"));
        }
        let context = AskReviewContext::for_question(
            &self.origin,
            role,
            &self.request.request_id,
            &self.request.question,
            None,
            &self.request.lang,
            self.request.scope,
            self.request.range.as_ref(),
            self.request.paths.as_deref(),
        )
        .map_err(reviewed)?
        .with_answer_review_qualification_qa(&self.family_id, &self.declared)
        .map_err(reviewed)?;
        if context.revision() != self.context.revision() {
            return Err(invalid("fixed review qualification context changed"));
        }
        context.check_packet(&self.sources).map_err(reviewed)?;
        let prompt =
            ordinary_flow::original_prompt(&self.request, &self.evidence, &self.sources, &context)?;
        let draft =
            answer_draft::validate_answer_draft(&self.raw_draft, &prompt, &self.request.lang)
                .map_err(|detail| ActivityFlowFailure {
                    code: "review_invalid",
                    detail,
                })?;
        if draft.prompt_revision() != self.prompt_revision {
            return Err(invalid("fixed review prompt changed"));
        }
        Ok((context, prompt, draft))
    }

    /// Validate a fixed untrusted draft and run exactly one ordinary Flat review.
    /// A valid rejected/uncertain verdict is an observation, never semantic truth.
    pub fn run(
        &self,
        token_count: impl FnMut(&str, &str) -> Result<usize, String>,
        mut generate: impl FnMut(&str, &str, i32, u32, GenerationSchema) -> Result<String, String>,
    ) -> Result<Value, ActivityFlowFailure> {
        let (context, prompt, draft) = self.checked_inputs()?;
        let review = answer_review::run(
            &context,
            &self.sources,
            &prompt,
            &draft,
            token_count,
            |system, user, output, context| {
                generate(
                    system,
                    user,
                    output,
                    context,
                    GenerationSchema::AskAnswerReviewV1,
                )
            },
        )
        .map_err(reviewed)?;
        if !review.binds(&context, &self.sources, &prompt, &draft) {
            return Err(ActivityFlowFailure {
                code: "review_invalid",
                detail: "fixed review receipt binding changed".into(),
            });
        }
        let accepted = review.require_accepted();
        let rejection_code = accepted.as_ref().err().map(|error| error.code());
        let rejection_detail = accepted.as_ref().err().map(ToString::to_string);
        Ok(
            json!({"caseId":self.id,"familyId":self.family_id,"proposalId":self.proposal_id,
            "fixedDraftSha256":self.fixed_draft_sha,"automatedAccepted":accepted.is_ok(),
            "reviewReceipt":review,"automatedAnswerReviewInputRevision":review.input_revision(),
            "rejectionCode":rejection_code,"rejectionDetail":rejection_detail,
            "writerGenerations":0,"maximumReviewGenerations":1,
            "native_io_authenticated":false,"product_role_authorized":false,
            "semantic_accepted":false,"production_accepted":false,"activityContractAccepted":false}),
        )
    }
}

/// Bind and structurally validate all sixteen scheduled drafts before model access.
pub fn prepare_all() -> Result<Vec<PreparedReviewCase>, String> {
    if source_revision(RUNTIME) != RUNTIME_SHA256 {
        return Err("compiled fixed-review runtime SHA changed".into());
    }
    inputs::prepare(serde_json::from_str(RUNTIME).map_err(|error| error.to_string())?)
}

/// Runtime-only complete-container pins; no reference facts or expected verdicts.
pub fn corpus_manifest() -> Value {
    match inputs::inventory(RUNTIME) {
        Ok(value) => value,
        Err(error) => json!({"valid":false,"error":error}),
    }
}

#[cfg(test)]
#[path = "answer_review_qualification_qa_tests.rs"]
mod tests;
