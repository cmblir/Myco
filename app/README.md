# Memex

A cross-platform desktop wiki app for plain markdown vaults. Built with
Tauri 2 + React 18 + TypeScript. Ships as a small native bundle (no
Chromium), edits real files on disk, talks to your choice of LLM provider,
and grows a citation-aware knowledge graph as you work.

## What is Memex?

Memex is **one app** that combines four things you'd otherwise stitch
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
- **A built-in offline model** — HyperCLOVA X SEED 0.5B ships inside the
  app and runs in-process (llama.cpp, Metal on Apple silicon). Zero setup,
  no key, works offline — for classification and light queries; use a
  cloud provider for high-quality ingest.
- **A vault you own** — everything is plain markdown on disk. Open the
  folder in Finder, in Obsidian, in Vim — Memex never locks your data.

Memex creates its own vault at `~/Documents/Memex/` on first launch
(scaffolded with `raw/`, `wiki/`, `daily/`, `ingest-reports/` and a
maintenance `CLAUDE.md`). You can point it at any other directory from
Settings → Account.

## Highlights

### Writing

| | |
| --- | --- |
| `[[wikilink]]` autocomplete | Type `[[` in the editor, every file stem in the vault appears in a popup |
| Source / Split / Preview | Three modes in the editor header; preview wraps the live document so wikilinks resolve in real time |
| Save | `⌘S` or automatic 2-second debounce; atomic write (tempfile + rename) so you never see a half-saved file |
| Backlinks | Every page shows inbound links at the bottom |
| Today's note | Sidebar button creates / opens `daily/YYYY-MM-DD.md` |
| Right-click | New note / new folder / rename / delete on any tree node |

### Knowledge wiki

| | |
| --- | --- |
| Ingest | Drop a file or paste raw text → Memex writes `raw/<slug>.md` → invokes the active model with the ingest workflow → Claude reads, summarises, extracts entities/concepts, cross-links existing pages, writes a `wiki/source-<slug>.md` summary, updates `index.md` + `log.md`, and files a WHY report in `ingest-reports/`. **Multimodal inputs:** PDF, plain text, Office documents (`.docx` / `.pptx`, parsed from OOXML), spreadsheets (`.xlsx` / `.xls` / `.ods`), and **YouTube URLs** (transcript fetched from the watch page) all reduce to markdown before ingest |
| Semantic search | A local embedding index over the wiki (bundled SEED model by default, or an opt-in provider) powers meaning-based lookup: the command palette (`⌘K`) surfaces semantic hits, Ask retrieves the top-K relevant pages instead of dumping the whole vault, and the Graph can overlay similarity edges. Reindex from Settings; the index is a plain rebuildable file under the app-data dir |
| Related notes | Every page shows a "Related" panel — the nearest pages by embedding similarity, even when they aren't wikilinked |
| Live ingest progress | With the Claude CLI provider, the run streams in real time (`--output-format stream-json`): a mission-control panel shows the current action, an interactive mini-galaxy of pages touched so far (live d3-force physics — new pages born at the hub, real wikilink edges, drag to tow, hover for path, click for an in-place markdown preview with an open-in-reader button), a scrolling activity feed, read/write counters and elapsed time — plus a **Cancel** button that kills the run. The run lives in a global store, so navigating away doesn't lose it; a Topbar chip keeps showing a spinner + elapsed (click to jump back), then flips to done/failed until you revisit the page. On the Graph page, nodes the run touches glow live — written pages gold, read pages ice blue, newest touch pulsing — and brand-new pages are born into the galaxy mid-run: each write triggers a debounced link rescan whose diff is injected into the live physics, so new stars bud off their neighbours and settle in real time. The tint persists after the run so you can see what changed. When the run finishes, the mission-control panel stays up as the result view — mini galaxy, feed and counters intact — until you start another ingest |
| Ask | Question your wiki; the model answers with citations to vault pages. Answers render as markdown with clickable `[[wikilinks]]`, and every cited page appears in an interactive mini galaxy under the answer (drag, hover, click for an in-place preview) |
| Lint | "Run lint" in Provenance shells the CLAUDE.md checklist (structure / citation / connection / freshness) to the active model and renders a Markdown report. The run lives in a global store — navigate freely while it works; a Topbar chip tracks it and flips to done/failed until you return |
| Provenance | Per-page citation coverage (claim lines vs cited claims); sort by lowest coverage, slider threshold flags below-target pages |
| History | Lists the WHY report each ingest files under `ingest-reports/`, newest first, with an expandable in-place markdown preview and an open-in-reader jump |
| Graph | Full vault link graph rendered as a **3D universe** with **three.js** (WebGL) over a **d3-force-3d** layout (the same force family Obsidian uses: link + many-body + x/y/z + collision), with degree-normalised link strength so leaves hug their hub and clusters drift into separated "dandelions". Glowing star nodes (UnrealBloom + depth fog + drifting starfield), faint filament edges, every note shown including link-less orphans. **Drag to orbit**, scroll to zoom, slow idle auto-rotate; **grabbing a star re-heats the sim** so neighbours follow in 3D and it springs back on release. Right-side drawer mirrors Obsidian's panel: Filters (search, tags, folder, orphans, existing-only), Display (arrows, text fade, node size, link thickness, **brightness**, ▶ play), Forces (center, repel, link, link-distance) each driving a real d3-force-3d param. Hover spotlights the 1-hop neighbourhood, click opens the file. **▶ Timelapse** replays the vault oldest-to-newest by mtime with **live 3D physics** — each star spawns at the hub and shoves its placed neighbours aside as it arrives. The tree + graph **auto-refresh** on external file changes (Obsidian/Finder, finished ingest); drawer + slider state persists to localStorage |

### Learning & research

| | |
| --- | --- |
| Study (flashcards + spaced repetition) | "Make cards" on any page generates flashcards with the LLM stack (offline with the bundled model); cards live as plain markdown in `cards/<deck>.md` (Obsidian-`spaced-repetition` syntax + an FSRS state trailer, so review state round-trips). The **Study** route reviews due cards (front → reveal → grade Again/Hard/Good/Easy → FSRS advances the schedule → saved) and runs generated multiple-choice quizzes; a sidebar badge shows the due count |
| Agent mode | An Ask/Agent toggle on the Ask page. In Agent mode a tool-capable model (Anthropic API or an OpenAI-compatible provider) plans and calls read tools over the vault — search, read pages, traverse links, provenance — streaming a collapsible step trace, then answers with citations. Optional **write tools** (create/update page) are confirmed per call and never touch `raw/`. Reusable **task-agent presets** are saved as portable `agents/<slug>.md` files |
| Audio overview | Turn a set of pages (an answer's cited pages, or a Reader page + its neighbours) into a grounded two-host spoken "deep dive". The dialogue is generated from the pages' markdown (with citations), saved as a transcript in `audio/`, and played back offline via the OS voices (Web Speech API — no bundled engine); click any transcript turn to jump there |
| PDF viewer + highlight backlinks | Open a `raw/` PDF in-app (pdf.js, bundled worker — no network). Select text → "Highlight & cite" mints a colour-coded highlight and inserts a `[[pdf::<stem>#p<page>:<id>]]` pinpoint link into your note; highlights persist in an external sidecar (`wiki/.annotations/<stem>.json`, so `raw/` stays immutable). Click a pinpoint link to open the PDF at that spot; click a highlight to jump to the citing note |
| Schedules (recurring digests) | Define recurring digests (Schedules route): a free query, a "what changed" summary (folds in `git log`), a staleness/maintenance sweep, or a topic tracker. Each runs on a cadence (daily / weekly / monthly / every N hours) while the app is open and writes a plain-markdown note into `digests/`; "Run now" triggers one on demand, with a link to the latest digest |

### Model connections

Settings → Connections lets you connect any combination of:

- **Built-in (offline)** — Powered by HyperCLOVA X. SEED 0.5B bundled in the app, in-process llama.cpp — no install, no key, offline. Model © NAVER Corp., HyperCLOVA X SEED Model License (text ships with the app).
- **Claude Code (CLI)** — uses your Pro/Max subscription. No key needed; just have `claude` on PATH.
- **Anthropic API** — direct `/v1/messages`. Key from console.anthropic.com.
- **OpenAI API** — `/v1/chat/completions`. Live model list fetched from `/v1/models`.
- **Google AI** — `:generateContent` for the Gemini family.
- **Ollama** — local `http://localhost:11434`. Auto-detects installed models.
- **OpenRouter** — `/api/v1/chat/completions`. Live catalog of 80+ models.

API keys go straight to the OS keychain (macOS Keychain Access / Windows
Credential Manager / freedesktop Secret Service) under the service name
`dev.cmblir.memex`. They never touch the disk in plaintext.

Settings → Model gives you separate provider+model dropdowns for the two
tasks Memex performs — **Query** (Ask the wiki) and **Ingest** — so you
can run e.g. Claude Sonnet for ingest and a local Llama for Q&A.

### Interface

- Notion-flavored shell: warm-white light or near-black dark, three
  density modes, custom accent colour.
- Three UI languages: English / 한국어 / 日本語. The model's drafting
  language is independent of the UI.
- `⌘K` command palette (jumps to any route or vault file).
- `⌘B` toggles the sidebar.

## Install

Download a release bundle from the
[latest release](https://github.com/cmblir/Memex/releases/latest):

- macOS (universal — Apple Silicon + Intel): `Memex_0.1.0_universal.dmg`
- Windows x64: `Memex_0.1.0_x64-setup.exe` (NSIS installer)

Mount/run, drag to Applications.

Both installers are **unsigned** for v0.1.0, so the OS warns on first open.
Unblock once:

- macOS (Gatekeeper "unidentified developer"): right-click the app → Open →
  Open; or run `xattr -dr com.apple.quarantine /Applications/Memex.app`; or
  System Settings → Privacy & Security → "Open Anyway".
- Windows (SmartScreen "Windows protected your PC"): click "More info" →
  "Run anyway".

On first launch Memex creates `~/Documents/Memex/` and seeds it with the
canonical layout plus a few interconnected starter notes (LLM concepts) so
the Graph is populated on day one — delete them anytime. To use a different
folder, open Settings → Account → Change…

## Dev

Prerequisites: Node 20+, Rust 1.77+, plus platform-specific Tauri
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
cargo test             # Rust unit + integration tests (66 currently)
```

## Build

```bash
cd app
npm run tauri build
```

Outputs land in `app/src-tauri/target/release/bundle/`:

- `dmg/Memex_x.y.z_aarch64.dmg` — macOS installer (~2.8 MB)
- `nsis/Memex_x.y.z_x64-setup.exe` — Windows installer (when built on Windows)
- `macos/Memex.app/` — raw `.app` bundle

The release profile uses `lto`, `opt-level = "s"`, and `strip = true`.

## Architecture

```
app/
├── src/                       # React 18 + Vite 5 + TypeScript 5
│   ├── App.tsx                # shell wiring, ⌘K/⌘B, theme/density
│   ├── components/
│   │   ├── Sidebar.tsx        # recursive vault tree + context menu
│   │   ├── Topbar.tsx         # breadcrumb, claude status, lang switch
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
│   │   ├── PageHistory.tsx    # git log
│   │   ├── PageProvenance.tsx # citation coverage + lint
│   │   ├── PageSettings.tsx   # 6 sub-tabs
│   │   └── PageReader.tsx     # vault page in source/split/preview
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
    │   ├── main.rs            # entry → memex_lib::run
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
| `ensure_default_vault` | Create `~/Documents/Memex/` with scaffolding if missing |
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

Files on disk are the source of truth. Memex never modifies your files
outside explicit writes. The link graph is derived fresh from the markdown
on every `build_link_graph` call (no cache). Persistent app settings (not
your notes) live at:

- macOS: `~/Library/Application Support/dev.cmblir.memex/settings.json`
- Windows: `%APPDATA%/Memex/settings.json`
- Linux: `~/.config/memex/settings.json`

API keys are in the OS keychain, never in this file or anywhere else.

## License

MIT.
