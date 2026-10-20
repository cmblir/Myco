//! The shared production/probe activity flow over frozen original source spans.

use super::Request;
use crate::activity_recall::period_context::{self, PeriodSpanCounts};
use crate::activity_recall::{
    self, AdditionalSourceDeclaration, ResolutionCoverage, ResolutionSources, ResolutionTaskKey,
    ResolutionWindow,
};
use crate::local_llm::GenerationSchema;
use crate::local_synthesis::{self, claim_prompt, Evidence};
use crate::retrieval::Scope;
use crate::vault_session::AgentVaultSession;
use crate::wiki_claim_review::{AskReviewContext, ReviewFailure};
use crate::wiki_claims::{ClaimOutcome, SourceSet};

#[path = "activity_draft.rs"]
mod activity_draft;
#[path = "resolution_prompt.rs"]
mod resolution_prompt;
#[cfg(feature = "native-index-probe")]
use crate::native_ask_probe::{FocusTokenBudgetQa, FocusTokenPhaseQa};
use serde::Serialize;

#[cfg(feature = "native-index-probe")]
pub(super) type FocusTokenObserverQa<'a> =
    dyn Fn(FocusTokenPhaseQa, &str, &str, &Result<usize, String>, FocusTokenBudgetQa) + 'a;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityPeriodReceipt {
    pub start: String,
    pub end: String,
    pub start_epoch: Option<i64>,
    pub end_epoch: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityReceipt {
    pub activity_period: ActivityPeriodReceipt,
    pub scope: Scope,
    pub eligible_original_spans: usize,
    pub original_period_counts: PeriodSpanCounts,
    pub bounded_windows: usize,
    pub processed_windows: usize,
    pub omitted_windows: usize,
    pub extraction_batches: usize,
    pub proposed_claims: usize,
    pub selected_claims: usize,
    pub omitted_claims: usize,
    pub answer_original_spans: usize,
    pub answer_period_counts: PeriodSpanCounts,
    pub claim_source_and_structure_checked: bool,
    pub semantic_review_required: bool,
    pub automated_claim_reviews: usize,
    #[cfg(feature = "native-index-probe")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initial_extraction_corrections: Option<usize>,
    #[cfg(feature = "native-index-probe")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answer_corrections: Option<usize>,
    pub automated_answer_review_input_revision: String,
    pub original_inputs_incomplete: bool,
    pub independent_verification_receipts: usize,
    pub resolution_window: Option<ResolutionWindow>,
    pub resolution_coverage: Option<ResolutionCoverage>,
    pub additional_sources: Vec<AdditionalSourceDeclaration>,
}

#[derive(Debug)]
pub struct ActivityFlowOutput {
    pub answer: String,
    pub used_sources: Vec<String>,
    pub selected_chunks: usize,
    pub receipt: ActivityReceipt,
}

#[derive(Debug, Serialize)]
pub struct ActivityFlowFailure {
    pub code: &'static str,
    pub detail: String,
}

fn failure(code: &'static str, detail: impl Into<String>) -> ActivityFlowFailure {
    ActivityFlowFailure {
        code,
        detail: detail.into(),
    }
}

fn review_failure(reason: ReviewFailure) -> ActivityFlowFailure {
    failure(reason.code(), reason.to_string())
}

fn extraction_failure(reason: String) -> ActivityFlowFailure {
    let code = [
        "review_rejected",
        "review_uncertain",
        "review_missing",
        "review_invalid",
        "review_not_fit",
        "review_unavailable",
        "review_stopped",
    ]
    .into_iter()
    .find(|code| reason.starts_with(code))
    .unwrap_or("claim_extraction_failed");
    failure(code, reason)
}

/// Same closed-schema extraction and original-supported answer stages for the
/// production activity branch and synthetic actual-model probes. This does not
/// authenticate a native opening or grade source entailment/answer usefulness.
pub fn activity_synthesis_steps(
    request: &Request,
    evidence: &[Evidence],
    source_set: &SourceSet,
    current_origin: &AgentVaultSession,
    token_count: impl Fn(&str, &str) -> Result<usize, String>,
    mut generate: impl FnMut(&str, &str, i32, u32, GenerationSchema) -> Result<String, String>,
) -> Result<ActivityFlowOutput, ActivityFlowFailure> {
    activity_synthesis_steps_with_resolution(
        request,
        evidence,
        source_set,
        current_origin,
        token_count,
        &mut generate,
        |_, _| Err("activity resolution requires native original retrieval".into()),
        |_| Err("activity resolution requires native original recheck".into()),
    )
}

/// The production/probe flow retains independent native IO hooks. A mock
/// generation hook verifies transport/shape only, never model semantics.
#[allow(clippy::too_many_arguments)]
pub fn activity_synthesis_steps_with_resolution(
    request: &Request,
    evidence: &[Evidence],
    source_set: &SourceSet,
    current_origin: &AgentVaultSession,
    token_count: impl Fn(&str, &str) -> Result<usize, String>,
    generate: impl FnMut(&str, &str, i32, u32, GenerationSchema) -> Result<String, String>,
    resolve: impl FnOnce(&SourceSet, &[ResolutionTaskKey]) -> Result<ResolutionSources, String>,
    recheck: impl FnOnce(&ResolutionSources) -> Result<(), String>,
) -> Result<ActivityFlowOutput, ActivityFlowFailure> {
    activity_synthesis_steps_with_resolution_mode(
        request,
        evidence,
        source_set,
        current_origin,
        token_count,
        generate,
        resolve,
        recheck,
        false,
    )
}

/// Explicit QA extraction purpose. Native IO/role/revision hooks are unchanged.
#[cfg(all(test, feature = "native-index-probe"))]
#[allow(clippy::too_many_arguments)]
pub(crate) fn activity_synthesis_steps_with_source_focus_qa(
    request: &Request,
    evidence: &[Evidence],
    source_set: &SourceSet,
    current_origin: &AgentVaultSession,
    token_count: impl Fn(&str, &str) -> Result<usize, String>,
    generate: impl FnMut(&str, &str, i32, u32, GenerationSchema) -> Result<String, String>,
    resolve: impl FnOnce(&SourceSet, &[ResolutionTaskKey]) -> Result<ResolutionSources, String>,
    recheck: impl FnOnce(&ResolutionSources) -> Result<(), String>,
) -> Result<ActivityFlowOutput, ActivityFlowFailure> {
    activity_synthesis_steps_with_resolution_mode(
        request,
        evidence,
        source_set,
        current_origin,
        token_count,
        generate,
        resolve,
        recheck,
        true,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn activity_synthesis_steps_with_resolution_mode(
    request: &Request,
    evidence: &[Evidence],
    source_set: &SourceSet,
    current_origin: &AgentVaultSession,
    token_count: impl Fn(&str, &str) -> Result<usize, String>,
    generate: impl FnMut(&str, &str, i32, u32, GenerationSchema) -> Result<String, String>,
    resolve: impl FnOnce(&SourceSet, &[ResolutionTaskKey]) -> Result<ResolutionSources, String>,
    recheck: impl FnOnce(&ResolutionSources) -> Result<(), String>,
    source_focus_qa: bool,
) -> Result<ActivityFlowOutput, ActivityFlowFailure> {
    #[cfg(feature = "native-index-probe")]
    {
        activity_synthesis_steps_inner(
            request,
            evidence,
            source_set,
            current_origin,
            token_count,
            generate,
            resolve,
            recheck,
            source_focus_qa,
            false,
            false,
            false,
            None,
        )
    }
    #[cfg(not(feature = "native-index-probe"))]
    {
        activity_synthesis_steps_inner(
            request,
            evidence,
            source_set,
            current_origin,
            token_count,
            generate,
            resolve,
            recheck,
            source_focus_qa,
        )
    }
}

/// Feature-only observation plus an explicit bounded model-correction QA option.
#[cfg(feature = "native-index-probe")]
#[allow(clippy::too_many_arguments)]
pub(super) fn activity_synthesis_steps_with_resolution_mode_observed(
    request: &Request,
    evidence: &[Evidence],
    source_set: &SourceSet,
    current_origin: &AgentVaultSession,
    token_count: impl Fn(&str, &str) -> Result<usize, String>,
    generate: impl FnMut(&str, &str, i32, u32, GenerationSchema) -> Result<String, String>,
    resolve: impl FnOnce(&SourceSet, &[ResolutionTaskKey]) -> Result<ResolutionSources, String>,
    recheck: impl FnOnce(&ResolutionSources) -> Result<(), String>,
    source_focus_qa: bool,
    named_source_focus_qa: bool,
    ordinal_activity_qa: bool,
    review_correction_qa: bool,
    observer: Option<&FocusTokenObserverQa<'_>>,
) -> Result<ActivityFlowOutput, ActivityFlowFailure> {
    activity_synthesis_steps_inner(
        request,
        evidence,
        source_set,
        current_origin,
        token_count,
        generate,
        resolve,
        recheck,
        source_focus_qa,
        named_source_focus_qa,
        ordinal_activity_qa,
        review_correction_qa,
        observer,
    )
}

#[allow(clippy::too_many_arguments)]
fn activity_synthesis_steps_inner(
    request: &Request,
    evidence: &[Evidence],
    source_set: &SourceSet,
    current_origin: &AgentVaultSession,
    token_count: impl Fn(&str, &str) -> Result<usize, String>,
    mut generate: impl FnMut(&str, &str, i32, u32, GenerationSchema) -> Result<String, String>,
    resolve: impl FnOnce(&SourceSet, &[ResolutionTaskKey]) -> Result<ResolutionSources, String>,
    recheck: impl FnOnce(&ResolutionSources) -> Result<(), String>,
    source_focus_qa: bool,
    #[cfg(feature = "native-index-probe")] named_source_focus_qa: bool,
    #[cfg(feature = "native-index-probe")] ordinal_activity_qa: bool,
    #[cfg(feature = "native-index-probe")] review_correction_qa: bool,
    #[cfg(feature = "native-index-probe")] observer: Option<&FocusTokenObserverQa<'_>>,
) -> Result<ActivityFlowOutput, ActivityFlowFailure> {
    #[cfg(feature = "native-index-probe")]
    if named_source_focus_qa && !source_focus_qa {
        return Err(failure(
            "source_verification_failed",
            "named source-focus QA requires selected source-focus mode",
        ));
    }
    #[cfg(feature = "native-index-probe")]
    if ordinal_activity_qa && (!source_focus_qa || named_source_focus_qa || review_correction_qa) {
        return Err(failure(
            "source_verification_failed",
            "Ordinal activity representation or correction selection is invalid",
        ));
    }
    if !request.activity_overview || request.origin.is_none() {
        return Err(failure(
            "source_verification_failed",
            "activity requires a native opening origin",
        ));
    }
    if request.origin.as_ref().map_or(true, |origin| {
        origin.vault_path != current_origin.vault_path
            || origin.opening_token != current_origin.opening_token
    }) {
        return Err(failure(
            "source_verification_failed",
            "activity request opening origin changed",
        ));
    }
    source_set
        .validate(
            r#"{"outcome":"insufficient_evidence","claims":[]}"#,
            current_origin,
            request.scope,
        )
        .map_err(|reason| failure("source_verification_failed", reason))?;
    let range = request
        .range
        .as_ref()
        .ok_or_else(|| failure("prompt_unavailable", "activity requires its claimed period"))?;
    let resolution_window = request
        .resolution
        .as_ref()
        .map(|resolution| {
            resolution
                .checked_window(range, resolution.captured_query_epoch)
                .map_err(|reason| failure("source_verification_failed", reason))
        })
        .transpose()?;
    if let Some(window) = &resolution_window {
        for span in source_set.spans() {
            if period_context::record_interval(span).is_some_and(|(_, end)| end > window.end_epoch)
            {
                return Err(failure(
                    "source_verification_failed",
                    "initial original exceeds the declared as-of cutoff",
                ));
            }
        }
    }
    let mut eligible_original_spans = source_set.spans().count();
    let mut original_period_counts = period_context::annotate(range, source_set.spans())
        .map_err(|reason| failure("source_verification_failed", reason))?
        .counts;
    let role = request.role_snapshot.as_ref().ok_or_else(|| {
        failure(
            "source_verification_failed",
            "activity review requires the captured Ask selection",
        )
    })?;
    let review_context = AskReviewContext::new(
        current_origin,
        role,
        &request.request_id,
        &request.question,
        &request.lang,
        request.scope,
        range,
        resolution_window.as_ref(),
        request.paths.as_deref(),
    )
    .map_err(review_failure)?;
    #[cfg(feature = "native-index-probe")]
    let review_context = if source_focus_qa {
        if named_source_focus_qa {
            review_context.with_source_focus_qa_encoding(
                crate::wiki_claims::focus_claims_qa::Encoding::NamedV1,
            )
        } else {
            review_context.with_source_focus_qa()
        }
        .map_err(review_failure)?
    } else {
        review_context
    };
    #[cfg(feature = "native-index-probe")]
    let review_context = if ordinal_activity_qa {
        review_context
            .with_ordinal_activity_qa()
            .map_err(review_failure)?
    } else {
        review_context
    };
    #[cfg(feature = "native-index-probe")]
    let review_context = if review_correction_qa {
        review_context
            .with_review_correction_qa()
            .map_err(review_failure)?
    } else {
        review_context
    };
    #[cfg(not(feature = "native-index-probe"))]
    if source_focus_qa {
        return Err(failure(
            "source_verification_failed",
            "source-focus QA is unavailable in this build",
        ));
    }
    let count_initial = |_system: &str, user: &str| {
        #[cfg(feature = "native-index-probe")]
        if ordinal_activity_qa {
            let (system, user) =
                crate::wiki_claims::focus_claims_qa::PreparedOrdinalActivityQa::inputs(
                    user,
                    review_context.payload(),
                    review_context.revision(),
                )?;
            return token_count(&system, &user);
        }
        #[cfg(feature = "native-index-probe")]
        if source_focus_qa {
            let prepared = crate::wiki_claims::focus_claims_qa::PreparedFocusQa::prepare_for(
                user,
                review_context.source_focus_qa_encoding(),
            )?;
            return token_count(prepared.system(), prepared.user());
        }
        let (system, user) = claim_prompt::reading_inputs(user)?;
        token_count(&system, &user)
    };
    let windows = claim_prompt::window_sources(
        &request.question,
        &request.lang,
        range,
        source_set,
        768,
        count_initial,
    )
    .map_err(|reason| failure("prompt_unavailable", reason))?;
    let mut extraction = claim_prompt::extract(
        &request.question,
        &request.lang,
        range,
        &windows,
        current_origin,
        request.scope,
        768,
        &token_count,
        &mut generate,
        &review_context,
    )
    .map_err(extraction_failure)?;
    if extraction.claims.outcome == ClaimOutcome::InsufficientEvidence {
        return Err(failure(
            "activity_insufficient_evidence",
            "no relevant original activity claims were proposed",
        ));
    }
    let mut resolution_sources = None;
    let mut keys = Vec::new();
    if resolution_window.is_some() {
        let (bound_keys, keys_omitted) = activity_recall::resolution_task_keys(&extraction.claims)
            .map_err(|reason| failure("source_verification_failed", reason))?;
        keys = bound_keys;
        let mut sources = resolve(&windows, &keys)
            .map_err(|reason| failure("source_verification_failed", reason))?;
        sources.coverage.incomplete |= keys_omitted;
        eligible_original_spans += sources.originals.spans().count();
        original_period_counts.add(
            &period_context::annotate(range, sources.originals.spans())
                .map_err(|reason| failure("source_verification_failed", reason))?
                .counts,
        );
        resolution_sources = Some(sources);
    }
    // Retain the admitted native sources even if later generation/validation
    // fails, so their revisions are rechecked on every terminal outcome.
    let rendered = (|| {
        let mut answer_sources = windows.clone();
        let mut answer_evidence = evidence.to_vec();
        if let (Some(window), Some(sources)) = (&resolution_window, resolution_sources.as_mut()) {
            let (combined, later) = resolution_prompt::extract(
                &request.question,
                &request.lang,
                range,
                window,
                &keys,
                &windows,
                &sources.originals,
                current_origin,
                request.scope,
                &mut sources.coverage,
                &token_count,
                &mut generate,
                &review_context,
            )
            .map_err(extraction_failure)?;
            extraction.claims.claims.extend(later.claims.claims);
            extraction
                .processed_span_ids
                .extend(later.processed_span_ids);
            extraction.reviews.extend(later.reviews);
            extraction.eligible_spans += later.eligible_spans;
            extraction.processed_spans += later.processed_spans;
            extraction.omitted_spans += later.omitted_spans;
            extraction.batches += later.batches;
            answer_sources = combined;
            for hit in &sources.evidence {
                if !answer_evidence.iter().any(|old| old.page == hit.page) {
                    answer_evidence.push(hit.clone());
                }
            }
        }
        let max_tokens = request.max_tokens.unwrap_or(768).clamp(1, 768);
        let fits = |system: &str, user: &str| {
            let counted = token_count(system, user);
            #[cfg(feature = "native-index-probe")]
            if source_focus_qa {
                if let Some(observer) = observer {
                    observer(
                        FocusTokenPhaseQa::AnswerGroupCandidate,
                        system,
                        user,
                        &counted,
                        FocusTokenBudgetQa {
                            context_tokens: 4096,
                            output_tokens: max_tokens,
                            reserve: 8,
                        },
                    );
                }
            }
            counted.map(|count| count <= 4096 - max_tokens as usize - 8)
        };
        let prepared = if resolution_window.is_some() {
            claim_prompt::prepare_answer_with_resolution(
                &request.question,
                &request.lang,
                range,
                &answer_evidence,
                &answer_sources,
                &extraction,
                resolution_window.as_ref(),
                resolution_sources.as_ref().map(|sources| &sources.coverage),
                fits,
            )
        } else {
            claim_prompt::prepare_answer(
                &request.question,
                &request.lang,
                range,
                &answer_evidence,
                &answer_sources,
                &extraction,
                fits,
            )
        }
        .map_err(|reason| failure("prompt_unavailable", reason))?;
        #[cfg(feature = "native-index-probe")]
        if source_focus_qa {
            let counted = token_count(&prepared.prompt.system, &prepared.prompt.user);
            if let Some(observer) = observer {
                observer(
                    FocusTokenPhaseQa::AnswerDraftFinal,
                    &prepared.prompt.system,
                    &prepared.prompt.user,
                    &counted,
                    FocusTokenBudgetQa {
                        context_tokens: 4096,
                        output_tokens: max_tokens,
                        reserve: 8,
                    },
                );
            }
            let count = counted.map_err(|reason| failure("prompt_unavailable", reason))?;
            if count > 4096 - max_tokens as usize - 8 {
                return Err(failure(
                    "prompt_unavailable",
                    "review_not_fit: final activity answer input does not fit",
                ));
            }
        }
        let review_sources = answer_sources
            .retained(|span| {
                prepared
                    .selected_originals
                    .iter()
                    .any(|original| original.id() == span.id())
            })
            .map_err(|reason| failure("source_verification_failed", reason))?;
        let reviewed = activity_draft::run(
            &review_context,
            &review_sources,
            prepared,
            &request.lang,
            max_tokens,
            &token_count,
            &mut generate,
            #[cfg(feature = "native-index-probe")]
            observer,
        )?;
        let prepared = reviewed.prepared;
        let draft = reviewed.draft;
        let answer_review = reviewed.review;
        let answer_review_revision = answer_review.input_revision().to_owned();
        let (answer, used_sources) = draft.into_rendered();
        let additional_sources = resolution_sources
            .as_ref()
            .map_or_else(Vec::new, |sources| {
                activity_recall::resolution_answer_declarations(
                    &sources.declarations,
                    &used_sources,
                    &prepared.selected_originals,
                )
            });
        Ok(ActivityFlowOutput {
            answer,
            used_sources,
            selected_chunks: prepared.prompt.evidence.len(),
            receipt: ActivityReceipt {
                activity_period: ActivityPeriodReceipt {
                    start: range.start.clone(),
                    end: range.end.clone(),
                    start_epoch: range.start_epoch,
                    end_epoch: range.end_epoch,
                },
                scope: request.scope,
                eligible_original_spans,
                original_period_counts,
                bounded_windows: extraction.eligible_spans,
                processed_windows: extraction.processed_spans,
                omitted_windows: extraction.omitted_spans,
                extraction_batches: extraction.batches,
                proposed_claims: prepared.proposed_claims,
                selected_claims: prepared.selected_claims,
                omitted_claims: prepared.omitted_claims,
                answer_original_spans: prepared.original_spans,
                answer_period_counts: period_context::annotate(
                    range,
                    prepared.selected_originals.iter(),
                )
                .map_err(|reason| failure("source_verification_failed", reason))?
                .counts,
                claim_source_and_structure_checked: true,
                semantic_review_required: true,
                automated_claim_reviews: extraction.review_count(),
                #[cfg(feature = "native-index-probe")]
                initial_extraction_corrections: review_correction_qa
                    .then_some(usize::from(extraction.review_correction_used)),
                #[cfg(feature = "native-index-probe")]
                answer_corrections: review_correction_qa
                    .then_some(usize::from(reviewed.correction_used)),
                automated_answer_review_input_revision: answer_review_revision,
                original_inputs_incomplete: false,
                independent_verification_receipts: 0,
                resolution_window: resolution_window.clone(),
                resolution_coverage: resolution_sources
                    .as_ref()
                    .map(|sources| sources.coverage.clone()),
                additional_sources,
            },
        })
    })();
    if let Some(sources) = &resolution_sources {
        recheck(sources).map_err(|reason| failure("source_changed_during_generation", reason))?;
    }
    rendered
}

#[cfg(test)]
#[path = "activity_flow_tests.rs"]
mod tests;
