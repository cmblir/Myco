# LLM Wiki execution record

Baseline: `121c0fa2`. Execution started 2026-11-10 with the
[goal contract](../specs/2026-11-10-llm-wiki-goal.md); implementation is in progress.
The [acceptance cases](2026-11-10-llm-wiki-acceptance.md) are frozen development
requirements and must not be mistaken for passing results.

## Package status

| Package | State | Evidence and remaining work |
| --- | --- | --- |
| G0 acceptance/runtime | Baseline recorded; quality failed | Corpus and supplemental cases frozen. Actual offline 4B native compiler witness failed; raw outputs retained below. A recorded failure establishes the baseline, not product acceptance. |
| G1 Ingest drafts | Implemented; bundled D1/D2 acceptance withdrawn | Unit and synthetic browser regressions passed. Native UI showed preserved drafts, but the bundle was also launched outside the intended isolated state; clean installed acceptance must be repeated. |
| G2 Ask contract | Implemented; native acceptance pending | Explicit scope/selected-note and date-follow-up contracts tested. README distinguishes existing selected-note scope from the absent general document selector. |
| G3 Windows | Partial; Windows unverified | Portable relative-path changes passed macOS library tests. Windows handle identity, custody, durable publication and Windows execution remain. |
| G4 project state | v5 identity repair; acceptance incomplete | Project routing retains explicit paths, period and coverage. Opaque recorded-cwd identities replace basename collisions; immutable-source migration preserves human pages. Verified repository equivalence and W1–W4 actual-model meaning remain incomplete. |
| G5 maps | Native refresh and latest History view implemented; recovery incomplete | Private ownership, source/revision checks, manual/approved automatic refresh and before/after observation readback are implemented. Incomplete-attempt repair/recovery, undo, full timeline and actual-model meaning remain; external editors are not atomically excluded. |
| G6 UI | Main changes verified in synthetic browser | Compact Home, consolidated Ask examples, vault-bound import review and 800px Graph panel repair implemented. Full accessibility/state/translation review remains. |
| G7 release acceptance | In progress; full model case failed | Final frontend/default and feature-native suites, example tests and strict Clippy passed. Structure-only A/B passed its limited contract; the full v9 model witness remained partial. Installed/Windows and repeated semantic acceptance remain unverified. |

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
