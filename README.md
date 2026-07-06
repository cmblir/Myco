<div align="center">

<br />

<img src="docs/memex-icon.png" width="100" alt="Memex icon" />

<h1>Memex</h1>

<p><strong>A personal knowledge base that writes itself.</strong></p>

<p>
Drop a source. Claude does the bookkeeping.<br/>
Your knowledge compounds — in plain markdown you own.
</p>

<p>
<a href="#install"><img alt="Install" src="https://img.shields.io/badge/install-DMG-111?style=flat-square" /></a>
&nbsp;
<img alt="License" src="https://img.shields.io/badge/license-MIT-111?style=flat-square" />
&nbsp;
<img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-111?style=flat-square" />
&nbsp;
<img alt="Made with Claude Code" src="https://img.shields.io/badge/made%20with-Claude%20Code-111?style=flat-square" />
&nbsp;
<a href="README-ko.md"><img alt="한국어" src="https://img.shields.io/badge/한국어-README-111?style=flat-square" /></a>
</p>

<br />

<p>
<em>"Obsidian is the IDE. Claude is the programmer. The wiki is the codebase."</em>
</p>

<br />

<img src="docs/screenshots/hero-mesh.png" width="100%" alt="Memex knowledge graph — a ~10,000-note vault rendered as a 3D neural mesh of glowing, community-colored stars" />

<sub><em>A real Memex render — ~10,000 notes as a 3D neural mesh. Every note a glowing star, every <code>[[wikilink]]</code> a filament, each community its own colour with a faint dust halo.</em></sub>

</div>

---

## Why?

Most LLM-plus-documents setups **re-derive knowledge on every query**. RAG finds chunks, the model stitches an answer, nothing is kept. Ten queries against the same docs → ten rediscoveries.

**Memex inverts this.** You add a source once. Claude reads it, integrates it into a persistent wiki, flags contradictions against older pages, wires up citations, and commits the result. By query #10 the wiki itself answers — the bookkeeping already happened.

Based on [Andrej Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f). Named for [Vannevar Bush's 1945 Memex](https://en.wikipedia.org/wiki/Memex).

---

## Two surfaces, one wiki

Memex ships as a native desktop app. A second surface exists for programmatic access from another Claude client.

| Surface | What it is | When to use |
|---|---|---|
| **Memex desktop app** (`app/`) | Tauri 2 + React. Ships as a `.dmg` / `.exe`. Bundles its own vault, talks to any of 5 LLM providers (CLI + 4 HTTP APIs + Ollama). | **Default. Use this.** |
| **MCP server** (`mcp-server/`) | 25 tools exposed via the Model Context Protocol. | Drive Memex from Claude Desktop / Claude Code / any MCP client. |

Both share the same vault layout (`raw/ wiki/ daily/ ingest-reports/`) and never lock your data. Plain markdown on disk, always.

---

## Install

### Desktop app (recommended)

Grab the bundle for your platform from the
**[latest release](https://github.com/cmblir/Memex/releases/latest)**:

- **macOS** (universal — Apple Silicon + Intel): `Memex_0.1.0_universal.dmg`
- **Windows x64**: `Memex_0.1.0_x64-setup.exe` (NSIS installer)

Mount/run, drag to Applications.

> [!note] First launch — installers are unsigned for v0.1.0
> Both bundles are **unsigned**, so the OS will warn on first open. This is expected; unblock once:
>
> - **macOS** (Gatekeeper "unidentified developer") — right-click the app → **Open** → **Open**; or run `xattr -dr com.apple.quarantine /Applications/Memex.app`; or go to **System Settings → Privacy & Security → "Open Anyway"**.
> - **Windows** (SmartScreen "Windows protected your PC") — click **More info** → **Run anyway**.

On first launch Memex creates
`~/Documents/Memex/` and seeds it with:

```
~/Documents/Memex/
├── CLAUDE.md            ← maintenance rules for Claude
├── welcome.md           ← onboarding note
├── raw/                 ← drop sources here (immutable)
├── wiki/                ← Claude-maintained pages
│   ├── index.md
│   ├── log.md
│   └── …                ← interconnected starter notes (LLM concepts)
├── daily/               ← daily notes (YYYY-MM-DD.md)
└── ingest-reports/      ← WHY reports per ingest
```

The `wiki/` ships with a small set of interconnected starter notes so the
**Graph** view is populated on first launch — delete them anytime.

To use a different folder (e.g. an existing Obsidian vault), open
Settings → Account → Change…

### MCP server (optional)

Requires Python 3.10+ (stdlib only) and the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code).

```bash
git clone https://github.com/cmblir/memex.git
cd memex
bash mcp-server/install.sh    # MCP server for Claude Desktop/Code
```

---

## Screenshots

<p align="center">
<img src="docs/screenshots/mesh.gif" width="100%" alt="The Memex 3D neural-mesh graph slowly auto-orbiting — glowing community-colored stars, wikilink filaments and faint dust haze" />
<br/>
<sub><em>The Graph view rendering a ~10,000-note vault as a 3D neural mesh — glowing community-colored stars, <code>[[wikilink]]</code> filaments and faint cosmic-dust haze, idling on a slow auto-orbit. Grab any star and the d3-force-3d sim re-heats; its neighbours follow and spring back on release.</em></sub>
</p>

<br/>

<table>
<tr>
<td width="50%"><img src="docs/screenshots/overview.png" alt="Overview — vault stats, jump-back cards, recent git activity" /></td>
<td width="50%"><img src="docs/screenshots/provenance.png" alt="Provenance — per-page citation coverage with a threshold flag and a Run lint button" /></td>
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

> Captured from the app running on a seeded sample vault. A fresh install ships
> ~50 interconnected starter notes (an LLM knowledge map), so the Graph looks
> like this on day one — delete them anytime.

---

## The desktop app

Seven routes in the left sidebar. Cmd/Ctrl-K opens the command palette, Cmd/Ctrl-B toggles the sidebar.

### Overview

Vault stats (file count, resolved wikilinks, ratio), recent git activity, jump-back cards to your most-edited notes.

### Ingest

1. Drop a file or paste raw text → Memex writes it to `raw/<slug>.md`.
2. The active **ingest model** is invoked (Claude CLI by default) with the vault as cwd.
3. Claude reads the source, finds affected wiki pages, writes citations, creates/updates `wiki/source-<slug>.md`, appends `wiki/log.md`, and files an `ingest-reports/<datetime>-<slug>.md` with the WHY.
4. The tree and graph refresh.

### Ask

A chat surface that answers questions about your wiki. The active **query model** runs from the vault root with a preamble nudging it to use Read/Grep tools on `wiki/` first, falling back to `raw/`. Conversation history is preserved per session.

### Graph

Full vault link graph rendered as a **3D neural mesh** with **three.js** (WebGL) over a **d3-force-3d** layout — the same force family Obsidian uses (`forceLink` + `forceManyBody` + `forceX/Y/Z` + collision), with each link's strength normalised by node degree. By default there is **no community-clustering force** (exactly Obsidian's model), so notes spread into one even, organic web rather than a few clumps. Nodes are glowing stars, edges are `[[wikilinks]]` drawn as faint community-colored filaments, and a faint **cosmic-dust haze** hangs around each dense cluster. Node glow is power-law and **hard-capped**, so even an `index`/MOC that links to everything stays a bright star instead of a white blob. **Every note is shown, including link-less orphans**, and unresolved links to not-yet-written notes appear as dim **ghost nodes** — just like Obsidian (toggle *Show orphans* / *Existing files only* in the drawer).

Link resolution matches Obsidian: `[[note]]`, `[[note|alias]]`, `[[note#heading]]`, `![[embeds]]`, and links to non-`.md` files such as Obsidian **Bases** (`[[Table.base]]`) all resolve, so the graph reflects your real link web instead of dropping half of it.

**Drag to orbit** the camera and scroll to zoom (now far enough out to frame even a large, spread vault); the mesh idles with a slow auto-rotate. **Grab a star and the simulation re-heats** — its neighbours follow in 3D and it springs back on release. Glowing nodes (UnrealBloom), depth fog and signal **pulses travelling along the edges** sell the alive, deep-space look, and a **Brightness** slider tunes the glow. The file tree and graph **auto-refresh** when files change outside the app (edits in Obsidian/Finder, or a finished ingest).

A right-side settings drawer (gear icon) mirrors Obsidian's panel:

- **Filters** — live search by filename, tag chips, folder dropdown, toggles for *Show orphans* and *Existing files only*.
- **Display** — *Arrows*, *Text fade threshold*, *Node size*, *Link thickness*, *Brightness*, and a **▶ Play timelapse** button.
- **Forces** — *Center force*, *Repel force*, *Link force*, *Link distance*, and *Cluster force* (0 = even neural mesh ↔ higher = communities contract into separated "galaxies"). Each slider drives a real d3-force-3d parameter.

**Timelapse** (toolbar ▶ or the drawer button) reveals notes oldest-to-newest by file mtime at their settled positions — edges appear as each note connects up, so you watch the graph build itself in the order you actually wrote it. It's a pure reveal (no physics), so it stays smooth on any vault size, and the camera holds steady on the whole graph.

Hover any node to spotlight its 1-hop neighbourhood (the rest dims). Click to open the file. Zoom and pan are smooth (mouse wheel + drag-background); the toolbar offers zoom-in / fit / zoom-out. Drawer state and every slider position persist to localStorage.

### History

Reads `git log` from the vault directory and renders each commit with subject, hash, date, and `+/~` line counts. HEAD is marked. If the vault isn't a git repo yet, an inline tip explains how to `git init`.

### Provenance

Per-page **citation coverage** — total claim lines vs cited claim lines. Sortable by lowest coverage, with a slider threshold that flags pages below target.

**Run lint** sends the CLAUDE.md lint checklist (structure / citation / connection / freshness) to the active query model and renders the Markdown report inline.

### Settings

Six sub-tabs:

- **Account** — current vault path; **Change…** to point at any folder.
- **Model** — separate provider+model dropdowns for **Query** and **Ingest**. Switch a task to a different provider without losing connections to others.
- **Connections** — connect/disconnect any of:
  - **Built-in (offline)** — Powered by HyperCLOVA X. SEED 0.5B ships inside the app (in-process llama.cpp, Metal on Apple silicon). No install, no key, works offline — classification and light queries; pick a cloud provider for high-quality ingest. Model © NAVER Corp., HyperCLOVA X SEED Model License.
  - **Claude Code (CLI)** — uses your Pro/Max subscription. No key required, just `claude` on PATH.
  - **Anthropic API** — direct `/v1/messages`.
  - **OpenAI API** — `/v1/chat/completions`. Live model list via `/v1/models`.
  - **Google AI** — Gemini family via `:generateContent`.
  - **Ollama** — local `http://localhost:11434`. Auto-detects installed models.
  - **OpenRouter** — `/api/v1/chat/completions`. Live catalog of 80+ models.
  
  API keys go straight to the OS keychain (macOS Keychain / Windows Credential Manager / freedesktop Secret Service) under the service name `dev.cmblir.memex`. **Never written to disk in plaintext.**
- **Language** — EN / 한국어 / 日本語 (UI). The drafting language for the model is independent.
- **Appearance** — light / dark / system.
- **About** — version + about text.

### Page reader (any vault file)

Click a file in the sidebar → opens with three modes:

- **Source** — CodeMirror 6 with markdown highlighting, `[[wikilink]]` autocomplete (start typing `[[` and pick from a popup of every note in the vault), `⌘S` to save, 2-second idle autosave.
- **Preview** — markdown-it render with wikilinks as live buttons.
- **Split** — both side by side, edits propagate to the preview live.

A **Backlinks** panel at the bottom lists every note that links here.

Right-click any tree node for **New note / New folder / Rename / Delete**. Cmd-K jumps to any file by stem name.

---

## The pattern

```
   ~/Documents/Memex/    Your vault (or any folder you point Memex at)
     ├─ raw/             Original sources. Immutable.
     │    │
     │    ▼  Ingest page
     ├─ wiki/            Claude-maintained pages.
     │                   Inline citations [^src-*]. Cross-referenced.
     │                   Frontmatter schema (CLAUDE.md per vault).
     ├─ daily/           Daily notes (Today's note button).
     ├─ ingest-reports/  WHY each ingest decided what it decided.
     └─ CLAUDE.md        Maintenance rules Memex seeds on first launch.
     ▼
   Memex desktop + Obsidian (optional) + your shell / git client
   All three see the same files. Memex never locks the vault.
```

- **You**: curate sources, ask questions, draw the boundaries.
- **Claude**: summarise, cross-reference, cite, detect contradictions, commit.
- **The wiki**: compounds with every ingest.

---

## Talk to your wiki from outside the app

The desktop app exposes everything from inside its UI, but you may want the same vault accessible from **Claude Desktop / Claude Code** sessions running elsewhere. That's what the MCP server does.

**Easiest path — let the app do it.** The desktop app **bundles the MCP server and registers it for you**: open **Settings → MCP**, click *Install* (creates a private Python venv in the app's data dir) then *Register* (runs `claude mcp add` for you). The server then **follows whichever vault the app currently has open** — it reads an `active-vault` marker the app rewrites on every vault switch, so changing vaults in the app redirects MCP reads/writes automatically, with no re-registration. The manual steps below are for driving the server from a from-source checkout.

<details>
<summary><b>4-step MCP setup wizard (from source)</b></summary>

#### Step 1 — Install the server

```bash
bash mcp-server/install.sh
```

Creates `mcp-server/.venv` with the `mcp` SDK and prints the absolute paths you'll paste into your client config.

The 14 exposed tools:

| Read-only | Mutating |
|---|---|
| `list_projects` `list_pages` `read_page` `search` `folder_tree` `stats` `recent_log` `list_raw_sources` `get_instructions` | `add_raw_source` `create_page` `update_page` `create_folder` `git_commit` |

#### Step 2 — Pick your client

**Claude Code (terminal CLI):**

```bash
claude mcp add --scope user memex \
  -- "$PWD/mcp-server/.venv/bin/python" "$PWD/mcp-server/memex_mcp.py"
claude mcp list                       # memex should appear
```

**Claude Desktop:**

> ⚠️ Quit Claude Desktop completely first (Cmd+Q on macOS).

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "memex": {
      "command": "/Users/<you>/Memex/mcp-server/.venv/bin/python",
      "args": ["/Users/<you>/Memex/mcp-server/memex_mcp.py"]
    }
  }
}
```

#### Step 3 — Verify

> List my Memex projects.

Claude should call `list_projects` and reply.

#### Step 4 — Pin the schema (optional)

At the start of an ingestion-heavy chat:

> Call `memex.get_instructions` once. From now on treat factual content
> I share as wiki ingestion — write to the wiki with citations, ask
> before creating new pages, commit at the end.

</details>

The MCP server and the Memex desktop app share the same `wiki/` tree, so changes from either surface are immediately visible in the other.

---

## Build from source

### Desktop app

Prerequisites: Node 20+, Rust 1.77+, and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```bash
cd app
npm install
npm run tauri dev       # hot-reload dev window
npm run tauri build     # release bundle in src-tauri/target/release/bundle/
```

See [`app/README.md`](app/README.md) for the full development guide,
architecture diagram, and IPC surface.

### MCP server

Already covered above — no compilation needed, just Python 3.10+.

---

## Multi-project

The MCP server supports multiple independent wikis. Each lives under `projects/<slug>/` with its own `wiki/ raw/ CLAUDE.md .settings.json`.

Templates scaffold `wiki/` subfolders at creation time:

| Template | Default folders |
|---|---|
| `generic` | `sources entities concepts techniques analyses` |
| `llm-research` | `sources models techniques concepts entities benchmarks analyses` |
| `reading-log` | `sources authors ideas quotes reviews` |
| `personal-notes` | `daily topics people projects` |

The desktop app currently focuses on a single vault. To switch vaults, use Settings → Account → Change.

---

## Repository layout

```
app/                       Memex desktop app (Tauri 2 + React)
  src/                       React frontend (TS)
  src-tauri/                 Rust shell + IPC
  README.md                  Desktop app docs
  PLAN.md / PROGRESS.md      Build history
mcp-server/                MCP server (25 tools)
  memex_mcp.py
  project_registry.py        Multi-project resolver
  install.sh
CLAUDE.md                  Root common schema
projects/                  Per-project vaults (MCP)
  <slug>/
    CLAUDE.md
    .settings.json
    wiki/  raw/  ingest-reports/
projects.json              Active project + registry (MCP)
templates/                 Project templates
raw/ wiki/ ...             Legacy single-project mode (still supported)
```

---

## Configuration

### Desktop app

Stored at `~/Library/Application Support/dev.cmblir.memex/settings.json`
(macOS, equivalent path on other OSes). Holds selected provider/model
per task, connection flags, language. **Never stores API keys** — those
are in the OS keychain.

Per-project settings (MCP) live in `projects/<slug>/.settings.json` and
`projects/<slug>/CLAUDE.md`.

---

## Star History

<a href="https://www.star-history.com/?repos=cmblir/memex&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=cmblir/memex&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=cmblir/memex&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=cmblir/memex&type=date&legend=top-left" />
 </picture>
</a>

---

## Keyboard shortcuts

**Desktop app:**
- `⌘K / Ctrl-K` — command palette: jump to any route or vault file by name, and
  full-text search across page contents (matches show the file and matching line)
- `⌘B / Ctrl-B` — toggle sidebar
- `⌘S / Ctrl-S` — save (autosave fires 2s after last edit too)
- `[[` in editor — wikilink autocomplete popup
- Right-click in sidebar — new / rename / delete

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
