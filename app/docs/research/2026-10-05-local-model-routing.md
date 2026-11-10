# Bounded local wiki tasks — 2026-10-05

This continues the [earlier generator evaluation](2026-10-05-local-generation-verification.md).
The earlier rejected Qwen2.5 1.5B, Qwen3 4B and Phi-4-mini evaluations remain
historical evidence; they were not rerun in this comparison. This change evaluates
Qwen3.5 2B and 4B against the same production prompt, decoder and evidence checks.
It also extends local generation to import and daily/weekly/monthly draft summaries.
It does not enable arbitrary local agents, entity editing, map drafting, or every
other workflow that currently needs a provider with file tools.

## Role selection

| Task | Selected approach | Reason and boundary |
| --- | --- | --- |
| Retrieval, related notes, tags | Existing bundled Korean E5-small + BM25 + RRF | Qwen does not replace embeddings. Tags reuse the vault vocabulary; links remain deterministic. |
| Dated activity overview | Verified original transcript dates and role-attributed excerpts | No generator or similarity top-K is required for a topic-free day overview. These are statements, not independently verified completed tasks. |
| Existing note connections | Readable resolved wiki links and shared tags | Conversation-only scope cannot establish this graph; return an explicit scope notice instead of echoing a test plan. |
| Source-grounded Ask synthesis | Qwen3.5 4B Q4_K_M | More reliable than 2B on this small Ask set, with original passages retained for review. |
| Import summaries and local organization | Qwen3.5 2B Q4_K_M, explicitly selected for import | Faster small drafts; marked low confidence and stored alongside complete bounded evidence. Organization prefers the selected local import model when Ask uses the built-in provider. Remote Ask preserves its existing organization route. |

Settings → Model shows two separately verified artifacts and independent Ask/import
selection buttons. Installing one does not change provider preferences. Quote-only
operation is available without either download. Selecting 2B for Ask is an explicit
experimental option with its observed relationship error disclosed; it is not the
recommended Ask choice. Other devices retain their current selections.

The reported Korean question `내가 어제 한 일들에 대해서 알려줘` previously missed
the topic-free activity route because `에 대해서` was not recognized. It now uses
the original transcript timestamps even for an empty or incomplete result, without
falling back to a low-similarity user request as an answer. Generic connection
discovery in conversation-only scope now stops with an explicit scope notice;
a copied browser-test question cannot establish the wiki's existing links.

## Actual comparison

Hardware: Apple M3, 16 GB RAM, macOS, Metal. The initial 17 Ask cases and 8 import/organization
cases use synthetic sources only. Context is 2,048 tokens; output is capped at 192.
Temperature/top-p/top-k/seed and production evidence policy are shared. No root
compilation, browser or full test run overlapped inference. Brief focused TypeScript
tests from a delegated task may have overlapped the early 2B run; timings are
development observations, not controlled statistical performance claims.

| Model / task | Cases | Format + citation acceptance | Median | Observed range | Maximum post-answer process RSS |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2B Ask | 17 | 14/17 | 4.18 s | 3.34–5.97 s | 1,512.86 MiB |
| 4B Ask | 17 | 17/17 | 9.85 s | 7.86–14.27 s | 2,852.23 MiB |
| 2B import/organization | 8 | 8/8 | 5.47 s | 3.60–6.64 s | 1,513.47 MiB |
| 4B import/organization | 8 | 8/8 | 12.57 s | 9.25–18.93 s | 2,853.70 MiB |

Acceptance is **not** an accuracy score. Manual comparison found these limitations:

- 2B invented that background indexing indicates active answer generation. The
  actual source says new indexing batches are deferred during generation.
- 2B incorrectly applied an untrusted-source qualifier to the valid 8 GB target.
  Two other Ask outputs lacked citation IDs; `2–4초` failed the complete Korean
  output guard. These rejected outputs return original quotations.
- Both models omitted secondary details in some short replies. 4B strengthened
  a hardware support target into minimum support without retaining the qualifier.
- The 2B organization draft correctly retained both 42 MB and 40 MB records,
  but described recorded values as measured. 4B additionally mentioned an
  unconfirmed measurement-unit difference. Neither warrants high confidence.
- Proposal-only sources remained unconfirmed, and a later rollback superseded
  earlier reported completion in the tested organization cases.

The sources, raw outputs, acceptance/rejection, token counts, timings and RSS are
retained in [synthetic comparison data](2026-10-05-local-role-results.json).
Reproduce with `cargo run --release --example local_ask_probe -- --bounded --roles`
and add `--model-2b` for the smaller artifact. `--quick` limits Ask to three cases;
`MYCO_EVAL_CPU=1` disables GPU offload on the current host, not on an Intel device.

The separate CPU-only 2B quick run accepted all three Ask outputs, taking
9.41–11.55 seconds (median 9.96 seconds). Observed post-load RSS was 2,120.53 MiB;
post-answer RSS reached 1,494.89 MiB. These snapshots are not peak-memory
profiling. CPU numerical behavior produced a valid citation for the changed-decision
case that the Metal run rejected; the CPU subset does not override the 2B Ask
semantic failures. Recorded cancellation probes use the legacy 4,096/256 helper,
so their delay is not a measurement of the new handler's bounded deadline.

### Final attribution follow-up

After adding original speaker/date attribution, an experimental version prefixed
even plain undated documents with `Source`/unknown-date JSON. Actual 2B generation
then accepted only 4/9 citation outputs; its English reply also denied that the
passage recorded facts. That framing was rejected and its nine outputs retained
in the comparison data. The final path leaves plain undated documents unchanged,
while retaining meaningful verified turn/document attribution.

Both models were then rerun sequentially on nine import/organization cases,
including an Oct 4 User request and Oct 5 Assistant record without a confirmed
outcome. No root tests, builds or browser checks overlapped these runs, and the
Myco app was closed.

| Model | Format + citation acceptance | Median | Observed range | Maximum post-answer process RSS |
| --- | ---: | ---: | ---: | ---: |
| 2B | 9/9 | 2.82 s | 1.70–3.06 s | 1,498.64 MiB |
| 4B | 9/9 | 5.14 s | 3.55–7.55 s | 2,858.88 MiB |

These observations differ from the initial run and are not controlled repeated
trials or a latency guarantee. Both preserved the unconfirmed backup outcome;
4B retained its dates, while 2B omitted them in its short preview. The final 4B
conflict reply no longer invented a measurement-unit explanation; the 2B reply
still described recorded sizes as measured. Acceptance therefore still does not
establish sentence-level accuracy, and previews remain low confidence.
Reproduce this subset with `--bounded --roles-only` and optionally `--model-2b`.

### Search ablation and remaining retrieval gap

`cargo run --release --example local_search_probe` indexes twelve synthetic
documents in memory using the production `embed_spec` role prefixes and compares
dense-only, BM25-only and RRF/tier-prior ranking for twelve fixed questions.
It never reads or writes a user vault. Dense and hybrid put the intended source
first for 10/12 questions and within three for 11/12; BM25 scored 9/12 and 10/12.
Observed query computation took 7.39–10.44 ms on this tiny corpus, not on a large
vault. This result supports retaining both search arms, not a general claim that
the current embedder is optimal.

Two paraphrases remain weak: the intended source for `메일 연동은 끝났어?`
ranked fourth and the highest dense score was 0.313, below the unchanged 0.42
floor. Another vague retrieval paraphrase had a top score of 0.399, also below
the floor, although its source ranked within three. Rank recall alone therefore
overstates successful Ask coverage. No relevance threshold was lowered or expected
question rewritten to hide these failures. Broader paraphrase retrieval needs
additional evaluation; selecting a generator cannot repair missing evidence.

The initial search harness mistakenly called the legacy chat-model embedding
helper after loading an embedding-only host and stopped with `no local chat model
is bundled`. The corrected run above uses `embed_spec`, matching native search.
This was a harness error, not evidence that production search needs chat weights.

## Artifact identity and runtime

| Artifact | Revision | Bytes | SHA256 |
| --- | --- | ---: | --- |
| LM Studio community Qwen3.5 2B Q4_K_M | `bb84e11355a036e28f080c7793fa6d22b7c4e344` | 1,270,808,032 | `0bfe35afc9f05b7fac3fa04925e051ac7939a42a8a17ea11afc99701bea826cc` |
| LM Studio community Qwen3.5 4B Q4_K_M | `f9f88ac3e234be915e23811a6d28ea287bdb927e` | 2,707,513,696 | `25082a7dd3776cc3c741c6347d3bd04523f05796607b3fbc32fa3a25dfa1418c` |

Both conversions declare Apache-2.0; they are community GGUFs of Qwen checkpoints,
not Qwen-published GGUFs. The exact converter input checkpoint revision is not
independently established. Models live in per-user app data, outside the app bundle.
The 41,641,440-byte E5 resource remains unchanged.

[Qwen 2B model card](https://huggingface.co/Qwen/Qwen3.5-2B),
[pinned 2B conversion](https://huggingface.co/lmstudio-community/Qwen3.5-2B-GGUF/blob/bb84e11355a036e28f080c7793fa6d22b7c4e344/Qwen3.5-2B-Q4_K_M.gguf),
[Qwen 4B model card](https://huggingface.co/Qwen/Qwen3.5-4B), and
[pinned 4B conversion](https://huggingface.co/lmstudio-community/Qwen3.5-4B-GGUF/blob/f9f88ac3e234be915e23811a6d28ea287bdb927e/Qwen3.5-4B-Q4_K_M.gguf).

The 2B template differs from the pinned 4B template only in the final default
thinking branch. Its initial load was rejected until its exact hash and
non-thinking text-only rendering were verified. Runtime accepts only these two
template hashes; it does not enable arbitrary tool templates.

One local generation host serializes all three roles and releases the previous
artifact before loading another. Four CPU threads, 128-token prefill batches,
disabled CPU mmap/mlock, and lazy loading/idle release remain in place. Both roles
use a 45-second cooperative deadline including queue time; failed or timed-out
generation returns source quotations only after fresh source verification. Native
model loading and an in-progress prefill/IO operation are not hard-interruptible,
so this is not a guaranteed 45-second wall-clock ceiling.

Import/organization accepts at most six original contiguous passages, 600 characters
each. Full-file revisions and exact excerpts are verified before and after native
generation. The native preview also derives the recorded speaker and timestamp
from those verified bytes. A turn date requires ordinal-aligned object metadata;
validated ISO document dates are labeled separately. A broken header/metadata
contract downgrades both speaker and date, including literal role-marker collisions
inside code examples. The saved quote layer applies the same conservative rule.
Identical excerpts in multiple turns have unknown
attribution rather than inheriting the first turn's speaker or time. These labels
remain source records, not proof that an assistant's reported outcome occurred.
The frontend also rechecks every source in the complete 48-chunk evidence
batch before saving its quotes. Receipt comments removed during normalization never
become invented contiguous inputs. Generated preview coverage is distinct from
complete quote coverage. Native code constructs citations; the model cannot choose
arbitrary paths, file operations, providers or tools. User Stop cancels its own
request and rejects late writes. Existing coverage receipts and conditional writes
remain authoritative for archive eligibility.
The post-import refresh and validation path also checks run ownership and the
current vault token after each await, so a reset, new run or vault reopening cannot
revive a superseded completed state.

These guards bind previews to checked source snapshots, bound their inputs/outputs
and restrict references. They
cannot prove that every generated sentence follows from its cited passages. Actual
Intel Mac/8 GB latency, memory pressure, long-corpus semantic quality and real-account
mobile connectors remain unverified by this synthetic development comparison.

## Validation and installed state

The final full frontend run passed 4,662 tests across 329 files, including 16
new post-import state-race and eight evidence-attribution cases. Typechecking
passed, and the final release app build completed. ESLint reported no errors
and two existing React hook
dependency warnings in `notchDriver.ts`. Rust formatting and all-target Clippy
with warnings denied passed; all-target tests passed 1,093 tests with 15 ignored.
The real 2B artifact/template guard was also run explicitly and passed. Doc tests
completed with no tests defined.

Synthetic browser checks passed 65 recall, 206 Ask synthesis, 380 dual-model
settings and 28 local import/Stop assertions. Recall, Ask and settings were checked
at 375, 768 and 1,280 pixels. These exercise the real React UI with synthetic IPC;
they are not native generation or private-vault end-to-end accuracy tests.

The new 0.4.0 app was installed at `/Applications/myco.app`, with the previous app
backed up before replacement. The installed executable SHA256 is
`3943392f4db6330541eecb3b27d5b9990729b28e9606e137ff645cb89bf84bc9`.
The launched native app showed both local artifacts installed and verified. Its
actual Settings UI was used to select `qwen3.5-2b-q4_k_m` for import/organization,
while Ask remained `qwen3.5-4b-q4_k_m`; both providers are `builtin-local`.
Settings-file readback confirmed those selections and an unchanged canonical hash
of every other preference. No private Ask question or vault switch was performed.
This installation targets the current Apple Silicon host; it is not an Intel
or universal distribution artifact.

No Developer ID Application identity was available: the signed-build identity
check failed. The subsequent explicitly ad-hoc local build and strict bundle
signature verification succeeded. This installation is not a notarized release;
permission persistence across ad-hoc rebuilds has not been established.
