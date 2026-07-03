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
use llama_cpp_2::model::{AddBos, LlamaModel, Special};
use llama_cpp_2::sampling::LlamaSampler;

/// The wiki page types the classifier maps a note to (matches the frontmatter
/// `type` enum). Longest-match wins so "source-summary" beats a stray "source".
pub const WIKI_TYPES: [&str; 5] =
    ["concept", "entity", "technique", "source-summary", "analysis"];

const CTX_TOKENS: u32 = 4096;
const CLASSIFY_MAX_TOKENS: i32 = 6;

pub struct LocalLlm {
    // The backend guard must outlive the model; drop deinits llama.cpp.
    backend: LlamaBackend,
    model: LlamaModel,
}

impl LocalLlm {
    /// Load the bundled GGUF. Call once per process (backend init is global).
    pub fn load(model_path: &Path) -> Result<Self, String> {
        let backend = LlamaBackend::init().map_err(|e| format!("llama backend init: {e}"))?;
        let model =
            LlamaModel::load_from_file(&backend, model_path, &LlamaModelParams::default())
                .map_err(|e| format!("load model {}: {e}", model_path.display()))?;
        Ok(Self { backend, model })
    }

    /// Greedy decode `prompt` for up to `max_tokens`, returning the text.
    fn run(&self, prompt: &str, max_tokens: i32) -> Result<String, String> {
        let n_ctx = NonZeroU32::new(CTX_TOKENS).ok_or("invalid ctx size")?;
        let ctx_params = LlamaContextParams::default().with_n_ctx(Some(n_ctx));
        let mut ctx = self
            .model
            .new_context(&self.backend, ctx_params)
            .map_err(|e| format!("new_context: {e}"))?;

        let tokens = self
            .model
            .str_to_token(prompt, AddBos::Always)
            .map_err(|e| format!("tokenize: {e}"))?;

        let mut batch = LlamaBatch::new(512, 1);
        let last = tokens.len() as i32 - 1;
        for (i, tok) in (0i32..).zip(tokens.iter()) {
            batch
                .add(*tok, i, &[0], i == last)
                .map_err(|e| format!("batch.add: {e}"))?;
        }
        ctx.decode(&mut batch).map_err(|e| format!("decode prompt: {e}"))?;

        let mut sampler = LlamaSampler::chain_simple([LlamaSampler::greedy()]);
        let mut out = String::new();
        let mut n_cur = batch.n_tokens();
        for _ in 0..max_tokens {
            let token = sampler.sample(&ctx, batch.n_tokens() - 1);
            sampler.accept(token);
            if self.model.is_eog_token(token) {
                break;
            }
            // TODO(korean): token_to_str decodes per-token and can split a
            // multi-byte Hangul token; switch to byte accumulation + one decode
            // for clean Korean query output. ASCII labels (classify) are fine.
            if let Ok(piece) = self.model.token_to_str(token, Special::Tokenize) {
                out.push_str(&piece);
            }
            batch.clear();
            batch
                .add(token, n_cur, &[0], true)
                .map_err(|e| format!("batch.add gen: {e}"))?;
            ctx.decode(&mut batch).map_err(|e| format!("decode gen: {e}"))?;
            n_cur += 1;
        }
        Ok(out)
    }

    /// Classify a note into one of [`WIKI_TYPES`]. The output is validated
    /// against the label set (longest match wins).
    pub fn classify(&self, note: &str) -> Result<String, String> {
        let prompt = format!(
            "You are a wiki classifier. Reply with exactly one of: {}.\nNote: {note}\nType:",
            WIKI_TYPES.join(", ")
        );
        let raw = self.run(&prompt, CLASSIFY_MAX_TOKENS)?;
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

    /// Free-form, language-matched generation. The caller should inline vault
    /// context for grounding; facts are unreliable at 0.5B.
    pub fn generate(&self, prompt: &str, max_tokens: i32) -> Result<String, String> {
        self.run(prompt, max_tokens.clamp(1, 512))
    }
}
