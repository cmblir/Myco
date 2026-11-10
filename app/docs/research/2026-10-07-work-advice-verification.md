# Local work-advice verification — 2026-10-07

**Current installed result:** local Ask now has no automatic cutoff and shows
elapsed time, following the user's request after three installed 90-second
failures. Qwen 4B, source checks and generation bounds are unchanged. The new
bundle is installed and its main window is accessible, but macOS requested
Documents-folder access at launch and folder reads waited. The main window
initially disabled Ask during loading, then showed zero loaded notes although
Finder could open the existing folder. No answer from this installation has
been verified. The reported answer problem remains unresolved; successful
public controls do not establish successful installed generation.

The reported Korean question, **내가 앞으로 어떤 작업을 하는게 좋을까?**, used
wiki scope and the installed Qwen3.5-4B Q4_K_M. Its answer restated a PPT plan
instead of suggesting what to do, with an opaque source filename as the label.
This follow-up evaluates recommendation meaning separately from valid JSON and
citation syntax. It does not change retrieval scope, E5, the relevance floor,
source revision checks, model preferences or deletion policy.

## Reproduction and policy selection

The opt-in `local_ask_probe --bounded --recommendations-only` runs four synthetic
cases: an undated PPT plan, an explicitly prioritized unfinished PPT draft,
completed PPT work without a recorded follow-up, and generic presentation facts
without a personal goal. Expected criteria are evaluation metadata, not part of
the model prompt. No private note bodies are used in the fixtures.

The installed verified 4B weights run through the production native preparation,
192-token generation, 2,048-token context and answer validation. A fixed sampler
seed makes same-input comparisons reproducible. These are native Metal runs on
the current host, not mocks or Intel/8 GB certification.

The original fact-only policy accepted all four outputs structurally, yet none
provided a useful next-work recommendation. Completed-work evidence was also
strengthened from an absent follow-up record to an assertion that none existed.
Policy candidates were tested with identical evidence and source counts.

Candidate 3 preserved conditional advice, recorded priorities, completed work
and the distinction between unrecorded tasks and actual absence across the four
cases. Its priority answer still repeated a word and included body `S1`/`S2`
references. An additional wording-only candidate regressed the missing-record
distinction and was discarded; it was not installed.

Applying candidate 3 globally to the existing 17 fact/status cases accepted
17/17 structures but introduced semantic regressions: a request/proposal without
an outcome became unfinished work with unsolicited advice, resource usage became
large usage, and an optional export route became the only route. The original
policy did not introduce those claims in the same comparison. Therefore only
explicit direct next-work questions use the advice policy; factual queries,
historical recall, quoted questions and a follow-up's previous question retain
the original policy. Phrase recognition is deliberately bounded, not a general
intent classifier.

The selected Korean advice policy SHA256 is
`98169ff775154c3d9cd96d1b806873c60efbac2dcc755a6c50f8602794ca95ea`.
The factual policy file is byte-identical to the previous main version. Its
rendered SHA256 values remain:

- Korean: `b15a8ce6461aea8f8afc2b83280a4c944b25e19ee6a4ce1f3eb02f5d7514ebec`
- English: `c6f756375d583375e506f4f6e6fdeb5e903dd50f9c339cf0c7bfe2cb7768ef2a`
- Japanese: `99b90ac550f38169fcffe1ac05cfa40ee0fc352ccc11d3d23aee61e99333a281`

## Citation handling and regressions

Declared body source IDs are rendered as links to the same verified evidence
paths, including distinct sections of one page. Unknown or undeclared references
are rejected. IDs actually present as content in a source remain literal;
ASCII identifier boundaries preserve `AS1`, `S1_variant` and `XS10Y`. When a
product code and a model reference share the same token, literal preservation
wins; the formatter cannot determine that token's intended meaning.

A reviewer identified `[S1]` producing a nested link after replacing only its
inner ID. A failing regression reproduced it, then the renderer was changed to
consume the single-ID brackets. Frontend labels are normalized only after reply
validation, using the existing readable-name formatter and preserving full link
targets and history extraction.

Before implementation, Rust regression runs failed the routing/citation
assertions (11 passed/2 failed), then the additional natural-phrase and bracket
cases (12 passed/2 failed). The latter included:

```text
thread ... panicked at src/local_synthesis.rs:405:9:
assertion failed: answer.starts_with("根拠は[[wiki/a|Synthetic source]]です。")
error: test failed, to rerun pass --lib
```

Final source checks passed:

- `cargo fmt --check`
- `cargo clippy --all-targets -- -D warnings`
- `RUST_TEST_THREADS=1 cargo test --all-targets`: 1,109 passed, 15 ignored;
  includes Criterion smoke execution, not a performance comparison
- `npx tsc -b`
- `npx vitest run`: 331 suites, 4,727 tests passed
- `npm run lint`: no errors; two existing `notchDriver.ts` hook warnings
- `git diff --check`

## Final compiled recommendation run

The final release probe was built with `custom-protocol` and executed without a
policy override. All four recommendation outputs passed structural validation
and manual review of the core semantic criteria below. Raw model outputs,
selected passage counts and prompt token counts matched candidate 3 exactly.
All used the selected advice SHA256 above. Standalone generated body IDs were
rendered as verified links instead of leaking `S1`/`S2`.

| Synthetic case | Whole passages | Prompt tokens | Observed core meaning |
| --- | --- | --- | --- |
| Plan only | 1 | 932 | Conditional PPT-template first step and its recorded basis |
| Explicit priority | 2 | 995 | PPT draft before document cleanup, with recorded priority |
| Completed work | 1 | 947 | Completion preserved; unrecorded follow-up is not actual absence |
| Insufficient evidence | 1 | 939 | Personal plan/priority gap instead of invented work |

These four inputs establish this comparison, not semantic correctness on all
user notes. They use the same verified Qwen artifact and complete passages as
the baseline; source selection and relevance thresholds were not loosened.

The same final binary then ran all 17 existing fact/status cases without an
override and exited successfully. All 17 were structurally accepted; their
policy hashes, raw model outputs, prompt token counts and whole-passage counts
were identical to the original-policy baseline. Manual comparison found no new
semantic regression. The request/proposal case retained the unconfirmed-record
wording without an unfinished-work assertion or an unsolicited recommendation.
The conflicting-number case retained both reported sizes and rendered body
references as verified links. Existing qualifier/detail omissions remain.

The legacy cancellation check returned `local generation cancelled` approximately
3,991 ms after the signal. Its separate 256/4,096 path and host contention do not
certify the production Ask cancellation deadline. The evaluation process ended
before application packaging or installed-app inference was started.

Reproduce the opt-in recommendation evaluation with installed verified weights:

```sh
cd app/src-tauri
cargo run --release --features custom-protocol --example local_ask_probe -- --bounded --recommendations-only
```

## Remaining quality and measurement boundaries

Valid JSON and links do not establish semantic truth. Original-policy controls
still omit some qualifiers and secondary details, including support-target
wording and optional-weight/startup/idle distinctions. The selected advice
candidate can repeat words or combine its suggested step and basis into fewer
sentences than requested. Retrieval may also supply too little goal/status
context to recommend personal work; an embedding replacement alone does not
repair generation policy or missing records.

Earlier runs experienced substantial host contention during weight verification
and inference, so their timings are not a policy performance comparison. The
legacy cancellation probe uses 256 output tokens and a 4,096-token context and
does not measure the bounded Ask deadline. English/Japanese advice quality,
Intel/8 GB behavior, VoiceOver and 3G were not certified by these synthetic cases.

## Installed-app follow-up

The first replacement was built as a macOS app, installed with a retained bundle
backup and verified using strict code-signature checks. Its executable SHA256
was `af6bb321b39e2ddb798bc589b01283cd451ee6ce6a59d7ba9d1c9cf6e591629d`;
the bundle remained version 0.4.0 / `dev.cmblir.myco` with an ad-hoc local
signature. Bundled E5 remained byte-identical, SHA256
`bc06a6d33fc6a69f44168dbb4a3106b8350a7a2cef356b6b66fd81409437aa2b`.
The installed settings selected verified Qwen 4B for both Ask and import, with
wiki scope for this question; no model selections were changed.

The exact reported question initially stopped on source verification. Retry
returned source quotations rather than generated advice. A visible full reindex
completed for 837 pages, but another same-question attempt still returned quotes.
This did not pass the installed generation check. The old UI hid the native
fallback reason, so neither context overflow nor a timeout was established by
that observation alone.

The follow-up preserves quoted evidence while exposing bounded failure categories
and a same-question Retry. Native Ask now distinguishes model loading, prompt
preparation, decoding and answer validation. Source rejection still stops the
answer, cancellation still rejects late output and the native time budget stays
45 seconds. Only static codes enter the fallback callback; raw errors, source
bodies, paths and model output are not added to diagnostic logs. Quote-only
selection does not acquire a failed-generation notice. Source-list display names
also use the existing readable-name formatter without changing link identities.

Stage regressions first failed four expected static-code assertions, then all
15 native generation tests passed. The source-ladder regression failed on the
opaque visible name before the display fix and then passed. A dated Retry test
also reproduced a relative-period shift after midnight: an October 7 question
about yesterday retried on October 8 searched October 7. Retry now retains the
captured October 6 range; `ignoreRange` still takes precedence, while ordinary
questions continue parsing at question time.

Final diagnostic-source gates passed: 1,114 Rust tests with 15 ignored,
332 Vitest suites / 4,738 tests, TypeScript build, Clippy, format and diff checks.
ESLint reported no errors and the same two existing notch hook warnings. The
focused browser fixture checked 441 assertions with synthetic IPC across three
languages and 375/768/1280 px; the complete synthetic Ask smoke passed 518
assertions. The previous PageQuery in an isolated fixture
failed 168 expected notice/Retry/readable-name assertions. These fixtures do not
establish installed model inference, native VoiceOver behavior or device speed.

With a loopback Vite development server running, reproduce the focused UI check:

```sh
cd app
MYCO_TEST_URL=http://127.0.0.1:5173 node scripts/ask-local-synthesis-smoke.mjs --fallback
```

The diagnostic app build completed successfully (frontend 6.92 seconds, native
release 2 minutes 42 seconds). It replaced the first build only after normal
application shutdown, retaining another verified backup. The installed
executable SHA256 is
`ada7f735f4037dabb790c1cdcf548ba0096562f254b9873dfc5554ebc0048ee5`.
Strict signature, bundle ID/version and the unchanged E5 digest were checked
again. The main window reopened with verified Qwen 4B and wiki scope.

The exact question and Retry both stopped at source verification in that build.
A read-only local metadata audit then established a persistence-order defect:
replacing a page reuses free BM25 slots in reverse physical order, `encode`
stores physical order, and `decode` reconstructs `page_slots` in that order.
`page_hashes` returned this storage order, while source validation compares
against current chunks in section order. Individual section hashes remained
correct, but the complete hash arrays failed equality after reload.

| Real retrieved source | Current / BM25 / dense chunks | Matching individual hashes | Stored-order array matches | Section-order array matches |
| --- | --- | --- | --- | --- |
| Source 1 | 279 / 279 / 279 | 279 / 279 | No | Yes |
| Source 2 | 190 / 190 / 190 | 190 / 190 | No | Yes |

Both sources satisfied path, scope, file/read budgets and stable-read checks.
There were no missing or token-empty chunks. The audit used local parsing and
hash comparisons without model inference or file mutations; private bodies,
filenames and hash values were excluded from its output and these fixtures.

The correction sorts returned BM25 page hashes by section ID. It does not change
physical storage, index encoding, lexical score calculation, relevance floors,
model/policy selection, source verification or generation budgets. Restoring the
current-source check can legitimately affect hybrid deduplication that previously
treated those pages as stale; no bit-identical real-data ranking claim is made.
An existing index needs no schema migration or reindex for this correction.

A synthetic regression replaces two pages to recycle their slots, then checks
encode/decode and an actual save/load round trip. All individual hashes and
lexical ranking remained correct, but the original complete page array failed
with `page hash arrays must preserve section order after persistence`
(`retrieval.rs:1805`, exit 101). With the section-order correction, all 45
retrieval tests and 15 local generation/source-guard tests passed. The complete
native gate passed **1,115 tests, zero failures, 15 ignored**; Clippy with warnings
denied and format checks also passed. Frontend sources did not change after the
4,738-test and synthetic UI gates above.

The section-order build completed (frontend 8.12 seconds, native release
2 minutes 45 seconds) and was installed after normal shutdown at
2026-10-07 10:30:50 +09:00. Its executable SHA256 is
`aef01787326ed6a08d82a55f44e5bd0540f1bff15534f53e961ee79143edd958`.
Another verified backup was retained; signature, bundle identity/version and
unchanged bundled E5 were checked again. Startup's existing ingest finished
before the exact question was submitted with verified Qwen 4B and wiki scope.
Both the first attempt and same-question Retry passed source verification but
returned the visible validation-failure quotation fallback. This establishes
source-gate recovery, not successful installed advice generation.

An additional bounded reason distinguishes only `serde_json::Error::is_eof()`
as `answer_incomplete`. Syntax, schema, unknown/extra fields, empty abstentions
and all other output rejections remain `answer_rejected`. There is no parsing
recovery, output acceptance change or raw-output logging. The frontend displays
an incomplete-answer notice in English, Korean and Japanese and preserves Retry.
Native classification regressions failed two expected assertions before the
correction, then the focused local suite passed 75 tests with five ignored.
Callback regression and the nine language/viewport notice checks also failed
before correction. After correction, related frontend tests passed 146/146 and
the focused synthetic UI passed 75/75. TypeScript and ESLint passed, with the
same two existing lint warnings. The complete native gate passed 1,117 tests,
zero failures and 15 ignored; Clippy with warnings denied and format checks
passed. Actual failure classification still requires a real inference receipt.

A separate temporary synthesis-only probe received installed MCP recall metadata
for the same question, wiki scope and `k=12` hybrid search: two accepted chunks
from two pages, with cosine 0.42610 and 0.42411. It read complete current chunks
and checked confined paths, bounded reads and pre/post file revisions without
persisting or printing bodies, paths, hashes or generated text. The first debug
attempt was interrupted because uncached BM25 decoding did not reach generation.
The isolated follow-up omitted that cache reconstruction; its deadline starts
after source/artifact preparation, so it does not prove full native Ask or its
45-second end-to-end budget.

With the unchanged policy, Qwen 4B selected both chunks in 1,488 prompt tokens
and returned complete JSON: 373 bytes / 213 characters, an answer of 183
characters and one source ID. Native validation rejected the evidence-reference
group rather than EOF. Source parsing took 57 ms; the debug artifact checksum
took 96,636 ms, loading 10,886 ms and isolated generation 14,681 ms. These debug
numbers are not installed-app latency measurements.

A shorter, prose-only candidate policy was tested without changing production.
All four synthetic outputs passed structural validation, but three failed the
core meaning check: the priority answer suggested waiting for completion instead
of starting the priority task, the completed-work answer invented little remaining
work, and the missing-goal answer did not ask the required focused question.
The candidate was discarded; the original advice and factual policies remain.

A subsequent isolated attempt with more specific static rejection categories
hit the unchanged 45-second generation deadline. It did not establish which
body-markup condition caused the earlier complete JSON rejection. The earlier
receipt establishes only the evidence-reference rejection group; a verified-body
link correction must therefore be assessed separately with synthetic regressions
and installed-app inference. No private model output was persisted or printed.

Synthetic regressions then established that declared, verified body wikilinks
were rejected by the blanket `[[` check. Three positive regressions failed while
the original unknown/malformed/HTML/Markdown negatives continued to be rejected.
The correction resolves reserved source IDs first, then exact selected page
paths (with or without `.md`), then stems unique across all selected pages; the
resolved page must also be declared in the output's `sources`. Model labels are
discarded in favor of trusted native labels, and canonical links are not fed
back into the plain source-ID renderer.

Independent review found namespace collisions and markup wrappers in the first
candidate. Three added regressions failed before ID/path precedence and wrapper
rejection were corrected. Raw link labels also cannot satisfy Korean/Japanese
language or question-echo checks: the original checks remain, and the plain prose
is checked separately. Links with unknown, undeclared or ambiguous targets,
nested/unfinished delimiters, embed/escape/reference wrappers and other blocked
markup remain rejected. The advice and factual policies, model, sampler,
192-token output, 2,048-token context, 45-second deadline, relevance floor and
full before/after source verification remain unchanged.

A further English link-only regression failed before meaningful plain prose was
required for the new wikilink path. Bare, alias-only and punctuation-only bodies
are rejected; ordinary English prose and the existing plain source-ID path are
preserved. The focused synthesis suite passed 24/24 and generation/source guards
passed 16/16. An independent read-only review found no remaining bypass in these
boundaries.

The first full native run failed one unrelated web redirect assertion:
`web_fetch.rs:646`, `fetch_via(.../h1).await.is_ok()` (1,097 passed, one failed,
11 ignored in the library). It passed unchanged when run alone in 2.92 seconds;
the initial failure's cause was not established. The complete all-target rerun
with `RUST_TEST_THREADS=2` passed **1,126 tests, zero failures, 15 ignored** and
its benchmark checks. No test, network guard or timeout was weakened.
Clippy on all targets with warnings denied, formatting and diff checks passed.
Frontend code did not change after the 4,739-test and 75/75 focused synthetic
incomplete-answer UI gates recorded above.

The corrected build completed (frontend 30.26 seconds, native release
4 minutes 31 seconds) and was installed after normal application shutdown at
2026-10-07 12:14:28 +09:00. Its executable SHA256 is
`f155b902e829f7b5566097f935a04e8003a568d3a361ff731a5939bff2819f05`.
The prior app was retained in a verified backup. Strict ad-hoc signature,
bundle ID/version, correction markers and the unchanged bundled E5 digest were
checked before and after replacement. The local build intentionally skipped
notarization without credentials; the Developer ID signing guard was unchanged.

After launch, the computer-use service initially returned `cgWindowNotFound`
for both myco and Finder. Resetting that service session restored access; the
native Window menu brought the main window forward. Startup background
indexing/rollups were still active, so installed inference was held until that
work settled. Synthetic/native passing results alone do not establish that
the exact real question produces a generated advice answer.

After startup's ingest/indexing settled, the main-window question was pasted
and verified exactly, then submitted with Qwen 4B and wiki scope. It still
returned the validation-failure quotation fallback with two readable source
labels; no generated-answer badge appeared. This installed result does not
establish successful advice generation after the body-link correction.

The same privacy-preserving isolated probe was rebuilt against the corrected
validator. A first attempt reached the 45-second generation deadline. A warm
attempt returned complete JSON in 34,439 ms: the same 1,488 prompt tokens,
373 bytes / 213 characters, 183 answer characters and one declared source.
Static classification narrowed the rejection to angle brackets (`<` / `>`),
not the newly supported verified wikilinks or EOF. Some further attempts reached
the unchanged generation deadline. Warm complete attempts consistently returned
the same byte/character counts. A static-only shape diagnostic found one paired
ASCII identifier, with no closing tag or match in the public tag vocabulary;
arrows and declared source-ID notation were excluded. Its private contents
were not emitted. These debug probe timings still do not certify the full
native command's latency.

## Prevent rejected markup during generation

The decoder's JSON grammar previously allowed literal `<` and `>` in the
answer, although the independent validator rejected both. The minimum fix
excludes those two characters from the answer's negated character class during
sampling. It does not accept or strip arbitrary HTML or placeholder labels.
Policies, source checks, seed and other sampler settings, context and output
limits, and the native 45-second deadline remain unchanged. This bounded JSON
decoder also serves local import/organization previews; legacy free-form
generation is unchanged.

The pinned `llama-cpp-2` 0.1.150 runtime masks any candidate token piece
that conflicts with the grammar. An actual-vocabulary, no-inference regression
first failed because `<` remained a finite-logit candidate. With the corrected
grammar it passes: `<`, `>`, `<br>` and a synthetic placeholder are blocked,
while ordinary Korean/ASCII text, bracketed text and JSON escapes/closure remain
available. JSON Unicode escapes can still spell those characters, so additional
validator cases explicitly retain rejection after `\u003c`/`\u003e` decoding.

The same RAM-only private probe then returned complete JSON in 31,878 ms with
1,488 prompt tokens, two whole passages/pages, 179 answer characters and one
declared source. Validation passed and neither angle character remained. Raw
source/generated text was neither printed nor saved; only bounded counts and
static diagnostics were emitted. This is source-isolated validation evidence,
not yet the installed main-window answer or a review of its generated meaning.

Formatting, Clippy with warnings denied and all native targets passed again:
1,126 tests passed, zero failed, 15 ignored. The actual-vocabulary ignored
template/grammar test was also explicitly run and passed. Two independent
read-only reviews found no new validation bypass or unrelated source changes.

The public recommendation comparison after the grammar change passes 4/4:
raw outputs, policy SHA256 values, prompt tokens and whole-passage counts are
identical to the prior compiled recommendation run. The new evaluation uses
a debug example with a temporary `profile.dev.package.sha2.opt-level=3` Cargo
configuration, solely to avoid debug-speed hashing of the verified 4B artifact.
No manifest or lockfile changed and the complete digest check remains active.
The first unoptimized attempt was stopped with exit 143 before any model case
result, so it supplies no passing evidence. These runs compare output meaning
and structure, not production performance.

The 17 factual/status controls also completed successfully. Accepted status,
raw outputs, rendered answers, factual-policy SHA256 values, prompt tokens and
selected passage counts are identical to the prior 17-case run. No new raw
meaning regression was observed. Previously recorded qualifier/detail omissions
remain; structural acceptance is not full semantic completeness. The separate
legacy-path cancellation check returned `local generation cancelled` 2,127 ms
after the signal and does not certify production Ask's cancellation latency.
The installed application still requires final verification.

The final current-source bundle built successfully and was installed at
2026-10-07 13:50:38 +09:00. The executable SHA256 is
`1bd4810479bd4ad45ff5a5bd86b7f34ace931eeeba24c6771fa587a00b9bfac6`.
The prior bundle was backed up, and strict ad-hoc signature, identity, correction
markers and unchanged bundled E5 were checked before and after replacement.
The first preflight stopped before replacement over a mistaken requirement to
bundle four unused preparation-master images; production consumer review
resolved that distinction while retaining checks for every used mascot asset.
The main window launched successfully. Startup's normal ingestion completed
before the exact question was entered and submitted with the saved wiki picker
and Qwen 4B selection. The picker alone does not certify the effective native
scope: existing personal-memory routing can expand an unconfirmed saved scope.

The first main-window attempt reached the unchanged native generation
deadline and displayed the explicit timeout explanation with two readable
quotation sources. This does not establish successful installed generation.
The built-in fresh-search Retry was then used for the same exact question and
scope after that initial model load.

The warm Retry also reached the native deadline. A subsequent profiling attempt
returned the same timeout; that third run is diagnostic only because profiling
can affect execution. None of these three installed attempts establishes a
generated answer. Targeted process checks found no `MYCO_EVAL_CPU`, policy
override or evaluation-comparison environment override. The release native
cache has Metal enabled and matches the debug probe's relevant backend flags.
The OS sampler produced a native stack report (no note/generated-body dump),
but stripped application symbols did not identify the failing stage. It is not
used as latency or successful-generation evidence.

Code review confirms that the production 45-second budget at that baseline
covers task queueing, source admission, model preparation, prompt preparation,
generation and the full post-generation source check. The private helper's
31,878 ms begins after source audit, artifact verification, loading and prompt
preparation, and includes
generation, its file-revision check and response validation. BM25 loading and
frontend model status are before the production timer. A warm model and valid
artifact metadata cache should skip reloading/rehashing, so cold overhead alone
does not explain the repeat. Bounded stage measurements are required before
selecting any performance change; no deadline or source guard was relaxed.
Read-only retrieval review found that MCP `recall(limit=6)` and production Ask
both search with hybrid `k=12`; the MCP truncation would not remove anything
from a two-hit result. The UI's one collapsed quotation refers to a page row,
not proof of another section. Matching page labels do not prove identical hit
arrays. A diagnostic control must explicitly select wiki and compare prompt
token counts rather than assume the saved picker establishes equivalence.

## Bounded installed-stage measurement

A temporary diagnostic build was installed at 2026-10-07 14:21:47 +09:00.
It recorded only static stage names, elapsed milliseconds and token counts;
no question, source contents, generated answer, paths or identifiers were
written. The main-window control explicitly selected the wiki scope and
submitted the exact question after startup ingestion completed. Requests ran
one at a time. Both the initial attempt and its warm Retry timed out.

| Stage | Initial attempt | Warm Retry |
| --- | ---: | ---: |
| Source admission | 622 ms | 20 ms |
| Model lock acquired | 629 ms | 23 ms |
| Chat model ready | 29,605 ms | 23 ms |
| Generation context ready | 29,825 ms | 345 ms |
| Prompt prefill submission boundary | Not reached | 31,643 ms, 1,488 tokens |
| First 20 generated tokens | Not reached | 38,699 ms |
| Worker finished, timeout | 50,813 ms | 45,162 ms |

Times are cumulative from production synthesis entry, not from the UI submit.
Cancellation is cooperative between native batches, so the initial worker's
completion after 45 seconds does not indicate a changed deadline. The warm
prompt token count matches the isolated helper, but counts alone do not prove
byte-identical inputs. The warm prefill submission boundary took about 31.3
seconds; the next 20 tokens took about 7.1 seconds. Native decode can enqueue
GPU work, and sampling can wait for its completion; the final prefill work may
therefore finish in that first sampling interval. These measurements are not
pure GPU prefill time or a steady-state token-rate benchmark. Admission,
artifact verification and model-lock waiting do not explain this warm failure.
The first UI search also took much
longer than synthesis entry; these stage measurements do not identify that
separate delay.

The machine had substantial wired and compressed memory and other running
applications. This is observed context, not proof of a causal explanation.
No other applications were stopped and no OS setting was changed. The
diagnostic source changes were restored byte-for-byte to the tested Git HEAD.
At 14:28:54 +09:00 the verified production bundle with executable SHA256
`1bd4810479bd4ad45ff5a5bd86b7f34ace931eeeba24c6771fa587a00b9bfac6`
was restored from the pre-diagnostic backup. Strict signature, identity,
used mascot assets and unchanged E5 were rechecked; the installed executable
does not contain the temporary recorder marker.

Bounded metadata receipts:

- `/tmp/myco-20261007-local-stages-cold-wiki.json`
- `/tmp/myco-20261007-local-stages-warm-wiki.json`
- `/tmp/myco-20261007-stage-diag-restore.json`

## Rejected batch-size change and selected deadline

A separate temporary public harness compared 128- and 256-token batches using
the same copied generation implementation, model, policy, seed, complete
synthetic passages and 192/2048 output/context bounds. The project native
sources were not changed for this comparison. First-sample timing includes the
last GPU prefill wait without adding an extra synchronization or sampling step.

The corrected 128 control accepted the same 1,455-token, two-passage case on
all three runs (40.07/43.57/40.19 seconds). Its first-sample boundary was
16.47/23.47/17.19 seconds. The 256 candidate timed out on all three runs
(45.10/48.11/45.17 seconds), with first-sample boundaries of
27.29/47.99/22.51 seconds. Peak RSS was 2.846 GiB and 2.840 GiB respectively.
Paging and host load varied; this does not isolate batch size as the cause of
the slowdown. It establishes no usable improvement on this host, so 256 was
rejected and the production chunk size remains 128.

The initial 128 advice cases retained all four prior raw outputs, policies,
prompt counts and selected-chunk counts. A corrected cancellation test signaled
100 ms after the first prefill dispatch, returned 4.311 seconds after that
signal and successfully generated the next request. An earlier context-only
cancellation measurement is not used as prefill cancellation evidence. After
the 256 failures, the temporary harness was terminated with native exit -15;
this is not a successful test run. Its advice, factual controls and actual
prefill cancellation/recovery were not completed, and 512 was not evaluated.
No 8 GB or installed-app performance guarantee follows from these controls.

The comparison receipt is `/tmp/myco-20261007-prefill-comparison.json`.
No candidate sampler, policy, model, dependency or batch-size change shipped.

The user then explicitly selected retaining Qwen 4B quality and extending its
Ask synthesis deadline from 45 to 90 seconds. The private timer accepts the
selected duration: 4B Ask uses 90 seconds, 2B Ask and transform previews retain
45 seconds. Registry, cancellation flags, timer abortion, source admission,
complete file-revision checks, active-vault checks and the output validator are
unchanged. The timer still includes model preparation and post-generation
checks; preceding search and artifact-status checks remain outside it.
Formatting, Clippy on all targets with warnings denied, and all native targets
passed after the duration-only change: 1,126 tests passed, 15 intentionally
ignored, zero failed. An independent read-only review confirmed the 4B-only
selection and unchanged source/Stop ordering. Frontend's separate 30-second
model-status timer is cleared before generation; it has no 45-second synthesis
cancellation timer. The existing public 21-case model controls remain applicable
to the unchanged generation implementation, but are not used as installed
latency evidence.

The frontend build passed in 18.11 seconds and the release native build in
4 minutes 16 seconds. After successful build exit and normal app shutdown,
the 90-second bundle was installed at 2026-10-07 15:09:25 +09:00. Its executable
SHA256 is
`909015ec1c9632f9a11f7e2238cc89cc8a840e5b840b6b21f1f2d1fecf2f11a2`.
The previous tested bundle remains in
`~/Library/Application Support/myco-install-backups/20261007-150923/myco.app`.
Strict ad-hoc signature, bundle identity, all 23 used mascot assets, four
preparation-master digests, correction markers, absent temporary recorder and
unchanged E5 were verified. The installer was independently reviewed before
execution. The receipt is `/tmp/myco-20261007-90s-install.json`.

The installed process started from `/Applications/myco.app`, but the native
screen tool initially returned `cgWindowNotFound` for both myco and Finder.
Resetting the tool runtime and restarting only its identified Codex helper did
not immediately restore window access. Access later recovered, and the user
confirmed bringing the new main window forward. These observations do not
establish the cause of the earlier access failure. No OS security setting was
changed.

## Installed 90-second main-window result

The native main window showed the selected Qwen 4B artifact as ready. After
startup ingestion, rollup and indexing completed, the control explicitly
selected **My notes** and entered the exact reported Korean question. The
question and scope were checked before submission. The first request and its
fresh-search Retry ran sequentially; no probe or build ran concurrently.

Both requests reached the native time-budget fallback. The first displayed
indexing activity again while Ask was running; the warm Retry displayed only
Ask activity. Absence of another visible activity is not proof that every
background worker was idle. The initial request was still active at the
89-second observation and had returned by the 136-second observation. The warm
Retry was active at 93 seconds and had returned by 112 seconds. These are UI
observation bounds, including tool delays, not exact generation durations. The
90-second native budget excludes preceding search/status work and cooperative
GPU cancellation can return after its expiry.

The UI explicitly explained that the local answer was not ready in time and
that the displayed passages were unchanged source quotations. It offered
Retry, used readable source labels and showed two quotation sources. It did
not present those excerpts as a generated recommendation. No generated answer,
generated model badge or generated body citation was observed, so this run
does not verify their semantics or rendering on the installed app.

A third Retry was observed with two bounded native stack samples, each three
seconds at a ten-millisecond interval. It also reached the timeout fallback;
profiling overhead prevents using it as an independent latency control. Raw
profiles were captured through `/dev/stdout` into RAM and discarded. Only
static known symbol names, sample counts and execution metadata were retained.
The second sample contained 242 samples at
`-[_MTLCommandBuffer waitUntilCompleted]`. Application symbols were stripped,
so this identifies a sampled GPU wait, not its owning inference role or the
cause of the slowdown. It does not establish a grammar, queueing, indexing or
memory-pressure bottleneck.

The installed process had approximately 2.70 GiB RSS during the warm request.
The host reported approximately 6.32 GiB wired memory and 4.03 GiB occupied by
the compressor at that observation. These are host conditions, not a causal
measurement. A process-environment check retained only boolean results:
`MYCO_EVAL_CPU` and `GGML_METAL_DISABLE` were absent. Other applications and
system settings were not changed. No deadline, model, sampler, prompt or source
guard change followed these failures.

Bounded receipts:

- `/tmp/myco-20261007-90s-main-window.json`
- `/tmp/myco-20261007-90s-profile-1.json`
- `/tmp/myco-20261007-90s-profile-2.json`

The selected 90-second change is installed and passes its source gates, but it
has not resolved the reported installed generation failure. Diagnosis still
needs a measured installed inference stage or a controlled host comparison;
isolated successful controls and visible GPU waiting do not supply that proof.
Private notes, answers and screenshots were not saved as diagnostic artifacts.

## User-selected unbounded Ask

The user subsequently requested removal of the maximum time or an average
completion time. The selected implementation removes the native Ask timer for
both local chat models and the frontend's separate 30-second artifact-status
cutoff. The page displays actual elapsed time beside the active retrieval or
generation status. It does not invent an average or a remaining-time estimate.
Import/transform previews retain their 45-second generation budget.

Manual Stop still ends the frontend wait, cancels the exact native request when
generation has started, and prevents a late status result or answer from being
adopted. Model readiness, complete source-revision checks before and after
generation, active-vault checks, declared-citation validation and the unchanged
192/2,048 output/context bounds remain in place. Removal of a time cutoff does
not guarantee that every generated answer passes those checks.

The old status cutoff failed the new long-wait and late-readiness cancellation
regressions. Missing elapsed rendering failed four new page checks before
implementation. The final targeted frontend runs passed 146/146 tests across
query synthesis, query lifecycle and the page. The page checks cover English,
Korean and Japanese, one active elapsed indicator, an enabled semantic Stop
button and immediate removal of elapsed status after Stop. Their IPC mocks and
server rendering establish those frontend boundaries, not native-window QA.
Type checking, scoped ESLint, native formatting and Clippy with warnings denied
passed. The resumed all-native-targets run passed 1,126 tests, with 15 ignored
and zero failures. No dependency, sampler, model or batch-size change shipped.

The macOS bundle build exited successfully at 2026-10-07 17:25:30 +09:00 after
167.6 seconds; its frontend build completed in 6.22 seconds. The receipt binds
the build to 14 source digests, including both generation policies and package
lockfiles. After normal app shutdown, installation completed at
2026-10-07 17:28:43 +09:00. The executable SHA256 is
`14e06abbc49915122d8ea777f72aff4d6de050ed3b515694c42e1cb1cc450daa`.
Strict signature validity, actual ad-hoc signature type, bundle identity, all
23 used mascot assets, four preparation masters, unchanged E5 and absence of
the temporary recorder were verified. The previous 90-second app remains in
`~/Library/Application Support/myco-install-backups/20261007-172843/myco.app`.

The native main window showed Qwen 4B ready, but initially displayed vault
loading with disabled Ask controls. Bounded stack samples found directory-open
waits. An independent directory-listing probe also waited beyond its three-second
probe limit, while directory metadata returned immediately. Finder opened the
same folder successfully. The macOS privacy log recorded a myco
`AUTHREQ_PROMPTING` event for `kTCCServiceSystemPolicyDocumentsFolder` at
17:28:50 +09:00. A later observation showed enabled Ask input with zero loaded
notes, while the directory-listing probe still waited. The existing notes were
not shown as loaded and no Ask was submitted against that incomplete state.
This establishes a launch-time access prompt and failed access to existing
content; it does not establish an answer-generation failure in this installation.

The screen tool refused access to the system permission application with
`Computer Use is not allowed to use the app 'com.apple.UserNotificationCenter'
for safety reasons.` No permission or OS security setting was changed. The
user was asked to allow the displayed myco Documents-folder request. Until
folder access completes, the installed elapsed display, manual Stop and actual
recommendation body remain unverified. No average latency is reported from the
earlier timeouts or from this blocked launch.

Persistent local receipts are stored under
`~/Library/Caches/myco-development/2026-10-07-ask-completion/`:
`native-tests.json`, `build.json`, `installation.json` and `main-window.json`.
Earlier `/tmp` receipts in this report are historical and may no longer exist
after the interrupted turn. No private note, answer or screenshot was saved.
