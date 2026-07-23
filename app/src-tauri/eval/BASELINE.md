# Retrieval baseline (Phase 0)

Measured 2026-07-22 with `cargo run --example retrieval_eval --release` over the
bundled sample vault (`sample_vault::SAMPLE_NOTES`) and `eval/retrieval-queries.json`.

This is the number every later phase is measured against. It reflects the retrieval
the app ships today: **Gemma-3-1B mean-pooled embeddings → `VectorStore` cosine, dense-only.**

## Corpus
51 wiki pages · 102 chunks · 30 labeled queries

## Results — Gemma-3-1B dense, cosine

| k  | hit@k  | recall@k |
|----|--------|----------|
| 1  | 20.0 % | 18.3 %   |
| 3  | 33.3 % | 31.7 %   |
| 5  | 46.7 % | 45.0 %   |
| 10 | 53.3 % | 53.3 %   |

**MRR 0.323 · nDCG@10 0.353**

Read: only 1-in-5 queries put a relevant page at rank 1, and ~47 % of queries have
**no** relevant page anywhere in the top 10 — so the model answering "Ask" is fed
the wrong pages nearly half the time.

## Where it fails (drives Phase 1 priorities)
- **Exact-term / acronym queries are worst** — `BPE @12`, `DPO @27`, `RAG @4`,
  `quantization @4`, `LoRA @4`; `multi-head-attention` and `positional-encoding`
  MISS the top-40 entirely. These are precisely what a **BM25 lexical arm** recovers
  (dense Gemma vectors don't encode rare exact tokens well). Highest-value change.
- **Semantic paraphrases also weak** — `attention-mechanism @36`, `self-attention @31`,
  `chain-of-thought @24` — pointing at a **real embedding model + cross-encoder rerank**.

## Phase 1 target
Re-run this harness after each change (embed-model swap · BM25 + RRF · rerank ·
embed-all-chunks · re-index between runs). Each addition must beat these numbers
or it is dropped.

## Phase 1a — embed-model bake-off (2026-07-23)

Measured with `MEMEX_EMBED_SPEC=<id> cargo run --example retrieval_eval --release`
over the same corpus (51 wiki pages · 102 chunks · 30 queries). Candidates run
through their correct pooling + role prefixes (see `local_llm::EMBED_SPECS`):

| model              | file MB | pooling | hit@1 | hit@10 | MRR   | nDCG@10 | recall@10 |
|--------------------|--------:|---------|------:|-------:|------:|--------:|----------:|
| gemma-3-1b (base)  | (chat)  | mean    | 20.0  | 53.3   | 0.323 | 0.353   | 53.3      |
| **bge-m3** Q4_K_M  |   438   | cls     | 76.7  | 100.0  | 0.860 | 0.874   | 98.3      |
| e5-large Q4_K_M    |   406   | mean    | 80.0  | 100.0  | 0.876 | 0.895   | 100.0     |

Both purpose-built embedders crush the Gemma baseline: **hit@10 53.3 % → 100 %**,
**MRR 0.323 → 0.86+**. The Phase-0 exact-term/paraphrase failures (BPE, DPO,
multi-head-attention, positional-encoding, attention-mechanism) are all recovered;
only one weak query remains for both models
(`training a model to align with a written set of principles` @8).

**Winner: `bge-m3`.** e5-large edges it on this eval (MRR 0.876 vs 0.860), but the
corpus is English-only (the bundled karpathy-llm sample vault) and does not test
Korean. bge-m3 is MIRACL Korean-tuned and has an 8192-token context, so it does
not truncate long chunks; e5-large's 512-token limit would silently truncate long
Korean chunks (~1800-byte chunks can exceed 512 tokens in Korean). For a
Korean+English vault the 0.016-MRR gap on a 30-query English set is within noise,
and bge-m3's Korean coverage + no-truncation wins. 32 MB size difference is
negligible.

**New reference for Phase 1b:** bge-m3 — hit@10 100.0 % · MRR 0.860 · nDCG@10 0.874.
Phase 1b (CJK BM25 + RRF) must beat these, focusing on the remaining weak query and
on Korean queries once the eval set is extended.
