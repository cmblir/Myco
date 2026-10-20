//! Draft and independently re-review one explicitly enabled model correction.

use super::*;
use crate::local_synthesis::answer_draft::{validate_answer_draft, ValidatedAnswerDraft};
use crate::local_synthesis::answer_review::{self, NativeAnswerReview};
use crate::local_synthesis::claim_prompt::ActivityPrompt;

pub(super) struct ReviewedDraft {
    pub(super) prepared: ActivityPrompt,
    pub(super) draft: ValidatedAnswerDraft,
    pub(super) review: NativeAnswerReview,
    #[cfg(feature = "native-index-probe")]
    pub(super) correction_used: bool,
}

#[allow(clippy::too_many_arguments)]
pub(super) fn run(
    context: &AskReviewContext,
    sources: &SourceSet,
    prepared: ActivityPrompt,
    language: &str,
    output_tokens: i32,
    token_count: &impl Fn(&str, &str) -> Result<usize, String>,
    generate: &mut impl FnMut(&str, &str, i32, u32, GenerationSchema) -> Result<String, String>,
    #[cfg(feature = "native-index-probe")] observer: Option<&FocusTokenObserverQa<'_>>,
) -> Result<ReviewedDraft, ActivityFlowFailure> {
    #[cfg(feature = "native-index-probe")]
    let mut prepared = prepared;
    #[cfg(feature = "native-index-probe")]
    let mut correction_used = false;
    #[allow(clippy::never_loop)] // Non-probe builds have one attempt; QA can continue once.
    loop {
        let raw = generate(
            &prepared.prompt.system,
            &prepared.prompt.user,
            output_tokens,
            4096,
            GenerationSchema::AskAnswerV1,
        )
        .map_err(|reason| failure("generation_failed", reason))?;
        let draft = validate_answer_draft(&raw, &prepared.prompt, language).map_err(|reason| {
            failure(
                if reason == local_synthesis::INCOMPLETE_ANSWER {
                    "answer_incomplete"
                } else {
                    "answer_rejected"
                },
                reason,
            )
        })?;
        let review = answer_review::run_activity(
            context,
            sources,
            &prepared,
            &draft,
            |system, user| {
                let counted = token_count(system, user);
                #[cfg(feature = "native-index-probe")]
                if context.source_focus_qa_enabled() {
                    if let Some(observer) = observer {
                        observer(
                            FocusTokenPhaseQa::FinalAnswerReview,
                            system,
                            user,
                            &counted,
                            FocusTokenBudgetQa {
                                context_tokens: 4096,
                                output_tokens: 768,
                                reserve: 8,
                            },
                        );
                    }
                }
                counted
            },
            |system, user, output, window| {
                generate(
                    system,
                    user,
                    output,
                    window,
                    GenerationSchema::AskAnswerReviewV1,
                )
            },
        )
        .map_err(review_failure)?;
        // A verdict can authorize a retry only after its private binding is checked.
        if !review.binds_activity(context, sources, &prepared, &draft) {
            return Err(failure("review_invalid", "answer review binding changed"));
        }
        match review.require_accepted() {
            Ok(()) => {
                return Ok(ReviewedDraft {
                    prepared,
                    draft,
                    review,
                    #[cfg(feature = "native-index-probe")]
                    correction_used,
                })
            }
            Err(reason) => {
                #[cfg(feature = "native-index-probe")]
                if context.review_correction_qa_enabled()
                    && !correction_used
                    && matches!(reason.code(), "review_missing" | "review_rejected")
                {
                    let corrected = local_synthesis::answer_correction::prepare(
                        context, sources, &prepared, &draft, &review,
                    )
                    .map_err(review_failure)?;
                    let counted = token_count(&corrected.prompt.system, &corrected.prompt.user);
                    if let Some(observer) = observer {
                        observer(
                            FocusTokenPhaseQa::AnswerCorrection,
                            &corrected.prompt.system,
                            &corrected.prompt.user,
                            &counted,
                            FocusTokenBudgetQa {
                                context_tokens: 4096,
                                output_tokens,
                                reserve: 8,
                            },
                        );
                    }
                    let count = counted.map_err(|detail| failure("prompt_unavailable", detail))?;
                    if count > 4096 - output_tokens as usize - 8 {
                        return Err(failure(
                            "review_not_fit",
                            "corrective activity answer input does not fit",
                        ));
                    }
                    // Failed attempts never replenish this stage's single allowance.
                    correction_used = true;
                    prepared = corrected;
                    continue;
                }
                return Err(review_failure(reason));
            }
        }
    }
}
