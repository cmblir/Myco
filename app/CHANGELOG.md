# Changelog

All notable changes to Memex are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security audit hardening

A full multi-agent security review of the codebase produced these fixes (each
finding was adversarially re-verified against the source):

- **Ingest no longer pre-authorizes the agent's `Bash` tool.** The Claude CLI
  ingest reads untrusted `raw/` source content in non-interactive `--print`
  mode, so the default tool set is now `Read,Write,Edit,Glob,Grep` — a
  prompt-injection payload in a source can no longer reach a shell.
  `MEMEX_CLAUDE_TOOLS` still overrides it.
- **PDF / spreadsheet parsing is isolated in a child process.** pdf-extract and
  calamine run on untrusted bytes under `panic = "abort"`; a parser panic/OOM
  used to crash the whole app. `read_external_text` now parses via
  `memex --extract-text <path>`, so a crash/timeout becomes a normal error. The
  extracted output is capped and the cell walk bounded (xlsx zip-bomb defence).
- **`read_file` rejects pathologically deep YAML frontmatter** before parsing
  (and `pod_to_json` caps recursion), so adversarial nesting can't overflow the
  stack; large files are size-guarded.
- **HTTP provider clients no longer follow redirects** (the `x-api-key` /
  `x-goog-api-key` headers can't be replayed to another host), and a
  `MEMEX_*_URL` override now requires https except for loopback hosts, so a
  plaintext-http override can't leak a key in cleartext.
- **The read-only vault scanners** (`list_files`, `file_mtimes`,
  `read_vault_context`, `build_link_graph`, `scan_provenance`, `git_log`) are
  confined to the open vault root like the mutating commands, and skip files
  over 2 MB.
- **MCP `create_page` / `list_pages` confine the `folder` argument** and the
  project registry validates each `slug`, so neither can escape `wiki/` or
  `projects/` via `..` / an absolute path.
- **CSP `img-src` no longer allows bare `https:`**, so a vault note can't beacon
  to a remote host on render (local/embedded/vault images still load).
- **The autosave flush on navigation** compares against a component-local
  baseline, so a rename/interleaved open can't drop keystrokes typed in the
  debounce window.
- Provenance coverage no longer counts footnote-definition lines as claims (it
  was inflating every page toward 100%).
- CI now runs `cargo audit` + `npm audit` (shipped deps) and Dependabot watches
  cargo/npm/actions; markdown-it bumped to 14.2.0 (smartquotes-DoS advisory).

### Security & robustness

- **Content-Security-Policy is now enabled** (was `null`). The policy restricts
  the webview to self-hosted code plus the exact runtime dependencies the app
  needs — Tauri IPC, the asset protocol, the bundled sim Web Worker, inline
  styles, the local Ollama daemon fetch, and the Google Fonts it loads — so a
  crafted vault page can no longer pull in arbitrary external resources or
  scripts. Verified in the built desktop app: the vault, styles, fonts, and the
  worker-driven 3D graph all render under the policy.
- Provider base URLs from `MEMEX_*_URL` env overrides are honoured only when
  they are http(s), falling back to the production URL otherwise (SSRF guard).
- The MCP server's `git_commit` aborts with an error if `git add` fails instead
  of silently committing a stale/partial staging set.
- HTTP provider responses are now size-capped (32 MB) so a hostile/buggy
  endpoint can't OOM the app, and chat calls retry transient failures
  (network error / 429 / 5xx) with backoff — without retrying 4xx auth errors.
- `open_external` now only launches http(s)/mailto URLs or existing local
  paths, rejecting arbitrary schemes (javascript:, data:, …).
- `settings.json` and the active-vault marker are written atomically
  (temp + fsync + rename); `write_file` now also fsyncs the parent directory,
  so a crash mid-write can't corrupt or lose them.
- The streaming Claude run writes stdin on a thread concurrent with the stdout
  drain, so a large ingest prompt can no longer deadlock on the stdin pipe.

### Accessibility

- Modal dialogs: `role="dialog"`/`aria-modal` on the dialog (not the backdrop),
  focus moved into the dialog on open and restored on close, a Tab focus trap,
  Escape-to-close, and the previously hardcoded English buttons are translated.
- The ⌘K command palette is navigable with Up/Down arrows (Enter opens the
  selected row).
- The provenance coverage bars no longer signal status by colour alone — each
  shows its percentage and a "below threshold" badge.
- The Ollama setup card is now fully localized (was hardcoded English).

### Performance

- **The 3D graph simulation now runs in a Web Worker**, off the main thread. A
  10k-node settle (and every drag / slider reheat) used to freeze the UI for the
  whole layout — each force tick blocked the thread ~120 ms and the freeze grew
  with node count. The physics is now off-thread; the main thread only applies
  the posted positions. Measured on the 10k-node hero mesh: settle frame rate
  18.7 → **60 fps**, worst main-thread block 137 ms → **25 ms**, and 100 ms+
  freezes 55 → **0**. The galaxy layout is byte-for-byte identical (same forces).
- Graph nebula centroids are computed in O(nodes) (was O(communities × nodes))
  with cached colours, trimming per-tick cost on large vaults.
- **Graph hover picking is coalesced to one pick per frame** instead of one per
  `pointermove`. Picking projects every node, so on a fast mouse move (100-120
  events/s) it flooded the thread; a 60-move burst now costs ~0.4 ms (was
  hundreds) and hovering an 11k-node graph holds 60 fps.

### Fixed

- **Misleading provider status:** a CLI provider (e.g. the Claude CLI, which is
  enabled by default) showed "Connected" purely from the saved enable flag, so on
  a machine without the CLI installed it claimed to work while ingest/query
  failed. CLI provider cards now reflect the live install check and show
  "CLI not installed" when the binary can't be found.
- The markdown viewer's `[[wikilink]]` parser now matches the same links as the
  graph/backlinks parser (e.g. `[[a]b]]` is consistently a non-link), so the
  rendered page and the graph no longer disagree about whether a link exists.
- Settings writes that fail on disk now surface an error instead of silently
  desyncing the UI from what's persisted.
- **Data loss:** editing any page with YAML frontmatter and letting autosave
  fire silently erased the entire frontmatter block. `read_file` now returns the
  full raw document; the editor round-trips it losslessly while the preview
  still hides the frontmatter. Covered by a Rust round-trip regression test.
- **Autosave** could drop the newest keystrokes when navigating right as an
  in-flight save resolved; it now flushes any unsaved edit on navigation.
- **Rename** now rewrites inbound `[[wikilinks]]` vault-wide (alias/section
  preserved), so renaming a note no longer orphans its backlinks and graph edges.
- **Security:** filesystem IPC commands are confined to the open vault root — a
  crafted call can no longer read/write/delete files outside it. The Gemini API
  key now travels in a header instead of the URL, so it can't leak into error
  strings.
- **A11y:** the graph "Show orphans / Existing only / Arrows" toggles are real
  keyboard-operable `<button role="switch">`s instead of unfocusable spans.
- **Agent CLI hangs:** codex/gemini runs now drain stdout/stderr concurrently
  with the stdin write (and reap the child on timeout), so a verbose agent can no
  longer deadlock on its stdout pipe and hang until the 600s timeout.
- **Responsive:** added a <=768px breakpoint — the sidebar becomes an off-canvas
  overlay and columns stack, so nothing overflows horizontally on phones/tablets
  (verified at 375 / 768 / 1280).

### Added

- **Memex Pro provider** (Settings → Connections): a managed ingest option that
  runs a cheap model server-side and applies the returned wiki pages locally —
  no API key or CLI needed. You **sign in with your Memex Pro account** (the one
  created on the website); the app fetches and stores the account's access key
  automatically — no key to copy by hand. The `memex_pro_ingest` command then
  POSTs the vault snapshot and applies the returned file operations through the
  confined `write_file`; `memex_pro_login` / `memex_pro_logout` manage the session.
- **In-app auto-ingest toggle** (Settings → Model): while Memex is open, it
  periodically ingests sources dropped into the vault's `_inbox/` via the
  selected provider (a configurable interval). Complements the headless cron
  daemon; both watch the same `_inbox/`.
- **Scheduled auto-ingest** (`automation/autoingest.py`): drop sources into the
  vault's `_inbox/` and they're ingested into the wiki automatically on a
  schedule (cron / launchd), using your own `claude` CLI. New `raw/<slug>.md`
  files are created (raw/ stays immutable), originals are archived to
  `_inbox/.archived/`, and each pass is logged. The ingest agent runs without
  `Bash` since inbox content is untrusted.
- **MCP inbox tools** (`list_inbox`, `read_inbox_source`, `archive_inbox_source`):
  a terminal-connected Claude can continuously ingest the `_inbox/` backlog using
  its own read/write tools — read a pending source, write the wiki pages with
  citations, then archive it.
- **Choose the Claude CLI model** (Settings → Model): the CLI run now passes
  `--model`, so ingest/query can run on a cheaper model. Defaults to Haiku for
  ingest (high volume) and Sonnet for query.
- **Ingest PDF, XLSX/XLS/ODS, and CSV files** — they're extracted to text
  (pdf-extract / calamine) before ingestion. Scanned/image PDFs report a clear
  "OCR not supported" message.
- **Full-text search** in the ⌘K command palette: matches inside page contents
  now appear alongside name/route matches, each showing the file and the
  matching line. Backed by a new vault-confined `search_vault` command.
- A top-level React error boundary (plus one around the 3D graph) so a render
  throw shows a recoverable card instead of blanking the whole window.
- Frontend unit test suite (vitest): stripFrontmatter, wikilink parsing/escaping,
  graph filter algebra, deterministic seeding, and time formatters.
- `ci.yml` gating eslint, `tsc`, vitest, `cargo fmt`/`clippy`/`test` (Linux and
  Windows) on every push and PR — previously CI only ran on release tags.

## [0.1.0] - 2026-06-21

First public installer release of Memex — a cross-platform desktop wiki for
plain markdown vaults. Supersedes the 2026-05-09 internal MVP build.

### Added

- Prebuilt installers: macOS universal `.dmg` (Apple Silicon + Intel) and
  Windows x64 `.exe` (NSIS), built in CI via `tauri-action`.
- Tauri 2 + React 18 + Vite 5 + TypeScript 5 application shell.
- Vault IPC: `open_vault`, `list_files`, `read_file`, `write_file`
  (atomic via tempfile + rename), `parse_links`, `build_link_graph`.
- Sidebar with collapsible folder tree and resizable splitter
  (200–600 px), state persisted to localStorage.
- CodeMirror 6 markdown editor with `⌘S` save and 2 s autosave debounce.
- markdown-it preview with custom `[[wikilink]]` rule rendering
  `<a data-link>` for app-level click resolution.
- Source / Preview / Split (50/50) view-mode toggle.
- Backlinks panel powered by the cached link graph.
- 3D vault Graph view (three.js + d3-force) with tag/folder filters,
  click-to-open, and a growth timelapse.
- Tauri dialog plugin for directory picking; last vault path persisted
  across launches.

### Changed

- The 3D vault Graph now renders as a cohesive galaxy/brain — range-capped
  local repulsion plus Louvain community clustering — instead of the radial
  "firework" explosion. Ships a new `galaxy` default preset and stays usable
  on 10k+ node vaults. (The original MVP graph used Cytoscape.js + fcose.)

### Notes

- Installers are unsigned for this release. macOS Gatekeeper ("unidentified
  developer") and Windows SmartScreen ("Windows protected your PC") warn on
  first launch; right-click → Open (macOS) or More info → Run anyway (Windows)
  to proceed.
