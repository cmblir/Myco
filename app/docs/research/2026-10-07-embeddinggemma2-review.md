# EmbeddingGemma 2 review — 2026-10-07

**Decision:** keep the bundled E5 in installed myco for now. Evaluate
EmbeddingGemma 2 as a possible replacement for myco's
E5 retrieval/organization embeddings, not for Qwen's generated drafts or Ask
answers. The current pinned runtime cannot accept its GGUF as a file-only
replacement. Korean workload measurements are required before selecting it.

This is a documentation and installed-source review. No candidate weights were
downloaded, no candidate inference or benchmark was run, and no dependency,
installed application, provider preference, or private vault was changed by this
review. The procedures below are proposed work, not passing receipts.

## Official model and artifacts

The new release is **EmbeddingGemma 2**, announced **October 6, 2026**, rather
than the first EmbeddingGemma released in September 2025. Google identifies it
as a Gemma 4-based model under **Apache 2.0**.
[Google launch announcement](https://blog.google/innovation-and-ai/technology/developers-tools/embeddinggemma-2/),
[Google checkpoint](https://huggingface.co/google/embeddinggemma-2).

| Property | Official description |
| --- | --- |
| Parameters | Approximately 740M total; 270M text/code, plus optional 170M vision and 300M audio encoders |
| Inputs | Text/code, images, video and audio; shared 8,192-token context |
| Output | 768 dimensions; supported MRL truncations are 512, 256 and 128 |
| Text architecture | Mean pooling and a 512→768 projection |
| Languages | 100+ languages; the card does not provide a Korean-only comparison against our E5 artifact |

Sources: [Google model card](https://ai.google.dev/gemma/docs/embeddinggemma/model_card_2),
[developer guide and selective encoder loading](https://developers.googleblog.com/embeddinggemma-2-the-developer-guide/).
The full-model inference example reports 744,371,488 parameters; the table uses
Google's rounded configuration names.
[Google inference guide](https://ai.google.dev/gemma/docs/embeddinggemma/inference-embeddinggemma-with-sentence-transformers).

The card reports multilingual MTEB 61.36 versus 61.15 for EmbeddingGemma 1,
and code MTEB 78.68 versus 68.76. Those comparisons support investigating code
and multimodal retrieval, not a claim that Korean retrieval beats the current
pruned E5. Scores are full-precision benchmark results, not myco measurements.
[Google evaluation tables](https://ai.google.dev/gemma/docs/embeddinggemma/model_card_2).

The llama.cpp maintainers publish a text-sized GGUF with architecture
`gemma-embedding2`: **Q8_0 310 MB** and **BF16 558 MB**. These are listed artifact
sizes, not process RSS or a claim of full multimodal support in that conversion.
[ggml-org conversion](https://huggingface.co/ggml-org/embeddinggemma-2-GGUF).
Google's approximately **191 MB text-only / 567 MB full-model active weight RAM**
claim refers to quantized deployment on **Pixel 11 Pro**. It does not establish
macOS llama.cpp memory use, peak allocation or Intel/8 GB performance.
[Google memory claim](https://blog.google/innovation-and-ai/technology/developers-tools/embeddinggemma-2/).

## What it would change in myco

| Role | Current selection | Relevance of EmbeddingGemma 2 |
| --- | --- | --- |
| Meaning search and semantic organization signals | Bundled E5, with BM25/RRF for retrieval | Candidate replacement for numerical representations |
| Import/organization draft wording | Optional selected Qwen3.5 2B or 4B | No replacement: embeddings do not write summaries |
| Source-grounded Ask wording | Optional selected Qwen3.5 4B | No replacement: embeddings can supply evidence to the generator |

Current role boundaries and their measured limitations are recorded in the
[local role comparison](2026-10-05-local-model-routing.md#role-selection).
The installed AI settings observed during this follow-up selected 4B for both
Ask and import/organization; the review did not change either selection.
The E5 resource is **41,641,440 bytes**, with **384-dimensional**, mean-pooled
embeddings, `query: ` / `passage: ` prefixes and a **512-token** context.
These are the pruned bundled artifact's properties, not the unpruned upstream
model's parameter count.
[Current E5 spec](../../src-tauri/src/local_llm.rs#L171),
[artifact identity](2026-10-05-local-model-routing.md#artifact-identity-and-runtime).

An improved embedder may retrieve a missed paraphrase or improve topic geometry.
It does not by itself fix a generator's recommendation policy, unsupported
completion claims, or missing sources. The earlier E5 ablation already records
paraphrase failures and distinguishes ranking recall from clearing the unchanged
answer relevance floor.
[Existing retrieval gap](2026-10-05-local-model-routing.md#search-ablation-and-remaining-retrieval-gap).

## Current runtime and transition blockers

1. **Architecture support:** the lockfile pins `llama-cpp-2` and
   `llama-cpp-sys-2` **0.1.150**. The installed package's
   `llama.cpp/src/llama-arch.cpp:61` registers `gemma-embedding`; a read-only
   search of its `src` and `include` found no `gemma-embedding2` implementation.
   Gemma 4 and first-generation EmbeddingGemma support do not establish support
   for the new embedding architecture. The current app binary was not separately
   probed with candidate weights.
   [Lockfile](../../src-tauri/Cargo.lock#L2754),
   [published package source](https://docs.rs/crate/llama-cpp-sys-2/0.1.150/source/llama.cpp/src/llama-arch.cpp),
   [new GGUF architecture](https://huggingface.co/ggml-org/embeddinggemma-2-GGUF).
2. **Output length:** `embeddings_seq_ith` in the installed Rust wrapper uses
   `model.n_embd()` as the returned slice length (`context.rs:140–150`). The
   vendored C++ exposes separate hidden and output widths in
   `llama-model.cpp:2291–2300`. The new 512→768 projection therefore requires
   checking/fixing the Rust output contract as well as runtime support; silently
   treating a hidden-width slice as the final vector is not an acceptable probe.
   The package's `.cargo_vcs_info.json` identifies commit
   `5459e4dfe57bdb0de41bead8c7e8386ea7961368`.
   [Pinned Rust wrapper](https://github.com/utilityai/llama-cpp-rs/blob/5459e4dfe57bdb0de41bead8c7e8386ea7961368/llama-cpp-2/src/context.rs#L140-L150),
   [C++ width accessors](https://docs.rs/crate/llama-cpp-sys-2/0.1.150/source/llama.cpp/src/llama-model.cpp),
   [Google projection description](https://ai.google.dev/gemma/docs/embeddinggemma/model_card_2).
3. **Vector identity and rebuilds:** the dense-index signature includes the
   weight fingerprint, pooling, context, prefixes and chunk/aggregation identity.
   Model/signature changes clear dense records. Ontology and distill ledger
   invalidation check the model ID, so use a new ID and rebuild the matching
   geometry. BM25 remains an independent lexical fallback.
   [Index signature](../../src-tauri/src/commands.rs#L4178),
   [dense invalidation](../../src-tauri/src/vector_index.rs#L291),
   [ontology](../../src-tauri/src/ontology.rs#L377),
   [ledger](../../src-tauri/src/distill.rs#L282),
   [lexical fallback](../../src-tauri/src/commands.rs#L5243).
4. **Old quarantine vectors:** verdict sidecars contain vectors but no
   model/signature/dimension identity, and emerging-cluster detection reads them
   back directly. A future transition must separate or regenerate these vectors
   before mixing them with the new space. This review does not change that
   existing storage format.
   [Sidecar schema](../../src-tauri/src/distill.rs#L555),
   [sidecar reader](../../src-tauri/src/distill.rs#L1915).

## Minimum comparison before adoption — not executed

- Pin the official text-only candidate revision, bytes and SHA256, and evaluate
  an isolated runtime/spec without replacing the bundled E5 or changing user
  selections. First validate load support, finite final-width vectors and
  reference agreement. Google recommends BF16/FP32 reference inference rather
  than FP16. Apply the correct query/document task prompts; symmetric clustering
  uses its own task prompt. If evaluating MRL, use a supported dimension on both
  sides and L2-normalize after truncation.
  [Precision and task rules](https://ai.google.dev/gemma/docs/embeddinggemma/model_card_2),
  [MRL and encoder configuration](https://developers.googleblog.com/embeddinggemma-2-the-developer-guide/).
- Reuse synthetic retrieval, abstention and intent fixtures with fixed expected
  sources, adding Korean paraphrases, Korean/English pairs, code identifiers and
  irrelevant hard negatives. Compare dense-only, BM25-only and hybrid ranking,
  plus answerable/off-corpus acceptance. Keep the baseline rules unchanged;
  candidate thresholds require held-out calibration, not lowering a floor to
  hide misses. The current relevance floor is **0.42**, measured for E5, while
  emerging-topic **0.55** is explicitly an unmeasured default.
  [Retrieval evaluator](../../src-tauri/examples/retrieval_eval.rs#L59),
  [abstention probe](../../src-tauri/examples/abstention_probe.rs#L106),
  [intent probe](../../src-tauri/examples/intent_probe.rs#L120),
  [E5 floor](../../src-tauri/src/retrieval.rs#L39),
  [emerging threshold](../../src-tauri/src/distill.rs#L1894).
- Measure cold load, warm query/document latency, indexing throughput and peak
  process memory sequentially on an otherwise idle host. Compare the same source
  content and disclose tokenizer/truncation differences. Separate long-context
  and generation-contention runs from the initial comparison. The current
  `bench_embed` can select a file path but fixes its spec to E5; it needs explicit
  candidate-spec handling before its numbers describe this model.
  [Latency harness](../../src-tauri/examples/bench_embed.rs#L134),
  [fixed spec](../../src-tauri/examples/bench_embed.rs#L147).
- Run synthetic gate/clustering cases without file mutations, preserving raw,
  approval and deletion guards. Measure false admission/quarantine decisions
  before changing semantic thresholds. Rebuild model-bound indexes, ontology and
  sidecars in isolated data, and retain E5 as the rollback baseline. Do not infer
  Korean quality or low-memory-device behavior from the Pixel marketing figure.

There is no measured E5-versus-EmbeddingGemma 2 quality, speed or memory result
in this review. The next decision is whether the text-only candidate justifies
runtime and migration work after a bounded synthetic comparison.
