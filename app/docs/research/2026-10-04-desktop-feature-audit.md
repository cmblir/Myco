# Desktop workflow audit — 2026-10-04

This is an execution and coverage ledger for `fix/desktop-workflows`, based on
`0caa18cb`. It does not certify every desktop feature as working. The audit host
is Apple M3; the user's Intel/8 GB machine has not been measured here.

## Evidence boundary

- **Source** means the route, caller, IPC registration, and implementation entry
  point were read. It does not mean the full implementation was audited.
- **Browser** means real Chromium interactions with `?mock=1`. The React editor,
  DOM, layout, and browser code execute; Tauri IPC, files, models, and provider
  replies use synthetic in-memory fixtures. Browser writes are not native disk
  writes and provider replies are not real inference.
- **Unit** means a synthetic regression was executed. Deferred promises are used
  for request races. No private vault or account data are fixtures.
- **Prerequisite** means a real model, credential, permission, external service,
  or OS surface is required and was not used in this audit. This is distinct
  from a demonstrated product failure.

The synthetic workflow audit performed no account connection, external message,
model download, microphone recording, scheduled job installation, private-vault
bulk read, or private-vault mutation. Native UI and full Rust/build gates are
coordinated separately
by the root agent; the browser results below cannot replace those gates.
The earlier root-owned read-only native observations covered Home, Review
suggestions, Graph, and Appearance on macOS. They confirmed those surfaces in the
previously installed native app, before the later changes recorded below; they
contain no native button-write assertions and were not executed
by the author of this browser ledger. Main-process RSS is not total app memory
and is not evidence that the Intel/8 GB memory budget is satisfied.
The earlier signed-release preflight found no valid Developer ID Application
identity and did not replace the installed app. The later user-requested
development reinstall has a separate receipt below; native button-write coverage
must still be distinguished from browser fixtures.

## Feature inventory and execution coverage

`App.tsx` routes to nine named workspace pages, Settings, and `page:<path>`
Reader routes. The first six navigation items are Home, Ask, Add sources,
Review suggestions, Graph, and Tasks. Study, History, and Provenance are under
More tools. The Settings button is separate from that navigation list.

| User feature | Actual call chain / source boundary | Executed evidence and remaining prerequisite |
| --- | --- | --- |
| Open/restore/switch vault | `App` startup → `vaultStore.restoreVault/openVault` → `ensure_default_vault`, `open_vault`, `list_files`, `build_link_graph` | Home mock startup and named navigation execute. Native directory selection, existing private vaults, and filesystem permissions are not tested here. The legacy startup smoke needs a stable Vite module graph before its store assertions can be trusted. |
| Home / daily capture | `PageOverview` → `dailyNote` → `capture_note`, `read_file` | Home route renders. Actual native daily-note writes remain outside browser coverage. |
| New note / template / rename / move / trash | `newNote`, `TemplatePicker`, `vaultStore` → file IPC | New-note browser smoke verifies source/live mode, immediate Korean typing, create/save/cancel against synthetic IPC (20 checks). Dialog-selected native paths and trash operations are not exercised. |
| Navigation / back and forward / split views | `Sidebar`, `CommandBar`, `uiStore.navHistory`, `App` | Strict named navigation proves all nine workspace routes and Settings. It does not claim complete split-view, history-stack, or keyboard coverage. |
| Source/live Markdown editing | `PageReader` → CodeMirror `Editor` / `editorBlocks` → `vaultStore.saveFile` → `write_file` | Updated editor smoke passes 115 checks: source/live round trips, Korean input, undo, 320–1280 px/split views, raw read-only UI, delayed saves, failed-save recovery, and stale responses. Files are in-memory IPC fixtures; this does not prove native disk durability or crash recovery. |
| Markdown blocks / tables / charts / math / diagrams | `editorBlocks`, `blocks/*`, `Viewer`, Markdown renderers | Source scan and compiler inclusion; no complete browser interaction matrix for all block types in this run. |
| Images / paste / drop / attachments | `assets` → `write_asset`, `copy_asset`; Reader asset renderers | Source only. OS clipboard/file-drop permissions and native asset copy require a synthetic native vault run. |
| Wikilinks / backlinks / related pages | `PageReader`, `ReaderRail`, `resolveWikilink`, `related` → link graph / `related_pages` | Rendering occurs in normal Reader flows. Legacy semantic-discoverability smoke did not reach the current related-panel control; no missing-feature conclusion follows from that timeout. |
| Command palette / filename / text / semantic search | `CommandBar`, `searchQuery`, `queryViews` → `search_vault`, `semantic_search` | Query topic-versus-Git intent smoke passes 5 checks. Legacy command-palette accessibility smoke stops at a collapsed mobile sidebar. Actual local embedding search requires the native index and model. |
| Ask / citations / scope / dates / abstention | `PageQuery` → `queryStore` → `chat`, `timeQuery`, `sessionEvidence` → retrieval and provider IPC | Ask stages passes 8 checks; personal recall passes 27 checks, and lifecycle passes 36 checks at 375/768/1280 px. Lifecycle covers local Stop, late results, and a live-store simulated vault change. Actual E5 retrieval is measured separately below; provider synthesis remains unverified. |
| Agent / tool trace / per-write confirmation | `AgentPanel` → `agentStore`, `agentLoop` → `agent_chat`, `agent_tool_call` | Current named-button rerun passes 8 checks, including search tool trace and the per-write dialog. Real tool-capable provider credentials and inference remain prerequisites. |
| Sources: text / files / URL / PDF / image / audio / YouTube | `PageIngest` → `mediaIngest.sourceTextFor` → parsing/fetch/transcription IPC → `ingestStore` → source admission, validation, publish | Strict inbox failure → alert → Retry → original pending contents passes. Intake smoke reaches desktop submission and grounded source results before a stale Ask-details assertion fails; no complete ingest pass is claimed. Real fetch/extraction/transcription/inference require native/service validation. |
| Conversation import / manual sweep / retry | `ImportCard` → `importStore` → `import_conversations`, `import_session_sweep`, `import_paths` → Rust `importers/*` | Updated mock-browser import passes 39 assertions at 375/768/1280 px, including transport failure → retained files/destination → retry. Four store regressions pass. Importer tests and synthetic browser imports do not prove successful imports of a real private export. |
| Auto import / ingest / reflect / reindex / distill | `App` interval hooks → `autoImport`, `autoIngest`, `autoReflect`, `autoReindex`, `autoDistill` | Source entry points are present. Process restart, clock scheduling, disk queues, failure recovery, and background provider execution are not proved by browser fixtures. |
| Harvest / suggestion review / topic maps / digest | `PageOverview`, `PageFeedback`, `HarvestQueue` → harvest/reflect/distill stores and IPC | Feedback route renders as Harvest box under Review suggestions navigation. Queue correctness and real local backfill are audited by the assigned harvest owner. No real model-backed harvest was run. |
| Suggested links / accept / dismiss / retries | `LinkSuggestions`, `ReaderRail`, tray/notch → `linkSuggestStore`, link actions → CAS file writes | Link owner reports 102 focused tests and 30 responsive mock-browser checks at 375/768/1280 px. Synthetic batching reduces fixture read/write calls by 75%; this is not native disk latency, Intel/8 GB performance, or a complete graph-model evaluation. |
| Graph / layouts / appearance / filter / selection | `PageGraph` → graph data → `GraphScene`, simulation worker, canvas/renderers → `build_link_graph` | Updated looks smoke passes 51 checks: all 12 current picker looks, actual shader settings, numeric/range controls, keyboard focus, restore, spread, Woven flight, and Paper flight exit. Legacy saved Terrain/City rendering and the separate selected-neighborhood readability smoke remain unverified. No large-vault/GPU budget is established. |
| Graph timeline / multiverse / universe switching | `PageGraph`, `multiverseStore` → `list_universes`, universe graphs, `openVault` | Source identified; individual smoke outcomes are recorded below. No real secondary vault is opened here. |
| Tasks / board / calendar / recurrence / notes | `PageTasks` → `scan_tasks`, `taskLine`, `taskWrite`, `taskRecurrence`, `taskHub`, roadmap | Updated mock-browser workflow passes 115 assertions at 375/768/769/900/1280 px: CRUD, recurrence, status/notes, draft and existing-note preservation on failure, and actual detail-panel Open-note clicks. Native disk mutation is not tested by these browser fixtures. |
| Make cards / deck list / due count / review / quiz | Reader More → `study`, `extractiveCards`, `cardStore`; `PageStudy` → `studyStore`, FSRS, deck read/write | Updated workflow passes 75 assertions at 375/768/1280 px: two graded cards, re-read FSRS bytes/due dates, zero due on revisit, extractive quiz, and card preview/save/dedup. The prior visible read error → Retry checks also pass. Real quiz inference and native review writes remain prerequisites. |
| History / diff / undo / authorship | `PageHistory` → distill run list/detail/diff/undo; Reader → page authorship/Git IPC | History route renders; query smoke distinguishes activity from topic search. Git disk history and native undo are not exercised here. Legacy history accessibility smoke stops at mobile navigation. |
| Provenance / missing citations / lint | `PageProvenance` → `provenanceStore.scan`, `lintStore` → `scan_provenance`, provider lint, run log | Ten synthetic scan regressions verify path switches, closure, late responses, and same-vault cache retention. Strict browser failure → alert → Retry → restored coverage rows passes. CLI-generated lint was not invoked. |
| PDF viewer / highlights / pinpoint links | `PdfViewer` → `read_raw_bytes`, pdf.js worker; annotations → sidecar read/write | Updated smoke passes 8 checks: real pdf.js canvas, seeded highlight → citing note, and live Markdown pinpoint → PDF. Source bytes and sidecars are mock IPC. Native PDF selection and new annotation persistence remain untested here. |
| Audio overview / transcript / browser speech | Reader More → `audioStore`, `audioOverview` → read pages, provider completion, transcript write, Web Speech API | Updated smoke passes 8 checks: transcript/speakers/citations/controls and an enabled Play click without JavaScript errors. Audible playback/voice quality is not assessed. Generated dialogue and persisted transcript are mock IPC; no real provider inference occurs. |
| Voice capture / partial transcription | `Spotlight`, `voiceCapture` → `getUserMedia`, `transcribe_partial`, `save_voice_capture` | Source only; microphone permission, recording, Whisper executable/model, native audio encoding, and transcription were not used. |
| Notch / Spotlight / tray / mascot / global shortcuts | Settings/`NotchPanel`/`Spotlight` → native `notch`, `spotlight`, `tray`, `roam` modules | Browser notch shape/controls are mock-only. macOS windows, notch geometry, menu-bar residency, shortcut registration, and native ACK are separate root-owned checks. Non-macOS notch functions include no-op/false paths; registration alone is not platform support. |
| MCP server / tool auth / client connection | Settings MCP → `mcp_info`, `mcp_connect`; native `mcp_native` | Source routing exists. Browser MCP status is fixture data. No real client configuration, server network request, credential, or external tool invocation was changed here. |
| Plugins / trust / permissions / sandbox | Settings/`pluginStore` → manifest validation → worker sandbox → permitted IPC calls | Source scan only. Per-vault trust, plugin permission limits, and worker boundaries exist; no plugin directory was installed or executed in a real vault. |
| Storage / compression / restore / quarantine / tidy | Settings Storage/Tidy → archive IPC; `tidyStore`, `tidyRun` → expected-hash manifest and writes/moves | Source paths identified. No actual archive, restore, quarantine deletion, tidy write, or rollback was performed. |
| Settings persistence / provider connections | `PageSettings`, settings panels → `settingsStore`, provider IPC / Keychain | Named Settings route renders. Old save/notch scripts resolve hidden switches and do not reach the action. Root/connection owner separately tests persistence errors. No actual credential/settings change occurs in browser mock mode. |
| Settings export / import / reset / appearance / language | About → `settingsBundle` validation/export/import/undo; appearance → `uiStore` | Source includes credential exclusion and native pick/save boundaries. No native exported file, import, reset, or updater restart was executed; old language smoke targets the former Account navigation layout. |
| Clipper / deep link / web article capture | `clipper/` extension/bookmarklet → native `clip` / inbox; `web_fetch` | Source identified. Legacy clip smoke targets the old Model picker. No browser extension installation, real deep-link arrival, or external article fetch was performed. |
| Scheduled automation / cron / launchd | `automation/README.md`, scripts; native schedule handling | Source only. No jobs were installed or enabled, and no external CLI/model task was executed. |
| Gmail / Google Calendar / iCloud Mail / iPhone companion | Research contracts, not the existing provider picker | Account connectors and mobile client are not implemented/live-authenticated. Existing `google-api` means Gemini inference, not Gmail or Calendar synchronization. See the existing Google/iCloud contracts for prerequisites; do not present connector mock screens as sync proof. |

## Confirmed Study fixes and five-state coverage

Previously, `cardStore.summarizeDecks` swallowed deck reads and grounding-source
reads. A failed scan could resemble an empty or ungrounded deck. The Study store
had no error state, and a completed request for vault A could overwrite vault B
or repopulate a closed vault.

The UI scan now requests strict reads, distinguishes legitimate missing evidence
from failed reads, exposes an error with Retry, clears unusable counts, and
commits only the current vault/request. The best-effort default remains for
existing non-UI callers. Diagnostic logging records only `study_refresh_failed`,
not a path or source content. Background refresh does not unmount an active
review session merely because the deck-list scan is loading or failed.

| State | Evidence in this audit |
| --- | --- |
| Idle | Study route and deck navigation render with mock fixtures. |
| Loading | Source provides a role=status loading panel before deck-list completion; unit deferred reads exercise the in-flight store state. |
| Empty | No-vault/closed-vault regression clears rows and counts. A separate browser empty-deck review was not added. |
| Error | Real `cardStore` synthetic read failure propagates to store error; Chromium shows an alert and removes stale rows. |
| Success / retry | Retry after restoring synthetic read access returns the original deck rows/due text. Late/superseded requests do not replace current results. |

Five states for every other feature are not fully browser-tested. A route title
or mock screenshot alone is not a loading/error/recovery test.

## Browser smoke ledger

Raw diagnostic logs are temporary artifacts under
`/tmp/myco-workflows-feature-audit/`; strict route/Study screenshots and JSON are
under `/tmp/myco-desktop-feature-audit/`. They contain synthetic fixture content.

Confirmed mock-browser checks at the initial audit stage:

| Script | Result | Meaning |
| --- | --- | --- |
| `desktop-feature-smoke.mjs`, including default `npm run test:e2e` | 13/13 passed in the final run | Nine named routes, named Settings, Provenance/Inbox/Study visible error → Retry. No numeric navigation-index fallback or dynamic store imports. |
| `new-note-writing-smoke.mjs` | 20 checks passed | Real browser editing/create/cancel with in-memory persistence. |
| `query-smoke.mjs` | 5 checks passed | Mock Git activity versus wiki topic intent. |
| `ask-stages-smoke.mjs` | 8 checks passed | Extractive grounded states and no-index honesty with synthetic IPC. |
| `recall-smoke.mjs` | 27 checks passed | Synthetic history scope, timestamp/source links, and responsive layouts. |
| `agent-smoke.mjs` after narrow update | 8/8 checks passed | Current named Agent control, search tool trace, cited answer, and per-write confirmation with synthetic provider/tool IPC. No real agent model was used. |
| `audio-smoke.mjs` after narrow update | 8/8 checks passed | Current Reader More menu, transcript, citations, and enabled Play click without JS errors. Audible output/voice quality remains unverified. |
| `pdf-smoke.mjs` after narrow update | 8/8 checks passed | Current managed-folder/expanded-folder handling, real pdf.js canvas, highlight navigation, and live Markdown pinpoint navigation using synthetic bytes. |
| `editor-writing-smoke.mjs` after module-URL fix | 115 checks passed | Imports the actual Vite/HMR module loaded by the app. Editing, save failure/retry, delayed writes, undo, and raw read-only UI use synthetic native IPC. |
| `graph-looks-smoke.mjs` after current-UI update | 51 checks passed | Twelve named picker looks and live shader/control/flight behavior. Terrain/City presets remain for compatibility but are not in the picker; their saved rendering is explicitly unverified. |
| `route-smoke.mjs` | Exit 0, excluded | Uses old numerical nav indices and swallowed waits. It reports Graph/History/Provenance while visiting different current routes; its 6/6 claim is not route evidence. |

The initial serial run attempted 36 browser scripts: five exited zero (one is
the excluded route false pass), and 31 exited nonzero. The strict runner and
successful updated reruns are separate from that initial count. The current
`route-smoke.mjs` is now a compatibility entry point for the strict runner;
its original false-coverage implementation is replaced, not treated as proof.

Unresolved legacy harness failures are retained as such. The lists below describe
the initial run; an explicit successful updated rerun supersedes only that script.
They are not converted
to product failures or successful feature checks:

- Hidden/mobile navigation: `study`, `wikify-grounding`, `import`, `tasks`,
  `provenance`, `history-a11y`, `cmdbar-a11y`, `crash-screen`, `reindex-progress`.
  `multiverse` and `ollama-delete` stop at the same mobile-sidebar boundary.
- Current controls differ: `agent`, `audio`, `pdf`, `ask-ladder`, `clip`,
  `graph-looks`, `graph-readability`, `settings-save`, `notch-toggle`, `i18n`.
  Agent/Audio/PDF and Graph looks receive current-control/strict-wait updates;
  the remaining listed scripts are not repaired or certified in this audit.
  `woven` uses the obsolete graph drawer selector; `timelapse` still selects
  the old Overview label instead of Home.
- Dynamic `import('/src/stores/...')` during Vite HMR can reference an unversioned
  duplicate store while the mounted app imports a `?t=` version. `editor-writing`
  initially fail on module identity. The editor harness now imports the actual
  resource URL, including `?t=`, and passes 115 checks. `vault-startup` is not
  rerun with this repair, and its initial null-store failure is not evidence
  that native vault startup is broken.
  `orbit-ease` lost its browser execution context during navigation/HMR before
  its motion measurement completed and has no valid performance result.
- `semantic-discoverability`, `intake`, `everyday`, and `topbar-activity` stop at
  changed fixture/control expectations and require a focused rerun before a
  product diagnosis. Earlier successful assertions are partial evidence only.
- `notch-agenda` initially expects optimistic row disappearance. Completion ACK
  is fixed in the production action path; this old expectation cannot certify a
  backend-completed decision.

The separate legacy graph-readability/model-deletion scripts remain unresolved;
their initial failures provide no valid performance/model-deletion result.
Updated rerun results above are from execution, not inference from source.

Do not execute the legacy `smoke.sh` or `smoke_full.sh` in this environment.
They target old Memex DMGs, delete `~/Documents/Memex`/raw and app state with
`rm -rf`, and are unsuitable as safe myco regression runners. They were read
but not run. `brand-video-smoke.mjs` belongs to a separate brand gallery server
and is not desktop product coverage.

## IPC and unused-code evidence

Static extraction found 155 distinct literal `invoke` commands in `ipc.ts` and
156 registered Rust handler items in `lib.rs`, including command functions in
`tray`, `spotlight`, `notch`, `roam`, and `backfill`. Every extracted literal
command has a registration. This verifies names, not runtime arguments, access
control, real dependencies, network results, or cross-platform behavior.

The following IPC wrapper members have no production or smoke call site beyond
their definitions in the scanned tree: `backfillStatus`, `promoteSessions`,
`saveView`, `listViews`, `deleteView`. No computed `ipc[index]` or destructured
method consumer was found. These remain **candidates**, because compatibility
with native/public/external consumers has not been disproved. Saved search
views currently use `queryViews` localStorage and settings-bundle persistence.
No native command is deleted solely because its TypeScript wrapper is unused.
The five wrappers are preserved: removing only the wrappers would break the
existing registered-IPC/mock/API parity checks. The root owner separately removes
the obsolete optimistic notch helper/state and duplicate link runners after
their completion-ACK/shared-action replacements; those are not whole-file or
native-handler deletions.

These apparent orphan modules must be retained:

| Module | Actual consumer |
| --- | --- |
| `heroMesh.ts` | `hero-mesh.html` and capture-mesh tooling |
| `bigGraph.ts` | `big-graph.html` separate entry point |
| `langHtmlStub.ts` | Vite and Vitest aliases |
| `cpuMs.ts` | Markdown/math performance tests |

`tsconfig.json` includes `src` with unused-local/parameter checks, but successful
compilation does not prove that every exported module is runtime-reachable. No
unrelated production file was removed in this audit.

## Reproduction commands

Use a stable loopback Vite server and synthetic mock mode:

```sh
cd app
npx vitest run src/stores/studyStore.test.ts src/lib/cardStore.test.ts src/pages/PageStudy.test.ts
MYCO_TEST_URL=http://127.0.0.1:5173 node scripts/desktop-feature-smoke.mjs
MYCO_TEST_URL=http://127.0.0.1:5173 node scripts/agent-smoke.mjs
MYCO_TEST_URL=http://127.0.0.1:5173 node scripts/audio-smoke.mjs
MYCO_TEST_URL=http://127.0.0.1:5173 node scripts/pdf-smoke.mjs
MYCO_TEST_URL=http://127.0.0.1:5173 node scripts/editor-writing-smoke.mjs
MYCO_TEST_URL=http://127.0.0.1:5173 node scripts/graph-looks-smoke.mjs
```

The targeted Study suite passed 36 tests. Source ESLint passed for the five owned
Study/card files; repository ESLint does not cover `.mjs` smoke scripts. The new
runner deliberately blocks non-loopback HTTP(S) requests and writes artifacts
to `/tmp`. Root-owned full gates, native-window evidence, account prerequisites,
and measured link/embedding performance should be reported separately.

## Root-owned workflow fixes

The screenshot's 28,189 suggestions and 20-source harvest exposed several
independent failure paths. The following fixes are backed by synthetic
regressions and the native Rust gates; they have not been installed into the
previously running native app.

- **Links:** one conditional append per source document, exact vault-relative
  wikilinks, conflict retries, one shared action owner, and open-reader draft
  transforms. User typing remains in the existing editor/autosave path.
  Partial failures retain the remaining queue. Dismissal persistence keeps all
  decisions instead of silently truncating them to the last 500; storage quota
  failure returns failure and exposes Retry.
- **Harvest:** copying creates a pending receipt, not a completion receipt.
  Only selected inbox copies are processed, and long sources resume bounded
  evidence passes. Completion requires full coverage and successful archiving;
  the native ledger records the SHA-256 of the exact archived copy. Held,
  unsupported, refused, busy, changed-vault, and failed sources never count as
  completed. A changed original source becomes eligible again. Legacy
  copy-only records remain retryable and exact-byte copies can be recovered.
- **Local ingest:** explicitly confirmed extractive writes supplement the
  second-resolution mtime check, fixing repeated evidence batches written in
  the same second. Listing, reading, settings, and archive failures become
  visible errors. Unreadable quarantine settings fail closed. A selected
  source retains its identity even when it is held, unsupported, or refused.
- **Native copying/import:** temporary-file publication uses no-clobber
  semantics and checks the inbox destination remains confined. A growth cap
  prevents an expanding source from bypassing the existing size limit.
  Legacy projection lookup preserves a symlink's reserved identity so
  confinement rejects it instead of creating a duplicate projection elsewhere.
- **Notch:** requests register a matching completion listener before emitting
  the action. Pending, failed, and completed outcomes reflect the main writer's
  acknowledgement, with a bounded timeout. Link failures, partial harvest,
  failed/gated proposal approval, and failed proposal dismissal reject the
  acknowledgement. Removing the permanent optimistic-hide state also keeps a
  replenished harvest batch with the same row ID accessible.
- **Recovery and request ownership:** Inbox and Study expose read errors and
  Retry. Provenance invalidates cached/in-flight scans on vault closure or
  path changes and rejects stale results. The unchanged-vault revisit cache
  is retained. Proposal dismissal returns its actual write result and keeps
  its error after the closing refresh.

Obsolete optimistic notch helpers/state, duplicated link execution paths, and
the false-passing route runner were replaced. The five compatibility IPC
wrappers listed above remain; their existing parity tests require them.
No model, dependency, private-vault content, or unrelated visual behavior was
changed. The existing embedding GGUF is 41,641,440 bytes, approximately 42 MB.

## Measured optimization and limits

| Measurement | Before | After | Boundary |
| --- | ---: | ---: | --- |
| Link fixture read calls | 28,189 | 7,048 | 28,189 synthetic edges sharing 7,048 documents |
| Link fixture write calls | 28,189 | 7,048 | Same fixture; 75% fewer calls, not a disk latency measurement |
| Repeated pending-count derivation, 100 calls | 746.37 ms | 0.033 ms | In-memory immutable snapshots/cache, Apple M3 browser host |
| Native centroid edge ranking | 2,727.03 ms | 1,198.56 ms | Apple M3 debug Rust; 1,000 synthetic pages, 384 dimensions, k=4; identical ordered edges/scores |

The centroid algorithm computes each pair once and retains bounded top-k
instead of sorting every complete row. Its pairwise work remains O(N²); this
does not establish large-vault latency on Intel/8 GB. Dismissals are still
device-local browser storage, with quota limits and no multi-Mac synchronization.
The final frontend build retains large editor/graph/PDF chunks. An index entry
chunk below 200 KB gzip alone does not establish that total initial JavaScript
meets the 200 KB budget.

Harvest mock-browser scenarios each use 12 long synthetic sessions containing
819 evidence chunks. The normal scenario completes all 12; archive-error and
held-source scenarios complete 11 and keep one pending until retry, then reach
12. The longest session contains 191 chunks (about 96.7 KB) and takes four
bounded passes. Two unrelated inbox entries remain untouched in each scenario.
These execute the production evidence-receipt logic with in-memory IPC; they
do not prove native disk durability or real model inference.

Real Intel/8 GB profiling, signed installed-app button workflows, actual local
model/provider/media inference, native shortcuts/microphone/notifications,
credential-backed Gmail/Calendar/iCloud sync, and the iPhone client remain
unverified or unimplemented as indicated by the feature table. The missing
Developer ID Application identity blocks the signed release preflight; no
ad-hoc signing fallback or installed-app replacement was performed.

## Verification at a1c313f0

| Gate | Executed result | Scope |
| --- | --- | --- |
| `NODE_OPTIONS=--no-experimental-webstorage npx vitest run` | 4,268 passed across 317 files; 0 failed | Final frontend source and synthetic regressions |
| `npm run build` | Passed; TypeScript project build and Vite production build | Final frontend, 8.47 s Vite build on this host |
| `npm run lint` | Exit 0; 0 errors, 2 existing warnings | Both warnings concern unchanged voice-effect `machine` dependencies in `notchDriver.ts`; they are not reported as a warning-free lint result |
| `cargo fmt --all --check` | Passed | Final Rust formatting |
| `cargo clippy --all-targets -- -D warnings` | Passed | Final Rust source; no Rust changes after this gate |
| `cargo test --all-targets` | 1,000 passed, 12 ignored, 0 failed | Native unit/integration suites; ignored tests are not counted as executed |
| Explicit ignored centroid benchmark | 1 passed; exact ordered output matches reference | Synthetic M3 CPU benchmark, not an Intel performance guarantee |
| `cargo build --bin myco` | Passed | Native debug Mach-O arm64 binary, not a signed distribution or Intel run |
| `npm run test:e2e` | 13/13 passed | Final named-route and three error-recovery browser flows; mock IPC |
| Links browser workflow | 30/30 passed | 375/768/1280 px, partial/retry/storage/conflict/editor-draft flows; mock IPC |
| `npm run test:e2e:harvest` | Normal, archive-error retry and held-source retry passed | Each scenario contains 12 synthetic sources / 819 chunks; production evidence logic with mock IPC |
| Editor / Graph / Agent / Audio / PDF / Ask browser scripts | 115 / 51 / 8 / 8 / 8 / 8 checks passed | Updated current-control browser harnesses, with the boundaries above |
| `npm run build:macos:signed -- --check` | Failed: no valid Developer ID Application identity | Signed installed-app release remains blocked; no fallback identity was used |

The read/write destination regression, same-second ingest regression, request
race regressions, selected-source outcomes, and failed proposal-ACK regressions
were first observed failing before their respective fixes. The final gates
above ran successfully after the fixes, except the explicitly reported signing
preflight. The installed app and unrelated worktrees remain unchanged.

## Continued desktop development and verification

The following regressions were reproduced before their fixes:

- Ask clearing, closing/reopening a vault, delayed history responses, and delayed
  capture/recall writes could affect a replacement conversation. Independent
  capture and harvest actions also replaced the same turn object, losing capture
  receipts or permitting duplicate recall writes. Logical turn identity now
  survives these state patches without being serialized into history or prompts.
- Local retrieval had no visible Stop control. Settings, local search, Git
  activity, and intent classification now settle the question immediately when
  stopped; an already running native operation may finish, but its result is
  discarded. A Git read error is shown as an error instead of an empty history.
- Native root acceptance happened before the UI published the new vault. A
  dedicated opening state clears Ask before that change and blocks new questions.
  Accepted native metadata is published before fallible tree/link reads, so
  follow-up failures cannot leave the old vault displayed against a new root.
  Reset invalidates pending openings; late file reads from an earlier vault
  cannot replace the new active file, loading state, or error.
- Date parsing rejected the first quoted/filename/invalid occurrence but missed
  a valid later occurrence. It now checks every match of the same rule. IPC adds
  inclusive local-midnight start and exclusive next-day end in UTC seconds,
  preserving 23/25-hour daylight-saving days. Native tests cover Seoul midnight,
  the exclusive end, partial/reversed bounds, and explicit empty/null/non-array
  turn metadata. Missing metadata keeps the legacy month-bucket fallback.
- Import retry transport errors erased the original failure list. The list and
  destination now survive, the error stays visible, and Retry remains available.
- Tasks ignored a failed no-clobber create after an existing daily note read
  failed, then overwrote the note. Creation errors now propagate and the draft
  clears only after a successful write. Recurring task completion retains the
  original task in its detail panel; mobile controls clear the phone tab bar.

### Native cache measurement

Sequential warm edge requests were already cached. The new fixes share one
computation between overlapping cold requests and preserve derived results when
an identical store is published. Model/vector/geometry changes invalidate them.
Obsolete `store_edges` publication code was removed.

| Synthetic cache measurement | Before | After |
| --- | ---: | ---: |
| Cold edge calculation | 1,151.21 ms | 1,132.31 ms |
| Ten warm lookups | 0.035 ms | 0.057 ms |
| Three identical store publications and requests | 3,443.92 ms | 32.80 ms |
| Derived result allocations | 4 | 1 |

These are M3 debug measurements for 1,000 pages, 384 dimensions and k=4, not
Intel/8 GB certification. Cold calculation remains O(N²·dim), store comparison
is O(records·dim), and response serialization is O(Nk). A read interleaved between
disk save and cache publication can still trigger the existing freshness reload;
the benchmark does not establish that every no-op reindex avoids recomputation.

### Actual bundled E5 evaluation

No model or dependency was downloaded or replaced. The existing 41,641,440-byte
GGUF was used against public/synthetic fixtures through production Rust ranking.

| Evaluation | Executed result |
| --- | --- |
| Public retrieval | 62 queries, 71 pages/75 chunks; hit@1 52/62, hit@3 62/62, MRR 0.9167; query median 19.8 ms, p95 27.4 ms |
| Synthetic personal recall | 304 chunks; six answerable queries hit@1 6/6 and recall@5 6/6; both negative questions rejected; median 12.7 ms, p95 66.0 ms |
| Explicit CPU-only long-source probe | Three windows, maximum 498 tokens/window, one normalized 384-dimensional vector; passed with `MYCO_EVAL_CPU=1` |

The first two probes use the host's default embedding backend, including Metal;
only the third is explicitly CPU-only. They do not measure the user's private
vault, native installed-app workflows, or Intel/8 GB total-app memory. Lifecycle
status such as superseded/disputed claims is still not returned as a structured
retrieval field; selecting current versus historical claims needs a separate
policy rather than silently discarding historical evidence.

The updated browser logs are `/tmp/myco-{task,import,study}-workflows.log` and
`/tmp/myco-continuation-*.log`. Screenshots contain only synthetic data.

### Continued final gates

| Gate | Final executed result |
| --- | --- |
| Frontend unit tests | 4,308 passed across 319 files; 0 failed |
| TypeScript and production build | Passed; Vite 8.08 s on this host |
| ESLint | Exit 0; 0 errors, the same 2 unchanged notch voice-effect warnings |
| Rust formatting / Clippy | `cargo fmt --all --check` and `cargo clippy --all-targets -- -D warnings` passed |
| Rust all targets | 1,006 passed, 13 ignored, 0 failed; ignored model/benchmark probes listed above were separately executed |
| Native debug binary | `cargo build --bin myco` passed; arm64, unsigned distribution/Intel verification not claimed |
| Tasks / Import / Study | 115 / 39 / 75 browser assertions passed; synthetic IPC |
| Ask lifecycle / recall / stages | 36 / 27 / 8 browser checks passed; synthetic IPC |
| Named routes / linking / harvest | 13 routes/recovery checks, 30 linking checks, and all three 12-source/819-chunk harvest scenarios passed again |
| Reader editing after vault guards | 115 browser checks passed again, including delayed writes, undo, failed-save recovery, Korean input and raw read-only handling |

The vault acceptance, follow-up read and old-file races are synthetic IPC
regressions. Concurrent native open-command completion ordering itself was not
changed or exercised. The signed release preflight from the preceding audit
still has no provided Developer ID identity; no installed-app replacement,
ad-hoc signing, private-data mutation, account sync or iPhone implementation
was performed in this continuation. Existing model memory measurements are
not a total-app budget or an Intel/8 GB compatibility certificate.

Additional repeatable commands (run browser scripts with a stable loopback Vite
server, using only synthetic `?mock=1` fixtures):

```sh
cd app
npm run test:e2e:tasks
npm run test:e2e:import
npm run test:e2e:study
npm run test:e2e:ask-lifecycle
node scripts/recall-smoke.mjs
cd src-tauri
cargo test --lib cache_edges_repeated_request_benchmark -- --ignored --nocapture
cargo test --lib public_retrieval_e5_measurement -- --ignored --nocapture
cargo test --lib personal_recall_e5_measurement -- --ignored --nocapture
MYCO_EVAL_CPU=1 cargo test --lib e5_token_windows_keep_single_vectors_and_include_long_tail -- --ignored --nocapture
```

## Home responsiveness and layout guards

The user's next report identified buffering during harvest, tools remaining on
Home, and dense decorative lines behind the statistics. The fixes preserve the
Graph route and mascot. Ordinary Home visits start folded; only registered
activity targets open the disclosure. Closing unmounts `HomeManagement`, including
morning panels, layout observers, board and review widgets. The previous mounted
latch kept them alive behind `hidden`; CSS itself did respect `hidden`.

Home now has no ambient canvas. Page counts, link counts, seven-day activity and
saved arrangements remain. The obsolete Home background picker and its live
preview, canvas host and unused CSS were removed. Stored `overviewTheme` remains
compatible; the historical engine research modules are retained and no longer
advertised as a working Home setting.

A saved column layout exposed a real focus race: an activity target consumed its
focus request before the asynchronous layout load replaced the target's DOM
parent. Stable wrapper nodes now preserve focus; full-width view mode uses
`display: contents` to retain the previous stack's margin behavior. No global
focus timeout was extended. Links, contradictions and reflection all pass.

Closing also flushes pending arrangement saves. These and Home board saves carry
their originating `vaultPath` into `save_dashboard`. Native confinement checks
reject a switched root before creating or replacing a document. The native
stale-vault regression failed before the guard and passes after it; matching and
legacy calls still work. Layout and board failures now display a localized
warning instead of a silent catch. Rejected writes are not reported as saved.

Large whole-vault reads (`file_mtimes`, `search_vault`, `scan_provenance`, session
digest readiness and full-tier listing) now run on blocking workers. Embedding
status, semantic-map/edge/related reads, harvest and distill use asynchronous
cache loads. Hybrid, wikify and harvest cluster ranking are also offloaded.
Vector/BM25 caches retain single-flight parsing, mtime/length freshness and
revision-specific shared edge work. No ranking formula or embedding weights
changed. An offloaded task still has CPU/I/O cost and is not automatically
cancelled merely because its widget unmounts.

### Executed checks

| Check | Result |
| --- | --- |
| Frontend units | 4,316 passed across 322 files |
| TypeScript and production build | Passed; Vite 18.77 s during concurrent checks |
| ESLint | 0 errors; the same 2 existing notch effect warnings |
| Rust all targets | 1,013 passed, 13 ignored, 0 failed |
| Rust formatting and Clippy | Passed, including `--all-targets -- -D warnings` |
| Cache scheduling regressions | Inline loading failed 2 heartbeat cases; offloaded loading passes, with concurrent cold-load identity, rewrite/delete and edge sharing preserved |
| Home / layout saves / everyday UI | 78 / 24 / 35 browser checks passed |
| Links / named routes | 30 / 13 browser checks passed |
| Harvest | All 3 scenarios passed, each covering 12 sources and 819 chunks |

The browser checks use synthetic IPC. Closing during a held request is exercised
through the actual HarvestQueue action, then input, navigation and failed-run
settlement; it is not merely a manually set busy flag. Saved layouts, focus,
failed writes and switched-vault writes are checked without private data.

### Browser measurement scope

Single 1-second samples in Chromium at 375, 768 and 1280 px measured the already
opened, then folded Home. Before the fix it retained 120 animation callbacks per
second; after the fix all three samples recorded zero. Script time changed from
8.735 / 7.565 / 10.447 ms to 0.145 / 0.121 / 0.465 ms; task time changed from
37.582 / 41.047 / 67.877 ms to 2.848 / 1.168 / 4.026 ms. A held synthetic harvest
request measured 1.60 ms input processing and 4.10 ms to the next frame.
These are illustrative samples on the audit host, not native latency, percentile
estimates or Intel/8 GB certification. Native heartbeat tests instead establish
that cache contention no longer blocks the async runtime's current thread.

The entry JS chunk changed from 177.58 to 174.54 kB gzip in matching production
builds. This is one chunk, not all startup dependencies or application RAM.
Model artifact provenance and separate quality experiments are recorded in the
[local model review](2026-10-04-local-model-improvement.md).

## Native startup reads and design follow-up

The next native change moves document/settings reads, default-vault creation,
raw PDF bytes, plugin manifests, distillation status/run history, authorship git
reads and Ask's fallback context read onto blocking workers. Existing IPC names,
arguments, successful JSON/binary responses and domain validation are preserved.
Five root-taking adapters still canonicalize their arguments on an async worker
before dispatching the heavier body; this is not a claim that every filesystem
operation uses the blocking pool. `open_vault` remains synchronous and is not
covered by this change; making concurrent opens asynchronous also requires
native publication-order protection, rather than relying only on the TS sequence.

The gated synthetic read regression failed with `file read blocked the runtime
heartbeat` before offload and passes afterwards. It reads a real synthetic
regular file, preserves its raw/frontmatter contents, and verifies confinement
and missing-file errors. The held mutex is a synthetic scheduling gate, not a
reproduction of a specific macOS folder or permission delay. No FIFO/type guard
was weakened. Native gates pass: 1,015 tests, 13 ignored, formatting and Clippy
with `--all-targets -- -D warnings`.

The subsequent UI pass retains the original logo and character assets:

- Sidebar lockup: 32 px image, 17 px wordmark, natural-width Home target and
  separate 44 px Settings target. The duplicate accessible name is removed.
- Counts: centered 20 px sidebar badges and 15 px notch badges; longer counts
  grow without clipping. The waiting wing is 55 px for one digit, while the idle
  37 px wing and hardware cutout are unchanged.
- Roam: projected floor shadow, apex/return modulation, ground-run pointer
  clearance checks and hidden-window pause. The original hops remain. Cramped
  fallback paths and airborne positions do not guarantee 120 px clearance.
- Graph cameo: elapsed-time drift, live hidden/reduced-motion gates and one
  cancellable exit timer. Graph materials, camera and world anchor are unchanged.

The [design system](../design/design-system.md) records actual theme/type tokens,
component contracts, states, brand, responsiveness and motion rules. Current
implementation and subsequent targets are distinguished. README and repository
instructions link the guide; the notch spec has a dated count-geometry amendment.

Final frontend gates pass: 4,326 tests across 322 files, TypeScript/production
build (Vite 19.17 s), and ESLint with 0 errors and the same 2 pre-existing notch
effect warnings. Browser checks pass Home 78, brand 10 conditions, mascot 61,
and named routes 13, all with synthetic IPC. The entry JS chunk is 174.55 kB gzip,
not the complete startup dependency or RAM footprint.

Single synthetic observations: the brand changed from 187×32 to 94.5×44 px with
the English fixture font; hidden Roam changed from 60 to 0 callbacks/second.
A controlled 1-second cameo projection measured x = 3.1782 / 6.1643 at 60/120 Hz
before the timing fix, versus 3.12689849769 at both rates afterwards. These are
browser scheduling/geometry observations, not native frame pacing or Intel/8 GB
certification. Native VoiceOver, physical notch placement and iPhone behavior
remain separate checks.

## Ordinary local reinstall — native observation

The user's requested development reinstall was executed on 2026-10-04. This is
the actual application at `/Applications/myco.app`, not a parallel QA copy
sharing its identity and private data. The existing and replacement bundles are
version 0.4.0, identifier `dev.cmblir.myco`, arm64, with ad-hoc runtime signatures
and no TeamIdentifier. `codesign --verify --deep --strict` passed for source,
staged and installed bundles. No valid signing identity was available; this does
not replace a Developer ID/notarized release or certify an Intel build.

The original bundle was preserved at
`~/Library/Application Support/myco-install-backups/20261004-193502/myco.app`.
The swap uses a verified sibling staging bundle, same-filesystem renames and
rollback on verification failure. The installer does not reset vaults,
preferences, keychain records or TCC permissions. Ordinary application startup
can still perform its existing migrations, schedulers and indexing; a normal
launch is not a synthetic data-isolated test.

The initial replacement binary SHA-256 was
`0f8da06750d40962043c320c0870cd05da7375af67a5df93e2d2c731430b1e23`, versus
`1453d274c6bffce53c911fa4fba845b6260f2e934f6bca4b617913dfc79492dc` for the
original. It includes the earlier Home/cache changes; the design follow-up
requires the later rebuild recorded below. The unchanged bundled GGUF is
41,641,440 bytes, SHA-256
`bc06a6d33fc6a69f44168dbb4a3106b8350a7a2cef356b6b66fd81409437aa2b`.

Initial native observation failed twice with the computer-use runtime closing
its connection. A one-second symbol-stack sample found the main thread waiting
in `open/__open` under WebKit IPC. The stripped Rust frames did not identify a
command or file path; no private file tracing or memory dump was taken. The same
process later returned to its normal event loop. Accessibility/screenshots then
worked and showed Ask with indexing progress, followed by Home through its named
navigation button. No native harvest/link/write action was asserted. The exact
initial wait cause remains unconfirmed; the worker changes above are validated
scheduling fixes, not a proven diagnosis of that OS wait.

## Cross-window vault identity and acknowledgement

The existing notch agenda smoke failed two removal assertions because its
standalone mock had no main writer to acknowledge a delivered request. The
same failure reproduced on the previous source revision. Its replacement
fixture explicitly brokers outcomes and authoritative status updates: unrelated
or late replies cannot settle the current request, a negative reply retains the
row, and a positive reply alone does not delete it before the refreshed source
list arrives. This is synthetic protocol coverage, not a native writer claim.

That investigation exposed a separate product defect. A real button click in a
synthetic vault-A notch reached the production App listener with vault B active.
The old relative proposal name was rebound to B: the mock recorded both
`write_file` and `apply_distill_proposal` for B and an `ok: true` reply. The
regression failed with `2 !== 0`. Existing native confinement was not bypassed;
the main window had constructed a valid B path for an intent that belonged to A.

The protocol now carries `VaultActionScope { vaultPath, vaultToken }` from the
rendered panel snapshot to the main writer. The token rotates on module startup,
the beginning of each native-root transition, first-launch preparation and
reset. A-to-B-to-A and reopening the same directory cannot revive an old intent.
The main broker checks both identifiers and rejects mutations while opening;
contextless legacy mutation messages fail closed. Navigation retains its native
string contract. The Rust tray adapter preserves the scope and optional ACK ID,
checks its cached snapshot and leaves current-session validation to the main
window because the cache can lag a transition. Native menu distill also carries
the cached scope. Filesystem confinement and existing write checks remain.

The token regressions failed five cases before implementation and pass all 55
focused store/startup checks afterwards. Native scope serialization/cache tests
pass; the final Rust all-target run passes 1,021 tests with 13 ignored, formatting
and Clippy (`--all-targets -- -D warnings`). Frontend workflow and reinstall
results after the remaining session guards are recorded separately below.

### Final session-guard verification

Proposal reads, approval, dismissal, refresh and manual map drafting retain their
originating path/token. Pending UI state clears synchronously on transition,
while an absolute proposal's execution owner remains held until its existing
apply finishes. Concurrent list refreshes publish only the last-started result.
The manual map guard is optional, follows the existing manifest-ID argument and
does not alter other distill callers, model prompts or disk formats. Quarantine
actions and the complete auto-distill chain were not redesigned here.

Harvest candidate caches and semantic edges invalidate on token/path changes.
An agenda cannot attach B's new identity to A's cached queue. Link reads,
follow-up decisions, retries and progress use the origin session. Senders capture
the rendered snapshot, then check the latest scope before delivery and feedback;
they do not rebind an old DOM click using a newly received ref. Pending keys,
ACK completion and delayed UI callbacks are scoped. A matching success response
still waits for authoritative source-list removal. Already-dispatched IO/model
work is not rolled back; outstanding ACK listeners finish on response or timeout,
rather than cancelling the main writer on unmount.

Additional regressions reproduced stale proposal writes, late refresh overwrite,
lost absolute-file exclusion, and late harvest/semantic/link results before their
guards. Final frontend units pass 4,366 tests across 322 files. TypeScript and
production build pass (Vite 9.98 s in that run); lint passes with 0 errors and the
same 2 pre-existing notch effect warnings. The entry chunk is 174.54 kB gzip.
No dependencies or model weights were added or upgraded.

| Final browser check | Result and boundary |
| --- | --- |
| Home | 78/78; actual loaded-module resolver prevents a warm Vite/HMR graph from creating a second store in the test |
| Sidebar brand | 10 theme/viewport/motion/touch conditions; named keyboard destinations and focus |
| Mascot | 61/61; synthetic projected geometry and frame clocks |
| Notch agenda | 37/37; explicit synthetic writer ACK/status broker |
| Notch and tray vault boundary | 73/73 over 9 production sender/App-broker scenarios; current-scope controls produce 2 expected storage effects, stale controls produce 0; native-menu-shaped no-ACK envelopes and legacy rejection included |
| Suggested links | 30 checks over 375/768/1280 px; partial failure and retry |
| Harvest | All 3 scenarios, each processing 12 sources and 819 chunks |
| Named routes and recovery | 13/13 |

The final Home rerun uses an 8,192-entry resource timing buffer and resolves the
module URL actually loaded by the app, including Vite query revisions. Its
previous warm-server run failed at `Synthetic graph is required`; no product
graph was replaced with a fabricated default to make it pass. The same module
identity protection prevents false current-scope controls in the two-window
tests. Single synthetic Home samples recorded 0 folded RAF callbacks at all
three widths and 0.4 ms input processing / 1.5 ms to the next frame during a held
harvest request. Concurrent host load was not controlled; these are not native
latency percentiles or Intel/8 GB measurements. Browser checks do not assert
native disk writes, physical notch placement, VoiceOver or iPhone behavior.

## Native rebuild and startup investigation

The UI and session-guard revision was installed at 21:11 KST. Its binary SHA-256
was `fb98828ed1b0e65aa1995fc1768c216b9bedb62364b42e1da12a905462f897c6`.
The root-launched process then stalled: repeated accessibility observations
reported `runtime_unavailable: The Orca runtime closed the connection before
responding`, although the global runtime status remained ready. A one-second
sample found the native main thread in `__opendir2` / `open$NOCANCEL` under WebKit's
URL-scheme task handler for all 830 collected samples. Stripped Rust frames did
not identify the invoked command or directory. A targeted window screenshot
showed the new sidebar brand and Settings, with no editing operation initiated
by the audit. Pixels alone do not establish responsiveness.

Source tracing found always-on quarantine enumeration and conditional CLI or
inbox discovery still using synchronous commands. `list_quarantine`,
`list_inbox_entries`, `claude_check` and `whisper_check` now use the existing
blocking-worker helper. Successful response shapes and confinement remain;
worker failures reject instead of hanging or claiming success. This narrows a
demonstrated scheduling risk, but does not establish which old command caused
the observed OS wait. `open_vault` remains synchronous for the publication-order
reason described above.

After these four adapters, Rust all-target tests again pass 1,021 tests with
13 ignored; formatting and Clippy with warnings denied pass. The fresh Tauri
release reran TypeScript/Vite successfully (6.60 s for Vite, 2m24s for the native
release build). Frontend source was unchanged from the final 4,366-test run.
The stalled root-launched process did not respond to its ordinary quit request;
SIGTERM exited it without SIGKILL before replacement. No data or permission
reset was used.

The verified replacement was installed at 21:32 KST, preserving the previous
bundle at `~/Library/Application Support/myco-install-backups/20261004-213248/myco.app`.
The current binary SHA-256 is
`c70bbfdceb6512f251fe44aa73cb32b4c7fecb2ac31cb3095d0cafc867a5be3d`.
Source, staging and installed signature verification passed. The bundle remains
arm64, version 0.4.0 and ad-hoc signed; no notarization or Intel certification is
claimed. The installed embedding GGUF remains byte-identical to the model hash
recorded above. Launch was requested after the swap; native UI observations are
recorded separately from the synthetic workflow checks.

The next launch returned accessibility observations and allowed an actual Home
navigation click. A subsequent rich accessibility tree and screenshot confirmed
the Home route, new sidebar lockup and collapsed management button. The initial
AX tree contained only native window controls; the click's provider response had
no verification metadata, so its reported success alone is not the assertion.
The changed Home tree and pixels supply the navigation evidence. No native
harvest, link or proposal write was exercised.

Inventory preparation remained pending: the sidebar showed an empty tree and
zero-count summary, while Home correctly retained its recent-notes loading label.
This is not evidence of an empty vault. A later one-second sample showed the
main thread in its ordinary AppKit event loop and dozens of other threads in
`__opendir2`; 85 thread blocks were collected. The specific directories and
commands remain unidentified. A later AX observation reported a single generic
`Tauri App` system-dialog element while its screenshot still showed Home; no
permission cause is inferred from that mismatch and no permission was reset.

Source review found two avoidable fanout paths under slow reads: periodic vault
refreshes can overlap, and the tray's null inflow cache can start another probe
on every vault-store update while its first probe is pending. These are separate
source/reproduction findings, not symbol-level identification of the sampled
threads. Their regression and final reinstall results follow below.

### Slow-read fanout regressions and loading presentation

Held synthetic production probes reproduced 21 `inflow_stats` calls for the
initial request plus 20 vault-store updates; the guarded loop starts one.
A held `scan_tasks` was started again after the two-minute send throttle;
the guarded loop retains one pending read. Scope-specific owners permit a
different path/token to start immediately. Late responses and cleanup cannot
publish into or release a new session's owner. Cached inflow/task counts reset
on a session transition, the completed-read throttle remains two minutes, and
failed reads release ownership for retry. Warnings omit paths and task contents.
The seven new tray regressions pass; the tray test file passes 58 tests.

Periodic graph refreshes now join their session's active reads through revision,
tree and graph phases. Both parallel reads settle before ownership releases,
even when one fails. Newer forced refreshes retain latest-started publication,
and their completion cannot release an older held poll. Path/token/sequence gates
reject stale tree, graph, baseline and failure publication; failed freshness
baselines allow a retry to rebuild. Native vault opening suppresses new refresh
starts. Eleven new regressions pass, following nine initial failures and an
additional superseded-flight reproduction; the store file passes 57 tests.

Sidebar and StatusStrip now distinguish inventory preparation from a measured
empty result. Pending and previous-vault rows are withheld, the tree is busy,
and the existing status disclosure uses loading for inventory/index counts.
Empty/zero remain valid completed results. Structure, disclosure state,
translations and brand are preserved. Locale/previous-row regressions first
failed; final Sidebar and StatusStrip tests pass 35 checks with synthetic SSR.

After this follow-up, the complete frontend run passes 4,392 tests in 322 files.
TypeScript and full ESLint pass, with 0 lint errors and the same 2 existing notch
effect warnings. Fresh browser reruns pass Home 78, brand 10 conditions and the
73-case notch/tray boundary check. These remain synthetic IPC/webview checks;
the native Rust source is unchanged from the 1,021-test/13-ignored gate above.
The follow-up does not cancel blocked OS IO or merge every startup read. Initial
`openVault` still waits for tree, graph and favorites before publishing inventory;
Home's independent `fileMtimes` has no timeout. Folder permissions, OS IO and
actual private-vault harvest/write completion require separate native evidence.

### Latest installation receipt

Before the last swap, a fresh native Home observation in the prior binary showed
3,320 notes; both the empty-tree label and recent-notes loading label were gone.
The delayed reads had settled. Their resolution mechanism is still unknown;
this does not establish a permission diagnosis or attribute recovery to the
subsequent fanout guards.

The final UI/polling revision was built from commit `8e0ac603`, with TypeScript
and Vite passing again (6.68 s; entry chunk 174.55 kB gzip), and native release
build/bundling passing in 2m29s. Ordinary keyboard quit attempts encountered
`window_not_focused`; after the restore attempt the previous PID was absent but
a new myco process was present, so the installer refused to swap a live app.
No cause for the relaunch is inferred. A normal `NSRunningApplication.terminate`
request subsequently exited the remaining instance, and process absence was
verified. This final quit used no force-termination API or signal.

The Swift version of that temporary quit helper did not execute: the installed
Command Line Tools reported `redefinition of module 'SwiftBridging'` and
`failed to build module 'AppKit'`. No SDK or module-map repair was attempted.
The equivalent Objective-C helper compiled against the installed AppKit headers
and sent the ordinary quit request. This helper failure is separate from the
passing product build and tests.

The installer completed at 22:09 KST. The replaced bundle is preserved at
`~/Library/Application Support/myco-install-backups/20261004-220918/myco.app`.
The installed binary SHA-256 is
`b14d91046aa3745c9fd1f1265c49ee0ed0a4cd6320aa7b47088398aa113a8e2f`.
Source, staging and installed signature verification passed. Version remains
0.4.0, architecture arm64 and signature ad-hoc; no notarization is claimed.
The installed GGUF size/hash still match the unchanged model above. Vaults,
settings, keychain records and permissions were not reset by the installer.
Normal startup remains distinct from an isolated synthetic fixture.

The latest launch responded to native observations. After bringing its existing
window forward, the accessibility tree contained 62 elements on Home. Pixels and
the tree showed the retained original brand, inventory/status loading labels,
no false empty-vault label, and the collapsed management button with no layout
editor controls. Recent notes still displayed loading during this observation;
final private inventory and writer completion are not claimed. A one-second
sample contained 48 thread blocks, 28 waiting in directory opens, while the main
thread remained in its normal AppKit run loop. Startup age and OS conditions
differ from the previous sample: these counts are not a controlled performance
comparison or proof that every pending read was deduplicated. No actual private
harvest/link/proposal write, account permission, VoiceOver or Intel/8 GB test was
performed in the final native check.

## Owner correction: delete the collapsed menu-bar attachment

The owner reiterated deletion of the mushroom and number shown beside the
hardware notch. Earlier badge-centering work had retained the unwanted display.
The correction removes collapsed avatar/count markup, wing width helpers and
styles, native wing state and the resize IPC wing parameter. The collapsed
notchless background is also transparent. The open panel retains capture,
voice, agenda rows and scoped action acknowledgements. Roaming keeps its
existing motion/shadow, but enters through the cutout and leaves no resting
avatar in its preview.

Regression tests failed before implementation: SSR still rendered a collapsed
mascot for waiting counts 0, 1, 2 and 28,189, and the initial/re-shown native fit
returned `(241, 37)` instead of the transparent `(204, 51)` input target. Both
contracts now pass. The installed old app's public window metadata independently
showed a level-25 `263×37` panel at `(801, 0)` before replacement; its main window
was observed separately. No private file contents were needed for that probe.

Validation after the correction:

- Frontend: **4,383 tests in 322 files** pass; type-check passes; ESLint has
  zero errors and the same two pre-existing voice-machine dependency warnings.
- Native: **1,019 passed, 13 ignored** across all targets; formatting and
  Clippy with warnings denied pass. Ignored real-keychain and other opt-in
  cases were not enabled.
- Synthetic Chromium: mascot/motion **61**, notch agenda **37**, vault boundary
  **81** checks pass. Positive counts 2, 99 and 28,189 across 375/768/1280px
  preserve an interactive transparent `204×51` hotspot with no collapsed
  avatar, count, dot, wing or card. The inspected closed screenshot has no
  decoration. Hovered rows, keyboard focus, ACK failure/retry and scoped writer
  positive/negative controls remain covered. These are synthetic IPC checks,
  not actual private-vault writes or native pixel evidence.

README and the design guide now state the invisible collapsed contract. A dated
owner correction in the mascot spec supersedes its earlier wing amendments.

The release build/bundle passed (Vite 6.94s; native release 2m34s). A normal
`NSRunningApplication.terminate` request exited the old PID; process absence
was checked before replacement. Installation completed at 23:11 KST with the
old bundle backed up at
`~/Library/Application Support/myco-install-backups/20261004-231159/myco.app`.
The installed binary SHA-256 is
`51a11b6d5093a613d2bafa4e591aa097a9227f5cfa42464362691730a633d49a`.
Source/staging/installed signatures verified; the bundle remains 0.4.0 arm64
with an ad-hoc signature, without notarization. The embedding GGUF size/hash
remain unchanged. The installer did not reset vaults, settings, credentials,
or permissions.

After relaunch, public native metadata measured the level-25 notch window at
`208×51`, `(856, 0)`: the old 55px extension is gone. Two targeted captures of
that window contain **zero nontransparent pixels out of 42,432**, including
after the main Home webview was observable with 62 accessibility elements.
ImageIO/CoreGraphics read the PNG's alpha channel; the initial optional Pillow
probe could not run (`ModuleNotFoundError: No module named 'PIL'`), and no
dependency was installed. Home pixels retain the Sidebar identity and show
inventory loading. These observations certify the idle attachment's absence,
not completion of existing private-vault startup reads or every native writer.

## Ask evidence correction — 2026-10-05

The follow-up fixes distinguish personal-day recall from file modification
history, preserve verified BM25 evidence while dense vectors are absent or
stale, and show existing wiki links/shared tags for undated generic connection
questions. Topic-free dated activity now reads bounded original transcript
excerpts with actual turn timestamps and all four speaker roles; it does not
verify completed tasks. Explicit scopes remain authoritative.

The new [Ask recall verification ledger](2026-10-05-ask-recall-verification.md)
records the reproduced failures, source/date/duplicate boundaries and resource
limits. Executed checks are 4,503 frontend tests in 324 files, TypeScript pass,
ESLint zero errors with two unchanged warnings, 65 Ask-recall and 42 Ask-stages
synthetic browser checks, and 17 native chronology tests. The explicit
500-page synthetic chronology probe checked 64 files and returned 48 of 64
dated excerpts in 10.761 ms on this Apple M3 Mac. This is neither model speed
nor Intel/8 GB certification. Rust formatting and all-target Clippy pass. The
full native suite completed with 1,040 passed, no failures and 14 ignored tests;
the chronology timing probe was separately executed as described above.

The release build passed and the app was reinstalled with a verified backup on
2026-10-05. The new executable SHA256 is
`1eb1abfd305ac0c5e1c2f5f89a9ef106dd114821bd91cc385e4e502c2e7351ba`.
The installed bundle remains version 0.4.0, arm64 and ad-hoc signed. Relaunch,
the unchanged single E5 artifact and an invisible idle menu attachment were
verified. Home inventory remained loading during the observed snapshots;
private-vault Ask results are unverified. The linked ledger contains this
installation's receipt, backup and native observation limits, separately from
the older receipts and synthetic browser/native-fixture coverage.
