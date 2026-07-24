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
Korean. bge-m3 is MIRACL Korean-tuned; the model supports up to 8192 tokens and we
configure it at `max_ctx: 2048` (`EMBED_SPECS`) — comfortably above our ~1800-byte
chunks, so they are not truncated. e5-large's hard 512-token limit would silently
truncate long Korean chunks (~1800 bytes can exceed 512 tokens in Korean). For a
Korean+English vault the 0.016-MRR gap on a 30-query English set is within noise,
and bge-m3's Korean coverage + no truncation at our chunk size wins. 32 MB size
difference is negligible.

**New reference for Phase 1b:** bge-m3 — hit@10 100.0 % · MRR 0.860 · nDCG@10 0.874.
Phase 1b (CJK BM25 + RRF) must beat these, focusing on the remaining weak query and
on Korean queries once the eval set is extended.

## Phase 1b — extended bilingual corpus (2026-07-25)

The Phase-1a set (51 English pages · 30 English queries) was **saturated** at
hit@10 100 %, so BM25/RRF had no headroom to prove a gain. This increment extends
the eval — it adds no retrieval code. Two additions:

- **Korean parallel corpus**: 20 pages under `eval/ko-corpus/` (`ko-*` stems),
  parallel translations of the core concept pages, read from disk by the harness
  and indexed into the *same* store as `SAMPLE_NOTES`. Eval-only — not in the
  shipped binary or the starter vault. Combined corpus: **71 pages · 142 chunks**.
- **32 new queries** (`eval/retrieval-queries.json`): 27 Korean (semantic + Korean
  exact-term + Korean-phrase-with-shared-acronym) and 5 hard English (rare exact
  tokens present in exactly one page — QLoRA/PPO/RLAIF/pre-post-norm/grouped-query-cache).
  **62 queries** total.

Measured with `MEMEX_EMBED_SPEC=bge-m3 cargo run --example retrieval_eval --release`.

### Results — bge-m3 dense, cosine (71 pages · 142 chunks · 62 queries)

| k  | hit@k  | recall@k |
|----|--------|----------|
| 1  | 72.6 % | 67.7 %   |
| 3  | 91.9 % | 87.9 %   |
| 5  | 96.8 % | 94.4 %   |
| 10 | 98.4 % | 96.8 %   |

**MRR 0.829 · nDCG@10 0.847**

The extension **de-saturated** the eval (hit@10 100 % → 98.4 %, MRR 0.860 → 0.829,
hit@1 76.7 % → 72.6 %), re-opening measurable headroom for BM25 + RRF.

### Weak queries — the explicit gap the BM25/RRF increment must close

| rank | query | lang | why dense is weak |
|------|-------|------|-------------------|
| @4  | `RLAIF` | EN | rare exact token; appears verbatim only in `constitutional-ai` |
| @4  | `PPO로 정책을 갱신하는 인간 선호 정렬` → `ko-rlhf` | KO | shared acronym **PPO** pulls the English `rlhf` page above the Korean one; Korean tokens (정책/갱신/인간 선호) would disambiguate |
| @5  | `모델 크기 데이터 연산이 커질수록 성능이 예측 가능하게 향상됨` → `ko-scaling-laws` | KO | semantic paraphrase, no distinctive lexical anchor |
| @8  | `training a model to align with a written set of principles` → `constitutional-ai` | EN | persistent Phase-1a miss (semantic) |
| @12 | `PPO` → `rlhf` | EN | rare exact token; dense under-weights it |

**Honest finding:** bge-m3's Korean is strong — every Korean *exact-term* query
(다중 헤드 어텐션, 바이트 페어 인코딩, KV 캐시, 직접 선호 최적화, 임베딩) already
lands in the top-3. The residual gap is (a) **rare English exact tokens** (PPO,
RLAIF) and (b) **Korean phrases sharing a cross-lingual acronym** where the English
parallel page becomes a distractor — both classic **lexical-arm** territory.

**New reference the next increment must beat:** bge-m3 — hit@1 72.6 % · hit@10
98.4 % · MRR 0.829 · nDCG@10 0.847. The CJK BM25 + RRF core (shared `retrieval.rs`)
should raise MRR / hit@1 and rescue the five weak queries above without regressing
the queries already at rank 1; each addition is re-run here or it is dropped.
