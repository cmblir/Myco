---
title: "Frontend UI & Pages"
type: dev-status-area
project: memex-app
updated: 2026-06-15
---


# Frontend UI & Pages

**Maturity: `████████░░ 82%`** · back to [[index]]

Memex is a fully functional LLM wiki desktop app with 7 main pages (Overview, Ingest, Query, Graph, History, Provenance, Settings) plus a file reader. All pages are wired to real IPC backends and stores. The UI is polished with proper i18n (en/ko/ja), theme switching (light/dark/system), density modes, and a breadcrumb-based navigation with a sidebar tree, command palette, and topbar status chips. Core features (file editing with CodeMirror, markdown rendering, 3D graph visualization, ingest progress tracking, provenance linting) are functional end-to-end. Some advanced graph features (timelapse, filters) appear partially complete.

## Features

| | Feature | Stage | Key files | Gaps |
|--|---------|-------|-----------|------|
| ✅ | PageOverview (landing page) | mvp | `src/pages/PageOverview.tsx` | — |
| ✅ | PageQuery (LLM Q&A on vault) | mvp | `src/pages/PageQuery.tsx` | — |
| ✅ | PageHistory (ingest run reports) | mvp | `src/pages/PageHistory.tsx` | — |
| ✅ | PageSettings (6 tabs) | polish | `src/pages/PageSettings.tsx` | MCP install/register flow refs Tauri IPC commands but actual desktop.json generation appears incomplete (shows static te… |
| ✅ | PageReader (file editor + preview) | polish | `src/pages/PageReader.tsx` | SamplePage rendering is a manual markdown parser (not markdown-it), only handles basic formatting—mismatch with real Vie… |
| ✅ | Sidebar (file tree + nav) | mvp | `src/components/Sidebar.tsx` | Context menu position absolute to screen (not ideal on scrolled sidebar). No drag-reorder of files. New page button only… |
| ✅ | Topbar (breadcrumb + status) | mvp | `src/components/Topbar.tsx` | — |
| ✅ | CommandBar (fuzzy palette ⌘K) | mvp | `src/components/CommandBar.tsx` | — |
| ✅ | DialogHost (prompt/confirm modals) | mvp | `src/components/DialogHost.tsx` | — |
| ✅ | Editor (CodeMirror 6) | mvp | `src/components/Editor.tsx` | No syntax highlighting beyond markdown; no folding; no search/replace UI (though CodeMirror supports via keymap extensio… |
| ✅ | Viewer (markdown renderer) | mvp | `src/components/Viewer.tsx` | No copy button on code blocks. No dark-mode syntax highlighting config visible. |
| ✅ | BacklinksPanel (inbound link references) | mvp | `src/components/BacklinksPanel.tsx` | — |
| ✅ | NodePreview (in-context file preview) | mvp | `src/components/NodePreview.tsx` | — |
| ✅ | Routing & navigation | mvp | `src/App.tsx`, `src/stores/uiStore.ts` | — |
| ✅ | Theme & appearance | mvp | `src/App.tsx`, `src/stores/uiStore.ts` | Accent color currently hardcoded seed (#181715); picker UI in settings shows all options but actual custom color input n… |
| ✅ | i18n (en/ko/ja) | mvp | `src/lib/i18n.ts` | Some component error messages and labels (e.g., 'Cancel', 'Delete') are hardcoded English; not all i18n keys are used (d… |
| ✅ | Store architecture (state management) | mvp | `src/stores/uiStore.ts`, `src/stores/vaultStore.ts` | No subscription cleanup in some effects (settingsStore.load called but not all hooks have dependency arrays). No optimis… |
| 🟢 | PageIngest (file upload + AI processing) | mvp | `src/pages/PageIngest.tsx`, `src/components/IngestProgress.tsx` | Stepper UI hardcoded to show all 3 steps as not-done on the form side; progress animation in IngestMiniGraph could be mo… |
| 🟢 | PageGraph (3D force-directed graph) | polish | `src/pages/PageGraph.tsx`, `src/components/GraphControls.tsx` | Timelapse UI (play/pause buttons in controls) partially wired but graph settling/animation logic refs suggest work-in-pr… |
| 🟢 | PageProvenance (citation coverage lint) | mvp | `src/pages/PageProvenance.tsx` | Lint runs asynchronously but UI does not show intermediate progress (just spinner + 'running…' text). No live streaming … |
| 🟢 | OllamaSetup (local model provider setup) | polish | `src/components/OllamaSetup.tsx` | Presets are hardcoded; no way to manage existing models (delete, unload). Pull error handling shows error text but no re… |
| 🟢 | MiniGalaxy (3D node cluster visualization) | experimental | `src/components/MiniGalaxy.tsx` | Implementation details not fully reviewed; likely shares some boilerplate with PageGraph but dimensions/styling may diff… |
| 🟢 | Keyboard shortcuts | mvp | `src/App.tsx`, `src/components/Editor.tsx` | No global settings for rebinding. Limited to hardcoded subset (no vim mode, no chord support). |
| 🟢 | Error handling & loading states | mvp | `src/pages/*.tsx`, `src/components/*.tsx` | Some errors silently swallowed (catch with no action). No global error boundary. User-facing error messages lack actiona… |

## Notes

Strengths: All 7 main pages + reader are wired to real IPC backends and function end-to-end. Editor, markdown renderer, wikilink navigation, and file tree are fully polished. Theme/i18n/density settings work smoothly. Ingest progress tracking is exceptionally detailed (live orb, activity feed, file constellation). Query Q&A with galaxy visualization is unique and functional. Settings tabs for provider/MCP setup are comprehensive.  Weaknesses: Graph page (PageGraph.tsx) is partially complete—timelapse playback UI exists but settling/animation refs suggest ongoing work. Some component state management uses refs instead of React state (graph hover, ingest glow). Error messages are generic. MCP setup shows static template, not clear if registration auto-populates desktop.json. Ollama model management is pull-only (no delete/unload UI). Some hardcoded English labels not yet i18n-ified.  Dead code: SamplePage has a duplicated markdown parser (renderInline) that differs from real Viewer (markdown-it).  Architecture: Stores are clean Zustand + localStorage. UI state machine (route, stage) is well-factored. PageGraph is imperative (three.js + d3-force-3d refs), which is appropriate for heavy WebGL workloads but makes that page a bit isolated from the React paradigm.  Tauri integration: Drag-drop, file picker, IPC calls, OS keychain, context-loss recovery—all present and working. No obvious WebView-specific issues beyond documented WKWebView GL context loss handling."
