# Lightweight local generation options

Status update, 2026-10-05: optional Qwen Ask installation and its verification
are documented in [local generation verification](2026-10-05-local-generation-verification.md).
The review below records the October 4 state before that implementation.

Checked on 2026-10-04. The owner chose fully local processing first, with Intel
Macs and 8 GB RAM included in the support target. This review inspected source
and primary publisher/runtime documentation. It fetched public JSON metadata and
configuration files, but downloaded no model weights, ran no inference, changed
no defaults and read no vault content. Candidate answer quality, Intel latency
and total application memory remain unmeasured.

## What is installed now

The source model directory and the installed app's model directory each contain
one GGUF: `multilingual-e5-small-ko-v2-q8_0.gguf`, 41,641,440 bytes.

| Purpose | Current location or behavior |
| --- | --- |
| Source embedding weights | `app/src-tauri/models/multilingual-e5-small-ko-v2-q8_0.gguf` |
| Installed embedding weights | `/Applications/myco.app/Contents/Resources/models/multilingual-e5-small-ko-v2-q8_0.gguf` |
| Bundled embedding ID | `e5-small-ko` |
| Built-in Ask catalog ID | `extractive-retrieval`: retrieve and quote source passages |
| Built-in Ingest catalog ID | `extractive-ingest`: quote and cite source material |
| Local prose-generation weights | None in either inspected model directory |

`tauri.conf.json` bundles only that embedding GGUF. `providers.ts` explicitly
describes the built-in provider as extractive. The retained native generation
implementation does not mean a generation model is installed. The current
`local_model_path` only probes `models/gemma-3-1b-it-q4_k_m.gguf`; that file is
absent. Changing the selected model string does not download weights or make
this resolver select a different GGUF.

The verified E5 artifact provenance is recorded in the
[local model improvement review](2026-10-04-local-model-improvement.md#verified-bundle-provenance).
E5 turns text into retrieval vectors; it cannot generate a Korean summary or
reason over several passages. Adding a prose model would add a separate stage
after evidence retrieval. It would not recover evidence that retrieval missed.

## Candidate artifacts verified in publisher metadata

Byte sizes and SHA256 values below are the publishers' LFS metadata at verified
repository revisions, not locally recomputed weight checksums. None of these
artifacts is installed by this review. Decimal MB/GB describe disk bytes, not
runtime RAM. Quantization names alone do not determine file size.

| Candidate artifact | Verified bytes | Declared license | Review role |
| --- | ---: | --- | --- |
| Qwen2.5-0.5B-Instruct Q4_K_M | 491,400,032 | Apache-2.0 | Small CPU/resource baseline |
| Qwen3-0.6B Q8_0 | 639,446,688 | Apache-2.0 | Small hybrid reasoning comparison; mode handling required |
| Qwen2.5-1.5B-Instruct Q4_K_M | 1,117,320,736 | Apache-2.0 | First candidate for a grounded synthesis comparison |
| Qwen3-1.7B Q8_0 | 1,834,426,016 | Apache-2.0 | Larger optional comparison, not an 8 GB default |
| Gemma 3 1B QAT Q4_0 | 1,003,541,152 | Gemma Terms | Prior model-family comparison; different artifact from the old filename |
| EXAONE 4.0 1.2B Q4_K_M | 812,437,792 | EXAONE 1.2-NC | Korean-focused research comparison; distribution/use restrictions apply |

The candidate ordering is an engineering proposal, not a measured ranking.
Choosing the smallest file without measuring Korean source-grounded answers
could reproduce the current quality problem.

### Pinned artifact identities

- **Qwen2.5-0.5B**: `qwen2.5-0.5b-instruct-q4_k_m.gguf`, revision
  `9217f5db79a29953eb74d5343926648285ec7e67`, SHA256
  `74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db`.
  [Official pinned artifact metadata](https://huggingface.co/api/models/Qwen/Qwen2.5-0.5B-Instruct-GGUF/revision/9217f5db79a29953eb74d5343926648285ec7e67?blobs=true),
  [official model card](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF).
- **Qwen3-0.6B**: `Qwen3-0.6B-Q8_0.gguf`, revision
  `23749fefcc72300e3a2ad315e1317431b06b590a`, SHA256
  `9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031`.
  [Official pinned artifact metadata](https://huggingface.co/api/models/Qwen/Qwen3-0.6B-GGUF/revision/23749fefcc72300e3a2ad315e1317431b06b590a?blobs=true),
  [official model card](https://huggingface.co/Qwen/Qwen3-0.6B-GGUF).
- **Qwen2.5-1.5B**: `qwen2.5-1.5b-instruct-q4_k_m.gguf`, revision
  `91cad51170dc346986eccefdc2dd33a9da36ead9`, SHA256
  `6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e`.
  [Official pinned artifact metadata](https://huggingface.co/api/models/Qwen/Qwen2.5-1.5B-Instruct-GGUF/revision/91cad51170dc346986eccefdc2dd33a9da36ead9?blobs=true),
  [official model card](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF).
- **Qwen3-1.7B**: `Qwen3-1.7B-Q8_0.gguf`, revision
  `90862c4b9d2787eaed51d12237eafdfe7c5f6077`, SHA256
  `061b54daade076b5d3362dac252678d17da8c68f07560be70818cace6590cb1a`.
  [Official pinned artifact metadata](https://huggingface.co/api/models/Qwen/Qwen3-1.7B-GGUF/revision/90862c4b9d2787eaed51d12237eafdfe7c5f6077?blobs=true),
  [official model card](https://huggingface.co/Qwen/Qwen3-1.7B-GGUF).
- **Gemma 3 1B QAT**: `gemma-3-1b-it-q4_0.gguf`, revision
  `d1be121d36172a4b0b964657e2ee859d61138593`, SHA256
  `95e5b8d891cd6a794f66c2a6fb59a41e9562b4660560b854274eceffb628b22a`.
  [Official pinned artifact metadata](https://huggingface.co/api/models/google/gemma-3-1b-it-qat-q4_0-gguf/revision/d1be121d36172a4b0b964657e2ee859d61138593?blobs=true),
  [official artifact card](https://huggingface.co/google/gemma-3-1b-it-qat-q4_0-gguf).
- **EXAONE 4.0 1.2B**: `EXAONE-4.0-1.2B-Q4_K_M.gguf`, revision
  `162446400ea4596377a3ce1d3ddffa32971af0a6`, SHA256
  `7b5e753540183ae4d56e6febd9b48cdd944de53386e6faa8f51c8f98cb2b47df`.
  [Official pinned artifact metadata](https://huggingface.co/api/models/LGAI-EXAONE/EXAONE-4.0-1.2B-GGUF/revision/162446400ea4596377a3ce1d3ddffa32971af0a6?blobs=true),
  [official artifact card](https://huggingface.co/LGAI-EXAONE/EXAONE-4.0-1.2B-GGUF).

Publisher identity matters: the inspected `ggml-org/Qwen3-0.6B-GGUF` Q8_0 is
804,753,632 bytes, while the Qwen-published Q8_0 above is 639,446,688 bytes.
These are different artifacts despite similar names. This review does not
establish why they differ or that they perform identically.
[Runtime publisher metadata](https://huggingface.co/api/models/ggml-org/Qwen3-0.6B-GGUF/revision/b5f37287796e5be0ea3dab2e7430873fb3f73e49?blobs=true).

## Language, context and licensing limits

The official Qwen2.5 cards include Korean among supported languages and describe
32,768-token model context for both inspected sizes. That is a model limit,
not a recommended app allocation. Their GGUFs offer several quantizations;
the two Q4_K_M files above are concrete publisher artifacts.
[Qwen2.5-0.5B](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF),
[Qwen2.5-1.5B](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF).

Qwen3 describes 100+ languages, 32,768-token context and thinking/non-thinking
modes. Its official GGUF instructions use `/no_think` as a soft mode request.
This does not establish Korean personal-recall quality for the quantized model,
or a hard output-format guarantee.
[Qwen3-0.6B](https://huggingface.co/Qwen/Qwen3-0.6B),
[GGUF mode instructions](https://huggingface.co/Qwen/Qwen3-0.6B-GGUF).

Gemma 3's model family covers over 140 languages; the 1B size has 32K input
context. The Google QAT artifact is approximately 1 GB on disk, so describing
all 1B Q4 artifacts as approximately 500 MB would be wrong.
[Gemma model card](https://huggingface.co/google/gemma-3-1b-it),
[official QAT artifact](https://huggingface.co/google/gemma-3-1b-it-qat-q4_0-gguf).
Redistribution has the separate Gemma agreement and notice/use-restriction
requirements; it is not Apache-2.0.
[Gemma distribution terms, section 3](https://ai.google.dev/gemma/terms).

EXAONE explicitly targets English, Korean and Spanish and offers a 1.2B
on-device model with 65,536-token context. Its published Korean comparisons are
for the original model, not these quantized weights or myco's wiki questions.
The publisher recommends temperature 0.1 for Korean general conversation.
[EXAONE official card and usage guidance](https://huggingface.co/LGAI-EXAONE/EXAONE-4.0-1.2B-GGUF).
Its inspected agreement restricts use to research/education and requires a
separate agreement for commercial use. It should not be myco's general default
bundle on the assumption that open weights permit unrestricted product use.
[Official EXAONE 1.2-NC agreement](https://huggingface.co/LGAI-EXAONE/EXAONE-4.0-1.2B-GGUF/blob/main/LICENSE).

Qwen3.5-0.8B and 2B are further review candidates. The official 0.8B card
describes a newer hybrid architecture, 262,144-token default context and a
non-thinking default. It expressly does not support Qwen3's soft mode switch
and notes a greater tendency toward thinking loops. No public publisher GGUF
was verified at the two guessed `Qwen/Qwen3.5-*-GGUF` names: unauthenticated
metadata requests returned 401, which does not prove the repositories do not
exist. No size/hash or deployment readiness is asserted for them.
[Qwen3.5-0.8B official card](https://huggingface.co/Qwen/Qwen3.5-0.8B),
[Qwen3.5-2B official card](https://huggingface.co/Qwen/Qwen3.5-2B).

## Existing runtime: feasible building blocks and integration gaps

The installed Rust dependency is `llama-cpp-2` 0.1.150. Its vendored sources
recognize `qwen2`, `qwen3`, `qwen35`, `gemma3` and `exaone4` architectures.
Recognition is source evidence, not a successful model-load/inference test.
llama.cpp officially supports x86 CPU instruction sets and quantized GGUF
inference. Intel CPU use is therefore plausible without adopting a second
runtime or Python service, but the x86_64 app build and actual Intel inference
must both be tested.
[llama.cpp official runtime overview](https://github.com/ggml-org/llama.cpp).

The current native implementation already has a process-global backend, model
reuse, background blocking-task execution, serial access and a ten-minute idle
unloader. Those are useful foundations, but several gaps precede deployment:

- `with_local_llm` loads a found chat GGUF even when the caller only needs
  embeddings. Keep an embedding-only host and load chat weights only for a
  generation request. Model selection, download completion and model readiness
  must be distinct states.
- The resolver only knows an old Gemma filename. Add an explicit selected-model
  manifest with publisher, revision, expected bytes/hash, template/mode and
  license. Do not disguise Qwen weights under a Gemma filename.
- `format_chat` calls the native legacy template API; the inspected ChatML and
  EXAONE branches do not evaluate Jinja thinking kwargs. Qwen3's documented soft
  switch and EXAONE's supplied Jinja template are not interchangeable. Test
  exact prompt suffixes, EOS behavior and thinking separation for each candidate.
  [Qwen llama.cpp guide](https://github.com/QwenLM/Qwen3/blob/main/docs/source/run_locally/llama.cpp.md),
  [EXAONE template guidance](https://huggingface.co/LGAI-EXAONE/EXAONE-4.0-1.2B-GGUF).
- Generation currently allocates 4096 context tokens, prefill batches of 512
  and at most 512 output tokens. CPU thread counts and GPU offload use defaults.
  Installed bindings expose `with_n_threads`, `with_n_threads_batch`,
  `with_n_batch`, `with_n_ubatch` and `with_n_gpu_layers` for measured tuning.
- Oversized generation prompts currently discard their leading tokens. A future
  grounded synthesis path must budget complete evidence and instructions before
  tokenization, or report insufficient context, rather than silently losing them.
- The synchronous decode loop has no per-token cancellation argument. UI abort
  alone does not establish that CPU work stopped. Add cancellation checks during
  prefill/decode before enabling long interactive generation.

For Intel testing, explicitly start with zero GPU layers. A Metal build can
disable GPU inference using zero offloaded layers; CPU-only build options are
also documented. Do not copy Apple Silicon timings onto Intel CPUs.
[Official Metal and CPU build documentation](https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md#metal-build).

## Proposed bounded Korean synthesis experiment

Preserve E5, BM25, exact-source/hash checks and local timestamp filtering. Obtain
evidence first, then ask the optional generator to explain only that evidence.
Keep the extractive answer available when weights are absent, generation fails,
the evidence is insufficient, or the user chooses the lightest mode. Local
generation should not create source facts or control file writes by itself.

Start with the Qwen2.5-1.5B Q4_K_M publisher artifact and compare the smaller
Qwen2.5-0.5B baseline. Evaluate Qwen3-0.6B separately after mode/template checks.
These choices prioritize an available official artifact and an uncomplicated
text-only comparison; they are not a claim that Qwen2.5 has the best Korean
quality. Downloading, integration and measurements are subsequent work.

| Experiment control | Proposed initial value; not a verified product budget |
| --- | --- |
| Context | Compare 2048 and 4096 tokens; never allocate advertised 32K+ by default |
| Output | 128 and 256 tokens; short Korean answers with evidence references |
| Evidence | Complete cited passages fitting the actual model tokenizer budget |
| CPU threads | Compare 1, 2 and 4, constrained by the target Mac's available cores |
| CPU GPU layers | 0 for the Intel baseline |
| Prefill | Compare 128 and 256 tokens before raising batch/ubatch allocations |
| Concurrent generations | 1; pause/defer background reindexing under contention |
| Load policy | Generation only, with explicit progress and existing idle unloading |
| Default distribution | Retain lightweight embedding bundle until quality/resource gates pass |

Build 64 synthetic Korean questions, eight per category: exact facts, paraphrases,
local-day activity, resumed multi-day sessions, changed/superseded decisions,
connections across two sources, insufficient evidence and adversarial source
instructions. Keep source labels independent of generated answers; include
similar but wrong names/dates, unknown timestamps and assistant proposals.
Separate duplicate sessions/source revisions across evaluation partitions.

Measure retrieval Recall@12 and wrong-date inclusion first. On a fixed evidence
set, separately measure factual answer correctness, supported claim fraction,
citation validity, false acceptance on negatives, Korean language consistency
and answer completion. Valid reference IDs and copied dates alone do not prove
that a generated paraphrase follows from the source; use independently labeled
claims and human review for the quality comparison.

On a real Intel 8 GB Mac, record model/revision/hash, macOS, CPU, app architecture,
runtime build and all inference settings. Measure cold load separately from
warm runs; collect at least twenty warm app-level runs per selected configuration
for median/p95 time to first token and completion time. Record peak whole-app
resident memory, memory pressure, swap changes, CPU load, UI interaction latency
and cancellation latency while ordinary search/indexing tasks run. Weight file
bytes exclude KV cache, compute buffers, indexes, WebView and OS memory.

Use the official `llama-bench` prompt-processing/generation controls for the
runtime portion, with zero GPU layers and explicit thread/batch settings. Its
measurements exclude tokenization and sampling, so they cannot replace the
app-level latency test. The existing `bench_local_llm.rs` is Gemma-specific and
must be adapted before it can honestly report these candidate measurements.
[Official llama-bench measurement contract](https://github.com/ggml-org/llama.cpp/blob/master/tools/llama-bench/README.md).

Promote a candidate only after a reproducible improvement over the extractive
baseline and acceptable measured UI/memory behavior on Intel 8 GB. Publish
category denominators and resource measurements, retain source-grounded fallback,
and keep optional heavier candidates separate from the default install.
