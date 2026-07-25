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

## Wikify — first measurement of the second retrieval path (2026-07-26)

> **Outcome: fusion was reverted on this path.** `wikify_candidates` ships
> **dense-only**; `semantic_search` (Ask) keeps the fusion, where it measured
> better. See "Decision" below the verdict. The measurement, tables, and
> mechanism analysis in this section are kept as the evidence for that call
> and are unchanged from when they were first recorded.

Everything above measures **Ask** (`semantic_search`). The app's other retrieval
consumer, `wikify_candidates` — "which existing pages should this source text
link to / update?" — received the same dense+BM25(RRF) fusion but had **never
been measured**. This section is that measurement. It adds no retrieval code and
changes no parameter.

Harness: `examples/wikify_eval.rs`, run as
`cargo run --example wikify_eval --release` (defaults to `MEMEX_EMBED_SPEC=bge-m3`,
the shipped embedder; the env var still overrides). It drives the *shipped* glue —
`pipeline::dense_chunk_matches` (filter non-knowledge pages → cap at 16) for the
dense arm, `pipeline::fuse_chunk_matches` (the same policy over `rrf_fuse`) for
the fused arm, and `pipeline::rank_candidates` for both — which was extracted out
of `wikify_candidates` for exactly this reason, so the harness cannot drift from
the command: the dense arm calls the very helper the command calls. Only the Tauri
shell (vault root, caches, `embed_texts`) is replaced. `MAX_CHUNKS` = 8 unchanged.

### Corpus and coverage

Same corpus as the Ask eval: **71 pages · 142 chunks** (51 English
`sample_vault::SAMPLE_NOTES` `wiki/` pages + 20 Korean `eval/ko-corpus/` fixtures).

Ground truth is the corpus's own link graph, not authored labels. For each page P,
the label set is the `[[...]]` targets of P (via `parser::parse_links_from_text`,
`#`-fragment stripped) that (a) exist in the corpus, (b) pass
`pipeline::is_knowledge_page`, and (c) are not P itself — every page in this vault
self-links at least once. **71 of 71 pages had a non-empty label set, so 0 pages
were skipped**; 215 labels total, 3.0 per case.

Two source-text variants per case, both with the YAML frontmatter, the `[^src-*]`
citation markers and the footnote definition lines stripped (markup, not prose a
user would paste); the `#` heading and body are kept:

- **easy** — each `[[stem|alias]]` becomes `alias`, each `[[stem]]` becomes the
  stem as prose (hyphens → spaces). The realistic case: ordinary writing that
  names the concepts, and wikify must find the pages that own them.
- **hard** — the linked phrase is deleted outright, leaving only the surrounding
  prose, so only context can identify the target. A Hangul run glued to the
  closing brackets (`[[dpo|직접 선호 최적화]]는`) is an agglutinative particle
  belonging to the deleted phrase and goes with it; the residual whitespace and
  punctuation damage is then collapsed.

### Label confound in the KO subset, and two label definitions

The Korean fixtures (`eval/ko-corpus/ko-*.md`) are parallel translations of 20
English `wiki/` pages, but they were authored with their `[[wikilinks]]`
pointing at the **English** stems (`[[self-attention|셀프 어텐션]]`), while the
corpus also contains their Korean twins (`ko-self-attention`). So a Korean
page's label set can only ever contain English stems — yet the CJK-bigram
lexical arm correctly surfaces the Korean twins, which then (a) count as wrong
against the English-only label set and (b) evict the labeled English pages
from the top-k. Fusion is penalised here for making the more appropriate
suggestion, not for being wrong.

Rather than loosen the labels and report only the improved number — which would
be moving the goalposts after seeing a bad result — every metric below is
reported under **both** label definitions:

- **strict** (the original definition): a suggestion counts as correct only if
  its stem is exactly a labeled link target.
- **translation-aware**: a suggestion also counts as correct if it is the
  parallel translation of a labeled stem, i.e. for a labeled stem `x`, `ko-x`
  also counts, and vice versa. The pairing is mechanical — derived from the
  `ko-<slug>.md` / `wiki/<slug>.md` filename convention the corpus already
  uses, not a hand-maintained mapping table (`label_match` in
  `examples/wikify_eval.rs`). If both `x` and `ko-x` are retrieved for one
  labeled stem, only the first (best-ranked) counts as a hit — `compute_hits`
  claims each label at most once — so precision/MAP cannot be inflated by
  double-crediting a single label.

### Results — easy variant (71 cases)

**Strict labels:**

| k  | precision@k | recall@k | F1@k  |     | precision@k | recall@k | F1@k  |
|----|------------:|---------:|------:|-----|------------:|---------:|------:|
|    | **dense**   |          |       |     | **fused**   |          |       |
| 5  | 34.9 %      | 64.0 %   | 0.437 |     | 34.4 %      | 61.8 %   | 0.427 |
| 10 | 26.3 %      | 89.1 %   | 0.396 |     | 21.7 %      | 74.8 %   | 0.327 |
| 20 | 18.2 %      | 92.9 %   | 0.297 |     | 15.4 %      | 82.7 %   | 0.255 |

MAP@20 — dense 0.416 · fused 0.421

**Translation-aware labels:**

| k  | precision@k | recall@k | F1@k  |     | precision@k | recall@k | F1@k  |
|----|------------:|---------:|------:|-----|------------:|---------:|------:|
|    | **dense**   |          |       |     | **fused**   |          |       |
| 5  | 40.6 %      | 72.9 %   | 0.504 |     | 44.2 %      | 77.4 %   | 0.544 |
| 10 | 27.0 %      | 91.2 %   | 0.406 |     | 25.8 %      | 87.0 %   | 0.387 |
| 20 | 18.5 %      | 94.1 %   | 0.302 |     | 17.5 %      | 91.5 %   | 0.287 |

MAP@20 — dense 0.474 · fused 0.537

### Results — hard variant (71 cases)

**Strict labels:**

| k  | precision@k | recall@k | F1@k  |     | precision@k | recall@k | F1@k  |
|----|------------:|---------:|------:|-----|------------:|---------:|------:|
|    | **dense**   |          |       |     | **fused**   |          |       |
| 5  | 29.9 %      | 54.8 %   | 0.374 |     | 29.6 %      | 53.2 %   | 0.367 |
| 10 | 22.8 %      | 79.1 %   | 0.345 |     | 19.9 %      | 68.6 %   | 0.300 |
| 20 | 17.1 %      | 88.7 %   | 0.280 |     | 14.5 %      | 78.5 %   | 0.240 |

MAP@20 — dense 0.355 · fused 0.373

**Translation-aware labels:**

| k  | precision@k | recall@k | F1@k  |     | precision@k | recall@k | F1@k  |
|----|------------:|---------:|------:|-----|------------:|---------:|------:|
|    | **dense**   |          |       |     | **fused**   |          |       |
| 5  | 33.5 %      | 60.5 %   | 0.416 |     | 39.4 %      | 68.6 %   | 0.483 |
| 10 | 24.2 %      | 83.0 %   | 0.365 |     | 23.9 %      | 81.2 %   | 0.360 |
| 20 | 17.3 %      | 90.0 %   | 0.285 |     | 16.8 %      | 88.6 %   | 0.276 |

MAP@20 — dense 0.404 · fused 0.484

### Headline delta at k=10 (fused − dense)

| variant | metric       | strict: dense | strict: fused | strict Δ | trans-aware: dense | trans-aware: fused | trans-aware Δ |
|---------|--------------|---------------:|---------------:|-----------:|---------------:|---------------:|-----------:|
| easy    | precision@10 | 26.3 % | 21.7 % | **−4.6 pp** | 27.0 % | 25.8 % | **−1.3 pp** |
| easy    | recall@10    | 89.1 % | 74.8 % | **−14.4 pp** | 91.2 % | 87.0 % | **−4.1 pp** |
| easy    | F1@10        |  0.396 |  0.327 | **−0.068** | 0.406 | 0.387 | **−0.019** |
| easy    | MAP@20       |  0.416 |  0.421 | +0.005 | 0.474 | 0.537 | **+0.063** |
| hard    | precision@10 | 22.8 % | 19.9 % | **−3.0 pp** | 24.2 % | 23.9 % | −0.3 pp |
| hard    | recall@10    | 79.1 % | 68.6 % | **−10.5 pp** | 83.0 % | 81.2 % | **−1.8 pp** |
| hard    | F1@10        |  0.345 |  0.300 | **−0.045** | 0.365 | 0.360 | −0.006 |
| hard    | MAP@20       |  0.355 |  0.373 | +0.018 | 0.404 | 0.484 | **+0.080** |

**Under strict labels, fusion HURTS wikify at k=10** — 10–14 pp of recall and
3–5 pp of precision, on both variants. **Under translation-aware labels the
regression shrinks by roughly two-thirds but does not disappear**: recall@10
still drops 4.1 pp (easy) / 1.8 pp (hard), and MAP now clearly *improves* under
fusion in both variants and both label definitions. Nothing was tuned to
produce either column; the difference between them is entirely the label
definition, computed from the same single run. The next section shows why the
strict number is this much worse: it is not purely the translation-label
artifact — a real, smaller fusion regression on the KO subset survives even
once the artifact is corrected for.

### Where the regression comes from — language split (post-hoc)

This split was chosen *after* seeing the aggregate regress, on the hypothesis
that the KO fixtures' labels were the cause — it is not a pre-registered
breakdown, and is reported as such.

| labels | lang | variant | arm | precision@10 | recall@10 | F1@10 | MAP@20 |
|---|---|---|---|---:|---:|---:|---:|
| strict | EN (51) | easy | dense | 27.1 % | 94.2 % | 0.409 | 0.469 |
| strict | EN (51) | easy | fused | **27.5 %** | **94.9 %** | **0.414** | **0.559** |
| strict | EN (51) | hard | dense | 23.5 % | 84.3 % | 0.358 | 0.393 |
| strict | EN (51) | hard | fused | **25.3 %** | **87.8 %** | **0.382** | **0.497** |
| strict | KO (20) | easy | dense | 24.5 % | 76.1 % | 0.362 | 0.281 |
| strict | KO (20) | easy | fused | 7.0 % | 23.3 % | 0.106 | 0.069 |
| strict | KO (20) | hard | dense | 21.0 % | 65.9 % | 0.311 | 0.259 |
| strict | KO (20) | hard | fused | 6.0 % | 19.6 % | 0.090 | 0.057 |
| trans-aware | EN (51) | easy | dense | 27.1 % | 94.2 % | 0.409 | 0.469 |
| trans-aware | EN (51) | easy | fused | **27.5 %** | **94.9 %** | **0.414** | **0.559** |
| trans-aware | EN (51) | hard | dense | 23.5 % | 84.3 % | 0.358 | 0.393 |
| trans-aware | EN (51) | hard | fused | **25.3 %** | **87.8 %** | **0.382** | **0.497** |
| trans-aware | KO (20) | easy | dense | 27.0 % | 83.3 % | 0.398 | 0.485 |
| trans-aware | KO (20) | easy | fused | 21.5 % | 66.9 % | 0.318 | 0.479 |
| trans-aware | KO (20) | hard | dense | 26.0 % | 79.8 % | 0.383 | 0.433 |
| trans-aware | KO (20) | hard | fused | 20.5 % | 64.4 % | 0.304 | 0.452 |

The EN rows came back **identical** under both label definitions **in this
run**, so the twin rule did not manufacture the EN improvement here. This is a
measured property of this corpus and embedder, **not a structural guarantee**:
`label_match` is symmetric, and 20 of the 51 English pages do have Korean
twins, so an English case *could* gain a credited hit whenever a labeled
English stem falls outside the top-k while its Korean twin lands inside it. A
different embedder, more Korean pages, or a larger k could break the
invariance — it has to be re-checked, not assumed, on any future run. On EN,
fusion **helps on every metric, both variants**, under either label definition.

On KO, translation-aware labels recover most — not all — of the strict
collapse: recall@10 goes from 23.3 %→66.9 % (easy) and 19.6 %→64.4 % (hard),
but dense still beats fused on KO recall@10 by 16.4 pp (easy) / 15.4 pp (hard)
even once the twins are credited. So part of the KO regression really was the
labeling artifact (the ~53–45 pp jump on correction), and part of it is a
genuine fusion weakness on this specific 20-page bilingual subset that
translation-awareness does not explain away — plausibly the CJK-bigram lexical
arm still over-concentrating candidate slots on near-duplicate KO chunks in a
way that costs a *few* labeled hits even after the twin credit, though this
harness does not isolate that mechanism further. KO's MAP tells a mixed story:
fused MAP is roughly flat vs. dense on KO-easy (0.479 vs. 0.485) and higher on
KO-hard (0.452 vs. 0.433).

The mechanism for the artifact itself is visible in the harness's own
worst-case output (computed under strict labels, unchanged by this scoring
change), which prints what the retriever returned instead of the labels:

```
0.0%  ko-attention-mechanism (6 labels) <- ko-attention-mechanism, ko-self-attention,
                                           ko-kv-cache, ko-multi-head-attention, ko-embeddings
```

Every one of those top-5 stems besides the source page itself is the Korean
twin of a labeled English stem — exactly the pattern the translation-aware
definition credits.

### Verdict

- **Fusion helps wikify on the English subset** — the only subset whose labels
  were never confounded — on precision@10, recall@10, F1@10 and MAP, on both
  difficulty levels and under both label definitions (the EN rows do not move).
  The MAP gains are large (+0.090 easy, +0.104 hard): fusion pulls the correct
  pages toward the top of the candidate list.
- **Under strict labels, fusion hurts the aggregate**, overwhelmingly via the
  confounded KO subset (translation-labeled-as-wrong twins evicting the correct
  English answers).
- **Under translation-aware labels, the aggregate recall/precision regression
  at k=10 shrinks substantially (by roughly two-thirds) but does not
  disappear**, and aggregate MAP now improves under fusion in both variants.
  The residual KO gap is real, not an artifact of this particular labeling
  choice — treat it as a genuine (if second-order, non-EN) fusion weakness on
  this bilingual fixture set rather than as evidence against fusion generally.
- **Honest overall read**: fusion improves ranking quality (MAP) everywhere
  measured, and improves recall/precision cleanly on the sound (EN) label set;
  it costs some raw recall/precision on the KO fixtures specifically, and only
  part of that cost is a labeling artifact. The strict aggregate number
  overstates the harm; the translation-aware number is not a "fixed" number
  that erases it, and neither should be read as the sole headline in isolation.
- Neither of the review's two hypothesised harms was observed on EN: source-summary
  chunks do not eat candidate slots (both helpers filter before capping, which is
  unit-tested), and RRF's compressed score range does not flatten
  `rank_candidates` — the fused MAP is *higher*, i.e. discrimination improved.

### Decision

Per this project's standard (every addition must beat the recorded baseline or
be dropped), **wikify was reverted to dense-only** (2026-07-26): the strict-label
k=10 recall regression (−14.4 pp easy, −10.5 pp hard) is not offset by the MAP
gain for a "suggest wikilink targets" feature, where what a user sees is the
ranked list itself, not a ranking-quality summary statistic — and even under
the more generous translation-aware labels the KO recall gap does not fully
close. **Ask (`semantic_search`) is unaffected and keeps the fusion**, where it
was measured to help outright (see the Phase 1b sections above) with no
comparable regression.

**Mechanism, for whoever attempts fusion here again**: wikify's "query" per
chunk is a whole paragraph of source prose, not a short keyword query, so BM25
promotes many pages that merely share common vocabulary with that prose, and
RRF's rank-based weighting lets those lexical-only matches displace the
dense-correct pages in the fused ranking. The CJK bigram tokenizer compounds
this on long Korean text specifically (more spurious bigram overlaps across
unrelated pages as the query text gets longer), which is why the KO subset
regresses harder than EN even after crediting translation twins. A future
attempt should likely score on a short extracted query (keywords/entities, not
the raw chunk prose) rather than reusing the chunk text as the BM25 query
verbatim, and should re-run `examples/wikify_eval.rs` — kept in the tree for
exactly this — against the tables above before shipping.

### Worst EN cases — where a future change should aim

| variant | case | fused recall@10 |
|---------|------|----------------:|
| easy | `interpretability` (2 labels) | 50.0 % |
| easy | `analysis-scaling-vs-data`, `google-deepmind`, `pretraining`, `prompting` (3 labels each) | 66.7 % |
| hard | `google-deepmind`, `gpt-4` (3 labels) | 33.3 % |
| hard | `interpretability`, `layer-normalization`, `meta-ai` (2 labels) | 50.0 % |

The organisation/model pages (`google-deepmind`, `gpt-4`, `meta-ai`) are the hard
variant's weak spot: with the linked entity names deleted, nothing in the residual
prose distinguishes one lab or model page from another, and the fused top-5 fills
with sibling org/model pages.

### Determinism

Two consecutive runs of `cargo run --example wikify_eval --release` produced
**byte-identical stdout** (`cmp` clean), including every metric table and every
worst-case list. No nondeterminism source survives on this path.

### Re-measurement after the cosine-score fix (2026-07-26)

The dense arm above was originally computed through
`fuse_chunk_matches(&dense, &[])`, i.e. `rrf_fuse` over one arm. That preserves
the dense *order* within a chunk but replaces each hit's score with
`1/(RRF_K + rank)`, so `rank_candidates` was folding a page's chunks by **best
rank across chunks** rather than by **max cosine** — and the scores reaching the
ingest planner prompt and the Ingest panel, both of which read them as
similarities, were a near-constant ~0.017…0.012. The shipped command and this
harness's dense arm now both call `pipeline::dense_chunk_matches`, which keeps
the raw cosine.

Re-ran the harness twice after that change (`cargo run -q --release --example
wikify_eval`, `cmp` clean between the two runs — byte-identical). **Every dense
figure in every table above reproduced exactly**: strict easy dense
P@5/10/20 34.9/26.3/18.2 % · R 64.0/89.1/92.9 % · MAP@20 0.416; strict hard
22.8 % / 79.1 % / 0.355; translation-aware easy 27.0 % / 91.2 % / 0.474;
translation-aware hard 24.2 % / 83.0 % / 0.404; and every EN/KO split row. The
fused column is unchanged by construction (it still calls `fuse_chunk_matches`).

So on this corpus the two folds happened to produce the same ranking: max-RRF is
`min` rank and min-rank ordering agreed with max-cosine ordering on the whole
top-20 for all 71 cases × 2 variants. That is an **empirical coincidence of this
corpus, not an identity** — the two folds can disagree whenever a page's
best-cosine chunk is not its best-rank chunk, so the fix is a real behavioural
correction that this particular measurement cannot see. **No number in this
section changed, so the fusion verdict stands unchanged**: fused is still worse
than dense on aggregate recall/precision at k=10, and wikify still ships
dense-only.

### Known measurement artifacts

- **Precision has a hard ceiling below 100 %.** Cases average 3.0 labels, so
  precision@10 cannot exceed 30 % and precision@20 cannot exceed 15 %. Compare
  precision *between arms*, never against 100 %.
- **The source page P is itself indexed**, because the source text is derived from
  P's body. P therefore takes rank 1 in essentially every case (visible in the
  worst-case lists) and is excluded from its own labels, so it burns one slot of
  every top-k. Real wikify input is unindexed text, so this is an artifact — but it
  costs both arms identically, so it does not bias the dense-vs-fused comparison.
- The **easy** variant hands the retriever the target pages' titles verbatim (that
  is what "easy" means); the **hard** variant is the one with no lexical gift.
- The **hard** variant's phrase deletion leaves residual grammatical damage in a
  few cases (a comma or connective left dangling after its clause was removed).
  The `tidy()` cleanup repairs whitespace/punctuation, not grammar, so the hard
  variant is slightly less natural than real user prose — it affects both arms
  identically.
- The **EN/KO language split is a post-hoc breakdown**, chosen after the strict
  aggregate came back regressed, not a split planned before running the harness.
- The **translation-aware label definition changed no `EN` row in this run**: it
  adds no credit anywhere a labeled stem's twin does not exist, and every EN row
  in every table came out bit-for-bit identical between the two label
  definitions, which is evidence the definition did not do anything to the EN
  result here. It is *not* structurally guaranteed to leave EN alone —
  `label_match` is symmetric and 20 of the 51 EN pages have Korean twins, so an
  EN case can in principle gain a hit from a twin inside the top-k when the
  labeled English stem falls outside it. The EN invariance is a measured
  property of this corpus/embedder/k and must be re-verified on future runs.
  When both a stem and its translation twin are retrieved for one labeled stem,
  only the best-ranked one is counted (`compute_hits`), so translation-aware
  precision/MAP cannot be inflated by double-crediting a single label.
