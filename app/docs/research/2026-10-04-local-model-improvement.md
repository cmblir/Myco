# Local model quality improvements

Research checked on 2026-10-04. Retain the approximately 42 MB Korean E5
embedding model and improve evidence retrieval before replacing or training it.
This document separates existing implementation, verified artifact provenance
and proposed experiments. Intel Macs with 8 GB RAM and iPhone are support targets,
not hardware certifications established by this review.

## Verified bundle provenance

The local file is byte-identical to the publisher's Q8_0 GGUF, despite its renamed
filename. Its SHA256 and byte size match the LFS metadata in the
[official Hugging Face tree API at the pinned revision](https://huggingface.co/api/models/jc-lab/multilingual-e5-small-ko-v2-gguf/tree/2ef7b8d5761dce722669b4ffe2191f503daaf12a?recursive=true&expand=false).

| Field | Verified value |
| --- | --- |
| Local file | `app/src-tauri/models/multilingual-e5-small-ko-v2-q8_0.gguf` |
| Publisher file | `jc-lab/multilingual-e5-small-ko-v2-gguf/ggml-model-q8_0.gguf` |
| Repository revision | `2ef7b8d5761dce722669b4ffe2191f503daaf12a` |
| SHA256 and LFS object ID | `bc06a6d33fc6a69f44168dbb4a3106b8350a7a2cef356b6b66fd81409437aa2b` |
| Size | 41,641,440 bytes, approximately 41.6 MB or 39.7 MiB |
| GGUF parameter metadata | 37,368,960 parameters, BERT architecture |
| Distribution license declaration | Apache-2.0 |

The parameter count is [publisher API metadata at that revision](https://huggingface.co/api/models/jc-lab/multilingual-e5-small-ko-v2-gguf/revision/2ef7b8d5761dce722669b4ffe2191f503daaf12a), not an independently enumerated
tensor count. The [GGUF model card](https://huggingface.co/jc-lab/multilingual-e5-small-ko-v2-gguf)
declares Apache-2.0. The upstream
[Korean E5 card](https://huggingface.co/dragonkue/multilingual-e5-small-ko-v2)
reports 118M parameters, 384-dimensional output and a 512-token limit.
Do not mix the upstream parameter count with the bundled artifact's size, or
describe this distribution as MIT on the strength of the original E5 lineage.

The publisher compared GGUF embeddings with the original on seven Korean and
English samples. This is conversion evidence, not a personal-recall benchmark.
An upstream comparison with BGE-M3 does not establish the same score for the
bundled quantized file. Hash verification did not download or execute weights.

## Already implemented

- `local_llm.rs` applies `query: ` and `passage: ` prefixes, mean pooling and L2
  normalization, consistent with the Korean E5 card's retrieval examples.
- `embeddings.rs` separates spoken turns and headings, bounds chunks and retains
  their tails. Actual tokenizer windows include prefix and special-token costs.
- Oversized inputs combine normalized window vectors into one parent vector.
- Native retrieval combines BM25 and dense candidates with Reciprocal Rank Fusion,
  validates current chunk hashes, applies scope and tier policy, and caps results.
- Exact identifiers and quoted phrases can pass the dense floor only through
  verified lexical grounding; ordinary keyword coincidence cannot do so alone.
- Date parsing preserves quoted dates and date-shaped filenames. The IPC boundary
  supplies local midnight epoch bounds, including calendar days affected by DST.
- Structured turn timestamps support event filtering. Explicit unknown metadata
  does not establish a date; legacy files retain their coarser bucket fallback.
- Offline Ask quotes retrieved passages. E5 is an embedder, not a bundled prose
  generator or an automatic source of verified current facts.

Implementation evidence is in `local_llm.rs`, `embeddings.rs`, `commands.rs`,
`retrieval.rs`, `timeQuery.ts` and `sessionEvidence.ts`. Existing measurements and
their hardware limits are recorded in the
[knowledge recall report](2026-10-04-knowledge-recall.md#native-retrieval-measurements).
This review produced no new retrieval timing, memory or answer-quality measurement.

## Proposed priority order

| Priority | Experiment | Keep current model |
| --- | --- | --- |
| 1 | Classify failed questions and establish independent evidence labels | Yes |
| 2 | Tune hybrid fusion, tier weights, candidate selection and abstention | Yes |
| 3 | Compare chunk granularity while preserving headings, turns and provenance | Yes |
| 4 | Expand verified aliases and follow-up context while retaining the original query | Yes |
| 5 | Evaluate a bounded optional reranker only for demonstrated ranking failures | Additional model required |
| 6 | Consider embedding fine-tuning only after data and evaluation are adequate | Same model family possible; artifact size must be verified again |

These are proposals, not measured improvements or new default behavior. Preserve
immutable raw records, source revision checks and current candidate budgets until
a controlled experiment supports a change.

## Hybrid ranking and candidate recall

The empty/retired dense-index gate in `chat.ts` was reproduced and removed.
Ask now calls native hybrid retrieval and accepts source-verified lexical
evidence while dense vectors are absent or rebuilding. Unverified high-cosine
responses from an incompatible dense index remain rejected. Unit regressions
and the held-IPC browser tests cover these states; the 0.42 dense floor was not
lowered to make unrelated answers pass.

One separate source-observed gap remains: `rank_hybrid` caps its final result
count before `ask_response` applies the evidence floor; rejecting those hits can
leave an underfilled answer. Candidate refill after rejection still needs an
independent quality regression before changing that policy. An exact ID match
does not prove that a cited proposal was accepted or remains current.

The [local generation review](2026-10-04-local-generation-options.md) records
the owner's fully-local preference, concrete publisher artifacts and the
remaining runtime/Intel measurement work. These candidates are not installed
and are not additions to the built-in model picker.

BM25 was a robust baseline in the heterogeneous
[BEIR evaluation](https://arxiv.org/abs/2104.08663); reranking performed well at
higher computational cost. Hybrid retrieval therefore remains a suitable baseline
for exact names and IDs alongside semantic wording. A
[fusion analysis](https://arxiv.org/abs/2210.11934) found parameter sensitivity in
RRF and strong results from a tuned convex combination of lexical and dense scores.
Proposed experiment: compare the existing RRF with normalized weighted fusion on
held-out questions. A universal gain for myco is not established by those papers.

## Windowing and query preparation

Complete input coverage does not prove that a particular fact remains retrievable.
Hypothesis: averaging several windows can dilute a decisive name or changed
decision. Compare the current vectors with smaller source chunks, retaining turn,
heading and source identity; report both recall and the increased index cost.
Any change to chunk identity or vector aggregation requires index invalidation.

Proposed query expansion should retain the original exact terms and copy aliases
only from confirmed records. Generative rewriting needs a separate writer:
the [Rewrite Retrieve Read research](https://aclanthology.org/2023.emnlp-main.322/)
uses language models, not embedding-only inference. Do not infer that the current
42 MB embedder can generate rewrites or decide which historical claim is true.

## Reranking and training tradeoffs

An optional cross-encoder scores a query and each retrieved candidate together,
as described in the [official retrieve and rerank guide](https://sbert.net/examples/sentence_transformer/applications/retrieve_rerank/README.html).
It can reorder candidates but cannot recover a source absent from that set.
Proposed use is bounded and conditional on measured ranking errors; relevance
scores do not certify entailment, speaker authority or present-day validity.

The [Korean E5 card](https://huggingface.co/dragonkue/multilingual-e5-small-ko-v2) reports that standard Multiple Negatives Ranking training
alone reduced performance, while margin-guided training improved its evaluation.
[NV-Retriever](https://arxiv.org/abs/2407.15831) studies positive-aware hard-negative
mining to remove false negatives. Proposed training data should contain questions,
correct evidence and verified hard negatives, including similar names and dates.
Do not treat another valid source as a negative merely because it was not clicked.
Training is a separate development experiment; conversion, quantization, complete
reindexing and score calibration must be checked before deploying new weights.

## Evaluation and resource limits

[LongMemEval](https://arxiv.org/abs/2410.10813) separates extraction, multiple-session
reasoning, temporal reasoning, knowledge updates and abstention. Use those failure
classes without claiming its benchmark score for myco. Proposed fixtures should
also cover user versus assistant assertions, proposals versus accepted decisions,
current versus superseded or disputed notes, emails, calendar events and long tails.
Email sent time, calendar event time, import time and document creation time must
remain distinct. Fixtures test source contracts; they do not prove live connectors.

Track evidence Recall@12, exact-name hit@1, nDCG@10, wrong-date inclusion, update
confusion and false acceptance on negatives. Measure generated-answer correctness
separately. Group duplicate sessions and related source revisions into one
partition to avoid training and evaluation leakage; report category denominators.

42 MB is a file size, not total application RAM. Tokenizer, context buffers,
vectors, lexical index, WebView and OS memory also matter. Larger embeddings or
rerankers add weights and inference cost; fitting weights alone does not certify
responsive Intel 8 GB operation. Measure cold and warm CPU latency, total app
memory and indexing contention; measure iPhone memory, thermal behavior and UI
response separately. Existing Apple Silicon probes are not Intel or iPhone results.
