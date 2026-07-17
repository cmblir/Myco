---
title: "Memex — Architecture"
type: dev-status-architecture
project: memex-app
---

# Memex — Architecture

A system map of the Memex desktop app: what the pieces are and how a change
travels between them.

> **Scope, deliberately narrow.** This file describes *structure*, not status
> and not progress. It carries no completion percentages, no LOC counts, no
> command/tool counts and no version pins — those rot within weeks and the
> previous version of this directory rotted into confident fiction because of
> them. Versions live in `package.json` / `Cargo.toml`; what shipped lives in
> `app/CHANGELOG.md`; what is tested lives in `app/docs/E2E.md`. Those three are
> the source of truth. If you catch yourself adding a number here, put it in one
> of them instead.

## Stack

| Layer | Tech |
|-------|------|
| Shell | **Tauri 2** — Rust core + the platform webview (WKWebView on macOS). Not Electron. |
| Frontend | **React** + **TypeScript** (strict), **Vite**, **Zustand** for state |
| Editor | **CodeMirror 6** (source) · **markdown-it** (preview) |
| Graph | **three.js** + **d3-force-3d** (the 3D universe) · graphology + Louvain (data, communities) |
| Backend | **Rust**, in `app/src-tauri/src/` |
| Local AI | **llama-cpp-2** + a bundled Gemma GGUF — query and embeddings run on-device |
| Remote AI | CLI bridges (Claude streaming, Gemini, Codex) + HTTP adapters (Anthropic/OpenAI/Google/OpenRouter/Ollama) |
| Secrets | the OS keychain, via `secrets.rs` |
| Build | `tsc -b && vite build` → Tauri bundle → `.dmg` / nsis |

## The vault is the product

A vault is a **plain directory of markdown**, not a database. Everything else is
derived and disposable:

```
<vault>/
  wiki/            the knowledge base — the only thing that really matters
  raw/             ingested sources. IMMUTABLE: read-only, never modified.
  _inbox/          drop zone for auto-ingest; consumed sources are archived
  daily/           daily notes
  ingest-reports/  what each run did
  CLAUDE.md        the vault's own instructions to the model
```

`raw/` immutability is enforced in `vault::is_raw_path` and honoured by both
`agent_tools.rs` and the backlink rewriter. It outranks every other rule.

The link graph, the vector index and the communities are all rebuilt from the
markdown. Delete them and nothing is lost but time. This is the portability
pitch: the vault opens in Obsidian, or in a text editor, forever.

## Module map

**Frontend — `app/src/`**

- `pages/` — one per route: Overview, Ingest, Query, Graph, Reader, History,
  Provenance, Tags, Views, Study, Schedules, Settings.
- `components/` — Sidebar, Topbar, CommandBar (⌘K), DialogHost, Editor, Viewer,
  GraphControls, MultiverseScene, MascotClip, and the panels.
- `stores/` — Zustand, one per long-lived concern. `vaultStore` (vault, files,
  adjacency) and `uiStore` (route, theme, lang; persisted) are the two most
  things depend on. Runs that must survive navigation get their own store —
  `ingestStore`, `lintStore`, `reindexStore`, `agentStore` — each with a
  re-entry guard and listeners scoped to the run, never to a component.
- `lib/` — `ipc.ts` (the typed `invoke` wrappers; the only place the frontend
  names a command), `graph*` (scene/sim/data/theme/settings), `chat.ts`,
  `markdown.ts`, `wikilinks.ts`, `i18n.ts`, `devMock.ts`.

**Backend — `app/src-tauri/src/`**

- Vault + derivation: `vault.rs`, `parser.rs` (wikilinks → adjacency),
  `index.rs`, `provenance.rs`, `git_log.rs`, `registry.rs`, `sample_vault.rs`
- Local AI: `local_llm.rs`, `embeddings.rs`, `vector_index.rs` (the binary
  `.mxv` store + cache), `perf.rs`
- Remote AI: `providers.rs`, `claude.rs` (streaming tool loop), `cli_agent.rs`,
  `ollama.rs`, `agent_tools.rs`
- Extraction: `extract.rs`, `whisper.rs`, `youtube.rs`, `clip.rs`
- Plumbing: `commands.rs` (the IPC surface), `settings.rs`, `secrets.rs`,
  `schedules.rs`, `mcp_server.rs`, `memex_pro.rs`, `lib.rs` (registration), `main.rs`

**MCP — `mcp-server/memex_mcp.py`**

A standalone Python FastMCP server, registered with Claude clients from within
the app (`mcp_server.rs`). It shares `projects.json` with the Rust side and
reaches the same vault through the same rules. Its SSE transport requires a
bearer token minted per app launch.

**Automation — `automation/`**

`autoingest.py`, a standalone daemon watching `_inbox/`. Note it *archives* a
consumed source to `_inbox/.archived/`, where the app's in-process pass
(`app/src/lib/autoIngest.ts`) deletes it — a known divergence, not a design.

## Data flow

**Opening a vault.** `openVault` → Rust walks the tree (non-following: symlinks
are skipped, `vault::vault_entries`) → `build_link_graph` parses every wikilink
into an `Adjacency` → `vaultStore` holds it → the graph, Views, Tags and the
palette all read from that one object.

**Keeping it fresh.** A poll asks for `vault_revision` — a stat-only hash over
(relpath, mtime, len). Only when it moves is the graph rebuilt. This is the
difference between a background poll costing ~50 ms and ~2 s.

**Ingest.** A source lands in `raw/` → the model runs with the vault as cwd and
the vault's `CLAUDE.md` as its instructions → it writes into `wiki/` through
`agent_tools.rs` (which refuses `raw/`) → the adjacency rebuilds → the graph
grows on screen. `claude_run_stream` emits `claude-stream` events; `ingestStore`
subscribes for the life of the run.

**Ask.** The question is embedded on-device → `semantic_search` over the `.mxv`
vectors → the top pages, bounded by a context budget, are concatenated → the
model answers. With no index it degrades to the whole vault, and the UI says so
rather than pretending it retrieved.

**The graph.** `adjacency` → `buildGraph` (graphology, Louvain communities) →
`GraphScene` (three.js) with positions from a `graphSim` worker (d3-force-3d),
or pre-baked for the static layouts. The render loop is **continuous by
intent** — it drives the living-galaxy animation. Do not "optimise" it to idle.

## Conventions that are load-bearing

- **`ipc.ts` is the only door.** The frontend never calls `invoke` directly;
  `devMock.parity.test.ts` pins `lib.rs` ↔ `ipc.ts` ↔ `devMock.ts` so the three
  cannot drift.
- **The mock must lie as little as possible.** `devMock` paces its responses to
  measured latencies and *rejects* unknown commands, because every time it got
  more honest it exposed a real bug.
- **Long IPC work is `async` + `spawn_blocking`.** A sync `#[tauri::command]`
  body runs on the platform event loop and freezes the window.
- **UI copy goes through `i18n.ts`.** The default language is Korean; an English
  literal in JSX is a bug a Korean user sees on install.
