<div align="center">

<br />

<img src="docs/myco-banner.jpg" width="100%" alt="myco — feed it sources, watch your galaxy grow" />

<h1>myco</h1>

<p><strong>A personal knowledge base that writes itself.</strong></p>

<p>
Drop a source. Claude does the bookkeeping.<br/>
Your knowledge compounds — in plain markdown you own.
</p>

<p>
<a href="https://github.com/cmblir/Memex/releases/latest"><img alt="Install" src="https://img.shields.io/badge/install-DMG%20%2F%20EXE-111?style=flat-square" /></a>
&nbsp;
<img alt="License" src="https://img.shields.io/badge/license-MIT-111?style=flat-square" />
&nbsp;
<img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-111?style=flat-square" />
&nbsp;
<a href="README-ko.md"><img alt="한국어" src="https://img.shields.io/badge/한국어-README-111?style=flat-square" /></a>
</p>

<br />

<p>
<em>"Obsidian is the IDE. Claude is the programmer. The wiki is the codebase."</em>
</p>

<br />

<p>
<strong>Built to outlive its vendor.</strong> MIT-licensed, and the vault is plain markdown you can <code>grep</code> —<br/>
every page stays readable, searchable and editable with myco uninstalled. Local git history is opt-in;<br/>
turn it on and each edit carries its author, so you can tell your writing from the agent's and revert either.<br/>
<code>raw/</code> is immutable — nothing here rewrites your sources. No server, no account, no sign-in:<br/>
the app is the only moving part, and it is the part you can throw away.
</p>

<br />

<img src="docs/screenshots/hero-mesh.png" width="100%" alt="myco knowledge graph — a vault rendered as a 3D cosmic web of glowing, community-colored stars with named clusters" />

<sub><em>The Graph view. Every note is a star sized by its links, each community its own hue, <code>[[wikilinks]]</code> are the connective tissue.</em></sub>

</div>

---

## Why?

Most LLM-plus-documents setups **re-derive knowledge on every query**. RAG finds chunks, the model stitches an answer, nothing is kept. Ten queries against the same docs → ten rediscoveries.

**myco inverts this.** You add a source once. Claude reads it, integrates it into a persistent wiki, flags contradictions against older pages, wires up citations, and commits the result. By query #10 the wiki itself answers — the bookkeeping already happened.

Based on [Andrej Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f). The idea goes back to [Vannevar Bush's 1945 Memex](https://en.wikipedia.org/wiki/Memex), which the project was originally named after.

```
  raw/              Original sources. Immutable.
    │  Ingest
    ▼
  wiki/             Claude-maintained pages. Cited [^src-*], cross-linked.
    │
    ▼
  myco desktop + Obsidian (optional) + your shell / git client
  All see the same files. myco never locks the vault.
```

---

## How it compares

**NotebookLM** is the closest familiar thing: drop sources, ask questions, get
grounded answers. It is very good at that one session. Where it stops:

| Where NotebookLM stops | What myco does instead |
|---|---|
| **Answers stay in the tool.** Take one out and its citations stop pointing at anything you own. | Ingest writes the answer's substance into cited markdown pages in your own folder — `[^src-*]` footnotes resolve to the file sitting in `raw/`. |
| **Every notebook is an island** — nothing carries across them. | One vault, one graph. A new source is merged into the pages that already exist, and claims that conflict with older pages get flagged instead of quietly duplicated. |
| **No page-level citation history** — you cannot ask what a page was built from, or what changed it last night. | Provenance resolves every `[^src-*]` to its source and flags the dangling ones; the run log replays each run file by file — as a word-level diff once vault history is on — and reverts the whole run in one click. |
| **No search across notebooks.** | `⌘K` searches the whole vault at once — `"exact phrase"`, `path:` / `tag:` filters, keyword and semantic results in one list. |
| **Hard per-notebook source caps.** | No cap. Sources are just files; the ceiling is your disk. |

**Versus Obsidian plus an agent plugin**, the files look identical — that is the
point, and myco never locks the vault, so keep Obsidian open on the same folder.
The difference is what you can *review*. The trust surfaces are native here: a run
log that renders an agent's edit as a word-level diff with the revert next to it, an
authorship badge on the page header (share of human vs agent lines, last human touch)
with a human-authored filter in the sidebar, a redaction gate that stops secrets
*before* they can land in immutable `raw/`, and a contradiction queue on the Overview
that settles a disputed page in two clicks. Letting an agent edit your vault is the
easy half; reading, attributing and undoing what it did is the half that has to be
built in.

**Flashcards that are actually scheduled.** Generating cards is table stakes —
NotebookLM does it too. myco *schedules* them: FSRS state lives in the deck's plain
markdown and round-trips with Obsidian's spaced-repetition plugin, so cards come due
on a real curve instead of being a one-off study aid you export and forget.

---

## Install

Grab the bundle for your platform from the
**[latest release](https://github.com/cmblir/Memex/releases/latest)**:

- **macOS** (Apple Silicon): `myco_x.y.z_aarch64.dmg` — unsigned; Gatekeeper
  warns on first open (right-click the app → **Open** → **Open**, or
  **System Settings → Privacy & Security → "Open Anyway"**).
- **Windows x64**: `myco_x.y.z_x64-setup.exe` — unsigned; SmartScreen warns on
  first launch (**More info → Run anyway**).

On first launch myco creates `~/Documents/myco/` seeded with maintenance rules
(`CLAUDE.md`), `raw/`, `wiki/` (interconnected starter notes so the Graph is
populated on day one — delete them anytime), `daily/`, and `ingest-reports/`.
To use a different folder (e.g. an existing Obsidian vault):
Settings → Account → Change…

---

## Screenshots

<p align="center">
<img src="docs/screenshots/mesh.gif" width="100%" alt="The myco 3D cosmic-web graph slowly auto-orbiting" />
</p>

<table>
<tr>
<td width="50%"><img src="docs/screenshots/overview.png" alt="Overview — vault stats, jump-back cards, recent activity" /></td>
<td width="50%"><img src="docs/screenshots/provenance.png" alt="Provenance — per-page citation coverage" /></td>
</tr>
<tr>
<td align="center"><sub><strong>Overview</strong> — stats, jump-back, recent activity</sub></td>
<td align="center"><sub><strong>Provenance</strong> — citation coverage per page</sub></td>
</tr>
<tr>
<td width="50%"><img src="docs/screenshots/reader.png" alt="Reader — CodeMirror source, live markdown preview, backlinks" /></td>
<td width="50%"><img src="docs/screenshots/settings.png" alt="Settings — per-task provider + model pickers" /></td>
</tr>
<tr>
<td align="center"><sub><strong>Reader</strong> — source / split / preview + backlinks</sub></td>
<td align="center"><sub><strong>Settings</strong> — separate Query / Ingest models</sub></td>
</tr>
<!-- TODO(owner): trust-surface screenshots — run log word-diff + authorship badge
     go here as a third row; both need a headed capture on a real vault. -->
</table>

---

## Features

**Ingest** — drop a file or paste text; it lands in `raw/` and the active model
integrates it into `wiki/` with citations, a log entry, and a WHY report.
Inputs are multimodal: PDF, Office docs, spreadsheets, images (vision
provider), audio/video (built-in speech recognition), YouTube URLs. A bundled
offline embedding index (e5-small-ko, in-process llama.cpp) powers semantic search
and per-page Related notes.

**Ask & Agent mode** — chat over your wiki with any connected model. Agent
mode turns a tool-capable provider into an autonomous researcher: it searches,
reads pages, traverses links, and answers with citations; optional write tools
are confirmed per call and never touch `raw/`. Audio overview renders an
answer's cited pages as a two-host spoken deep-dive, offline.

**Graph** — the whole vault as a 3D cosmic web (three.js + d3-force-3d).
Louvain communities get hues and auto-named cluster labels, hubs bloom, orphans
and ghost links show like Obsidian. Drag stars (the sim re-heats), isolate
neighbourhoods, light shortest paths, play a timelapse of the vault building
itself. Alternative layout engines include a static 2D atlas and a grown
mycelium mat. 60 fps to ~10k nodes.

**Study** — generate flashcards from any page; plain-markdown decks with FSRS
scheduling that round-trip with Obsidian's spaced-repetition plugin. Review due
cards and generated quizzes in-app.

**Tasks** — every `- [ ] …` checkbox in the vault in one place: a list, a
kanban board whose columns are the checkbox marks themselves, and a month
calendar where a task with a start and a due draws as a bar across its days.
Click one to open a panel for its dates, priority, estimate and repeat rule,
written back as Obsidian Tasks' own markers (`🛫 ⏳ 📅 ✅ 🔁`) so the line still
works in that plugin; completing a recurring task writes its next occurrence.
A generated `wiki/tasks/<YYYY-MM>.md` per month puts the schedule in the graph
next to the projects its tasks link to. Adding a task can carry a category
(`#tag`, suggested from your existing tags), a project (`[[page]]`), and a
target note — today's daily or a roadmap. A roadmap is a page
(`wiki/roadmaps/<slug>.md`, milestones + checkboxes) with its own Tasks tab
showing per-milestone progress; coding sessions read, check off and extend it
over MCP (`list_tasks`, `set_task_status`, `add_task`).

**Schedules** — recurring digests: a standing query, "what changed", staleness
sweeps, topic trackers. Each run writes a cited markdown note into `digests/`.

**Distillation** — an idle-time housekeeping pass scores new raw/session
inflow against the wiki's topic clusters: junk is filtered before it costs an
embedding, near-duplicate or off-topic items are quarantined then trashed, and
raw sources already folded into the wiki move to a dated archive. Review its
proposals on the Feedback page; tune intensity, gate strictness, and schedule
from Settings. It also compresses in three layers — a day's session logs into
`daily/`, a settled week's daily digests into `weekly/`, and a settled month's
weekly rollups into `monthly/`, each layer's source moving to a cold archive
once summarised — drafts topic maps for its
clusters, and, with an optional profile, personalises Ask and ingest toward
your stated role and interests.

**Run log & undo** — distill and ingest runs are listed newest-first with what
each one moved, created and trashed. Open one for per-file rows and, once vault
history is on, a word-level diff of exactly which words changed. *Undo this run*
replays the run's manifest backwards — un-trash, un-move, remove created pages —
with or without git; content a run rewrote in place is shown by the diff rather
than rolled back.

**Authorship** — turn on vault history and agent commits get their own author,
so a page header can show the human/agent split of its lines and the last human
touch, and the sidebar can hide every page the agent has ever committed. It is
forward-only and says so: no history means no badge. myco never guesses who
wrote a line.

**Resurfacing & ritual** — after a distill run, myco embeds the day's note and
looks for wiki pages you haven't opened in a month whose content resonates with
it. One or two arrive as *today's reunions* on the Overview, each with the
snippet that made the match, beside the review cards that are due. Open, snooze
a week, or ignore — the similarity floor tunes itself to how often you accept.

**Redaction & audit** — nothing reaches immutable `raw/` unscanned. Anything
shaped like a key (AWS, `sk-`, GitHub, Slack, Google, PEM blocks) blocks the
write: the inbox pass, promotion out of `_inbox/`, conversation import, the
headless daemon, and both MCP servers all scan before they write. Email, phone
and resident numbers warn by default, with a quarantine mode in Settings for
stricter vaults. A read-only audit card rescans all of `raw/` — and the git
history behind it — reporting which patterns it found without touching a file.

**Time-anchored Ask** — ask "what did I decide last week" and the window is
parsed out of the question (EN / 한국어 / 日本語: today, last week, a named
month, an explicit date), then local retrieval is restricted to sources actually
dated inside it — daily notes, sessions, weekly and monthly rollups — ties
broken by recency. The answer shows the window it used and says so plainly when
nothing in it matched. On an external provider the range rides along as an
instruction, not a filter.

**Voice capture** — `⌥M` in Spotlight or on the notch records, Enter saves: the
transcript lands in `_inbox/` for the normal ingest pipeline to pick up. Speech
recognition is built in — myco ships whisper.cpp and fetches its model (~190 MB)
once, on your first recording, showing the progress on the capture surface.
Nothing to install, and the audio never leaves the machine. A `whisper` already
on your PATH is used instead, if you have one you prefer.

**Reader** — CodeMirror source / live preview / split, `[[wikilink]]`
autocomplete, `/` blocks, ⌘F find/replace, image paste into `assets/`, a click-to-jump outline pane, backlinks and Related notes panels. Live editing (the default)
renders headings, bullets, task checkboxes and links in place and shows the
raw markdown only on the caret line; ⌘-click opens a wikilink. Frontmatter is a
**Properties** form above the editor — dropdowns for `type` / `status` /
`confidence`, a number for `source_count`, chips for `tags`, key/value rows
for the rest; each change is one undoable edit to the YAML block only.
`raw/` PDFs open in an
in-app pdf.js viewer: select text → highlight & cite mints a pinpoint link;
highlights live in a sidecar so `raw/` stays immutable.

**Providers** — bundled offline embeddings (no key, no install), Claude Code
CLI (your Pro/Max subscription), Anthropic / OpenAI / Google AI / OpenRouter
APIs, and local Ollama. Separate model pick for Query vs Ingest, monthly cost
budget. API keys go to the OS keychain — never plaintext on disk.

**Portable settings** — Settings → About → Export/Import bundles providers,
automation toggles, appearance and graph looks into one JSON file, so moving
to a new machine doesn't mean re-clicking through every tab. API keys, the
vault path and this device's identity never leave. An import names the
sections it will replace before it touches anything, and can be undone for
the rest of the session. Saved Views are not in the bundle because they live
in the vault itself (`.myco/views/*.json`, beside the dashboards) and travel
with it.

**Notch drop surface** *(macOS, opt-in)* — a quiet drop target living under
the MacBook notch. Drag a file at the top of the screen: the surface unfolds,
the drop lands in `_inbox/`, ingest picks it up, and the panel folds back on
its own. Sits above the menu bar without ever stealing focus; Macs without a
notch get the same surface as a small menu-bar pill. Settings → Model →
"Notch drop surface".

**Web clipper** — browser extension + bookmarklet (`clipper/`) that sends any
page or selection into the vault inbox via a deep link.

`⌘K` command palette (files, routes, full-text + semantic), EN / 한국어 / 日本語
UI, light/dark, responsive to 320px.

---

## MCP server

Use the same vault from Claude Desktop, Claude Code, or any MCP client.

**Easiest path — the app hosts it.** The desktop app runs the MCP server
in-process (no Python needed). Open **Settings → MCP** → **Connect to Claude
Code**. The server follows whichever vault the app has open; the token
persists, so you connect once.

<details>
<summary><b>Standalone Python server (from-source / non-app clients)</b></summary>

Requires Python 3.10+ (stdlib-only runtime).

```bash
bash mcp-server/install.sh            # creates mcp-server/.venv
bash mcp-server/serve.sh              # serves http://127.0.0.1:22360/sse
claude mcp add --transport sse myco http://localhost:22360/sse
```

Or stdio for Claude Desktop — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "myco": {
      "command": "<repo>/mcp-server/.venv/bin/python",
      "args": ["<repo>/mcp-server/myco_mcp.py"]
    }
  }
}
```

28 tools: read (`list_pages` `read_page` `search` `folder_tree` …), write
(`add_raw_source` `create_page` `update_page` `git_commit` …), inbox, no-LLM
quality checks (`lint_citations` `trust_report` `contradictions` …), and
multi-project governance (`resolve_cross_links` `export_project`
`register_vault` …). The standalone server manages multiple independent wikis
under `projects/<slug>/`, each with its own `wiki/ raw/ CLAUDE.md`.

</details>

---

## Build from source

Prerequisites: Node 20+, Rust 1.77+, and the
[Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.
Clone with Git LFS (the bundled embedding model is stored in LFS).

```bash
cd app
npm install
npm run tauri dev       # hot-reload dev window
npm run tauri build     # release bundle in src-tauri/target/release/bundle/
```

Tests and lint:

```bash
cd app && npm run lint && npx tsc -b && npx vitest run
cd app/src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

See [`app/README.md`](app/README.md) for the development guide and
[`docs/SIGNING.md`](docs/SIGNING.md) for the release/signing process.
Issues and PRs welcome.

---

## Star History

<a href="https://www.star-history.com/?repos=cmblir/Memex&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=cmblir/Memex&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=cmblir/Memex&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=cmblir/Memex&type=date&legend=top-left" />
 </picture>
</a>

---

## Credits

- **Pattern**: [Andrej Karpathy](https://github.com/karpathy) — *[LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)*.
- **Ancestor**: [Vannevar Bush, "As We May Think"](https://en.wikipedia.org/wiki/As_We_May_Think), 1945.
- **Built with**: [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

---

<div align="center">
<br/>
<sub>MIT License · <a href="README-ko.md">한국어 README</a> · <a href="app/README.md">Desktop app docs</a></sub>
</div>
