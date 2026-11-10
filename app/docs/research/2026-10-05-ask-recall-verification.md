# Ask recall verification — 2026-10-05

The later [local role update](2026-10-05-local-model-routing.md) also fixes
`내가 어제 한 일들에 대해서 알려줘`: dated overview routing now returns even
empty/incomplete verified records instead of falling through to similarity search.
Generic connections in conversation-only scope return the scope notice before
retrieval, preventing a test plan quoting that question from becoming an answer.
The receipts below describe the earlier build.

This records the bounded Ask fixes prompted by two reported questions:
`어제한 일` returned today's recently modified files, and
`서로 연결되는 아이디어가 있어?` abstained without showing existing note
connections. It is a continuation of `fix/desktop-workflows`, not certification
of every Ask question, desktop feature or the owner's private vault.

## Causes and changed behavior

| Confirmed cause | Current behavior |
| --- | --- |
| The date parser already recognized `어제`, but personal-history routing missed subject-free wording such as `어제한 일`. A broad metadata fallback could then replace missing content evidence with an unrestricted recent-file list. | Conservative personal-activity routing recognizes omitted subjects. An implicit wiki default can widen to `all`; a caller's explicit scope or the persisted explicit selection remains authoritative. File metadata is reserved for explicit file questions. |
| A generic question about what happened yesterday contains no useful topic for similarity search. | For the built-in provider, a topic-free activity question with a parsed date range first reads bounded, indexed original conversation excerpts. Topic-qualified questions continue through normal retrieval; this is not a general activity summarizer. |
| Empty or incompatible dense-index status prevented the frontend from calling retrieval, even though native BM25 could independently find evidence. | Ask still calls hybrid-search IPC. With zero or stale dense vectors, only source-verified lexical hits marked `exact_match` can answer. An unverified simulated high-cosine response is rejected. The relevance floor was not lowered. |
| The old recent-file answer did not apply the requested period or preserve distinct paths sharing a basename. Broad activity routing could also use unrestricted Git history for a dated request. | File-modification answers apply the range and scope before the display limit, cite vault-relative paths, skip unknown timestamps/outside-root paths, and retain distinct filenames at different paths. Repository-history questions do not fall back to file mtimes. A dated request, session-only scope or one-note request cannot use the unrestricted recent-Git shortcut. |
| Generic connection discovery had no dedicated structural-evidence answer. Similarity to generic words alone could abstain. | An undated generic connection question can show resolved existing wiki links and shared tags with source-path citations. Both link endpoints must be readable knowledge pages within scope. These are recorded relationships, not newly generated conceptual insights. |

The conversation-only scope cannot establish the wiki graph's links or shared
tags. When that scoped query abstains, Ask explains the limitation and offers
the existing wider-scope retry. Topic-specific or dated connection questions
retain normal retrieval; the undated graph overview cannot establish when a
relationship arose. Graph output is bounded to five link pairs, three shared
tags and five notes per tag, with scan-limit coverage shown.

Implementation entry points:

- [Recall routing](../../src/lib/recallPolicy.ts) and
  [file/Git intent and formatting](../../src/lib/queryIntent.ts).
- [Ask orchestration](../../src/stores/queryStore.ts),
  [zero/stale dense retrieval](../../src/lib/chat.ts), and
  [structural connection overview](../../src/lib/queryConnections.ts).
- [Original transcript reader](../../src-tauri/src/temporal_recall.rs),
  [native date/filter and IPC boundary](../../src-tauri/src/commands.rs), and
  [chronological excerpt formatting](../../src/lib/queryTemporal.ts).

## Original dates, identity and coverage

Chronological recall reads only indexed `sessions/**` and
`raw/conversations/**` candidates permitted by the requested scope, optional
path set and archived-session setting. It does not walk the vault filesystem.
Each current source must remain confined to the open root and pass the same
scope/cold-path checks after symlink resolution. Its complete re-derived chunk
hash array must equal the current BM25 page hashes.

Evidence dates come only from valid original `turn_metadata.timestamp` values.
The reader does not borrow file modification time, import time, `created`,
`last_activity` or a session's month folder. Viewer-local start and exclusive
end epoch bounds preserve the requested civil-day range. A resumed session in
an old folder can therefore match a later turn date if selected within the read
budget. Older clients with only date strings use inclusive UTC calendar days.

The shared importer markers recognize `User`, `Assistant`, `System` and `Tool`.
The number of recognized body role headers must equal the metadata-array length
before any dates are attributed. A literal header inside quoted/fenced content
that breaks that count rejects the whole page. Each complete turn is re-chunked
and compared with the current page sections, so long turns and embedded headings
retain their original role/date and source section. Missing or malformed dates
produce incomplete coverage; they do not become yesterday's evidence.

In `all` scope without explicit paths, a session projection is suppressed only
when this same bounded read also verifies its exact indexed raw path, full source
SHA256 revision, normalized body SHA256 and parsed per-turn date array. Different
revisions, altered bodies/dates, explicit path selections and session-only scope
remain distinct. Repeated text at separate turn ordinals is retained. This is
identity-based duplicate removal, not similarity clustering or a claim that two
messages describe the same activity.

| Resource boundary | Current limit |
| --- | ---: |
| Retained indexed candidates | 256 |
| Attempted candidate files | 64; failed/skipped attempts also consume this budget |
| One source file | 512 KiB |
| Total bytes read | 8 MiB, with one overflow sentinel byte to reject growth |
| Returned excerpts | 48 |
| Returned excerpts from one page | 12 |
| Native excerpt text | 4,096 characters; truncated evidence marks incomplete coverage |

The in-memory index identities are inspected using a bounded heap; page names
are selected deterministically in descending order. This prioritizes newer
folder names but is not a timestamp-based candidate index. Older resumed
sessions can remain outside the candidate/read limits in a large index. Large
transcripts, unknown dates, stale hashes, unreadable files and budget exclusions
set `incomplete`. No result claims that all work or every historical message was
inspected. Reindexing cannot invent an absent original timestamp.

The reader checks `vault::is_dataless` before opening a file, skipping macOS
`SF_DATALESS` iCloud placeholders instead of deliberately downloading them.
This guard was verified in source; no physical iCloud-placeholder/offline
workflow was executed for this change. Bounded byte reads do not impose a kernel
IO timeout or make an already dispatched read cancellable.

The answer labels the output as original conversation excerpts, includes the
actual speaker and local time, uses readable source titles when available, and
cites the original path. It explicitly distinguishes what was said from verified
completed work. `indexed_pages` is the total BM25 page count;
`scanned_pages` counts successfully read eligible originals; `matched_events`
counts verified dated retrieval excerpts before the output cap, after proven
projection removal. These counts describe the bounded index inspection, not the
entire vault or a count of completed tasks.

## Executed verification

All browser IPC and chronology fixtures below are synthetic. Chromium executes
the real React interface and query-store code, but does not execute native
retrieval, provider inference or private-vault disk writes. Native chronology
tests use temporary synthetic files and the production reader, without E5 or
prose generation.

| Check | Executed result | Evidence boundary |
| --- | --- | --- |
| Final frontend suite | 4,503 passed across 324 files | Synthetic unit regressions; `/tmp/myco-ask-final-frontend-tests.log` |
| TypeScript | Passed | Type-check; not a release/install receipt |
| ESLint | 0 errors; 2 unchanged `notchDriver` effect-dependency warnings | `/tmp/myco-ask-final-lint.log` |
| Ask recall browser | 65/65 checks passed at 375/768/1280 px | `/tmp/myco-ask-recall-browser-final.log`; synthetic dated excerpts, readable source names/citations, coverage, graph relationships, explicit scope, held IPC, keyboard Stop, late results and simulated vault transition |
| Ask stages browser | 42/42 checks passed | `/tmp/myco-ask-stages-browser-final.log`; current dense fixture, verified zero-dense lexical evidence, rejection of unverified high-cosine hits, healthy empty results and IPC failure; search status only while search IPC is pending |
| Native chronology failure regression | 1 passed, 9 failed before implementation | `/tmp/myco-ask-temporal-native-red.log`; the stub could not satisfy original-date/source evidence contracts |
| Native chronology focused suite | 17 passed; 1 timing probe ignored in the normal run | `/tmp/myco-ask-temporal-native-green.log`; all four roles, local day bounds, unknown/invalid/legacy metadata, literal role collisions, stale/missing sources, symlink confinement, archive opt-in, exact revision dedup, long turns and budgets |
| Full native suite | 1,040 passed; 0 failed; 14 ignored across nine test targets, including doc-tests | `/tmp/myco-ask-final-native-tests.log`; the ignored chronology probe was separately executed below; other ignored tests are not claimed as passed |
| Explicit ignored chronology timing probe | 500 indexed synthetic pages; 64 scanned, 64 matching excerpts, 48 shown; **10.761 ms** | Production bounded reader on the current Apple M3 Mac; not model latency, an Intel/8 GB result, total-app memory, a latency distribution or a private-vault measurement |
| Rust formatting and all-target Clippy | Passed, Clippy warnings denied | Root-coordinated checks; full Cargo test/release/install status is separate below |

The earlier eight-check Ask-stages fixture expected zero dense pages to skip
search entirely. It failed 1/8 after the intended lexical-search behavior changed.
The replacement held-IPC fixture verifies positive lexical evidence and negative
unverified-dense/empty/failure controls rather than removing that assertion
without replacement.

Reproduction commands from `app/` (development server required for browser tests):

```sh
npx vitest run
npx tsc -b
npm run lint
node scripts/ask-recall-smoke.mjs
node scripts/ask-stages-smoke.mjs
```

Native focused commands from `app/src-tauri/`:

```sh
cargo test --lib temporal_recall::tests
cargo test --lib temporal_recall::tests::bounded_500_page_timing_probe -- --ignored --nocapture
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
```

## Remaining limits and release status

Stop and vault-transition guards prevent late results from repopulating a stopped
or replacement Ask conversation. They do not cancel already dispatched native
file reads, CPU work or model requests. Browser checks of these guards are
synthetic IPC races, not native worker-cancellation measurements.

This change retains the existing approximately 42 MB Korean E5 embedding GGUF.
No new dependency, embedding weights, reranker or prose-generation weights were
installed. The built-in provider retrieves and quotes evidence; it does not
generate a verified account of completed work or synthesize new conceptual
relationships. Wider history coverage, accepted/superseded fact-state policy,
model-backed synthesis, actual installed-app Ask QA and Intel/8 GB profiling
remain separate work. See the
[local model review](2026-10-04-local-model-improvement.md) and
[local generation options](2026-10-04-local-generation-options.md).
Earlier E5 retrieval measurements in the
[desktop audit](2026-10-04-desktop-feature-audit.md#actual-bundled-e5-evaluation)
are not new-model or rerun benchmark results for this change.

## Verified local installation

The full native suite completed through doc-tests. The release frontend build
passed in 21.82 seconds and the optimized native build passed in 4m 19s.
`APPLE_SIGNING_IDENTITY=-` produced a locally ad-hoc-signed arm64 app;
Developer ID signing, notarization and an Intel build were not performed.
The build log is `/tmp/myco-ask-release-build.log`.

The previous process (PID 59353) received a normal termination request and its
exit was verified before replacement. The installer staged and checked the
bundle, preserved the previous app, and installed `/Applications/myco.app`.
`codesign --verify --deep --strict` passed for the build, staged app and installed
app. The installed executable matches the release bundle:

- Version: `0.4.0`; bundle identifier: `dev.cmblir.myco`.
- New binary SHA256:
  `1eb1abfd305ac0c5e1c2f5f89a9ef106dd114821bd91cc385e4e502c2e7351ba`.
- Previous binary SHA256:
  `51a11b6d5093a613d2bafa4e591aa097a9227f5cfa42464362691730a633d49a`.
- Previous app backup:
  `~/Library/Application Support/myco-install-backups/20261005-020256/myco.app`.
- Installation receipt: `/tmp/myco-ask-installation.json`, also retained beside
  the backup as `installation.json`.

Relaunch was verified as PID 78162. The fresh main window (ID 24788) rendered
Home. Its inventory remained at the loading state in the two observed snapshots;
the cause was not resolved in this change. No private-vault Ask question was
submitted, no history was cleared, no vault was switched and no permission was
reset. Native rendering and installation therefore do not certify that these
two questions succeed on the owner's current vault.

The retained idle menu panel (ID 24790) was captured separately: all 42,432 pixels
of its 416×102 image had zero alpha, confirming that the previously removed
mascot/number attachment did not reappear in this idle observation.

The installed model directory contains exactly one GGUF, the unchanged
41,641,440-byte E5 artifact. Its SHA256 remains
`bc06a6d33fc6a69f44168dbb4a3106b8350a7a2cef356b6b66fd81409437aa2b`.
No generation model was added. The `v3` chunk/index signature requires the
existing controlled semantic rebuild; the verified lexical arm remains available
while dense vectors rebuild. No manual reindex was started in the private vault
for this QA.
