# Optional local Ask generation

This is the preceding Ask-only implementation record. The later
[role routing comparison](2026-10-05-local-model-routing.md) adds 2B import and
organization drafts and supersedes the runtime budgets below. Installation and
test receipts here describe the earlier build, not the later installed binary.

Implemented on 2026-10-05 after the owner authorized selecting and installing
the recommended local generator. This changes ordinary source-grounded Ask;
it does not enable new local prose generation for Ingest, maps, digests, or
other workflows. Topic-free dated recall and structural connection overviews
keep their deterministic paths. Retrieval still needs to find relevant evidence
before the generator can help.

## Artifact and installation

Qwen3.5-4B Q4_K_M is a separately installed artifact, not an app
resource. The bundled E5 embedder is unchanged (41,641,440 bytes). Each Mac can
keep quote-only Ask without downloading chat weights. Settings → Model provides
explicit download, verification, cancellation, and model-selection controls.
Installation alone does not switch another device's answer provider.

| Field | Verified identity |
| --- | --- |
| Repository | `lmstudio-community/Qwen3.5-4B-GGUF` |
| Revision | `f9f88ac3e234be915e23811a6d28ea287bdb927e` |
| Filename | `Qwen3.5-4B-Q4_K_M.gguf` |
| Bytes | 2,707,513,696 (2.71 GB disk space; not a RAM estimate) |
| SHA256 | `25082a7dd3776cc3c741c6347d3bd04523f05796607b3fbc32fa3a25dfa1418c` |
| License | Apache-2.0 |
| Per-user directory on macOS | `~/Library/Application Support/dev.cmblir.myco/models/` |

The base checkpoint is published by Qwen; this GGUF is the LM Studio community conversion,
not a Qwen-published GGUF. Its model card declares Apache-2.0 and identifies
the original checkpoint. The exact source-checkpoint revision used by the
converter was not independently established. The app streams explicit
downloads to a unique temporary file, checks the pinned size
and digest, then publishes atomically. Missing, corrupt, oversized, shortened,
or symlinked artifacts never become ready. An unchanged file's verified verdict
is cached using Unix path, inode, device, size, modification and change times;
unchanged corrupt bytes also avoid repeated full-file reads.

[Original model card](https://huggingface.co/Qwen/Qwen3.5-4B),
[quantizer's model card](https://huggingface.co/lmstudio-community/Qwen3.5-4B-GGUF),
and [pinned artifact metadata](https://huggingface.co/api/models/lmstudio-community/Qwen3.5-4B-GGUF/revision/f9f88ac3e234be915e23811a6d28ea287bdb927e?blobs=true).

## Execution and evidence boundaries

- Startup and embedding-only calls create a host without chat weights. Ask
  loads Qwen when needed and releases its independent host after at least
  180 idle seconds, checked every 30 seconds. E5 is not replaced by Qwen.
- Intel uses CPU inference; Apple Silicon uses Metal. CPU inference and prefill
  use at most four threads. The context is 4,096 tokens, prefill batches are
  128 tokens, and new Ask output is capped at 256 tokens. Metal keeps mmap;
  CPU disables mmap to avoid keeping mapped originals beside repacked weights.
  mlock is disabled. Model loading itself is not cooperatively interruptible.
- New background index batches defer while local synthesis is active or
  queued. A batch that was already running is not interrupted.
- A request is bound to the open canonical vault, scope, period, and optional
  exact relative paths. Up to 12 retrieved chunks are checked against current
  on-disk source text and the BM25 content hash. Individual files are bounded
  at 2 MiB, and total source reads at 8 MiB. The same check runs after inference.
- Exact model-template token counts select at most six complete passages;
  neither instructions nor source text are silently truncated. Reserved chat
  markers and NUL are rejected. Untrusted source passages are presented as
  data and the prompt distinguishes requests/proposals from completed work.
- Short follow-ups can include the preceding user question as topic context.
  That question is bounded separately, is not source evidence, and does not
  transfer its dates or prior generated answer to the current request.
- Answers must be complete JSON with known evidence IDs and supported language
  text. Native code constructs wikilinks from verified relative paths. Invalid
  citations, unsupported output, missing models, and execution errors restore
  source quotes. Source-verification rejection instead suppresses the stale
  answer, citations, copy action, and source details; Retry retrieves fresh
  evidence before another generation attempt. Stop cancels its own queued/prefill/decode request; the UI
  rejects late results and vault changes. A 30 s availability-check deadline
  allows initial disk verification without blocking the UI.

These guards establish source identity and citation validity. They do **not**
prove that each generated claim is entailed by its source. Generated text is
marked with its local model, and source passages remain available for review.

## Reproducible verification

`examples/local_ask_probe.rs` uses synthetic passages and the production chat
template, prompt budget, inference, and answer validator. It performs no vault
reads or writes. Its cases cover Korean facts, changed decisions, two-source
connections, proposals versus completion, absent facts, injected source
instructions, conflicting figures, negation, unmeasured hardware claims, and
English/Japanese responses. Citation acceptance is recorded separately from
manual assessment of the answer. `MYCO_EVAL_CPU=1` exercises zero GPU offload
on the same Apple M3; this is not an Intel benchmark.

### Rejected small candidate

Qwen2.5-1.5B-Instruct Q4_K_M (official Qwen GGUF, revision
`91cad51170dc346986eccefdc2dd33a9da36ead9`, 1,117,320,736 bytes,
SHA256 `6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e`)
was downloaded and evaluated first. Without constrained sampling, nine of
twelve replies failed JSON/citation validation. With JSON grammar and the
runtime correction below, all twelve passed format and reference checks, but
manual comparison found false claims: it named the generation model as the
embedder, treated a proposed mail connector as completed, and collapsed a
42 MB/40 MB disagreement to a definite 40 MB. Another answer added an unsupported
simultaneous-processing rationale. It was rejected as the recommended model;
valid JSON and references did not establish answer correctness.

Adding grammar also exposed an inherited sampler bug. In installed
`llama-cpp-2` 0.1.150, `sample()` already accepts the sampled token. Calling
`accept()` again advanced grammar twice and caused a native assertion abort
at `llama-grammar.cpp:940`. The duplicate call was removed before deployment;
the subsequent complete real-inference run exited successfully. The existing
dependency versions were retained.

Qwen3-4B-Instruct-2507 Q4_K_M (Unsloth revision
`a06e946bb6b655725eafa393f4a9745d460374c9`, 2,497,281,120 bytes, Apache-2.0)
was the next rejected candidate. Its first run corrected the embedder/completion errors but still described
conflicting figures as a numeric range and a reviewed export path as an
available capability. Two other cases returned a numeric-only answer rejected
by the Korean-language guard and an unnecessary English abstention. Prompt
instructions were tightened to preserve source status, distinguish conflicting
figures without inventing a range, and use complete sentences with partial
supported information. The synthetic evidence and expected outcomes were not
changed for this comparison.

Further 4B comparisons used tightened Korean/English/Japanese instructions,
generic reasoning examples, and the checkpoint's non-thinking sampling settings
(temperature 0.7, top-p 0.8, top-k 20, fixed seed 42). The final thirteen-case
run completed without a native error, but still inferred an unfinished mail
connector from missing implementation records, claimed that an explicitly
documented app-data location was unspecified, and generalized delayed new
index batches into a requirement for sequential execution. It also strengthened
a hardware support target into actual support. A one-sentence instruction
caused widespread unnecessary abstention rather than solving these errors.
Neither syntactically valid answers nor broad quote fallback justified choosing
this candidate as the recommended generator.

Phi-4-mini-instruct Q4_K_M was also evaluated (Unsloth conversion, revision
`78eb92a46fc37e6b524df991ed9aca9bc6aa7b80`, 2,491,874,272 bytes, SHA256
`88c00229914083cd112853aab84ed51b87bdf6b9ce42f532d8c85c7c63b1730a`, MIT).
The temporary adapter matched the actual GGUF's no-newline template and checked
its EOS/EOG behavior; it did not use llama.cpp's newline-inserting Phi3 formatter.
All seventeen first-run replies passed format checks, but answers obeyed an
injected source instruction (64 GB instead of 8 GB), chose one conflicting
size, and again inferred unfinished work from missing completion records.
Another answer began with yes while stating that the public SMS API is absent.
An English policy with generic contrasting examples still confused retrieval
with generation, followed the injected instruction, inferred unfinished work,
and invented a range from conflicting sizes. Phi was rejected, and its temporary
adapter was removed rather than leaving an unsupported model option.

### Selected Qwen3.5 candidate

The first Qwen3.5 run with the earlier localized policies still inferred an
unfinished mail connector from absent completion records. The shared English
grounding policy now distinguishes unknown outcomes from explicit completed
and unfinished statuses, preserves incompatible numeric claims, and treats
previous questions and source instructions as untrusted context. Output remains
Korean, English, or Japanese. The same policy was evaluated for all three output
languages and then copied byte-for-byte into `src/local_ask_policy.txt` with only
the language placeholder changing. The final run disabled the evaluation-policy
override and used the compiled production prompt.

All 17 final replies passed JSON/language/source-ID validation. Manual comparison
found the core factual claims supported by their supplied synthetic passages,
including proposal versus completion, an explicit current rollback, malicious
source instructions, and numeric disagreements. This is a small development
set, partly used while choosing prompts, not an independent general-accuracy
benchmark. Some replies omit secondary details, the hardware answer relies on
the question's future tense instead of repeating “target,” and the disagreement
answer still names S1/S2 inside the body despite the instruction to omit IDs.
The generated wording is less polished than the source identity checks; none
of these tests establishes correctness for every real wiki question.

The GGUF reports architecture `qwen35`, EOS `<|im_end|>`, no added BOS, and a
7,756-byte chat template with SHA256
`a4aee8afcf2e0711942cf848899be66016f8d14a889ff9ede07bca099c28f715`.
The binding cannot pass `enable_thinking=false` to this Jinja template, so the
adapter implements only its verified text-only system/user, no-tools branch,
including the empty thinking block in the assistant prefix. A changed template
is rejected. Reserved ChatML, vision, audio/TTS markers and NUL are rejected;
there is no extra vision projector download. No independent Jinja execution
comparison is claimed.

The grammar-constrained sampler uses temperature 0.7, top-p 0.8, top-k 20,
presence penalty 1.5, repetition penalty 1.0, and fixed seed 42. The penalty
history covers at most 256 generated tokens. The seed and short output/context
limits are application choices. The other values follow the checkpoint's
[general non-thinking recommendation](https://huggingface.co/Qwen/Qwen3.5-4B/blob/851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a/README.md).
Qwen3.5 does not use Qwen3's `/nothink` switch.

Final Metal production probe on Apple M3 / 16 GB:

| Observation | Result | Limit |
| --- | --- | --- |
| SHA256 verification | 31.86 s first / 0.117 ms unchanged | First pass overlapped frontend QA |
| Weight load | 2.41 s | Same host, warm file cache |
| Answer duration | 8.64–21.28 s; median 13.67 s | Short synthetic passages; part of run overlapped frontend QA |
| Largest sampled process RSS | 2,856.33 MiB | Samples after replies, not peak or whole-app RAM |
| Native cancellation after flag | 2.53 s | Context setup and current prefill batch are not interruptible |

Runtime logs independently show 128 MiB attention K/V plus 50.25 MiB recurrent
state (48 MiB S + 2.25 MiB R) at context 4,096 and one sequence. These are state
tensor payloads only, not the complete memory requirement. They exclude weights,
compute buffers, Metal, E5, UI, allocator overhead and the OS. UI Stop is
immediate and drops late results; it is distinct from native cleanup latency.
The frontend availability check can time out after 30 seconds and preserve
quote-only answers while the first native checksum finishes and warms its cache.

The zero-offload CPU comparison used the same M3 / 16 GB and the first three
synthetic cases, not an Intel Mac or the entire 17-case set. All three replies
passed validation and retained the expected core facts in both configurations.
With mmap, the runtime allocated 2,571.63 MiB CPU_Mapped plus 2,567.96 MiB
CPU_REPACK model buffers, and the largest post-answer sampled RSS was
5,113.38 MiB. An explicit CPU buffer override did not prevent repacking in this
vendor version; that ineffective experiment was removed.

With CPU mmap disabled, runtime model buffers were 500.98 MiB CPU plus
2,567.96 MiB CPU_REPACK. The largest post-answer sampled RSS fell to
2,873.70 MiB (about 44% lower). First verification took 19.83 s, cached
verification 0.056 ms, and loading 5.58 s. The three answers took
24.29–28.83 s (versus 25.18–28.97 s with mmap), and cancellation after a signal
took 3.43 s. This comparison does not establish an exact speed gain, peak RAM,
or whole-app usage. CPU no-mmap is the chosen loading policy; the Metal mapping
policy is unchanged. No unsafe binding changes or dependency updates were made.

Intel Mac with 8 GB remains a support target. This host is Apple M3 and only
the arm64 Rust target is installed. No Intel machine, x86 release, constrained
8 GB whole-app measurement, or private-vault answer-quality certification is
claimed by this verification.

## Automated checks

- Frontend: 328 files / 4,571 tests passed. Node 25.9.0 exposes an unusable
  default Web Storage object without a storage file; plain Vitest reproduced
  91 failures in 11 files at `storage.setItem`. The README's existing
  `NODE_OPTIONS=--no-experimental-webstorage` invocation passed the entire
  suite without changing assertions or production storage. A later full run
  exposed one existing mutation fixture crossing a second boundary: Date.now
  is now fixed during that comparison and restored afterward, preserving the
  entire before/after assertion. The settings browser harness now waits for
  the responsive sidebar effect and transition before clicking its gear.
- TypeScript build passed. ESLint passed with two pre-existing React Hook
  warnings in `notchDriver.ts`; neither was modified by this feature.
- Native: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`,
  and `cargo test` passed: 1,081 tests across unit and integration suites,
  15 opt-in tests ignored. The actual-weight template/grammar-construction test was then
  explicitly run and passed separately against the chosen Qwen3.5 weights
  (`generation_template_tokens_and_rejection_guards`, one passed).
- Synthetic browser contracts: `ask-local-synthesis-smoke.mjs` passed 206
  checks plus 8 focused follow-up checks; `local-model-settings-smoke.mjs` passed 190 checks. These exercise
  real UI interactions at 375/768/1280 px with synthetic IPC, not native
  inference or real network downloads. Failure recovery, scoped paths,
  epoch ranges, Stop, late results, explicit download/selection, progress,
  cancellation cleanup, source rejection/retry, keyboard operation, and visible
  layouts were checked. Screenshots were inspected at 375 and 1280 px.

Run the browser scripts against a loopback Vite development server. No
personal vault files were used as fixtures. The Qwen weights are untracked
per-user data; no dependency or model bundle additions were made.

## Installed application verification

The arm64 release build completed on 2026-10-05 with the existing dependency
versions. The previous application quit normally and was backed up to
`~/Library/Application Support/myco-install-backups/20261005-113956/myco.app`
before `/Applications/myco.app` was replaced. The installed version is 0.4.0;
its executable SHA256 is
`105f49eb1b64222df0d43c7c52ab52d4aa66de10a49c8b173da5965fa06d363e`.
`codesign --verify --deep --strict` passed. This is a local ad-hoc-signed arm64
build, not a notarized public release or an Intel build.

The installed app's native AI settings showed the verified model as ready.
Selecting “Use Qwen for question answers” produced a saved confirmation and
the selected-state label. Disk readback independently confirmed
`query_provider=builtin-local` and `query_model=qwen3.5-4b-q4_k_m`.
The canonical settings digest excluding those two fields was identical before
and after selection; all other preferences were preserved. No private-vault
question was submitted for this verification.

The installed resources still contain only the original
`multilingual-e5-small-ko-v2-q8_0.gguf` embedding model: 41,641,440 bytes,
SHA256 `bc06a6d33fc6a69f44168dbb4a3106b8350a7a2cef356b6b66fd81409437aa2b`.
The separate verified Qwen3.5 artifact remains in the per-user model directory.
The three rejected candidate files downloaded for this comparison were removed
only after their exact filenames, sizes, SHA256 digests, and unchanged file
identities were checked. No other model files were removed.
