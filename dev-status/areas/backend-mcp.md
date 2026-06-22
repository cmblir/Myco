---
title: "Backend — MCP Server & App Wiring (Rust)"
type: dev-status-area
project: memex-app
updated: 2026-06-15
---


# Backend — MCP Server & App Wiring (Rust)

**Maturity: `██████████ 95%`** · back to [[index]]

The Memex app provides in-app facilities for registering the standalone Python MCP server (stdio-based) with local Claude clients. The backend does NOT host an MCP server itself; instead, it helps users install the server's Python venv and surfaces the exact registration command + Desktop config JSON for copying into Claude's config files. The implementation includes path resolution, IPC commands for install/register, and Settings UI integration with i18n support. The actual MCP server (memex_mcp.py) remains a standalone stdio tool with 14 wiki-access functions.

## Features

| | Feature | Stage | Key files | Gaps |
|--|---------|-------|-----------|------|
| ✅ | MCP Server Module (mcp_server.rs) | mvp | `app/src-tauri/src/mcp_server.rs` | — |
| ✅ | IPC Command Wiring (commands.rs + lib.rs) | mvp | `app/src-tauri/src/commands.rs`, `app/src-tauri/src/lib.rs` | — |
| ✅ | Transport & Protocol (stdio) | mvp | `mcp-server/memex_mcp.py`, `app/src-tauri/src/mcp_server.rs` | — |
| ✅ | Tools & Resources Exposed (Python MCP Server) | mvp | `mcp-server/memex_mcp.py`, `mcp-server/README.md` | — |
| ✅ | Settings Panel UI (React, TypeScript) | mvp | `app/src/pages/PageSettings.tsx`, `app/src/lib/ipc.ts` | — |
| ✅ | Internationalization (i18n) | mvp | `app/src/lib/i18n.ts` | — |
| ✅ | App Setup & State (Tauri Builder + CLI Locator) | mvp | `app/src-tauri/src/lib.rs`, `app/src-tauri/src/main.rs` | — |
| ✅ | Error Handling & User Feedback | mvp | `app/src-tauri/src/mcp_server.rs`, `app/src/pages/PageSettings.tsx` | — |
| ✅ | Testing & Verification | mvp | `app/src-tauri/src/mcp_server.rs` | Manual acceptance test (e.g., registering, running claude mcp list, invoking a tool) not automated; requires human verif… |
| ✅ | Dependencies & Cross-Platform Compatibility | mvp | `app/src-tauri/Cargo.toml`, `app/src-tauri/src/claude.rs` | Path construction for Desktop config file (~/Library/Application Support/Claude/…) shown in UI only; not validated progr… |
| ✅ | Scope & Non-Goals | mvp | `docs/superpowers/specs/2026-06-13-mcp-stdio-registration-design.md` | — |
| 🟢 | Settings Persistence | mvp | `app/src-tauri/src/settings.rs`, `app/src/lib/ipc.ts` | — |

## Notes

STRENGTHS: (1) Clean separation — app does NOT host MCP server; stdio registration is delegated to client (Claude). (2) Robust path resolution — handles Finder-minimal PATH via locate_bin + augmented_path (same helpers used for claude CLI spawning). (3) User-friendly error handling — all failures (missing venv, missing claude CLI, install.sh errors) propagate to UI with stderr context. (4) Comprehensive i18n — 12 strings, 3 languages (en/ko/ja). (5) Unit tests for core logic. GAPS: (1) No integration test verifying end-to-end registration (design doc acknowledges this as manual acceptance). (2) Desktop config file path validation not automated (by design — user manually edits ~Library/Application Support/Claude/…). (3) Packaged .app bundle not supported (design doc, line 152) — assumes source-checkout layout; venv in app-data + bundled server would require follow-up. RISKS: (1) Finder PATH issues are historically fragile; locate_bin is well-hardened but depends on login shell availability. (2) install.sh success depends on python3 + pip availability in augmented_path. (3) User must have `claude` CLI installed to register (not auto-installed; optional Register button disabled if missing). DEAD CODE: None visible. MOCKS: Tests use tempdir; no external mocks needed."
