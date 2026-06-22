---
title: "State Management & IPC Bridge"
type: dev-status-area
project: memex-app
updated: 2026-06-15
---


# State Management & IPC Bridge

**Maturity: `████████░░ 78%`** · back to [[index]]

The Memex app uses Zustand for client-side state management with a clear separation of concerns: vaultStore (file tree, active file, link graph), ingestStore (LLM ingest pipeline with streaming), settingsStore (provider configuration), uiStore (layout/theme, localStorage-persisted), and lintStore (wiki quality checks). The ipc.ts module provides 37 type-safe Tauri invoke wrappers with varying wiring: core vault operations fully connected, LLM features (claude/agent/chat) actively used, but some graph/model-introspection APIs remain unconnected to UI pages. The markdown renderer integrates wikilink parsing, dev mock layer is active for visual QA, and streaming events drive live progress during ingest runs.

## Features

| | Feature | Stage | Key files | Gaps |
|--|---------|-------|-----------|------|
| ✅ | vaultStore (File Tree + Active File) | mvp | `src/stores/vaultStore.ts` | — |
| ✅ | ingestStore (LLM Pipeline State) | mvp | `src/stores/ingestStore.ts` | — |
| ✅ | uiStore (Layout & Preferences) | mvp | `src/stores/uiStore.ts` | — |
| ✅ | IPC: Vault Operations (26/37 commands) | mvp | `src/lib/ipc.ts` | — |
| ✅ | IPC: LLM Operations (8/37 commands) | mvp | `src/lib/ipc.ts` | — |
| ✅ | time.ts (Time Formatting) | mvp | `src/lib/time.ts` | — |
| ✅ | sample.ts (Mock Data) | mvp | `src/lib/sample.ts` | — |
| ✅ | Store Wiring: ingestStore → vaultStore Refresh | mvp | `src/stores/ingestStore.ts`, `src/stores/vaultStore.ts` | — |
| 🟢 | settingsStore (Provider Configuration) | mvp | `src/stores/settingsStore.ts` | — |
| 🟢 | lintStore (Wiki Quality Checks) | mvp | `src/stores/lintStore.ts` | — |
| 🟢 | IPC: Provider Integration (6/37 commands) | mvp | `src/lib/ipc.ts` | — |
| 🟢 | chat.ts (Unified LLM Dispatcher) | mvp | `src/lib/chat.ts` | — |
| 🟢 | markdown.ts (Wikilink Rendering) | mvp | `src/lib/markdown.ts` | — |
| 🟢 | devMock.ts (Browser-Based IPC Mock) | infra | `src/lib/devMock.ts` | — |
| 🟢 | Store Wiring: vaultStore → UI Navigation | mvp | `src/stores/vaultStore.ts`, `src/stores/uiStore.ts` | — |
| 🟢 | Store Wiring: Tauri Event Streaming | mvp | `src/stores/ingestStore.ts` | — |
| 🟡 | wikilinks.ts (Link Parsing Utilities) | mvp | `src/lib/wikilinks.ts` | parseWikilink, findWikilinks exported but unused; consider removing or integrate into markdown rendering if future rende… |
| 🔵 | IPC: Unused/Stub Commands (6/37) | infra | `src/lib/ipc.ts` | UI pages (PageOverview for gitLog, PageProvenance for scanProvenance, PageSettings for listProviderModels/mcpRegistratio… |

## Notes

ACTIVE/DEAD CODE FINDINGS: parseWikilink and findWikilinks are exported from wikilinks.ts but never called—candidate for removal or future use. Six IPC commands have stubs (parseLinks, gitLog, scanProvenance, hasProviderKey, listProviderModels, mcpRegistrationInfo) but are only called from comment hooks in PageOverview/PageProvenance/PageSettings, suggesting deferred wiring rather than dead code. devMock.ts is production-safe (tree-shaken when import.meta.env.DEV=false) and enables visual QA with mock=1 query param. settingsStore and lintStore both swallow IPC errors to preserve UI optimism, which is reasonable for non-critical mutations. vaultStore uses localStorage for last-vault caching but catch silently if storage unavailable. ingestStore caps event log to 500 entries (pathological run protection). Race-condition guards (openSeq, refreshSeq) prevent stale async results from overwriting state. No persistence layer for ingestStore (ephemeral runs) or lintStore (ephemeral reports). Type safety is strong across ipc.ts (all invoke calls match Rust sigs per comment). Streaming is frontend-only (Tauri events), non-tool providers fall back to blocking calls with stage-only UI feedback."
