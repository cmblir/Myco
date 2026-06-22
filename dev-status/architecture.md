---
title: "Memex — Architecture"
type: dev-status-architecture
project: memex-app
updated: 2026-06-15
---

# Memex — Architecture

System map of the Memex desktop app. Back to [[index]] · stages in [[roadmap]].

## Stack

| Layer | Tech |
|-------|------|
| Shell | **Tauri 2.11** (Rust core + platform webview — WKWebView on macOS). NOT Electron. |
| Frontend | **React 18.3** + **TypeScript** (strict), **Vite 5.4**, **Zustand 4.5** state |
| Editor | **CodeMirror 6** (source mode) · **markdown-it 14** (preview/render) |
| Graph | **three.js 0.184** + **d3-force-3d 3.0** (3D universe) · graphology + Louvain (data/communities) |
| Backend | **Rust** (`src-tauri/`) — ~4.8k LOC, 17 modules, 32 `#[tauri::command]`s |
| AI | 3 CLI bridges (Claude streaming, Gemini, Codex) + 5 HTTP adapters (Anthropic/OpenAI/Google/OpenRouter/Ollama) |
| Secrets | OS keychain (apple/windows/linux) via `secrets.rs` |
| Build | `tsc -b && vite build` → Tauri bundle → **.dmg / nsis** |

Frontend ~11.5k LOC TS/TSX · Backend ~4.8k LOC Rust.

## Module map

**Frontend (`app/src/`)**
- `pages/` — 8 route views: Overview, Ingest, Query, Graph, History, Provenance, Settings, Reader
- `components/` — Sidebar, Topbar, CommandBar (⌘K), DialogHost, Editor, Viewer, GraphControls, IngestProgress, MiniGalaxy, BacklinksPanel, NodePreview, OllamaSetup
- `stores/` — Zustand: `vaultStore` (vault/files/adjacency), `ingestStore` (streaming run), `uiStore` (route/theme/lang, persisted), `settingsStore`, `dialogStore`, `lintStore`
- `lib/` — `ipc.ts` (typed Tauri invoke wrappers), `graph*` (scene/sim/data/theme/settings — the 3D graph), `chat.ts`, `markdown.ts`, `wikilinks.ts`, `i18n.ts` (en/ko/ja), `devMock.ts`

**Backend (`app/src-tauri/src/`)**
- `vault.rs` · `parser.rs` (wikilinks→adjacency) · `index.rs` · `provenance.rs` · `git_log.rs` · `sample_vault.rs`
- `providers.rs` · `claude.rs` (streaming tool-loop) · `cli_agent.rs` · `ollama.rs` · `secrets.rs` · `settings.rs`
- `mcp_server.rs` (stdio registration) · `commands.rs` · `lib.rs` (command registration + setup) · `main.rs`

## Data flow

```
Rust vault.rs ──invoke──▶ ipc.ts ──▶ vaultStore {currentVault, fileTree, adjacency}
                                              │
        ┌─────────────────────────────────────┼───────────────────────────┐
        ▼                                       ▼                           ▼
   PageReader (CodeMirror)              PageGraph                     PageQuery / PageIngest
   edit → ipc.writeFile            buildGraph(adjacency)             chat.ts → Claude CLI
                                   → graphSim (d3-force-3d)          stream-json events
                                   → graphScene (three.js)           → ingestStore → vault refresh
```

**Ingest pipeline:** PageIngest → `ingestStore.startIngest()` → Rust `claude_run_stream` (tool-loop writes wiki pages) → stream-json events → live progress + debounced link-graph rescan → graph live-grows.

**Graph pipeline:** `vaultStore.adjacency` → `buildGraph()` (graphology + Louvain colors + 3D seed) → `createSim()` (d3-force-3d) → tick writes x/y/z → `GraphScene` (Points glow shader + bloom + CSS2D labels) renders. Settings/filters re-run build; force sliders re-tune in place.

## Build & bundle

- `npm run build` → `tsc -b && vite build`. The 3D graph (three.js ~153KB gzip) is **lazy-loaded** as a separate `PageGraph` chunk, kept out of the initial bundle.
- `npx tauri build --bundles dmg` → unsigned `.dmg` (arm64). No code-signing identity configured.
- Dev QA: `scripts/verify-graph.mjs` — Playwright harness with mocked Tauri IPC, 3-viewport screenshots + WebGL/timelapse/brightness probes.

## Conventions

- TS strict, `noUnusedLocals/Parameters`, ESLint + Prettier.
- i18n: every user string keyed (en/ko/ja); no hardcoded UI text (a few stragglers remain — see [[index]] risks).
- Errors: Rust `Result`-based with rich messages; frontend stores catch + surface via status chips.
- Graph state intentionally uses refs (not React state) for per-frame WebGL updates.
