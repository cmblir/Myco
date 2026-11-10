# Installed myco continuation — 2026-10-06

This follows the [local role comparison](2026-10-05-local-model-routing.md)
and [desktop audit](2026-10-04-desktop-feature-audit.md). The requested scope
covered local Ask/recall, editing, graph/notch/settings UI, and the installed
macOS app. No models, provider preferences, credentials, or private vault
contents were changed by the verification harnesses.

## Changes and regressions

- **Current local Ask evidence:** the original check accepted a selected
  excerpt when another section of its page had changed. A synthetic regression
  kept the selected excerpt identical while editing, appending, or removing a
  later section; it failed before the fix. Ask now compares the complete page's
  chunk hash array with BM25, then retains a SHA256 of the complete file for
  comparison after generation. A second regression covers frontmatter and
  whitespace changes excluded from chunking. Source rejection keeps the
  existing fresh-search Retry contract. All ten local-generation tests passed.
- **Safe recalled block insertion:** a timed-out initial syntax lookup could
  miss an outer list while a later lookup found its child, placing text inside
  the list. A controlled-clock test reproduced that case before the fix.
  Insertion now obtains one complete tree before looking up boundaries, with
  at most two 50 ms cooperative parsing attempts. Continued delay preserves
  the full document and selection and emits visible retry advice. A successful
  retry inserts after the enclosing list and remains one undo step.
- **Mobile graph inspector:** at 375 px, the title's center hit the Graph tools
  button instead of the title. Only the mobile inspector's stacking order was
  raised above those tools. The same hit-test, region semantics and keyboard
  close passed at 375, 768 and 1280 px after the fix.
- **Resident macOS reopening:** `RunEvent::Reopen` now shows, restores and focuses
  the maintained main window, irrespective of a retained notch window's
  visibility. The API and event path were checked against installed Tauri
  2.11.1 and Tao 0.35.2 sources and compiled by the native test build.

Unbounded editor parsing was measured and rejected: a synthetic 5 MB list
could block for several seconds. In 24 bounded insertion scenarios, each
operation either inserted at a complete boundary or preserved the document
and caret. Large prose/list rejection took approximately 101–149 ms; a 5 MB
fence case including state update/GC reached 574 ms. The parsing budgets are
soft, not a hard 100 ms wall-clock guarantee or an idle-machine benchmark.

## Browser coverage

These checks run the real React/CodeMirror/WebGL code in Chromium with
synthetic IPC and notes, not native model inference or a private vault.

| Check | Result |
| --- | --- |
| Editor writing and Reader insertion path | 119 checks passed; source/live modes, save/recovery, declined insertion, retry, one undo |
| Ask freshness/refusal and fresh-search Retry | 132 checks passed at 375/768/1280 px in Korean, English and Japanese |
| Current graph looks | 12 looks × 375/768/1280 px: 36 scenarios passed, no page errors |
| Notch toggle | 64 checks passed at 320/375/768/1280 px |
| Settings saves and disconnected-provider recovery | 66 checks passed at 320/375/768/1280 px |
| Notch agenda | 37 checks passed |
| Sidebar brand, themes and touch | 10 scenarios passed |

The existing graph/settings/notch scripts were updated to navigate current
mobile settings, use current provider switches and graph look names, and import
the module actually mounted by Vite. Graph selection uses development scene
APIs; picker actions, mobile tools, title geometry and keyboard close use
visible controls. Scripts also check horizontal overflow. No production
settings or provider selections are used by these scripts.

## Verification boundaries

Native tests passed with 1,095 successful cases and 15 ignored opt-in cases;
the ignored cases include real keychain/model requirements. Benchmark targets
ran in test mode, not as new model performance measurements.

The first full frontend attempt was interrupted during severe host contention
and is not a passing receipt. Existing graph-layout and autocomplete timing
assertions exceeded their unchanged limits under that load. A subsequent
serial run also caught the new Korean retry wording using `메모`; it was
corrected to the established `노트` vocabulary without changing the test.
The completed serial run passed 329 suites/4,663 tests and failed only that
wording assertion. After the correction, the four relevant suites passed all
112 tests: glossary, recalled insertion, editor/autocomplete, and graph layouts.
The unchanged 1,244-note graph frame-budget test measured 83.8 ms in that
recheck. Final editor browser checks were rerun with the corrected wording.
ESLint exited successfully with the two existing `notchDriver.ts` hook warnings;
native formatting and Clippy with `-D warnings` passed without warnings.

No new actual Qwen inference evaluation, Intel/8 GB run, account integration,
VoiceOver session, or 3G measurement was performed. The role comparison's
paraphrase retrieval gaps and sentence-level generation uncertainty remain.
No relevance threshold or model selection was changed to hide those limits.
The local signing preflight reported no valid Developer ID Application
identity. The installed app already used an ad-hoc signature; stable signing,
notarization and folder-permission persistence across builds remain unresolved.
Existing dependency audit findings were recorded without an unsolicited major
toolchain upgrade; the package manifest and lockfile were not changed.

## Build, installation and native observation

The current-source frontend type/build and arm64 macOS release bundle completed
successfully. The bundle used the existing project's release dependency cache
with two build jobs, not another worktree's source or frontend assets.
The ordinary development build retained ad-hoc signing and skipped notarization;
the guarded stable-signing command was not modified.

| Receipt | Verified value |
| --- | --- |
| Installed application | `/Applications/myco.app` |
| Version / identifier | `0.4.0` / `dev.cmblir.myco` |
| Installed executable SHA256 | `9ded49abce371592c06e9e9b8944700a733dfb73cffab4c9dff35bdec4888296` |
| Previous executable SHA256 | `3943392f4db6330541eecb3b27d5b9990729b28e9606e137ff645cb89bf84bc9` |
| Previous-app backup | `~/Library/Application Support/myco-install-backups/20261006-172837/myco.app` |
| Signature | Ad-hoc; `codesign --verify --deep --strict` passed for build, backup and installed app |
| Bundled E5 file | Identical SHA256 before and after installation |

The idle prior app was quit through its normal menu before replacement. A
verified new bundle was staged and renamed into place, with the previous live
bundle retained beside the backup. The installed executable launched from the
exact application path, and its main window and production web content loaded.
No OS permission dialog appeared during these observations.

With resident mode and the notch already enabled, the main window was closed.
The application retained the same process and a secondary window. Opening the
exact installed application in Finder restored the main window and production
web content without restarting that process. No preference was toggled, source
file edited, model question submitted, or private note contents exported during
this check. This confirms the installed resident/Finder reopen path; it does not
certify every native UI workflow, future TCC approval, or folder-permission
persistence on another rebuild.

## Permanent deletion, missing-note recovery and activity-answer follow-up

The follow-up request explicitly chose immediate permanent deletion instead of
moving deletion targets to Trash, reported a missing-session canonicalization
error, and supplied the conversation-scope question **최근 일주일동안 한일**.
The earlier checks above did not evaluate that exact question's answer quality.

- **Deletion policy:** legacy installations default to recoverable deletion.
  The optional policy covers manual deletes, approved delete proposals and
  eligible automatic expiry without bypassing original/session approval guards.
  Native commands capture one persisted policy and reject a confirmation made
  under another policy. Whole batches are confined and checked for symlinks
  before removal. With permanent deletion enabled, automatic runs purge only
  manifest-proven internal myco trash copies and separately record irreversible
  removals; unknown internal
  folders and the system Trash are not emptied. Undo cannot recover files
  whose copies have been permanently removed. Synthetic regressions cover
  actual temporary-file removal, protected targets, partial-batch prevention,
  policy mismatch, legacy settings, old-run manifests and irreversible Undo.
- **Reader ownership:** late reads cannot replace newer navigation, restore a
  deleted/moved path, or leak an old error into the sidebar. Current missing or
  unreadable reads take priority over cached content and show recovery while
  preserving drafts. Same-root vault reopening waits for the current native
  root. Controlled failed-read regressions were run before the fix, followed
  by store, reader and browser recovery checks. The reported missing original
  was not recreated; the cause of its disappearance is not established.
- **Activity answer:** the built-in provider recognizes the exact Korean
  recent-week question and uses today plus the preceding six local dates.
  Dated original statements are bounded to four per status, with source,
  speaker, time and coverage limits. Recognized requests, plans, conditions,
  negations, examples and code do not establish performed-work evidence.
  Final review reproduced three leading English conditions (`Once`, `When`,
  `After`) being misclassified as reported work; a leading-clause guard fixes
  them while retaining an actual past-action report with embedded `after`.
  Phrase rules do not resolve every formulation, and an assistant's completion
  report remains a report, not independent verification of actual work.

The installed production UI accepted and saved the user's permanent-deletion
choice, and the switch remained on after a normal quit and relaunch. The exact
question was submitted using **Built-in (offline) / extractive-retrieval** and
**conversation records**. Its answer completed with the **2026-09-30–2026-10-06**
window and all three status headings. It reported incomplete coverage: 63 of
815 indexed records checked, 347 dated excerpts found and 48 considered. The
visible groups contained 4 reported-result, 2 progress and 4 unconfirmed items
with citations; the old `Need your decision` heading was not dumped as the
answer. Private record bodies were not copied into fixtures or this report.
This confirms production parsing, retrieval and output structure, not the
truth of every reported task or complete coverage of all weekly activity.

No user file was deleted manually for verification, and no OS Trash purge was
performed. Existing saved answers are not rewritten; the fresh question
produces the updated output. Qwen inference, Intel/8 GB behavior, account
integrations, VoiceOver and 3G remain outside these checks. Models and provider
preferences were unchanged; the deletion preference was changed as explicitly
requested, and the native Ask checks created local question-history entries.

Follow-up verification uses the production TypeScript/React/native paths. The
browser harnesses replace native IPC with synthetic records; they are not
native model-inference or private-vault deletion checks.

| Check | Result |
| --- | --- |
| Final frontend suite | 331 suites / 4,724 tests passed after the leading-condition fix |
| TypeScript / frontend build | Passed |
| ESLint | Passed with the two existing `notchDriver.ts` hook warnings, no errors |
| Native all targets | 1,105 passed, 15 opt-in tests ignored; benchmark test mode completed |
| Native formatting / Clippy | Passed; Clippy used `--all-targets -- -D warnings` |
| Ask activity browser check | 86 passed |
| Deletion-policy browser check | 56 passed at 320/375/768/1280 px |
| Stale-reader browser check | 76 passed, including mobile recovery and pending reads |
| Leading-condition regression | Three failures reproduced before the guard; related four suites passed 216 tests afterward |

An initial native all-target invocation passed the unit tests but exited with
`error: unexpected argument found` when Criterion received `--test-threads=1`.
The corrected command, `RUST_TEST_THREADS=1 cargo test --all-targets`, completed
successfully. Clippy initially rejected two cloned single-element test slices;
both were corrected to `std::slice::from_ref` and rechecked. A new confirmation
test's setup hook initially returned a mock cleanup function accidentally; the
hook was corrected and all focused confirmation regressions passed. An older
history timing check exceeded its unchanged 5-second limit under build load;
its subsequent focused run passed without weakening that limit.

Local receipts include `/tmp/myco-cleanup-vitest-current.log`,
`/tmp/myco-cleanup-lint-current.log`, `/tmp/myco-cleanup-native-all-final.log`,
`/tmp/myco-cleanup-clippy-final.log`, `/tmp/myco-activity-quality-final.log`,
`/tmp/myco-deletion-policy-final.log`,
`/tmp/myco-stale-reader-portable-2026-10-06.log` and
`/tmp/myco-leading-condition-{red,green}.log`. The expected failure log retains
the assertion stack for each misclassified synthetic condition. UI recovery
and destructive-operation tests use disposable synthetic data only.

The final current-source arm64 macOS app bundle completed after the additional
condition fix. The installed app was idle, quit normally, and replaced using a
verified staging bundle with a rollback copy. The final executable was launched
from `/Applications/myco.app`; permanent deletion remained enabled across the
final replacement. Signing remains ad-hoc and notarization was not performed;
the stable-signing guard and bundled model were unchanged.
The exact conversation-scope question completed again in the final installed
bundle with the same date window, three status headings and incomplete-coverage
notice. No stale canonicalization error appeared in the current sidebar.

| Final installation receipt | Verified value |
| --- | --- |
| Version / identifier | `0.4.0` / `dev.cmblir.myco` |
| Executable SHA256 | `c88cb54bda9df47c068cbab6af36fa28f610c35f8a845db359797be49e2eef45` |
| Previous follow-up executable SHA256 | `785af9b57156f6ee9713a4ee842a4fa0b420fce4515f4ea8ea75b392cd66083a` |
| Previous-app backup | `~/Library/Application Support/myco-install-backups/20261006-193903/myco.app` |
| Original continuation-app backup | `~/Library/Application Support/myco-install-backups/20261006-192330/myco.app` |
| Signature verification | `codesign --verify --deep --strict` passed for candidate, backup, staged and installed bundles |
| E5 SHA256 before and after | `bc06a6d33fc6a69f44168dbb4a3106b8350a7a2cef356b6b66fd81409437aa2b` |
| Build / install receipts | `/tmp/myco-cleanup-release-current.log`, `/tmp/myco-cleanup-install-current.json` |
