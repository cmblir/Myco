---
title: "Memex — Development Status"
type: dev-status-index
project: memex-app
updated: 2026-06-15
---


# Memex — Development Status

> One-glance progress map of the Memex desktop app (Tauri 2 + React 18 + Rust). Auto-derived from a full codebase analysis on 2026-06-15.

**Overall completion: `████████░░ 85%`**

Memex is a Tauri 2 + React 18 + TypeScript desktop "LLM wiki" app that is functional end-to-end across all its core surfaces. The Rust backend is the most mature layer: vault file CRUD, markdown/wikilink parsing, link-graph building, provenance scanning, and git-log reading are production-grade with comprehensive Result-based error handling and extensive unit tests (vault domain ~95%). On top of it sit 8 LLM providers (3 CLI subprocess bridges + 5 HTTP adapters) with keychain secret storage and settings persistence (~82%), and an in-app stdio MCP registration flow that helps users register the standalone Python MCP server with Claude clients (~95%). The frontend delivers all 7 main pages plus a CodeMirror-based file reader, wired to real IPC, with polished i18n (en/ko/ja), theming, command palette, and a notably detailed ingest-progress experience (~82%). The standout feature is the recently migrated 3D three.js + d3-force-3d "universe" graph with custom glow shaders, bloom, timelapse, and live-ingest growth (~92% by code, though not visually verified). The weakest seam is the state/IPC bridge (~78%): 6 of 37 IPC commands are exported but never invoked from the UI (gitLog, scanProvenance, listProviderModels, mcpRegistrationInfo, parseLinks, hasProviderKey appear as deferred/TODO hooks in some analyses, though other areas report several of these as actively wired — an internal inconsistency worth verifying), and a few utility exports (parseWikilink, findWikilinks) are dead. Honest weighted completion lands at roughly 85%: a robust, tested backend and a working, attractive frontend, with the main gaps being UI-side wiring of a handful of backend capabilities, the absence of HTTP/CLI-agent streaming (only Claude CLI streams), no automated end-to-end/integration tests for streaming-cancel, keychain, CLI spawning, or MCP registration, and the 3D graph being verified by code inspection only (no rendered-output proof, unknown performance at 5000+ nodes).

**Legend** — ✅ complete · 🟢 functional · 🟡 partial · 🔵 stub · ⚪ planned

See also: [[architecture]] · [[roadmap]]

## Areas

| Area | Maturity | Features |
|------|----------|----------|
| [[frontend-ui\|Frontend UI & Pages]] | `████████░░ 82%` | 24 |
| [[graph-3d\|Graph Visualization — 3D Universe]] | `█████████░ 92%` | 26 |
| [[state-ipc\|State Management & IPC Bridge]] | `████████░░ 78%` | 18 |
| [[backend-vault\|Backend — Vault, Parsing & Graph (Rust)]] | `██████████ 95%` | 22 |
| [[backend-ai\|Backend — AI Providers & Agents (Rust)]] | `████████░░ 82%` | 16 |
| [[backend-mcp\|Backend — MCP Server & App Wiring (Rust)]] | `██████████ 95%` | 12 |

## Development stages

| # | Stage | Status |
|---|-------|--------|
| 1 | Foundation — Vault, Parsing & Graph Data (Rust) | ✅ done |
| 2 | Core UI & Navigation (React) | ✅ done |
| 3 | Ingest Pipeline (LLM tool-driven wiki writing) | ✅ done |
| 4 | Graph 3D Universe (three.js + d3-force-3d) | ✅ done |
| 5 | AI Providers & Multi-Model Support | ✅ done |
| 6 | MCP Integration (stdio registration) | ✅ done |
| 7 | Provenance & Wiki Quality (lint) | 🚧 in-progress |
| 8 | Polish, Wiring Cleanup & Test Hardening | 🚧 in-progress |

Full breakdown → [[roadmap]]

## Feature dashboard

| | Feature | Area | Stage |
|--|---------|------|-------|
| ✅ | Vault open/scan/CRUD + atomic writes | Rust Backend — Vault & Parsing | mvp |
| ✅ | Vault scaffold & 50+ sample note seeding | Rust Backend — Vault & Parsing | mvp |
| ✅ | Wikilink parser (regex) + link-graph builder (stem resolution) | Rust Backend — Vault & Parsing | mvp |
| ✅ | YAML frontmatter + tag extraction | Rust Backend — Vault & Parsing | mvp |
| ✅ | Provenance scanner (claim/citation counting) | Rust Backend — Vault & Parsing | mvp |
| ✅ | Git log reader (system git binary) | Rust Backend — Vault & Parsing | mvp |
| ✅ | Name validation / path-traversal protection | Rust Backend — Vault & Parsing | infra |
| ✅ | IPC command registration (32 commands, invoke_handler) | Rust Backend — Vault & Parsing | infra |
| ✅ | Claude CLI bridge (streaming, run_id cancellation) | Rust Backend — AI Providers | mvp |
| 🟢 | Gemini & Codex CLI bridges (blocking, no streaming) | Rust Backend — AI Providers | mvp |
| ✅ | HTTP provider adapters (Anthropic/OpenAI/Google/OpenRouter/Ollama) | Rust Backend — AI Providers | mvp |
| ✅ | Ollama local provider + daemon status introspection | Rust Backend — AI Providers | mvp |
| ✅ | OS keychain secret storage (keyring crate) | Rust Backend — AI Providers | mvp |
| ✅ | Settings persistence & provider flags | Rust Backend — AI Providers | mvp |
| ✅ | CLI agent locator (PATH/login-shell resolution) | Rust Backend — AI Providers | infra |
| ✅ | Stream event parsing (stream-json) | Rust Backend — AI Providers | mvp |
| 🟢 | Provider ID routing (stringly-typed, no enum) | Rust Backend — AI Providers | mvp |
| ✅ | MCP server module (path resolve, install, register) | Rust Backend — MCP Integration | mvp |
| ✅ | MCP IPC commands (registration_info/install/register) | Rust Backend — MCP Integration | mvp |
| ✅ | Python MCP server (14 stdio wiki tools) | Rust Backend — MCP Integration | mvp |
| ✅ | MCP Settings panel UI (install/copy/register) | Rust Backend — MCP Integration | mvp |
| ✅ | 3D rendering core (three.js, glow shader, bloom, fog) | Graph 3D Universe | mvp |
| ✅ | Force layout (d3-force-3d dandelion clusters) | Graph 3D Universe | mvp |
| ✅ | Timelapse reveal (oldest→newest by mtime) | Graph 3D Universe | mvp |
| ✅ | Live-ingest growth (liveAdd with write/read tint+pulse) | Graph 3D Universe | mvp |
| ✅ | Drag with 3D physics + hover neighbourhood highlight | Graph 3D Universe | mvp |
| ✅ | WebGL context-loss recovery (glEpoch rebuild) | Graph 3D Universe | mvp |
| ✅ | Filters (tag/folder/search/orphans) + display settings | Graph 3D Universe | mvp |
| ✅ | Community detection (Louvain coloring) | Graph 3D Universe | polish |
| ✅ | DEV spiral-galaxy hero render (sigma, not bundled) | Graph 3D Universe | experimental |
| ✅ | PageOverview (vault stats, git feed, quick access) | Frontend UI/Pages | mvp |
| 🟢 | PageIngest (drop-zone, live progress, mini galaxy) | Frontend UI/Pages | mvp |
| ✅ | PageQuery (streaming Q&A, cited-page galaxy) | Frontend UI/Pages | mvp |
| 🟢 | PageGraph (React orchestration of 3D scene) | Frontend UI/Pages | polish |
| ✅ | PageHistory (ingest-report list + preview) | Frontend UI/Pages | mvp |
| 🟢 | PageProvenance (citation coverage lint) | Frontend UI/Pages | mvp |
| ✅ | PageSettings (6 tabs: account/model/providers/MCP/lang/appearance) | Frontend UI/Pages | polish |
| ✅ | PageReader (CodeMirror editor, autosave, wikilink autocomplete) | Frontend UI/Pages | polish |
| ✅ | Sidebar file tree + context menu + today's note | Frontend UI/Pages | mvp |
| ✅ | Command palette (⌘K fuzzy nav) | Frontend UI/Pages | mvp |
| ✅ | Markdown renderer (markdown-it + wikilinks) | Frontend UI/Pages | mvp |
| 🟢 | OllamaSetup (install/pull with live progress) | Frontend UI/Pages | polish |
| ✅ | i18n (en/ko/ja, ~140 keys) | Frontend UI/Pages | mvp |
| ✅ | Theme/density/accent (persisted) | Frontend UI/Pages | mvp |
| ✅ | Zustand stores (vault/ingest/settings/ui/lint/dialog) | State & IPC Bridge | mvp |
| ✅ | ingestStore streaming pipeline (claude-stream events) | State & IPC Bridge | mvp |
| 🟢 | chat.ts unified LLM dispatcher (task/provider routing) | State & IPC Bridge | mvp |
| 🟢 | devMock.ts browser IPC mock (visual QA) | State & IPC Bridge | infra |
| 🔵 | Unwired/stub IPC commands (gitLog, scanProvenance, listProviderModels, mcpRegistrationInfo, parseLinks, hasProviderKey) | State & IPC Bridge | infra |
| 🔵 | Dead exports (parseWikilink, findWikilinks) | State & IPC Bridge | infra |
| 🟢 | Error handling / loading states across UI | Frontend UI/Pages | mvp |

## Highlights

- Rust vault/parsing/graph layer is production-grade (~95%): atomic tempfile writes, canonicalized stable-ID paths, deduplicated edge counts, OnceLock-compiled regex, and a full happy+error-path unit test for every public function with no TODOs or panics in domain code.
- 3D 'universe' graph (~92%) is the standout: custom perspective-corrected glow shaders, theme-tuned UnrealBloom, d3-force-3d dandelion clusters, drag-with-3D-physics via raycast plane intersection, multi-phase timelapse, live-ingest growth with gold/ice write/read tints, and WKWebView GL context-loss recovery via epoch rebuild.
- Ingest experience is exceptionally detailed: live stepper + activity feed + mini-galaxy of touched files, driven by real stream-json events from the Claude CLI tool-loop with run_id cancellation and debounced live link-graph rescans.
- Multi-provider backend is broad and well-tested: all 8 declared providers implemented, OS keychain secret storage (apple/windows/linux), wiremock-covered HTTP adapters, and robust Finder/Dock-resilient CLI binary location via env override → which → well-known dirs → login-shell lookup.
- MCP integration is clean and honestly scoped (~95%): app does not host a server but delegates stdio registration to Claude, surfacing the exact `claude mcp add` command + Desktop JSON with copy/install/register UI, full en/ko/ja i18n, and unit-tested path resolution.
- Frontend polish: all 7 pages wired to real IPC, complete en/ko/ja i18n (~140 keys), light/dark/system theming with density and accent, ⌘K command palette, and a CodeMirror reader with wikilink autocomplete, autosave, and Obsidian-style on-click file creation.

## Risks & gaps

- IPC wiring inconsistency: the State/IPC analysis reports 6 commands (gitLog, scanProvenance, hasProviderKey, listProviderModels, mcpRegistrationInfo, parseLinks) as exported-but-never-invoked stubs, yet the Frontend, MCP, and Providers analyses describe several of these (gitLog in PageOverview, scanProvenance in PageProvenance, mcpRegistrationInfo in PageSettings, listProviderModels in model pickers) as actively wired. This contradiction must be verified against the source before trusting either claim.
- Dead code: parseWikilink/findWikilinks (wikilinks.ts) are exported but unused; graphTheme.ts retains unused sigma Settings imports and gxCore/Arm/Halo palette remnants; SamplePage uses a hand-rolled markdown parser that diverges from the real markdown-it Viewer.
- Streaming is Claude-CLI-only: Gemini/Codex CLI agents are blocking (600s timeout) and all 5 HTTP adapters intentionally do not stream — non-Claude providers give stage-only UI feedback with no live token output.
- 3D graph verified by code inspection only — no rendered screenshot/video proof, force-layout stability under drag/resize unconfirmed, and performance unknown at 5000+ nodes (writeNodes loops all nodes every frame; only the non-interactive ~14k-star hero was exercised). Context-loss recovery forces a full rebuild, which is costly if WKWebView backgrounding is frequent.
- Test coverage gaps: no automated integration/E2E tests for streaming cancellation, keychain access, actual CLI invocation, or end-to-end MCP registration (the latter is explicitly manual-acceptance per the design doc).
- Silent error swallowing in several spots: HTTP adapters use unwrap_or_default for missing content (empty string on malformed JSON), ollama.rs returns an empty model list on parse failure, and some frontend catch blocks take no action; no global React error boundary and user-facing messages lack actionable guidance.
- Stringly-typed provider IDs (no Rust enum) allow frontend typos and give no compile-time exhaustiveness check; static Anthropic/Google model catalogs are hand-curated and can drift from live APIs.
- MCP packaging limitation: registration assumes a source-checkout layout and a user-installed `claude` CLI; a packaged .app bundle is not yet supported, and Desktop config path is shown for manual editing rather than validated programmatically.
- Minor parser edge case: unclosed brackets like '[[unclosed and [[ok' resolve to a single link target due to the non-greedy regex — undocumented as a known limitation.
- PageGraph timelapse play/pause UI and some render state use refs rather than React state (appropriate for WebGL but flagged as work-in-progress); Ollama model management is pull-only (no delete/unload); some hardcoded English labels remain un-i18n'd.

## Notes & corrections

> [!note] IPC wiring — verified
> The automated analysis flagged a contradiction: the State/IPC reader (which read `ipc.ts` in isolation) marked `gitLog`, `scanProvenance`, `mcpRegistrationInfo`, `listProviderModels` as unwired stubs, while the page readers saw them used. **Verified against the page code: these ARE wired** — `gitLog`→PageOverview, `scanProvenance`→PageProvenance, `mcpRegistrationInfo`/`mcpInstall`/`mcpRegister`→PageSettings, `listProviderModels`→model pickers. Genuinely dead exports are only `parseWikilink`/`findWikilinks` (wikilinks.ts) and the leftover sigma `buildSigmaSettings`/`nodeProgramSettings` in graphTheme.ts after the 3D migration.
