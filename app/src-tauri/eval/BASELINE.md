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

## Phase 1b — BM25 + RRF fusion (2026-07-25)

The lexical arm from the previous section's plan, now implemented and measured:
a dependency-free script-aware tokenizer (Latin runs lowercased, CJK runs as
character bigrams), a BM25 index (`k1 = 1.2`, `b = 0.75`) keyed on the same
`(page, section)` chunk identity as the vector store, and Reciprocal Rank Fusion
(`k = 60`) over the two rankings. Same corpus and same query set as the section
above — **nothing about the eval inputs changed**, only the retrieval under test.

Measured with `MEMEX_EMBED_SPEC=bge-m3 cargo run --example retrieval_eval --release`
over **71 wiki pages · 142 chunks · 62 queries**. The harness reports both arms in
one run, so within a run the two tables share the identical index.

**Run-to-run stability — read this before quoting a fused number.** Four runs of
the unchanged harness on the unchanged corpus and query set were recorded. The
dense control came out **identical in all four** (every figure below reproduces
exactly). The fused arm did **not**: it landed on one of two outcomes, differing
in exactly one query (`DPO`), and therefore in hit@1 / recall@1 / MRR / nDCG@10.
Observed 2× each:

| outcome | hit@1 | recall@1 | MRR | nDCG@10 | `DPO` |
|---------|------:|---------:|----:|--------:|------:|
| A | 83.9 % | 79.0 % | 0.914 | 0.932 | @1 (no regression) |
| B | 82.3 % | 77.4 % | 0.906 | 0.926 | @2 (regression) |

The cause is not the embedder: bge-m3 was checked and is bit-reproducible for the
same input, within a process and across processes. It is `Bm25Index::search`
(`src/retrieval.rs`): for the query `DPO`, `wiki/analysis-rlhf-vs-dpo.md#1` and
`ko-corpus/ko-dpo.md#1` score **bit-identically** (both `0x408b86dc`), the hit
list is materialised from a `HashMap` (per-process random iteration order) and
sorted with a *stable* sort on score alone, so which of the two takes lexical
rank 1 varies per process. RRF weights by rank (1/61 vs 1/62), so that swap is
enough to move `wiki/dpo.md` between fused rank 1 and 2. Reproduced directly:
5 index-only runs of the same query gave order A 3× and order B 2×, with
identical scores. Every figure below that depends on that one query is therefore
quoted as the observed range, not as an exact value.

### Results — bge-m3 dense, cosine (control)

| k  | hit@k  | recall@k |
|----|--------|----------|
| 1  | 72.6 % | 67.7 %   |
| 3  | 91.9 % | 87.9 %   |
| 5  | 96.8 % | 94.4 %   |
| 10 | 98.4 % | 96.8 %   |

**MRR 0.829 · nDCG@10 0.847**

### Results — dense + BM25 (RRF fused)

| k  | hit@k              | recall@k           |
|----|--------------------|--------------------|
| 1  | 82.3 – 83.9 %      | 77.4 – 79.0 %      |
| 3  | 100.0 %            | 98.4 %             |
| 5  | 100.0 %            | 100.0 %            |
| 10 | 100.0 %            | 100.0 %            |

**MRR 0.906 – 0.914 · nDCG@10 0.926 – 0.932**

The ranges are the two outcomes tabulated above, each seen in 2 of 4 runs; hit@3,
hit@5, hit@10 and their recalls were identical in every run.

### Aggregate delta (fused − dense)

| metric    | dense | fused         | delta                |
|-----------|------:|--------------:|---------------------:|
| hit@1     | 72.6  | 82.3 – 83.9   | **+9.7 – +11.3 pp**  |
| hit@3     | 91.9  | 100.0         | **+8.1 pp**          |
| hit@5     | 96.8  | 100.0         | **+3.2 pp**          |
| hit@10    | 98.4  | 100.0         | **+1.6 pp**          |
| recall@10 | 96.8  | 100.0         | **+3.2 pp**          |
| MRR       | 0.829 | 0.906 – 0.914 | **+0.077 – +0.085**  |
| nDCG@10   | 0.847 | 0.926 – 0.932 | **+0.079 – +0.085**  |

Fusion beats dense on every metric in every run — the run-to-run variation is
smaller than the smallest gain. Every query now has a relevant page in its
top 3, and recall@5 is complete.

### The five recorded weak queries — all rescued

| query | target | dense | fused |
|-------|--------|------:|------:|
| `PPO` | `rlhf` | @12 | **@3** |
| `RLAIF` | `constitutional-ai` | @4 | **@2** |
| `PPO로 정책을 갱신하는 인간 선호 정렬` | `ko-rlhf` | @4 | **@2** |
| `모델 크기 데이터 연산이 커질수록 성능이 예측 가능하게 향상됨` | `ko-scaling-laws` | @5 | **@1** |
| `training a model to align with a written set of principles` | `constitutional-ai` | @8 | **@3** |

The two hypotheses behind the increment both hold: rare English exact tokens
(`PPO` @12 → @3, `RLAIF` @4 → @2) are recovered by the lexical arm, and the
Korean-phrase-with-shared-acronym distractor case (`PPO로 정책을…` @4 → @2) is
disambiguated by the CJK bigram tokens. The Korean semantic paraphrase
(`모델 크기 데이터 연산이…` @5 → @1) also gains, from partial lexical overlap
(모델/데이터/성능) rather than from an exact-term hit.

### Regressions — the complete list

Two queries lost rank 1, both by exactly one position:

| query | target | dense | fused | seen in |
|-------|--------|------:|------:|---------|
| `DPO` | `dpo` | @1 | @2 | 2 of 4 runs (the tied-score coin-flip above) |
| `RAG` | `rag` | @1 | @2 | all 4 runs |

No other query regressed in any run, and the five rescues listed above were
identical in all four.

Both are the same mechanism, and it is inherent to RRF rather than a tuning
mistake: for a 3-letter acronym that titles its own page, the dense arm already
ranks that page first, while BM25 spreads the term across every page that
mentions it (`dpo` is discussed at length in `analysis-rlhf-vs-dpo`, `rag` in
`vector-database`). Where the lexical arm's own #1 is a *different* chunk, RRF's
rank-agreement sum can push that chunk above the dense #1. Neither query drops
out of the top 3, so neither costs hit@3 or hit@5, and MRR loses ~0.008 each
against the +0.077 net. No other query regressed; no query left the top 10.
Recorded here rather than smoothed over: this is the price paid for the +9.7 pp
on hit@1, and a future reranker is the place to reclaim it.

### Success criteria — met

The previous section required the increment to "raise MRR / hit@1 and rescue the
five weak queries above without regressing the queries already at rank 1." The
first two are met with margin in every run (MRR 0.829 → 0.906–0.914, hit@1
72.6 % → 82.3–83.9 %) and all five weak queries are rescued. The third is met with
the exceptions listed above — `RAG` slipped @1 → @2 in every run and `DPO` in half
of them — so the criterion is met **with a documented, quantified exception**, not
unconditionally.

**New reference the next increment must beat:** dense+BM25 RRF — hit@1 82.3 % ·
hit@3 100.0 % · MRR 0.906 · nDCG@10 0.926, i.e. the **worse** of the two observed
outcomes, so a real improvement is not confused with landing on the luckier one.
Note that hit@3/@5/@10 are saturated again: further gains are only measurable on
hit@1 / MRR / nDCG until the corpus or query set is extended again. The tie-order
instability in `Bm25Index::search` is a separate follow-up: until it is given an
identity tie-break, single-run fused figures on this corpus carry ±1 query
(≈1.6 pp hit@1, ≈0.008 MRR) of noise.

### Wired-path check (not just the harness)

Measured on the real vault the app was bound to (`~/Documents/Memex`,
53 wiki pages · 109 chunks), not the eval corpus:

- The running app creates and populates the `.mxb` sidecar next to the `.mxv`
  under `<app-data>/embeddings/`, including the bootstrap case where the dense
  index was already current (`.mxb` deleted, app relaunched → sidecar rebuilt in
  6 s with the `.mxv` byte-identical, i.e. no re-embed).
- Fused retrieval over those real on-disk sidecars raises `wiki/rlhf.md` — the
  only page containing `PPO`, absent from the dense top-8 — to fused rank 2.
- With the `.mxb` absent, the fused order is byte-for-byte the dense order:
  the lexical arm degrades to a no-op rather than an error.
- Driven end-to-end through the Tauri command layer afterwards (⌘K search and the
  Ask page, temporary logging at the guards, since removed): `semantic_search`
  entered with `provider="builtin-local" model="bge-m3"` against a store tagged
  `"builtin-local:bge-m3"` — the stale-index guard does not fire — and returned
  6 hits for ⌘K and 12 hits for Ask on the query `PPO`.

See the task-8 report and task-8-diagnosis for the commands and the observed
output.
