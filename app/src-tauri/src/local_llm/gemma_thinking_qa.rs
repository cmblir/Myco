//! One closed Gemma thinking experiment; never a product generation route.

use super::generation_telemetry::{GenerationErrorCode, GenerationPhase, LoopStop, Recorder};
use super::{
    check_measured_cancelled, decode_error_code, grounded_sampler, grounded_sampling,
    GenerationSchema,
};
use llama_cpp_2::context::LlamaContext;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::{AddBos, LlamaModel};
use llama_cpp_2::token::LlamaToken;
use llama_cpp_2::token_type::LlamaTokenAttr;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::atomic::AtomicBool;
use std::time::Instant;

pub const THOUGHT_TOKENS: usize = 1024;
pub const FINAL_TOKENS: i32 = 192;
pub const CONTEXT_TOKENS: u32 = 4096;
const HEADER: &[u8] = b"thought\n";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ThinkingQaFailure {
    AdmissionFailed,
    MalformedChannel,
    PrematureEog,
    ThoughtBudget,
    FinalBudget,
    InvalidUtf8,
    InvalidJson,
    Cancelled,
    DecodeFailed,
}

/// Closed protocol identifiers and observations; no thought or source text.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GemmaThinkingQaTelemetry {
    pub version: u8,
    pub thought_budget: usize,
    pub final_budget: i32,
    pub effective_prompt_sha256: Option<String>,
    pub context_creation_count: usize,
    pub prefill_pass_count: usize,
    pub expected_header_token_ids: Vec<i32>,
    pub sampled_header_token_ids: Vec<i32>,
    /// Ordinary channel-name bytes only, excluding the sampled opening control token.
    pub parsed_header_bytes: usize,
    pub parsed_header_sha256: Option<String>,
    pub opener_sample_ordinal: Option<usize>,
    pub closing_token_id: Option<i32>,
    pub closing_sample_ordinal: Option<usize>,
    pub closing_decoded_kv_position: Option<usize>,
    pub thought_sampled_tokens: usize,
    pub thought_decoded_tokens: usize,
    pub thought_body_bytes: usize,
    pub thought_body_sha256: Option<String>,
    pub thought_pending_utf8_bytes: usize,
    pub final_grammar_sha256: String,
    pub final_sampler_fresh: bool,
    pub final_grammar_activation_sample_ordinal: Option<usize>,
    pub final_first_kv_position: Option<usize>,
    pub final_sampled_tokens: usize,
    pub final_decoded_tokens: usize,
    pub final_eog_sample_ordinal: Option<usize>,
    pub final_pending_utf8_bytes: usize,
    pub final_json_valid: bool,
    pub thought_elapsed_micros: Option<u64>,
    pub final_elapsed_micros: Option<u64>,
    pub failure: Option<ThinkingQaFailure>,
}

impl GemmaThinkingQaTelemetry {
    pub(super) fn new() -> Self {
        Self {
            version: 1,
            thought_budget: THOUGHT_TOKENS,
            final_budget: FINAL_TOKENS,
            effective_prompt_sha256: None,
            context_creation_count: 0,
            prefill_pass_count: 0,
            expected_header_token_ids: Vec::new(),
            sampled_header_token_ids: Vec::new(),
            parsed_header_bytes: 0,
            parsed_header_sha256: None,
            opener_sample_ordinal: None,
            closing_token_id: None,
            closing_sample_ordinal: None,
            closing_decoded_kv_position: None,
            thought_sampled_tokens: 0,
            thought_decoded_tokens: 0,
            thought_body_bytes: 0,
            thought_body_sha256: None,
            thought_pending_utf8_bytes: 0,
            final_grammar_sha256: GenerationSchema::AskAnswerV1.qa_grammar_sha256(),
            final_sampler_fresh: false,
            final_grammar_activation_sample_ordinal: None,
            final_first_kv_position: None,
            final_sampled_tokens: 0,
            final_decoded_tokens: 0,
            final_eog_sample_ordinal: None,
            final_pending_utf8_bytes: 0,
            final_json_valid: false,
            thought_elapsed_micros: None,
            final_elapsed_micros: None,
            failure: None,
        }
    }
}

pub(super) struct Protocol {
    open: LlamaToken,
    close: LlamaToken,
    expected_header: Vec<i32>,
}

const PINNED_VOCABULARY_SIZE: i32 = 262_144;

#[derive(Clone, Copy)]
struct PinnedMarker {
    text: &'static str,
    token_id: i32,
    class: LlamaTokenAttr,
}

// Exact token metadata from the pinned Google E4B GGUF. USER_DEFINED channel
// delimiters are special tokens in this binding, with a distinct class from THINK.
const THINK_MARKER: PinnedMarker = PinnedMarker {
    text: "<|think|>",
    token_id: 98,
    class: LlamaTokenAttr::Control,
};
const OPEN_MARKER: PinnedMarker = PinnedMarker {
    text: "<|channel>",
    token_id: 100,
    class: LlamaTokenAttr::UserDefined,
};
const CLOSE_MARKER: PinnedMarker = PinnedMarker {
    text: "<channel|>",
    token_id: 101,
    class: LlamaTokenAttr::UserDefined,
};

fn validate_marker_metadata(
    marker: PinnedMarker,
    vocabulary_size: i32,
    tokens: &[LlamaToken],
    attributes: u32,
    is_eog: bool,
    special_piece: &[u8],
) -> Result<LlamaToken, String> {
    if vocabulary_size != PINNED_VOCABULARY_SIZE
        || tokens.len() != 1
        || tokens[0].0 != marker.token_id
        || attributes != marker.class as u32
        || is_eog
        || special_piece != marker.text.as_bytes()
    {
        return Err("Gemma thinking QA pinned marker metadata failed".into());
    }
    Ok(tokens[0])
}

fn pinned_marker(model: &LlamaModel, marker: PinnedMarker) -> Result<LlamaToken, String> {
    let tokens = model
        .str_to_token(marker.text, AddBos::Never)
        .map_err(|_| "Gemma thinking QA token metadata failed")?;
    let [token] = tokens.as_slice() else {
        return Err("Gemma thinking QA pinned marker metadata failed".into());
    };
    validate_marker_metadata(
        marker,
        model.n_vocab(),
        &tokens,
        model.token_attr(*token).bits(),
        model.is_eog_token(*token),
        &piece(model, *token, true)?,
    )
}

pub(super) fn protocol(model: &LlamaModel, prompt: &str) -> Result<Protocol, String> {
    super::gemma4::validate_tokens(model, prompt)?;
    pinned_marker(model, THINK_MARKER)?;
    let open = pinned_marker(model, OPEN_MARKER)?;
    let close = pinned_marker(model, CLOSE_MARKER)?;
    if open == close
        || !prompt.ends_with(super::gemma4::MODEL_PREFIX)
        || prompt.contains("<|channel>")
        || prompt.contains("<channel|>")
        || prompt.matches("<|think|>").count() != 1
    {
        return Err("Gemma thinking QA prompt protocol failed".into());
    }
    let header = model
        .str_to_token("<|channel>thought\n", AddBos::Never)
        .map_err(|_| "Gemma thinking QA header tokenization failed")?;
    if header.first() != Some(&open) || header.len() > 16 {
        return Err("Gemma thinking QA header token metadata failed".into());
    }
    Ok(Protocol {
        open,
        close,
        expected_header: header.iter().map(|token| token.0).collect(),
    })
}

pub(super) fn validate_budget(prompt_tokens: usize) -> Result<(), String> {
    let reserve = THOUGHT_TOKENS + FINAL_TOKENS as usize + super::GENERATION_SAFETY_TOKENS;
    if prompt_tokens == 0 || prompt_tokens > CONTEXT_TOKENS as usize - reserve {
        return Err("Gemma thinking QA prompt does not fit fixed phase budgets".into());
    }
    Ok(())
}

fn piece(model: &LlamaModel, token: LlamaToken, special: bool) -> Result<Vec<u8>, String> {
    match model.token_to_piece_bytes(token, 32, special, None) {
        Ok(bytes) => Ok(bytes),
        Err(llama_cpp_2::TokenToStringError::InsufficientBufferSpace(size)) => model
            .token_to_piece_bytes(token, size.unsigned_abs() as usize, special, None)
            .map_err(|_| "Gemma thinking QA token piece failed".into()),
        Err(_) => Err("Gemma thinking QA token piece failed".into()),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Open,
    Header,
    Thought,
    Closing,
    FinalReady,
    Final,
    Complete,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Action {
    Decode,
    DecodeClose,
    Complete,
}

struct Controller {
    protocol: Protocol,
    phase: Phase,
    header_bytes: usize,
    pending: Vec<u8>,
    final_text: String,
    digest: Sha256,
    prompt_tokens: usize,
    pending_decode: Option<LlamaToken>,
    receipt: GemmaThinkingQaTelemetry,
    phase_started: Instant,
}

impl Controller {
    fn new(protocol: Protocol, prompt_tokens: usize) -> Self {
        let mut receipt = GemmaThinkingQaTelemetry::new();
        receipt.expected_header_token_ids = protocol.expected_header.clone();
        Self {
            protocol,
            phase: Phase::Open,
            header_bytes: 0,
            pending: Vec::new(),
            final_text: String::new(),
            digest: Sha256::new(),
            prompt_tokens,
            pending_decode: None,
            receipt,
            phase_started: Instant::now(),
        }
    }

    fn fail<T>(&mut self, code: ThinkingQaFailure) -> Result<T, ThinkingQaFailure> {
        self.receipt.failure = Some(code);
        Err(code)
    }

    fn ordinal(&self) -> usize {
        self.receipt.thought_sampled_tokens + self.receipt.final_sampled_tokens
    }

    fn count_sample(&mut self) {
        if self.phase == Phase::Final {
            self.receipt.final_sampled_tokens += 1;
        } else {
            self.receipt.thought_sampled_tokens += 1;
        }
    }

    fn before_sample(&mut self) -> Result<(), ThinkingQaFailure> {
        if matches!(
            self.phase,
            Phase::Closing | Phase::FinalReady | Phase::Complete
        ) {
            return self.fail(ThinkingQaFailure::MalformedChannel);
        }
        if self.phase == Phase::Final && self.receipt.final_sampled_tokens >= FINAL_TOKENS as usize
        {
            self.fail(ThinkingQaFailure::FinalBudget)
        } else if self.phase != Phase::Final
            && self.receipt.thought_sampled_tokens >= THOUGHT_TOKENS
        {
            self.fail(ThinkingQaFailure::ThoughtBudget)
        } else {
            Ok(())
        }
    }

    fn append(&mut self, bytes: &[u8], final_phase: bool) -> Result<(), ThinkingQaFailure> {
        if !final_phase {
            self.digest.update(bytes);
            self.receipt.thought_body_bytes += bytes.len();
        }
        self.pending.extend_from_slice(bytes);
        if final_phase {
            self.receipt.final_pending_utf8_bytes = self.pending.len();
        } else {
            self.receipt.thought_pending_utf8_bytes = self.pending.len();
        }
        let valid = match std::str::from_utf8(&self.pending) {
            Ok(_) => self.pending.len(),
            Err(error) if error.error_len().is_none() => error.valid_up_to(),
            Err(_) => return self.fail(ThinkingQaFailure::InvalidUtf8),
        };
        if final_phase && valid > 0 {
            self.final_text
                .push_str(std::str::from_utf8(&self.pending[..valid]).expect("validated prefix"));
        }
        self.pending.drain(..valid);
        if final_phase {
            self.receipt.final_pending_utf8_bytes = self.pending.len();
        } else {
            self.receipt.thought_pending_utf8_bytes = self.pending.len();
        }
        Ok(())
    }

    fn sampled(
        &mut self,
        token: LlamaToken,
        eog: bool,
        control: bool,
        bytes: &[u8],
    ) -> Result<Action, ThinkingQaFailure> {
        if self.pending_decode.is_some()
            || matches!(
                self.phase,
                Phase::Closing | Phase::FinalReady | Phase::Complete
            )
        {
            return self.fail(ThinkingQaFailure::MalformedChannel);
        }
        self.count_sample();
        if eog {
            if self.phase != Phase::Final {
                return self.fail(ThinkingQaFailure::PrematureEog);
            }
            self.receipt.final_eog_sample_ordinal = Some(self.ordinal());
            if !self.pending.is_empty() {
                return self.fail(ThinkingQaFailure::InvalidUtf8);
            }
            if !valid_final(&self.final_text) {
                return self.fail(ThinkingQaFailure::InvalidJson);
            }
            self.receipt.final_json_valid = true;
            self.phase = Phase::Complete;
            return Ok(Action::Complete);
        }
        match self.phase {
            Phase::Open if token == self.protocol.open => {
                self.receipt.opener_sample_ordinal = Some(self.ordinal());
                self.receipt.sampled_header_token_ids.push(token.0);
                self.phase = Phase::Header;
            }
            Phase::Header if !control => {
                self.receipt.sampled_header_token_ids.push(token.0);
                let needed = HEADER.len() - self.header_bytes;
                let consumed = bytes.len().min(needed);
                if bytes[..consumed] != HEADER[self.header_bytes..self.header_bytes + consumed]
                    || bytes.is_empty()
                {
                    return self.fail(ThinkingQaFailure::MalformedChannel);
                }
                self.header_bytes += consumed;
                self.receipt.parsed_header_bytes = self.header_bytes;
                if self.header_bytes == HEADER.len() {
                    self.receipt.parsed_header_sha256 =
                        Some(format!("{:x}", Sha256::digest(HEADER)));
                    self.phase = Phase::Thought;
                    self.append(&bytes[consumed..], false)?;
                }
            }
            Phase::Thought if token == self.protocol.close => {
                if !self.pending.is_empty() {
                    return self.fail(ThinkingQaFailure::InvalidUtf8);
                }
                self.receipt.closing_token_id = Some(token.0);
                self.receipt.closing_sample_ordinal = Some(self.ordinal());
                self.phase = Phase::Closing;
                self.pending_decode = Some(token);
                return Ok(Action::DecodeClose);
            }
            Phase::Thought if !control => {
                self.append(bytes, false)?;
            }
            Phase::Final if !control => {
                self.append(bytes, true)?;
            }
            _ => return self.fail(ThinkingQaFailure::MalformedChannel),
        }
        self.pending_decode = Some(token);
        Ok(Action::Decode)
    }

    fn decoded(&mut self, token: LlamaToken, position: usize) -> Result<bool, ThinkingQaFailure> {
        if self.pending_decode.take() != Some(token)
            || position
                != self.prompt_tokens
                    + self.receipt.thought_decoded_tokens
                    + self.receipt.final_decoded_tokens
        {
            return self.fail(ThinkingQaFailure::MalformedChannel);
        }
        if self.phase == Phase::Final {
            if self.receipt.final_decoded_tokens == 0 {
                self.receipt.final_first_kv_position = Some(position);
            }
            self.receipt.final_decoded_tokens += 1;
            return Ok(false);
        }
        self.receipt.thought_decoded_tokens += 1;
        if self.phase == Phase::Closing {
            if token != self.protocol.close
                || position + 1 != self.prompt_tokens + self.receipt.thought_decoded_tokens
            {
                return self.fail(ThinkingQaFailure::MalformedChannel);
            }
            self.receipt.closing_decoded_kv_position = Some(position);
            self.receipt.thought_elapsed_micros = Some(elapsed(self.phase_started));
            self.phase_started = Instant::now();
            self.phase = Phase::FinalReady;
            return Ok(true);
        }
        Ok(false)
    }

    fn final_sampler_ready(&mut self) -> Result<(), ThinkingQaFailure> {
        if self.phase != Phase::FinalReady || self.pending_decode.is_some() {
            return self.fail(ThinkingQaFailure::MalformedChannel);
        }
        self.receipt.final_grammar_activation_sample_ordinal = Some(self.ordinal() + 1);
        self.receipt.final_sampler_fresh = true;
        self.phase = Phase::Final;
        Ok(())
    }

    fn receipt(mut self) -> GemmaThinkingQaTelemetry {
        if matches!(
            self.phase,
            Phase::FinalReady | Phase::Final | Phase::Complete
        ) {
            self.receipt.final_elapsed_micros = Some(elapsed(self.phase_started));
        } else {
            self.receipt.thought_elapsed_micros = Some(elapsed(self.phase_started));
        }
        self.receipt.thought_body_sha256 = Some(format!("{:x}", self.digest.finalize()));
        self.receipt
    }
}

fn elapsed(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FinalAnswer {
    answer: String,
    sources: Vec<String>,
}

fn valid_final(text: &str) -> bool {
    let Ok(answer) = serde_json::from_str::<FinalAnswer>(text) else {
        return false;
    };
    answer.answer.chars().count() <= 1200
        && !answer.answer.contains(['<', '>'])
        && answer.sources.len() <= 12
        && answer
            .sources
            .iter()
            .all(|source| (1..=12).any(|id| *source == format!("S{id}")))
}

fn protocol_error(recorder: &mut Recorder, failure: ThinkingQaFailure) -> String {
    let code = match failure {
        ThinkingQaFailure::ThoughtBudget | ThinkingQaFailure::FinalBudget => {
            recorder.stopped(LoopStop::OutputBudget);
            GenerationErrorCode::GemmaThinkingQaBudgetFailed
        }
        ThinkingQaFailure::InvalidUtf8 => GenerationErrorCode::GemmaThinkingQaUtf8Failed,
        ThinkingQaFailure::InvalidJson => GenerationErrorCode::GemmaThinkingQaJsonFailed,
        _ => GenerationErrorCode::GemmaThinkingQaProtocolFailed,
    };
    recorder.fail(code);
    "Gemma thinking QA generation failed".into()
}

pub(super) fn generate(
    model: &LlamaModel,
    ctx: &mut LlamaContext<'_>,
    batch: &mut LlamaBatch<'_>,
    prompt_tokens: usize,
    protocol: Protocol,
    cancelled: &AtomicBool,
    recorder: &mut Recorder,
) -> Result<String, String> {
    let mut controller = Controller::new(protocol, prompt_tokens);
    let initial = recorder.thinking_qa_receipt();
    controller.receipt.context_creation_count = initial.context_creation_count;
    controller.receipt.prefill_pass_count = initial.prefill_pass_count;
    controller.receipt.effective_prompt_sha256 = initial.effective_prompt_sha256;
    let result = (|| {
        recorder.phase(GenerationPhase::SamplerCreate);
        let mut sampler = grounded_sampling::thinking_qa_sampler();
        recorder.phase(GenerationPhase::SamplingLoop);
        let mut position = prompt_tokens as i32;
        loop {
            check_measured_cancelled(recorder, cancelled)?;
            controller
                .before_sample()
                .map_err(|failure| protocol_error(recorder, failure))?;
            // sample() accepts once. The thought stream never reaches the final grammar.
            let token = sampler.sample(ctx, batch.n_tokens() - 1);
            let eog = model.is_eog_token(token);
            recorder.sampled(eog);
            let attributes = model.token_attr(token);
            let control = [
                LlamaTokenAttr::Control,
                LlamaTokenAttr::UserDefined,
                LlamaTokenAttr::Unused,
                LlamaTokenAttr::Unknown,
            ]
            .into_iter()
            .any(|attribute| attributes.contains(attribute));
            let bytes = if eog || control {
                Vec::new()
            } else {
                piece(model, token, false).inspect_err(|_| {
                    controller.count_sample();
                    recorder.fail(GenerationErrorCode::TokenPieceFailed);
                })?
            };
            let sampled = controller.sampled(token, eog, control, &bytes);
            recorder.output(
                &controller.final_text,
                controller.pending.len(),
                !bytes.is_empty() && controller.phase == Phase::Final,
            );
            let action = sampled.map_err(|failure| protocol_error(recorder, failure))?;
            check_measured_cancelled(recorder, cancelled)?;
            if action == Action::Complete {
                recorder.phase(GenerationPhase::Finalize);
                check_measured_cancelled(recorder, cancelled)?;
                return Ok(controller.final_text.trim().to_string());
            }
            batch.clear();
            batch.add(token, position, &[0], true).map_err(|_| {
                recorder.fail(GenerationErrorCode::BatchAddFailed);
                "Gemma thinking QA batch failed".to_string()
            })?;
            let started = Instant::now();
            let decoded = ctx.decode(batch);
            recorder.decode_elapsed(started, false);
            decoded.map_err(|error| {
                recorder.fail(decode_error_code(&error));
                "Gemma thinking QA decode failed".to_string()
            })?;
            recorder.output_decoded();
            let transition = controller
                .decoded(token, position as usize)
                .map_err(|failure| protocol_error(recorder, failure))?;
            position += 1;
            check_measured_cancelled(recorder, cancelled)?;
            if transition {
                // Actual closing control token has been decoded in this same KV context.
                sampler = grounded_sampler(model, GenerationSchema::AskAnswerV1)
                    .inspect_err(|_| recorder.fail(GenerationErrorCode::GrammarInitFailed))?;
                controller
                    .final_sampler_ready()
                    .map_err(|failure| protocol_error(recorder, failure))?;
            }
        }
    })();
    if result.is_err() && controller.receipt.failure.is_none() {
        controller.receipt.failure =
            Some(if cancelled.load(std::sync::atomic::Ordering::Acquire) {
                ThinkingQaFailure::Cancelled
            } else {
                ThinkingQaFailure::DecodeFailed
            });
    }
    recorder.thinking_qa(controller.receipt());
    result
}

#[cfg(test)]
#[path = "gemma_thinking_qa_tests.rs"]
mod tests;
