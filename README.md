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
</table>

---

## Features

**Ingest** — drop a file or paste text; it lands in `raw/` and the active model
integrates it into `wiki/` with citations, a log entry, and a WHY report.
Inputs are multimodal: PDF, Office docs, spreadsheets, images (vision
provider), audio/video (installed `whisper` CLI), YouTube URLs. A bundled
offline embedding index (bge-m3, in-process llama.cpp) powers semantic search
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

**Schedules** — recurring digests: a standing query, "what changed", staleness
sweeps, topic trackers. Each run writes a cited markdown note into `digests/`.

**Distillation** — an idle-time housekeeping pass scores new raw/session
inflow against the wiki's topic clusters: junk is filtered before it costs an
embedding, near-duplicate or off-topic items are quarantined then trashed, and
raw sources already folded into the wiki move to a dated archive. Review its
proposals on the Feedback page; tune intensity, gate strictness, and schedule
from Settings. It also compresses in two layers — a day's session logs into
`daily/`, then a settled week's daily digests into `weekly/`, each layer's
source moving to a cold archive once summarised — drafts topic maps for its
clusters, and, with an optional profile, personalises Ask and ingest toward
your stated role and interests.

**Reader** — CodeMirror source / live preview / split, `[[wikilink]]`
autocomplete, backlinks and Related notes panels. `raw/` PDFs open in an
in-app pdf.js viewer: select text → highlight & cite mints a pinpoint link;
highlights live in a sidecar so `raw/` stays immutable.

**Providers** — bundled offline embeddings (no key, no install), Claude Code
CLI (your Pro/Max subscription), Anthropic / OpenAI / Google AI / OpenRouter
APIs, and local Ollama. Separate model pick for Query vs Ingest, monthly cost
budget. API keys go to the OS keychain — never plaintext on disk.

**Portable settings** — Settings → About → Export/Import bundles providers,
automation toggles, appearance and graph looks into one JSON file, so moving
to a new machine doesn't mean re-clicking through every tab. API keys, the
vault path and this device's identity never leave.

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
