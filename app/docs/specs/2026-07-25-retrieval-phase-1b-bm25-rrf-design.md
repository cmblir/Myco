# Retrieval Phase 1b (BM25 + RRF) — design

Parent spec: `2026-07-22-retrieval-first-ingest-design.md` (Approach A).
Predecessor increment: `2026-07-25-retrieval-phase-1b-eval-design.md` (de-saturated
the eval; recorded the bge-m3 dense baseline this increment must beat: **hit@1
72.6% · hit@10 98.4% · MRR 0.829 · nDCG@10 0.847** over 71 pages / 142 chunks /
62 queries, with 5 named weak queries).

Scope (user-approved): **full build in one increment** — a shared lexical
retrieval core, its persistence, incremental sync, wiring into both consumers, and
the eval measurement.

## Why

Dense (bge-m3) already handles Korean and paraphrases well, but the recorded weak
queries are lexical: rare exact tokens present in exactly one page (`PPO`, `RLAIF`)
and Korean phrases sharing a cross-lingual acronym where the English parallel page
outranks the Korean one (`PPO로 정책을 갱신…` → the English `rlhf` page wins on the
shared `PPO`). These are exactly what a **BM25 lexical arm** recovers, and **RRF**
(Reciprocal Rank Fusion) combines it with dense without score normalization.

## Components

### 1. `src/retrieval.rs` — the shared lexical core (new, self-contained)

**Tokenizer** — `pub fn tokenize(text: &str) -> Vec<String>`, script-aware, no
external dependency:
- Latin/ASCII-alphanumeric runs → one lowercased token each (`QLoRA`→`qlora`,
  `PPO`→`ppo`), so rare acronyms match exactly.
- CJK runs (Hangul syllables U+AC00–D7A3 + Jamo, CJK ideographs U+4E00–9FFF,
  Hiragana/Katakana) → **character bigrams** (`정책`→`정책`; `최적화`→`최적`,`적화`);
  a length-1 run emits the unigram. This is the standard lightweight CJK approach
  (cf. Lucene CJKAnalyzer) — Korean handled with no morphological analyzer.
- Everything else (whitespace/punctuation) is a boundary and dropped.

**`Bm25Index`** — an in-memory inverted index over chunks:
```rust
pub struct Bm25Doc { pub page: String, pub stem: String, pub section: usize, pub len: u32 }
pub struct Bm25Hit { pub page: String, pub stem: String, pub section: usize, pub score: f32 }
pub struct Bm25Index { /* docs, per-doc term freqs, inverted postings, df, avgdl, n */ }

impl Bm25Index {
    pub fn new() -> Self;
    // Replace all chunks of `page` (retain-then-add, mirroring VectorStore::upsert_page).
    pub fn upsert_page(&mut self, page: &str, stem: &str, chunk_texts: &[String]);
    pub fn prune(&mut self, existing: &HashSet<String>) -> usize; // drop absent pages
    pub fn search(&self, query: &str, k: usize) -> Vec<Bm25Hit>;   // BM25 over tokenized query
}
```
BM25: `k1 = 1.2`, `b = 0.75`; `idf(t) = ln(1 + (N - df + 0.5)/(df + 0.5))`. Mutations
store per-doc term-frequency maps and rebuild the inverted index + df from them
(rebuild is O(total terms); mutations are batched/debounced by the IndexUpdater, and
typical vaults are ≤ low-thousands of chunks). Chunk id is `"{page}#{section}"`,
identical to `VectorStore`.

**RRF fusion** — `pub fn rrf_fuse(dense: &[Hit], lexical: &[Bm25Hit], k: usize) -> Vec<Hit>`
where `Hit = vector_index::Hit` (`page,stem,section,score`). Score =
`Σ 1/(RRF_K + rank)` over each list a chunk appears in (`RRF_K = 60`, standard);
`score` on the returned `Hit` carries the fused RRF score. Dedup by chunk id, sort
desc, truncate `k`. If either arm is empty the fusion degrades to the other's order
(so a missing `.mxb` → dense-only, graceful).

Unit-tested in isolation: tokenizer (Latin/CJK/mixed/empty), BM25 (idf monotonicity,
exact-token retrieval, upsert-replaces-not-appends, prune), RRF (fuse order,
empty-arm degradation).

### 2. Persistence — `.mxb` sidecar (`src/retrieval.rs`)

A binary sidecar next to the `.mxv`, resolved by
`Bm25Index::path_for(vault_root) -> <settings_dir>/embeddings/<hash16>.mxb` (same
scheme as `VectorStore::path_for`). Magic `MXB1` + a format-version byte; persists,
per doc, `page`, `stem`, `section`, `len`, and the term→tf map. On decode the
inverted index/df/avgdl are rebuilt. `load(path) -> Self` never fatal (missing/corrupt
→ empty, like `VectorStore::load`); `save(&self, path)` atomic temp+rename. BM25 is
lexical and **not** gated on the embed model (no `ensure_model` wipe) — it follows the
same *build triggers* as the vector index but survives embed-model swaps.

### 3. Cache — `Bm25Cache` (`src/vector_index.rs` or `src/retrieval.rs`)

Mirrors `VectorCache`: a `Mutex<HashMap<PathBuf, Bm25Index>>` Tauri-managed state
with `get(path)` (load-and-cache) and `put(path, index)`. Registered in `lib.rs`
`.manage(...)` alongside `VectorCache`.

### 4. Incremental sync — `src/index_updater.rs`

BM25 updates at the **same three choke points** the vector index mutates, gated by
the same `if changed { save }`:
- **upsert** (`embed_one_page`, called in both reconcile and incremental branches):
  the page's chunks are already computed there for embedding — tokenize the same
  `Vec<String>` and call `bm25.upsert_page(rel, stem, &chunks)`.
- **delete** (incremental branch, missing file): `bm25.upsert_page(rel, "", &[])`
  drops the page (retain-then-add with no chunks).
- **prune** (reconcile branch): `bm25.prune(&present)`.
`process_batch` loads the `.mxb` alongside the `.mxv`, threads a `&mut Bm25Index`
through `embed_one_page`, and on `changed` saves the sidecar and `Bm25Cache::put`s it.
`embed_one_page` (`commands.rs`) gains a `&mut Bm25Index` parameter; its two callers
and any test callers are updated.

### 5. Wiring the two consumers — `src/commands.rs`

- **`semantic_search`**: load the `.mxb` via `Bm25Cache`; run dense
  `store.search(&qv, POOL)` and lexical `bm25.search(&query, POOL)` with
  `POOL = (k*5).clamp(20, 50)`; `rrf_fuse(&dense, &lexical, k)`; reconstruct text for
  the fused top-k exactly as today (`chunk_text_at`). The embed-model-stale and
  empty-index guards stay; if BM25 is empty the result equals today's dense-only.
- **`wikify_candidates`**: per source chunk, fuse dense `store.search(v,16)` with
  `bm25.search(&chunk_text,16)` via `rrf_fuse` before the
  `is_knowledge_page` filter, then `rank_candidates` as today.

### 6. Eval — `examples/retrieval_eval.rs`

Build a `Bm25Index` in memory from the same corpus chunks already indexed into the
vector store (English `SAMPLE_NOTES` + `eval/ko-corpus/`). Replace the dense-only
`ranked` construction with `rrf_fuse(store.search(&qvec,40), bm25.search(&lab.q,40), 40)`.
Compute metrics for **both** the dense-only `ranked` and the fused `ranked` in the
same run and print two result blocks (`dense` / `dense+bm25 (RRF)`) plus a per-query
rank-delta table, making the gain (or its absence) explicit. Record the fused
results and the delta as a new section in `eval/BASELINE.md`.

## Success criteria

- Fused BM25+RRF **beats the dense baseline** on the extended eval: MRR and hit@1
  up, and the 5 named weak queries (`PPO`, `RLAIF`, `PPO로 정책…`, `ko-scaling-laws`
  paraphrase, `constitutional principles`) improved — **without regressing** queries
  already at rank 1 (report any regressions honestly; net nDCG@10 must not drop).
- If fusion does **not** beat dense (honest outcome given the narrow measured gap),
  that is recorded and the wiring is reconsidered rather than shipped as a
  no-op cost. The eval decides.
- `cargo test` green (new `retrieval.rs` unit tests + unchanged suites); app builds;
  `semantic_search`/`wikify` behavior verified against a real vault (the wired path,
  not only the harness) per [[verify-renders-at-scale]].

## Non-goals

- No cross-encoder reranker (separate, later, feasibility-gated).
- No change to the `.mxv` format or the embed path.
- No `MAX_CHUNKS=8` wikify change (tracked separately).

## Reuse & risks

- Reuse: `VectorStore` (`Hit`, `search`, `path_for`, `upsert_page`/`prune`,
  atomic save pattern), `embeddings::chunk_page` (same chunks feed both arms),
  `IndexUpdater` choke points, `pipeline::{is_knowledge_page, rank_candidates}`.
- Risk — **index drift** between `.mxv` and `.mxb`: both are written at the same
  `if changed { save }` and keyed by the same chunk id, so they move together;
  reconcile-on-rebind rebuilds both. A missing/stale `.mxb` degrades to dense-only,
  never errors.
- Risk — **BM25 removal index shift**: avoided by storing per-doc term maps and
  rebuilding postings on mutation (no live doc-index compaction).
- Risk — **eval overfitting**: the fused numbers are measured on the same set the
  weak queries came from; report per-query deltas, not just aggregates, and watch
  for rank-1 regressions.
