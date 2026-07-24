# Retrieval Phase 1b (eval extension) — design

Parent spec: `2026-07-22-retrieval-first-ingest-design.md` (Approach A).
This document covers **only the first increment of Phase 1b**: extending the
retrieval eval so the value of BM25/RRF and reranking becomes *measurable*.
The BM25 + RRF core and any reranker are the **next** increment and are out of
scope here.

## Why

The Phase-1a embed swap (bge-m3) took the eval from hit@10 53.3% to **100%**
(MRR 0.860) over the bundled English sample vault (51 pages, 30 queries). At
100% hit@10 the eval is **saturated**: any Phase-1b retrieval change (a BM25
lexical arm, RRF fusion, a cross-encoder reranker) has no headroom to show a
gain, so we would be building it blind. Two structural reasons the current eval
is too easy:

1. **Small corpus** — 51 pages gives few distractors, so even mediocre ranking
   lands a relevant page in the top-10.
2. **English-only, embedder-friendly queries** — paraphrases and acronyms that a
   strong multilingual dense model already handles. The cases where a lexical
   arm wins (rare exact tokens; **Korean/CJK term matching**, which is the real
   product's primary language) are not represented at all.

A Korean-query-against-English-document test would *not* fix this: BM25 gets zero
lexical overlap across languages, so it would measure bge-m3's cross-lingual
ability, not what Phase 1b builds. We need Korean **queries against Korean
documents**.

## Goal & success criteria

Deliverable: an extended eval + a **re-measured bge-m3 baseline that is no longer
saturated**, recorded in `eval/BASELINE.md`.

Success =

- The extended eval runs green via `cargo run --example retrieval_eval --release`
  (with `MEMEX_EMBED_SPEC=bge-m3`).
- bge-m3 dense-only shows **measurable headroom**: hit@10 below 100% and/or a
  non-trivial "weak queries" list, and that list **includes Korean exact-term
  cases** — i.e. there is now a gap for BM25/RRF to close in the next increment.
- If bge-m3 still saturates at hit@10 100%, the query set is iterated harder
  (shorter exact terms, closer distractors) until headroom exists. We report the
  honest number, not a target.

This follows the project rule that **the eval, not unit tests, proves retrieval**
([[verify-renders-at-scale]]).

## Design

### 1. Korean parallel fixture (eval-only)

- ~20 Korean pages, each a **parallel translation of an existing English
  concept page** (multi-head-attention, self-attention, RLHF, DPO, LoRA,
  quantization, RAG, tokenization/BPE, positional-encoding, KV-cache,
  scaling-laws, embeddings, chain-of-thought, in-context-learning,
  instruction-tuning, distillation, MCP, constitutional-AI, layer-norm,
  feedforward — final list finalized in the plan). Parallel translation, not
  invented content, so **no new facts are fabricated** and the same `[^src-*]`
  sources apply.
- Location: **`eval/ko-corpus/*.md`**, read by the harness at runtime from
  `CARGO_MANIFEST_DIR` (same mechanism as `eval/retrieval-queries.json`). This
  keeps Korean content **out of the shipped binary** and **out of `SAMPLE_NOTES`
  / the starter vault** — no product-facing change.
- Filenames use **ASCII stems** `ko-<english-slug>.md` (e.g.
  `ko-multi-head-attention.md`) to avoid filesystem/encoding edge cases; the
  **content** is Korean (what the tokenizer/BM25 see). Stems are distinct from
  the English stems, so relevance labels are unambiguous and cross-lingual
  retrieval (a Korean query pulling the English page) is itself a visible signal.
- Each file **mirrors the vault schema** (YAML frontmatter + `# Heading` + body
  with inline `[[wikilinks]]` and `[^src-*]` citations) so `embeddings::chunk_page`
  treats it identically to English pages. Note: `chunk_page` does not strip
  frontmatter — it rides in chunk 1 for both languages, so parity holds.
  `push_bounded` is already CJK-safe (splits on char boundaries, no whitespace).

### 2. Harness change (`examples/retrieval_eval.rs`)

Additive only: after indexing `sample_vault::SAMPLE_NOTES` (unchanged English
block), **walk `eval/ko-corpus/*.md`** and index each into the **same**
`VectorStore` (`chunk_page` → `content_hash` → `doc_vecs` → `upsert_page`), with
`rel = ko-corpus/<file>` and `stem = <file without .md>`. Combined corpus ≈ 71
pages. No new corpus-switch env var; one store, one run.

### 3. Query set (`eval/retrieval-queries.json`)

Extend the **single existing file** (harness already reads it):

- Keep the 30 English queries.
- Add ~20 **Korean** queries — a mix of semantic paraphrases and exact-term /
  acronym (e.g. `다중 헤드 어텐션`, `역전파`, `RLHF를 한국어로 물었을 때`) mapping
  to `ko-*` stems.
- Add ~5 **hard English** queries designed for the larger corpus (very short
  rare exact tokens; a term whose relevant page sits near strong distractors).
- Update `_about` to describe the bilingual corpus and the ko-corpus dependency.

### 4. Baseline doc (`eval/BASELINE.md`)

Add a **Phase-1b** section: the re-measured bge-m3 numbers over the extended
corpus (hit@k / recall@k / MRR / nDCG@10) and the weak-query list. This becomes
the new reference the BM25+RRF increment must beat.

## Non-goals (this increment)

- No BM25 / RRF / `retrieval.rs` core, no reranker — next increment.
- No change to `SAMPLE_NOTES`, the starter vault, or any shipped/product path.
- No change to the `MAX_CHUNKS=8` wikify cap (tracked in the parent plan).

## Verification

`MEMEX_EMBED_SPEC=bge-m3 cargo run --example retrieval_eval --release` over the
combined corpus; confirm the success criteria above (headroom + Korean weak
queries). `cargo test` for any harness-adjacent unit coverage stays green. This
increment touches an example + fixtures + a doc only — no `src/` runtime code, so
there is no wired-app path to drive.

## Reuse

`embeddings::chunk_page` (CJK-safe), `content_hash`, `VectorStore::upsert_page`,
`local_llm::{embed_spec_by_id, apply_prefix, EmbedRole}` — all already used by the
harness. The change is fixtures + an additive indexing loop + query rows.

## Risks

- **Fabricated Korean facts** → mitigated by parallel-translating existing pages
  (same claims, same sources), not authoring new material.
- **Still saturated after extension** → iterate queries harder (documented in
  success criteria); do not lower the bar to claim a pass.
- **Korean stems / encoding** → ASCII filenames sidestep FS issues; UTF-8 content
  only.
