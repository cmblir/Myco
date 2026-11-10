# Knowledge recall implementation and Claude handoff

The desktop changes address incomplete source processing, weak personal-history
retrieval and premature MCP queue completion. They retain the existing small
offline embedding model. A native iPhone app and authenticated account connectors
are separate deliverables; this branch does not claim to provide them.

## Authoritative baseline

Work started from `287af73c`, the clean `feat/permit-editor-ux` checkout in
`karpathy-editor-build`. The older `karpathy` checkout was not the current Claude
implementation. Changes live in the isolated `feat/knowledge-recall` branch.

Claude's requested mascot memory, project memory, October editor work log,
distill/semantic decisions and latest owner decisions were read before editing.
The decisions carried forward are:

- Keep the Notion-style editor, IME behavior, mobile web shell, graph animation
  and mascot/notch identity. These are established product choices.
- Ship e5-small-ko, approximately 42 MB; no generative chat model is bundled.
  Offline Ask quotes retrieved evidence and offline ingest creates cited extracts.
- Never overwrite, move or delete `raw/`. Updated imported conversations receive
  new immutable revisions. Distill archives derived sessions only after coverage.
- Quarantine known machine traffic by provenance and known prompt signatures.
  Do not discard a human conversation merely because it resembles another.
- Share the vault lock between automatic ingest and distill. Preserve memory
  pressure gates and embedding-index debounce.
- Preserve the installed macOS app's signing identity when replacing it.

The support target supplied by the owner is **Intel Macs with 8 GB RAM**, alongside
Apple Silicon, with **iPhone first** for mobile and **both Gmail and iCloud Mail**
for email. That target is not a hardware
certification: no Intel 8 GB device or iPhone was available for this run.

## Implemented behavior

| Failure | Change | Evidence to inspect |
|---|---|---|
| Personal work/decision questions were answered from git history or confined to wiki pages. | Personal-history routing uses all indexed evidence tiers when the saved scope is the default wiki scope. Explicit scopes persist across navigation/relaunch and apply to all Ask callers; custom weights remain authoritative. File/edit-history questions retain the metadata route. | `recallPolicy.ts`, `queryStore.ts`, `uiStore.ts` |
| Sessions lost rank under note-focused defaults. | Default sessions/all search uses equal tier weights. Wiki browsing retains its existing priors. | `recallPolicy.ts`, native hybrid retrieval |
| Date filters and follow-up wording differed across answer providers. | The same date range and contextual retrieval query reach local, HTTP and CLI paths. Quoted date-shaped IDs and filenames are not treated as date filters. | `timeQuery.ts`, `chat.ts` |
| Empty successful retrieval could inject unrelated vault contents. | A healthy empty search stays empty evidence. Compatibility fallback is restricted to an unavailable index on an unscoped, undated query. | `chat.ts`, `retrievalContext.ts` |
| Large first hits crowded out other sources; same filenames redirected citations. | Budgeted context gives distinct sources a first chance and uses vault-relative path citations, including offline answers and saved question history. | `retrievalContext.ts`, `wikilinks.ts`, native link index |
| Generic keyword coincidence could pass abstention. | Only verified distinctive identifiers, quoted phrases or substantive lexical coverage can bypass the dense floor; keyword hits alone cannot. | `abstention.ts`, native hybrid retrieval |
| Long inputs lost their tail during chunking, embedding or digesting. | Native indexing processes all chunks in bounded batches. Actual token windows are pooled into normalized parent-chunk vectors. Digest/rollup/ingest retains complete bounded quotes, resuming missing chunks on later passes. | `embeddings.rs`, `local_llm.rs`, `sessionEvidence.ts` |
| Edited files could reuse an old vector with new text. | Chunk hashes and embedding-pipeline signatures invalidate incompatible or changed vectors; stale candidates cannot quote current text as though it matched an old embedding. | `vector_index.rs`, `commands.rs` |
| A small preview was treated as a completely processed session. | Revision-bound coverage receipts cover actual retained quotes. Editing/removing quotes invalidates their receipt. Incomplete sources remain active; the UI reports pending evidence. | `sessionDigest.ts`, `rollup.ts`, `distill.ts` |
| A user edit made during evidence generation could be overwritten. | Derived evidence writes compare the exact previously read SHA256 under the native writer lock. A conflict rebuilds the append from the latest bytes, with three attempts before an explicit error. Summary, catalog, log and digest writes preserve concurrent cooperating edits. | `evidenceWrite.ts`, `vault.rs` |
| Inbox archive IPC could move a raw original. | The command now confines both the canonical source and archive destination to `_inbox/`, rejecting raw originals, other notes and symlink redirects into raw. | `commands.rs`, `devMock.archiveInbox.test.ts` |
| Structural mutation guards missed the vault root containing raw. | Delete, batch trash, rename and move-source guards reject the canonical vault root as well as raw descendants. Moving an ordinary note into the vault's top level remains allowed. | `vault.rs::is_raw_mutation_source`, native command tests |
| A planner reading only a prefix could return NOOP and drop an unread tail. | Prefix-only NOOP cannot discard the full source. | `ingestPlan.ts`, `ingestStore.ts` |
| MCP imports lost message identity/time or multiplied on resumed sessions. | Turn metadata and stable projection paths preserve identity, role, phase and timestamps. Immutable retained-record JSONL accompanies normalized markdown. | `importers/`, `mcp_native.rs` |
| An MCP client could mark a source done without reading it. | Paginated source reads track full byte coverage; completion also requires current SHA256, valid wiki pages and an inline citation whose definition names the exact raw revision. Receipts record the revision and wiki paths. | `importers/wikify.rs`, `mcp_native.rs` |
| Automatic local promotion waited for a generation provider. | Pending MCP conversations can use offline cited extraction. Validation and full local quote coverage precede app completion. Summary filenames distinguish identical conversation IDs in different provider directories. | `fullTierIngest.ts`, `extractiveIngest.ts` |
| macOS release automation produced only Apple Silicon installers. | CI and release matrices now include native Intel and Apple Silicon jobs. | `.github/workflows/ci.yml`, `release.yml` |

## What the receipts prove

Digest coverage proves that each normalized source chunk has a durable, intact
quoted representation for the specified revision. It is a completeness guard for
storage, not proof that a preview captured every meaning. A small FNV fingerprint
identifies digest progress; it is not a cryptographic authenticity claim.

MCP completion proves current raw SHA256, recorded full read coverage and exact
source citations in a structurally valid wiki page. App completion uses the SHA256
of the complete raw file that the app read; MCP additionally records paginated
client reads. Neither proves semantic entailment of every generated claim.

Retained-message JSONL preserves the JSON structure of original retained message
records through reserialization; it is not a byte-for-byte export-file backup or a
backup of discarded tool-only, sidechain or harness traffic. Unknown turn times
remain unknown when structured metadata exists; legacy files alone can use their
document date as a fallback. A proposal or an assistant's assertion does not
become a verified current fact merely by being imported.

Web exports retain optional per-message fields: ChatGPT active-branch message
IDs, parents and numeric creation times; Claude message UUIDs, senders and
offset-bearing creation times. Conversation creation time is not substituted for
a missing message time. These optional shapes were checked with synthetic
fixtures, not a private account export. Parser version 3 revisits unchanged
source files once so newly supported metadata can be captured.

Ask stores the selected scope together with `isAskScopeExplicit`. Per-question
scope overrides the stored explicit selection; automatic personal-history routing
applies only without either. Old UI settings contain no selection-origin flag, so
their saved `wiki` value cannot distinguish a default from a manual choice. They
use automatic routing until the user next chooses a scope; that new selection
survives navigation and rehydration, including Home/Spotlight Ask entry points.

Conditional writes protect cooperating app writers within this process. External
editors, another app process and future device synchronization do not share that
lock. Cross-device conflict detection and merge remain separate work; this branch
does not claim distributed atomic writes.

The archive regression reproduced the previous raw move before the fix:
`commands::tests::archive_inbox_source_at_refuses_raw_and_preserves_original_bytes`
panicked with `raw originals must never be archived`, receiving a synthetic
`raw/conversations/.archived/synthetic.md` destination. After confinement, raw
bytes remain in their original path and a legitimate consumed inbox file still
moves intact to its archive. All reproduction data was temporary and synthetic.

A separate pre-fix eligibility test failed at `src/commands.rs:6507` with
`the vault root contains raw`: `trash_targets` returned the synthetic vault root
as an eligible target. No OS trash operation was invoked. The shared structural
source guard now excludes that root before delete, rename or batch trash, while
the ordinary note-to-root move regression remains allowed.

## Resource policy

No new model or application dependency is required. Embedding batches and digest
passes are bounded, and source progress is checkpointed. Only changed chunks need
new vectors after an index built with the current pipeline signature. The first
index after this change must rebuild incompatible old vectors.

The graph's continuous movement remains intentional. This branch does not claim
to fix all GPU, bundle-size or startup costs. The production web build still has
large reader, graph and diagram chunks; splitting those further requires separate
measurements and must preserve the approved editor and graph behavior.

## Mobile and account integration

Use the [iPhone source-record contract](../specs/2026-10-04-iphone-source-records.md)
and the [Google sync contract](2026-10-04-google-sync-contract.md) and
[iCloud Mail contract](2026-10-04-icloud-mail-contract.md) for the next native
integration. The existing responsive web shell is usable for UI verification;
it does not grant native iOS permissions or device storage access.

Contacts can be collected only within the user's authorized contact set, including
limited access. Calendar reading needs EventKit read/full access. Treat all-day
events as dates with a calendar timezone rather than inventing a UTC midnight.
[Apple Contacts](https://developer.apple.com/documentation/contacts/accessing-the-contact-store),
[Apple EventKit](https://developer.apple.com/documentation/eventkit/accessing-the-event-store).

MessageUI supports composing a message, and CallKit integrates an app's calls with
system call UI. They do not establish a general historical SMS/iMessage or native
Phone call-log reader. iPhone-wide history must remain an explicitly supported
user import path unless a suitable public API is established.
[MessageUI](https://developer.apple.com/documentation/messageui/mfmessagecomposeviewcontroller),
[CallKit](https://developer.apple.com/documentation/callkit).

Google Calendar/Gmail require their own OAuth client configuration and consent.
The app's `google-api` model provider is Gemini, not a mail/calendar connector.
Calendar synchronization uses all pages before persisting the final sync token;
an expired token returns HTTP 410 and requires a fresh derived snapshot. Gmail
history expiry uses HTTP 404. Provider deletion changes the active derived view.
A connector retention/deletion design is required before permanently importing
mail; the existing immutable vault contract alone does not resolve that policy.
[Calendar sync](https://developers.google.com/workspace/calendar/api/guides/sync),
[Gmail sync](https://developers.google.com/workspace/gmail/api/guides/sync).

Email targets include both Gmail and iCloud Mail. The documented first iCloud
path uses TLS IMAP and a user-created app-specific password kept in Keychain.
Apple also offers authorization to supported third-party apps, but a custom-app
developer contract was not established here. An Apple sign-in does not establish
mailbox permission. Negotiate IMAP capabilities instead of assuming live iCloud
support for optional extensions. No mailbox has been connected in this branch.
[Apple IMAP settings](https://support.apple.com/en-us/102525),
[Apple app-specific passwords](https://support.apple.com/en-us/102654).

## Validation and remaining work

See the final validation results below. Synthetic UI fixtures verify application
routing/rendering, while the native E5 probes measure retrieval separately. No
private vault or personal contact/mail data is used in tests.

### Native retrieval measurements

The probes use the actual bundled E5 model and production hybrid ranking, on an
Apple M3 Mac with 16 GB RAM. Times exclude application startup and rendering.
These small synthetic corpora are regression evidence, not large-vault or Intel
8 GB performance certification.

| Probe | Corpus and results | Resource observations |
|---|---|---|
| Existing public retrieval evaluation | 62 queries, 71 pages, 75 chunks; hit@1 52/62, hit@3 62/62, recall@5 1.0, MRR 0.9167; grounded hit@3 62/62 | Model load 51.8 ms; full index 1.04 s; median query 18.3 ms, p95 27.0 ms; peak process RSS 180.7 MiB |
| Personal-history regression fixture | 304 chunks; 6 answerable queries hit@1/recall@5 6/6, MRR 1.0; 2 negative queries, false acceptance 0/2 | Load 43.8 ms; index 1.71 s; median query 11.3 ms, p95 63.4 ms; peak process RSS 141.1 MiB |
| CPU-only embedding window probe | GPU layers 0; three actual token windows, at most 498 tokens each; 384-dimensional normalized vector; single-window output matches the original path | Probe 0.63 s, peak RSS approximately 234 MiB; M3 CPU, not Intel |

The two negatives are too few to estimate a real-world false-answer rate. The
public corpus also measures retrieval of a target document, not semantic truth
of an automatically synthesized answer. Exact identifiers and whole-token
uppercase acronyms can pass the dense floor only when verified against the
current source; substring coincidences remain excluded.

Reproduce only these small-model probes from `app/src-tauri` with the bundled
model present:

```sh
cargo test --lib public_retrieval_e5_measurement -- --ignored --nocapture
cargo test --lib personal_recall_e5_measurement -- --ignored --nocapture
MYCO_EVAL_CPU=1 cargo test --lib e5_token_windows_keep_single_vectors_and_include_long_tail -- --ignored --nocapture
```

### Completed application checks

| Check | Command or environment | Result |
|---|---|---|
| TypeScript unit/integration suite | `NODE_OPTIONS=--no-experimental-webstorage npm test` on this host's Node 25 | 313 files, 4,203 tests passed |
| Native Rust suite | `cargo test`, one build worker on this host | 993 tests passed, 11 ignored; the three small-model probes above were run separately |
| Native formatting and lint | `cargo fmt --all --check`; `cargo clippy --all-targets -- -D warnings` | Passed |
| Native desktop executable | `cargo build --bin myco` | Passed; host debug executable is arm64, not a signed installer or Intel build |
| Production web build/typecheck | `npm run build` | Passed |
| Frontend lint | `npm run lint` | Passed with two pre-existing `notchDriver.ts` hook dependency warnings |
| Personal-history UI | `node scripts/recall-smoke.mjs` | 27 checks passed at 375/768/1280 px; includes persisted explicit wiki scope after navigation, date range and exact source opening |
| Ask stages and activity routing | Existing `ask-stages-smoke.mjs`, `query-smoke.mjs` | 8/8 and 5/5 passed |
| Editor regression | `node scripts/editor-writing-smoke.mjs` | 115 checks passed, including narrow layouts, autosave/undo, source-read-only and synthetic IME handling |

The Node flag avoids the host's native Web Storage stub interfering with tests;
it is a validation environment option, not a product runtime setting. UI checks
use synthetic IPC fixtures and do not establish native iOS permission access or
real-device keyboard behavior.

Native iOS build verification is blocked because this host has Command Line Tools
but no full Xcode or iOS SDK. The signed macOS preflight also fails with
`No valid Developer ID Application identity`; no ad-hoc replacement or app
installation was performed. Intel release jobs are configured, not remotely run.

### Remaining desktop issues and priorities

These are code-backed limitations. They are not all reproduced runtime failures,
and none is claimed to be fixed by this branch.

| Priority | Observed limitation | Next concrete improvement |
|---|---|---|
| P1 | `validator.rs` recognizes active/superseded/disputed, but hybrid eligibility does not apply claim validity or supersession. Earlier and current decisions can both be retrieved. | Preserve source-backed proposed/accepted/executed/cancelled claim revisions, valid time and observation time. Make current-state answers explain which claim replaced which; keep history searchable. |
| P1 | Provider keys use OS Keychain, while `vault.rs` writes Markdown bytes and `vector_index.rs` writes an ordinary binary index. Keychain protection does not encrypt all wiki content or backups. | Decide encrypted storage, device keys and managed-source retention/deletion before collecting contacts or mail. Preserve an explicit export choice for portable Markdown. |
| P1 | `lib.rs` has no mobile entry point and initializes desktop tray/global-shortcut facilities in its application setup. Responsive pages do not establish a native iPhone build. | Create and verify the iOS target, gate desktop facilities, and add actual Contacts/EventKit/OAuth adapters behind the documented source-record boundary. |
| P2 | Turn timestamp filtering converts instants to UTC civil dates in `commands.rs`. Legacy session dates can have only month precision. | Add an explicit query timezone and display timestamp precision. Test Korea/local midnight, DST and all-day calendar events before mobile collection. |
| P2 | `VectorStore::search` scans and sorts all records, and the full index lives in memory. Bounded indexing batches do not bound total index size or eliminate query sorting. | Measure 10k/100k synthetic chunks on Intel 8 GB, including foreground responsiveness during indexing. Use those results to choose top-k selection or a filtered index. |
| P2 | Weekly/monthly rollups retain complete quoted input views. This preserves history but can repeat evidence and its receipt markup across layers; current exact deduplication covers matching raw/session projections only. | Carry original source-span identity through every rollup and measure storage/index growth. Collapse only verified duplicate evidence while preserving distinct edits and historical states. |
| P2 | `schedules.rs::is_due` currently has only test callers. Its weekly/monthly cadence is a 7/30-day interval and deliberately ignores display day suffixes. Other macOS LaunchAgent scheduling does exist. | Trace and connect the recurring digest executor before advertising exact calendar schedules; test timezone and actual month boundaries. |
| P2 | The production build contains large reader, graph and diagram chunks. No end-to-end 8 GB startup/interaction budget was measured here. | Profile startup and navigation on target hardware, then split expensive loading paths while retaining the approved editor and graph animation. |

Existing review and contradiction UI can host temporal decisions. Entity aliases
need review so similarly named people/projects are not automatically merged.
This branch improves retrieval and complete evidence retention; it does not claim
an automatic authoritative fact graph or authenticated mobile synchronization.
