//! Embedded local model — in-process llama.cpp inference over the bundled
//! HyperCLOVA X SEED 0.5B GGUF. No daemon, no API key, no Python: this is the
//! zero-setup, offline provider for CLASSIFICATION (note type) and light,
//! language-matched QUERY. It is a 0.5B model — fluent Korean/English but weak
//! on facts — so high-quality ingest stays on the paid providers.
//!
//! `LlamaBackend::init()` is process-global and must run exactly once, so a
//! single `LocalLlm` is loaded into Tauri state at startup and reused; each call
//! spins up a fresh context (cheap) off the shared model.
//!
//! Prompts go through the model's own chat template (from the GGUF) so the
//! instruct tuning actually engages — feeding raw "User:/Assistant:" text made
//! the base LM continue the transcript with fake turns and thinking-style
//! artifacts. Tokenized prompts are truncated to fit the context window
//! (keeping the tail, where the question lives) and the batch is sized to the
//! prompt — a fixed 512 batch overflowed ("Insufficient Space of 512") the
//! moment vault context was inlined.
//!
//! Classification uses greedy decoding + a short token cap + post-validation
//! against the label set, NOT a GBNF grammar: the grammar sampler crashes in the
//! vendored llama.cpp of llama-cpp-2 0.1.150 (`GGML_ASSERT(!stacks.empty())`,
//! upstream PR #17869). SEED emits clean labels, so post-match is reliable.

use std::num::NonZeroU32;
use std::path::Path;

use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{AddBos, LlamaChatMessage, LlamaChatTemplate, LlamaModel};
use llama_cpp_2::sampling::LlamaSampler;

/// The wiki page types the classifier maps a note to (matches the frontmatter
/// `type` enum). Longest-match wins so "source-summary" beats a stray "source".
pub const WIKI_TYPES: [&str; 5] =
    ["concept", "entity", "technique", "source-summary", "analysis"];

const CTX_TOKENS: u32 = 4096;
const CLASSIFY_MAX_TOKENS: i32 = 6;
// Belt-and-braces stops for the no-template fallback path, where the base LM
// may start inventing new dialogue turns.
const STOP_MARKERS: [&str; 4] = ["\nUser:", "\nAssistant:", "\nQ:", "\n질문:"];

pub struct LocalLlm {
    // The backend guard must outlive the model; drop deinits llama.cpp.
    backend: LlamaBackend,
    model: LlamaModel,
    // The GGUF's own chat template (None if the file ships without one).
    template: Option<LlamaChatTemplate>,
}

impl LocalLlm {
    /// Load the bundled GGUF. Call once per process (backend init is global).
    pub fn load(model_path: &Path) -> Result<Self, String> {
        let backend = LlamaBackend::init().map_err(|e| format!("llama backend init: {e}"))?;
        let model =
            LlamaModel::load_from_file(&backend, model_path, &LlamaModelParams::default())
                .map_err(|e| format!("load model {}: {e}", model_path.display()))?;
        let template = model.chat_template(None).ok();
        Ok(Self {
            backend,
            model,
            template,
        })
    }

    /// Render (system, user) through the model's chat template, falling back to
    /// a plain concatenation when the GGUF has none. Returns the prompt text
    /// and whether a BOS still needs to be added at tokenization (the template
    /// already embeds its own special tokens).
    fn format_chat(&self, system: &str, user: &str) -> (String, AddBos) {
        if let Some(tmpl) = &self.template {
            let msgs: Vec<LlamaChatMessage> = [("system", system), ("user", user)]
                .into_iter()
                .filter(|(_, c)| !c.is_empty())
                .filter_map(|(r, c)| LlamaChatMessage::new(r.into(), c.into()).ok())
                .collect();
            if !msgs.is_empty() {
                if let Ok(p) = self.model.apply_chat_template(tmpl, &msgs, true) {
                    return (p, AddBos::Never);
                }
            }
        }
        let joined = if system.is_empty() {
            format!("{user}\n\nAnswer:")
        } else {
            format!("{system}\n\n{user}\n\nAnswer:")
        };
        (joined, AddBos::Always)
    }

    /// Decode up to `max_tokens` for a (system, user) chat turn (sampled).
    fn run(&self, system: &str, user: &str, max_tokens: i32) -> Result<String, String> {
        let (prompt, add_bos) = self.format_chat(system, user);
        self.run_prompt(&prompt, add_bos, max_tokens, true)
    }

    /// Core decode loop over an already-formatted prompt. `sampled` picks the
    /// generation sampler: repetition penalty + low temperature for free-form
    /// text (pure greedy sends a 0.5B model into degenerate sentence loops —
    /// the same line repeated until the token cap); classification stays pure
    /// greedy (single-word output, determinism preferred).
    fn run_prompt(
        &self,
        prompt: &str,
        add_bos: AddBos,
        max_tokens: i32,
        sampled: bool,
    ) -> Result<String, String> {
        let n_ctx = NonZeroU32::new(CTX_TOKENS).ok_or("invalid ctx size")?;
        let ctx_params = LlamaContextParams::default().with_n_ctx(Some(n_ctx));
        let mut ctx = self
            .model
            .new_context(&self.backend, ctx_params)
            .map_err(|e| format!("new_context: {e}"))?;

        let mut tokens = self
            .model
            .str_to_token(&prompt, add_bos)
            .map_err(|e| format!("tokenize: {e}"))?;

        // Fit prompt + generation inside the context window. Drop from the
        // FRONT: the instruction/question sits at the end of the prompt, the
        // (inlined vault) context at the front is the expendable part.
        let budget = CTX_TOKENS as usize - max_tokens.max(1) as usize - 8;
        if tokens.len() > budget {
            tokens.drain(..tokens.len() - budget);
        }
        if tokens.is_empty() {
            return Err("empty prompt".into());
        }

        // Chunked prefill: the context's n_batch is 512 (llama-cpp-2 exposes no
        // setter), so a long prompt must be decoded in ≤512-token chunks —
        // one oversized decode trips GGML_ASSERT(n_tokens_all <= cparams.n_batch),
        // and a fixed one-shot batch was the "Insufficient Space of 512" crash.
        const PREFILL_CHUNK: usize = 512;
        let mut batch = LlamaBatch::new(PREFILL_CHUNK, 1);
        let total = tokens.len();
        let mut pos: i32 = 0;
        for chunk in tokens.chunks(PREFILL_CHUNK) {
            batch.clear();
            let chunk_end = pos as usize + chunk.len();
            for (j, tok) in chunk.iter().enumerate() {
                let wants_logits = chunk_end == total && j == chunk.len() - 1;
                batch
                    .add(*tok, pos, &[0], wants_logits)
                    .map_err(|e| format!("batch.add: {e}"))?;
                pos += 1;
            }
            ctx.decode(&mut batch).map_err(|e| format!("decode prompt: {e}"))?;
        }

        // NOTE: llama-cpp-2's token_to_piece decodes into a String whose
        // capacity is only the CURRENT token's byte length; when the previous
        // token buffered an incomplete UTF-8 sequence, the combined output
        // overflows that capacity and encoding_rs silently drops the rest —
        // the reported "확인�습니" replacement chars. We therefore take raw
        // bytes (token_to_piece_bytes) and do our own incremental UTF-8
        // assembly: append, flush the valid prefix, keep the split tail.
        let mut sampler = if sampled {
            LlamaSampler::chain_simple([
                // Standard llama.cpp anti-repetition: penalize the last 64
                // tokens; then low-temperature nucleus-ish sampling. Fixed seed
                // keeps runs reproducible.
                LlamaSampler::penalties(64, 1.15, 0.0, 0.0),
                LlamaSampler::temp(0.4),
                LlamaSampler::min_p(0.05, 1),
                LlamaSampler::dist(42),
            ])
        } else {
            LlamaSampler::chain_simple([LlamaSampler::greedy()])
        };
        // Incremental UTF-8 assembly: a Hangul codepoint can span two tokens.
        // `pending` holds the split tail bytes until the codepoint completes.
        let mut pending: Vec<u8> = Vec::new();
        let mut out = String::new();
        // Continue positions after the FULL prompt (batch.n_tokens() would only
        // count the last prefill chunk).
        let mut n_cur = total as i32;
        'gen: for _ in 0..max_tokens {
            let token = sampler.sample(&ctx, batch.n_tokens() - 1);
            sampler.accept(token);
            if self.model.is_eog_token(token) {
                break;
            }
            let bytes = match self.model.token_to_piece_bytes(token, 32, false, None) {
                Ok(b) => b,
                // Negative size = required buffer; retry once at that size.
                Err(llama_cpp_2::TokenToStringError::InsufficientBufferSpace(i)) => self
                    .model
                    .token_to_piece_bytes(token, i.unsigned_abs() as usize, false, None)
                    .map_err(|e| format!("token bytes: {e}"))?,
                Err(e) => return Err(format!("token bytes: {e}")),
            };
            {
                pending.extend_from_slice(&bytes);
                let valid = match std::str::from_utf8(&pending) {
                    Ok(_) => pending.len(),
                    Err(e) => e.valid_up_to(),
                };
                if valid > 0 {
                    out.push_str(
                        std::str::from_utf8(&pending[..valid]).expect("validated prefix"),
                    );
                    pending.drain(..valid);
                }
                // Fallback-path guard: cut fake dialogue turns.
                for m in STOP_MARKERS {
                    if let Some(i) = out.find(m) {
                        out.truncate(i);
                        break 'gen;
                    }
                }
                // Degenerate-loop guard (belt to the penalty sampler's braces):
                // if the trailing 24 chars already appeared ≥2 more times, the
                // model is looping one sentence — cut at the first occurrence.
                if out.chars().count() > 120 {
                    let tail: String =
                        out.chars().rev().take(24).collect::<Vec<_>>().into_iter().rev().collect();
                    if !tail.trim().is_empty() && out.matches(&tail).count() >= 3 {
                        if let Some(i) = out.find(&tail) {
                            out.truncate(i + tail.len());
                        }
                        break 'gen;
                    }
                }
            }
            batch.clear();
            batch
                .add(token, n_cur, &[0], true)
                .map_err(|e| format!("batch.add gen: {e}"))?;
            ctx.decode(&mut batch).map_err(|e| format!("decode gen: {e}"))?;
            n_cur += 1;
        }
        Ok(out.trim().to_string())
    }

    /// Classify a note into one of [`WIKI_TYPES`]. The output is validated
    /// against the label set (longest match wins). Uses a RAW completion prompt
    /// (no chat template): the "Type:" cue reliably elicits a bare label, while
    /// the chat path made the model answer conversationally / echo the note.
    pub fn classify(&self, note: &str) -> Result<String, String> {
        let prompt = format!(
            "You are a wiki classifier. Reply with exactly one of: {}.\nNote: {note}\nType:",
            WIKI_TYPES.join(", ")
        );
        let raw = self.run_prompt(&prompt, AddBos::Always, CLASSIFY_MAX_TOKENS, false)?;
        let low = raw.to_lowercase();
        let mut best: Option<&str> = None;
        for t in WIKI_TYPES {
            if low.contains(t) && best.map_or(true, |b| t.len() > b.len()) {
                best = Some(t);
            }
        }
        best.map(str::to_string)
            .ok_or_else(|| format!("no known label in model output: {raw:?}"))
    }

    /// Free-form, language-matched generation. `prompt` is the user turn (the
    /// caller may prepend inlined vault context); facts are unreliable at 0.5B.
    pub fn generate(&self, prompt: &str, max_tokens: i32) -> Result<String, String> {
        self.run(
            "You are Memex's built-in assistant. Answer briefly, in the same language as the question.",
            prompt,
            max_tokens.clamp(1, 512),
        )
    }
}
