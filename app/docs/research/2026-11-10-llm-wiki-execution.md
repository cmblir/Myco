# LLM Wiki execution record

Baseline: `121c0fa2`. Execution started 2026-11-10 with the
[goal contract](../specs/2026-11-10-llm-wiki-goal.md); implementation is in progress.
The [acceptance cases](2026-11-10-llm-wiki-acceptance.md) are frozen development
requirements and must not be mistaken for passing results.

## Package status

| Package | State | Evidence and remaining work |
| --- | --- | --- |
| G0 acceptance/runtime | Baseline recorded; quality failed | Corpus and supplemental cases frozen. Actual offline 4B native compiler witness failed; raw outputs retained below. A recorded failure establishes the baseline, not product acceptance. |
| G1 Ingest drafts | Bundled macOS D1/D2/D4 passed; D3 partial | Navigation/restart, vault isolation and injected write-failure recovery passed through the fixed sandbox launcher. D3 current-revision success/failure retention and early cancellation passed; older-success/newer-draft race, later-stage cancellation, other platforms and signed-release acceptance remain open. Earlier contaminated results remain withdrawn. |
| G2 Ask contract | Implemented; native acceptance pending | Explicit scope/selected-note and date-follow-up contracts tested. README distinguishes existing selected-note scope from the absent general document selector. |
| G3 Windows | Partial; Windows unverified | Portable relative-path changes passed macOS library tests. Windows handle identity, custody, durable publication and Windows execution remain. |
| G4 project state | Opaque identity repair and v6 malformed-cwd migration; acceptance incomplete | Project routing retains explicit paths, period and coverage. Opaque recorded-cwd identities replace basename collisions; immutable-source migration preserves human pages. Verified repository equivalence and W1–W4 actual-model meaning remain incomplete. |
| G5 maps | Native refresh and latest History view implemented; recovery incomplete | Private ownership, source/revision checks, manual/approved automatic refresh and before/after observation readback are implemented. Incomplete-attempt repair/recovery, undo, full timeline and actual-model meaning remain; external editors are not atomically excluded. |
| G6 UI | Native Graph label repair verified in one dark viewport | Compact Home, consolidated Ask examples, vault-bound import review and 800px Graph panel repair implemented. Native Graph rail persistence and Reader navigation passed; label bounds and opaque backing passed the 1280px dark macOS replay. Other widths/themes and full accessibility/state/translation review remain. |
| G7 release acceptance | In progress; full model case failed | Final frontend/default and feature-native suites, example tests and strict Clippy passed. Structure-only A/B passed its limited contract; the full v9 model witness remained partial. Installed/Windows and repeated semantic acceptance remain unverified. |

## November 11: repeated candidate still fails fresh withdrawal answers

The [27-call stability receipt](2026-11-11-selected-note-stability-review.json)
repeats the unchanged coverage candidate three times. All 15 constructed binary
controls match their frozen labels. Fresh supported answers pass in all three
runs; fresh withdrawal answers fail in all three. Writer and reviewer outputs
are identical across repetitions with seed 42. This establishes reproducibility
for these inputs, not independent statistical evidence or broader quality.

The fresh withdrawal answer correctly denies the current links but omits the
frozen requirement to explain their withdrawal and the obsolete earlier
description. Separately, the reviewer incorrectly labels this supported current
negation unsupported. Missing explanatory coverage does not justify that factual
verdict. Gold requirements remain unchanged. The reviewer reason is capped at
128 characters by the grammar; its ending is not evidence of output-token
exhaustion. No production candidate is promoted.

The harness retains all prompts, raw outputs, telemetry, model/binary hashes and
sampling settings. A model-free regression proves its positive review input is
byte-identical to the prior candidate input. Source binding uses the shared native
algorithm with synthetic helper authority, not installed-app authorization.
Next freeze contrasts between brief current negation, explicit withdrawal
explanation and obsolete positive claims before changing production behavior.

Verification: 24 ordinary-flow tests passed, five model tests ignored in that
invocation. The explicit actual-model run completed 27 calls and exited zero;
this transport success is not semantic acceptance. Rust fmt and feature-enabled
strict all-target Clippy passed. Runtime was 673.622 seconds with maximum RSS
3,166,257,152 bytes; startup overlapped Clippy, so these are observations rather
than a clean benchmark. Network denial was verified and the owned process
stopped. No production code, frontend or README changes were needed. G2/G7 and
the overall goal remain incomplete.

## November 11: explicit coverage guidance passes the first five binary controls

Frozen [coverage controls](2026-11-11-selected-note-coverage-controls.json) retain
the four prior cases unchanged and add an explicit withdrawal at the end of a
separately revised synthetic center source. Its answer repeats the obsolete
relationship and must be rejected. A regression proves the complete correction
reaches review and that the existing cases/labels are unchanged. No fixture file
or live raw source is modified by the experiment.

Both comparison arms now use the same grouped-original representation. The
candidate alone defines coverage as retaining important question-relevant facts
and qualifications, requires inspecting uncited originals/corrections, and
specifies original turn `id` rather than source/citation IDs for missing spans.
It explicitly refuses to infer covered from packet completeness or an empty
missing-ID list. Verdict validation and all production gates remain unchanged.

The [actual ten-call receipt](2026-11-11-selected-note-coverage-review.json) shows
the candidate accepting the supported answer and rejecting all four negatives,
including the withdrawn relationship: 5/5 binary controls versus 4/5 for grouped
baseline, which still rejects the positive. Candidate span IDs are valid; none
of its rejections depend on malformed-ID refusal. This is initial diagnostic
success only. The partial-answer case still mislabels its supported partial fact
as unsupported, and each case ran only once. Constructed drafts do not prove
fresh generation, native authority or installed-app acceptance. No production
prompt, representation, grammar or model was promoted. Next repeat critical
positive/withdrawal/unsupported cases and extend source-shape coverage before
testing fresh generated answers with the candidate.

Verification: 23 ordinary-flow tests passed, four model tests ignored in that
invocation; explicit inference separately ran ten reviewer calls and exited
zero. Rust fmt passed. Initial strict Clippy found a redundant String conversion
in the new fixture helper; removing it restored a strict feature-enabled
all-target pass. The running inference binary predates only that identity
conversion cleanup; its hash is recorded. Startup overlapped Clippy, so receipt
runtime/RSS are observations rather than clean performance benchmarks. Network
denial was checked, the exact owned model process stopped, and README was
unchanged. Logs use `/tmp/myco-review-coverage-*`. G2/G7 are still incomplete.

## November 11: grouped originals repair positive disposition, not coverage

Reused the existing lossless `SourceDocumentGroupsQaV1` diagnostic presentation
for the same four frozen reviewer controls. The comparison harness now accepts
an explicit QA projection and counts the actual projected input before serving;
the prior citation-guidance experiment remains separately selectable. No
production representation, prompt, grammar or acceptance gate changed.

A new regression applies the grouping to the preceding actual reviewer input
and reverses it, proving exact equality of every original and non-original
field, with all three documents retained. Existing codec tests also passed.
The [actual comparison](2026-11-11-selected-note-grouped-review.json) recorded
eight reviewer calls with fixed constructed drafts. Baseline still rejects the
positive as unsupported. Grouped input changes its verdict to supported and
adequate, but leaves source coverage uncertain, so native processing correctly
returns `review_uncertain` rather than an accepted answer. This is narrower
diagnostic progress, not positive-case acceptance.

All three negative controls remain rejected. However, grouped North/partial
answers emit `S-selected-2` in `missingSpanIds`, which requires a `Q-selected-*`
span ID. They fail `review_invalid`, not an accepted semantic review. The
cross-link case returns unsupported and is rejected normally. Candidate
promotion remains disallowed. Next isolate coverage interpretation and ID
selection using full-packet and omitted-contrary-source controls; do not assume
covered merely because the input codec is lossless or missingSpanIds is empty.

Validation: 22 ordinary-flow tests passed, three model tests ignored in that
model-free invocation; eight codec tests, Rust fmt and strict feature-enabled
all-target Clippy passed. The separate model test ran eight actual calls and
exited zero. Runtime including preparation was 329.553 seconds, maximum RSS
3,178,053,632 bytes; Clippy overlapped startup, so this is not a clean benchmark.
Socket denial was verified in the isolated sandbox, and the exact owned model
process is absent after normal completion. README was unchanged; no new native
app, frontend or release acceptance is claimed. Logs use the
`/tmp/myco-review-grouped-*` prefix. G2/G7 remain incomplete.

## November 11: citation-mapping guidance does not repair answer review

Added an opt-in paired reviewer experiment with one supported answer and three
constructed negative answers: an invented North link, omission of the required
West link, and an invented East↔West link. Only reviewer responses use actual
inference; drafted answers are deliberately fixed controls. The candidate adds
generic guidance to join citation IDs to original paths, distinguish ID
namespaces, interpret explicit wikilinks and check complete question coverage.
The original source/question bytes, model, sampler, grammar and acceptance gate
remain unchanged. Neither gold labels nor case-specific answers enter guidance.

The [initial run](2026-11-11-selected-note-review-comparison.json) is retained as
incomplete: both positive arms falsely rejected the answer, but English negative
answers failed Korean-language validation before review. Its eight-call assertion
failed (exit 101; two actual reviews). This was a fixture error, not successful
negative semantic testing. [Revised controls](2026-11-11-selected-note-review-controls-v2.json)
translate only negative answer prose while preserving labels and relationships.
A model-free regression now proves all four controls reach the reviewer.

The [complete rerun](2026-11-11-selected-note-review-comparison-v2.json) recorded
eight actual reviews and exited zero. Both baseline and candidate rejected all
three negative controls, but both also rejected the supported answer. The
candidate therefore provides no positive-case improvement and was not promoted.
Some coverage/disposition fields and reasons remain inaccurate even when the
binary rejection is appropriate. Safe refusal of every case is not useful
grounded synthesis and does not pass G2/G7. This was one call per arm/case, not
three-repeat release acceptance.

An additional audit found the preceding replay's unfinished reason is exactly
128 characters, the current grammar's maximum. Its ending alone is not evidence
of spontaneous premature termination; the earlier receipt now records that
limit. The production grammar was not changed. Next compare original-source
representations under these same positive/negative controls, keeping every
original and native rejection condition intact.

Verification: ordinary-flow tests passed 16 with two opt-in model tests ignored;
the explicit reviewer rerun separately completed eight calls. Rust fmt and strict
all-target Clippy passed. Both model processes stopped. Initial socket denial was
verified, and the rerun used the identical sandbox profile with a fresh writable
temporary directory. Full runtime/RSS and raw responses remain in the receipts;
Clippy overlapped part of rerun startup, so these are not clean performance
benchmarks. README and production behavior were unchanged.

## November 11: actual-model replay isolates a false-negative answer review

The [selected-note controls](2026-11-11-selected-note-controls.json) freeze the
same question and all three allowed synthetic notes from the preceding native
probe. A new ignored test runs the production ordinary draft/review algorithm
with the pinned cached 4B model, retaining both full prompts, raw responses and
decoder telemetry. It uses a synthetic helper role/context, not an authenticated
Wry command. Fixed all-note ordering and complete Markdown are explicit replay
choices: the earlier app's exact selected-hit packet was not captured.

The draft correctly said that Synthetic Graph Center links to Synthetic Graph
East and Synthetic Graph West, citing S1 (the center note). The separate reviewer
returned `answerDisposition=unsupported`, `taskResponse=adequate`,
`sourceCoverage=uncertain`, no missing span IDs, and a reason ending “The source
S1”. This is a false-negative review for the supplied originals. The shared flow
retained `review_rejected`; no production prompt, verdict gate or model changed.
Both calls ended at EOG, not their 768-token output limits. This explains a
failure in the controlled replay, not conclusively the earlier hidden app output.

[Full replay receipt](2026-11-11-selected-note-model-replay.json) retains both
calls. Draft/review measured generation times were 14.886/17.622 seconds. Total
runtime was 215.156 seconds, including artifact SHA-256 verification/loading;
a startup process sample confirmed hashing. `/usr/bin/time -l` reported maximum
RSS 3,166,568,448 bytes. Network denial was verified by a blocked socket attempt.
Only the new temporary runtime was writable; production app data and vendor
stores were denied. The owned model host and process stopped normally.

The model-free original/path test passed, and the ordinary-flow group passed
15 tests with this opt-in model test ignored; its separate actual invocation ran
two calls and exited zero. That exit proves observation transport, not semantic
acceptance. Rust fmt and strict all-target Clippy passed. No frontend, README or
production behavior changed. Next compare
reviewer representation/guidance against the frozen positive and unsupported
answer controls, retaining both false positives and false negatives before any
promotion. G2/G7 remain incomplete.

## November 11: native selected-note Ask reaches inference but fails review

Rebuilt the isolated macOS acceptance app from `54d60c5e` with
`native-app-acceptance`, offline/locked dependencies and the existing distinct
bundle identifier. Restored its checksum-bound sandbox launcher before launch;
the bare binary still refused startup without diagnostic isolation. The network
and protected-directory deny rules were unchanged.

The Reader's “Ask this note” action opened Ask with the selected synthetic graph
center and the disclosed selected-note/direct-neighbor scope. The first question
returned explicit absence because this isolated vault had zero indexed pages;
the UI recorded no generation. Settings → AI → Reindex now then successfully
indexed all eight synthetic wiki pages using the real local embedder.

Repeating “Which two notes does Synthetic Graph Center link to? Answer only from
the selected note and cite it.” reached the actual 4B answer command. The UI
recorded a returned response for `qwen3.5-4b-q4_k_m`, but displayed a review failure
and Retry rather than an answer. Native stderr recorded `review_rejected`.
Inspection 119,334 ms after submission observed the failed state; this is an
observation bound, not precise generation latency. Sixty two-second process-RSS
samples peaked at 3,154,640 KiB; sampling began after submission and is not an
exact process peak or model-only allocation.

This positive probe failed. Neither the hidden draft nor review payload was
captured, so the failure cannot yet be attributed to the generator versus the
reviewer. Keep the acceptance gate: next replay these exact source/question
bytes through native Ask diagnostic capture. This supplemental probe did not
include the frozen Q2 conflicting-session fixture, follow-up, date scenarios or
three repeated successes and does not close G2/G7.

[Native receipt](2026-11-11-native-ask-selected-note.json) records the build hash,
two outcomes, scope labels, limits and shutdown. Normal quit completed; the native
and sampling processes are stopped. All 14 existing synthetic Markdown files
retain their SHA-256 bytes. Production active-vault marker metadata was unchanged
relative to the existing unresolved incident, not restored. Build log:
`/tmp/myco-native-ask-v6-build.log`. No production code or README changed in this
acceptance-only slice; no additional unit-suite pass is claimed.

## November 11: preserve malformed working-folder evidence during grouping

At `532301d1`, a non-string `cwd` made typed sidecar decoding drop the entire
record. A valid absolute folder elsewhere in the same transcript could then
assign that conversation to a project despite the malformed declaration. The
new regression failed on the original parser with a numeric Claude Code cwd.
It covers numeric, array and object declarations in both input orders for
Claude Code and Codex. Missing/null fields keep their existing meaning.

The parser now retains cwd JSON values and feeds non-string declarations into
the existing invalid-evidence rule. Such a conversation remains unassigned;
its own invalid evidence cannot be replaced by a parent or vendor-store lookup.
Facts version 6 forces rereading cached version 5 assignments. Opaque `p5-`
project keys are unchanged. A migration regression verifies that the invalid
assignment is removed while the original sidecar and human-annotated project
page retain their bytes. The frontend reader, shared writer/reader fixture and
import contract expect version 6; a frontend regression rejects version 5.

Initial verification exposed two stale version expectations: the shared fixture
in the focused native suite, then the import admission assertion in the full
suite (2,706 passed, 1 failed, 38 ignored). Both expectations were updated to the
new contract without removing assertions. Frontend validation passed 6,498 tests
in 405 files, TypeScript/Vite build and ESLint (two existing notch hook warnings).
Rust formatting and strict all-target Clippy passed. The final default-feature
native library suite passed 2,707 tests with 38 opt-in tests ignored (57.86s).
No additional inference or feature-native acceptance run is claimed.

Logs: `/tmp/myco-project-cwd-{baseline,focused,full,full-final,frontend,build,lint,clippy,fmt}.log`.
The app README and current goal status were updated. No real vault, vendor store,
raw source, model or installed app was used in this slice. This does not resolve
repository equivalence across historical subdirectories/worktrees or prove
actual-model task-state meaning; those gates remain incomplete.

## November 11: stop an in-flight orbit retarget on reduced motion

Inspection at `d93069e8` found that changing the OS reduced-motion preference
completed `camTween` but left `targetTween` running. The latter eases the orbit
pivot during multiverse navigation. A regression starts a retarget, advances
partway, then enables reduced motion: it failed against the unchanged scene
because the target remained between its endpoints (7 passed, 1 failed).

`applyMotionPreference` now uses the existing reduced-motion retarget behavior
to finish that movement immediately and clear its tween before finishing any
camera flight. The regression also advances another frame and checks that no
retarget movement resumes. No graph layout, inference or native code changed.

Validation: 8 focused motion tests passed; the full frontend suite passed
6,497 tests in 405 files. ESLint passed with the two existing `notchDriver.ts`
hook-dependency warnings, and `npm run build` passed TypeScript and Vite.
Logs: `/tmp/myco-orbit-motion-{baseline,full,lint,build}.log`.
The app README now mentions active orbit retargets. This is a unit-tested
runtime preference fix, not a new installed-app/OS accessibility acceptance
receipt. Native visual, other-theme and wider accessibility gates remain open.

## November 11: Windows port prerequisites revalidated

Current local tooling still has only the macOS Rust target and no discovered
Wine, Parallels CLI or QEMU executable. The repository's self-hosted runner API
returned zero runners; GitHub-hosted availability was not tested or triggered.
The owner was asked for a Windows PC/VM connection. This blocks Windows runtime
acceptance, not independent work on other goal packages.

Code inspection confirmed that receipt handles, private directory pins,
restart custody, publication and source grants still contain explicit non-Unix
rejection paths. The new [Windows port contract](2026-11-11-windows-native-port-contract.md)
maps these dependencies and the required replacement/interruption tests.
Microsoft's 128-bit file identity documentation also rules out simply filling
the existing Unix `u64` inode field with a truncated Windows ID. Identity format,
sharing behavior and ancestor confinement need a tested Windows implementation.
No guard was removed, no workflow was dispatched and no Windows pass is claimed.
This documentation-only audit does not require a new build; README was unchanged
because no product behavior or supported-platform claim changed.

## November 11: unrelated-action examples improve some controls, still rejected

Added an opt-in, QA-only comparison that appends six photograph-archiving and
filename examples to the frozen baseline system prompt. Original R1–R7 texts,
speakers, gold labels, pinned 4B artifact, grammar, sampler seed and token budgets
were unchanged. The comparison contract was written before inference. No
production prompt, decoder, safety boundary or model selection was changed.

All 14 actual local-model calls completed with native bindings in an isolated
synthetic runtime under OS network denial. The run took 484.84 seconds including
cold verification/loading; `/usr/bin/time -l` reported 3,183,902,720 bytes maximum
resident set size. A startup process sample showed artifact SHA-256 verification,
not a stalled inference. These figures are diagnostic observations, not release
performance acceptance or per-generation latency.

Source-based review matched baseline R5/R7 and candidate R1/R4/R5/R6/R7. The
candidate preserved an unknown performer for R1 and correctly distinguished
R4's future plan. However, R2 turned the explicitly named assistant performer
into a report recipient with unknown actor; R3 still classified a past report
as a new request. Both are required semantic failures. The candidate is rejected
for production; its 5/7 development-control result is not a promotion, held-out
generalization result or full-compiler pass. One run per arm also leaves the
three-repeat gate open. Full raw outputs, bindings, telemetry and review are in
the [comparison receipt](2026-11-11-request-examples-comparison.json).

The model-free request QA group passed 11 tests with eight model tests ignored.
Formatting passed after correcting the new call's line wrapping. The remaining
G4/G7 semantic gates stay incomplete; further work must distinguish nested
performer assignment and reported actions without weakening the frozen labels.
The feature-native suite passed 3,156 tests with 67 ignored, and strict
`native-index-probe` all-target Clippy passed. All owned model/check processes
stopped. Logs: `/tmp/myco-request-examples-{full,clippy,fmt}.log`. Frontend tests
were not rerun and README was unchanged because this slice changes only opt-in
QA code and research records.

## November 11: ambiguous map targets require review

Existing-map discovery returned the first topic/member-label match in directory
order. Two matching maps could therefore send an approved automatic refresh to
one arbitrary target. Native custody remains necessary, but custody alone does
not establish which of two otherwise valid maps the user intended to refresh.

Discovery now scans the matching candidates before selecting a target. Multiple
matches return `pending` / `validation_rejected` with a request to review the
maps; no source packet, model request, refresh preview or publication is started.
The single-match boundary/ownership flow is unchanged. Two reversed-directory
regressions failed before the fix and passed afterward; the combined map,
refresh, recovery and history suites passed 60 tests. These use synthetic mocked
IPC and establish frontend routing only, not native custody or model semantics.
The app README explains the ambiguity behavior for manual/automatic proposals.
The full frontend suite passed 6,496 tests in 405 files, with type/build passing
and lint reporting zero errors plus the two existing hook warnings. Logs:
`/tmp/myco-map-ambiguity-{full,build,lint}.log`. Native code was unchanged and
native/model acceptance was not rerun for this frontend routing repair.

## November 11: label bounds and opaque text backing

The previous native replay showed long neighbor names clipped at the canvas
edge and bright node artwork behind the text. Label decluttering previously
checked overlap with other labels but neither viewport bounds nor the open
inspector. Two regression cases failed before repair. Placement now clamps both
rendered label offsets and collision boxes to the available canvas area, with
eight-pixel margins and right/bottom inspector exclusion. A third case covers
the full-width bottom inspector. Overlong titles use ellipsis within the
available width; the full title remains on the label's title attribute.

Labels retain the shared typography and theme ink, with an opaque theme
background behind the text span. The transparent outer element retains the
node-to-label gap, so the backing does not cover that gap. Theme changes update
the backing as well as the ink. Graph visual rules were updated accordingly.

The first full run had six failures: the new literal border radius violated the
design token rule, and five Woven tests used a fake style object without the
standard `setProperty` API. The radius now uses `--r-sm`; the test DOM stores
custom property values rather than ignoring the call. All 104 targeted tests
then passed. This is code/test evidence, not a native visual acceptance claim.

The final full suite passed 6,494 tests in 405 files; lint had zero errors and two
existing warnings. Type/frontend build and isolated native bundle build passed.
Logs: `/tmp/myco-graph-labels-final-{full,lint,build}.log`. In the rebuilt native
1280x800 dark window, the center and both neighbor titles were visible inside
the uncovered canvas, including the formerly clipped east title. Opaque backing
separated text from the bright planet; a longer unrelated title ellipsized within
the strip. Read-only computed styles reported RGB(237,237,236) text on
RGB(25,25,25), with ancestor opacity product 1 (about 15:1 luminance contrast).
This proves only the observed node-label treatment, not all UI contrast or the
full theme/viewport/state matrix. See the
[native label receipt](2026-11-11-native-graph-labels.json).

The app was quit, no native process remained, and all eleven preexisting
synthetic Markdown hashes were unchanged. Production marker metadata remained
unchanged relative to the unresolved incident baseline. README was unchanged:
this repairs existing Graph rendering without a new command or workflow.

## November 11: native replay exposes remaining narrow-canvas focus error

Rebuilt the isolated native bundle from `8a550479` (binary SHA-256
`71a7a34c3bd7a9f1da738ce475508a66d48f224daacfd5fc1bf4edeca66cd292`).
The fixed launch wrapper and unchanged sandbox profile were restored before
launch; running the acceptance binary without diagnostic environment still
refused startup. Native search again selected the correct synthetic center.
The neighborhood action visibly moved the camera back, but ordinary search
still produced an oversized node and clipped labels. This replay failed visual
acceptance despite the preceding green tests.

Read-only inspection through the native Web Inspector found a selected-camera
distance of about 202 world units and an actual maximum of 30,000. Thus the
tiny-maximum regression covered a possible code path, not this replay's root
cause. Ordinary focus accounted for panel coverage in its lateral offset but
still calculated distance from vertical FOV alone. A new regression projected
the 60-unit focus radius into the 200px uncovered strip: it occupied 331px and
failed. The repair uses the narrower uncovered horizontal/vertical FOV for
ordinary focus as well as solid bounds. All nine focused tests then passed.

A second rebuilt native replay verified reduced search magnification and the
selected title outside the inspector. Neighborhood framing still clips the
beginning of a long neighbor label at the left canvas edge, and the bright node
background interferes with label readability. G6 remains incomplete: geometric
point/radius fitting is not sufficient evidence for label bounds or composited
contrast. Preserve this failed visual gate in the
[native Graph receipt](2026-11-11-native-graph-focus.json).

The full frontend suite passed 6,491 tests in 405 files. Lint had zero errors and
two existing hook warnings. Type checking, production frontend and the isolated
native bundle build passed. Logs: `/tmp/myco-graph-width-{full,lint,build}.log`.
README remains unchanged for this existing-behavior camera repair.

The diagnostic app was quit. All eleven existing synthetic Markdown files
remained unchanged; production marker metadata was unchanged relative to the
previous unresolved incident baseline. No live-vault content was read.

## November 11: native Graph navigation and focus regression

The isolated macOS bundle at `c2e81df3` was exercised with three new synthetic
linked notes. Searching for the center note selected the correct inspector,
showed two outgoing links and two backlinks, and opened the correct Reader
body. Collapsing both rails survived a normal quit/relaunch; both reopened.
The app was quit afterward and process absence verified. All eleven preexisting
synthetic raw/wiki files retained their hashes; the three added notes matched
their fixture bodies.

Visual acceptance failed: selection/neighborhood focus produced an oversized
pixel planet and inspector-obscured labels in the small graph. Two camera
regressions reproduced the causes: the previous maximum distance clamped the
required focus distance, and sculpted bounds replaced the neighborhood fit.
Both failed before the repair and passed afterward. The camera now retains the
required distance, accounts for the inspector's uncovered width, and expands
its maximum distance for ordinary focus too. Search always supplies inspector
coverage; the neighborhood button now reframes the camera.

Focused camera/label/presentation tests passed (29 tests). The full frontend suite
passed 6,490 tests across 405 files; type checking and production build passed.
Lint had zero errors and the two existing `notchDriver.ts` dependency warnings.
Logs: `/tmp/myco-graph-focus-{full,build,lint}.log`; exit codes were all zero.
The repaired frontend
has not yet been replayed in a rebuilt native bundle; this is not a visual
acceptance pass. Full accessibility, viewport and state review remain open.
README was unchanged because this repairs existing Graph behavior without
adding a command, setting or workflow.

## November 11: native early cancellation preserves submitted and newer drafts

Using the same unchanged bundle and isolated state, submitted a new synthetic
Birch source and clicked Cancel after the running UI appeared. The next native
accessibility observation showed the cancelled state and the exact submitted
title/full body. No cancellation response or native IPC was mocked.

Edited the returned form to a new title/body, visited Ask and returned to Ingest;
the new fields and cancelled result remained visible. Quit normally, verified
process absence and relaunched through the fixed wrapper. The new title/body
were restored exactly. Quit the replay app as well. Every preexisting synthetic
Markdown hash was unchanged; the only added Markdown file was the original
`Alpha/raw/synthetic-birch-cancellation.md` saved before cancellation. No wiki
page was created. Production marker metadata remained unchanged relative to the
existing unresolved incident baseline.

See [the cancellation receipt](2026-11-11-native-draft-cancellation.json). This is
the early/preparation cancellation portion of D3. There is no evidence that the
already-dispatched native request settled before app quit, and this must not be
reported as the older-success/newer-draft race or every publication-stage cancel
case. Those remain open. No code or README changed; JSON and whitespace checks
were performed, without rerunning code suites for validation-only records.

## November 11: native draft write failure and recovery pass D4

Used CUA to open the isolated app's Web Inspector and inject `QuotaExceededError`
only for writes to the exact Alpha Ingest draft key. The wrapper forwarded all
other storage calls to the original function; native IPC, providers and vault
files were not mocked. The injection refused an unexpected origin/startup vault.
This implements the frozen D4 instruction to inject a storage write failure; it
is not a claim about physical disk exhaustion or hardware failure.

Alpha's typed title/body stayed visible with the storage error and retry button.
Retrying while the fault remained retained both input and error. After editing to
a newer body, switching to Beta showed only Beta's own old draft; a new Beta body
saved normally. Returning to Alpha retained its latest input and error. Restored
the exact original property descriptor in the console and confirmed that Alpha
had no persisted record before retry. Clicking draft-save retry removed the
error and preserved the latest title/body.

Normal quit, process-absence verification and relaunch then restored Alpha's exact
latest fields without an error. Switching to Beta restored only its separate
body. The final app was quit; no fault wrapper or native process was left active.
No import was submitted, file counts stayed Alpha 4 raw/5 wiki and Beta 0 raw/1
wiki, and both synthetic Readers and prior generated source pages retained their
bytes. Production marker metadata was unchanged relative to the unresolved prior
incident baseline. See [the D4 receipt](2026-11-11-native-draft-storage-recovery.json).

D4 now passes for injected write failure in this bundled macOS build. Read/remove
failure, other platforms and the remaining D3 races/cancellation are not covered
by this result. No application code or README changed; validation-only records
were checked as JSON and with `git diff --check`, without rerunning code suites.

## November 11: rebuilt native cold-process first submission succeeds

Rebuilt the unsigned debug acceptance bundle at `c2e81df3`, then restored the
fixed sandbox launcher with the new native checksum. Launch without diagnostic
environment still refused. The model weights and synthetic vault were retained,
but the new native process had no process-local verification or model-host cache.
No provider setting changed and network denial remained in force.

Submitted the 12,340-byte synthetic Willow inventory once, with no retry. The
neutral preparation text was visible. A process sample after 45 seconds still
showed native artifact SHA-256 verification, and the task did not expire while
preparing. At 228 seconds the UI was still running; the next observation at about
266 seconds showed successful completion. This interval includes debug artifact
verification/loading and is not an inference-only latency or release benchmark.

The title/body were empty and submit was disabled after success. Review listed a
new source-summary note plus updated index/log. The generated 2B preview states
that a request exists but completion is not recorded, with explicit 6-of-24-chunk
coverage. Hashes of every preexisting synthetic Markdown file matched except the
expected app-managed index/log updates; all preexisting raw files were unchanged.
The native process and its RSS sampler were stopped. Two-second sampling observed
1,626,688 KiB maximum native RSS; this is not an exact peak or WebKit/process-tree
memory total. Production marker metadata was unchanged relative to the existing
unresolved incident baseline.

The [cold-process receipt](2026-11-11-native-ingest-cold-success.json) retains the
full synthetic input/output, binary/profile hashes, observations and limitations.
This verifies the previous timing fix on one actual first submission and the
neutral UI copy in the rebuilt app. It does not complete the newer-draft race,
native storage-failure recovery, Windows or three-repeat semantic gates. Build
passed (`/tmp/myco-budget-native-build.log`); application code and README were
unchanged in this validation turn, so code suites were not repeated.

## November 11: preview generation budget starts after model preparation

The [native Ingest receipt](2026-11-11-native-ingest-success.json) retained cold
preparation timeouts and a same-process warm success. Code inspection found that
`transform` started its 45-second timer before entering the blocking task, source
validation, artifact verification, model-lock acquisition and model loading.
This contradicted the documented *generation* budget and could exhaust it before
any generation began. The sampled software SHA-256 verification provides runtime
evidence of preparation work during the original wait, not a model latency claim.

Moved the existing 45-second deadline into the verified/loaded model callback.
Prompt preparation and decoding remain bounded by it; cancellation is never reset,
and pre/post source and vault checks remain unchanged. A scoped deadline guard
aborts the timer task on normal return, early error or unwinding. Added tests for
expiry setting both timeout/cancellation flags and for dropping the scope
terminating an already-started timer task. The focused native generation suite
passed all 39 tests. The initial formatting check required one line wrap, which
was fixed; the repeated formatting check passed.

The full native library suite with `native-app-acceptance` passed 2,707 tests
with 38 existing ignored tests (`/tmp/myco-generation-budget-full.log`).
Strict all-target Clippy with the same feature and final `cargo fmt --check`
also passed. Command exit codes are in `/tmp/myco-generation-budget-status.json`.
Frontend tests were not repeated because frontend code did not change.

Updated app README to explain that cold model preparation is outside the
generation budget. This changes preview timing, not source authority, model
selection or fallback policy. The previously exercised bundle still has the old
binary: cold-start native acceptance must be rerun after rebuilding, and no
first-attempt success is claimed yet.

## November 11: offline native Ingest success clears the submitted draft

With the same fixed sandbox wrapper, copied only existing pinned GGUF weights
into the isolated state directory. Both source and copied hashes matched the
repository manifests; no artifact was downloaded and network denial remained.
The toolbar advertised 4B, but the actual preview route requested 2B, as confirmed
by native diagnostics and the final saved page. Preparing only 4B therefore did
not establish the prerequisites for Ingest. Both pinned artifacts were eventually
available without changing provider settings.

Retained all four attempts: cold 4B state ended with `time_budget`; the next
attempt reported `generation_unavailable_or_rejected` for missing 2B; the first
attempt after copying 2B also ended with `time_budget`; the same-process warm
retry succeeded. A process sample during the initial wait showed software SHA-256
inside model verification. No inference-only latency is inferred from the UI
clock. Repeated submissions reused the same raw file, whose SHA-256 stayed exact.

The native UI showed three review entries (source note, index, log), completion,
empty title/body and disabled submit. Add-another kept the form empty. The saved
page contains a 2B-generated Korean preview and explicit 6-of-24-chunk coverage;
it says completion is not recorded and the outcome is unknown. This is one
synthetic current-revision success case, not the frozen project meaning suite or
three repeated trials. Both synthetic Reader files and Beta's file counts were
unchanged. The owned native process was quit and absence verified. Production
marker metadata stayed unchanged relative to the existing unresolved incident.
Full synthetic input/output and limits are in
[the native success receipt](2026-11-11-native-ingest-success.json).

During this run the local path visibly said “Starting Claude”. Replaced the
shared warm-up copy in English, Korean and Japanese with provider-neutral source
preparation wording. This fixes the false provider claim without changing model
selection. The existing seven IngestProgress tests and full 6,488-test frontend
suite passed; lint had zero errors and the same two existing hook warnings;
type-check/production build passed. Logs are `/tmp/myco-ingest-neutral-*`.
This text change was not rebuilt into the diagnostic bundle. README was unchanged
because only transient copy changed. No Rust source changed or native suite was
rerun. G1 still requires the older-success/newer-draft race and D4 native recovery;
G7 full model and cross-platform acceptance remain open.

## November 11: map cleanup errors preserve publication recovery state

A new regression reproduced a frontend error-classification bug in
`withMapEvidence`: a retained native refresh error followed by source-release
failure became a plain `AggregateError`. The proposal runner consequently lost
the `pending` classification and `writtenPath`, hiding the retained map from its
published-but-incomplete results. The baseline failed one test with 31 passing;
see `/tmp/myco-map-cleanup-baseline.log`.

Cleanup now preserves an existing workflow error's status, code and retained path,
while retaining both original errors in an aggregate cause and exposing the
cleanup failure in the message. A cancelled review remains stopped and does not
acquire a written-path claim. Unclassified generation errors retain the previous
aggregate behavior. No native write, custody, source validation or undo authority
was changed. These injected IPC/error tests are not installed-app interruption
or successful recovery acceptance; G5 remains incomplete.

Validation: the initial four focused suites passed 126 tests. After adding the
cancellation case, the full frontend suite passed 6,488 tests in 404 files,
including all 33 map-evidence cases. Lint passed with the two existing
`notchDriver.ts` warnings; the type-check/production build passed. Logs and exit
codes are `/tmp/myco-map-cleanup-{lint,build,full}.log` and
`/tmp/myco-map-cleanup-status.json`. No Rust suite was rerun because native code
was unchanged. README was unchanged: this repairs existing failure reporting
without adding a feature, API or configuration option.

## November 11: repeated storage failure recovery across vaults

Added a regression in `src/stores/ingestDraftStore.test.ts` for the D4 storage
contract: persist original A/B drafts, reject writes in both vaults, edit A more
than once, retry while failure persists, restore writes and retry A only. A fresh
store must recover A's latest title/body while B retains its previous persisted
version and its current in-memory draft still reports a save failure. Retrying B
then persists B without changing A. This checks stale-input and cross-vault
recovery behavior, rather than just a single successful retry.

The existing test setup uses `MemoryStorage`; quota exceptions are injected.
This is automated store-level evidence, not a real WebKit quota or installed UI
failure/recovery receipt. D4 remains open for native UI acceptance. No production
code changed and no newly reproduced implementation failure is claimed.

Validation: the three Ingest suites passed 54 tests; the full frontend suite
passed 6,486 tests in 404 files. `tsc -b` passed. ESLint reported zero errors and
the same two existing `notchDriver.ts` hook-dependency warnings. README was not
changed because this adds test coverage only. No Rust or release build was run.

## November 11: native Ingest failure retains the current draft

Using the same checksum-verified sandbox launcher and synthetic Alpha vault,
CUA submitted three synthetic inputs. The 186-byte input was excluded by the
junk floor; the 323-byte input was archived as raw-only. Neither was a model
failure, and both retained their drafts. A 10,654-byte input crossed the harvest
floor and reached a real native failure:
`WorkflowOperationError: WorkflowOperationError: Local preview rejected: generation_unavailable_or_rejected`.
The UI showed incomplete processing and a retry action. Title `Synthetic source`
and all 45 input sections remained. After visiting Ask and returning to Ingest,
comparison of the accessibility text with the submitted body was exactly equal.

Alpha now contains two new synthetic raw Markdown files and its original single
wiki file; Beta retains zero raw files and one wiki file. Both original synthetic
Reader files are unchanged. The owned app was quit and its native process absence
verified. Production marker metadata is unchanged relative to the already
recorded incident baseline; the earlier marker incident is not repaired by this.
See [the native failure receipt](2026-11-11-native-draft-failure.json).

This advances the failure-retention part of D3 only. Native successful completion
versus a newer draft, cancellation, other partial outcomes and D4 storage recovery
remain open. No inference quality or successful wiki publication is claimed.
Repository application code and README were unchanged; no code test suite was
rerun for this validation-only documentation update.

## November 11: isolated bundled draft navigation, restart and vault separation

The fresh bundle's unchanged native executable became reachable by CUA after
adding a temporary Launch Services entry wrapper. The wrapper verifies native
binary/profile checksums on each launch, sets the fixed diagnostic environment
and synthetic app-data directory, and execs the same OS sandbox and native binary.
This modifies only the temporary validation bundle, not repository application
code. The previous direct-process attachment failure is superseded by this result;
the earlier contaminated fixture and withdrawn acceptance are not reinstated.

Using the full production frontend and native IPC, CUA observed the exact frozen
D1 title `Synthetic source` and body `Synthetic report draft` after visiting Ask,
Settings and the synthetic Reader, then returning to Ingest. For D2, a normal
Cmd-Q ended the native PID; relaunch through the same wrapper restored both fields.
Beta received body `Different synthetic draft` with an empty optional title.
Returning to Alpha restored only D1, and returning to Beta restored only its own
input. Earlier supplemental runs also preserved longer distinct titles/bodies
through navigation and two restarts. These are not three repeated model trials.

All four native process lifetimes used the same binary/profile hashes. Three
normal quit/relaunch boundaries were observed; the final validation process was
explicitly stopped after the final UI observation. Both synthetic reader files
remained unchanged, each vault still held one wiki note and zero raw files, all
automatic jobs remained disabled, and production active-vault marker metadata
remained unchanged. Its original value is still unknown from the earlier incident.
No source was submitted and no model was invoked.

The [native draft receipt](2026-11-11-native-draft-navigation.json) retains the
launcher, checksums, exact observations, process identities and limits. D1 and the
restart variant of D2 pass for this unsigned debug macOS bundle. D3/D4, signed
installer behavior, Windows, full helper containment and model acceptance remain
open. The explicit startup URL selects Alpha, so this does not test restoration
of the last-selected vault at boot. No fresh source-code tests were necessary:
the binary is the previously built `8e705a28` artifact, whose type/build/native
checks are recorded in the preceding slices. README is unchanged because product behavior did not
change; the goal status table now reflects this bounded acceptance evidence.

## November 11: fresh guarded bundle starts, but UI attachment is unavailable (superseded)

Built an unsigned debug application from clean `8e705a28` with the acceptance
feature, a fresh bundle/deep-link identifier and an explicit synthetic Alpha
startup URL. The frontend type/build and offline locked native bundle build
passed. Both Alpha and Beta were created anew with one synthetic reader note;
the old contaminated fixture was not reused. Settings disabled every automatic
job, notch, resident tray and spotlight shortcut. The bundle refused a launch
without diagnostic environment variables before any GUI work.

The first sandboxed launch could not create its bundle-specific WebKit temporary
directories. Stopped that owned process, retained its log and added only the
observed new identifier's temporary directory to the write allowance. The second
launch reached the synthetic Alpha vault with no stderr errors. Production/legacy
app data, conversation directories and Documents stayed under read-data denial;
network and writes outside the synthetic/new-identifier directories remained
denied. Synthetic canaries checked protected read/write, symlink read, network
bind denial and allowed scratch read/write. Metadata reads remained available for
canonical path checks. This is not proof of every delegated WebKit helper's
containment.

CUA could not attach to the running owned process by bundle path, identifier or
display name (`Running application not found`). No native draft interaction,
navigation or restart was observed. The process was explicitly stopped, both
fixtures still held exactly one unchanged synthetic note and zero raw files, all
automatic-job flags remained false, and production active-vault marker metadata
was unchanged. The marker's original value remains unknown from the earlier
incident; this check does not restore or validate that value. D1/D2 remain
unaccepted. See the [startup receipt](2026-11-11-isolated-native-draft-startup.json).

Before rebuilding, `cargo clean --profile dev -p myco --dry-run` identified 87.8
GiB of package build artifacts; the actual package-scoped clean removed 87.5 GiB
logical size and left about 46 GiB physical free space. Source, vault and model
originals were outside this cleanup. The previous disabled app bundle still
exists without executable permissions. Logs are
`/tmp/myco-native-replay-clean-preview.log`, `/tmp/myco-native-replay-clean.log`
and `/tmp/myco-isolated-drafts-v2-build.log`;
the fresh fixture locator is `/tmp/myco-isolated-drafts-v2-path.txt`.
README is unchanged because product behavior did not change in this validation.

## November 11: complete portable path checks in activity recall

G3 baseline review found that `activity_recall::tests::resumed_old_session_uses_turn_dates_instead_of_its_folder`
and `scope_paths_archive_and_resolved_scope_are_enforced` returned zero hits on
Windows where one was required. The earlier portable-path slice fixed original
proof reads but missed both `recall_with_limits` scope checks: header catalog
admission and full-page revalidation still converted the native relative path
directly to a string. Windows separators therefore did not match slash-delimited
scope/path keys. Both checks now reuse the existing confined `relative_key` helper.
Confinement, scope/archive restrictions and the repeated pre-read check remain.

A Unix regression first failed because a literal-backslash filename was admitted
as an activity page. After conversion, such a nonportable identity is excluded
with incomplete coverage instead of being rewritten into another file identity.
A separate portable test exercises nested Unicode/space names with an explicit
selected-page filter. Its initial use of the shared mixed-date transcript correctly
produced incomplete coverage; the fixture was corrected to one fully dated turn
without removing the complete-coverage assertion. README describes the incomplete
coverage behavior for nonportable filenames.

This is a code-level Windows cause plus local regression evidence, not a Windows
runtime pass. Windows native identity, publication and full-suite acceptance remain
open; no Windows runner or CI job was started for this slice.

The first full-library and Clippy attempts exited 101 while disk free space fell
to about 145 MiB. The test log ended during file-creating tests without a complete
failure summary, and the Clippy log was empty; those runs are not passing evidence
or a proven code regression. After confirming both compiler processes had stopped,
removed only the regenerated static archive and five compiler query caches
(2,145,331,490 bytes). Source, vault and dependency files were untouched. Retained
logs: `/tmp/myco-activity-portable-{baseline,tests,full,clippy}.log`.

The unchanged-code retry passed all 2,705 library tests (38 ignored), including
both new regressions. Strict feature-enabled all-target Clippy and formatting
passed. Retry logs: `/tmp/myco-activity-portable-{full,clippy}-retry.log`.
The failure inventory reclassifies only the two named activity assertions from
unresolved to path/scope, retaining the code-inspection limit and all 340 baseline
entries. No claim is made that the Windows failure count has decreased yet.

## November 11: presence-penalty removal did not improve request meaning

The [frozen presence comparison](2026-11-11-request-presence-comparison.json)
changes only the existing QA sampler's presence penalty from 1.5 to 0.0. It reuses
the seven unchanged request controls, pinned cached 4B model, original payload,
system prompt, grammar, source binding, seed and 768/4096 budgets. The unit
regression checks that all other numeric sampler parameters remain identical.
No product decoding or model selection changed.

Runner `be74642a` completed 14 actual offline generations with isolated synthetic
state. The expected sampler profiles appeared in telemetry and all seven paired
inputs/system hashes matched. All seven paired generated outputs were byte-identical.
Both arms matched only R5/R7: R1/R2 requests and R3 past report were omitted;
R4 future plan became request/requested; R6's question itself became task activity.
Every full output and native binding is retained in the receipt. Native binding
passed, but neither arm passed the semantic contract. Do not promote the candidate.

This run provides no evidence that removing the presence penalty repairs these
errors. It does not establish other seeds/inputs or prose behavior, and one pair
per case does not satisfy repeated/full-compiler acceptance. The original quality
gates remain open; repeating this identical comparison is not a useful next step.

Validation: 11 request QA tests passed (7 explicit model tests ignored), strict
`native-index-probe` all-target Clippy and formatting passed. Actual model transport
passed in 441.92 seconds wrapper wall time with 3,185,573,888-byte maximum RSS.
All outputs have real positive prefill/sampling telemetry. Logs and hashes are in
the receipt. No inference process remains. README is unchanged because this adds
only a QA comparison and records evidence, not user-facing behavior.

## November 11: actual-process acceptance settings refusal

Rebuilt the standalone debug acceptance binary from clean `81df2562` and ran
eight rejected-startup cases with both diagnostic flags present and a canonical
synthetic data directory. Missing settings, empty defaults, malformed JSON, each
enabled automatic job, and an invalid endpoint all exited promptly with the
expected refusal message, no stdout and no change to synthetic state bytes.
See the [process receipt](2026-11-11-native-settings-startup.json) for the binary
checksum, exact revision and individual results. Exit code is currently zero;
the assertions require the refusal message too, not merely process termination.

The existing one-off OS sandbox denied network access, writes outside scratch,
and data reads from production/legacy app state, session directories and Documents.
Metadata reads remained available for canonical path checks. A synthetic protected
file read was denied before the native process cases ran. Production active-vault
marker inode/size/mtime/ctime were unchanged; its contents were not read or restored.
No native `myco` process remained after the checks. This proves refused startup
only: no accepted startup, WebKit helpers, GUI, model, Windows or D1/D2 scenario
was exercised. The old disabled app bundle remains unused.

The first build failed with `No space left on device (os error 28)` while creating
`libmyco_lib.a`. Removed only three regenerable target artifacts (the old static
archive and two compiler query caches, 1,547,158,295 bytes); the retry passed in
25.58 seconds. No source, vault, raw data or dependency version changed. Logs:
`/tmp/myco-acceptance-settings-binary-{build,rebuild}.log`; one-off harness:
`/tmp/myco-acceptance-settings-process.py`. This evidence supersedes the preceding
slice's outstanding standalone rebuild/refusal check, not installed acceptance.

## November 11: reject automatic-job defaults in acceptance startup

The opt-in `native-app-acceptance` guard previously allowed missing or unsafe
settings when both diagnostic environment flags and a separate data directory
were present. Missing settings can enable automatic imports through ordinary
application defaults. A synthetic startup regression reproduced `Ok(true)` for
that unsafe setup (`/tmp/myco-acceptance-settings-baseline.log`). An initial test
setup error (the scratch directory had not been created) was corrected before
recording this behavioral baseline.

Acceptance builds now require a regular settings file, apply the application's
checked settings validation, and refuse startup if any automatic import, ingest,
reflect or reindex job is enabled. This includes malformed endpoint/role settings
that would otherwise cause default fallback. Production builds are unchanged.
The synthetic test verifies missing/malformed settings, each enabled job, an
invalid endpoint, a valid disabled configuration, and a symlink on Unix. The
valid settings bytes remain unchanged. No installed app was launched and no
personal source contents were read for this change.

This is a startup precondition, not containment against later settings changes,
manual commands or filesystem races. OS restrictions, a separate WebView identity
and a clean synthetic-vault native rerun remain required. The previously
withdrawn D1/D2 acceptance is not reinstated.

Validation: 32 settings tests passed before adding the Unix symlink case; the
final feature-enabled library suite passed 2,703 tests with 38 ignored, including
that case. Feature-enabled all-target Clippy with `-D warnings` and Rust formatting
passed. Logs: `/tmp/myco-acceptance-settings-{tests,full,clippy}.log`. The existing
standalone acceptance binary and bundle have not been rebuilt with this change;
process-level startup checks and installed acceptance remain outstanding.

## November 11: retain wiki scope before follow-up project discovery

G2 regression tests reproduced a second scope bypass: after a wiki-only question,
the Korean follow-ups `어디까지 했어?` and `그거 어디까지 했어?` read
`.myco/workstreams.json` and entered session-derived project discovery. The
project route only checked a new explicit scope, ignoring the inherited one.
Both tests failed against `db3cf502`; the explicit `all` override control passed.
Baseline: `/tmp/myco-workstream-inherited-scope-baseline.log`.

The route now checks `explicitScope ?? inheritedScope` before discovery, matching
the source selection contract. The regressions assert no project facts read,
wiki-scoped retrieval, and preservation of an explicit switch to `all`. All 236
Ask store tests passed. README documents the follow-up behavior. These synthetic
IPC tests do not establish native/model acceptance.

Validation: all 6,485 frontend tests in 404 files passed; lint had zero errors
and the two existing `notchDriver.ts` hook warnings; `npm run build` passed
TypeScript and Vite (22.21 seconds). Logs are
`/tmp/myco-workstream-inherited-scope-{tests,full,lint,build}.log`.
No native code changed and no installed application or actual-model scenario
was run for this slice.

## November 11: keep explicit wiki scope out of unrestricted Git history

G2 inspection found a remaining scope bypass in the frontend's repository-history
shortcut. `git commit history` with explicit `scope: wiki` and no dates/paths
called `ipc.gitLog(vault, 20)`, whose result is not filtered to wiki files. The
new baseline test failed because that unrestricted read was called once. Log:
`/tmp/myco-wiki-git-scope-baseline.log`. Existing tests only covered dated wiki
history and session-only history, leaving this undated wiki case uncovered.

The shortcut now refuses an effective explicit/inherited wiki scope. The request
continues through normal scope-bound retrieval. Precedence remains explicit
scope over inherited scope: a new `all` choice can still request repository
history. Existing date/path and session exclusions remain intact; implicit
unrestricted history behavior is unchanged. No native filtering guarantee was
invented for the Git command.

Four regressions cover direct wiki scope, persisted explicit wiki selection,
inherited wiki follow-up and an explicit `all` override of inherited wiki. All
233 query-store tests passed. The cases use synthetic IPC stubs and establish
frontend dispatch, not native retrieval or model-answer quality. README now
states that wiki-only requests do not use unrestricted Git history.
The full frontend suite passed 6,482 tests in 404 files. Lint passed with the two
existing `notchDriver.ts` hook-dependency warnings; the TypeScript/production
build passed (Vite 11.30 seconds). Logs:
`/tmp/myco-wiki-git-scope-{tests,full,lint,build}.log`. Diff whitespace checks
passed. Native code was unchanged, so Rust and installed-app/model checks were
not rerun. The goal's G2 native and semantic acceptance gates remain open.

## November 11: readable empty Reader prompts

The live Reader's `.live-empty::after` used decorative `--ink-5` for actual
heading and text-block prompts. `editorLive.ts` supplies their localized
`data-placeholder`; the same selector covers both kinds. Changed only that
selector to existing readable metadata token `--ink-4`. Disabled controls and
decorative separators keep their existing treatment.

Static sRGB contrast calculations from the declared tokens:

| Theme | Before on editor background | After on editor background | After on hover token | After on selected token |
| --- | ---: | ---: | ---: | ---: |
| Light | 1.59:1 | 5.59:1 | 4.82:1 | 4.56:1 |
| Dark | 1.98:1 | 6.87:1 | 5.46:1 | 4.79:1 |

These are token calculations, not measured composited-browser results or a claim
about every editor background. The CSS declares `.cm-editor` background as `--bg`;
the other two columns test palette combinations rather than observed interaction
states. Theme transitions, screenshots and full G6 acceptance remain unverified.
No new localized strings or product behavior were introduced. README describes
the readable empty prompts. All 52 stylesheet tests and the production frontend
build (including TypeScript) passed; log: `/tmp/myco-reader-placeholder-build.log`.
Diff whitespace checks passed. Full frontend/Rust suites were not rerun for the
single CSS declaration change.

Browser inventory showed only user-owned TaskSpace 0; the earlier validation
spaces were already finished. The loaded ego-browser guide requires explicit
user direction for additional TaskSpaces, so a question was sent instead of
claiming the user's space or silently opening another. No browser page, native
app or vault was opened in this slice. Original-vault marker recovery still awaits
the owner's path, and Windows runtime remains unavailable (only macOS ARM64 Rust
target, no discovered Wine/Parallels/QEMU command, no repository self-hosted runner).

## November 11: distinguish Windows directory, replacement and expiry failures

The 27 baseline access-denied failures comprise ten archive tests, three distill,
one import ledger, two index publication, four retrieval and seven vector-index
tests. They must not be fixed as one generic permission error. The archive
directory capture uses `File::open`, followed by `same_identity`, which explicitly
returns unsupported on non-Unix. Microsoft documents that obtaining a Windows
directory handle requires `FILE_FLAG_BACKUP_SEMANTICS`
([Directory Handles](https://learn.microsoft.com/en-us/windows/win32/fileio/obtaining-a-handle-to-a-directory)).
Changing that open alone would merely expose the next unsupported identity check.

The ledger failure occurs during replacement while a reader retains the previous
file. The installed tempfile 3.27.0 Windows implementation uses `MoveFileExW`
with `MOVEFILE_REPLACE_EXISTING`; it is not the directory-open path. Windows
replacement/sharing semantics require native reproduction before choosing an
adapter ([Moving and Replacing Files](https://learn.microsoft.com/en-us/windows/win32/fileio/moving-and-replacing-files)).
The old reader must keep its complete bytes, the new name must publish the new
complete bytes, and failed writes must retain the original. No delete-first,
in-place rewrite, permission bypass or test skip was introduced.

The four previously labelled `clock_expiry` failures were only expiry/seam
assertions, not measured clock drift. `observe_expired_pair` captures native
identity before the preparation hook; non-Unix `same_observation` explicitly
refuses this. A failure before that hook leaves the original expired verdict,
and a failure before commit leaves no Keep worker. The inventory now uses
`expiry_seam_or_extension_assertion`, retaining all 340 original test names.
Three test files now include the original expiry result in those failure messages
instead of hiding it behind a future-time assertion or absent worker. Assertions,
timeouts, concurrency checks and runtime behavior are unchanged.
All four affected `actual_keep` tests passed on macOS with the acceptance feature;
strict all-target Clippy, formatting and diff whitespace checks passed. Logs:
`/tmp/myco-windows-keep-diagnostics-tests.log` and
`/tmp/myco-windows-keep-diagnostics-clippy.log`. The full suite and Windows were
not rerun for these diagnostic-only assertion changes.

This narrows investigation; it does not establish Windows support or repair the
underlying native adapters. README is unchanged because only test diagnostics and
research records changed. No GUI, model, user vault or production marker was used.

## November 11: Windows failure inventory and pinned-template checkout fix

Fetched baseline CI run 42773670030, job 129687133365 (`rust-windows`), and
confirmed its head is `121c0fa21bcffbc5ab831ef7f730169b7ed1ad9c`. The log contains
340 unique failed-test blocks, matching 1,994 passed / 340 failed / 29 ignored.
The [inventory](2026-11-11-windows-failure-inventory.json) retains test names,
panic locations, diagnostic groups and the downloaded log hash, without copying
large fixture payloads or runner paths.

| Diagnostic group | Failed tests | Interpretation |
| --- | ---: | --- |
| Explicit unsupported identity/custody | 71 | Non-Unix fail-closed branches remain in inbox, audio, publication and compiler custody. |
| Path/scope rejection | 82 | Baseline includes separator-sensitive checks; current portable fixes still need Windows execution. |
| Poisoned lock | 42 | Secondary failures: 29 session compiler, four settings and nine workstreams tests. Do not treat each as an independent platform defect or weaken lock errors. |
| Access denied | 27 | Includes directory opens and ledger replacement; Windows handle/share/ACL behavior needs native investigation. |
| Missing path/file | 6 | May be secondary to failed preparation; not established as independent missing-file defects. |
| Expiry seam/extension assertion | 4 | Early identity refusal can prevent the hook; this is not evidence of clock drift. |
| Pinned Qwen3 template | 5 | Checkout conversion reproduced and fixed below. |
| Other assertions/unresolved | 103 | First cause not yet established. |

These are diagnostic groups, not 340 fully resolved causes. Nested child failure
output stays with its parent. Serial focused Windows runs are required to locate
the first poison-producing panic and resolve the remaining assertion failures.
For example, current `recorded_identity` returns None outside Unix,
`inbox_source::verify_identity` explicitly refuses non-Unix, compiler pin/custody
operations refuse non-Unix, and archive directories are opened via `File::open`.
Replacing errors with success or skipping those tests would not satisfy G3.

The pinned-template test failed on Windows with length 4,200 rather than 4,116.
A new isolated Git checkout regression reproduced exactly `4200 !== 4116` on
macOS by checking out with `core.autocrlf=true` and `core.eol=crlf`. The repository
only had GGUF attributes. Added `-text` for this one byte-pinned Jinja fixture;
the same checkout now preserves length 4,116 and SHA-256
`87a2728cb8dc9fe424d624542f6060ec05a1d285ebbec578bb078900e33396b5`.
Neither the fixture nor the runtime hash check was changed. The regression uses
a temporary Git index without commits, user identity changes or dependencies.
The frontend CI job now runs it before its existing unit tests.

Validation: `node --test app/scripts/pinned-template-checkout.test.mjs` passed;
all six `local_llm::qwen3::tests` passed in the existing feature-enabled native
test binary; diff whitespace checks passed. Baseline failure log:
`/tmp/myco-template-checkout-baseline.log`; native result:
`/tmp/myco-template-qwen-tests.log`. No Windows run, push, model inference or GUI
launch occurred. README was unchanged because this fixes checkout/test behavior.
G3 remains incomplete, including its first-cause inventory for unresolved cases.

## November 11: native startup refusal and OS canary evidence

On clean `ee06a75c`, `cargo build --features native-app-acceptance --bin myco`
passed on macOS 26.5.1 arm64. The actual executable was started three times:
neither diagnostic flag, only `MYCO_REAL_DIAGNOSTIC=1`, and only
`MYCO_DIAGNOSTIC_DISABLE_INDEX_UPDATER=1`. Each process returned exit 0 with the
exact refusal `refusing diagnostic startup: acceptance binary requires diagnostic
isolation`, no stdout and no new state files. Exit 0 is the existing `run()` early
return contract, so the refusal text and absence of startup effects were checked
as well. Production active-vault inode, size, mtime and ctime were unchanged.
Its incorrect temporary Alpha value was not repaired or overwritten.

The subprocesses also ran under an OS profile denying network access, all writes
outside a new scratch directory, and reads of production/legacy app data,
Documents and the Claude/Codex directories. No existing personal file contents
were read to validate the profile. A separate entirely synthetic canary first
proved allowed scratch read/write, denied protected read/write, denied reads and
writes through a symlink, inherited child-process read denial and denied local
network binding. Protected synthetic bytes remained unchanged.

The local manual explicitly marks `sandbox-exec` deprecated. It was used only
for these one-off diagnostics, not added as a product dependency or new repository
launcher. These tests establish the observed process/file boundaries, not full
GUI/WebKit helper containment or a signed App Sandbox deployment. D1/D2 remain
unaccepted. The contaminated prior fixture and disabled bundle were not reused.

The [machine-readable receipt](2026-11-11-native-startup-isolation.json) retains
the binary checksum and outcomes. Build log:
`/tmp/myco-acceptance-binary-build.log`; raw receipts:
`/tmp/myco-sandbox-canary-result.json` and
`/tmp/myco-acceptance-refused-launch.json`. No product behavior changed in this
slice, so README was not updated again. Next native acceptance requires a fresh
bundle whose every launch is guarded and an app-level containment check before
repeating draft/scope scenarios.

## November 11: refuse unisolated acceptance-binary startup

Added the opt-in `native-app-acceptance` Cargo feature for full-app validation.
When compiled with it, `isolated_diagnostic_startup` returns an error instead of
normal startup if debug assertions are absent or either diagnostic flag is
missing. `run()` already checks this result before installing the panic hook,
migrating WebView data, constructing the Tauri builder or running setup. Existing
canonical/nonproduction `MYCO_DATA_DIR` checks remain unchanged. Ordinary builds
without the feature retain their prior behavior.

The regression ran before the implementation and failed with
`called Result::unwrap_err() on an Ok value: false` at `settings.rs:1187`.
It covers no flags and each partially supplied pair, restoring environment values
before assertions. Log: `/tmp/myco-acceptance-startup-baseline.log`. After the fix,
all 31 settings tests passed and feature-enabled all-target strict Clippy passed.
Logs: `/tmp/myco-acceptance-startup-tests.log` and
`/tmp/myco-acceptance-startup-clippy.log`.
The complete feature-enabled library suite passed 2,702 tests with 38 ignored
(`/tmp/myco-acceptance-startup-full.log`); formatting and diff whitespace checks
passed. Default-feature integration and frontend suites were not rerun for this
feature-gated startup change.

README now describes the guard and its limits. This is not OS confinement,
an installed-app acceptance rerun, or a correction of the production active-vault
marker. That correction still awaits the original path. No GUI app was launched
in this slice and the contaminated fixture was not reused.

## November 11: withdraw bundled acceptance after isolation failure

The next native run found additional files in the temporary Alpha vault before
submitting any draft. Only file counts and metadata were inspected: five wiki
files, 46 raw files and 22 session files. Their bodies were not read, exported or
committed. Existing raw files were not removed or modified. The temporary fixture
is no longer safe to treat as exclusively synthetic and must not be reused for
testing or model input.

The isolated settings file still had automatic import/ingest and notch disabled.
However, the production app-data `active-vault` marker had been modified at
`2026-11-10T18:10:25.975211Z`, during the preceding UI run. New raw/session file
modification times spanned `18:10:37Z` through `18:12:05Z`. Production settings
file metadata remained dated October 17. No original active-vault marker snapshot
was retained, so its original value cannot safely be guessed. The owner was asked
for the original vault path before restoring that marker.

The working hypothesis is that CUA app binding/observation relaunched the bundle
without the shell's environment, alongside or after the explicitly isolated
process. That mechanism has not yet been reproduced in a clean sandbox. A bundle
identifier and shell environment alone did not ensure every launch was isolated.
All matching app processes were stopped; the explicitly launched process returned
143 after targeted SIGTERM. No D3 submission was attempted.
The temporary debug bundle executable had its execute bits removed (0755 to
0644) to prevent another accidental CUA/Launch Services start. This changes only
the generated diagnostic bundle, not the installed production app or repository
source. A boolean-only check confirmed the production marker points to the
temporary Alpha path; no original production vault path was printed.

The prior D1/D2 visible strings remain observations, but their acceptance claim
is withdrawn because the required isolation boundary was not maintained. Before
repeating native acceptance, every launch path must enforce separate state and
prevent access to production transcripts/state even when no environment is
inherited. Do not use `getApp` or a post-quit observation that can auto-launch an
unprotected bundle. This incident does not establish that the source vault was
modified, nor does it prove there were no other production-side effects.

## November 11: bundled macOS draft navigation and restart (superseded)

D1 and the restart variant of D2 were initially reported as passed using the full production frontend and
native IPC in an unsigned debug `.app`, built from clean commit `9095ba8e` on
macOS 26.5.1 arm64. This is bundled-app evidence, not a signed release installer,
Windows result, model-quality result, or acceptance of every G1 failure path.
The later isolation incident above withdraws the acceptance claim.

The temporary fixture root is recorded in `/tmp/myco-installed-drafts-path.txt`.
It contains separate Alpha/Beta folders, each with one synthetic Markdown reader
note, plus a separate `state/settings.json`. Automatic import, ingest, reflect,
reindex, notch and global shortcut were disabled. The build override selected
`dev.cmblir.myco.draft-acceptance-20261111`, a separate deep-link scheme and an
explicit `index.html?vault=<synthetic Alpha path>` startup URL. The original
production app was not deliberately opened. No source was deliberately submitted
and no model was deliberately invoked; later metadata disproved the assumption
that every running instance used the isolated settings.

Build command, run from `app/`:

```sh
npx tauri build --debug --bundles app --no-sign --config "$(cat /tmp/myco-installed-drafts-path.txt)/tauri.override.json"
```

Build passed; log: `/tmp/myco-installed-drafts-build.log`. The bundled executable
SHA-256 is `d8a5dbd63997b0d20cc786abc0f7f117307d00ab9cabc61dceff9e2a41f0b5f0`.
Launch used `MYCO_DATA_DIR=<fixture>/state`, `MYCO_REAL_DIAGNOSTIC=1` and
`MYCO_DIAGNOSTIC_DISABLE_INDEX_UPDATER=1`. This existing diagnostic mode avoids
production WebView/keychain migration, MCP serving and global shortcut setup.
It does not replace the frontend, storage or vault commands with mocks.

Native accessibility observations through `cua_repl` established:

- D1: entered title `Synthetic source` and body `Synthetic report draft` in
  Alpha; visited Ask, Settings and the synthetic Reader; returned to Ingest and
  observed both exact strings.
- D2: quit the process (exit 0), relaunched the same bundle and observed both
  exact Alpha strings. Used Settings → My Space to switch to Beta; both inputs
  were initially blank. Entered body `Different synthetic draft`, switched to
  Alpha and observed its original title/body, then switched back to Beta and
  observed its own body with an empty title.
- A first-use wizard appeared on the first Beta switch; the ordinary Skip action
  returned to Settings without entering another path. This observation is not
  evidence of a draft failure or an assertion that onboarding is fully correct.

The second process was also quit and returned exit 0. Runtime log:
`/tmp/myco-installed-drafts-runtime.log`. No storage failure, delayed submission,
partial import, WebView reload or signed/release build was exercised here.
The `computer-use` skill's `orca` CLI was unavailable (`command not found`);
native UI inspection/input used the provided CUA tool instead.

README did not change: this slice adds validation evidence, not product behavior.
Next acceptance priorities are D3/D4 native failure handling and Q1/Q2 native
scope behavior, while Windows and actual-model semantic gates remain open.

## November 11: retained snapshots survive missing map directories

The new regression first failed on unchanged production code with
`Result::unwrap() on Err: No such file or directory (os error 2)` at
`map_creation_observation_tests.rs:234` after deleting the synthetic map and its
empty `wiki/maps` directory. Baseline log:
`/tmp/myco-map-missing-parent-baseline.log`.

Snapshot inspection now records the first missing non-root parent and does not
probe descendants beneath it. The vault root must still exist and match its
native scope; private records and retained anchors keep their existing checks.
At return, existing parents and records are revalidated and the missing parent
must still be absent. A directory or symlink appearing during the read rejects
the result. The operation creates no folders, restores no files and returns
`publicationUnknown` for the stored snapshots.

Tests remove `wiki/maps`, then `wiki`, confirm that both catalog discovery and
snapshot reading still work, exercise the opening-bound command, and prove the
directories remain absent afterward. Race cases inject a new directory or symlink
and verify rejection without deleting either replacement. Targeted map checks
passed 88 tests (three child-only ignored); strict all-target Clippy passed.
The full native suite passed 2,701 library and 28 integration tests, with 42
ignored tests overall. Formatting and diff whitespace checks passed. Full results
are recorded in `/tmp/myco-map-missing-parent-full.log`; these checks do not
establish installed-app, Windows or actual-model acceptance.
README now documents this read-only recovery behavior. Frontend code did not change.

The next priority returns to the original acceptance matrix's D1/D2 installed
draft navigation/restart and vault-isolation cases. Preparation inspection found
that the normal first-run fallback creates a Documents vault, while App's existing
`?vault=` startup route can select an explicit synthetic directory. A native run
must therefore use a distinct app/WebView identifier, isolated `MYCO_DATA_DIR`,
explicit synthetic startup vault, and disabled automatic session import before
launch. The existing native-index QA configuration has a separate fixture frontend;
it cannot be represented as installed full-app acceptance. No app was launched
in this preparation step. A read-only GitHub runners query returned no self-hosted
runners; that does not establish hosted Windows availability or pass Windows tests.

## November 11: discover retained maps missing from the file list

The opening-bound `retained_map_keys` command discovers canonical map names from
private records without depending on current map files. It checks the recorded
vault path and native vault identity, shared observation schema/scope/hash rules,
canonical artifact path and retained anchor identity. Other vault names are not
returned. Opened records, anchors, root and private-directory metadata are rechecked
before returning the sorted unique names. The scan is bounded to 4,096 entries,
32 MiB of private record bytes and 256 unique names. Because names must first be
identified, this byte limit covers the private store scan, not just one known map.

Stable records that cannot be identified do not supply guessed names. The response
instead carries a generic incomplete-list flag; it does not expose other vault
names or malformed text. I/O, privacy, anchor and concurrent replacement failures
abort the query. This is still read-only evidence and cannot restore a deleted map
or establish publication status.

History adds **Find retained maps**. Returned names join the existing file selector;
names absent from that tree are labelled **retained records only**. Selecting one
skips the latest-current-file read and directs the user to saved snapshots. Catalog
reload/errors and uncertain completeness are explicit. Opening changes clear the
catalog, selection and snapshots; late responses cannot populate another opening.
The new command has an explicit native-unavailable browser mock handler.

Three native regressions cover deleted-map discovery and snapshot readback,
cross-vault name isolation, invalid/traversal record suppression, changed records
and stale openings. Targeted native checks passed 86 tests. Full Rust passed
2,699 library and 28 integration tests (42 ignored overall); the library suite
took 65.07s. Final formatting and diff checks passed. The initial strict
Clippy run rejected an unused unit expression (`map_recovery_catalog.rs:62`);
removing it fixed the check without changing semantics. Frontend targeted tests
passed 25, and the full 404-file suite passed 6,478 tests in 79.46s. TypeScript/build
passed, with Vite taking 14.83s. The first lint run raced a Vite temporary config
file (`ENOENT` in `eslint-helpers.js:1305`); after stopping Vite, lint passed with
zero errors and the two existing notch hook dependency warnings. Logs use
`/tmp/myco-map-catalog-*`, with failed logs retained separately from final logs.

Ego-browser used the actual History page with synthetic IPC and an empty file tree.
Discovery found the retained-only map, keyboard expansion displayed its snapshots,
and the current-file read count remained zero. The incomplete-list warning,
retryable catalog error and same-path reopen reset were checked. Light/dark
320/375/768/1280px observations showed no horizontal overflow. Screenshots:
`/tmp/myco-deleted-map-{dark-320,light-1280}.png`. Theme-switch captures include
transition colors and do not establish settled WCAG contrast. The browser task
was finished and its Vite process stopped. This is not installed/native combined
acceptance.

README documents discovery and bounds. Restoring maps, repairing corrupt records,
inspection when parent directories have also been removed, safe undo, chronology,
model meaning and Windows/installed gates remain open.

## November 11: retained map records in History

History now offers **Retained map records** for the selected existing map, separate
from its latest update. The disclosure loads native snapshots only when opened.
Each record states current-file association, unknown publication or invalid data;
stored before/after text is escaped and never interpreted as HTML. Missing older
snapshots and invalid records have explicit explanations. There is no restore,
delete or undo control and no implied chronological ordering. English, Korean and
Japanese strings use the existing theme and localization system.

The loader validates the returned map path, bounded record count, unique record
IDs, known evidence labels and nullable text contract. Cancellation, vault switches,
same-path reopen and opening-in-progress suppress late success and error responses.
Changing map/opening remounts the disclosure, dropping prior selection and content.
The browser mock explicitly rejects this native command instead of inventing
custody. README documents the user-facing entry point and limitations.

The initial type check exposed an insufficiently discriminated idle/loading union
(`TS2339: Property 'snapshots' does not exist`); splitting those variants fixed
the narrowing. Targeted checks passed 20 tests. The first full suite failed the
command parity check because `retained_map_snapshots` lacked a mock handler
(`devMock.parity.test.ts:77`, one failed, 6,469 passed). Adding the explicit native
capability rejection fixed it; final full frontend validation passed all 404 files
and 6,470 tests in 60.91s. Final TypeScript/build passed; Vite took 11.32s
(`/tmp/myco-recovery-ui-build-final.log`). Lint has no errors and the two existing notch hook
dependency warnings. Logs: `/tmp/myco-recovery-ui-{target,full,full-final,lint-final}.log`.

Ego-browser inspected the actual History page with isolated synthetic IPC responses,
not a native application receipt. Keyboard Enter opened the disclosure and made
its first read; empty/error/reload and same-path reopen reset were checked. Both
themes at 320/375/768/1280px had no horizontal overflow; summaries were at least
44px tall. Script-shaped text remained text with no script node. The first wait
failed when background mock tree refresh removed the synthetic map; fixing the
fixture's listFiles/refresh behavior allowed the keyboard check to complete.
The narrow screenshot was inspected again after closing the sidebar drawer:
`/tmp/myco-recovery-dark-320-confirmed.png`; desktop:
`/tmp/myco-recovery-light-1280.png`. The task space was finished and Vite stopped.

Deleted maps are absent from the file selector even though their records can be
inspected by the native API. Deleted-map discovery, safe retry/undo, corrupt-record
repair, full chronology, VoiceOver and installed/native combined acceptance remain
open. This UI does not pass model meaning or Windows acceptance gates.

## November 11: opening-bound retained map snapshot API

`retained_map_snapshots` now exposes a bounded read-only inspection path for the
selected map's private observations. It holds the current vault opening through
dispatch and returns stored before/after snapshots with `currentObject` or
`publicationUnknown` evidence. A current-object identity match does not approve
the snapshot's meaning, current text or source validation. Stable invalid schema,
scope or baseline records return `invalidRecord` without their text. File I/O,
privacy, anchor and concurrent replacement failures abort the entire query.

The reader reuses the existing observation schema/scope/hash validator. Existing
refresh authority still requires its retained record, native pin and unchanged
owned sections; the display API returns none of those capabilities. It checks
private store placement, canonical map paths, non-symlink parents and native
anchor identities, retains opened record handles, then rechecks all records,
anchors, parents, target and directory before returning. It reads at most 4,096
entries, 256 matching snapshots and 32 MiB of matching record bytes. Results sort
by opaque ID and make no chronological claim. Missing custody stores return an
empty list; supported native custody remains Unix-only.

Tests cover creation/current evidence, absent current-file uncertainty, corrupt
record text suppression, cross-vault scope isolation, path traversal rejection,
stale same-path openings, record and target replacement races, symlink parents and
the 256-record limit. The interrupted-then-two-successful-updates process test now
starts a sixth process using the new API: both the never-published attempt and
superseded successful update remain `publicationUnknown`, with before-images and
human annotations intact. The current record alone matches the current object.

Full Rust validation passed 2,696 library and 28 integration tests, with 42 ignored
overall; the library suite took 63.33s. The initial targeted run passed 81 tests
before the final two regression additions, which then passed in the full suite.
Final formatting, diff checks and strict all-target Clippy also passed; the final
Clippy log is `/tmp/myco-map-recovery-final-clippy.log`.
Logs: `/tmp/myco-map-recovery-{target,full,clippy}.log`. README documents the new
native command and status semantics. No frontend behavior changed; recovery UI,
safe retry/undo, corrupt-record repair, full chronology and model/Windows/installed
acceptance remain open. Next connect this API to the existing opening-bound map
History UI with explicit uncertainty labels and escaped snapshot text.

## November 11: recovery classification cannot infer unpublished state

A new native five-process regression runs creation, exit immediately before
canonical publication, fresh-process inspection of the unchanged map, then two
successful refreshes. It finds two noncurrent version-4 `refreshPrepared` records:
one for the never-published attempt and one for the first successful refresh that
the second refresh superseded. Both have the same state label and neither matches
the current canonical object's identity. The latest map, human annotation and
synthetic source remain intact. The test passed in 0.46s; strict all-target Clippy
passed. Logs: `/tmp/myco-map-recovery-classification{,-clippy}.log`.

This directly rules out classifying every noncurrent preparation as unpublished.
The recovery view must distinguish current-object evidence, independently recorded
publication evidence, and unknown publication state. Existing version-4 records
without such evidence must retain the unknown state; a missing completion marker
cannot prove that replacement never occurred. Future publication observations
would also have a crash gap after replacement and before recording, so they could
prove observed publication when present but not nonpublication when absent.
Matching content hashes or filesystem timestamps must not substitute for native
object identity or establish chronology across human edits.

The next recovery implementation should expose retained snapshots and uncertainty
through an opening-bound read-only path before offering retry or undo. It must
not mint write authority from those records, delete uncertain attempts, or report
a complete ordered timeline from the current schema. No recovery UI or mutation
was added by this regression; G5 recovery, full history and undo remain open.
README is unchanged because product behavior is unchanged.

## November 11: actual minimal prose reading still fails action fidelity

The [prose-reading contract](2026-11-11-request-prose-reading.json) keeps all
seven original strings, speakers and semantic labels. It asks the cached model
to describe activity type and performer in short prose, using the existing
grammar-free QA entry point and grounded numeric sampler. This reuses the
registered fixed 768/4096 generation limits; it adds no production decoder or
model selection path. A regression checks that the input contains only the exact
original and speaker, with no expected labels.

This deliberately changes the system prompt, payload and grammar together to
test whether basic interpretation is available in a smaller task. It cannot
attribute a difference to any one component. Prose carries no native claim
binding, review approval or publication authority. The whole compiler and all
original extraction controls remain required even if these judgments succeed.

Runner `42db3c02` completed seven actual offline generations with the pinned
cached model and isolated synthetic state. All 16 records are retained in the
receipt. Complete source-based review matched R5/R6/R7 only. R1 correctly named
a request and unknown performer but changed requesting a report into generating
one. R2 likewise substituted report generation and did not preserve the explicitly
named assistant performing the request. R4 recognized future intent but again
substituted generation and assigned an unknown performer instead of the assistant.
R3 correctly described the assistant's past request, then asserted without evidence
that report generation/analysis had not been completed. Partial recognition does
not compensate for unsupported additional claims.

These errors occur without JSON grammar or a provenance payload in this run, so
the complex extraction format is not required for action substitution or invented
noncompletion. This does not establish a single cause, model-wide incapacity or
repeatability. No prose fallback or prompt was promoted. Further semantic review
must explicitly preserve the described action and its actor and reject unsupported
outcome assertions; existing extraction/full-compiler gates remain unchanged.

Validation: ten request QA tests passed (six opt-in tests ignored), five existing
prose-sampler tests passed, strict feature all-target Clippy and formatting passed.
Actual generation passed its transport-only assertion in 210.74s, with 213.81s
wrapper wall time and 3,036,807,168-byte maximum RSS. Every output includes real
prefill/sampling telemetry. README is unchanged because product behavior is unchanged.

## November 11: actual vocabulary diagnostic failed meaning gates

The [paired vocabulary controls](2026-11-11-request-vocabulary-controls.json)
replace only "synthetic report" with "inventory report" in five originals and
their expected action objects. R5/R7 remain unchanged negative controls. A
model-free regression checks every candidate field against that substitution,
including the original hash; actor, tense, speech-act/status and verification
labels are unchanged. The existing seven-case fixture is untouched.

The opt-in native runner now rebuilds source preparation, revision and packet
bindings independently for each arm. The vocabulary arm retains the exact baseline
system prompt, payload ordering, model, grammar and sampler. The
[comparison contract](2026-11-11-request-vocabulary-comparison.json) is frozen
before generation. Source-derived span IDs and byte coordinates necessarily
change with the source text. Capture paths still contain synthetic labels, so
this experiment tests phrase sensitivity, not all possible harness effects.
Neither these controls nor model-free tests establish actual model quality.

Runner `11510ee6` subsequently completed all 14 actual offline calls using the
pinned cached model, network denial and isolated synthetic state. All 44 records
are retained in the comparison receipt, with source-based review of every output.
Native transport/binding passed. Baseline matched only R5/R7; vocabulary candidate
matched R5/R6/R7. No candidate or production source rewrite is accepted.

The inventory wording caused R1-R3 to produce claims where the baseline abstained,
but R1/R2 assigned the requesting user as performer. R1 requires unknown actor;
R2 explicitly names the assistant and requires its supporting subject span.
R3/R4 retained assistant attribution but classified the past report and future
plan as request/requested. Their action paraphrases were acceptable; their meaning
labels were not. Thus all four positive controls failed in both arms. This single
run observes phrase-sensitive outputs, not a proven cause or repeatable improvement.
Changing test nouns cannot stand in for supporting the original task semantics.

Validation: nine model-free QA tests passed (five opt-in tests ignored), strict
feature all-target Clippy and format checks passed. The actual native test passed
its transport-only assertion in 472.35s; wrapper wall time was 475.56s and maximum
resident set size 3,222,011,904 bytes. Every output has real prefill/sampling
telemetry. The first formatter invocation used the repository root and reported
`could not find Cargo.toml`; rerunning in `app/src-tauri` passed. README remains
unchanged because this diagnostic changes no product behavior.

The next useful model diagnostic should isolate a minimal source-grounded semantic
judgment from the full extraction payload, to distinguish basic interpretation
from schema/prompt interaction. Keep all original controls and labels. A simplified
diagnostic cannot authorize publication or replace full extraction, three repeated
critical cases, full-compiler, Windows or installed acceptance.

## November 11: actual source-first input comparison rejected

The [source-order receipt](2026-11-11-request-source-order-comparison.json)
retains all 44 native records and individual semantic reviews from 14 actual
offline calls at runner `f21294a9`. The candidate puts original text and speaker
before packet metadata. Every parsed input pair is equal, and the system prompt,
model, grammar and sampler are unchanged. Nested metadata key order is also
canonicalized; this experiment does not isolate a single field move.

Native generation and binding succeeded, but meaning acceptance failed. Baseline
matched R5/R7; candidate matched R5/R6/R7. Both omitted R1/R2 requests. Candidate
classified R3's past report as request/requested and omitted R4's future plan;
baseline omitted R3 and classified R4 as request/requested. Correct abstention
on negative controls does not compensate for missing positive activity. No
production prompt or input representation was changed.

All outputs include actual prefill and sampled-token telemetry. The network-denied
run used the pinned cached 4B artifact and an isolated synthetic state directory.
Native test time was 423.23s, wrapper wall time 426.39s, and maximum resident set
size 3,190,767,616 bytes. The model-free QA group passed eight tests (four ignored),
the payload-equality regression passed, and feature all-target strict Clippy
passed. The runtime command, artifact hashes and raw log hashes are in the receipt.
README needs no change for this test-only diagnostic.

Input order alone did not repair the frozen controls. One unproven next hypothesis
is interaction between the source word "synthetic" and the system's exclusion of
test-harness chatter. Diagnose that with additional paired fictional sources,
keeping the existing controls and labels unchanged, before attributing failures
to model capacity or promoting another instruction change. Three repeated
critical cases, full-compiler meaning, Windows and installed acceptance remain
open; this single comparison does not satisfy those gates.

## November 11: stage complete custody records before publication

Direct writes to the final JSON leaf could expose a truncated observation if the
process exited during record writing. Both creation and refresh preparation now
share a bounded private record writer: write/sync a `.map-record-*.tmp`, verify
held/named identity, private-file metadata and exact staged bytes, then publish without clobbering the
final name, sync the directory and compare the retained handle and bytes again.
Staging names are outside observation discovery's scope/generation JSON pattern.
Existing final records are preserved; final-name collisions still fail closed.

The installed tempfile implementation was inspected before using its APIs. Its
no-clobber operation may fall back to link/unlink on unsupported filesystems;
there is no universal atomicity or power-loss claim. A retained extra link is
still rejected by the existing single-link record verifier. Interrupted staging
and failures retain private temporary paths; automatic cleanup is deliberately
not granted over a potentially replaced pathname. Existing corrupt final JSON
records are not silently skipped or deleted.

Tests cover complete publication, collision preservation, rejected staging-path
replacement without deleting the replacement, unexpected trailing staging bytes
rejected before final-name publication, and a fault-injected partial
staged write followed by process exit and a fresh-process read. A separate map
observation test proves a partial `.tmp` does not poison discovery of the valid
current map. The first targeted run exposed a validation-order bug in the new
writer (`map_custody_record_tests.rs:191`, `assertion failed:
error.contains("staging object changed")`; 75 passed, 1 failed). Corrected the
order and disabled temporary-path cleanup on all writer failure paths instead of
weakening the test. Baseline log: `/tmp/myco-map-record-staging-target.log`.

This prevents new truncated staging writes from appearing as final observations.
Repairing already corrupt JSON, safe pending-file cleanup, unpublished-attempt
review, undo, Windows and actual-model acceptance remain open.

Final validation: 77 targeted map tests passed (3 child-only ignored); Rust fmt
and strict all-target Clippy passed. Full Rust passed 2,690 library and 28
integration tests (42 ignored overall), with the library suite taking 61.39s.
Frontend source did not change, so frontend checks were not rerun. Final logs:
`/tmp/myco-map-record-staging-{verified-target,verified-clippy,verified-full}.log`.
The next independent priority is the failed actual-model speech-act/actor meaning
gate; this storage improvement does not stand in for grounded LLM Wiki behavior.

## November 11: durable preparation before map replacement

Map refresh now uses a native pre-publication observer after the staging file and
its private hardlink have been synced and physically matched. The observer writes
and syncs an immutable version-4 `refreshPrepared` record with the staged file's
native identity and exact before/after snapshots. A record failure stops before
canonical replacement. After the observer returns, the writer rechecks staged
handle/path/anchor identity, the old target pin and revision, and parent identity.
The default writer API retains a no-op observer for existing callers.

Readback accepts version 4 only with a valid previous snapshot and all existing
scope, revision, native object, anchor and private-record checks. It still selects
records by the current canonical inode; an unpublished staged object is not a
completed update. Existing version-1/2/3 records remain supported. After writing,
the map flow rechecks the held preparation record and observed canonical bytes,
then verifies sources and the native receipt before returning success. No undo
or old write permission is restored from the preparation JSON.

The fresh-process map test first exits after preparation but before replacement:
a new reader sees the old map and no completed History entry for the candidate.
It then retries from another process, exits inside the native writer immediately
after canonical persist (before receipt return and later sync/check steps), and
reads the exact before/after History snapshots including human text in a new
process.
A native fault test also checks preparation persistence failure and staged-byte
mutation: both reject before replacing the old canonical file. The test-only
checkpoint hook is thread-local and absent from production builds.

This closes the observed post-replacement/pre-observation process-exit gap.
It does not establish power-loss durability, repair partial/corrupt private
records, expose unpublished attempts, provide undo, or pass Windows/actual-model
acceptance. Existing SIGKILL tests still cover physical preservation separately.

Validation: map refresh tests passed 8 cases, the preparation failure/mutation
regression passed, and the five-process pre/post-replacement scenario passed in
0.34 seconds. Final Rust formatting and strict all-target Clippy passed; full
Rust passed 2,685 library and 28 integration tests (41 ignored overall) with the
library suite completing in 57.20 seconds. Frontend source/IPC contracts did not
change, so frontend tests were not rerun. Logs:
`/tmp/myco-map-prepared-{restart,fault,both-boundaries,final-clippy,final-full}.log`.

## November 11: process-kill evidence at native replacement boundaries

The previous source-check interruption case ran after native writing returned.
New controls now stop the writer process at its real `Pinned` and `Persisted`
checkpoints, then the parent sends SIGKILL and verifies that signal status. No
receipt or tempfile destructor runs. A different fresh process inspects bytes,
inode identities and link counts afterward. All fixtures, including `raw/`, are
synthetic and isolated; these tests do not touch an owner vault.

Observed in both cases: immutable raw content and the human annotation survived,
and distinct private anchors retained both old and new content. Before canonical
replacement the old canonical object remained (two links); immediately after
replacement the new object was canonical (two links) and the old anchor remained
(one link). The staged candidate's anchor had two links at both checkpoints.
The target regression passed both child-kill/inspection sequences in 0.24 seconds.

This confirms process-crash byte preservation at two specific boundaries. It is
not power-loss/fsync durability, Windows acceptance, a map manifest association,
an issued recovery/undo permit or an app-level successful update. Current map
observation discovery still requires a record matching the current file object,
so an interrupted writer can preserve bytes without making History readable.
The next recovery implementation must retain that association before publication
and expose uncertain attempts separately, without accepting replaceable anchor
names alone as ownership. Updated the stale G5 package/next-action descriptions
below so already implemented custody and refresh are no longer listed as new work.
Validation: Rust formatting and strict all-target Clippy passed; the full suite
passed 2,683 library and 28 integration tests (41 ignored overall, including the
new child-only entry point invoked by the parent regression). Logs:
`/tmp/myco-pin-process-kill-{target,clippy,full}.log`. No production behavior or
README usage changed in this test-only slice; frontend checks were not rerun.

## November 11: retain observations across post-write source failure

A regression against `6ec17014` demonstrated that a source check failing after
canonical replacement returned before saving its private observation. History
then failed at `map_refresh_apply_tests.rs:346` with
`no creation observation matches the current map object` (test exit 101;
`/tmp/myco-map-failed-refresh-baseline.log`). The map bytes were preserved but
its exact before-image was unavailable to the current-object history reader.

The refresh path now records the verified native-written bytes before the
post-write source check. It still checks sources before writing and before
returning success, checks the target revision/physical custody, and reports
post-write failure as retained incomplete output. The record never certifies
source validation or grants undo authority. History copy in all three languages
now makes this distinction explicit.

The regression checks history after the failed source check. A separate
three-process test creates an annotated synthetic map, exits the refresh child
with code 23 at the post-write source-check boundary (without a successful return
or stack cleanup), and reads the exact snapshots in a new process. This tests one
specific interruption boundary, not arbitrary crash recovery. Interruption inside
the anchored native writer or private-record persistence remains unresolved;
full history, safe undo, cleanup and actual-model acceptance remain open.

Validation: targeted native refresh tests passed 7 cases (1 child-only ignored);
full Rust passed 2,682 library and 28 integration tests (40 ignored overall).
Formatting and strict all-target Clippy passed. Targeted frontend tests passed
21 cases; production TypeScript/Vite build passed, lint had only the two existing
notch dependency warnings. Full frontend passed 402 files / 6,457 tests in
59.45 seconds. Logs: `/tmp/myco-map-failed-refresh-{baseline,target,clippy,full,front,front-full,build,lint}.log`.

## November 11: latest map refresh in History

History now reads the retained native before/after API on map selection, rather
than fetching every map snapshot. It labels missing legacy history separately
from errors, offers Reload, and discloses later edits and the absence of undo/full
timeline. Korean, English and Japanese copy follow the existing strings table.

The observation loader rejects mismatched origins/paths and drops late results
when cancelled, reopening or switching vaults. The section remounts for each UI
opening, and selected-key-bound results cannot be shown under another map.
Presentation uses labelled plain-text snapshots (escaped, without Markdown HTML
execution), scrollable keyboard-focusable regions, and one/two responsive columns.

Targeted synthetic tests passed 9 cases. The first full frontend run found one
new Korean glossary violation (`i18n.glossary.test.ts:79`, the English word
`vault` in `map_history_no_maps`); corrected it to the established `볼트` term,
without weakening the test. The final full run passed 402 files / 6,457 tests
in 56.45 seconds; production TypeScript/Vite build passed. Lint retained only
the two existing notch warnings. Logs: `/tmp/myco-map-history-ui-{target,full,final,lint,build,tsc}.log`.

Ego browser checked the actual History page with explicitly synthetic IPC data,
not native custody: light/dark widths 320/375/768/1280 had no horizontal overflow;
select/reload controls measured 44px high. Inspected wide-light and narrow-dark
screenshots; selection → Reload keyboard focus worked. Empty legacy history,
retryable error and same-path reopen clearing old errors/selection were observed.
A mock file-tree poll initially replaced the injected fixture; stabilizing that
fixture and reapplying it after HMR allowed the checks to finish. Screenshots:
`/tmp/myco-map-history-light-1280.png`,
`/tmp/myco-map-history-320-confirmed.png`.
This does not establish installed-app, screen-reader, native Windows, actual-model
or full History/undo acceptance. No native Rust source changed in this slice.

## November 11: retained map refresh before-images

The private refresh schema now records the exact pre-write content and its hash
alongside the merged result (version 3). This preserves human titles and outside
annotations in both snapshots. Serialized record size is checked before replacing
the map, including JSON escaping overhead. Identical-content refreshes remain
no-ops and do not manufacture a new history event.

`latest_map_refresh_history` is a read-only, opening-bound native command with a
typed IPC adapter. It discovers the current physical map's retained record and
returns its before/after snapshots plus whether current bytes differ from the
recorded result. It grants neither update nor deletion authority. Version-1/2
records remain readable but return no before-image rather than invented history.
Malformed or hash-mismatched version-3 previous snapshots fail closed.

Synthetic native cases cover fresh-process history readback, subsequent human
edits, stale openings, invalid keys, legacy/missing/corrupt before-images and a
JSON-escaped two-snapshot budget overflow that leaves the map untouched.
Validation: targeted refresh tests passed (6 passed, 1 child-only ignored),
IPC/parity tests passed (6), TypeScript passed, strict all-target Clippy passed,
and lint reported only the two existing `notchDriver.ts` hook warnings. The first
full frontend run had 6,449 passes and one timing failure during concurrent Rust
compilation: `Editor.test.ts:83`, `expected 253.1284169999999 to be less than 250`.
The threshold and implementation were not changed; this failure is retained here.
After Rust finished, the standalone Editor suite passed all 6 tests. Full Rust
verification passed 2,681 library and 28 integration tests (40 ignored overall),
including the schema and byte-budget regression cases. Formatting passed.
The full frontend rerun without concurrent Rust compilation passed all 400 files
and 6,450 tests in 53.79 seconds. Production `npm run build` passed
(TypeScript and Vite; existing mixed-import warnings retained). Build log:
`/tmp/myco-refresh-history-build.log`. Other logs: `/tmp/myco-refresh-history-{target,clippy,full,front-full,editor-recheck,front-recheck,lint,tsc}.log`.

This is an API/storage slice: History UI, multi-event browsing, undo, interrupted
writes and record cleanup remain incomplete. No installed UI, Windows or actual
model acceptance is claimed by these tests.

## Environment and isolation

- Host: macOS ARM64, 16 GiB RAM; Node `v24.13.0`, Rust `1.95.0`.
- Original checkout dependencies refreshed with `npm ci --no-audit --no-fund`.
- Existing prepared Qwen3.5 2B/4B GGUFs found in the application model directory;
  only model artifact metadata/bytes are inspected. No user vault or settings are
  used as fixture input. No new weights downloaded or provider defaults changed.
- Native compiler witness uses `with_isolated_data` and a temporary synthetic
  source fixture. It requires `native-index-probe`; compiling without the feature
  would not include the opt-in witness.
- Windows inventory: no repository self-hosted runners, no discovered local
  Wine/Parallels/QEMU command, and only the macOS ARM64 Rust target installed.
  Hosted CI would require an authorized code publication/run; none was started.
- Installed UI automation did not start: the selected command
  `orca skills get computer-use --json` failed with exit 127,
  `zsh:1: command not found: orca`. The computer-use skill requires:
  "If the selected executable cannot run, report its exact error and stop."
  Its no-fallback instruction was followed. Independent native model and browser
  mock checks continued; neither substitutes for installed UI acceptance.
- During native test-binary discovery, a worker mistakenly ran
  `target/debug/deps/myco-a039cf6e69b34e01 --list | rg 'map_sources|generic_map_publication'`
  and the corresponding `myco-f8cdebeaf4f0db08` command. These were app entry points,
  not library test runners. The session was stopped with Ctrl-C, exit 130.
  Output twice reported `settings unavailable: refusing to resolve the real
  app-data directory from a test binary: set MYCO_DATA_DIR; using unauthorised
  local defaults for display only`. Source inspection confirms that the `deps/`
  guard rejects platform data-directory resolution before creation/migration.
  No live vault or app-data inspection was performed to claim a complete
  before/after comparison. Subsequent commands use the exact `myco_lib` runner.

## Verification receipts

| Command / artifact | Result | Evidence level |
| --- | --- | --- |
| `node app/scripts/local-wiki-eval-run.mjs --split development --suite all --output /tmp/myco-goal-g0-fixture-receipt` | Valid frozen fixture; 160 selected cases. Receipt explicitly reports `inferenceExecuted:false`. | Fixture integrity only |
| `node --test app/scripts/local-wiki-eval-test.mjs` | 12 passed, zero failures. | Fixture integrity only |
| `cargo test --locked --features native-index-probe --lib cached_model_runs_native_source_bound_compilation --no-run` | Passed; 6m 32s build. | Build only, no inference |
| `target/debug/deps/myco_lib-3dfb3868fc32d18b --test-threads=2` | 3,055 passed, zero failed, 54 ignored; 132.27s. | macOS native library, feature `native-index-probe`; not integration/doc/installed acceptance |
| `npx vitest run --maxWorkers=2 --minWorkers=1` | After map retrieval/citation corrections: 389 files / 6,341 tests passed; 170.68s. Final cluster-label isolation follows this run. Earlier stable run: 6,335 passed. | Frontend unit/contract |
| `npm run lint` | Zero errors, two existing `notchDriver.ts` hook warnings. | Frontend static checks; final cluster-label patch has separate checks |
| `npm run build` | Passed again after final cluster-label isolation: TypeScript and Vite production build (10.84s). Existing `uiStore` static/dynamic import warning. | Final production build |
| `node app/scripts/ingest-draft-smoke.mjs` with loopback test URL | 16 checks passed; navigation, reload, two-vault isolation, storage failure/retry and completion revisions. | Synthetic browser IPC/store outcomes; no native ingest/model |
| Same draft smoke against untouched `121c0fa2` review worktree | Failed at `query: title retained` (`AssertionError: false == true`). Initial manual reproduction preceded implementation; automated baseline comparison ran afterward. | Browser regression, baseline worktree remained clean |
| Targeted G2 suite | 389 tests passed across four files after seven reproduced regression failures. | Scope/period/follow-up unit contracts |
| Contrast/i18n suite | 53 passed; prior token values failed nine contrast combinations. | Opaque neutral background ratios, not every composited UI surface |
| `cargo fmt --all --check` | Passed. | Native formatting |
| `cargo clippy --locked --all-targets -- -D warnings` | Passed after equivalent `Option::is_none_or` expressions replaced eight baseline diagnostics exposed by Rust 1.95 (seven library sites, one example site). | Native static checks; no lint suppression or safety-check removal |
| `cargo test --locked -- --test-threads=2` | Passed: 2,619 library and 28 integration tests; 38 ignored across targets. Main/doc targets contained zero tests. | Default native suite on macOS; ignored actual-model and platform cases are not counted as passed |
| Targeted map/chat suite | Final 197 tests passed across four files. Three regressions failed before retrieval/citation correction; two more failed before cluster label isolation. Final targeted ESLint and TypeScript also passed. | Actual `draftMap` → `complete` → local/HTTP IPC boundary with synthetic model responses; no actual inference |

Verified SHA-256 values before inference:

- Existing corpus manifest: `445b06f5ca5664042edf9f26a5ed549ce619aa0e1c8c9301db87ec801da88b2b`.
- Qwen3.5 4B: `25082a7dd3776cc3c741c6347d3bd04523f05796607b3fbc32fa3a25dfa1418c`.
- Qwen3.5 2B: `0bfe35afc9f05b7fac3fa04925e051ac7939a42a8a17ea11afc99701bea826cc`.

Both cached model hashes match their pinned source manifests. This verifies
artifact identity only, not model quality. The native build includes concurrent
G3 working-tree repairs; record it as baseline plus a dirty patch, not untouched main.

## Actual-model baseline: failed, original preserved

The [durable receipt](2026-11-10-native-compiler-baseline.json) retains all 14
native compiler JSON records: exact prompts, model manifest, outputs, telemetry,
checkpoints and terminal rejection. Metal diagnostic noise is omitted. It also
records hashes of the native working-tree changes included in the debug build.

The existing pinned Qwen3.5 4B artifact was run under `sandbox-exec` with all
network operations denied. Six actual generation calls occurred. The preamble
correctly yielded no activity; the user request was omitted as insufficient
evidence and its review returned uncertain coverage. The assistant's plan yielded
one planned claim, but the structure call returned an empty title and claim list.
Native validation rejected it before summary publication:

```text
thread 'session_compile::execution::tests::model_tests::cached_model_runs_native_source_bound_compilation'
panicked at src/session_compile/execution_model_tests.rs:159:5:
actual native compiler did not complete:
session structure identity, title or coverage is invalid
test result: FAILED. 0 passed; 1 failed
```

`RUST_BACKTRACE` was not enabled, so no stack backtrace was captured. The source
SHA remained `f95f310d45a6347224480fac2b57e2a134aa5c477bfbc29afbeef3805f356400`;
no summary was published. Wall time was 392.54s and maximum resident set size
3,173,793,792 bytes, including slow debug artifact hashing and preparation. These
are not release latency numbers. `nativeCompleted`, `semanticAccepted` and
`productionAccepted` are false. This did not exercise Wry or an installed app.
No favorable retry, label change, validator relaxation or mock substitution was
used. Diagnose extraction omission and empty structure separately before another
generation experiment.

## Frozen structure comparison and v9 correction

The [structure-only A/B receipt](2026-11-10-structure-prompt-comparison.json)
retains all eight JSON records from two actual offline 4B calls. Its SHA-256 is
`174b6aa5fd20f0ebc46d85f73072807bb3ceac16098b334b5d2cb1b17d18f427`.
The QA harness verifies the frozen baseline receipt bytes, reconstructs packet 2
and its native claim, and checks the exact recorded payload, grammar, model,
tokenizer, sampler and 768/4096 output/context budgets. The baseline prompt is
replayed from the receipt, so later product changes cannot silently alter the
control arm.

The unchanged prompt again returned an empty title and claim IDs and failed the
unchanged validator. Replacing only its empty-case guidance produced
`Draft synthetic report plan`, citing `C-2-0-1a7e5f8260c2aa7d`. The native
materializer retained assistant / plan / planned / unknown event time / no
verification. Coordinator and separate worker inspection found no new completion
claim in this single title. This is not full-source semantic acceptance: no
extraction, full-source review, whole-compiler or installed attempt ran in this
comparison. Both arms and the failed baseline remain recorded.

The test passed in 232.16s; process wall time was 232.27s and maximum resident set
size 3,184,476,160 bytes. This includes debug artifact hashing and model loading;
individual generation attempts took 10.55s and 13.66s. These are not release
performance numbers. The source snapshot was parent `72785222` plus the recorded
QA files in a shared dirty tree; a complete prebuild tree hash was not captured.

The observed candidate prompt was then promoted unchanged. Its SHA-256 is
`f9a5d6d2e9e87be7ca6835daebc900add458a52aa4f981697843e3e31d314036`.
The sole production structure caller already skips generation for empty claims;
empty structure is rendered by application code. The compiler/prompt contract
was advanced to v9 so v8 completions and checkpoints require fresh admission.
Three pre-fix regressions failed; the complete compiler test group then passed
226 tests with 8 opt-in tests ignored. Original sources, human writing, historical
receipts, grammar and validation rules were preserved. The full v9 witness below confirms that
this correction does not solve the recorded extraction omission by itself.

## Full v9 actual-model witness: partial, no publication

The [v9 native receipt](2026-11-10-native-compiler-v9.json), SHA-256
`87ed58240cefa34a2c256765aacefbed25126fbaf917536ecd6c237546591d52`,
retains all sixteen JSON records and the captured Rust backtrace. It records
commit `ff809a43`, the native source-tree object and executable SHA-256; native
sources were clean before launch. Only documentation was uncommitted.

With the same pinned 4B artifact and all network denied, seven generation calls
visited all three original packets once. The assistant plan produced the same
nonempty title and bound ID as the comparison; its source-bound title/summary
review passed. The user request again yielded no claim, and that packet's review
reported uncertain coverage. Native finalization correctly retained `partial`
with reason `native_compilation_or_review_incomplete`; no summary or publication
receipt was created. Before/after original SHA-256 remained
`f95f310d45a6347224480fac2b57e2a134aa5c477bfbc29afbeef3805f356400`.

The positive completion test **failed**, exit 101:

```text
thread 'session_compile::execution::tests::model_tests::cached_model_runs_native_source_bound_compilation' panicked at src/session_compile/execution_model_tests.rs:159:5:
actual native compiler did not complete: None
stack backtrace:
   0: __rustc::rust_begin_unwind
   1: core::panicking::panic_fmt
   2: myco_lib::session_compile::execution::tests::model_tests::cached_model_runs_native_source_bound_compilation
             at ./src/session_compile/execution_model_tests.rs:159:5
```

`None` denotes no thrown step error; the recorded terminal state is partial,
which fails the test's required completed outcome. The full captured backtrace
is in the receipt. Test time was 277.15s, process wall time 277.21s and maximum
resident set size 3,267,870,720 bytes, including debug hashing and preparation.
This is progress past the original structure error, not positive source
compilation or semantic/production/installed acceptance. There was no favorable
retry, changed fixture or relaxed validator.

## Frozen request comparison: candidate rejected

The [request-only A/B receipt](2026-11-10-request-prompt-comparison.json), SHA-256
`511e729a7be6ac653cd35128cf9be0a214cecb8edd2347ce796d36ef52d36454`,
retains all eight JSON records and the failure backtrace. The harness binds the
unchanged v9 receipt, packet 1, model artifact, grammar, sampler and 768/4096
output/context budgets. The copied test executable and three QA source hashes
were captured before execution; concurrent workstream/map changes were present,
and no complete prebuild tree hash was captured.

Two actual offline extraction calls ran, once per arm. The original was
`Please request the synthetic report.` The baseline again returned no claims.
The candidate added concrete-request guidance and produced
`Request a synthetic report`, request/requested, unknown time and no verification.
It bound the original citation, but assigned the requested action to
user/speaker. The frozen label requires an unknown performer: the original
identifies the requester without naming who performs the requested action.
The narrow action-text comparison also differs in its article; the actor error
independently prevents acceptance. The coordinator and a separate worker reviewed both raw outputs
against this original; no independent model review ran.

The test **failed**, exit 101, at `request_prompt_qa_model_tests.rs:125`:

```text
retain both outputs: request candidate failed native binding or the narrow frozen expectation; inspect raw output for meaning
stack backtrace:
   0: __rustc::rust_begin_unwind
   1: core::panicking::panic_fmt
   2: myco_lib::session_compile::request_prompt_qa::model_tests::cached_model_compares_frozen_request_prompts_once_per_arm
             at ./src/session_compile/request_prompt_qa_model_tests.rs:125:5
test result: FAILED. 0 passed; 1 failed
```

Both outputs passed structural source binding; that did not establish correct
meaning. Test time was 310.03s, process wall time 313.30s and maximum resident
set size 3,069,313,024 bytes, including debug hashing and model preparation.
These are not release performance figures. The candidate was not promoted,
the gold labels and validator were not relaxed, and no favorable retry was run.
Standing-rule controls passed only model-free checks. Actual negative controls,
full-source review, whole-compiler completion and repeated semantic acceptance
remain required before a later extraction change can be accepted.

## Changes and remaining verification

- G1 adds `ingestDraftStore` with per-vault durable records and a revision token.
  Failed, cancelled and partial runs retain input; an older successful run cannot
  clear a newer draft. Async loaders belong to one vault opening. Eighteen new
  store tests and thirty existing page tests passed. Manual browser navigation/
  reload also retained exact synthetic text. Native restart is still unverified.
- G2 keeps wiki-only queries off the session workstream shortcut, shows guided
  project scope before submission, preserves the chosen scope, and discloses seven
  local calendar days for the recent overview. Empty periods stay empty. Follow-up
  dates/context survive only inside the same scope and selected-note path set.
- G3 adds `vault_path::relative_key` for already-confined source paths and uses
  portable separators in source scope checks. This is not a Windows file-identity
  implementation. Windows-specific tests were not run.
- G4 intersects project candidates with current ledger fingerprints, explicit
  paths and dates, then reuses original-bound activity resolution. Follow-ups and
  retries retain the selected project and explicit caller restrictions while
  rediscovering candidate paths and the current default period. Native initial originals are also
  filtered by the selected start and historical cutoff before model input, so a
  resumed transcript's later outcome cannot leak through its full-source closure.
  Malformed/ambiguous discovery, missing projections and changed facts/ledger
  cannot silently become an unrestricted search. Incomplete candidates stay
  visible. These contracts passed synthetic-generation tests; actual W1–W4 meaning
  remains incomplete. The v5 identity repair below addresses the reproduced
  basename collisions, with repository equivalence still open. The route covers
  recognized progress and guided remaining-work questions; general free-text
  remaining-work intent recognition is not complete.
- G5 supplies at most twelve member excerpts with full-file SHA-256 revisions,
  source size/character budgets and truncation metadata. The complete generation
  path receives no unrelated retrieval context for maps; other organization
  calls retain their existing retrieval behavior. Full relative-path citations
  prevent same-stem pages from redirecting a selected source. The bounded cluster
  label stays in the untrusted JSON packet, outside the static system prompt.
  Native bounded capture and publication checks now replace the separate
  frontend reread; their transaction and external-editor limits are described below.
  Existing maps remain pending rather than being overwritten. Unknown wikilinks
  are still stripped to plain text; factual assertions are not yet semantically
  verified.
- G6 raises `ink-3`/`ink-4` neutral-theme contrast and labels Reader/Settings loading
  by route. Returning-device Home is compact; Ask examples fill/focus the draft
  without submission. Successful imports prioritize actual changed-note review,
  readable titles and the source link, tied to the originating vault token.
  Observed file snapshots determine created/updated labels; otherwise the UI says
  changed. Partial imports retain Retry. The 769–820px Graph layout now scrolls
  for mouse and touch and retains fold restoration controls; its panels previously
  collapsed to 4.9px. Phone sheets preserve the saved desktop fold preferences.
  The [browser receipt](2026-11-10-ui-browser-review.json) retains viewport and
  sampled contrast observations and explicitly labels synthetic success fixtures.
  Home/Ask/Ingest were checked at 320/375/768/1280px; Graph at
  768/800/1024/1280px in both themes. Sampled small-text contrast was 5.40–11.84:1
  light and 6.37–10.98:1 dark; hovered links were 15.45/11.92:1. Keyboard examples,
  review/open-source links, fold/reload restoration and stale-vault result hiding
  passed. This is not exhaustive state, reduced-motion or screen-reader acceptance.
- Root English/Korean and app README descriptions now cover draft behavior and
  the actual scope/period policy, bounded new-map drafts and pending refresh.
  Root distillation copy now distinguishes immutable raw sources from eligible
  derived archives. Provider and remaining historical README claims
  still need the final G7 reconciliation.

The first full frontend attempt overlapped map implementation and failed thirteen
tests with three unhandled errors; the stable rerun above passed. The initial lint
run also found a new control-character-regex error, which was fixed without a
suppression. These earlier failures are retained in `/tmp/myco-goal-*` logs.

## Post-fix verification at ff809a43

| Gate | Result |
| --- | --- |
| Final `npx vitest run` | 392 files / 6,370 tests passed, 77.40s. Includes final ambiguous-project and Graph regressions. |
| Final lint, typecheck and production build | Passed. Two pre-existing `notchDriver.ts` hook warnings and the existing build import warning remain; Vite took 14.48s. |
| `cargo fmt --all --check` and strict default/feature all-target Clippy | Passed. Existing optional QA predicates exposed by Rust 1.95 were changed equivalently; no lint suppression or validation relaxation. |
| `cargo test --locked --offline` | 2,625 library + 28 integration tests passed; 38 ignored across targets. |
| `cargo test --locked --offline --features native-index-probe --lib` | 3,065 passed, 55 ignored, 75.01s. These overlap the default library suite. |
| Five changed probe example test targets | 99 passed, zero failed/ignored. No actual model calls. |

The first strict feature-library check exposed 12 existing `unnecessary_map_or`
diagnostics; all-target checking then exposed nine more existing Option/divisibility
diagnostics in examples. Formatting checks also caught the wrapping required by
these replacements. The final checks above passed after equivalent expressions
and formatting were applied. Logs are under `/tmp/myco-goal-integrated-*` and
`/tmp/myco-goal-final-*`; opt-in model tests are reported separately.

## Final boundary corrections and verification at 419ff64a

Independent code review reproduced two data-boundary defects after the initial
implementation. A project retry/follow-up treated discovered candidate paths and
dates as user restrictions, silently excluding a newly added reopening session.
Project selection now stores explicit restrictions separately and rediscovers
current candidates; historical cutoffs and explicit document filters remain.
A follow-up explicitly naming another project asks for a new selection instead
of answering the old one. Ten new store regressions and the related 375-test group
passed; the frozen source labels were not weakened.

The import report action also lacked the same vault-opening guard as note/source
links. Four of five real-page SSR tests failed before the one-condition fix; all
five now pass with synthetic store receipts. This is render-level evidence, not
an OS file-open or native publication test.

Local import results previously unioned confirmed writes with every concurrent
wiki mtime change. Two reproduced failures showed an unrelated human edit in the
review list and a false success when the local pipeline returned no writes. Local
results/validation now use only the supplied confirmed write set, including an
empty set. Mtime snapshots only classify those pages. Receipt-less legacy provider
paths retain their existing whole-vault fallback; they are not reactivated or
accepted as source-attributed workflows by this change.

Final integrated `npx vitest run` passed **393 files / 6,387 tests** in 77.53s.
Full lint, TypeScript and production build passed; the same two existing hook
warnings and import warning remain, and Vite took 22.89s. Native code is unchanged
from the previously checked source tree, so its default/feature/example counts
above remain the applicable checks. The full v9 model case still failed with a
safe partial result; no unit result substitutes for that missing quality gate.
Logs: `/tmp/myco-goal-boundary-final-*`.

## Recorded project identities and native map publication

Workstream facts advance to v5. The new opaque identity hashes the complete
recorded absolute cwd and its path kind, preserving home/drive roots, case and
Unicode. Different or invalid cwd declarations stay unassigned. Facts migration
rereads tracked immutable originals even when their ledger fingerprints have not
changed; it preserves parent/subagent lineage without overriding a child's own
folder. A copied parent report remains stored as provenance but becomes a report
candidate only when an imported root proves the same project identity. An absent
or differently assigned parent cannot supply that project's reported outcome.

The actual importer regression exposed a gap beyond the initial synthetic
sidecar fixture: Codex `session_meta` was not retained by the admitted message
sidecar. New Codex admissions now preserve every cwd declaration in existing
session provenance, including conflicting declarations. Reimporting an older
source can therefore create one new normalized immutable revision; existing raw
bytes are preserved and subsequent identical imports use normal deduplication.
Old originals without this metadata retain the existing vendor lookup/unknown
fallback; no historical cwd is invented. Full cwd values are not copied into
public workstream facts.

Legacy name aliases are non-authoritative and adopted only when all recorded
members resolve to one new identity. Missing/ambiguous legacy members continue
to prevent adoption on later passes; the user's override file is never rewritten.
Every existing project page is preserved. Only absent v5 pages are created;
differing retained pages have a localized refresh-pending notice. Public markers
or editable old facts do not grant overwrite authority. Exact cwd grouping is an
intermediate repair, not proof of repository/device identity or equivalence across
subdirectories or worktrees. Different imported machines using the same recorded
path are not distinguished yet. Native workstream tests passed 43 cases with one live-vault dry-run
test intentionally ignored; the scoped frontend group passed 366 tests.

Maps now capture at most twelve 128KiB UTF-8 members through a native, exact
opening/organization-role grant. Descriptor-relative no-follow reads retain root,
parent and file identity; revision/hash and before/after read checks reject
replacement, mutation and oversize sources before full content crosses IPC.
Normal private compiler hardlinks remain readable; read custody never grants
write or undo authority. The registry holds at most eight grants, with at most
25 descriptors per grant. Normal completion, failure and late responses release
the original grant. If an IPC response itself is lost, a bounded grant can remain
until release, a new opening's capture or process exit; no expiry was added.

New-map publication requires that native grant and shares the cooperating-writer
lock with source checks. Generic Map publication and existing-map updates are
rejected. Source checks run before preparation, immediately before writing and
after persistence; the exact written output is checked too. Post-persist failure
retains the output and private receipt in Prepared state, without ordinary retry,
manifest or undo authority. A published retry rechecks sources and output identity.
External editors are not atomically excluded by this application lock.

Cross-review caught an overly broad initial binding: one distill run shares an
operation ID across several maps, each with its own source grant. A regression
failed before binding was narrowed to origin + operation + target. Different
targets now retain independent grants while same-target grant replacement is
rejected; both maps validate and undo under their shared manifest. The final
publication/source/command groups passed 38 tests, and the scoped frontend group
passed 221. These are native filesystem and synthetic generation contracts, not
actual model map quality or installed acceptance. Windows remains fail-closed;
durable ownership, restart recovery and existing-map refresh remain unfinished.

## Integrated verification of the identity and map slices

The final results below cover the source files committed as `a3ca4fb5`
(including `d35e3a66` and `5a080748`). Only documentation changed afterward.

| Gate | Result |
| --- | --- |
| `npx vitest run` | 395 files / 6,407 tests passed, 93.11s. |
| Frontend lint / TypeScript / production build | Passed; the same two existing `notchDriver.ts` hook warnings and `uiStore` import warning remain. Vite took 23.26s. Final test-fixture-only changes also passed scoped ESLint and `tsc --noEmit`; production sources were unchanged. |
| `cargo fmt --all --check` | Passed on the final native sources. |
| `cargo clippy --locked --offline --all-targets -- -D warnings`, with and without `native-index-probe` | Both passed. |
| `RUST_BACKTRACE=1 cargo test --locked --offline -- --test-threads=2` | 2,653 library + 28 integration tests passed; 38 ignored across targets. Library time 76.26s. |
| `RUST_BACKTRACE=1 cargo test --locked --offline --features native-index-probe --lib -- --test-threads=2` | 3,099 passed, 56 ignored, 78.80s. This overlaps the default library suite. |
| Request-only actual-model comparison | Failed, exit 101; both outputs and the backtrace are retained above. The opt-in failure is not counted as a passing model gate. |

The first full frontend attempt failed three tests because existing native-boundary
fixtures lacked the new source API. The prompt-head test dynamically calls the
actual map sender; its assertion was retained and strengthened with explicit
capture, send and release checks. The other two cases still check localized
missing-model errors and a vault change during generation. No assertion was
removed or skipped. A new Rust `filter_next` lint was corrected with equivalent
`rfind` syntax. The first full native run then found one old integration fixture:

```text
commands::import_admission::tests::native_and_mcp_imports_publish_workstream_facts_and_pages
panicked at src/commands_import_admission_tests.rs:73:9:
assertion `left == right` failed
  left: String("p5-20c92dae5359d8f20be4ace745aa296e1c525c1b278e0af0be303683977a45eb")
 right: "alpha"
test result: FAILED. 2652 passed; 1 failed; 34 ignored
```

That attempt did not enable a Rust backtrace. The fixture now checks the exact
v5 keys, recorded-source metadata and page paths while retaining both native/MCP
import, file-existence, marker and page-type assertions. Its 11-test group and
the final full suites passed with `RUST_BACKTRACE=1`. Unix-only test helpers are
conditionally compiled; this is not Windows execution evidence. A transient
process-spawn resource rejection was retried after existing jobs finished; no
successful check was inferred from that rejected invocation. Logs are under
`/tmp/myco-goal-identity-map-final-*`; initial failures remain alongside reruns.

## Next executable slices

G5 now gives newly created maps a versioned generated-body boundary and an exact
body-byte SHA-256 descriptor, separate from the editable title and outside text.
`mapContent.ts` renders that format in the existing checked new-map publication
path. Empty/NUL output and reserved generated markers in model output are rejected
before publication; the source grant is still released. This is preparatory
content structure, **not durable native ownership**. A public descriptor, even
with a matching hash, must never authorize refresh or undo. Existing maps remain
unchanged/pending, including legacy maps without a block. No refresh or semantic
acceptance checkbox is completed by this change.

Validation: the new renderer suite initially failed to load the not-yet-created
module; after implementation four related suites passed 49 tests. The full
frontend suite passed 397 files / 6,423 tests (72.92s). Lint passed with the two
existing hook warnings; TypeScript and production build passed (Vite 15.78s,
existing import warning). Logs are `/tmp/myco-map-content-{red,green,tests,lint,build}.log`.
The fixtures use synthetic sources and mocked IPC, so these results do not prove
native restart recovery, installed rendering or model explanation quality. Rust
was unchanged and was not rerun. The app README describes the format and limit.

The next G5 slice adds `map_content.rs` to the native publication command.
It checks the versioned generated block and exact UTF-8 body hash before any map
write, including missing/duplicate markers, unsupported descriptor versions,
empty/NUL content and unmarked trailing output. The command regression exercises
actual isolated native source grants and filesystem writes: malformed drafts
leave no target, valid drafts publish, and forged/released grants plus update
requests remain rejected. A shared synthetic `mapContent.fixture.json` is checked
by the TypeScript renderer and native parser to keep the byte contract aligned.
This is content consistency, not a durable custody journal or semantic review;
public metadata cannot authorize overwriting an existing file. The internal
publication helper still accepts trusted native inputs; the new check is at the
user-controlled IPC dispatch boundary.

Validation: default `cargo test` passed 2,655 library tests (34 ignored) and 28
integration tests (4 ignored), with no failures. The shared fixture was added
while that build was running, so its final native contract was separately run:
all three `map_content` tests passed. The frontend renderer's eight tests,
TypeScript check and changed-test ESLint passed. No full frontend rerun was
needed for the test-only frontend additions; its preceding full-suite evidence
remains recorded above. Formatting and final strict all-target Clippy passed
(Clippy 19.68s). Logs are under
`/tmp/myco-map-native-format-*`. These native tests use isolated synthetic vaults,
not installed-app or Windows evidence, and no actual model inference was run.

The G5 native creation path now writes an anchored receipt plus an immutable
`creationObserved` record under `<app-data>/map-creation-custody`. Scope binds the
canonical vault path and root device/inode to a validated map path. The record
contains the exact creation baseline, revision and native file identity; the
anchor retains the actual created object across handle closure. The directory is
checked private (0700) and records are create-only (0600), synced without replacing
unknown history. All production map dispatches require this store; private
publication helper tests may omit it. Existing live retries reuse their receipt
without writing another record. Source checks still surround publication, with
an additional check after recording. If recording conflicts or fails, the live
entry stays Prepared with its native receipt and output retained, never gaining
publication/undo authority through that failure.

This is durable **observation**, not completed restart recovery. No old JSON
record is deserialized into a native capability. Next implement bounded private
record readback/anchor validation and an update-only permit, then whole-file CAS
merging of the exact owned region while preserving title and outside bytes. A
fresh source grant remains necessary. The session compiler's physical custody
primitive is reused; its semantic grants are not reused. Unknown or incomplete
records and anchors are retained for manual recovery, with no automatic cleanup
or restart-created deletion authority. Hard-link custody currently requires the
vault and app-data directories to be on a compatible same filesystem; Windows
and cross-filesystem support remain unmet. No same-UID tamper/rollback protection
is claimed. Existing maps still stay pending, and no G5 acceptance checkbox is
completed by this slice.

Inspection found that generic compiler anchors intentionally deny deletion, so
using them directly would break new-map undo. A separate non-deserializable
`MapCreationUndo` is issued only after this live map creation was recorded and
its final sources checked, and kept with the exact publication entry. The narrow
vault removal path requires that permit plus an unchanged native file; generic
compiler-anchor deletion stays forbidden. Live undo consumes the publication,
while retaining private observation/anchor history. Human edits deny undo.
Two initial undo test attempts failed: the fixture used a noncanonical `/var`
root against `/private/var`, then incorrectly expected restored bytes to erase
native file-change history (`compiler receipt identity changed`). Neither guard
was weakened. The corrected test uses a canonical root and independent unchanged
and human-edited fixtures; it passes publication, recorded-file identity, retry,
manifest validation, unchanged undo, repeated-undo rejection and edit preservation.
The failed logs remain at `/tmp/myco-map-custody-undo.log` and
`/tmp/myco-map-custody-undo-green.log`; the successful focused rerun is
`/tmp/myco-map-custody-undo-final.log`.

A further native undo/recreate regression reproduced an actual creation defect:
a target-only anchor name collided with retained history (`File exists`,
`map_sources_tests.rs:349`). Each store now uses a random generation beneath the
vault/target scope hash. Live retries do not write a new generation; a fresh
creation after undo gets a separate anchor/record. The focused native test passes
with four retained private files after recreation and rejects the old consumed
undo against the successor. Red/green logs are
`/tmp/myco-map-custody-redraft-{red,green}.log`. This is native dispatch evidence,
not UI acceptance: at that checkpoint the frontend's session-local publication
cache still needed reconciliation with undo. The follow-up below addresses that
adapter path. Restart record readback, source-bound refresh, and private-history
cleanup remain incomplete.

Final validation for the creation/undo/generation slice: default `cargo test`
passed 2,658 library tests (34 ignored) and 28 integration tests (4 ignored),
with no failures. Compilation took 39.08s and the library suite 56.18s. Strict
all-target Clippy passed in 18.91s; formatting and diff checks passed. The final
logs are `/tmp/myco-map-custody-generation-{clippy,full}.log`. Earlier full runs
and the focused failure/recovery logs are retained rather than replaced. No
frontend runtime code changed, so frontend gates were not rerun for this native
slice. README was updated. Windows, installed UI, actual map restart recovery,
and full end-to-end undo/redraft remain unverified; no new model run occurred.

The frontend follow-up reproduces undo/redraft failing with `publication already
consumed`: `draftMap` retained the old manifest and receipt after successful undo.
The process-local recovery cache now lives in a small dependency-free runtime
module (IPC types are type-only). Both History and Settings use the shared IPC
undo adapter, which invalidates only a positively confirmed run in its captured
vault/opening. Failed or uncertain undo keeps recovery. A late reply cannot clear
a reopened vault, another vault or another run; all maps in the confirmed shared
run are invalidated together. This does not restore or invent native authority.

A second reproduction found default second-only run IDs colliding with a consumed
operation during immediate undo/redraft. Manual and automatic map runs now use
native-compatible `llm-<seconds>-<20 decimal digits>` IDs with 64 random bits.
Each automatic batch still explicitly shares one ID. Native manifest validation
already accepts this two-numeric-segment shape; no native validator was relaxed.
The regression suite uses the real map implementation and IPC adapter over
synthetic native responses, alongside scope/late-response adapter tests. Its
focused six suites pass 115 tests. Red logs are
`/tmp/myco-map-undo-cache-red.log` and `/tmp/myco-map-undo-id-red.log`; focused
success is `/tmp/myco-map-undo-cache-focused-final.log`. This is frontend behavior
plus the separately recorded native evidence, not an installed UI acceptance run.

Full frontend validation passed 398 files / 6,432 tests (70.02s), and lint passed
with the two existing `notchDriver` hook warnings. The initial build caught
TS2540 in the new fixture because `AgentVaultSession.openingToken` is read-only;
the fixture now creates a fresh origin object instead of mutating it. Its three
regressions passed again, followed by TypeScript and production build (Vite
11.24s; existing import warning). The failed build is retained in
`/tmp/myco-map-undo-cache-build.log`; final build and test logs use
`/tmp/myco-map-undo-cache-build-green.log`, `-full.log` and `-typefix-tests.log`.
The app README describes confirmed undo and fresh map run identities. Rust was
unchanged and not rerun for this frontend slice. No restart-derived native update
permission, map refresh, Windows or installed acceptance is claimed.

The next native slice adds a bounded private-record reader and uses it immediately
in `MapCreationStore::record`, before the live creation/undo permit can be issued.
It admits only a canonical scope-hash/generation JSON leaf, a regular single-link
0600 file owned by the process user, and at most 8 MiB. It opens with no-follow
and nonblocking flags, checks the named/opened object and before/after metadata,
rechecks the held directory, and compares readback bytes plus identity with the
actual native writer. Errors retain output and prevent completion through the
existing Prepared publication path. It does not deserialize an ownership grant.

Actual temporary-filesystem tests cover writer-close readback, same-byte object
replacement, altered expected bytes, symlink/hardlink/directory/FIFO, unsafe mode,
oversize records, escaped leaf names, same-length writes and identical-byte
replacement during reading. The first test run failed at the existing directory
guard because the macOS temporary path used a symlink component; the fixture was
canonicalized as production already does, without weakening the guard. Initial
and corrected focused logs remain at `/tmp/myco-map-record-read-tests.log` and
`/tmp/myco-map-record-read-green.log`. Reading stable bytes is only a prerequisite:
versioned record schema, scope and anchor validation for restart recovery and an
update-only permit remain unfinished. No installed or Windows acceptance follows
from these Unix tests, and no persisted data restores deletion authority.

Validation: final default `cargo test` passed 2,662 library tests (34 ignored)
and 28 integration tests (4 ignored), without failures; compilation took 56.59s
and the library suite 55.37s. Strict all-target Clippy passed in 21.20s, and
formatting/diff checks passed. Final logs are
`/tmp/myco-map-record-read-{clippy,full}.log`. The app README was updated. No
frontend runtime changed, so its previous gates were not rerun. No map-specific
process-restart acceptance, model inference or Windows run was performed.

The 2026-11-11 continuation adds `map_creation_observation.rs`, using the bounded
reader to validate a known private creation record. It requires the configured
app-data store outside the vault, a strict version/state/schema, matching native
vault/target scope and generation filename, a baseline digest and generated-body
format, and the recorded file object behind the retained anchor. It returns
baseline/current text only, allowing in-place human annotations to be read without
changing them. It never returns an old write receipt, an update permit or a
creation-undo permit. Native creation now invokes the same reader before issuing
its fresh live permit and additionally requires both texts to equal its new output.
Schema errors do not echo private record values.

A new adversarial test reproduced a named-anchor/open race: replacing both the
canonical map and anchor with an identical new pair between the preliminary
metadata check and reopen was accepted. `CompilerPriorFilePin::verify_issued_object`
now compares the held object with the recorded device/inode after the bounded
read, rather than trusting the earlier pathname observation. The red log is
`/tmp/myco-map-observation-race-red.log`; four observation tests pass in
`/tmp/myco-map-observation-race-green.log`. The tests also cover closed writer/store
handles, preserved annotations, malformed/schema/version/state/scope/revision/
anchor/issued-object metadata, another vault or app-data directory, and same-byte
target replacement. No generic compiler or deletion safeguard was relaxed.

Known-leaf readback is now validated, but automatic record discovery after restart,
section-level edit conflict detection, source-bound merge/publication, and an
update-only authority remain unfinished. Handle-close tests are not a separate
process-restart or installed-app acceptance run; existing maps still remain pending.

Final validation for this slice: `cargo fmt --all --check` and strict all-target
Clippy passed (25.95s). The full Rust test log records 2,666 library and 28
integration tests passed, with 38 ignored and no failures
(`/tmp/myco-map-observation-final-full.log`). Frontend, actual-model, Windows and
installed-app checks were not rerun for this native-only slice. The README now
describes validated creation observations without claiming restored update rights.

The next native slice adds bounded creation-record discovery from the canonical
vault/target scope and current file identity. Production creation uses this lookup
before confirming its live permit, exercising the same path that future restart
recovery can use without remembering a generation key. Old generations referring
to other inodes do not claim the current map; missing, malformed or multiple
matching observations fail closed. Directory identity and timestamps are checked
around enumeration, and the matched record is read again against its held file.
Discovery returns only baseline/current text. It does not recover any write/undo
permit or enable existing-map refresh.

The scan is bounded to 4,096 entries and 32 MiB of matching record bytes. Exhaustion
preserves the output and requires recovery; automatic retention cleanup remains
unfinished. Added isolated native cases cover lookup without a generation key,
closed creation handles, human annotations, new creation with old retained
generations, corrupt/missing/ambiguous records, identical-byte target replacement,
and entry-budget exhaustion. A further parent test launches a synthetic creation
child, waits for successful process exit, then launches a fresh discovery child
with only the isolated app-data path and phase. The second process finds the
baseline and preserves the current human annotation without a remembered key.
Both children use the existing test binary and an explicit synthetic marker.
This proves native discovery across process exit, not installed-app restart or
restored update authority. Next implement owned section conflict checks and
source-bound update authority, then wire recovery into the existing-map path.

Validation: the full Rust suite passed 2,669 library and 28 integration tests,
with 38 ignored (`/tmp/myco-map-discovery-full.log`). After adding the two-process
test, the focused suite passed 8 tests; its one ignored child helper was explicitly
executed in both phases by the parent (`/tmp/myco-map-discovery-restart.log`).
Final formatting and all-target strict Clippy passed
(`/tmp/myco-map-discovery-final-clippy.log`). The full suite preceded that test-only
addition; runtime code did not change afterward. Frontend, model and Windows
acceptance were not rerun. README documents lookup and exhaustion behavior.

The following slice adds owned-content conflict classification to native map
readback. `map_content.rs` now shares one bounded marker/descriptor parser between
new-draft admission and comparison against the private baseline. Native
observations expose `has_owned_content_edits`: unchanged generated body,
descriptor and evidence bytes permit title and outside-annotation differences;
edited generated bytes, recomputed public hashes, changed evidence, missing or
duplicate markers and ambiguous metadata are classified as conflicts. Current
bytes are returned untouched even when a conflict is found. Fresh creation rejects
an observation with an owned-content conflict before issuing its live permit.
Tests cover human titles and before/after annotations, edited bodies both with
and without recomputed hashes, evidence changes/removal, duplicate/quoted
metadata, inline/duplicate/missing markers and line-ending conversion. Native
readback verifies that an edited generated body remains readable but is flagged.
This classification is not a merge or update permit. Existing-map replacement,
source-bound publication and successive refresh baselines remain unfinished.
Final validation passed formatting, strict all-target Clippy and the full Rust
suite: 2,672 library plus 28 integration tests passed, 39 ignored, no failures
(`/tmp/myco-map-owned-final-clippy.log`, `/tmp/myco-map-owned-final-full.log`).
The ignored discovery child helper is still executed explicitly by its parent
restart test. README describes conflict classification. No frontend, Windows,
actual-model or installed-app acceptance was run for this slice.

The next slice implements three-input owned-section merge and registers the
read-only Tauri `preview_map_refresh` command. It requires current vault/organization
authorization and an exact native source grant, opens private creation evidence,
rejects owned-content conflicts, merges only the marked body and canonical
`map_generated`/`map_evidence` values, then rechecks sources. Other frontmatter,
titles and outside annotations remain byte-preserved. The response contains path,
current full-file revision and merged review text. It grants no update/undo permit
and performs no map write. Metadata presence changes are rejected for review.

Tests cover preserved human titles/custom fields/Unicode annotations, evidence
replacement, repeat merge against the accepted new baseline, rejection against a
stale baseline, edited owned text and unmarked candidates. An isolated native
case exercises role/source guards, retained creation evidence, returned current
revision, unchanged on-disk bytes, missing source grants, wrong feature role,
public-marker-only human files, invalid paths, owned edits, changed sources and
closed vault origin. Generated text in these tests is synthetic, not a model
quality acceptance result. The frontend review UI, anchored update-only publication,
successive durable refresh baselines and recovery/manifest behavior remain open.
Validation passed: 64 focused map-related tests (one child helper ignored by the
filter), then the final full suite with 2,675 library and 28 integration tests,
39 ignored and no failures. Formatting and all-target strict Clippy passed.
Logs: `/tmp/myco-map-refresh-preview-tests.log`,
`/tmp/myco-map-refresh-preview-full.log`, and
`/tmp/myco-map-refresh-preview-clippy.log`. README documents the native preview
contract and its missing UI/publication integration. Frontend, actual-model,
Windows and installed-app checks were not run for this native slice.

The following native slice registers `apply_map_refresh`. It independently checks
the active vault and organization role, exact native source grant, expected current
revision, retained record and held target object. It rebuilds the merge, rechecks
sources, and uses the existing anchored compare-and-swap writer. Changed content
receives a create-only version-2 `refreshObserved` record whose full baseline
includes preserved human text. Subsequent discovery validates the version/state
pair and owned-section format; version-1 creation admission remains strict.
Identical merged content returns `changed: false` without another anchor/record.
Successful refresh returns only path/revision/changed, never creation or undo
authority. Old creation undo cannot remove the replacement. Source/record/output
failures after persistence report retained output requiring manual recovery.

Native cases cover successive refreshes and preserved human text, stale CAS,
unchanged-repeat behavior with stable record count, changed source/closed origin,
an intervening external edit before the held-object check, and source verification
failure after persistence. The unchanged-content path also rechecks the held
target after its final source check; a fault test changes human text at that
checkpoint and verifies rejection without new records. A separate synthetic parent test launches creation,
first-refresh and second-refresh in three sequential child processes, each fresh
refresh obtaining a new vault origin, role and source grant. This exercises the
version-2 baseline without carrying private handles between processes. Installed
UI, actual-model meaning, Windows, interruption recovery and History/undo remain
unverified; frontend drafting still refuses existing maps until review/apply and
outcome tracking are wired. Legacy managed publication still refuses map updates.
Final validation passed formatting, all-target strict Clippy and the full Rust
suite: 2,679 library and 28 integration tests, 40 ignored, no failures
(`/tmp/myco-map-refresh-write-final-clippy.log`,
`/tmp/myco-map-refresh-write-final-full.log`). The ignored synthetic child helpers
are invoked explicitly by their parent process tests. README and the goal status
table reflect native refresh availability and the remaining product integration.
No frontend, Windows, actual-model or installed-app checks were run in this slice.

The next frontend slice connects manual proposal application to native refresh.
`mapRefresh.ts` validates preview path/revision, reads the exact current text for
review, requires explicit approval, rechecks sources and verifies the native result
against the reviewed merged hash. `reviewMapRefresh.tsx` uses the existing dialog
and diff renderer, closes on vault departure and settles replaced dialogs without
closing their replacement. Large lines use full before/after blocks to avoid the
shared quadratic word-diff pass. English/Korean/Japanese review text discloses
preserved human content and unavailable History undo. No created-file manifest
or creation receipt is fabricated for refresh.

Manual `draftMap` callers can review an existing native map. Completed creation
receipts no longer short-circuit that interactive refresh, while failed manifest
recovery remains prioritized. Noninteractive automatic callers keep existing maps
pending for review. Legacy maps lacking generated markers fail before a model
call; markers alone still do not prove custody, which the native preview enforces.
The store only marks the proposal done after a verified refresh result. The
frontend flow uses synthetic IPC tests; installed native UI and model meaning
acceptance are still required, as are automatic flow and History/recovery work.

Initial validation exposed a legacy-map store test reaching an unstubbed source
capture (`ReferenceError: window is not defined`); retaining the explicit legacy
boundary check restored its manual-recovery behavior without loosening assertions.
Lint also caught three empty test callbacks, which now return explicit undefined.
The focused final set passed 87 tests across four files, including the real
draftMap/store flow waiting on the real review dialog before dispatching apply,
real IPC argument routing with synthetic results, source/vault/cancellation guards,
inconsistent native result rejection and dialog replacement/long-output handling.
The first full frontend run found two further integration gaps: devMock command
parity lacked the new preview/apply commands, and Korean glossary rejected the
new review wording. Both were corrected without changing the checks: the browser
mock explicitly rejects the native-authority commands, and the Korean copy uses
the project's terminology and History navigation label. Failure evidence remains
in `/tmp/myco-map-refresh-ui-full.log`. An additional regression ensures a completed
creation receipt cannot bypass a later interactive update review; cancelled
review releases its source grant and creates no new manifest or publication.
Final frontend validation passed 400 files / 6,441 tests in 73.31s
(`/tmp/myco-map-refresh-ui-final-full.log`). `npm run build` passed TypeScript
and Vite (17.86s; existing import warnings remain), and lint passed with only the
two existing notchDriver hook warnings (`/tmp/myco-map-refresh-ui-final-build.log`,
`/tmp/myco-map-refresh-ui-check-lint.log`). README and the goal table describe the
manual review/apply flow and remaining automatic/history/recovery gates. Native
code was unchanged; Rust, installed-app, actual-model and Windows checks were
not rerun. SSR/dialog-store tests do not substitute for visible native UI testing.

The next slice enables existing-map refresh for already-approved automatic
proposals. Its explicit frontend routing decision carries an approval recheck,
not native authority: the original organization role/usage and source grant still
govern generation and native apply. The runner checks exact proposal bytes and
vault opening before generation and publication, and uses CAS to mark completion.
The shared model budget and pending-proposal filter remain in place. Completed
proposal counts include new, updated and unchanged maps, not created-file counts.
Native post-persist failures are surfaced as retained incomplete output; stale
target failures do not fabricate a retained-write claim.

Review found that leaving a cancelled manual map in `approved` could allow the
automatic runner to apply it later. Manual map work now stays `pending` during
generation/review; an earlier approved status is changed with an exact-revision
write before starting, after checking native/UI vault identity. Successful manual
completion also uses CAS. Automatic proposal rechecks reject withdrawn or edited
approval. Settings copy in English/Korean/Japanese explains approved automatic
updates, preserved human text and unavailable History undo.

Focused verification passed 150 tests across map generation, native IPC routing,
manual proposal review and the automatic runner. Added cases cover an automatic
role updating one existing map without a creation manifest, approval withdrawal,
same-path reopening before finalization, retained native failures, cancellation
remaining pending and unchanged proposal revisions at completion. Earlier focused
failures exposed stale store fixture expectations for the former approved status
and missing CAS stubs; the tests now assert the new pending/CAS contract while
retaining their vault/session guards (`/tmp/myco-map-auto-approval-tests.log`,
`/tmp/myco-map-auto-cas-final-tests.log`). These are synthetic frontend contracts;
installed automatic runs and actual generated meaning are still unverified.
Final verification passed 400 frontend files / 6,450 tests in 71.85s, TypeScript
and production build (Vite 24.71s), and lint with only the two existing notchDriver
hook warnings. Logs: `/tmp/myco-map-auto-final-full.log`,
`/tmp/myco-map-auto-final-build.log`, `/tmp/myco-map-auto-final-lint.log`.
README and the goal table reflect approved automatic refresh and pending
History/interruption/model gates. Native code was unchanged; Rust, Windows,
actual-model and installed-app checks were not rerun in this slice.

G6 reduced-motion inspection reproduced direction arrows advancing despite the
scene's reduced-motion flag: the regression expected phase 0.25 after two ticks
but observed 0.75 (`graphScene.motion.test.ts:24`). The arrow renderer now keeps
phase fixed while recomputing visible geometry for layout changes. Normal arrow
travel remains covered. Five related Graph files passed 31 tests; the complete
frontend suite passed 396 files / 6,409 tests in 63.76s. Full lint, TypeScript and
production build passed (Vite 11.28s; existing hook/import warnings remain).
README descriptions were updated. This is code/render-math evidence, not visual
or installed accessibility acceptance. At that checkpoint live OS preference
changes required Graph reopening; the follow-up below removes that limitation.
Other motion/state/screen-reader gates remain incomplete.

The G6 follow-up observes live `prefers-reduced-motion` changes and removes the
observer during scene disposal. Enabling it freezes arrow travel, stops idle
rotation/pulses, cancels a pending rotation-resume timer, and completes an active
camera flight at its destination with one completion callback. Disabling it
respects ambient-motion settings, flat layouts and active interaction. The
regression first failed because the observer method was absent after correcting
a fixture that attempted to assign the read-only `flatLayout` getter. Seven
focused motion tests now pass, including camera completion and three existing
rotation policies. Full frontend validation passed 396 files / 6,414 tests
(73.38s), lint (two existing `notchDriver` hook warnings), and TypeScript plus
production build (Vite 15.17s; existing static/dynamic import warning). Logs:
`/tmp/myco-graph-live-motion-{red,green,tests,lint,build}.log`. README descriptions
now cover live changes. These are code-level tests with synthetic scene objects,
not installed WebGL/OS interaction acceptance; already-running transient visual
effects and the broader accessibility gate are not claimed verified. No Rust
code changed, so the prior Rust evidence was not rerun for this frontend slice.

The [decoder/input audit](2026-11-10-request-decoder-audit.json) then verified
all fourteen recorded input texts, speakers and payload hashes against the
frozen controls. The existing opt-in vocabulary-masking matrix ran offline with
the hash-verified 4B artifact and passed in 1.23s (1.27s process wall time).
It exercised actual llama.cpp token masking and EOG admission for actor, time,
speech-act/status and outcome coupling, without generation. In particular,
plan/planned and report/reported_completed remain permitted. Blanket grammar
exclusion and changed input text do not explain the observed errors. Probability
distortion, field-order effects and model interpretation remain unproven causes;
this result does not establish semantic quality or authorize prompt promotion.

The subsequent [action/speech-act comparison](2026-11-10-request-speech-act-comparison.json)
also failed semantic acceptance. Runner `be1a2218` preserves the previous candidate
and adds a separately named experimental arm. Build, seven model-free tests,
strict feature all-target Clippy and formatting passed. Fourteen actual offline
calls completed with successful native binding, but the new arm matched only
the three negative controls R5–R7. It omitted both positive requests and still
classified the past report and future plan as request/requested. The baseline
again matched only R5/R7. All 44 records are retained; no prompt was promoted.

Test time was 443.13s, wall time 446.68s and maximum resident set size
3,235,168,256 bytes, including debug preparation. Every call has actual prefill
and sampled-token telemetry. These single-call observations do not satisfy
repeated semantic, full-compiler or installed acceptance. Before adding more
verbal instructions, inspect the source representation and decoder constraints
for the persistent action-verb versus speech-act confusion. Preserve the frozen
labels and all failed candidates during that investigation.

The [seven-case actual comparison](2026-11-10-request-controls-comparison.json)
retains all 44 records from 14 offline calls using the pinned 4B model. Runner
`e4dbbd9e` passed build, strict feature all-target Clippy, formatting and its
seven model-free regressions. The copied binary's pre-execution hashes are in
the receipt. Actual inference completed with exit 0 because transport and native
binding succeeded; **semantic acceptance failed**. Coordinator review matched
only R5/R7 for the baseline and R1/R5/R6/R7 for the new performer-guidance arm.
The candidate recovered the unspecified request but lost the explicitly named
performer, changed a reported completion into a request, and changed a plan into
a request while losing its actor. No candidate was promoted and no labels changed.
The baseline also emitted a question activity for the frozen no-task question.

Test time was 473.65s, wall time 477.29s and maximum resident set size
3,233,431,552 bytes, including debug artifact verification and loading. All
fourteen telemetry records show actual prefill and sampled tokens. This was one
call per arm/case, with no full compiler, independent semantic judge or installed
app run. Next diagnose speech-act and actor interpretation together; improving
request recall alone is insufficient. Production prompts remain unchanged.

After `04fce3c6`, the worktree was rechecked clean and the previous turn classified
as progress: it changed code and retained a failed actual-model observation.
Seven supplemental request-extraction originals and gold labels are now frozen in
[the control artifact](2026-11-10-request-extraction-controls.json). A local Python
integrity check verified seven unique IDs, four positive/three negative cases and
every original SHA-256. This is fixture integrity only: no additional inference,
new product prompt or model acceptance is claimed. The next comparison must
consume these controls through fresh native SourceSets, including the negative
cases, before any candidate promotion.

The control labels now also pass through the real native preparation and claim
binding functions in a model-free regression. Each of the seven originals gets
its own synthetic source revision, opening, packet and derived span IDs. Explicit
subjects reference that original; bound claims retain mandatory semantic review.
The request QA group passed seven tests in 0.04s. An earlier invocation used an
incomplete `--exact` filter and ran zero tests; it is not counted as validation.
This still uses constructed gold proposals, not actual generated outputs, and
does not satisfy the model comparison or semantic acceptance gate.

1. Complete G4 repository equivalence without reinstating basename/worktree-name
   guesses. The v5 repair preserves complete recorded cwd identity, including
   different home/drive roots and case, but exact cwd alone cannot prove that
   subdirectories or worktrees belong to one historical repository or distinguish
   different machines using the same path. Missing
   historical cwd cannot be invented from today's filesystem. Retain ambiguous
   cases for confirmation and establish private page-refresh custody before
   replacing existing project pages.
2. Diagnose requester/performer conflation after the rejected request-only
   comparison. Keep its frozen source and failed outputs; add actual standing-rule
   and other-request controls before promoting a later candidate. The whole v9
   compiler remains partial. W1–W4 still need real model meaning checks and
   three repeated critical cases; mocked resolution tests do not pass those gates.
3. G5 now has durable app-owned custody, revision/source-checked refresh,
   manual/approved automatic flows, latest before/after History, and pre-persist
   preparation binding staged native identity to both snapshots. Next handle
   incomplete/corrupt preparation records and expose unpublished attempts
   separately from current-object history. Preserve identity/race checks and
   distinguish pre-persist from post-persist interruption without restoring write
   authority from public markers. Complete safe undo/full history and actual
   M1/M2 meaning and human-edit acceptance.
4. Finish the remaining native/installed and UI acceptance matrix. Browser mocks
   cannot grant native publication authority. Synthetic success fixtures verify
   only presentation; they do not prove a completed import. VoiceOver, 3G,
   exhaustive state/translation combinations and installed restart remain open.

Windows and installed acceptance remain explicit missing evidence while these
independent slices continue. No commits have been pushed or merged to main.

## Verified commit slices

| Commit | Scope |
| --- | --- |
| `b504472d` | Goal contract and supplemental acceptance cases |
| `2224f62c` | G1 durable vault-scoped Ingest drafts and browser regression |
| `3c34ab95` | G2 Ask scope, period and follow-up contracts |
| `35d96b78` | G6 neutral-text contrast and route-specific loading labels |
| `b240b774` | G3 portable confined source keys; Windows runtime still unverified |
| `3c1e491e` | G7 equivalent Option predicates for Rust 1.95 lint |
| `8fa8005e` | G5 bounded source packets, path citations and isolated map generation; refresh incomplete |
| `139c9607` | Equivalent Rust 1.95 predicates in optional native QA and example gates |
| `234b3f0c` | Frozen actual structure comparison, nonempty prompt and v9 contract admission |
| `7710f050` | Project-bound original resolution, period isolation and ambiguous-discovery guard |
| `b755e413` | Compact Home/Ask and vault-bound import review |
| `ff809a43` | Accessible stacked Graph panels and phone-sheet boundary |
| `dd0f876a` | Refresh derived project candidates on retry/follow-up while retaining explicit restrictions |
| `76b9d043` | Hide stale-opening import report links; real-page SSR regressions |
| `419ff64a` | Attribute local import results to confirmed writes, excluding concurrent human edits |
| `d35e3a66` | Frozen request-only actual-model comparison; rejected candidate and raw outputs retained |
| `5a080748` | v5 recorded-folder identities, admitted Codex cwd provenance, copied-report project boundary and human-page preservation |
| `a3ca4fb5` | Native bounded map-source grants and checked new-map publication, including shared-manifest and cleanup contracts |
| `732283a4` | Native source/revision-checked existing-map refresh |
| `20b6632d` | Manual map-update diff review |
| `68602d0e` | Approved automatic map refresh |
| `802b79b2` | Version-3 before/after snapshots and read-only native history API |
| `6ec17014` | Opening-bound latest map refresh History UI |
| `6f28275b` | Preserve the observation before post-write source recheck |
