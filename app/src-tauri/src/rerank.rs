//! Cross-encoder reranker — Stage 1, measurement only.
//!
//! **Retired.** Measured worse than the shipped hybrid (dense+BM25/RRF)
//! retrieval — hit@1 80.6% vs 82.3%, MRR 0.901 vs 0.906, 6 rank-1 demotions,
//! ~550 ms/query — so nothing here ships; it is kept behind the `rerank`
//! cargo feature purely so a future attempt (different model, page-level
//! rerank, different top-N) is one command away instead of a rewrite. See the
//! "Cross-encoder rerank — Stage 1" section of `eval/BASELINE.md` for the full
//! numbers, the verdict, and the exact reproduction command.
//!
//! A cross-encoder scores a (query, passage) PAIR in one forward pass, so it
//! sees the interaction between the two instead of comparing two independently
//! produced vectors. `bge-reranker-v2-m3` is the XLM-RoBERTa backbone we already
//! embed with (`bge-m3`) plus a 1-logit classification head; llama.cpp exposes
//! that logit through `LLAMA_POOLING_TYPE_RANK`.
//!
//! ## Why this module holds raw FFI instead of using `llama-cpp-2`
//!
//! `llama-cpp-2 0.1.150`'s only route to a pooled result is
//! `LlamaContext::embeddings_seq_ith`, which builds
//! `slice::from_raw_parts(ptr, n_embd)` (`src/context.rs:135`). Under Rank
//! pooling the C buffer behind that pointer holds `n_cls_out` floats — **one**
//! for this model (`llama.h:1027-1031`; `llama-context.cpp:1463-1473`). So the
//! crate constructs a 1024-element slice over a 4-byte allocation, and the UB is
//! committed inside the crate before a caller can defend against it. The crate's
//! `LlamaContext` is not `repr(transparent)` and its raw handle is `pub(crate)`,
//! so the pointer cannot be recovered from a context the crate created either.
//!
//! The fix is to own the context: this module creates the model, context and
//! batch through `llama-cpp-sys-2` and calls `llama_get_embeddings_seq` itself,
//! reading exactly one `f32`. That keeps ALL of the reranker's FFI in this one
//! file. The process-global backend is still shared with `local_llm`
//! (`local_llm::shared_backend`) — llama.cpp may only be initialized once.
//!
//! ## Two things that silently produce a working-looking, wrong reranker
//!
//! 1. **L2 normalisation.** `local_llm.rs` normalises every embedding it
//!    returns; on a 1-element score vector that maps every score to ±1.0 and
//!    erases the ranking. Nothing on this path normalises. Do not add it.
//! 2. **A model with no classification head.** Rank pooling on such a model
//!    falls through to plain CLS pooling and returns the first element of an
//!    ordinary embedding, with no error at any layer (measured on the bundled
//!    `bge-m3`). [`Reranker::load`] rejects those; see
//!    [`require_classification_head`].

use std::ffi::{c_char, CString};
use std::path::Path;

use llama_cpp_sys_2 as sys;

use crate::local_llm::shared_backend;

/// Context window for one (query, passage) pair. The backbone trains to 8192,
/// but the app's chunks target ~1800 bytes, so a pair fits inside 2048 tokens
/// with room to spare — and `n_ubatch` is pinned to the same value below, which
/// the Metal compute buffer scales with.
const CTX_TOKENS: u32 = 2048;

/// `llama_token` value meaning "this vocab has no such token".
const TOKEN_NULL: sys::llama_token = -1;

/// The GGUF tensors llama.cpp needs to build the Rank-pooling classification
/// head (`llama-graph.cpp`, `LLAMA_POOLING_TYPE_RANK`): `cls` and the optional
/// `cls.output`. If NEITHER is present, the head is skipped and Rank pooling
/// quietly returns the raw CLS embedding — the silent-nonsense case.
const CLS_HEAD_TENSORS: [&str; 2] = ["cls.weight", "cls.output.weight"];

/// A loaded cross-encoder plus the single context and batch it scores through.
///
/// Not `Send`/`Sync`: it owns raw llama.cpp handles that must be used and freed
/// on one thread.
pub struct Reranker {
    ctx: *mut sys::llama_context,
    batch: sys::llama_batch,
    model: *mut sys::llama_model,
    vocab: *const sys::llama_vocab,
    bos: sys::llama_token,
    eos: sys::llama_token,
    sep: sys::llama_token,
}

impl Reranker {
    /// Loads a reranker GGUF.
    ///
    /// Fails if the file has no classification head, which is the difference
    /// between a relevance score and a meaningless slice of an embedding.
    pub fn load(path: &Path) -> Result<Self, String> {
        // Header-only check first: it costs a few milliseconds and avoids
        // mapping ~438 MB of weights just to reject them.
        require_classification_head(path)?;

        // Reuse the process-wide backend rather than initializing a second one.
        let _backend = shared_backend()?;

        let c_path = CString::new(
            path.to_str()
                .ok_or_else(|| format!("rerank model path is not UTF-8: {}", path.display()))?,
        )
        .map_err(|_| "rerank model path contains a NUL byte".to_string())?;

        // SAFETY: `c_path` is a valid NUL-terminated C string that outlives the
        // call, and the backend has been initialized above. Returns null on
        // failure rather than aborting.
        let model = unsafe {
            sys::llama_model_load_from_file(c_path.as_ptr(), sys::llama_model_default_params())
        };
        if model.is_null() {
            return Err(format!(
                "load rerank model {}: llama.cpp returned null",
                path.display()
            ));
        }
        Self::finish_load(model).inspect_err(|_| {
            // SAFETY: `model` is the non-null handle just returned by
            // `llama_model_load_from_file` and has not been freed.
            unsafe { sys::llama_model_free(model) };
        })
    }

    /// Everything after the model is mapped. Split out so [`Reranker::load`] has
    /// exactly one place to free the model on failure.
    fn finish_load(model: *mut sys::llama_model) -> Result<Self, String> {
        // SAFETY: `model` is a live handle from `llama_model_load_from_file`.
        let n_cls_out = unsafe { sys::llama_model_n_cls_out(model) };
        // A multi-label classifier's first logit is not a relevance score, so
        // anything but a single output is refused. NOTE: this check alone does
        // NOT identify a reranker — `n_cls_out` defaults to 1 for every model
        // that omits `classifier.output_labels` (`llama-hparams.h:186`), which
        // includes both this reranker and a plain embedding model. The tensor
        // check in `require_classification_head` is the real discriminator.
        if n_cls_out != 1 {
            return Err(format!(
                "rerank model has n_cls_out = {n_cls_out}, expected 1 (single relevance logit)"
            ));
        }

        // SAFETY: same live `model` handle; the returned vocab borrows from it
        // and stays valid until `llama_model_free`.
        let vocab = unsafe { sys::llama_model_get_vocab(model) };
        if vocab.is_null() {
            return Err("rerank model has no vocab".to_string());
        }
        // SAFETY: `vocab` is the non-null vocab of a live model.
        let (bos, eos, sep) = unsafe {
            (
                sys::llama_vocab_bos(vocab),
                sys::llama_vocab_eos(vocab),
                sys::llama_vocab_sep(vocab),
            )
        };

        // Pooled output requires the whole sequence to land in ONE ubatch —
        // splitting it aborts the process from inside llama.cpp (the SIGTRAP
        // documented in `local_llm::embed_pooled_with`). Pinning n_batch and
        // n_ubatch to the full context window makes that unconditionally true
        // for any pair we can build, since pairs are truncated to CTX_TOKENS.
        //
        // SAFETY: plain value initialization of a C params struct, then one
        // call with a live model handle. Returns null on failure.
        let ctx = unsafe {
            let mut params = sys::llama_context_default_params();
            params.n_ctx = CTX_TOKENS;
            params.n_batch = CTX_TOKENS;
            params.n_ubatch = CTX_TOKENS;
            params.embeddings = true;
            params.pooling_type = sys::LLAMA_POOLING_TYPE_RANK;
            sys::llama_init_from_model(model, params)
        };
        if ctx.is_null() {
            return Err("rerank: llama_init_from_model returned null".to_string());
        }

        // SAFETY: allocates a batch for CTX_TOKENS token entries, no embeddings
        // input, one sequence. Freed in `Drop`.
        let batch = unsafe { sys::llama_batch_init(CTX_TOKENS as i32, 0, 1) };
        if batch.token.is_null() {
            // SAFETY: `ctx` is the live context created just above.
            unsafe { sys::llama_free(ctx) };
            return Err("rerank: llama_batch_init failed".to_string());
        }

        Ok(Self {
            ctx,
            batch,
            model,
            vocab,
            bos,
            eos,
            sep,
        })
    }

    /// Relevance score for one (query, passage) pair. Higher is better. The
    /// scale is model-defined (an unbounded logit) and is deliberately NOT
    /// normalised — normalising a 1-element vector would collapse every score
    /// to ±1.0 and erase the ranking.
    pub fn score(&mut self, query: &str, passage: &str) -> Result<f32, String> {
        let q = self.tokenize(query)?;
        self.score_pair(&q, passage)
    }

    /// Scores pairs in input order; one score per passage. The query is
    /// tokenized once and the model, context and batch are reused across the
    /// batch — the per-pair cost is the forward pass, nothing else.
    pub fn score_batch(&mut self, query: &str, passages: &[String]) -> Result<Vec<f32>, String> {
        let q = self.tokenize(query)?;
        let mut out = Vec::with_capacity(passages.len());
        for passage in passages {
            out.push(self.score_pair(&q, passage)?);
        }
        Ok(out)
    }

    fn score_pair(
        &mut self,
        query_tokens: &[sys::llama_token],
        passage: &str,
    ) -> Result<f32, String> {
        let tokens = self.build_pair(query_tokens, passage)?;
        self.encode(&tokens)?;
        self.read_rank_score()
    }

    /// Query and passage in ONE sequence, in llama.cpp's own `format_rerank`
    /// layout for XLM-R style rerankers: `<s> query </s></s> passage </s>`.
    /// A wrong separator degrades the score silently, so the special tokens come
    /// from the vocab rather than from a formatted string.
    fn build_pair(
        &self,
        query_tokens: &[sys::llama_token],
        passage: &str,
    ) -> Result<Vec<sys::llama_token>, String> {
        let mut passage_tokens = self.tokenize(passage)?;

        let mut specials = 0usize;
        for t in [self.bos, self.eos, self.sep, self.eos] {
            if t != TOKEN_NULL {
                specials += 1;
            }
        }
        let cap = CTX_TOKENS as usize;
        if query_tokens.len() + specials >= cap {
            return Err(format!(
                "rerank: query is {} tokens, too long for the {cap}-token pair window",
                query_tokens.len()
            ));
        }
        // Truncate the passage, never the query: the query is the thing being
        // matched, and a reranker is expected to judge a truncated passage.
        passage_tokens.truncate(cap - specials - query_tokens.len());

        let mut tokens =
            Vec::with_capacity(cap.min(query_tokens.len() + passage_tokens.len() + specials));
        if self.bos != TOKEN_NULL {
            tokens.push(self.bos);
        }
        tokens.extend_from_slice(query_tokens);
        if self.eos != TOKEN_NULL {
            tokens.push(self.eos);
        }
        if self.sep != TOKEN_NULL {
            tokens.push(self.sep);
        }
        tokens.extend_from_slice(&passage_tokens);
        if self.eos != TOKEN_NULL {
            tokens.push(self.eos);
        }
        Ok(tokens)
    }

    /// One `encode()` over the pair. This is an encoder-only model: llama.cpp
    /// logs "cannot decode batches with this context (calling encode() instead)"
    /// if `decode` is used, so we call `encode` directly rather than relying on
    /// that fallback.
    fn encode(&mut self, tokens: &[sys::llama_token]) -> Result<(), String> {
        if tokens.is_empty() {
            return Err("rerank: empty pair".to_string());
        }
        if tokens.len() > CTX_TOKENS as usize {
            return Err(format!(
                "rerank: pair is {} tokens, exceeds the {CTX_TOKENS}-token batch allocation",
                tokens.len()
            ));
        }

        // SAFETY: `self.ctx` is live. `llama_get_memory` returns null for a
        // model with no KV cache (this encoder-only BERT is one), so the clear
        // is conditional; when a memory does exist, stale keys from the previous
        // pair would leak into this one's pooled output.
        unsafe {
            let mem = sys::llama_get_memory(self.ctx);
            if !mem.is_null() {
                sys::llama_memory_clear(mem, true);
            }
        }

        // SAFETY: `self.batch` was allocated by `llama_batch_init(CTX_TOKENS, 0,
        // 1)`, so `token`/`pos`/`n_seq_id`/`logits` each address at least
        // CTX_TOKENS entries and each `seq_id[i]` addresses at least 1 — and
        // `tokens.len() <= CTX_TOKENS` by construction in `build_pair`. Every
        // token is marked as an output because pooling averages/selects over the
        // whole sequence; leaving any unmarked makes llama.cpp override them
        // with a warning.
        unsafe {
            for (i, tok) in tokens.iter().enumerate() {
                self.batch.token.add(i).write(*tok);
                self.batch.pos.add(i).write(i as sys::llama_pos);
                self.batch.n_seq_id.add(i).write(1);
                self.batch.seq_id.add(i).read().write(0);
                self.batch.logits.add(i).write(1);
            }
            self.batch.n_tokens = tokens.len() as i32;
        }

        // SAFETY: live context, and a batch whose invariants were just
        // established. `llama_batch` is passed by value (it is a bag of borrowed
        // pointers; ownership stays with us).
        let rc = unsafe { sys::llama_encode(self.ctx, self.batch) };
        if rc != 0 {
            return Err(format!("rerank: llama_encode failed ({rc})"));
        }
        Ok(())
    }

    /// Reads the single rank logit for sequence 0.
    fn read_rank_score(&mut self) -> Result<f32, String> {
        // SAFETY: `self.ctx` is a live context created with
        // `pooling_type = LLAMA_POOLING_TYPE_RANK` and `embeddings = true`, and
        // `llama_encode` has just succeeded for sequence 0. Under Rank pooling
        // `llama_get_embeddings_seq` returns a buffer of `n_cls_out` f32s
        // (`llama.h:1027-1031`), and `n_cls_out == 1` is enforced in
        // `finish_load` — so exactly one f32 at offset 0 is in bounds of the
        // real allocation. We read that one and nothing else: no slice is
        // built, so no length can be wrong. The pointer stays valid until the
        // next encode on this context, and f32 has no invalid bit patterns.
        // (This is the whole reason the module talks to llama-cpp-sys-2
        // directly; `llama-cpp-2`'s safe getter mis-sizes the slice to `n_embd`
        // before a caller can intervene.)
        let score = unsafe {
            let p = sys::llama_get_embeddings_seq(self.ctx, 0);
            if p.is_null() {
                return Err("rerank: no pooled output for sequence 0".to_string());
            }
            p.read_unaligned()
        };
        Ok(score)
    }

    /// Tokenizes without special tokens — [`Reranker::build_pair`] adds those in
    /// the pair layout the model expects.
    fn tokenize(&self, text: &str) -> Result<Vec<sys::llama_token>, String> {
        // A token is at least one byte of input, so bytes + 1 always suffices;
        // the negative-return path below is belt and braces.
        let mut buf = vec![0 as sys::llama_token; text.len() + 1];
        let mut n = self.tokenize_into(text, &mut buf);
        if n < 0 {
            buf.resize(n.unsigned_abs() as usize, 0);
            n = self.tokenize_into(text, &mut buf);
        }
        if n < 0 {
            return Err(format!("rerank tokenize failed ({n})"));
        }
        buf.truncate(n as usize);
        Ok(buf)
    }

    fn tokenize_into(&self, text: &str, buf: &mut [sys::llama_token]) -> i32 {
        // SAFETY: `self.vocab` belongs to the live model. `text` is passed as a
        // (pointer, length) pair so it needs no NUL terminator, and `buf` is a
        // mutable slice whose length is handed over honestly. llama.cpp writes
        // at most `n_tokens_max` entries and returns a negative required size if
        // that is too small.
        unsafe {
            sys::llama_tokenize(
                self.vocab,
                text.as_ptr().cast::<c_char>(),
                text.len() as i32,
                buf.as_mut_ptr(),
                buf.len() as i32,
                false,
                false,
            )
        }
    }
}

impl Drop for Reranker {
    fn drop(&mut self) {
        // SAFETY: each handle was created by its matching llama.cpp constructor
        // and is freed exactly once, in reverse order of creation (the batch and
        // context borrow from the model). `Drop` runs before the fields, and
        // none of them own anything themselves.
        unsafe {
            sys::llama_batch_free(self.batch);
            sys::llama_free(self.ctx);
            sys::llama_model_free(self.model);
        }
    }
}

/// Rejects a GGUF that has no Rank-pooling classification head.
///
/// This is the check that `llama_model_n_cls_out` cannot perform: that field
/// defaults to 1 for every model lacking a `classifier.output_labels` array
/// (`llama-hparams.h:186`), and this reranker's GGUF does not carry one — so it
/// reads 1 for a real reranker AND for a plain embedding model. The
/// discriminating signal is the tensor set. Reading the GGUF header is cheap
/// (`no_alloc`, no tensor data touched).
fn require_classification_head(path: &Path) -> Result<(), String> {
    let c_path = CString::new(
        path.to_str()
            .ok_or_else(|| format!("rerank model path is not UTF-8: {}", path.display()))?,
    )
    .map_err(|_| "rerank model path contains a NUL byte".to_string())?;

    // SAFETY: valid C string; `no_alloc` with a null `ctx` means gguf only
    // parses the header and allocates nothing for tensor data. Returns null if
    // the file is missing or not a GGUF.
    let gguf = unsafe {
        sys::gguf_init_from_file(
            c_path.as_ptr(),
            sys::gguf_init_params {
                no_alloc: true,
                ctx: std::ptr::null_mut(),
            },
        )
    };
    if gguf.is_null() {
        return Err(format!(
            "rerank: cannot read GGUF header of {}",
            path.display()
        ));
    }

    let mut found = false;
    for name in CLS_HEAD_TENSORS {
        let c_name = CString::new(name).expect("static tensor name has no NUL");
        // SAFETY: live gguf context and a valid C string; returns a negative
        // index when the tensor is absent.
        if unsafe { sys::gguf_find_tensor(gguf, c_name.as_ptr()) } >= 0 {
            found = true;
            break;
        }
    }
    // SAFETY: `gguf` is the live context from `gguf_init_from_file`, freed once.
    unsafe { sys::gguf_free(gguf) };

    if found {
        Ok(())
    } else {
        Err(format!(
            "{} has no classification head ({}): it is not a cross-encoder reranker. \
             Rank pooling on such a model returns part of an ordinary embedding, with no error.",
            path.display(),
            CLS_HEAD_TENSORS.join(" / ")
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Where the Stage-1 spike keeps the reranker. Deliberately OUTSIDE the
    /// repo: `models/` is git-LFS tracked and this file must never enter the
    /// working tree. Overridable so another machine can point elsewhere.
    fn reranker_path() -> PathBuf {
        crate::env::var("MYCO_RERANK_MODEL")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(std::env::var("HOME").unwrap_or_default())
                    .join(".cache/memex-spike/bge-reranker-v2-m3-Q4_K_M.gguf")
            })
    }

    fn bundled_embed_model() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("models/bge-m3-Q4_K_M.gguf")
    }

    // The bundled embedding model must be REJECTED, not silently scored. This is
    // the regression test for the spike's measured failure mode: Rank pooling on
    // bge-m3 returned `Ok` with no warning. Needs the 438 MB bge-m3 GGUF, which
    // the repo no longer tracks (see .gitignore; keep a local copy in models/),
    // so it skips when absent. Not #[ignore]d: it loads no weights
    // (header parse only) and is the check most worth running by default.
    #[test]
    fn rejects_a_model_without_a_classification_head() {
        let path = bundled_embed_model();
        if !path.exists() {
            return; // model not present on this machine
        }
        let err = match Reranker::load(&path) {
            Ok(_) => panic!("bge-m3 has no classification head but load() succeeded"),
            Err(e) => e,
        };
        assert!(err.contains("no classification head"), "got: {err}");
    }

    // E2E over the real 438 MB reranker. #[ignore]d by default like the other
    // model-loading tests in this crate (see `local_llm::tests`), AND guarded on
    // the file existing, since it lives outside the repo. Run with:
    //   cargo test --lib rerank -- --ignored
    #[test]
    #[ignore]
    fn scores_separate_relevant_from_irrelevant() {
        let path = reranker_path();
        if !path.exists() {
            return; // reranker GGUF not downloaded on this machine
        }
        let mut r = Reranker::load(&path).expect("load reranker");
        let query = "What is RLHF?";
        let passages: Vec<String> = vec![
            "RLHF is reinforcement learning from human feedback: a reward model is trained on \
             human preference comparisons, then the policy is updated against it with PPO."
                .into(),
            "Byte-pair encoding builds a subword vocabulary by repeatedly merging the most \
             frequent adjacent pair of symbols in the training corpus."
                .into(),
            "RLHF는 인간 피드백 기반 강화학습이다. 사람의 선호 비교 데이터로 보상 모델을 \
             학습한 뒤, PPO로 정책을 갱신한다."
                .into(),
            "Shopping list: milk, eggs, coffee beans, two lemons, a loaf of rye bread.".into(),
        ];
        let s = r.score_batch(query, &passages).expect("score batch");
        let (rlhf_en, bpe, rlhf_ko, shopping) = (s[0], s[1], s[2], s[3]);
        assert!(
            rlhf_en > bpe && rlhf_en > shopping,
            "English RLHF passage ({rlhf_en}) must beat tokenization ({bpe}) and shopping ({shopping})"
        );
        assert!(
            rlhf_ko > bpe && rlhf_ko > shopping,
            "Korean RLHF passage ({rlhf_ko}) must beat tokenization ({bpe}) and shopping ({shopping})"
        );
    }

    // Determinism: the same pair scored twice yields the SAME bits. The whole
    // eval's reproducibility guarantee rests on this.
    #[test]
    #[ignore]
    fn scoring_is_deterministic() {
        let path = reranker_path();
        if !path.exists() {
            return; // reranker GGUF not downloaded on this machine
        }
        let mut r = Reranker::load(&path).expect("load reranker");
        let q = "How does the KL penalty in RLHF stop the policy from drifting?";
        let p = "The KL divergence penalty keeps the updated policy close to the reference \
                 model, trading a little reward for staying on-distribution.";
        let a = r.score(q, p).expect("score a");
        let b = r.score(q, p).expect("score b");
        assert_eq!(
            a.to_bits(),
            b.to_bits(),
            "same pair must score identically: {a} vs {b}"
        );
    }
}
