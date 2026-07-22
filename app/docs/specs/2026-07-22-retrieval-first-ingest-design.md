# Retrieval-First Ingest / Query — Design Spec (Phase 1)

- **Date:** 2026-07-22
- **Status:** Design approved; implementation pending. Phase 0 (eval harness +
  baseline) DONE and pushed (`1507e24`). This spec covers **Phase 1** of the
  retrieval-first redesign (full "Approach A", highest-ROI stage).
- **Scope:** Make Memex retrieval good enough that "Ask" is fed the *right*
  pages, and that pages ingested by any writer (MCP, in-app ingest, external
  editor) become searchable without a manual reindex. The LLM stays only for the
  final prose answer / summary; **organization and retrieval move to deterministic,
  measured code.**

## Motivation (the numbers this must beat)

Baseline — Gemma-3-1B mean-pooled dense embeddings, cosine, dense-only
(`eval/BASELINE.md`, 51 pages / 102 chunks / 30 queries):

| k  | hit@k  | recall@k |
|----|--------|----------|
| 1  | 20.0 % | 18.3 %   |
| 10 | 53.3 % | 53.3 %   |

**MRR 0.323 · nDCG@10 0.353.** ~47 % of queries retrieve **no** relevant page in
the top 10 — so the model answering "Ask" is fed the wrong pages nearly half the
time. Two failure clusters drive Phase 1:

- **Exact-term / acronym misses** (`BPE @12`, `DPO @27`, `multi-head-attention`
  and `positional-encoding` miss the top-40 entirely) — a mean-pooled decoder LM
  does not encode rare exact tokens. This is what a **lexical (BM25) arm** recovers.
- **Semantic-paraphrase weakness** (`attention-mechanism @36`, `self-attention @31`)
  — a mean-pooled **decoder chat model used as an embedder** is the wrong tool;
  a purpose-built bi-encoder is the fix.

### Root cause (from the code audit)

- **Bundled Gemma-3-1B is a decoder chat model** mean-pooled into an embedding
  (`local_llm::embed`, `LlamaPoolingType::Mean`). Purpose-built bi-encoders beat
  this substantially. Highest-ROI single change.
- **Two retrieval sites, both dense-only, unshared:** "Ask" (`semantic_search`
  → frontend `chat.ts semanticContext`) and ingest-dedup (`wikify_candidates` →
  `pipeline::rank_candidates`). Improvements land in only one today.
- **Ask inlines WHOLE pages, not chunks.** `Hit` carries no chunk text
  (`vector_index.rs:63`), so `chat.ts:200-214` re-reads entire page bodies into a
  6 000-char local window — one large page starves the rest.
- **The index is decoupled from every writer.** Only `reindex_embeddings` (manual
  button + off-by-default foreground poller) ever writes the `.mxv`. **MCP write
  tools do not touch the index** (verified: zero index references in
  `mcp_native.rs`), so MCP-ingested pages are invisible to Ask until a manual
  reindex.
- **The only ingest "success" signal is an mtime gate** (`ingestStore.ts:304-328`:
  "did any `wiki/*.md` mtime change?") — no citation/frontmatter validation.

## Decisions (locked)

1. **Embedding model — bundle a purpose-built embedding GGUF, run in-process**
   via the existing `llama-cpp-2` seam (same path as `local_llm::embed`). No new
   runtime dependency, offline, keeps the app self-contained (matches the
   embedded-model philosophy in [[2026-07-01-embedded-local-model]]). The Ollama
   provider (`embeddings::embed_ollama`) stays as an optional seam, not the
   default. **The specific model is chosen by a bake-off in the eval harness**
   (candidates below), judged on quality-per-MB.
2. **Candidate embed models (bake-off):** `bge-m3` (568 M, 1024-d, 8192-token,
   **CLS pooling**, MIRACL Korean-tuned — front-runner for this Korean+English
   vault), `multilingual-e5-large` (560 M, 1024-d, 512-token, **mean pooling**),
   `nomic-embed-text-v1.5` (768-d, mean, English-leaning, smallest). **Pooling
   type must match the chosen model** — the current code hardcodes `Mean`; bge-m3
   needs `Cls`. Roughly +100–360 MB to the bundle depending on the winner/quant.
3. **Lexical arm — a self-contained, CJK-aware BM25** over the same in-memory
   chunk corpus. Rejected Tantivy (heavy compile, weak out-of-box CJK) and SQLite
   FTS5 (adds `rusqlite`, weak CJK unicode61). Reasons to build our own: the vault
   is Korean+English (we must control tokenization — Unicode word segmentation +
   CJK bigrams), the corpus is personal-scale (thousands of chunks, brute-force is
   fine, same as the existing `VectorStore`), and it keeps the lightweight-first,
   no-heavy-dep posture.
4. **Fusion — Reciprocal Rank Fusion (RRF)** of the dense and lexical rankings
   (`score = Σ 1/(k + rank_i)`, k≈60). Simple, tuning-free, robust to score-scale
   mismatch between arms.
5. **Reranker — STAGED and CONDITIONAL.** llama.cpp supports reranking
   (`--pooling rank`, `bge-reranker-v2-m3` GGUF exists), but whether
   **`llama-cpp-2 0.1.150` exposes `LlamaPoolingType::Rank` and the rank score is
   UNVERIFIED**. Phase 1c begins with a feasibility spike; the reranker ships only
   if the spike succeeds **and** it beats RRF-only enough to justify ~+360 MB.
6. **Incremental index — both an in-process write-hook and a `notify` file-watcher,**
   funnelled into one `IndexUpdater` (below). Write-hook gives immediacy for
   in-app/MCP writes; the watcher is the safety net that also catches external
   editors (Obsidian/vim). Double-fire is idempotent via the existing content-hash
   skip.
7. **Spec/convention:** design docs live in `app/docs/specs/` (project convention),
   not the Superpowers default. Indexes remain rebuildable sidecars outside git.

## Architecture

### One shared retrieval core

New module **`src-tauri/src/retrieval.rs`** — the single fused retriever both
sites call:

```
retrieval::search(store, bm25, query, k) -> Vec<ScoredChunk>
  ScoredChunk { page, stem, section, text, score }   // NOTE: carries chunk TEXT
  1. qv = embed(query)                 // real bundled embed model
  2. dense = store.search(qv, N)       // existing brute-force cosine (VectorStore)
  3. lexical = bm25.search(query, N)   // NEW self-contained CJK BM25
  4. fused = rrf(dense, lexical, k=60) // reciprocal rank fusion
  5. [optional] fused = rerank(query, fused)  // Phase 1c, conditional
  return top-k
```

The critical shape change: **`ScoredChunk` carries the chunk text.** Today `Hit`
returns only `{page, stem, section, score}`, forcing whole-page re-reads. Carrying
text lets Ask inline passages (1d) and removes a filesystem round-trip.

Both consumers switch to this core:

- **Ask:** `commands::semantic_search` (`commands.rs:1502`) returns `ScoredChunk`s;
  `chat.ts semanticContext` inlines the returned passages, not whole files.
- **Ingest-dedup:** `commands::wikify_candidates` (`commands.rs:1556`) feeds
  `retrieval::search` results into `pipeline::rank_candidates` (which stays the
  page-level fold), so dedup grounding gets the same lexical+dense boost.

### The BM25 index

`src-tauri/src/bm25.rs` (NEW) — an in-memory inverted index over the same chunks
the `VectorStore` holds, keyed identically (`page` = vault-relative path,
`section` = chunk index), so the two arms align 1:1 for fusion. Tokenizer:
Unicode word segmentation for Latin/space-delimited text + character bigrams for
CJK runs (Hangul/Han/Kana), lowercased, so exact terms *and* Korean substrings
match. Persisted as a sidecar next to the `.mxv` (or rebuilt from the vault —
cheap at this scale); kept in sync by the same `IndexUpdater`.

### IndexUpdater (incremental)

`src-tauri/src/index_updater.rs` (NEW) — a serialized updater that owns
"vault changed → index changed":

```
IndexUpdater::mark_dirty(rel_path)      // called by write-hook AND watcher
  → debounce/coalesce per path (e.g. 500 ms)
  → for each dirty page: read → chunk → content_hash
      → skip unchanged chunks (existing hash compare)   // idempotent double-fire
      → embed changed chunks → VectorStore::upsert_page + bm25.upsert_page
  → persist (.mxv + bm25 sidecar), publish to VectorCache
```

- **Write-hook feed:** each MCP writer in `mcp_native.rs` (`create_page`,
  `update_page`, `add_raw_source`, …) and the in-app ingest write path call
  `IndexUpdater::mark_dirty` after `vault::write_file`.
- **Watcher feed:** a `notify` watcher on `<vault>/wiki` (Rust backend, runs
  regardless of UI foreground) calls the same `mark_dirty`.
- Fixes today's poller limits: it builds a first index (poller refuses when
  `indexed_pages == 0`) and runs with the app backgrounded.

## Sub-phases (each gated by the eval harness)

Commit order: **1a → 1b → (measure, decide 1c) → 1d → 1e → 1f → 1g.** Measured
retrieval wins (1a/1b) land first, then Ask surfacing (1d), then freshness /
correctness (1e/1f/1g). Each retrieval-affecting step must beat the prior number
or it is dropped (BASELINE methodology).

| Step | Change | Key files | Acceptance |
|------|--------|-----------|------------|
| **1a** | Bundle a real embed GGUF; bake off candidates; match pooling type; swap the embed path; handle model-space-guard migration (force reindex when the model id changes) | `local_llm.rs` (embed model load + pooling), `commands.rs` (`embed_texts`, `reindex_embeddings`, `semantic_search` guard), `Cargo.toml`/resources, `retrieval_eval.rs` | Winner beats baseline hit@10 / MRR; harness re-run recorded |
| **1b** | `bm25.rs` CJK BM25 arm + `retrieval.rs` RRF fusion; both sites call the core | `bm25.rs` (NEW), `retrieval.rs` (NEW), `commands.rs` | Fused beats 1a on exact-term queries (BPE/DPO/…); overall MRR up |
| **1c** | Reranker — **feasibility spike first** (`LlamaPoolingType::Rank` in `llama-cpp-2`); adopt only if it beats RRF-only and justifies bundle size | spike, then `retrieval.rs` + model resource | Beats 1b by a margin worth ~+360 MB, else deferred to Phase 2 |
| **1d** | Ask inlines chunk passages, not whole pages; `ScoredChunk.text` fills the 6 000-char local window with top passages | `commands.rs` (`semantic_search` return shape), `chat.ts` (`semanticContext`), `ipc.ts` | Ask answers cite correct pages; window holds more relevant passages |
| **1e** | `IndexUpdater` + `notify` watcher + write-hooks in every MCP writer and in-app ingest | `index_updater.rs` (NEW), `mcp_native.rs`, ingest write path, `vector_index.rs` (reuse `upsert_page`/`prune`) | An MCP-written page is Ask-searchable within the debounce window, no manual reindex; first index self-builds |
| **1f** | Replace the mtime gate with a deterministic validator: citations resolve to real `raw/` sources + line ranges, frontmatter schema, wikilinks resolve | ingest validator (Rust command + `ingestStore.ts`) | Ingest fails loudly on unresolved citations / bad frontmatter; no silent "success" on hallucinated cites |
| **1g** | `wikify_candidates`: drop `MAX_CHUNKS = 8` (spread-sample the source), use the shared core | `commands.rs:1580-1585`, `retrieval.rs` | Dedup grounding surfaces related pages from the *whole* source, not just the leading ~14 k chars |

## Cross-cutting

- **Eval gate:** `cargo run --example retrieval_eval --release` after every
  retrieval-affecting step; append each result to `eval/BASELINE.md`. A change
  that doesn't beat the prior number is dropped, not shipped.
- **Model version pinning:** embed (and, if adopted, rerank) model versions are
  pinned; the index stores its model id (`"{provider}:{model}"`) and a mismatch
  forces a reindex. Document the migration on upgrade.
- **Indexes are rebuildable sidecars** in app-data (`settings_dir()/embeddings/`),
  out of git — unchanged.
- **`raw/` stays immutable** throughout (repo rule, overrides everything).

## Risks & mitigations

- **Reranker binding unverified** → Phase 1c starts with a spike; reranker is
  conditional, never assumed. (§Decisions 5.)
- **CJK BM25 tokenization correctness** → unit tests with Korean queries against
  Korean pages; the eval set already includes exact-term/acronym queries — extend
  with Korean cases.
- **Bundle size** (embed +100–360 MB, rerank +~360 MB; DMG already ~761 MB) →
  quality-per-MB judgement in the bake-off; rerank must clearly earn its size.
- **Watcher × write-hook double-update** → both funnel into one serialized
  `IndexUpdater`; content-hash skip makes a redundant fire a no-op.
- **Watcher lifecycle** → start/stop with the active vault; ignore `.git`,
  `raw/` (immutable, not indexed), and the index sidecars.
- **Model swap wipes the index** → expected; the guard + reindex handle it, but
  the first post-upgrade Ask must not silently return the whole-vault fallback
  without signalling "reindexing".

## Out of scope (Phase 2+)

Deterministic dedup (MinHash + embedding) → ADD/UPDATE/MERGE suggestions;
kNN/citation link suggestions; late chunking; GLiNER entities → `[[Entity]]`
pages; clustering *suggestions* (never auto-move a curated vault); LazyGraphRAG
query layer. All deferred.

## References

- `app/src-tauri/eval/BASELINE.md`, `eval/retrieval-queries.json`,
  `examples/retrieval_eval.rs` (Phase 0)
- [[2026-07-01-embedded-local-model]] (in-process GGUF philosophy)
- Memory: `memex-ingest-redesign`, `verify-renders-at-scale` (eval, not unit
  tests, proves retrieval)
