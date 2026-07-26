# Cross-encoder rerank — Stage 1 (measurement) design

**Outcome (recorded after implementation): rejected.** The rerank arm measured
worse than the shipped hybrid retrieval (hit@1 80.6 % vs 82.3 %, MRR 0.901 vs
0.906) and was retired behind an off-by-default `rerank` cargo feature. See
`eval/BASELINE.md`, "Cross-encoder rerank — Stage 1", for the full numbers, and
the "Correction (implementation)" note in this document for a premise below
that the implementation proved false.

Parent: `2026-07-22-retrieval-first-ingest-design.md` (Approach A), whose Phase-1b
tail lists an optional cross-encoder rerank as **staged and conditional on a
feasibility spike**. That spike is done (two rounds); this is the increment it
authorised.

Scope: **measurement only**. Prove a reranker improves the eval before any product
surface is built. No download UX, no settings, no wiring into `semantic_search`.
Stage 2 (opt-in product) happens only if Stage 1 wins.

## What the spike established

Recorded in `scratchpad/rerank-spike.md` and `rerank-spike2.md`:

- **The primitive works.** `bge-reranker-v2-m3` Q4_K_M with `LlamaPoolingType::Rank`
  scores query/passage pairs that separate cleanly and reproducibly: for
  "What is RLHF?" — RLHF-Korean **+6.02**, RLHF-English **+3.31**,
  tokenization **−9.14**, shopping list **−10.99**; bit-identical across three
  processes. Korean scoring highest matters for this app's users.
- **Latency (measured, Metal, release, 390-token pairs):** ~74 ms/pair; 6 pairs
  ≈ 0.45 s, 12 pairs ≈ 0.9 s. Cold load 402 ms, ~950 MB peak RSS. CPU-only is
  **unmeasured** (estimated 2-4 s for 12).
- **Two upstream blockers, both real:**
  1. `llama-cpp-2 0.1.150`'s `Context::embeddings_seq_ith` builds
     `slice::from_raw_parts(ptr, n_embd)` over the 4-byte rank buffer, so the UB is
     committed inside the crate before we see it.
  2. `n_cls_out` is not discoverable through its safe API at all, so a
     user-supplied GGUF cannot be validated — and a model without a classification
     head returns an ordinary CLS embedding with **no error** (measured on the
     bundled bge-m3: `Ok, len=1024`).
- **`local_llm.rs` unconditionally L2-normalises** (`:502`), which would flatten a
  1-element score to ±1.0 and destroy the ranking, and `embed_pooled_with` puts each
  text in its own sequence — a cross-encoder needs query+passage in **one**.
- The model is **encoder-only**: llama.cpp logs "cannot decode batches with this
  context (calling encode() instead)" on every pair, so production should call
  `encode()`.

## Approach

**Add `llama-cpp-sys-2 = "=0.1.150"` as a direct dependency** (user-approved). It
is already in `Cargo.lock` as a transitive dep of `llama-cpp-2 0.1.150`, so this
adds **no new code to the build** — it only makes the already-compiled sys crate
callable. The exact `=` pin is deliberate: a version skew against `llama-cpp-2`
would build two copies of llama.cpp, and `=` turns that into a resolution error
instead of a silent disaster. Both blockers dissolve: we call
`llama_get_embeddings_seq` ourselves and read **exactly one** float, and we call
`llama_model_n_cls_out` to validate the model. An upstream PR to `llama-cpp-2` is
worth filing separately but must not gate this work.

### Components

**1. `src/rerank.rs` (new)** — the scoring primitive, isolated so all FFI lives in
one small, documented module:

```rust
pub struct Reranker { /* model + context */ }
impl Reranker {
    /// Loads a reranker GGUF. Fails if the model has no classification head
    /// (`n_cls_out != 1`) — without this check a plain embedding model scores
    /// silently and nonsensically.
    pub fn load(path: &Path) -> Result<Self, String>;
    /// Relevance score for one (query, passage) pair. Higher is better; the
    /// scale is model-defined and NOT normalised — normalising a 1-element
    /// vector would erase the ranking.
    pub fn score(&mut self, query: &str, passage: &str) -> Result<f32, String>;
    /// Scores pairs in input order. Returns one score per passage.
    pub fn score_batch(&mut self, query: &str, passages: &[String]) -> Result<Vec<f32>, String>;
}
```

> **Correction (implementation).** The doc comment above assumed `n_cls_out !=
> 1` was the way to reject a non-reranker model. Implementation proved that
> false: `n_cls_out` defaults to 1 for *any* model that omits
> `classifier.output_labels` — including the bundled `bge-m3` embedding
> model — so it cannot discriminate a reranker from a plain embedder at all.
> What shipped instead (`src/rerank.rs`, `require_classification_head`)
> inspects the GGUF's **tensor set** for `cls.weight` / `cls.output.weight` via
> a header-only parse; `n_cls_out == 1` is kept only as a secondary assert that
> is load-bearing solely for the `n_cls_out == 0` case. The reasoning above is
> left as originally written for the record.

Query and passage go into **one** sequence in the model's expected pair format;
`encode()` (not `decode()`); pooling `Rank`; no L2 normalisation. The unsound
wrapper is bypassed: one clearly-commented `unsafe` block reads a single `f32`
from the pointer `llama_get_embeddings_seq` returns, documenting the invariant
(`n_cls_out == 1`, enforced at load).

**2. Eval arm** — `examples/retrieval_eval.rs` gains a third reported block,
`dense+bm25+rerank`, active only when a reranker model path is supplied via env
(e.g. `MEMEX_RERANK_MODEL`); absent, the harness behaves exactly as today so the
existing recorded baselines stay reproducible. The arm reranks the **top-N fused
candidates** (N configurable in the harness, default 12 to match Ask's `k`) and
re-orders them by score, leaving the tail untouched.

**3. Unit tests** — `n_cls_out` validation rejects a non-reranker (use the bundled
bge-m3 as the negative case: it must be an `Err`, not a silent success); score
ordering on the spike's four pairs, with the Korean pair scoring above the
irrelevant ones; determinism (same input twice → identical score).

## Success criteria

- The rerank arm **beats the fused arm** on the extended eval (71 pages · 142
  chunks · 62 queries): hit@1 above 82.3 % and MRR above 0.906, with no query that
  fused ranks 1st pushed out of 1st. The ceiling is hit@1 100 % / MRR 1.0 since
  fused already reaches hit@10 100 %, so the honest question is what fraction of
  the remaining ~11 rank-1 promotions it captures.
- Two consecutive runs byte-identical (this codebase's determinism guarantee).
- Recorded in `eval/BASELINE.md` with the measured per-query latency alongside, so
  the quality gain is read against its cost.
- **If it does not beat fused, Stage 2 is dropped** and the finding is recorded —
  the same rule that retired wikify fusion.

## Non-goals (Stage 1)

No download UX, no settings toggle, no `semantic_search` wiring, no bundling (the
438 MB stays out of the repo and out of the installer), no CPU-only latency work,
no upstream PR. `MAX_CHUNKS`, BM25 params, `RRF_K`, and the `.mxb`/`.mxv` formats
are untouched.

## Risks

- **FFI soundness** — mitigated by confining `unsafe` to one module with the
  invariant enforced at load time and asserted in a test.
- **Version skew** with `llama-cpp-2` — mitigated by the `=` pin; note it in the
  dependency comment so a future bump moves both together.
- **Measured gain may be small** — the eval is already at hit@3 100 %, so there is
  limited headroom; that is exactly why Stage 1 exists before Stage 2.
- **Memory** — ~950 MB RSS while loaded, on top of the existing models. Stage 2
  must decide the model's lifetime; Stage 1 only notes it.
