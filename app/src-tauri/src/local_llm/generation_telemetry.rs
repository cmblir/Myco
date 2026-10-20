//! Decoder observations only; these do not establish schema or semantic validity.

use super::GenerationSchema;
use serde::Serialize;
use std::time::Instant;

/// Private text/errors are deliberately excluded from Debug and serialization.
pub struct GenerationAttempt {
    result: Result<String, String>,
    telemetry: GenerationTelemetry,
}

impl GenerationAttempt {
    /// Safe observations from this one generation attempt.
    pub fn telemetry(&self) -> &GenerationTelemetry {
        &self.telemetry
    }

    /// Return the unchanged private generation result.
    pub fn into_result(self) -> Result<String, String> {
        self.result
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TelemetrySchema {
    Freeform,
    AskAnswerV1,
    WikiClaimsV1,
    #[cfg(feature = "native-index-probe")]
    WikiClaimsCompactQaV1,
    #[cfg(feature = "native-index-probe")]
    WikiSourceFocusClaimsQaV1,
    #[cfg(feature = "native-index-probe")]
    WikiSourceFocusClaimsNamedQaV1,
    #[cfg(feature = "native-index-probe")]
    WikiQuotedClaimsQaV1,
    #[cfg(feature = "native-index-probe")]
    NativeSourceInterpretationQaV1,
    #[cfg(feature = "native-index-probe")]
    NativeSourceInterpretationFacetsQaV2,
    #[cfg(feature = "native-index-probe")]
    NativeSourceInterpretationOrdinalQaV3,
    #[cfg(feature = "native-index-probe")]
    NativeActivityTypesQaV2,
    WikiClaimReviewV1,
    #[cfg(feature = "native-index-probe")]
    WikiClaimFieldReviewQaV1,
    #[cfg(feature = "native-index-probe")]
    WikiSourceCoverageQaV1,
    AskAnswerReviewV1,
    SessionCompilationV1,
    SessionStructureV1,
    SessionReviewV1,
    #[cfg(feature = "native-index-probe")]
    SessionReviewCorrelatedQaV1,
}

impl From<Option<GenerationSchema>> for TelemetrySchema {
    fn from(schema: Option<GenerationSchema>) -> Self {
        match schema {
            None => Self::Freeform,
            Some(GenerationSchema::AskAnswerV1) => Self::AskAnswerV1,
            Some(GenerationSchema::WikiClaimsV1) => Self::WikiClaimsV1,
            #[cfg(feature = "native-index-probe")]
            Some(GenerationSchema::WikiClaimsCompactQaV1(_)) => Self::WikiClaimsCompactQaV1,
            #[cfg(feature = "native-index-probe")]
            Some(GenerationSchema::WikiSourceFocusClaimsQaV1(decoder)) => {
                if decoder.wire_version() == "WikiSourceFocusClaimsNamedQaV1" {
                    Self::WikiSourceFocusClaimsNamedQaV1
                } else {
                    Self::WikiSourceFocusClaimsQaV1
                }
            }
            #[cfg(feature = "native-index-probe")]
            Some(GenerationSchema::WikiQuotedClaimsQaV1) => Self::WikiQuotedClaimsQaV1,
            #[cfg(feature = "native-index-probe")]
            Some(GenerationSchema::NativeSourceInterpretationQaV1(_)) => {
                Self::NativeSourceInterpretationQaV1
            }
            #[cfg(feature = "native-index-probe")]
            Some(GenerationSchema::NativeSourceInterpretationCandidateQa(decoder)) => {
                use crate::wiki_claims::source_interpretation_qa::CandidateQa;
                match decoder.variant() {
                    CandidateQa::FacetsV2 => Self::NativeSourceInterpretationFacetsQaV2,
                    CandidateQa::OrdinalV3 => Self::NativeSourceInterpretationOrdinalQaV3,
                }
            }
            #[cfg(feature = "native-index-probe")]
            Some(GenerationSchema::NativeActivityTypesQaV2(_)) => Self::NativeActivityTypesQaV2,
            Some(GenerationSchema::WikiClaimReviewV1(_)) => Self::WikiClaimReviewV1,
            #[cfg(feature = "native-index-probe")]
            Some(GenerationSchema::WikiClaimReviewReasonFirstQaV1(_)) => Self::WikiClaimReviewV1,
            #[cfg(feature = "native-index-probe")]
            Some(GenerationSchema::WikiClaimFieldReviewQaV1) => Self::WikiClaimFieldReviewQaV1,
            #[cfg(feature = "native-index-probe")]
            Some(GenerationSchema::WikiSourceCoverageQaV1) => Self::WikiSourceCoverageQaV1,
            Some(GenerationSchema::AskAnswerReviewV1) => Self::AskAnswerReviewV1,
            Some(GenerationSchema::SessionCompilationV1) => Self::SessionCompilationV1,
            Some(GenerationSchema::SessionStructureV1) => Self::SessionStructureV1,
            Some(GenerationSchema::SessionReviewV1) => Self::SessionReviewV1,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SamplerProfile {
    ExistingGroundedV1,
    #[cfg(feature = "native-index-probe")]
    ExistingGroundedNoPresenceQaV1,
    #[cfg(feature = "native-index-probe")]
    GemmaInstructionFamilyQaV1,
    #[cfg(feature = "native-index-probe")]
    Gemma12BOrdinalQaV1,
    #[cfg(feature = "native-index-probe")]
    ExistingGroundedGrammarFreeQaV1,
    ExistingFreeformV1,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LoopStop {
    Eog,
    OutputBudget,
    LegacyDialogueMarker,
    LegacyRepetition,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AttemptTerminal {
    ReturnedText,
    Cancelled,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GenerationPhase {
    Admission,
    Template,
    Tokenize,
    Budget,
    ContextCreate,
    Prefill,
    SamplerCreate,
    SamplingLoop,
    Finalize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GenerationErrorCode {
    ModelMissing,
    InvalidLimits,
    EmptyPrompt,
    TemplateFailed,
    TokenizeFailed,
    PromptDoesNotFit,
    ContextCreateFailed,
    AdapterApplyFailed,
    BatchAddFailed,
    DecodeNoKvSlot,
    DecodeEmptyBatch,
    DecodeUnknown,
    GrammarInitFailed,
    InvalidSessionReviewContract,
    #[cfg(feature = "native-index-probe")]
    InvalidSessionReviewQaContract,
    #[cfg(feature = "native-index-probe")]
    InvalidGemma12BOrdinalQaContract,
    TokenPieceFailed,
    #[cfg(feature = "native-index-probe")]
    GemmaThinkingQaProtocolFailed,
    #[cfg(feature = "native-index-probe")]
    GemmaThinkingQaBudgetFailed,
    #[cfg(feature = "native-index-probe")]
    GemmaThinkingQaUtf8Failed,
    #[cfg(feature = "native-index-probe")]
    GemmaThinkingQaJsonFailed,
}

/// Application wall times, not GPU profiling or whole-question latency.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationElapsed {
    pub attempt_total: u64,
    pub admission: Option<u64>,
    pub template: Option<u64>,
    pub tokenize: Option<u64>,
    pub budget: Option<u64>,
    pub context_create: Option<u64>,
    pub prefill: Option<u64>,
    pub prefill_decode_calls: Option<u64>,
    pub sampler_create: Option<u64>,
    pub sampling_loop: Option<u64>,
    pub output_decode_calls: Option<u64>,
    pub finalize: Option<u64>,
    pub first_output_piece: Option<u64>,
}

/// Only closed identifiers and measured numbers may leave the decoder.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationTelemetry {
    pub version: u8,
    pub schema: TelemetrySchema,
    pub profile: SamplerProfile,
    pub requested_output_tokens: i32,
    pub requested_context_tokens: u32,
    pub prompt_tokens: Option<usize>,
    pub prefill_completed_tokens: Option<usize>,
    pub prefill_completed_batches: Option<usize>,
    pub sampled_tokens: Option<usize>,
    pub sampled_output_tokens: Option<usize>,
    pub decoded_output_tokens: Option<usize>,
    pub pending_utf8_bytes: Option<usize>,
    pub assembled_chars: Option<usize>,
    pub returned_chars: Option<usize>,
    pub loop_stop: Option<LoopStop>,
    pub terminal: AttemptTerminal,
    pub terminal_phase: GenerationPhase,
    pub error_code: Option<GenerationErrorCode>,
    pub elapsed_micros: GenerationElapsed,
    #[cfg(feature = "native-index-probe")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gemma_thinking_qa: Option<super::gemma_thinking_qa::GemmaThinkingQaTelemetry>,
}

pub(super) struct Recorder {
    telemetry: GenerationTelemetry,
    started: Instant,
    phase_started: Instant,
    cancelled: bool,
}

fn micros(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX)
}

fn accumulate(slot: &mut Option<u64>, elapsed: u64) {
    *slot = Some(slot.unwrap_or(0).saturating_add(elapsed));
}

impl Recorder {
    pub(super) fn new(schema: Option<GenerationSchema>, output: i32, context: u32) -> Self {
        let started = Instant::now();
        Self {
            telemetry: GenerationTelemetry {
                version: 1,
                schema: schema.into(),
                profile: if schema.is_some() {
                    SamplerProfile::ExistingGroundedV1
                } else {
                    SamplerProfile::ExistingFreeformV1
                },
                requested_output_tokens: output,
                requested_context_tokens: context,
                prompt_tokens: None,
                prefill_completed_tokens: None,
                prefill_completed_batches: None,
                sampled_tokens: None,
                sampled_output_tokens: None,
                decoded_output_tokens: None,
                pending_utf8_bytes: None,
                assembled_chars: None,
                returned_chars: None,
                loop_stop: None,
                terminal: AttemptTerminal::Failed,
                terminal_phase: GenerationPhase::Admission,
                error_code: None,
                elapsed_micros: GenerationElapsed::default(),
                #[cfg(feature = "native-index-probe")]
                gemma_thinking_qa: None,
            },
            started,
            phase_started: started,
            cancelled: false,
        }
    }

    pub(super) fn sampler_profile(&self) -> SamplerProfile {
        self.telemetry.profile
    }

    /// Select before admission; this does not imply sampler creation or inference.
    #[cfg(feature = "native-index-probe")]
    pub(super) fn select_qa_profile(&mut self, profile: SamplerProfile) {
        self.telemetry.profile = profile;
    }

    #[cfg(feature = "native-index-probe")]
    pub(super) fn select_session_review_qa(&mut self) {
        self.telemetry.schema = TelemetrySchema::SessionReviewCorrelatedQaV1;
    }

    pub(super) fn limits(&self) -> (i32, u32) {
        (
            self.telemetry.requested_output_tokens,
            self.telemetry.requested_context_tokens,
        )
    }

    #[cfg(feature = "native-index-probe")]
    pub(super) fn thinking_qa(
        &mut self,
        receipt: super::gemma_thinking_qa::GemmaThinkingQaTelemetry,
    ) {
        self.telemetry.gemma_thinking_qa = Some(receipt);
    }

    #[cfg(feature = "native-index-probe")]
    pub(super) fn thinking_qa_context_created(&mut self) {
        if let Some(receipt) = &mut self.telemetry.gemma_thinking_qa {
            receipt.context_creation_count += 1;
        }
    }

    #[cfg(feature = "native-index-probe")]
    pub(super) fn thinking_qa_receipt(&self) -> super::gemma_thinking_qa::GemmaThinkingQaTelemetry {
        self.telemetry
            .gemma_thinking_qa
            .as_ref()
            .expect("thinking QA selected")
            .clone()
    }

    #[cfg(feature = "native-index-probe")]
    pub(super) fn thinking_qa_prompt(&mut self, prompt: &str) {
        use sha2::{Digest, Sha256};
        if let Some(receipt) = &mut self.telemetry.gemma_thinking_qa {
            receipt.effective_prompt_sha256 =
                Some(format!("{:x}", Sha256::digest(prompt.as_bytes())));
        }
    }

    fn end_phase(&mut self) {
        let elapsed = micros(self.phase_started);
        let times = &mut self.telemetry.elapsed_micros;
        let slot = match self.telemetry.terminal_phase {
            GenerationPhase::Admission => &mut times.admission,
            GenerationPhase::Template => &mut times.template,
            GenerationPhase::Tokenize => &mut times.tokenize,
            GenerationPhase::Budget => &mut times.budget,
            GenerationPhase::ContextCreate => &mut times.context_create,
            GenerationPhase::Prefill => &mut times.prefill,
            GenerationPhase::SamplerCreate => &mut times.sampler_create,
            GenerationPhase::SamplingLoop => &mut times.sampling_loop,
            GenerationPhase::Finalize => &mut times.finalize,
        };
        accumulate(slot, elapsed);
    }

    pub(super) fn phase(&mut self, phase: GenerationPhase) {
        self.end_phase();
        self.telemetry.terminal_phase = phase;
        self.phase_started = Instant::now();
        if phase == GenerationPhase::Prefill {
            self.telemetry.prefill_completed_tokens = Some(0);
            self.telemetry.prefill_completed_batches = Some(0);
            #[cfg(feature = "native-index-probe")]
            if let Some(receipt) = &mut self.telemetry.gemma_thinking_qa {
                receipt.prefill_pass_count += 1;
            }
        } else if phase == GenerationPhase::SamplingLoop {
            self.telemetry.sampled_tokens = Some(0);
            self.telemetry.sampled_output_tokens = Some(0);
            self.telemetry.decoded_output_tokens = Some(0);
            self.telemetry.pending_utf8_bytes = Some(0);
            self.telemetry.assembled_chars = Some(0);
        }
    }

    pub(super) fn fail(&mut self, code: GenerationErrorCode) {
        self.telemetry.error_code = Some(code);
    }

    pub(super) fn cancel(&mut self) {
        self.cancelled = true;
    }

    pub(super) fn prompt_tokens(&mut self, tokens: usize) {
        self.telemetry.prompt_tokens = Some(tokens);
    }

    pub(super) fn prefill_completed(&mut self, tokens: usize) {
        *self
            .telemetry
            .prefill_completed_tokens
            .as_mut()
            .expect("prefill entered") += tokens;
        *self
            .telemetry
            .prefill_completed_batches
            .as_mut()
            .expect("prefill entered") += 1;
    }

    pub(super) fn decode_elapsed(&mut self, started: Instant, prefill: bool) {
        let slot = if prefill {
            &mut self.telemetry.elapsed_micros.prefill_decode_calls
        } else {
            &mut self.telemetry.elapsed_micros.output_decode_calls
        };
        accumulate(slot, micros(started));
    }

    pub(super) fn sampled(&mut self, is_eog: bool) {
        *self
            .telemetry
            .sampled_tokens
            .as_mut()
            .expect("sampling entered") += 1;
        if is_eog {
            self.stopped(LoopStop::Eog);
        } else {
            *self
                .telemetry
                .sampled_output_tokens
                .as_mut()
                .expect("sampling entered") += 1;
        }
    }

    pub(super) fn output_decoded(&mut self) {
        *self
            .telemetry
            .decoded_output_tokens
            .as_mut()
            .expect("sampling entered") += 1;
    }

    pub(super) fn output(&mut self, assembled: &str, pending: usize, assembled_piece: bool) {
        self.telemetry.assembled_chars = Some(assembled.chars().count());
        self.telemetry.pending_utf8_bytes = Some(pending);
        if assembled_piece && self.telemetry.elapsed_micros.first_output_piece.is_none() {
            self.telemetry.elapsed_micros.first_output_piece = Some(micros(self.started));
        }
    }

    pub(super) fn stopped(&mut self, reason: LoopStop) {
        self.telemetry.loop_stop = Some(reason);
    }

    pub(super) fn exhausted_budget(&mut self) {
        if self.telemetry.loop_stop.is_none() {
            self.stopped(LoopStop::OutputBudget);
        }
    }

    pub(super) fn finish(mut self, result: Result<String, String>) -> GenerationAttempt {
        self.end_phase();
        self.telemetry.elapsed_micros.attempt_total = micros(self.started);
        #[cfg(feature = "native-index-probe")]
        if result.is_err() {
            if let Some(receipt) = &mut self.telemetry.gemma_thinking_qa {
                if receipt.failure.is_none() {
                    receipt.failure = Some(if self.cancelled {
                        super::gemma_thinking_qa::ThinkingQaFailure::Cancelled
                    } else {
                        super::gemma_thinking_qa::ThinkingQaFailure::AdmissionFailed
                    });
                }
            }
        }
        self.telemetry.terminal = if let Ok(text) = &result {
            self.telemetry.returned_chars = Some(text.chars().count());
            AttemptTerminal::ReturnedText
        } else if self.cancelled {
            AttemptTerminal::Cancelled
        } else {
            AttemptTerminal::Failed
        };
        GenerationAttempt {
            result,
            telemetry: self.telemetry,
        }
    }
}

#[cfg(test)]
#[path = "generation_telemetry_tests.rs"]
mod tests;
