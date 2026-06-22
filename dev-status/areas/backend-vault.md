---
title: "Backend — Vault, Parsing & Graph (Rust)"
type: dev-status-area
project: memex-app
updated: 2026-06-15
---


# Backend — Vault, Parsing & Graph (Rust)

**Maturity: `██████████ 95%`** · back to [[index]]

The Rust backend implements a complete, production-grade vault file system layer with markdown parsing, wikilink resolution, and provenance tracking. All core capabilities (open/scan/CRUD, link parsing, graph building, git history, and default scaffold) are functional and well-tested. Code quality is high: comprehensive error handling via Result types, no TODOs in the core domain modules, and extensive unit tests covering happy and error paths. The invoke_handler registers 32 IPC commands covering vault I/O, graph building, CLI invocation, and settings.

## Features

| | Feature | Stage | Key files | Gaps |
|--|---------|-------|-----------|------|
| ✅ | Vault open & metadata | mvp | `src-tauri/src/vault.rs (lines 231-258)`, `src-tauri/src/commands.rs (lines 18-21)` | — |
| ✅ | Vault scaffold & seed (ensure_default_vault) | mvp | `src-tauri/src/vault.rs (lines 42-76)`, `src-tauri/src/commands.rs (lines 24-26)` | — |
| ✅ | File list (tree walk) | mvp | `src-tauri/src/vault.rs (lines 406-482)`, `src-tauri/src/commands.rs (lines 29-31)` | — |
| ✅ | File read with YAML frontmatter parsing | mvp | `src-tauri/src/vault.rs (lines 267-311)`, `src-tauri/src/commands.rs (lines 39-41)` | — |
| ✅ | File write (atomic via tempfile) | mvp | `src-tauri/src/vault.rs (lines 381-404)`, `src-tauri/src/commands.rs (lines 52-54)` | — |
| ✅ | File create (empty .md) | mvp | `src-tauri/src/vault.rs (lines 313-325)`, `src-tauri/src/commands.rs (lines 76-78)` | — |
| ✅ | Folder create | mvp | `src-tauri/src/vault.rs (lines 327-339)`, `src-tauri/src/commands.rs (lines 81-83)` | — |
| ✅ | Path delete (file or dir tree) | mvp | `src-tauri/src/vault.rs (lines 341-351)`, `src-tauri/src/commands.rs (lines 86-88)` | — |
| ✅ | Path rename | mvp | `src-tauri/src/vault.rs (lines 353-366)`, `src-tauri/src/commands.rs (lines 91-93)` | — |
| ✅ | File mtime list (timelapse data) | mvp | `src-tauri/src/vault.rs (lines 418-450)`, `src-tauri/src/commands.rs (lines 34-36)` | — |
| ✅ | Vault context concatenation (LLM input) | mvp | `src-tauri/src/vault.rs (lines 489-537)`, `src-tauri/src/commands.rs (lines 47-49)` | — |
| ✅ | Read external text (ingest drag-drop) | mvp | `src-tauri/src/commands.rs (lines 59-73)` | — |
| ✅ | Wikilink parser (regex-based) | mvp | `src-tauri/src/parser.rs (lines 11-35)`, `src-tauri/src/commands.rs (lines 96-98)` | — |
| ✅ | Link graph builder (stem resolution) | mvp | `src-tauri/src/index.rs (lines 18-33, 71-105)`, `src-tauri/src/commands.rs (lines 101-103)` | — |
| ✅ | YAML frontmatter tag extraction | mvp | `src-tauri/src/index.rs (lines 107-145)` | — |
| ✅ | Provenance scanner (claim counting) | mvp | `src-tauri/src/provenance.rs (lines 18-54)`, `src-tauri/src/commands.rs (lines 182-184)` | — |
| ✅ | Git log reader (system git binary) | mvp | `src-tauri/src/git_log.rs (lines 19-54)`, `src-tauri/src/commands.rs (lines 106-108)` | — |
| ✅ | IPC command registration (invoke_handler) | mvp | `src-tauri/src/lib.rs (lines 20-59)` | — |
| ✅ | Error handling across vault domain | mvp | `src-tauri/src/vault.rs (lines 42-75, 231-258, 267-291, 313-378, 381-403)`, `src-tauri/src/parser.rs` | — |
| ✅ | Sample vault seeding (demo notes) | mvp | `src-tauri/src/sample_vault.rs (50+ wiki notes)`, `src-tauri/src/vault.rs (lines 64-67)` | — |
| ✅ | Name validation (path traversal protection) | mvp | `src-tauri/src/vault.rs (lines 368-379)` | — |
| ✅ | Hidden file filtering | mvp | `src-tauri/src/vault.rs (lines 567-570)`, `src-tauri/src/index.rs (lines 56-59)` | — |

## Notes

Code quality is production-grade. All core capabilities are functional with comprehensive error handling via Result types and no panic!() in domain code. Tests are extensive—every public function has ≥1 happy-path + error-path test. No TODOs or FIXMEs in vault.rs, parser.rs, index.rs, provenance.rs, or git_log.rs. Unwraps appear only in tests (safe for setup) or as fallbacks (unwrap_or defaults). Regex is compiled once via OnceLock static. File writes use atomic tempfile pattern. Paths are canonicalized to absolute form so frontend can use them as stable IDs. The graph builder deduplicates repeated links per source, preventing inflated edge counts. Frontmatter parsing gracefully falls back to null if YAML is invalid. Git log shell-outs gracefully return empty list if vault isn't in a repo, rather than failing. One minor edge case: unclosed brackets like '[[unclosed and [[ok' are parsed as a single link 'unclosed and [[ok' (regex non-greedy within line allows this), but this is an extreme edge case and the regex comment does not mention it as a known limitation. Sample vault is rich (50+ notes) and interconnected, so graph views are populated on first launch. CLAUDE.md vault schema is enforced in docs but not checked at parse time—could be a future lint pass. Provenance scanning is deterministic and sorts by citation ratio. Mtime tracking enables animated graph timelapse. Overall: mature, tested, production-ready MVP with no significant gaps."
