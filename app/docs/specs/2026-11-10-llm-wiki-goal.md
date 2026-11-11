# Reliable local LLM Wiki execution goal

Date: 2026-11-10

Baseline: `121c0fa2` on `origin/main`, myco 0.4.0

Status: Active. Draft/scope handling, source-bound project routing and UI fixes
are implemented; native, project identity and model acceptance remain incomplete.
See the [execution record](../research/2026-11-10-llm-wiki-execution.md).

## Objective

Make myco a reliable local LLM Wiki: a user adds a source, reviews the resulting
wiki changes, asks questions with traceable evidence, and receives updated
knowledge when sources or project states change. Preserve original sources and
human writing throughout retries, navigation, concurrent edits and restarts.

The owner requested this goal following the November 10 main-branch audit, with
the goal document delivered first. Implement the work below in small verified
slices. Creating this document or passing mocked tests does not complete the goal.

## Existing implementation and baseline evidence

The app already has Markdown/block editing, wikilinks, imports, revision-aware
session compilation, hybrid retrieval, cited Ask, project workstreams, maps,
provenance, history, graph exploration, tasks and study. Extend these paths rather
than replacing them with another wiki architecture.

The [October model and validation plan](2026-10-08-llm-wiki-model-and-validation-plan.md)
remains context for local-first operation and model promotion gates. Its model
candidates are not accepted production choices. The [October execution status](../research/2026-10-09-llm-wiki-execution-status.md)
is historical: several items marked Planned there are implemented in this baseline.
This goal defines the current execution scope; do not reopen every historical item.

| Evidence at the baseline | Result and limit |
| --- | --- |
| Frontend unit suite | 387 files, 6,276 tests passed in an isolated worktree of the same commit. |
| Frontend lint and build | Build passed; lint had zero errors and two existing hook-dependency warnings. |
| Rust formatting | `cargo fmt --all --check` passed; full Rust tests were not rerun locally. |
| Synthetic evaluation fixture checks | 12 tests passed; these do not measure generated-answer quality. |
| [CI run 42773670030](https://github.com/cmblir/Myco/actions/runs/42773670030) | Frontend, audit, Linux and both macOS jobs passed. Windows reported 1,994 passed, 340 failed and 29 ignored tests. |
| Browser reproduction | Ingest title and body became empty after navigating to Ask and returning. Synthetic IPC only. |
| Visual inspection | Dark Home, Ask, Ingest and Graph reviewed. Narrow browser captures are not installed mobile acceptance. |
| Actual-model acceptance | No current complete release-acceptance receipt was established by this audit. This is not a claim that inference has never been run. |

## Product and safety boundaries

- Keep local inference as the default. Connection discovery never selects an
  external provider. Local failure must not trigger remote inference or a paid judge.
- Use existing local artifacts first. Record exact model revision, checksum and
  runtime before quality evaluation. Follow existing artifact and promotion gates;
  do not select a new model merely because it appears in an older plan.
- Test with synthetic, isolated vaults and isolated application state. Never use
  the owner's live vault, credentials or personal transcripts as test fixtures.
- Never modify or delete existing `raw/` sources. Admit changed input as a new
  revision using the existing lineage rules. Preserve human titles and annotations.
- Keep native revision checks, file identity, confinement and fail-closed behavior.
  Do not repair Windows by bypassing safeguards or skipping failing suites.
- Inferred completion is not verified completion. Separate requests, proposals,
  reported outcomes, independently verified outcomes and unknown state.
- Retain the mushroom identity, existing theme and component system. Localize new
  visible strings with the existing language parity conventions.

Out of scope: a new graph database, wholesale GraphRAG replacement, model training,
new OCR, mobile release certification, new graph skins, mascot redesign, unrelated
refactoring, external CLI reactivation, automatic execution of inferred tasks,
release publication or merging to main. Pushes and external publication are not
required to create this document.

## Execution order and ownership

Start G0, then implement G1 and G2 as the first user-facing slice. G3 can proceed
in parallel on a separate branch/worktree with a Windows-capable runner. G4 and G5
follow the shared evidence contract from G0/G2. G6 may proceed on separate UI files
after G1. Run actual-model/native scenarios throughout, not only in G7.

| ID | Package | Depends on | Current state |
| --- | --- | --- | --- |
| G0 | Freeze acceptance cases and establish runtime evidence | None | Baseline recorded; actual model quality failed |
| G1 | Preserve Ingest drafts | G0 cases | Bundled macOS D1/D2/D4 passed; D3 success/failure retention and early cancellation passed; older-success/newer-draft race and later-stage cancellation remain; other platforms unverified |
| G2 | Make Ask scope and period consistent | G0 cases | Implemented; native acceptance pending |
| G3 | Restore Windows native safety and functionality | G0 inventory | Hosted Windows run at 868c7b67: 2,228 passed, 190 failed, 31 ignored; all 20 handle diagnostics pass. Production model/index read-lease regressions and parent-handle rename probes pass. Relative creation/cleanup probes await runtime validation; production custody/publication and installed flow incomplete |
| G4 | Resolve current project work state | G2 contract | Source-bound route and opaque folder identities implemented; facts v6 rebuild malformed cwd assignments; repository equivalence and actual meaning gates remain |
| G5 | Refresh evidence-based topic maps | G0 evidence contract | Bundled macOS editor-save/restart and two changed-source refreshes preserve the complete human suffix with one map. Actual generated output falsely claims partial member coverage, so semantic acceptance still fails. Remaining native failure matrix and model cases are open; full timeline/undo is not an additional gate. |
| G6 | Improve capture, review and reading screens | G1; G2 for Ask | Main screens improved; native Graph navigation/restart and dark label repair checked; 800px graph-first layout verified in light/dark, with 1024/1280px checks; full accessibility/state and phone review incomplete |
| G7 | Complete native acceptance and documentation | G1–G6 | In progress; not release-accepted |

Parallel workers must own disjoint files or isolated worktrees. One coordinator
integrates changes and resolves shared schema/i18n edits. Use feature branches;
do not implement on detached HEAD or push directly to main.

## Work packages and completion criteria

### G0 Establish an executable acceptance baseline

Reuse `app/src-tauri/eval/`, existing compiler tests and browser smoke helpers.
Inventory available local weights, runtime, native build and Windows runner
without downloading or changing models as a side effect of inspection.

- [x] Freeze synthetic cases and expected claims before implementation changes.
  Include changed sources, two vaults, explicit scopes/dates, and conflicting
  requested/reported/verified work states.
- [x] Reproduce current failures and retain command, commit, fixture revision,
  environment and output. Distinguish not run, failed, blocked and passed.
- [x] Run at least one actual-model/native end-to-end baseline when the required
  runtime exists; otherwise record the specific missing prerequisite and continue
  independent work. Never substitute mock output for this milestone.

### G1 Preserve unsent Ingest drafts

Starting points: `src/pages/PageIngest.tsx`, route mounting in `src/App.tsx`,
existing vault-scoped draft/checkpoint patterns and their tests.

- [x] Reproduce draft loss before changing behavior and retain an automated
  regression against the untouched baseline. Manual reproduction preceded
  implementation; the automated baseline comparison followed it.
- [ ] Preserve title/body across Ask, Settings and Reader navigation and refresh/
  restart using existing durable storage conventions where suitable.
- [ ] Isolate drafts by vault; switching vaults cannot expose or overwrite another
  draft. Storage failure must retain current input and show recoverable status.
- [ ] Clear only the submitted draft after confirmed success, or on explicit
  discard. Failed, cancelled or partial imports retain it. Completion of an older
  submission must not erase a newer draft.

### G2 Make Ask scope and period consistent

Starting points: `src/stores/queryStore.ts`, `src/lib/queryWorkstreams.ts`,
`src/pages/PageQuery.tsx` and their tests.

- [ ] Honor explicitly selected wiki/session/all scope and document filters on
  ordinary and workstream routes. A guided project action must disclose its
  session scope before submission; it cannot silently override an explicit filter.
- [ ] Preserve explicit dates and display the period actually used. If a route
  uses a seven-day default, disclose it. Older records cannot silently replace an
  empty requested period; offer a clearly labelled wider/older search instead.
- [ ] Answers retain source targets and distinguish wiki content, imported
  conversations and reported work. Missing evidence yields an actionable empty
  result, never an unrelated answer.
- [ ] Add cases for follow-ups, Korean date wording, document selection, empty
  periods, old-only records and a vault switch while a query is running.
- [x] Update relevant README descriptions to match the final policy.

### G3 Restore Windows native behavior

Starting points: `src-tauri/src/distill_publication.rs`,
`session_compile/compiled_custody.rs`, `inbox_source.rs`,
`audio_overview/sources.rs` and source/scope path handling.

- [ ] Group the baseline Windows failures by first cause; distinguish unsupported
  platform behavior from path errors and secondary poisoned-lock failures.
- [ ] Implement platform-appropriate identity, confined path handling and durable
  publication without weakening revision, ownership or atomicity guarantees.
- [ ] Cover replacement races, changed source identities, Unicode/space paths,
  access denial, interruption and reopen. Preserve source/draft on failure.
- [ ] Pass the existing Windows suite and native synthetic-vault capture → publish
  → Ask → restart flow. Recheck Linux/macOS for shared changes.

If Windows execution is unavailable, retain G3 as unverified with the missing
runner recorded. Do not declare cross-platform completion from macOS tests or
cross-compilation alone, and do not silently reduce supported platforms.

### G4 Resolve the current state of project work

Starting points: `src-tauri/src/workstreams.rs`, existing session claims and
`src/lib/queryWorkstreams.ts`. Reuse rule extraction as candidate collection.

- [ ] Link evidence for the same task across sessions; preserve project, actor,
  event time, speech act, original source/revision and bounded coverage.
- [ ] Handle pending → reported complete → reopened, cancellation, and conflicts.
  A request, plan or assistant suggestion is never evidence of performed work.
- [ ] Do not merge similarly named tasks from different projects. Keep ambiguous
  items as needs confirmation; absence of a record is not proof of no remaining work.
  The November 10 audit reproduced distinct repository paths collapsing to the
  same basename-derived project key. Replace that identity with a versioned,
  provenance-based identity and rebuild derived facts without overwriting human
  pages or guessing which ambiguous legacy name belongs to which repository.
- [ ] Resolve historical questions using only evidence within their cutoff and
  selected scope; later completion or reopening cannot leak into an earlier answer.
- [ ] Render the current supported state with evidence links and coverage limits.
  A deterministic list of historical sentences alone does not pass this package.

### G5 Maintain topic maps from source evidence

Starting points: `src/lib/maps.ts`, its tests, existing evidence packets and
native publication checks.

- [ ] Use bounded member content, citations and revisions rather than titles alone
  to generate explanatory relationships. Every factual explanation has support.
- [ ] Refresh only app-owned sections and preserve human writing. If ownership is
  ambiguous, keep the existing content and offer review rather than overwrite it.
- [ ] Repeated runs are idempotent; adding a source updates one map rather than
  producing duplicates. Changed evidence before publication rejects stale output.
- [ ] Missing/unreadable sources and partial coverage remain visible and retryable.

Native structural evidence (November 11): a real-filesystem scenario now covers
member expansion, rejection of an old source grant, a fresh-revision retry,
no-op repetition and preservation of one canonical map with human title/notes.
A subsequent bundled macOS replay also preserves a real editor-authored paragraph
through atomic save, process restart and two changed-source refreshes, with one
map and unchanged bytes outside generated/evidence fields. Its actual model
output falsely claims partial member coverage, so semantic acceptance fails.
This does not close the above checkboxes: generated explanation quality and the
complete user-facing/native failure matrix remain incomplete. See the execution
record for commands and scope.

### G6 Improve visual hierarchy and review flow

Use `docs/design/design-system.md`, the shared UI kit and graph visual rules.

- [x] Compact the returning-user Home introduction so recent notes and meaningful
  review actions are easier to reach. Preserve onboarding and custom layouts.
- [x] Consolidate duplicated Ask intent/example guidance around the composer;
  retain guidance while making room for answers and sources.
- [x] Make reviewing created/updated pages the main successful-import action.
  Show readable titles, change type and source links; retain add-another access.
- [ ] Keep graph panels collapsible and preserve saved preferences. Improve label
  priority for selected notes/neighbors and verify opening the underlying page.
- [ ] Raise ordinary small-text contrast to at least 4.5:1 on actual composited
  backgrounds; verify selected/hover states. Give Reader and Settings truthful
  route-specific loading text rather than graph-only wording.
- [ ] Review light/dark, keyboard focus, reduced motion, long translations and
  idle/loading/empty/error/success/partial states. Test 800/1024/1280 desktop widths
  plus 320/375/768 responsive layouts. Native mobile certification remains excluded.

### G7 Complete acceptance and update documentation

- [x] Pass applicable frontend lint, type/build and unit gates, Rust fmt/clippy/
  tests, and relevant browser workflows. Report existing warnings separately.
- [ ] Execute the native scenario matrix below with real local inference and
  network disabled after artifacts are prepared. Record latency and peak memory;
  do not invent performance thresholds after seeing results.
- [ ] Review actual generated claims against frozen source labels. Require zero
  critical scope leaks, unsupported completion claims, fabricated citations or
  source/human-edit corruption. Safe abstention alone does not pass positive
  cases that require a useful grounded synthesis.
- [ ] Repeat critical generated-answer cases three times with recorded generation
  settings. Retain failures; do not report only the best run or weaken gold labels.
- [ ] Update root/app README and corresponding translations for changed behavior,
  current workstream functionality and actually supported providers. Separate
  citation coverage from semantic correctness; do not imply universal fact checking.
- [ ] Record installed-app and OS-specific acceptance independently. Missing model,
  Windows or installed-app evidence leaves that gate incomplete.

## Required scenario matrix

| Case | Required observable result |
| --- | --- |
| New source | Immutable raw source, reviewable wiki change and resolvable citation. |
| Identical reimport | No duplicate canonical page or false new-work success. |
| Updated source | New revision linked to the original; only owned content refreshed. |
| Human edit during generation | Human content preserved; stale publication rejected. |
| Draft navigation/restart | Title/body recovered in the originating vault only. |
| Failed/cancelled import | Input and recovery retained; no completed-success claim. |
| Scoped/datable Ask | Only allowed evidence; actual scope and period visible. |
| Empty requested period | Explicit absence and optional widening, not silent substitution. |
| Task lifecycle | Request → report → verification → reopening remains distinguishable. |
| Map refresh | Evidence-based relationships, preserved annotations, no duplicate map. |
| Vault switch in flight | No old-vault answer or write published into the new vault. |
| Offline restart/recovery | Durable state recovered; no remote inference fallback. |

Use unit/integration fault tests for boundary coverage, browser tests for UI
behavior, and native/actual-model runs for the full loop. Each evidence record
must identify its level; one level cannot stand in for another.

## Progress and stop conditions

For each package, record status, commit, changed files, tests run, actual results,
remaining risks and the next executable action in a companion research status
record created when implementation begins. Update checkboxes only with evidence.

Continue independent work when a runner or model is unavailable. Surface concrete
blockers promptly; never mark the whole goal complete because one environment
cannot run a required check. A product-policy conflict with this contract needs
one focused owner decision; routine implementation choices do not.

The goal is complete only when G0–G7 acceptance conditions are satisfied and the
record distinguishes code verification, generated-answer quality and installed
behavior. A draft PR, a passing unit suite or this goal document alone is insufficient.
