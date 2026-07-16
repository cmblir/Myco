//! Embedded local model — in-process llama.cpp inference over the bundled
//! Gemma 3 1B GGUF (instruction-tuned, Q4_K_M). No daemon, no API key, no
//! Python: this is the zero-setup, offline provider for CLASSIFICATION (note
//! type) and light, language-matched QUERY. It is a 1B model — solidly
//! multilingual but still weak on facts — so high-quality ingest stays on the
//! paid providers.
//!
//! `LlamaBackend::init()` is process-global and must run exactly once, so a
//! single `LocalLlm` is loaded into Tauri state at startup and reused; each call
//! spins up a fresh context (cheap) off the shared model.
//!
//! Prompts go through the model's own chat template (from the GGUF) so the
//! instruct tuning actually engages — feeding raw "User:/Assistant:" text made
//! the base LM continue the transcript with fake turns and thinking-style
//! artifacts. Tokenized prompts are truncated to fit the context window
//! (keeping the tail, where the question lives) and prefilled in fixed-size
//! chunks — pushing a whole prompt into one batch overflowed it ("Insufficient
//! Space of 512") the moment vault context was inlined.
//!
//! Classification uses greedy decoding + a short token cap + post-validation
//! against the label set, NOT a GBNF grammar: the grammar sampler crashes in the
//! vendored llama.cpp of llama-cpp-2 0.1.150 (`GGML_ASSERT(!stacks.empty())`,
//! upstream PR #17869). The model emits clean labels, so post-match is reliable.

use std::num::NonZeroU32;
use std::path::Path;

use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::context::params::LlamaPoolingType;
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

    /// How many tokens `text` costs this model. The context window is measured in
    /// tokens while everything upstream (chunk sizes, vault-context budgets) is
    /// measured in bytes, and the ratio between them swings wildly by script —
    /// so a caller that needs the real number has to ask the tokenizer.
    pub fn token_count(&self, text: &str) -> Result<usize, String> {
        self.model
            .str_to_token(text, AddBos::Always)
            .map(|t| t.len())
            .map_err(|e| format!("tokenize: {e}"))
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
    /// text (pure greedy sends a model this small into degenerate sentence loops —
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

        // Chunked prefill: a long prompt is decoded PREFILL_CHUNK tokens at a
        // time. The binding limit is the batch we allocate immediately below —
        // LlamaBatch::add rejects the token past `allocated`, which is what the
        // "Insufficient Space of 512" failure was when this pushed a whole
        // prompt into one fixed-size batch. So the chunk size and the batch
        // allocation must stay equal; they are both PREFILL_CHUNK for that
        // reason.
        //
        // llama.cpp's own GGML_ASSERT(n_tokens_all <= cparams.n_batch) sits
        // above this: n_batch defaults to 2048 (n_ubatch is the one that
        // defaults to 512), so a 512-token chunk clears it with room to spare.
        // Raising PREFILL_CHUNK is therefore possible — llama-cpp-2 does expose
        // with_n_batch/with_n_ubatch — but no measurement says it is worth it,
        // and prefill on this path has never been profiled. Bench before tuning.
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

    /// Embed texts with the bundled model in embeddings mode (mean-pooled,
    /// L2-normalized). Offline, no key — reuses the already-loaded Gemma weights.
    /// Quality trails a dedicated embed model but needs zero extra assets.
    ///
    /// One context serves the whole call. Building a context costs ~78 ms and
    /// this used to build one per text, which reindex pays per chunk — measured
    /// at 1.25x over a page's worth of chunks (3114 ms -> 2491 ms for 8), and
    /// ~23 s across a 300-chunk vault. The sequences stay independent because
    /// the KV cache is cleared between them; verified against a fresh context
    /// per text, the vectors are bit-identical (max |Δ| = 0.0).
    pub fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
        const EMBED_CTX: u32 = 2048;
        let n_ctx = NonZeroU32::new(EMBED_CTX).ok_or("invalid embed ctx")?;
        let cap = EMBED_CTX as usize - 8;

        // Tokenize everything up front: the context is sized to the widest
        // sequence in the call, which cannot be known one text at a time.
        let mut token_sets = Vec::with_capacity(texts.len());
        for text in texts {
            let mut tokens = self
                .model
                .str_to_token(text, AddBos::Always)
                .map_err(|e| format!("embed tokenize: {e}"))?;
            tokens.truncate(cap);
            token_sets.push(tokens);
        }
        let max_n = token_sets.iter().map(Vec::len).max().unwrap_or(0);
        if max_n == 0 {
            // No tokens at all (an empty `texts`, or a tokenizer that emitted
            // nothing) — there is no context worth building.
            return Ok(texts.iter().map(|_| Vec::new()).collect());
        }

        // Mean pooling collapses a sequence into one vector, which llama.cpp can
        // only do when that whole sequence lands in a single ubatch. n_ubatch
        // defaults to 512, so this once fed anything longer through
        // `tokens.chunks(512)` and decoded it in pieces — which aborts the
        // process from inside llama.cpp (SIGTRAP; not an Err this could return,
        // nor a panic it could catch). A vault page written as one long
        // paragraph reaches that: a real chunk_page output of Korean prose
        // measured 1,501 tokens, and reindexing it killed the app.
        //
        // Size to the widest text in the call, and no larger: the Metal compute
        // buffer scales with n_ubatch at ~1 MiB/token, so pinning it to the 2048
        // ceiling would reserve ~2 GiB to embed a 400-token chunk. Callers pass
        // one page's chunks, which chunk_page has already bounded to a common
        // size, so the widest is close to the average and nothing pays much for
        // sharing.
        let ctx_params = LlamaContextParams::default()
            .with_n_ctx(Some(n_ctx))
            .with_embeddings(true)
            .with_pooling_type(LlamaPoolingType::Mean)
            .with_n_batch(max_n as u32)
            .with_n_ubatch(max_n as u32);
        let mut ctx = self
            .model
            .new_context(&self.backend, ctx_params)
            .map_err(|e| format!("embed new_context: {e}"))?;
        let mut batch = LlamaBatch::new(max_n, 1);

        let mut out = Vec::with_capacity(texts.len());
        for tokens in &token_sets {
            // Unreachable on this tokenizer — AddBos::Always means even "" is
            // one BOS token — but a tokenizer that yields nothing must not index
            // into an empty batch.
            if tokens.is_empty() {
                out.push(Vec::new());
                continue;
            }
            // Each text is its own sequence. Clearing the KV cache is what keeps
            // them independent while the context is shared — without it the
            // previous text's keys would still be in the window and leak into
            // this one's pooled vector.
            ctx.clear_kv_cache();
            batch.clear();
            for (i, tok) in tokens.iter().enumerate() {
                // Mark output on every token; Mean pooling averages the
                // sequence's token embeddings into one vector.
                batch
                    .add(*tok, i as i32, &[0], true)
                    .map_err(|e| format!("embed batch.add: {e}"))?;
            }
            ctx.decode(&mut batch).map_err(|e| format!("embed decode: {e}"))?;
            let emb = ctx
                .embeddings_seq_ith(0)
                .map_err(|e| format!("embeddings_seq_ith: {e}"))?;
            let mut v = emb.to_vec();
            crate::embeddings::normalize(&mut v);
            out.push(v);
        }
        Ok(out)
    }

    /// Free-form, language-matched generation. `prompt` is the user turn (the
    /// caller may prepend inlined vault context); facts are unreliable at 1B.
    pub fn generate(&self, prompt: &str, max_tokens: i32) -> Result<String, String> {
        self.run(
            "You are Memex's built-in assistant. Answer briefly, in the same language as the question.",
            prompt,
            max_tokens.clamp(1, 512),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn cos(a: &[f32], b: &[f32]) -> f32 {
        crate::embeddings::cosine(a, b)
    }

    // E2E: load the bundled Gemma model and embed. Ignored by default (loads a
    // 769 MB model, ~seconds). Run with: cargo test --lib -- --ignored embed
    #[test]
    #[ignore]
    fn builtin_embeddings_are_meaningful() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("models/gemma-3-1b-it-q4_k_m.gguf");
        let llm = LocalLlm::load(&path).expect("load gemma model");
        let v = llm
            .embed(&[
                "a domestic cat".to_string(),
                "a pet dog".to_string(),
                "a diesel truck engine".to_string(),
            ])
            .expect("embed");
        assert_eq!(v.len(), 3);
        assert!(!v[0].is_empty(), "embedding must be non-empty");
        assert_eq!(v[0].len(), v[1].len(), "consistent dimension");
        // cat should be closer to dog than to truck engine.
        let cat_dog = cos(&v[0], &v[1]);
        let cat_truck = cos(&v[0], &v[2]);
        assert!(
            cat_dog > cat_truck,
            "cat~dog ({cat_dog}) should exceed cat~truck ({cat_truck})"
        );
    }
}
