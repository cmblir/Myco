---
title: "Memex — Roadmap & Stages"
type: dev-status-roadmap
project: memex-app
updated: 2026-06-15
---


# Memex — Development Stages

Foundational → advanced. Each stage groups the features that compose it. Back to [[index]].

**Legend** — ✅ done · 🚧 in-progress · ⚪ planned

## 1. ✅ Foundation — Vault, Parsing & Graph Data (Rust)

*Status: done*

Production-grade vault file system: open/scan/CRUD with atomic tempfile writes, YAML frontmatter parsing, regex wikilink parser, stem-resolved link-graph builder, provenance scanner, git-log reader, path-traversal validation, and 50+ interconnected sample notes. Comprehensive Result-based error handling and extensive happy+error-path unit tests; no TODOs/panics in domain code.

**Features:**
- Vault open/scan/CRUD + atomic writes
- Vault scaffold & sample seeding
- Wikilink parser + link-graph builder
- YAML frontmatter + tag extraction
- Provenance scanner
- Git log reader
- Name validation / traversal protection
- IPC command registration (32 commands)

## 2. ✅ Core UI & Navigation (React)

*Status: done*

All 7 main pages plus the file reader rendered and wired to real IPC and Zustand stores: sidebar file tree with context menu, breadcrumb topbar with status chips, ⌘K command palette, dialog host, CodeMirror editor with wikilink autocomplete and autosave, markdown-it renderer, backlinks panel, routing, theming/density/accent, and full en/ko/ja i18n.

**Features:**
- PageOverview
- PageQuery
- PageHistory
- PageReader (CodeMirror)
- Sidebar file tree + context menu
- Command palette (⌘K)
- Topbar breadcrumb + status chips
- Markdown renderer (markdown-it + wikilinks)
- i18n (en/ko/ja)
- Theme/density/accent
- Zustand store architecture

## 3. ✅ Ingest Pipeline (LLM tool-driven wiki writing)

*Status: done*

End-to-end ingest: drag-drop/file-picker/text input feeds the Claude CLI tool-loop; backend streams stream-json events; ingestStore tracks read/write tool calls, debounced live link-graph rescans, and a 6-stage pipeline with run_id cancellation. UI shows a stepper, activity feed, and live mini-galaxy of touched files, plus history reports.

**Features:**
- PageIngest (drop-zone + live progress)
- ingestStore streaming pipeline
- Claude CLI streaming + cancellation
- Stream event parsing (stream-json)
- Store wiring: ingest → vault refresh
- PageHistory (ingest-report list)

## 4. ✅ Graph 3D Universe (three.js + d3-force-3d)

*Status: done*

Recently migrated from sigma.js 2D to a full 3D cosmic graph: custom glow shaders, bloom, fog, starfield, OrbitControls auto-rotate, dandelion force layout, drag-with-3D-physics, hover highlight, timelapse reveal, live-ingest growth with write/read tint+pulse, Louvain community coloring, and WebGL context-loss recovery. Feature-complete in code; rendered output and large-graph performance not yet visually verified.

**Features:**
- 3D rendering core (glow shader/bloom/fog)
- Force layout (d3-force-3d)
- Timelapse reveal
- Live-ingest growth (liveAdd)
- Drag 3D physics + hover highlight
- WebGL context-loss recovery
- Filters + display settings
- Community detection (Louvain)
- PageGraph React orchestration

## 5. ✅ AI Providers & Multi-Model Support

*Status: done*

8 providers: 3 CLI subprocess bridges (Claude streaming/tool-capable; Gemini, Codex blocking) and 5 HTTP adapters (Anthropic/OpenAI/Google/OpenRouter/Ollama) with uniform chat_complete/list_models, token counting, keychain secret storage, settings persistence, robust PATH/login-shell binary location, and Ollama daemon introspection. Streaming exists only for Claude CLI; provider IDs are stringly-typed; wiremock-tested HTTP adapters.

**Features:**
- Claude CLI bridge
- Gemini & Codex CLI bridges
- HTTP provider adapters
- Ollama provider + status
- OS keychain secret storage
- Settings persistence & provider flags
- CLI agent locator
- Provider ID routing
- OllamaSetup UI
- PageSettings provider/model tabs

## 6. ✅ MCP Integration (stdio registration)

*Status: done*

In-app facilities to register the standalone Python MCP server (14 stdio wiki tools, FastMCP) with local Claude clients. Backend deliberately does NOT host MCP; it resolves paths, runs install.sh to build the venv, builds the `claude mcp add` command + Desktop config JSON, and exposes IPC + a Settings panel with copy/install/register and full i18n. Unit-tested path logic; end-to-end registration is manual-acceptance only.

**Features:**
- MCP server module (resolve/install/register)
- MCP IPC commands
- Python MCP server (14 tools)
- MCP Settings panel UI
- MCP i18n (12 keys, 3 langs)

## 7. 🚧 Provenance & Wiki Quality (lint)

*Status: in-progress*

Citation-coverage tooling: backend provenance scanner counts claims vs citations and sorts by ratio; PageProvenance shows per-file coverage bars with a threshold slider; lintStore runs a LINT_PROMPT query (frontmatter/citations/connections/freshness) via the Claude CLI and renders a markdown report. Functional but lint output is not streamed (spinner only), and scanProvenance may be inconsistently wired from the UI per the IPC analysis.

**Features:**
- Provenance scanner (Rust)
- PageProvenance (coverage lint UI)
- lintStore (LINT_PROMPT pipeline)
- chat.ts unified dispatcher

## 8. 🚧 Polish, Wiring Cleanup & Test Hardening

*Status: in-progress*

Remaining work: wire (or remove) the unconnected IPC commands and dead utility exports; finish timelapse play/pause UI plumbing; replace SamplePage's duplicate markdown parser; add HTTP/CLI-agent streaming; i18n-ify remaining hardcoded English labels; add an error boundary; and add automated integration/E2E tests for streaming-cancel, keychain, CLI spawning, MCP registration, and rendered 3D-graph verification.

**Features:**
- Unwired/stub IPC commands (gitLog/scanProvenance/listProviderModels/mcpRegistrationInfo/parseLinks/hasProviderKey)
- Dead exports (parseWikilink/findWikilinks)
- Timelapse play/pause UI plumbing
- SamplePage duplicate parser cleanup
- HTTP/CLI streaming
- Hardcoded English labels → i18n
- Global error boundary
- Integration/E2E test coverage
