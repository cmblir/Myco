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

**Run-to-run stability — fixed.** An earlier measurement pass on this same
harness, corpus, and query set recorded the fused arm landing on one of two
outcomes across runs, differing in exactly one query (`DPO`) and therefore in
hit@1 / recall@1 / MRR / nDCG@10. The cause was not the embedder — bge-m3 is
bit-reproducible for the same input, within and across processes — but
`Bm25Index::search` (`src/retrieval.rs`): for the query `DPO`,
`wiki/analysis-rlhf-vs-dpo.md#1` and `ko-corpus/ko-dpo.md#1` scored
bit-identically (both `0x408b86dc`), the hit list was materialised from a
`HashMap` (per-process random iteration order) and sorted with a *stable* sort
on score alone, so which of the two took lexical rank 1 varied per process.
RRF weights by rank, so that swap was enough to move `wiki/dpo.md` between
fused rank 1 and 2.

`Bm25Index::search` now breaks ties on score by `(page, section)` ascending —
the same tie-break `rrf_fuse` already used — giving it a deterministic total
order. Two runs of `MEMEX_EMBED_SPEC=bge-m3 cargo run --example retrieval_eval
--release` after the fix produced a **byte-identical fused block** (every
table and rank-change line below reproduced exactly). The figures below are
single measured values, not a range: the earlier spread was a property of the
tie-break bug, not of the retrieval itself.

### Results — bge-m3 dense, cosine (control)

| k  | hit@k  | recall@k |
|----|--------|----------|
| 1  | 72.6 % | 67.7 %   |
| 3  | 91.9 % | 87.9 %   |
| 5  | 96.8 % | 94.4 %   |
| 10 | 98.4 % | 96.8 %   |

**MRR 0.829 · nDCG@10 0.847**

### Results — dense + BM25 (RRF fused)

| k  | hit@k   | recall@k |
|----|---------|----------|
| 1  | 82.3 %  | 77.4 %   |
| 3  | 100.0 % | 98.4 %   |
| 5  | 100.0 % | 100.0 %  |
| 10 | 100.0 % | 100.0 %  |

**MRR 0.906 · nDCG@10 0.926**

Identical in both post-fix runs; no range to quote.

### Aggregate delta (fused − dense)

| metric    | dense | fused | delta            |
|-----------|------:|------:|-----------------:|
| hit@1     | 72.6  | 82.3  | **+9.7 pp**       |
| hit@3     | 91.9  | 100.0 | **+8.1 pp**       |
| hit@5     | 96.8  | 100.0 | **+3.2 pp**       |
| hit@10    | 98.4  | 100.0 | **+1.6 pp**       |
| recall@10 | 96.8  | 100.0 | **+3.2 pp**       |
| MRR       | 0.829 | 0.906 | **+0.077**        |
| nDCG@10   | 0.847 | 0.926 | **+0.079**        |

Fusion beats dense on every metric. Every query now has a relevant page in its
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

Two queries lost rank 1, both by exactly one position, in both post-fix runs:

| query | target | dense | fused |
|-------|--------|------:|------:|
| `DPO` | `dpo` | @1 | @2 |
| `RAG` | `rag` | @1 | @2 |

No other query regressed, and the five rescues listed above were identical in
both runs.

Both are the same mechanism, and it is the tie-break in `rrf_fuse`, not a
tuning mistake: for a 3-letter acronym that titles its own page, the dense arm
already ranks that page first, while BM25 spreads the term across every page
that mentions it (`dpo` is discussed at length in `analysis-rlhf-vs-dpo`, `rag`
in `vector-database`). When the lexical arm's own #1 is a *different* chunk,
each arm's top hit sits at rank 0 of its own list only, so both chunks score
exactly `1/RRF_K` — the score alone cannot order them. `rrf_fuse` breaks that
tie on chunk identity (`page` ascending, then `section`), and for these two
queries the lexical arm's top chunk alphabetically precedes the dense arm's,
so it wins fused rank 1. Neither query drops out of the top 3, so neither
costs hit@3 or hit@5, and MRR loses ~0.008 each against the +0.077 net. No
other query regressed; no query left the top 10. Recorded here rather than
smoothed over: this is the price paid for the +9.7 pp on hit@1, and a future
reranker is the place to reclaim it.

**A dense-rank-preferring tie-break was tried and refuted — do not re-try it
blind.** The obvious fix reads as: since exact ties at `1/RRF_K` are the
*ordinary* case whenever the two arms' top hits differ (not a rare corner),
a chunk's dense rank — the better (lower) it is, the more decisive it should
be — ought to decide before falling back to chunk identity, since a chunk
found by the dense arm at all is stronger evidence than one found only by
BM25. This was implemented, tested (three unit tests pinning the new
precedence, all passing), and measured on this same corpus and query set:
hit@1 **80.6 %** · hit@3/@5/@10 100 % · MRR **0.898** · nDCG@10 **0.920** —
worse than the identity tie-break on every metric that moved. `RAG` did
reclaim rank 1, but the aggregate still
fell, because preferring dense rank systematically demotes chunks the lexical
arm found and the dense arm ranked poorly or missed — exactly the rescue BM25
exists to provide (`PPO` is dense rank @12; fused rank @3 depends on the
lexical arm's top hit being allowed to outrank a weak or absent dense hit on
ties elsewhere too). The diagnosis above (ties at `1/RRF_K` decide rank 1,
and it is ordinary rather than a corner case) is correct; the remedy is
refuted by measurement. The change was reverted; the identity tie-break
(`page` asc, then `section`) is what ships.

Before the tie-break fix, `DPO` was the query whose fused rank flip-flopped
between @1 and @2 across runs (the earlier "run-to-run stability" note above);
`RAG` regressed in every run recorded then, and still does now. With the fix,
`DPO`'s @1 → @2 regression is reproducible on every run — the previously
"lucky" @1 outcome is not something the current, corrected code produces.

### Success criteria — met

The previous section required the increment to "raise MRR / hit@1 and rescue the
five weak queries above without regressing the queries already at rank 1." The
first two are met with margin (MRR 0.829 → 0.906, hit@1 72.6 % → 82.3 %) and all
five weak queries are rescued. The third is met with the exceptions listed
above — `RAG` and `DPO` both slip @1 → @2 — so the criterion is met **with a
documented, quantified exception**, not unconditionally.

**New reference the next increment must beat:** dense+BM25 RRF — hit@1 82.3 % ·
hit@3 100.0 % · MRR 0.906 · nDCG@10 0.926. These are now stable, reproducible
values (two identical post-fix runs), not the worse end of a range. Note that
hit@3/@5/@10 are saturated again: further gains are only measurable on
hit@1 / MRR / nDCG until the corpus or query set is extended again. The
tie-order instability in `Bm25Index::search` that previously made single-run
fused figures on this corpus carry noise (±1 query, ≈1.6 pp hit@1, ≈0.008 MRR)
has been fixed — `search` now sorts ties by `(page, section)` ascending — so
that noise no longer applies.

**Re-verified after the final whole-branch review's fix wave.** That review
landed two more determinism/correctness fixes after this section was first
written — `upsert_page` made O(page terms) instead of O(index) (perf only, no
scoring change), and `Bm25Index::search`'s query-term loop made to iterate a
sorted `Vec` instead of a `HashSet` (float-accumulation order was otherwise
per-process-random for any query matching 3+ terms). Two fresh runs of
`MEMEX_EMBED_SPEC=bge-m3 cargo run --example retrieval_eval --release` with
both fixes in place reproduced the identical fused block above byte-for-byte
(hit@1 82.3 % · hit@3/@5/@10 100 % · MRR 0.906 · nDCG@10 0.926, `DPO`/`RAG`
both @1 → @2, all five weak-query rescues intact) — the same review's
dense-rank-preferring tie-break was also tried in this pass and reverted, as
detailed above.

### Wired-path check (not a scale check)

Measured on the real vault the app was bound to (`~/Documents/Memex`,
53 wiki pages · 109 chunks), not the eval corpus. This confirms the wired
command path (not just the harness) behaves correctly — it is **not** a
verification that the implementation scales; 53 pages is far below where the
pre-fix `Bm25Index::upsert_page` quadratic cost was visible (measured
250p = 0.99 s / 500p = 4.0 s / 1000p = 16.0 s / 2000p = 65.7 s, extrapolating
to tens of minutes for a ~10k-page vault's first bootstrap). See commit
`9a7b65f`, which fixed that to linear (same corpus: 0.022 / 0.046 / 0.094 /
0.205 s, and 10000 pages in 1.11 s) — that commit's own measurement, not this
53-page check, is the scale evidence:

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
