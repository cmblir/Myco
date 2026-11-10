# myco

A cross-platform desktop wiki app for plain markdown vaults. Built with
Tauri 2 + React 18 + TypeScript. Ships as a small native bundle (no
Chromium), edits real files on disk, talks to your choice of LLM provider,
and grows a citation-aware knowledge graph as you work.

## What is myco?

myco is **one app** that combines four things you'd otherwise stitch
together yourself:

- **A markdown editor** — Obsidian-style `[[wikilinks]]`, autocomplete,
  backlinks, live preview, CodeMirror source, autosave.
- **A knowledge wiki** — pages of type `source-summary / entity / concept
  / technique / analysis`, YAML frontmatter schema, citation lint,
  provenance scan.
- **An LLM client** — Claude Code CLI, Anthropic API, OpenAI, Google
  Gemini, Ollama, OpenRouter — plus the local `gemini` and `codex` CLIs
  (no API key; they use your existing subscriptions, like the `claude`
  CLI). Pick a different model for ingest vs ask;
  keys live in your OS keychain.
- **A built-in offline embedder** — a multilingual-e5-small-ko-v2 embedding model ships inside
  the app and runs in-process (llama.cpp, Metal on Apple silicon). Zero
  setup, no key, works offline — powers semantic search and quote-only Ask.
  For optional local Ask summaries, download Qwen3.5-4B Q4_K_M
  (2.71 GB of disk space) under Settings → AI settings, then choose
  **Use Qwen for Ask**. Missing, unavailable or rejected generation falls back to quoted
  passages with source links. If sources changed or cannot be verified, Retry
  retrieves fresh evidence before answering. Optional Qwen3.5-2B Q4_K_M
  (1.27 GB of disk space) adds import drafts when explicitly selected for import,
  plus organization drafts when Ask uses the built-in provider. Drafts retain
  source quotes and require review.
  Classification and other file-tool workflows still need a connected
  provider. Intel Mac with 8 GB RAM inference
  performance has not been measured.

  Explicit next-work questions such as “내가 앞으로 어떤 작업을 하는게 좋을까?”
  use a separate local advice policy: conditional suggestions, their recorded
  basis and a small first step. The model chooses a historical review period
  and reads dated work and follow-up evidence within the selected scope. This
  period selects records; it does not set a deadline for the suggested work.
  Missing task records do not establish that no
  work remains. Fact and status questions keep the factual policy.
  Korean recommendations use Korean instructions for conditional next steps,
  recorded priorities and direct questions about missing goals.
  Generated citations use the open vault's organized session titles when available,
  while retaining their verified targets.
  Body wikilinks resolve only to declared sources and receive trusted labels;
  unknown, ambiguous and malformed links remain rejected. Bounded local JSON
  generation prevents literal angle-bracket markup before validation. Valid links still
  do not certify the answer's meaning.

  When imported workstream facts answer a topic-free recent-work question such
  as “내가 최근에 한 일들에 대해서 정리해줘”, the overview uses seven local
  calendar days including today, displayed in the answer and saved with it. An
  empty period stays empty and offers an explicit search of older records.
  Guided project questions disclose their session evidence before submission;
  explicit scope and selected-note restrictions take priority. Recognized progress
  and guided remaining-work questions use the selected built-in local chat model's
  original-source resolution flow. Workstream facts only select project records;
  they do not establish task completion. Current-state and historical-cutoff
  queries retain the project identity and explicit filters on follow-up and retry,
  rediscover available project records, expose missing coverage, and reject a
  changed project snapshot before showing the answer. Other free-text
  remaining-work phrasings still use ordinary Ask; this is not universal intent recognition.
  An unsupported selected provider offers a model-setting message without
  selecting another model. For other recent-activity questions, the selected local chat model can choose a period from
  the question and available record dates. Ask displays that period, reads
  date-grounded records within the selected scope, and summarizes
  work themes, reported results and requests with unrecorded outcomes.
  Related records become concrete work themes rather than a list of worker
  handoffs. Failed period planning and failed summary generation have separate
  retry messages.
  Creation/update dates locate records, not every action inside them. The answer
  uses compiled session work and remaining-task statements when their visible
  text, original quote proofs and explicit dates can be rechecked. These remain
  secondary reports, not independent proof of completion. Older summaries retain
  original quoted evidence rather than partial model previews; standing
  instructions are not performed work. Curated outcome
  quotations and their selected follow-ups stay together through retrieval and
  prompt budgeting, including quotations split into attribution and body chunks. It
  reports evidence coverage when selection is partial. A failed period plan or
  summary offers Retry instead of substituting unrelated similarity matches.
  Activity answers reserve up to 768 output tokens within the existing context
  budget so longer summaries can finish their citation-bearing JSON.
  Explicitly dated questions retain their specified period.
  Current Qwen 4B activity answers still fail semantic checks for unrecorded
  outcomes and missing citations; review them against their sources. See the
  [verification report](docs/research/2026-10-07-recent-activity-verification.md).
  Project grouping now separates recorded absolute folders with opaque keys.
  Verified repository equivalence across folders and actual-model project-state
  acceptance remain open in the [current goal](docs/specs/2026-11-10-llm-wiki-goal.md).
- **A vault you own** — everything is plain markdown on disk. Open the
  folder in Finder, in Obsidian, in Vim — myco never locks your data.

myco creates its own vault at `~/Documents/myco/` on first launch
(scaffolded with `raw/`, `wiki/`, `daily/`, `ingest-reports/` and a
maintenance `CLAUDE.md`). You can point it at any other directory from
Settings → My space.

Subsequent launches open only your selected folder. If a drive is disconnected
or access fails, **Try again** and **Choose a folder** remain visible even with
the sidebar collapsed; the saved folder is preserved. The default Documents
folder is created only when no previous folder has been selected.

## Highlights

Unsubmitted Ingest titles and text persist on this device per vault across page
changes and restarts. A storage failure retains the input in memory and offers
Retry. Failed, cancelled and partial imports keep the draft; successful completion
clears only the exact submitted version. Clear text explicitly discards a draft.
Successful imports prioritize **Review notes**, with readable titles, observed
creation/update status and the original source link. A page with insufficient
before/after evidence is labelled changed. Partial imports prioritize Retry;
result links are hidden after the originating vault opening changes.
Local imports list only their confirmed writes, so concurrent edits to unrelated
notes do not appear as import results or turn an empty write result into success.
Legacy provider paths without a confirmed write list still show changes observed
during the run and may include concurrent edits.

Home uses a compact introduction on returning devices, preserving first-visit
onboarding and custom layouts. Ask examples live inside the composer and only
fill and focus the draft; choosing one does not submit a question.

Follow-up questions retain a previous date window only within the same scope and
selected-note context. An explicitly supplied new date takes priority. Switching
scope or note does not carry the previous answer's topic or evidence into the new
question. The current document-specific control is the selected-note scope; a
general checked-document selector is not available in this build.

Workstream facts v6 group source-recorded absolute working folders with opaque
keys, rather than merging matching folder names. Ambiguous folders stay
unassigned, including records with non-string working-folder declarations.
The existing opaque project keys remain unchanged. Reconciliation rereads tracked
immutable originals for the migration;
it preserves existing project pages and name overrides. Differing retained pages
show a refresh-pending notice. Different machines using the same path are not
distinguished yet; verified equivalence between a repository's subdirectories or
worktrees remains incomplete.

New topic-map drafts delimit the generated body with `myco:map-generated:v1`
comments and record its exact SHA-256 revision in `map_generated`. Titles and
text outside that block remain separate from the generated section. These public
descriptors are not ownership credentials and do not enable existing-map refresh.
Empty output or output containing reserved section markers stays pending for retry
without publishing a map. Durable native refresh authority is still required.
The native publication command independently checks the versioned boundary and
exact generated-body hash before writing. A matching descriptor proves content
consistency only, not source entailment or ownership of an existing map.
On supported Unix filesystems, new maps also retain their native file object and
creation baseline under `<app-data>/map-creation-custody`. This requires vault and
app data to support hard links on the same filesystem. Conflicting or failed
records preserve output for recovery instead of confirming publication. These
records support freshly authorized native refreshes. Custody cleanup remains
incomplete.
Before publication completes, the native writer re-reads the private record and
checks its exact bytes and file identity; unstable or unsafe records stop completion.
Creation observations also validate their schema, vault/target scope, baseline
revision and retained file object. Reading a baseline and current human-edited
text does not restore an update or deletion permit.
Readback separately flags edits to the generated body or its evidence/descriptor
metadata. Titles and annotations outside the generated markers do not count as
generated-content edits. Ambiguous markers or metadata require manual review;
the classifier does not overwrite either kind of edit.
The native `preview_map_refresh` command returns merged review text and the current
file revision after checking the active vault/organization role, native source
snapshot and private creation record. It replaces only generated body and
evidence/descriptor values, preserving titles and outside annotations. It writes
no map and grants no update or undo permission.
The native `apply_map_refresh` command independently repeats authorization,
source checks, private record checks and merge, and requires the preview's current
revision. Before canonical replacement, it retains the staged file anchor and a
synced version-4 preparation record with exact before/after snapshots and the
staged native file identity. Record bytes are written and synced under a private
`.tmp` name before no-clobber publication to the final `.json` name; interrupted
staging is excluded from observation discovery. Existing final records are never
replaced. Failed staging paths are retained, including replaced paths, for later
recovery rather than automatically unlinked. Both snapshots must fit the private
record budget.
Failure to save the record stops canonical replacement; the writer rechecks the
staged object and target before replacing it. A prepared record does not certify
publication completion or source validation.
The read-only `latest_map_refresh_history` command requires the current map's
physical identity to match its record and anchor. It can therefore read snapshots
after a process exits immediately after replacement, before the writer returns.
A staged candidate that never became the current file is not shown as a written
update. Legacy version-1/2 records have no before-image; version-3 observations
remain readable. Identical content remains a no-op; changed targets are rejected.
Failures after persistence retain output for manual recovery instead of reporting
success. Post-write source checks still must pass before refresh succeeds.
History describes recorded writes, including interrupted updates, and does not
certify completed source validation. Power-loss recovery, partial/corrupt private
record repair and browsing unpublished attempts remain incomplete.
The opening-bound, read-only `retained_map_snapshots` native command exposes
stored before/after text for recovery inspection. `currentObject` means the
record's retained inode matches the current file, not that its contents or sources
are approved. Other validated records are `publicationUnknown`, including both
interrupted attempts and superseded updates. Stable malformed records appear as
`invalidRecord` without snapshot text; privacy, I/O and concurrent replacement
failures abort the query. Results are ordered by opaque record ID, not time, and
bounded to 256 snapshots, 32 MiB of records and 4,096 directory entries. This API
does not retry, delete, restore or grant undo authority. In History, select an
existing map and expand **Retained map records** to load these snapshots separately
from its latest update. Each record discloses current-file association, unknown
publication or invalid data; invalid text stays hidden. Records expand as escaped
plain text, with reload, empty and error states. Switching or reopening the vault
clears them. **Find retained maps** adds names from validated private records to
the selector, including maps missing from the current file list. Those entries
are labelled **retained records only** and open the saved snapshots without
reading a nonexistent current map. The opening-bound `retained_map_keys` command
validates vault identity, canonical map names, record hashes and anchors before
returning names. It scans at most 4,096 entries and 32 MiB of private records and
returns at most 256 unique names. Unidentifiable records produce an incomplete-list
warning, never guessed names or text from another vault. Saved snapshots remain
readable when `wiki/maps` or `wiki` has also been removed: inspection follows no
descendants below the first missing parent and checks that it remains absent.
It creates no folders or files. Reappearing paths, including symlinks, abort the
read. Corrupt-record repair and restoring deleted maps remain incomplete.
Refresh issues no creation/undo receipt. Manual map proposals show the native
merged diff before applying an existing-map update. Cancelling or switching vaults
stops the update; sources and the target revision are rechecked after approval.
If multiple existing maps match the topic or its member-based label history,
drafting stops before generation or publication and asks for map review. It does
not pick a target by directory order or change either map, even for an approved
automatic proposal.
History offers a map selector with the latest saved before/after snapshots,
a notice for edits since that update, and explicit empty/error/reload states.
Snapshots stack on narrow screens and appear side by side on wide screens.
Switching or reopening a vault clears the selection and old responses. This is
not a full update timeline; refresh undo remains incomplete.
Native creation now also discovers its observation by vault/path and current file
identity, without relying on a remembered generation key. Missing, corrupt or
ambiguous observations stop confirmation. Discovery is bounded to 4,096 directory
entries and 32 MiB of matching records; exceeding a bound requires recovery.
Live undo can remove an unchanged map created in that opening; human edits block
removal. The private baseline and file anchor remain retained after undo.
After confirmed undo through History or Settings, drafting the topic again starts
a fresh run. Failed undo retains publication recovery. Map run IDs stay distinct
even within the same second; maps in one automatic batch still share one undo run.

New topic-map drafts use at most twelve selected member pages, bounded body
excerpts, full relative-path citations and source revisions. Maps do not add
unrelated retrieval context. Native reads accept at most 128KiB per member and
retain file/directory identities under the original vault opening and organization
role. Source checks and new-map publication share the cooperating-writer lock;
external edits are checked before and after writing, not atomically excluded.
Oversized, missing or changed sources leave the proposal pending. A failure after
writing retains the output for manual recovery without publication/undo authority.
Existing maps without native custody remain pending for manual recovery. Automatic
organization can refresh existing maps only from already-approved proposals,
within its shared model budget and original organization-role authorization.
It rechecks the approved proposal before generation and publication; existing-map
refreshes check again after asynchronous source validation and preview hashing,
immediately before native apply. A changed or withdrawn approval observed by that
check stays pending. This does not atomically lock external edits to the proposal.
Manual map work remains pending during review,
so cancellation cannot leave an automatic approval behind. Proposal completion
uses a revision-checked write. Native map identity remains unavailable on Windows.
Generated explanations require review; link validation is not semantic validation.

Graph follows live changes to system reduced motion without reopening: direction arrows retain their visible geometry without advancing, idle rotation and pulses stop, and an active camera flight or orbit retarget completes at its destination immediately. Turning reduced motion off respects the ambient-motion toggle, flat layouts and ongoing user interaction.

### Writing

Empty heading and text-block prompts use the readable secondary text color in
both light and dark themes.

| | |
| --- | --- |
| `[[wikilink]]` autocomplete | Type `[[` in the editor, every file stem in the vault appears in a popup. In Source mode, frontmatter `tags:` values and body `#tag`s complete from the vault's tags. Tags are indexed from both frontmatter and inline body `#tags` (Obsidian's rule: not inside code, not `# Heading`, not URL fragments). `[[Note#Heading]]` opens the note and scrolls to that heading (`[[#Heading]]` scrolls within the current note) |
| `/` blocks | `/` at the start of a line (or after a space) opens 26 blocks in four sections (Basic, Media, Records, Advanced): headings 1–4, bullet / numbered / to-do lists, quote, callout, toggle, table, divider, code, image (a file dialog; the file is copied into `assets/`), link to note, note embed (`![[` with the note list open), recall, ask (`/질문`: Enter asks your notes and shows the answer — one `> [!question]` callout of your notes' own lines with `[[note#Section]]` sources and match percentages, never generated prose — and Enter again inserts it; nothing is inserted when no note clears the relevance floor), on this day, on this day as a query (`/과거의 오늘`: a query block for today's month-day under `daily/`, newest year first), today's date, table of contents, chart (`/차트`: a sample table and its chart, the chart's panel open), diagram (`/다이어그램`: a sample Mermaid flowchart), math (`/수식`: a `$$` formula) and query (`/쿼리`). They are filtered by the keyword or the localized name, on either keyboard layout (`/h2`, `/ㅗ2`, `/표`, `/임베드`); Enter or Tab applies, and a word that matches nothing says "No results" |
| Find / replace | `⌘F` in the editor (`⌘G` / `⇧⌘G` next / previous, `Esc` closes); not available in Preview mode |
| Image paste / drop | Paste a PNG / JPEG / GIF / WebP into the editor, or drop one from Finder onto it — it is saved as `assets/YYYYMMDD-HHMMSS.<ext>` in the vault and `![](assets/…)` is inserted; the preview renders vault images, including Obsidian `![[shot.png]]` embeds from `assets/` |
| Note info / outline | The **Note info** button opens properties, headings, sources and connections. It starts closed on new devices and preserves an existing saved choice. It appears beside the note when there is room and below it on narrow or split panes. Click a heading to jump to it |
| One editor | A note opens in one Live editor that renders headings, bullets, task checkboxes and links in place, revealing Markdown on the caret line; there is no separate Read view (a device that closed on the old one opens in Live). **More → Edit Markdown source** opens the full raw file with a visible **Close Markdown source** action, and that choice is remembered per device. Switching between Live and source keeps the same editor and its undo history. Make cards and Audio overview also live under **More** |
| Blocks | Notion-style over plain markdown: `## `, `- `, `1. `, `[] `, `> ` and `---` become their block as you type and the block marks stay hidden even on the caret line, while bold/link marks show only while the caret is inside that span. Enter starts a new block (a blank line in the file, so nothing typed below restyles the line above — setext headings are off in the editor), Shift+Enter breaks the line inside the block, Backspace at a block's start turns it back into text, Tab / Shift+Tab nest list items, and `/h2⏎` applies even typed faster than the menu opens. Blocks draw in place, in Live as in Preview: images (`|300` sets the width), GFM tables (edited like a Notion table: a click in a cell puts the caret there, and the cell holds its text as typed, `**bold**` and `[[links]]` drawn once it loses the caret; Tab / Shift+Tab and Enter move between cells, Tab in the last cell or Enter in the last row adds a row, the arrows cross cells at the text's edge and leave the table above or below, Escape selects the table, Backspace in an empty row removes it; the + bars on the right and bottom add a column or a row, and a row's or a column's handle, or `⌘/` in a cell, adds rows above / below and columns left / right, deletes them (never the last one) and aligns a column; `/table` inserts 3 × 3 empty cells with the caret in the first; every edit is written back as one plain `| a | b |` table, a typed `|` as `\|`, one undo step per cell until it loses the caret or 1 s passes; the Viewer draws the same table, and the `^id` line that tags a chart's table is not drawn, in either view), callouts and toggles (`⌘↩` on a toggle's title, or a click on its chevron, opens and closes it; the fold is view-only, the file is unchanged), note embeds (`![[note#Heading]]` or `![[note]]`: the section, read-only, under a link that opens the note; "Section not found" when the note or heading is missing; no `^block-id`), ` ```toc `, ` ```chart ` (bar, line or pie; obsidian-charts keys), ` ```mermaid ` (mermaid loads on the first diagram, strict mode, in the app's theme; one it cannot read shows mermaid's message above its source), math (`$…$` and `$$…$$` by GitHub's rules — `$5 and $10` stays text — typeset by KaTeX, loaded on first use; a bad formula shows its source in red) and ` ```myco-query ` (one line of ⌘K operators — `"phrase"`, `tag:`, `type:`, `status:`, `confidence:`, `path:` — plus `sort:` (`name`, `modified`, `type`, `links`, `sources`; `-` reverses), `limit:` and `view:list|table|count`: the matching pages as links, a name/type/status/updated table or one bar per type, the page it is on left out; **Bake links** writes the pages shown as `[[link]]` lines between `<!-- myco:query … -->` markers, replacing the last bake in place, one undo step; Preview hides the markers). Callouts and toggles aside, which stay text to type in, a block never shows its markdown in Live: a click on it, or ArrowUp / ArrowDown onto it, selects it whole with a ring; then Enter opens its editor (a table's first cell, a fence's panel) or, under an image, an embed or a TOC, adds a line, Backspace or Delete removes its lines (one undo step), `⌘C` / `⌘X` copy or cut its markdown, Escape puts the caret after it, the arrows move on past it, and typing starts a paragraph under it. A chart, diagram, formula, query or plugin fence shows its result only: hovering it or selecting it shows **Edit** and **Delete**, and a click, **Edit** or Enter opens its panel inline under it (not a modal; Tab stays in it while it is open) — a chart's Type (Bar / Line / Pie), Title and Data (a tagged table in this note with its Layout, **New table** for a tagged sample table above the chart, or inline labels and series; editing the table's cells redraws the chart), a diagram's code beside its live drawing (stacked under 720px; a parse error shows under the code and the last good diagram stays), a formula's TeX, a query's Folder, Tag, Type, Sort and Max results with the whole query line under Advanced (Bake links stays on the result), or a plugin fence's text. The result redraws 300 ms after typing stops; **Done**, `⌘↩` or Escape closes the panel and keeps the edits. The file keeps a plain fence: only what the panel changed is rewritten, keys and terms it does not show stay as written, one panel session is one undo step, and nothing is written while an IME composes. `⌘/` or the ⋮⋮ handle beside a block opens the block menu: Turn into, Duplicate, Delete, Move up / down, Ask about this block (opens `/ask` on the block's text, the answer going in under the block); `⌘⌥0`–`⌘⌥8` turn the caret's block into Text, Heading 1–3, To-do, Bullet, Numbered, Toggle or Code. |
| New note | Home, the sidebar, `⌘N` and the command palette open the title prompt. Confirming opens the editor with the caret after the new note's title, ready for the body, even after using the Markdown source view. An existing title opens that note for writing at its end. The note goes in the open note's folder, or `wiki/` when that folder is one myco manages, the vault root, or nothing is open; a note from a template follows the same rule, and a folder picked in the tree's context menu wins |
| Folder crumb | Each folder in an open note's topbar crumb (`myco / wiki / name`) is a chip that opens the same Move dialog as the tree for that note. A `raw/` file gets none |
| Save | `⌘S` or automatic 2-second debounce; the note header shows waiting, saving, saved or not saved. **Saved** appears only after the latest text is written; writes to the same note run in order. A failed save keeps the draft while the app remains open, including after navigating away; **Save again** retries it. Unsaved drafts follow a rename or move and are cleared only after a matching successful write. Recovery drafts are in memory, so save successfully before closing the app. Disk writes are atomic (tempfile + rename) |
| Imported originals | Markdown under `raw/` opens read-only, matching the backend's source protection. No editor opens there, and source editing is disabled |
| Authorship marks | Hidden by default in Live and Source so writing has no per-line author bars. On a note with recorded history, choose **More → Show authorship marks** to inspect or revert a paragraph, and **Hide authorship marks** to return to writing. Each newly opened note starts with marks hidden; the header's authorship summary remains available. |
| Backlinks | Every page shows inbound links at the bottom |
| Today's note | Sidebar button creates / opens `daily/YYYY-MM-DD.md` |
| Templates | Right-click → "New note from template…" (also in `⌘K`) picks a plain `.md` file from `templates/` in your vault; `{{date}}`, `{{time}}` and `{{title}}` are filled in. With no folder yet, one click creates it with two editable starters (note, meeting). A template whose frontmatter has `slash: meeting` (optional `slash_label`, `slash_section`) is also `/meeting` in the editor, inserting its body with the caret at `${}`; an empty note shows up to three of them as chips under its `/` hint (a daily note shows three day starters) until you type |
| Plugins | `.myco/plugins/<id>/manifest.json` = `{ "id": "<id>", "name", "version", "permissions": [...], "contributes": { "slash": [{ "label", "detail", "template" \| "fence" \| "command" }], "fences": [{ "lang", "renderer" }] } }`, where `renderer` is `builtin:code`, `builtin:chart`, `builtin:mermaid` or `builtin:query` (a renderer this version lacks draws the block as code with a note). A vault's plugins stay off until Settings → Plugins → "Trust this vault's plugins" (per device, revocable); each can then be switched off, and an invalid manifest is listed with the reason. Plugin `/` items come after the built-in ones and your templates, so they never take a built-in keyword |
| Code plugins | A `command` item runs a handler of the folder's `main.js` in a Web Worker made from a blob URL: `myco.command("name", async () => { … })`. The worker has no DOM and no Tauri IPC; it can only make the calls its manifest lists in `permissions`, each a Promise: `myco.editor.insertAtCursor(text)`, `myco.editor.replaceSelection(text)`, `myco.editor.selection()` → `{ text, line }` (the caret's line, since a `/` command leaves no selection), `myco.vault.readPage("wiki/….md")` → the file's text (a `.md` under `wiki/` only; no `raw/`, `sessions/`, `.myco/`, absolute or `..` path, no link out), `myco.recall(query, k = 5)` → `[{ page, text, similarity }]`, `myco.search(query)` → `[{ path, line, snippet }]` (both `wiki/` pages only), `myco.ui.notify(text)`. An insert or replace waits while the user is composing with an IME (Korean, Japanese) and lands once the composition ends; the wait counts toward the command's 5 s. There is no file write. Calls are served only while one of the plugin's commands runs; a command gets 5 s and 100 calls before its worker is terminated, and three failures in a row stop the plugin until it is switched off and on. The app's CSP applies inside the worker: no `eval`, and no network except the app's own files and a local Ollama (`localhost:11434`). Such a plugin turns on only from its permission prompt, which lists exactly those calls; turning it off revokes them, and a manifest that asks for more is off until asked again. Install = copy the folder into `.myco/plugins/` (no registry) |
| Right-click | New note / new note from template / new folder / add to favorites / Move to… / rename / delete on any tree node (also `⇧F10` on a focused row). `⌘`-click and `⇧`-click select several rows; Move to… and Delete then act on all of them |
| Favorites / Recently edited | Two groups above the file tree: starred pages in star order, and the five most recently edited notes |
| Back / forward | `⌘[` / `⌘]`, or the two arrows in the top bar, walk the pages you visited |

### Knowledge wiki

| | |
| --- | --- |
| Harvest queue | Home → Review & organize contains `harvest_candidates`: archived sessions sieved for duplicate bodies (content hash, newest copy kept), boilerplate (`junk_reason`) and size bands, clustered against the wiki, with an estimated citation yield each. Select → plan gate → `harvest_run` copies into `_inbox/` → the normal inbox pass ingests them → one toast with the citation count before / after. The exclusion line expands to a table of what was hidden and why |
| Judgement | Every source is judged (`judge_source`) before the model or the disk is touched: `drop` (junk, duplicate body) writes nothing and leaves one line in `.myco/ingest-noop.jsonl`; `log` (too small / too large) records to `raw/` without a model call; an all-NOOP plan writes nothing either. The Ingest page shows the five-step rail, the verdict counts, the excluded reasons and a backfill panel (eligible / too small / too large / already harvested, batch size, model-call estimate) |
| Ingest | Drop a file or paste raw text → myco writes `raw/<slug>.md` → invokes the active model with the ingest workflow → Claude reads, summarises, extracts entities/concepts, cross-links existing pages, writes a `wiki/source-<slug>.md` summary, updates `index.md` + `log.md`, and files a WHY report in `ingest-reports/`. **Multimodal inputs:** PDF, plain text, Office documents (`.docx` / `.pptx`, parsed from OOXML), spreadsheets (`.xlsx` / `.xls` / `.ods`), **images** (described via a vision provider), **audio/video** (transcribed by an installed `whisper` CLI — none bundled), and **YouTube URLs** (transcript fetched from the watch page) all reduce to markdown before ingest. With the **Built-in (offline)** provider and no selected local import model, the run is quote-only: the source page quotes its leading passages verbatim, each cited `[^src-<slug>]`, tags are reused from tags the vault already has, `## Related` comes from the local embedding index, `confidence` is `low`, and the WHY report says the run was extractive. Explicitly selecting a local 2B or 4B import model adds a generated draft beside verified quotes, marked for review |
| Semantic search | A local embedding index over the wiki (bundled multilingual-e5-small-ko-v2 embedder by default, or an opt-in provider) powers meaning-based lookup: the command palette (`⌘K`) surfaces semantic hits, Ask retrieves the top-K relevant pages instead of dumping the whole vault, and the Graph can overlay similarity edges. Reindex from Settings; the index is a plain rebuildable file under the app-data dir. A live reindex (like a live ingest or lint run) surfaces as a Topbar chip, so navigating away doesn't lose track of it |
| Related notes | Every page shows a "Related" panel — the nearest pages by embedding similarity, even when they aren't wikilinked |
| Live ingest progress | With the Claude CLI provider, the run streams in real time (`--output-format stream-json`): a mission-control panel shows the current action, an interactive mini-galaxy of pages touched so far (live d3-force physics — new pages born at the hub, real wikilink edges, drag to tow, hover for path, click for an in-place markdown preview with an open-in-reader button), a scrolling activity feed, read/write counters and elapsed time — plus a **Cancel** button that kills the run. The run lives in a global store, so navigating away doesn't lose it; a Topbar chip keeps showing a spinner + elapsed (click to jump back), then flips to done/failed until you revisit the page. On the Graph page, nodes the run touches glow live — written pages gold, read pages ice blue, newest touch pulsing — and brand-new pages are born into the galaxy mid-run: each write triggers a debounced link rescan whose diff is injected into the live physics, so new stars bud off their neighbours and settle in real time. The tint persists after the run so you can see what changed. When the run finishes, the mission-control panel stays up as the result view — mini galaxy, feed and counters intact — until you start another ingest |
| Ask | Question your wiki. Retrieval defaults to the wiki; the scope segment widens it to sessions or all, and Settings → AI settings → "Search archived sessions" adds `sessions/archive/` to the index (re-indexes). Hits carry a source tier (note / map / digest / rollup / session / source) and a tier prior applied after RRF fusion (defaults 1 / .9 / .8 / .8 / .6 / .5, retunable in the Advanced disclosure, "all 1.00" restores the old behaviour); the source ladder shows readable note titles and quoted passages, with weight, `RRF × prior = final`, file paths and rank changes under Search details. When no hit clears the relevance floor (0.42), the abstention card replaces the answer in plain words ("I couldn't find this in your notes"): its primary **Write this question in today's note** appends `Question: …` through the same `capture_note` as Home and then reads **✓ Written in today's note · Open**, which opens the note on that line; **Search wider** and **Mark as a question to fill later** follow, and **Details** holds the indexed page count, the floor and the near-misses on a floor gauge ("keywords only" when only BM25 matched). **History** at the top of the page lists past turns newest first (question, relative time, cited notes, a badge for not found / failed / stopped) with a search; it starts folded, and opening a row shows the turn as recorded, never asked again. Each vault's turns go one JSON line each to `<app-data>/ask-history/<hash>.jsonl`, outside the vault, keeping the last 500. A failed last turn offers **Retry** with its own question and scope. During retrieval or an answer, the send button is ■ (**Stop answering**): the turn becomes a **Stopped** card at once and a late answer is dropped; on Claude Code ■ also cancels the `claude` run. With a cloud or CLI provider, the model answers with citations to vault pages. The built-in offline provider offers quote-only answers with real `[[wikilink]]` citations, plus optional short local summaries after installing Qwen3.5-4B Q4_K_M (2.71 GB of disk space) in Settings → AI settings and choosing **Use Qwen for Ask**. E5 retrieval stays unchanged. Sources are checked before and after local generation; missing models, unavailable generation and rejected replies retain the quoted-evidence answer. Rejected source evidence instead offers Retry, which retrieves fresh sources. Ask generation remains separate from import and organization drafts; generated wording and valid source links do not establish that every claim is supported by those sources. Answers render as markdown with clickable `[[wikilinks]]`, and every cited page appears in an interactive mini galaxy under the answer (drag, hover, click for an in-place preview) |
| Lint | "Run lint" in Provenance shells the CLAUDE.md checklist (structure / citation / connection / freshness) to the active model and renders a Markdown report. The run lives in a global store — navigate freely while it works; a Topbar chip tracks it and flips to done/failed until you return |
| Provenance | Per-page citation coverage (claim lines vs cited claims); sort by lowest coverage, slider threshold flags below-target pages |
| History | Lists the WHY report each ingest files under `ingest-reports/`, newest first, with an expandable in-place markdown preview and an open-in-reader jump |
| Graph | Full vault link graph rendered as a **3D universe** with **three.js** (WebGL) over a **d3-force-3d** layout (the same force family Obsidian uses: link + many-body + x/y/z + collision), with degree-normalised link strength so leaves hug their hub and clusters drift into separated "dandelions". Glowing star nodes (UnrealBloom + depth fog + drifting starfield), faint filament edges, every note shown including link-less orphans. **Drag to orbit**, scroll to zoom, slow idle auto-rotate; **grabbing a star re-heats the sim** so neighbours follow in 3D and it springs back on release. The settings drawer starts with **eleven coordinated looks**: Spiral galaxy places the actual notes along spiral arms with soft starlight, alongside Sigma board, Cosmic web, Neural, Planetarium, Paper atlas, Chronicle, Meaning nebula, Walrus tree and Mycelium. **Woven** replaces Ribbon with actual links gathered into curved fiber bundles, calculated in a worker. One edge produces one strand, retaining exact endpoints. Selection, search, question highlights, filtering, dragging and fit-to-view use the shared graph interactions. Terrain and City are hidden from the pickers. Each look restores its full appearance while preserving the current question and filters. Tuned looks show **Adjusted** with a restore button. Numeric fields beside sliders support precise entry with bounded values. **Note name visibility** explains its zoom behavior; community names prefer existing notes and use a bounded display width. Appearance and motion controls follow the active renderer; static maps offer **Layout size**, simulated layouts offer force controls, and Mycelium offers mat and branch density. Hover spotlights the 1-hop neighbourhood, click opens the file. **▶ Timelapse** replays the vault oldest-to-newest by mtime with **live 3D physics** — each star spawns at the hub and shoves its placed neighbours aside as it arrives. The tree + graph **auto-refresh** on external file changes (Obsidian/Finder, finished ingest); drawer + slider state persists to localStorage. Above the stage a **question bar** picks one of four questions (where is it empty / what clumps together / what grew recently / this note's neighbours) — each one changes only the per-node encoding `{color, radius, alpha, ring}` (`lib/graphEncoding`) that the scene's own style pass applies, never the layout, so the answers sit on the same coordinates; the size channel switches between backlinks and citations, two checkboxes hide the first-run sample notes and toggle unresolved links, and a chip counts scene rebuilds (typing in the find box must never move it). A **gaps column** on the left lists orphans, missing pages, notes with no backlink, under-cited and low-confidence notes, each row offering open / draft a link question / log as a wanted topic. The gaps column and the legend on the right each fold to a 28px edge tab with their icon and count — the chevron in their head, `[` / `]` (ignored while typing, while a dialog is open and on key repeat), or **Graph settings → Panels** — and the stage takes their width (the canvas resizes through its ResizeObserver); in a window 821–1240px wide, where the legend sits under the gaps column, one fold gives the other column its full height and only folding both widens the stage, at 769–820px, the graph appears first and both panels stack below it, retaining readable height and fold/restore controls on the scrolling page for mouse and touch. At 768px and under, the phone sheet provides panel access without changing saved desktop folds. The fold is stored per device in the graph settings (`gapsRailOpen` / `legendRailOpen`), outside every look, so reloads and look changes keep it |
| Tidy | Offline ingest of session transcripts left `wiki/source-claude-code-<uuid>` pages titled `Source: <uuid>` whose `## Related` links named transcripts outside `wiki/` (the Graph's missing pages). Lists name such a page `Claude Code · 3f2a9c1e`, or its readable title once it has one (`listedName`). **Tidy** — the gaps column head, `⌘K` "Tidy the vault", Settings → My space → Tidy — scans the vault and proposes three groups (`lib/tidy.ts`, pure): titles from the transcript's first prompt, agent and date (found by stem or `conversation_id` under `sessions/` or `raw/`, read only; a page with no transcript is listed as skipped); Related links rewritten to `source-<stem>` or removed, prose and citations untouched; and, unticked by default, a move into `wiki/sessions/YYYY-MM/`. Applying (`lib/tidyRun.ts`) writes only `wiki/` through `write_file` / `move_path` (moves follow the page like the sidebar's: draft, route, favorites), re-reads each page first and leaves, and names, one that changed since the scan, after saving `.myco/tidy/<timestamp>.json` with each file's previous path, text and the sha256 of the new text. Undo, on the receipt or under Settings → Tidy history, restores a file only while it still hashes to what Tidy wrote and names the ones it left |

Woven retains the `ribbon` storage key. Routing fans follow the link topology
(Louvain on the links); inside a fan each colour cluster sits whole as its own
sub-fan, so its name and a legend focus land on one region. The strands are
drawn in GraphScene's own scene with the shared link-light tokens and their
notes' hues, and Woven draws the default look's pixel notes. Crossings do not
create graph junctions;
orphans remain unconnected. The old Terrain and City renderers and saved settings
are retained for compatibility, but are no longer offered in the pickers.
Verify with `node scripts/woven-smoke.mjs 250` against the dev server on port 5187
(or set `MYCO_TEST_URL`). Screenshots use synthetic notes only.
Graph settings keep keyboard focus and do not trigger canvas shortcuts while a
control is focused.
Before changing how the Graph draws, read the
[graph visual rules](docs/design/graph-visual-rules.md);
`src/lib/graphVisualRules.test.ts` pins the ones code can check.

Spiral galaxy starts at an inclined view with open, thin arms. Planetarium keeps
its stars clear of nebula haze. Cosmic web's link visibility controls its actual
filament field; Neural uses quieter points and links, and Mycelium uses a violet
palette. Void and grid backgrounds contain no residual decorative stars.

### Learning & research

| | |
| --- | --- |
| Study (flashcards + spaced repetition) | **More → Make cards** on any page builds cards from the note's own words with no model call (`lib/extractiveCards.ts`): a definition card from the lead, a card per H2 with prose under it, and up to six cloze cards from sentences with a bold or wikilinked term. Every front and back is the note's text apart from the i18n frames, and each card is sourced at `[[stem#Heading]]`. A preview lists them with checkboxes; the checked ones are saved to `cards/<stem>.md`, deduped by normalised front. Cards live as plain markdown (Obsidian-`spaced-repetition` syntax + an FSRS state trailer, so review state round-trips; a new card keeps its source in a `<!--src:…-->` line). `cards/` is not part of the link graph, so a deck never stands in for its note. **Start review** on Home and at the top of the **Study** route opens *Today's review*: the due cards of every counted deck in one queue, most overdue first, so the session holds exactly Home's number (front → reveal → grade **Forgot** (FSRS Again) or **Remembered** (Good), each naming the interval it schedules, "tomorrow", "in 4 days" → saved to the card's own deck). **Settings → Study → Grade in detail** brings back Again / Hard / Good / Easy. Space reveals, then focus waits on Remembered; 1 / 2 (1–4 in detail) grade. The end screen names the next review day and its count ("Next review tomorrow: 3 due"), and a failed save warns. Each card keeps its source as a link to the note's heading, and the route also runs an extractive multiple-choice quiz from the cloze cards. A deck whose cards name no source note, or whose backs that note does not contain, is flagged "N ungrounded cards"; if every card is, it counts toward no due total (Study, the sidebar badge, Home), and **Archive** moves it to `cards/archive/` via `move_path`. Model-made cards and quizzes are opt-in (**Settings → Study → Make cards with AI (experimental)**, off by default, needs a connected chat provider) and quote-checked: a card survives only when its back occurs verbatim in the note |
| Agent mode | An Ask/Agent toggle on the Ask page. In Agent mode a tool-capable model (Anthropic API or an OpenAI-compatible provider) plans and calls read tools over the vault — search, read pages, traverse links, provenance — streaming a collapsible step trace, then answers with citations. Optional **write tools** (create/update page) are confirmed per call and never touch `raw/`. With a provider the agent cannot drive, the tab says so beside an **Open AI connections** button that opens that Settings tab. Reusable **task-agent presets** are saved as portable `agents/<slug>.md` files |
| Audio overview | Turn a set of pages (an answer's cited pages, or a Reader page + its neighbours) into a grounded two-host spoken "deep dive". The dialogue is generated from the pages' markdown (with citations), saved as a transcript in `audio/`, and played back offline via the OS voices (Web Speech API — no bundled engine); click any transcript turn to jump there |
| PDF viewer + highlight backlinks | Open a `raw/` PDF in-app (pdf.js, bundled worker — no network). Select text → "Highlight & cite" mints a colour-coded highlight and inserts a `[[pdf::<stem>#p<page>:<id>]]` pinpoint link into your note; highlights persist in an external sidecar (`wiki/.annotations/<stem>.json`, so `raw/` stays immutable). Click a pinpoint link to open the PDF at that spot; click a highlight to jump to the citing note |

### Model connections

Settings → Connections lets you connect any combination of:

- **Built-in (offline)** — multilingual-e5-small-ko-v2 embedder (42 MB) bundled in the app, in-process llama.cpp — no install or key for search, quote-only Ask and extractive Ingest. Optionally download the separate Qwen3.5-4B Q4_K_M artifact (2.71 GB of disk space) under Settings → AI settings, then choose **Use Qwen for Ask**. It summarizes retrieved evidence locally; factual similarity questions preserve the quote-only answer when generation is unavailable or rejected, while recent-work overviews offer Retry. Rejected source evidence requires a fresh search through Retry. Optional Qwen3.5-2B Q4_K_M (1.27 GB of disk space), selected with **Use 2B for import and organization drafts**, adds reviewable summaries beside source quotes. Local organization uses the selected import model when Ask uses the built-in provider. Installation and model selection are explicit. Classification and other file-tool workflows still need a connected provider. Intel Mac with 8 GB RAM inference performance has not been measured.
- **Claude Code (CLI)** — uses your Pro/Max subscription. No key needed; just have `claude` on PATH.
- **Anthropic API** — direct `/v1/messages`. Key from console.anthropic.com.
- **OpenAI API** — `/v1/chat/completions`. Live model list fetched from `/v1/models`.
- **Google AI** — `:generateContent` for the Gemini family.
- **Ollama** — local `http://localhost:11434`. Auto-detects installed models.
- **OpenRouter** — `/api/v1/chat/completions`. Live catalog of 80+ models.

API keys go straight to the OS keychain (macOS Keychain Access / Windows
Credential Manager / freedesktop Secret Service) under the service name
`dev.cmblir.myco`. They never touch the disk in plaintext.

Settings → AI settings gives you separate provider+model dropdowns for the two
tasks myco performs — **Query** (Ask the wiki) and **Ingest** — so you
can run e.g. Claude Sonnet for ingest and a local Llama for Q&A.

### Interface

- Notion-flavored shell: warm-white light or near-black dark, three
  density modes, custom accent colour.
- Three UI languages: English / 한국어 / 日本語. The model's drafting
  language is independent of the UI.
- `⌘K` command palette (jumps to any route or vault file; `path:` `tag:`
  `type:` `status:` `confidence:` narrow the page list by frontmatter, and
  the four built-in lenses — no sources · orphans · disputed · recently
  changed — list the pages that answer each question). Name and body rows
  run notes on record as yours, then unmarked notes, then myco's pages
  ("wiki · by myco"), then managed files, each named by its kind (Study cards, Ingest
  report, Organizing candidate) instead of its folder; semantic hits keep
  their score order, and the body search fills its hit limit from your
  folders first.
- Home starts with **Add something**, **Ask your notes**, **Write a note**, and
  recent notes. **Review & organize** opens the existing suggestions, activity,
  customizable board and maintenance tools; activity links reveal their target.
  Home is one centred column. The bell in its title row counts what needs a
  look: notes changed while you were away, notes to check (each problem in
  plain words, never the raw lint line) and notes that disagree. The sidebar's
  Home badge is the same number, and with nothing to report neither shows one.
  **Reflect** in Review & organize lists notes nothing links to and links to
  notes that don't exist yet, among your own notes only. Each row leaves the
  list once you open it, create the note or dismiss it (a dismissal is kept
  for that vault until the finding stops holding); the card shows when the
  run finished and says "All tidied up" once the list is empty.
  Under the Home box, **Ask** and **Add to today's note** do what Enter and
  ⌘Enter do; the box grows to four lines, the key hint shows only where a
  pointer can hover, and the "Added to today's note" toast's **Open** lands on
  the `- HH:MM` line just written.
- First run is a three-step wizard (1/3 … 3/3, **Skip** on each): choose the
  folder for your notes or start with a demo vault, write a first note or
  import a file's text (saved as `wiki/<first line>.md`), then ask one
  prefilled question, which opens Ask on its answer. Session import and vault
  history moved to a Home **More you can set up** card, closed for good with
  its ×; Settings keeps both.
- Sidebar: Home · Ask · Add sources · Review suggestions · Graph · Tasks. Study,
  History and Provenance remain under **More tools**. Desktop navigation uses
  compact 32px rows and a 240px default width; narrow and touch screens retain
  44px row targets.
- The file tree draws your top-level entries under **My notes** and folds the
  ones myco keeps (`raw/`, `sessions/`, `cards/`, `ingest-reports/`, `work/`,
  `_inbox/`, `templates/`, `audio/`, `CLAUDE.md`; `lib/vaultAreas.ts`) under
  one **Managed by myco** row, closed unless the open note lives there. Files
  stay where they are on disk. A page the authorship index says the agent
  committed carries **by myco**; a page with no record stays unmarked. With
  vault history off, the opened managed row says how to tell myco's notes
  apart.
- Disabled `.btn` and `.btn-primary` buttons are dimmed with a not-allowed
  cursor.
- Add sources puts file selection and pasted text first. Other import methods,
  batch processing and technical details are available in expandable sections.
- Ask puts the question first, offers example questions that only fill the input,
  and keeps provider, agent and ranking controls under **Answer options**.
- Settings groups **My space**, **AI settings**, **Appearance**, and **Language**
  first. **More settings** contains AI connections, external tools (MCP), automatic
  organization, Plugins and About. Search includes every group and reveals matches.
- On macOS, the **Notch** switch hides and reuses its native window when disabled. It blocks duplicate changes while saving, restores the previous state on failure, and displays a retryable error beside the switch. Disabling also stops notch voice capture and clears its expanded state.
- The notch's mascot (`NotchMascot`, rules in `lib/notchMascot.ts`, spec
  `docs/specs/2026-10-02-notch-mascot.md`): the myco mushroom perches under the
  collapsed notch (30 px), stands at the open card's leading edge (56 px) and
  in the notchless pill (22 px). Each pose has its eyes painted out and redrawn
  in SVG, so they blink every 3–7 s, follow the pointer while peeked (notch.rs
  sends the pointer at most 30 Hz, only while hovered), squint, close or
  spiral; one spring transform carries breathing, the peek's hello, the drop's
  gulp, hops, the sigh and the head shake. A click squishes it for 600 ms, a
  triple-click makes it dizzy for 2.5 s. Running plays `read-loop`, saving a
  voice take `think`, a rejected file `shake-no`; after 90 s of idle quiet it
  plays `doze`, and a peek wakes it with `wake`. The clips are krea.ai takes
  from the five character-sheet poses, keyed to 160 px WebP strips with
  `scripts/mascot-key-clip.py` (about 0.59 MB, under a 1.6 MB budget); hello,
  gulp, celebrate, sigh and listen stay procedural until retaken (see
  `src/assets/mascot/README.md`). Recording drives the cap glow from the voice
  level. Reduced motion shows still poses with no blink, tracking or clips, a
  hidden window plays no clip, and **Settings → Appearance → Show MYCO, the
  mascot** off restores the status dot. The mascot is `aria-hidden`; the text
  stays the source of status.
- Mascot pose edges recover colour before alpha cleanup, and the macOS video
  encoder premultiplies RGB to match native HEVC alpha playback. This reduces
  bright cap fringes across the shared poses and app clips; see the
  [asset guide](src/assets/mascot/README.md) and
  [verification record](docs/research/2026-10-07-mascot-edge-verification.md).
- Settings changes save in order. The page shows saving, saved, or an error;
  a failed change restores only the affected setting and preserves later choices.
  Disconnecting a selected AI connection switches the affected tasks to the
  built-in offline provider.
- `⌘B` toggles the sidebar.
- Menu bar tray: left- or right-click opens a glass popover — the mascot with a
  one-line status, at most one card for the thing awaiting a decision
  (approve/dismiss a map proposal inline), the waiting counts and today's
  inflow as tiles with the 24-hour chart folded behind a disclosure, and
  Ask / Distill buttons.
- On macOS, opening myco again from the Dock or Finder restores and focuses
  the main window, including when a resident notch window is still present.
- Notices: work in progress lives in the top-right activity chip — **every**
  long run reports there and only there (Ask, harvest, ingest, lint, distill,
  reflect, reindex, a link "accept all"), so the bar shows one spinner however
  many are going: a ring fills as the run advances, the label swaps per step,
  two or more collapse into one "Activity N" chip listing them all, and the
  ring turns green for a beat when the last one ends. A finished run then
  leaves a single done/failed pill in the bar until you visit the page that
  explains it — harvest → Today, distill → Feedback, ingest → Ingest, lint →
  Provenance, Ask → Ask — which is how a run you walked away from still finds
  you. Results arrive as toasts that drop in directly under the chip — at most
  three, each with one action, paused while hovered, `Esc` dismisses the
  newest. The same event never appears in both. Accepting a single suggested
  link animates the ✓ in place instead of raising a toast.
- `⌥Space` (global, works from any app) opens a spotlight window: type a
  question, press Enter, and the answer appears with its citations —
  clicking one opens that note in myco. It runs the same Ask path as the
  in-app page. When it finds nothing it says so with the Ask page's title,
  **Write this question in today's note** and **Open in Ask**. Change or
  switch it off under Settings → Appearance; if
  another app already owns the combination, that row says so instead of
  leaving a key that quietly does nothing.
- `⌥M` (global, works from any app) records a voice memo into `_inbox/`. It
  starts the take on the notch; with the notch switched off (Settings →
  Appearance) it opens the spotlight window and records there, so the key
  always has a surface. Pressing it again saves the take — it never
  discards one. If another app already owns `⌥M`, the key still works
  inside the notch or the spotlight window itself, and the reason is logged
  at startup. In either surface (or via the mic button): the waveform is drawn
  from the real mic level (a flat line plus a "no sound is coming in" hint
  mean the mic is not being heard) and the words appear under it as a live
  caption while you speak, the row names each stage (transcribing → saving)
  while whisper runs, and the note is saved as soon as the transcript
  exists — related-page stamping happens afterwards in the background.

### Reusable myco motions

Six motions use the original myco character: idle, welcome, thinking, saving,
success and empty. Welcome and success play once. All variants honor reduced
motion; the in-app mascot switch shows a static mark.

Use `MycoMotion` in React or copy the standalone HTML/CSS examples from
[`public/brand-motion/`](public/brand-motion/index.html). The gallery includes
replay, pause, light/dark previews and a portable ZIP download. See the
[usage guide](docs/myco-motion.md). No animation library or video decoder is
required. For the frontend usability checks, start the dev server and run
`node scripts/everyday-smoke.mjs` and `node scripts/intake-smoke.mjs`
(development mock IPC only). These cover primary actions, disclosures, preserved
review state, error recovery, keyboard input and responsive layouts.
`node scripts/editor-writing-smoke.mjs` checks the editor and source editing,
optional authorship review, undo, list continuation, lossless mode switching,
read-only originals, save status during queued writes and failed-save recovery with synthetic notes in the same
development mock. It also checks Note info on 320/375/768/960/1280px layouts
and in a split workspace.
If a large note is still being prepared, block insertion preserves its text and
caret and asks you to retry instead of inserting into an incomplete list.
`node scripts/new-note-writing-smoke.mjs` checks immediate typing after Home,
sidebar and shortcut creation, switching from Read/source, existing-title reuse,
and cancelling the title prompt without changing the note or mode.

For actual video assets, see the [video motion kit](docs/myco-video.md): fifteen
silent clips with transparent WebM, Safari HEVC, ProRes 4444, MP4 previews, and
a standalone gallery. The exported media lives outside `public/` so editor
masters and downloadable archives do not increase the desktop application size.
The four additional actions—inspecting, idea, greeting, and organizing—preserve
the handless source character and accepted reading framing, using authored
props and transforms. The previous eleven clips are unchanged.

If Node exposes an unconfigured experimental Web Storage API, run unit tests
with `NODE_OPTIONS=--no-experimental-webstorage npm test`. Browser storage and
native app behavior are unaffected by this test-process option.

### Desktop workflow verification

Home starts with workspace tools folded. Folding releases their widget scans,
observers and layout effects; explicit activity links still reveal and focus
their section. Home statistics retain their numbers and seven-day strip without
an animated graph behind them. The obsolete Home background picker is removed.
Pending arrangement saves bind their originating vault and report failures.
While a vault's initial inventory is being prepared, sidebar rows and counts
show loading instead of claiming the vault is empty. Repeated periodic graph
refreshes and tray inflow/task probes share their session's pending reads rather
than queueing more directory walks. A different vault can still start its reads;
this does not cancel an existing OS filesystem wait.

File inventory and provenance scans, index cache loads, CLI checks and retrieval
ranking use blocking workers, keeping those reads out of the native window
handler. Scans and inference still consume CPU and I/O; `open_vault` and other
existing adapters retain their current scheduling.

Authoritative file inventories and embedding rebuilds report folder/file read
errors rather than publishing an empty or partial inventory as complete.
Incremental index batches retain pending work on uncertain reads; only a
confirmed missing file is treated as deleted. These preservation checks do not
establish the quality of generated answers.

Agent tool calls and Reflect-created notes carry their originating native vault
opening. Switching, closing, reopening the same folder or attempting a failed
open invalidates old actions. Pending approvals and late results are discarded.
MCP HTTP sessions are also pinned to their opening: initialize a new session
after those transitions; an old session cannot follow the new active vault.

With automatic organization enabled, explicit MCP session imports and updates
queue one session per pass using the selected ingest provider. Updates reuse the
same wiki summary across immutable source revisions and preserve human
annotations and earlier source citations. Failed or partially read revisions
remain pending; automatic organization does not silently select a cloud model.
New evidence also refreshes an organized session's original record and saved
turn dates, keeping later revisions discoverable without inventing an activity
date from the time of organization.
Title changes create immutable source revisions without changing the session's
summary path. Duplicate session identities remain pending rather than selecting
an arbitrary page. MCP `write_page` and deprecated `update_page` updates require
the full-file `expected_sha256` from `read_page` or `preview_page_update` to reject
a stale revision; create requires the target path to be absent. Legacy tools
use the same canonical path and source-protection checks. Agent `update_page`
also requires the exact full-file hash returned by its `read_page`.
Session updates require a local, API or CLI ingest provider. The myco Pro
connector currently keeps session revisions pending; its ordinary document
imports are unaffected.

The [local-first model and validation plan](docs/specs/2026-10-08-llm-wiki-model-and-validation-plan.md)
assigns candidates and acceptance gates for each wiki workflow. Gemma generation
and EmbeddingGemma 2 remain evaluation candidates; these source changes do not
select them in the installed app or establish semantic/offline acceptance.

Suggested links share one action owner across Home, the reader and the notch.
Batch actions append once per source note, preserve open editor
drafts, reject changed disk revisions, and expose partial failures with Retry.
Dismissed link suggestions survive browser reload without a 500-item cutoff.
The reader's Git authorship lookup runs off the UI thread so a filesystem
access wait does not freeze the window.

Harvest processes only the selected inbox copies and resumes bounded evidence
batches. Copying a session does not count as completion: full ingestion and
successful archiving are required. Unfinished copies remain retryable. The
notch waits for the main writer's acknowledgement and keeps failed or refilled
rows available. Tray and notch decisions retain the vault and opening-session
identity of their snapshot. Switching, closing or reopening a vault invalidates
older decisions; rejected requests remain available for retry after a fresh
status update. Unreadable Study decks, inbox listings and provenance scans
show an error with Retry; scans discard superseded vault results and clear
closed-vault caches. Proposal dismissal reports its actual write result.

Ask offers **Stop answering** during local retrieval too. A stopped or cleared
question cannot replace a later answer, and opening another vault clears the
conversation and note scope before native search can switch roots. Calendar
filters use local midnights, including daylight-saving boundaries. Imported
sessions with explicit but unknown turn timestamps cannot count as exact dated
evidence; older sessions without turn metadata retain their month-level fallback.

With the built-in provider, topic-free dated work questions such as **어제한 일** and
**최근 일주일동안 한일** read original timestamped conversations and show a
compact status overview instead of long verbatim excerpts. Performed/results
reported, in progress/planned, and requests/decisions pending/completion
unconfirmed each show up to four recent statements with their time, speaker,
and exact source path. “Recent week” includes today and the preceding six
local calendar dates. Recognized request, condition, negation, example and code
markers remain unconfirmed; unrecognized wording stays unconfirmed. Status
classification uses bounded rules and cannot resolve every phrasing. This bounded
indexed-record scan reports incomplete coverage, and even an assistant's
completion report does not independently verify a completed task. Topic-specific
questions keep ordinary hybrid retrieval. Personal recall never falls back to
a list of recently modified files. Explicit file-activity questions use their
requested local-day window and scope, with unambiguous relative-path citations.
An explicit or inherited wiki-only scope never uses the unrestricted Git log;
the question keeps the normal scope-bound retrieval path instead.
Wiki-only follow-ups also stay out of session-derived project discovery, unless
the user explicitly changes the scope.
Activity searches mark coverage as incomplete when a file name cannot be safely
represented across platforms, such as a literal backslash in a Unix file name.

Generic **connected ideas** questions can show existing wiki links and shared
tags from the readable graph snapshot, without another model or an all-pairs
similarity pass. A conversation-only scope explains its limitation and offers
the existing **Search wider** action. This is structural evidence, not generated
conceptual synthesis. Missing or retired dense vectors still allow verified
keyword evidence while semantic indexing rebuilds.

Settings → Automatic organization → Deletion method offers an explicit
**Delete permanently** option. Legacy settings continue using recoverable
deletion. The selected method covers manual deletion, approved delete proposals,
and eligible quarantine expiry; raw-original and approval guards remain.
With permanent deletion enabled, cleanup purges only manifest-proven internal
myco trash copies, never the system Trash. Symlinked targets are rejected and
batches are validated before removal.
The confirmation's policy must match native persisted settings. Automatic
organization runs record permanent cleanup removals separately. Permanently
deleted files cannot be restored by Undo, including
when a later cleanup removes an older run's trash copy.

Tasks keeps the draft after a failed save and refuses to overwrite an existing
daily note when its read fails. Completing a recurring task keeps its detail
panel on the completed occurrence. Failed conversation-import retries retain
their source list and destination for another retry.

With a loopback dev server running, `npm run test:e2e` checks named routes,
Study, inbox and provenance error recovery; `npm run test:e2e:links` checks partial linking
and retries at 375, 768 and 1280 px; `npm run test:e2e:harvest` verifies long
sources, full evidence coverage, held sources and archive-error retries.
`npm run test:e2e:ask-lifecycle`, `npm run test:e2e:tasks`,
`npm run test:e2e:import`, and `npm run test:e2e:study` cover the additional
question, task, import and study workflows with synthetic IPC.
`npm run test:e2e:home` checks folded tools, saved layout and section focus at
375, 768 and 1280 px, plus input during a held synthetic harvest request at 1280 px.
`npm run test:e2e:home-save` checks arrangement and board saves on close,
failed writes and vault transitions with synthetic IPC.
These execute browser code with synthetic
IPC and do not certify native permissions, accounts, speech, or model inference.
The [desktop audit](docs/research/2026-10-04-desktop-feature-audit.md) records
coverage, remaining prerequisites, measurements and native verification.
The [Ask recall verification](docs/research/2026-10-05-ask-recall-verification.md)
records dated original evidence, keyword fallback, connection scope and the
synthetic-versus-installed-app verification boundaries.
The [local model review](docs/research/2026-10-04-local-model-improvement.md)
records the verified 42 MB GGUF, quality priorities and Intel/8 GB test limits.
The [EmbeddingGemma 2 review](docs/research/2026-10-07-embeddinggemma2-review.md)
evaluates Google's October 6 release as an E5 replacement candidate, with
runtime, vector migration and Korean measurement prerequisites. It does not
replace Qwen's generated wording; no candidate weights were installed or tested.
The [local generation verification](docs/research/2026-10-05-local-generation-verification.md)
records the optional Qwen Ask installation, source checks and measurement limits.
The [local role comparison](docs/research/2026-10-05-local-model-routing.md)
records separate Ask/import model selection, organization drafts and remaining
retrieval and generation quality limits. Local Ask checks every chunk of each
cited page against its index and compares complete file revisions before and
after generation; changed evidence requires Retry.
The [local generation options](docs/research/2026-10-04-local-generation-options.md)
retain the October 4 artifact review and implementation prerequisites.
The [installed continuation](docs/research/2026-10-06-installed-continuation.md)
records stale-source and delayed-insertion regressions, mobile graph coverage,
and installation verification boundaries.
The [work-advice verification](docs/research/2026-10-07-work-advice-verification.md)
separates native model meaning checks from JSON/citation acceptance and records
recommendation-policy selection, regression tests and remaining quality limits.
When a selected local Ask model cannot produce a verified answer, the page
explains the failure category above the source quotations and offers Retry for
the latest question. Quote-only Ask remains available without this notice.
Local Ask has no automatic time limit for model verification or generation.
The page shows elapsed time while it runs. Stop cancels the request and rejects
a late reply; source rechecks and token/context bounds remain in place. Import
previews retain a 45-second generation budget, starting after model artifact
verification and loading. Cold preparation does not consume that budget;
cancellation and source rechecks still apply.
The [design system](docs/design/design-system.md) records theme and type tokens,
component states, responsive layout, accessibility, brand and mascot motion.
It distinguishes current implementation from requirements for subsequent work.
`npm run test:e2e:brand` checks the sidebar logo, touch targets and keyboard
navigation at 320, 375, 768 and 1280 px with synthetic IPC.
`npm run test:e2e:mascot` checks count badges, projected floor shadows,
hidden-window pauses and graph cameo timing with synthetic geometry.
`node scripts/notch-agenda-smoke.mjs` checks acknowledged row outcomes;
`node scripts/notch-vault-boundary-smoke.mjs` checks both secondary-window
senders against the production App broker with synthetic storage, including
vault transitions, reopened sessions, failure/retry and successful controls.
The roaming character retains its hops and checks pointer clearance along its
planned ground run; cramped windows may use the farthest available stop.
Its shadow shrinks at the apex and fades on return.

## Install

Download a release bundle from the
[latest release](https://github.com/cmblir/Memex/releases/latest):

- macOS (Apple Silicon): `myco_0.3.0_aarch64.dmg` — signed and notarized.
- Windows x64: `myco_0.3.0_x64-setup.exe` (NSIS installer) — unsigned.

Mount, drag to Applications.

Windows, and macOS builds before v0.3.0, are **unsigned**, so the OS warns on
first open. Unblock once:

- macOS (Gatekeeper "unidentified developer"): right-click the app → Open →
  Open; or run `xattr -dr com.apple.quarantine /Applications/myco.app`; or
  System Settings → Privacy & Security → "Open Anyway".
- Windows (SmartScreen "Windows protected your PC"): click "More info" →
  "Run anyway".

On first launch myco creates `~/Documents/myco/` and seeds it with the
canonical layout plus a few interconnected starter notes (LLM concepts) so
the Graph is populated on day one — delete them anytime. To use a different
folder, open Settings → My space → Change…

### Reading graph relationships

All graph looks retain their visual identity. Selecting a note prioritizes its
name and neighboring names. Terrain, Ribbon and City use clearer community colors,
raised note tiles or lower towers, and relationship strokes above their surfaces;
selected links remain traceable across folds and buildings. Mycelium preserves
its selected neighborhood when the pointer leaves. Dense overview labels remain
bounded to avoid overlap. See the [research and tradeoffs](docs/graph-readability-research.md).

## Dev

### Native acceptance startup guard

Build full-app validation binaries with `--features native-app-acceptance`.
These binaries refuse startup unless they are debug builds with both
`MYCO_REAL_DIAGNOSTIC=1` and `MYCO_DIAGNOSTIC_DISABLE_INDEX_UPDATER=1`.
The existing startup validation also requires an explicit, canonical, existing
`MYCO_DATA_DIR` separate from production application data. Missing environment
variables must never fall back to a normal production launch, including launches
initiated by desktop automation or Launch Services.
The acceptance feature also requires a regular, valid `settings.json` with
`auto_import_enabled`, `auto_ingest_enabled`, `auto_reflect_enabled`, and
`auto_reindex_enabled` disabled. Missing or invalid settings cannot silently
enable automatic imports through the application's normal defaults.

This guard is necessary but is not a complete filesystem sandbox. Before native
acceptance, use a separate bundle/WebView identifier, explicit synthetic startup
vault, disabled automatic imports and OS-level access restrictions. Do not reuse
a fixture containing automatically imported personal sessions. Normal builds
without this feature retain their existing startup behavior.

### Interactive graph design preview

Run `npm run dev`, then open `http://localhost:5173/graph-preview.html`.
This development-only review page uses the existing synthetic sample vault and
its explicit links; it never opens a personal vault. Switch Terrain, Ribbon and
City, drag nodes or the background, zoom with the wheel or buttons, search note
names, and follow the selected note's neighbors. Selection persists across styles.
The search and neighbor buttons provide keyboard access; the graph also supports
arrow-key panning, `+`/`-` zoom, `0` to fit, and Escape to clear selection.
Reduced motion disables layout transitions. This prototype is not yet integrated
into the desktop Graph page; its separate HTML entry is not part of release builds.
Run `npx vitest run src/graph-preview/model.test.ts` for graph identity and layout
boundary checks.

Prerequisites: Node 20+, Rust 1.89+, plus platform-specific Tauri
prerequisites (<https://tauri.app/start/prerequisites/>).

```bash
cd app
npm install
npm run tauri dev      # hot-reload dev window
```

Other scripts:

```bash
npm run build          # frontend type-check + vite bundle
npm run lint           # eslint over src/
npm run format         # prettier write src/
cargo fmt              # in app/src-tauri
cargo clippy -- -D warnings
cargo test             # Rust unit + integration tests
cargo bench            # vector-store benchmarks (see below)
```

### Measuring the semantic layer

`cargo bench --bench vector_store` benchmarks the embedding index over synthetic
1k/5k/10k-record stores at the bundled model's 1152 dimensions. It is pure CPU —
no model weights, no Metal — so it runs anywhere and is the place to compare two
implementations before shipping one. Each candidate optimization is written into
the bench first and measured against the baseline it proposes to replace.

For where time goes on a *real* vault, which a synthetic bench cannot tell you,
launch with `MEMEX_PERF=1`. Each semantic command then prints one structured line
to stderr:

```text
[myco-perf] semantic_search load_store_ms=0.31 embed_query_ms=182.44 scan_ms=11.98 total_ms=194.79 records=10000
```

Probed commands: `semantic_search`, `related_pages`, `semantic_edges`,
`reindex_embeddings`.

For the embedded model itself, `cargo run --example bench_local_llm --release`
measures load, prefill, generation and embedding against the real GGUF. It is an
example rather than a bench because `LlamaBackend::init()` refuses a second call
per process (so a load cannot be iterated), because Metal timings want
median/p95 over warm state with the cold run discarded, and because it needs
model weights that `cargo bench` must not require (the chat GGUF it exercises
is no longer bundled — point it at a local download).

## Build

For local macOS updates that keep a stable signing identity:

```bash
cd app
npm run build:macos:signed -- --check
npm run build:macos:signed
```

This requires a valid Developer ID Application identity in the local keychain
and stops before building if it is missing or ambiguous. See
[Signing](../docs/SIGNING.md#local-builds-and-macos-folder-permissions).
It does not install or launch the app. Ad-hoc development builds remain available:

```bash
cd app
npm run tauri build
```

Outputs land in `app/src-tauri/target/release/bundle/`:

- `dmg/myco_x.y.z_aarch64.dmg` — macOS installer (~2.8 MB)
- `nsis/myco_x.y.z_x64-setup.exe` — Windows installer (when built on Windows)
- `macos/myco.app/` — raw `.app` bundle

The release profile uses `lto`, `opt-level = "s"`, and `strip = true`.

## Architecture

```
app/
├── src/                       # React 18 + Vite 5 + TypeScript 5
│   ├── App.tsx                # shell wiring, ⌘K/⌘B, theme/density
│   ├── components/
│   │   ├── Sidebar.tsx        # recursive vault tree + context menu
│   │   ├── Topbar.tsx         # breadcrumb, model status + picker, background-job chips
│   │   ├── CommandBar.tsx     # ⌘K palette (routes + files)
│   │   ├── Editor.tsx         # CodeMirror 6 + wikilink autocomplete
│   │   ├── Viewer.tsx         # markdown-it preview (wikilink → onLinkClick)
│   │   ├── BacklinksPanel.tsx
│   │   ├── DialogHost.tsx     # custom prompt/confirm (WKWebView strips natives)
│   ├── pages/
│   │   ├── PageOverview.tsx   # stats + recent git
│   │   ├── PageIngest.tsx     # drop → raw/ → model → wiki
│   │   ├── PageQuery.tsx      # ask the wiki (with cite expansion)
│   │   ├── PageGraph.tsx      # 3D graph orchestrator (lib/graphScene three.js + lib/graphSim d3-force-3d)
│   │   ├── components/GraphControls.tsx  # right-side settings drawer (Filters/Display/Forces)
│   │   ├── components/GraphQuestions.tsx # question bar over the stage (lib/graphEncoding)
│   │   ├── components/GraphGaps.tsx      # left column: the gaps, three exits per row
│   │   ├── components/GraphRailToggle.tsx # a rail's fold chevron + its edge tab while folded
│   │   ├── PageHistory.tsx    # git log
│   │   ├── PageProvenance.tsx # citation coverage + lint
│   │   ├── PageSettings.tsx   # 6 sub-tabs
│   │   └── PageReader.tsx     # vault page in live/source/preview
│   ├── stores/                # Zustand
│   │   ├── vaultStore.ts      # vault, tree, active file, adjacency
│   │   ├── uiStore.ts         # route, sidebar, theme, lang, density
│   │   ├── settingsStore.ts   # persisted settings mirror
│   │   └── dialogStore.ts     # prompt/confirm queue
│   └── lib/
│       ├── ipc.ts             # typed Tauri invoke wrappers
│       ├── chat.ts            # unified complete() across providers
│       ├── markdown.ts        # markdown-it with wikilink rule
│       ├── icons.tsx          # SVG icon set + provider glyphs
│       └── i18n.ts            # en/ko/ja strings
└── src-tauri/                 # Rust shell
    ├── src/
    │   ├── main.rs            # entry → myco_lib::run
    │   ├── lib.rs             # Tauri builder + IPC handler list
    │   ├── commands.rs        # thin IPC adapter layer
    │   ├── vault.rs           # open/list/read/write/CRUD + scaffold seed
    │   ├── parser.rs          # wikilink regex parser
    │   ├── index.rs           # link graph + tag map (deduped wikilinks)
    │   ├── sample_vault.rs    # interconnected starter notes seeded on first launch
    │   ├── git_log.rs         # shells `git log` and parses shortstat
    │   ├── claude.rs          # `claude --print` bridge (CLI provider)
    │   ├── providers.rs       # 5 HTTP adapters (anthropic/openai/google/ollama/openrouter)
    │   ├── secrets.rs         # OS keychain wrapper (keyring crate)
    │   ├── settings.rs        # JSON-on-disk persisted settings
    │   └── provenance.rs      # claim/cite scanner
    ├── capabilities/default.json
    └── tauri.conf.json
```

### IPC surface

All Rust ↔ frontend communication goes through a small typed boundary
defined in `src/lib/ipc.ts` and `src-tauri/src/commands.rs`:

| Command | Purpose |
| --- | --- |
| `open_vault` | Validate a directory; return canonical path + name |
| `ensure_default_vault` | Create `~/Documents/myco/` with scaffolding if missing |
| `list_files` | Recursive `.md` walk → `FileNode` tree |
| `read_file` | Read a file + parse YAML frontmatter (gray_matter) |
| `read_vault_context` | Concatenate vault markdown (bounded) so non-CLI providers can answer Query/Lint with real context |
| `write_file` | Atomic write via tempfile + rename |
| `create_file` / `create_folder` | Name-validated create in a parent dir |
| `rename_path` / `delete_path` | Move within parent / remove |
| `parse_links` | Extract `[[wikilinks]]` from one file |
| `build_link_graph` | Full vault scan; adjacency + tag map (repeated wikilinks deduped) |
| `git_log` | Shells `git log --shortstat`, parses into commits |
| `scan_provenance` | Per-file claim/cite count |
| `claude_check` | Locate the `claude` binary, return version |
| `claude_run` | Pipe a prompt to `claude --print`, return stdout |
| `chat_complete` | Generic chat: routes to provider HTTP adapter |
| `list_provider_models` | Live model list from the active provider |
| `set_provider_key` / `delete_provider_key` / `has_provider_key` | OS keychain |
| `get_settings` / `set_settings` | JSON persistence |

### Storage

Files on disk are the source of truth. myco never modifies your files
outside explicit writes. The link graph is derived fresh from the markdown
on every `build_link_graph` call (no cache). Persistent app settings (not
your notes) live at:

- macOS: `~/Library/Application Support/dev.cmblir.myco/settings.json`
- Windows: `%APPDATA%/myco/settings.json`
- Linux: `~/.config/myco/settings.json`

API keys are in the OS keychain, never in this file or anywhere else.

## License

MIT.
