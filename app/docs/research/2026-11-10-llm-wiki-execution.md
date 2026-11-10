# LLM Wiki execution record

Baseline: `121c0fa2`. Execution started 2026-11-10 with the
[goal contract](../specs/2026-11-10-llm-wiki-goal.md); implementation is in progress.
The [acceptance cases](2026-11-10-llm-wiki-acceptance.md) are frozen development
requirements and must not be mistaken for passing results.

## Package status

| Package | State | Evidence and remaining work |
| --- | --- | --- |
| G0 acceptance/runtime | Baseline recorded; quality failed | Corpus and supplemental cases frozen. Actual offline 4B native compiler witness failed; raw outputs retained below. A recorded failure establishes the baseline, not product acceptance. |
| G1 Ingest drafts | Implemented; installed restart pending | Vault-scoped durable title/body, revision-aware completion and storage recovery. Unit and synthetic browser regressions passed. |
| G2 Ask contract | Implemented; native acceptance pending | Explicit scope/selected-note and date-follow-up contracts tested. README distinguishes existing selected-note scope from the absent general document selector. |
| G3 Windows | Partial; Windows unverified | Portable relative-path changes passed macOS library tests. Windows handle identity, custody, durable publication and Windows execution remain. |
| G4 project state | Implemented route; acceptance incomplete | Project candidates now enter original-bound resolution with explicit paths, period and coverage. W1–W4 actual-model meaning remains unverified. A reproduced basename-key collision still merges distinct repositories and must be fixed. |
| G5 maps | Partial; code checks passed | Bounded member excerpts/revisions, explicit supplied-only generation, isolated cluster data and full-path citations added. Native atomic source binding, semantic review and owned-section refresh remain. |
| G6 UI | Main changes verified in synthetic browser | Compact Home, consolidated Ask examples, vault-bound import review and 800px Graph panel repair implemented. Full accessibility/state/translation review remains. |
| G7 release acceptance | In progress; full model case failed | Final frontend/default and feature-native suites, example tests and strict Clippy passed. Structure-only A/B passed its limited contract; the full v9 model witness remained partial. Installed/Windows and repeated semantic acceptance remain unverified. |

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
  and the confirmed repository-key collision remain incomplete. The route covers
  recognized progress and guided remaining-work questions; general free-text
  remaining-work intent recognition is not complete.
- G5 supplies at most twelve member excerpts with full-file SHA-256 revisions,
  source size/character budgets and truncation metadata. The complete generation
  path receives no unrelated retrieval context for maps; other organization
  calls retain their existing retrieval behavior. Full relative-path citations
  prevent same-stem pages from redirecting a selected source. The bounded cluster
  label stays in the untrusted JSON packet, outside the static system prompt. A frontend reread
  rejects detected source changes, but is not atomic with native publication.
  Existing maps remain pending rather than being overwritten. Unknown wikilinks
  are still stripped to plain text; factual assertions are not yet semantically
  verified, and source reads are not natively bounded before IPC returns.
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

## Next executable slices

1. Repair confirmed project identity collisions before accepting G4. The actual
   `project_key`/`thread_key` functions, extracted with existing normalization and
   run on synthetic paths, collapse `projects/Atlas` and `work/Atlas`, distinct
   home/drive roots, case-sensitive `Atlas`/`atlas`, and independently named
   `Atlas-worktree-*` directories to `atlas`. Facts retain no full cwd or opaque
   repository identity, and unchanged fingerprints skip rereading. Separate
   display names from opaque source-provenance identity, version/rebuild facts
   from immutable originals, and preserve parent/subagent lineage. Do not infer
   repository equivalence from a basename or worktree suffix. Preserve existing
   project pages and name overrides; ambiguous old names require review. The
   existing marker-only project-page writer is not sufficient authority to
   overwrite a human annotation during migration.
2. Diagnose the request extraction omission retained by the full v9 witness.
   The structure correction passed its stage, but native finalization remained
   partial. Freeze another input-bound comparison
   before changing their prompts. W1–W4 still need real model meaning checks and
   three repeated critical cases; mocked resolution tests do not pass those gates.
3. G5's next implementation slice is native bounded map-source capture/check/
   release consumed by `draftMap`: at most twelve 128KiB sources, exact native
   opening/organization role, retained file and directory identity, and bounded
   UTF-8 reads. Keep its read-only evidence capability separate from write/undo
   authority; normal compiler files can have private hardlink anchors. A separate
   check followed by publish is still non-atomic. Follow with source revalidation
   and target CAS in one writer operation, durable app-owned section custody,
   and update prior images in manifest/recovery. Preserve human bytes and reject
   ambiguous ownership; frontmatter hashes/markers are not native authority.
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
