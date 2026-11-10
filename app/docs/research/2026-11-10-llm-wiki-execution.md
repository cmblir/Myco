# LLM Wiki execution record

Baseline: `121c0fa2`. Execution started 2026-11-10. The previous turn delivered
the [goal contract](../specs/2026-11-10-llm-wiki-goal.md); implementation is now in progress.
The [acceptance cases](2026-11-10-llm-wiki-acceptance.md) are frozen development
requirements and must not be mistaken for passing results.

## Package status

| Package | State | Evidence and remaining work |
| --- | --- | --- |
| G0 acceptance/runtime | Baseline recorded; quality failed | Corpus and supplemental cases frozen. Actual offline 4B native compiler witness failed; raw outputs retained below. A recorded failure establishes the baseline, not product acceptance. |
| G1 Ingest drafts | Implemented; installed restart pending | Vault-scoped durable title/body, revision-aware completion and storage recovery. Unit and synthetic browser regressions passed. |
| G2 Ask contract | Implemented; native acceptance pending | Explicit scope/selected-note and date-follow-up contracts tested. README distinguishes existing selected-note scope from the absent general document selector. |
| G3 Windows | Partial; Windows unverified | Portable relative-path changes passed macOS library tests. Windows handle identity, custody, durable publication and Windows execution remain. |
| G4 project state | Pending | W1–W4 specify requested/reported/reopened state and historical isolation. |
| G5 maps | Partial; code checks passed | Bounded member excerpts/revisions, explicit supplied-only generation, isolated cluster data and full-path citations added. Native atomic source binding, semantic review and owned-section refresh remain. |
| G6 UI | Partial | Neutral-background small-text contrast and route-specific loading copy corrected. Home/Ask/Ingest layout changes and full state/viewport review remain. |
| G7 release acceptance | In progress; model quality failed | Frontend suite/build and default native Cargo/fmt/Clippy passed. Final map label isolation passed its affected tests and static checks. Installed/Windows and repeated semantic acceptance remain unverified. |

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
  by route. The rendered dark Graph rail count measured 6.37:1 in a mock browser;
  light, selected/hover compositions, responsive widths, keyboard and state-matrix
  review are not all covered by that observation.
- Root English/Korean and app README descriptions now cover draft behavior and
  the actual scope/period policy, bounded new-map drafts and pending refresh.
  Root distillation copy now distinguishes immutable raw sources from eligible
  derived archives. Provider and remaining historical README claims
  still need the final G7 reconciliation.

The first full frontend attempt overlapped map implementation and failed thirteen
tests with three unhandled errors; the stable rerun above passed. The initial lint
run also found a new control-character-regex error, which was fixed without a
suppression. These earlier failures are retained in `/tmp/myco-goal-*` logs.

## Next executable slices

1. Diagnose the actual model failure with a frozen QA-only structure experiment.
   Packet 2 carries a nonempty planned claim, but the current structure prompt
   also describes the empty case and its grammar permits empty title/IDs. Compare
   the unchanged prompt with explicit nonempty-title/claim-ID instructions while
   keeping input, model, grammar, sampler and 768/4096 budgets fixed. Retain both
   outputs, apply the unchanged validator and separately review meaning. Existing
   extraction replay is claims-only and native review replay is review-only, so
   reuse their binding/receipt patterns in a dedicated QA entry point. The
   extraction omission is a separate issue; full inputs ended at EOG rather than
   a token limit. Do not change labels or treat a structured title as full success.
2. G4 should reuse `activity_synthesis_steps_with_resolution`, not add another
   state engine. Workstream facts preserve the first user request and latest
   assistant report, so a later user reopening is lost. A synthetic renderer
   reproduction retained the older completed report and labelled it with the
   session's later activity date. `open_items` also unions old text without
   resolving later completion/cancellation. Bind initial and follow-up evidence
   to the project's source paths intersected with the user's scope, then route
   current/historical questions through existing source-bound resolution. Distinct
   project keys stayed separate in the renderer reproduction; same-basename repo
   identity and native project filtering still require regression coverage.
3. G5 refresh requires native source snapshot capability, durable app-owned
   section custody, target compare-and-swap and source revalidation in one
   publication operation, plus update prior images in manifest/recovery. Reuse
   existing custody patterns; a frontmatter hash or marker is not write authority.
4. G6 can compact the returning-device Home introduction while preserving first
   visit/onboarding/custom management layout, consolidate Ask examples near the
   composer without auto-submission, and prioritize reviewing successful imports.
   Ingest currently exposes changed paths only: derive created/updated metadata
   from actual before/after results and retain the actual source path, rather than
   infer change type from a model's plan. Preserve partial/error recovery and
   vault-bound links. Full viewport/theme/keyboard/state review remains required.

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
