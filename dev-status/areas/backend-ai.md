---
title: "Backend — AI Providers & Agents (Rust)"
type: dev-status-area
project: memex-app
updated: 2026-06-15
---


# Backend — AI Providers & Agents (Rust)

**Maturity: `████████░░ 82%`** · back to [[index]]

The Memex app implements a multi-provider LLM backend with 8 declared providers (anthropic-cli, gemini-cli, codex-cli, anthropic-api, openai-api, google-api, ollama, openrouter). Three are CLI-based (spawned as local subprocesses with stdin/stdout bridging); five are HTTP-based adapters with common chat_complete/list_models signatures. The CLI runner (claude.rs) includes streaming support with run_id-based cancellation. Settings persistence stores non-secret provider flags and model selections; secrets live in the OS keychain. The HTTP layer does not stream responses; Ollama gets special status introspection to report daemon health and pulled models.

## Features

| | Feature | Stage | Key files | Gaps |
|--|---------|-------|-----------|------|
| ✅ | Claude CLI Bridge (anthropic-cli) | mvp | `src-tauri/src/claude.rs`, `src-tauri/src/commands.rs` | — |
| ✅ | HTTP Provider Adapters (anthropic-api, openai-api, openrouter, google-api, ollama) | mvp | `src-tauri/src/providers.rs`, `src-tauri/tests/provider_adapters.rs` | No streaming responses — explicitly avoided per comment on line 3. Response parsing uses unwrap_or_default for missing c… |
| ✅ | Anthropic API Adapter | mvp | `src-tauri/src/providers.rs` | — |
| ✅ | OpenAI & OpenRouter API Adapters | mvp | `src-tauri/src/providers.rs` | — |
| ✅ | Google Gemini API Adapter | mvp | `src-tauri/src/providers.rs` | — |
| ✅ | Ollama Local Provider | mvp | `src-tauri/src/providers.rs`, `src-tauri/src/ollama.rs` | — |
| ✅ | Secret/API Key Storage (OS Keychain) | mvp | `src-tauri/src/secrets.rs`, `src-tauri/src/commands.rs` | Keyring errors (e.g., permission denied) propagate as Err(String). No UI guidance on keychain access prompts on first us… |
| ✅ | Settings Persistence & Provider Flags | mvp | `src-tauri/src/settings.rs`, `src-tauri/src/commands.rs` | — |
| ✅ | Chat Complete & Model Listing Unification | mvp | `src-tauri/src/providers.rs`, `src-tauri/src/commands.rs` | Unknown provider IDs fail at runtime rather than compile-time. No rate limiting or request deduplication. |
| ✅ | CLI Agent Locator (PATH Resolution) | mvp | `src-tauri/src/claude.rs`, `src-tauri/src/cli_agent.rs` | — |
| ✅ | Stream Event Parsing (Claude CLI) | mvp | `src-tauri/src/claude.rs` | — |
| ✅ | Streaming Run Cancellation | mvp | `src-tauri/src/claude.rs`, `src-tauri/src/commands.rs` | — |
| ✅ | Model Catalog Static Data | mvp | `src-tauri/src/providers.rs` | Static Anthropic/Google model lists are hand-curated and may fall out of sync with live APIs. No auto-refresh or depreca… |
| 🟢 | Gemini CLI & Codex CLI Bridges (gemini-cli, codex-cli) | mvp | `src-tauri/src/cli_agent.rs`, `src-tauri/src/commands.rs` | No streaming support — both CLI runners are blocking. No event parsing (unlike claude's stream-json). Codex tmpfile clea… |
| 🟢 | Provider ID Routing & Validation | mvp | `src-tauri/src/providers.rs`, `src-tauri/src/settings.rs` | Provider IDs are stringly-typed, allowing typos in frontend. No compile-time exhaustiveness check for new providers. Set… |
| 🟢 | Error Handling & Propagation | mvp | `src-tauri/src/providers.rs`, `src-tauri/src/claude.rs` | Silent failures where unwrap_or_default is used (e.g., providers.rs line 601 ollama message unwrap_or_default, ollama.rs… |

## Notes

## Cross-Cutting Observations  **Architecture Pattern**: Three-tier provider model: CLI-based (claude/gemini/codex, subprocess bridging), HTTP-based (Anthropic/OpenAI/Google/OpenRouter/Ollama, reqwest adapter), and local daemon status (Ollama introspection).  **Streaming**: Only Claude CLI supports streaming (via --output-format stream-json + event parsing). HTTP providers intentionally do NOT stream (comment on providers.rs:3). Agent CLIs are blocking. Frontend must poll or use claude streaming exclusively for live feedback.  **Key Storage**: Solid keychain integration (apple-native/windows-native/linux) via keyring crate. Never stored on disk. One exception: Ollama needs no key (line 213–214 in commands.rs).  **Settings Persistence**: JSON to platform-standard app data dir. Backward-compatible defaults (anthropic_cli always true for upgrades). Tolerates partial/corrupt JSON gracefully.  **Model Catalogs**: Anthropic/Google hardcoded (may go stale). OpenAI/OpenRouter dynamic (requires API key to list). Ollama dynamic (no key needed). No version pinning or deprecation warnings.  **Provider Dispatch**: String-based routing in chat_complete() and list_models(). No enum. Route-not-found returns Err at runtime. cli_agent handles this better with Option<_> return from provider_bin().  **Error Swallowing**:  - ollama.rs line 91: `resp.json().await.unwrap_or_default()` returns empty models list on parse error (silent) - providers.rs line 601: `message.and_then(\|m\| m.content).unwrap_or_default()` silently returns "" if Ollama response malformed - settings.rs line 119: `serde_json::from_str(&raw).unwrap_or_default()` accepts corrupt JSON and loads defaults (reasonable fallback)  **Unwraps/Panics**: All use cases are safe defaults or test-only (unwrap_or_default, unwrap_or(), unwrap_or_else). No actual panics found in production paths.  **Testing**: Comprehensive wiremock tests for HTTP adapters (provider_adapters.rs). CLI tests validate arg construction and env resolution. Settings tests cover persistence + legacy migration. Missing: end-to-end tests of streaming cancellation, keychain integration, actual CLI invocation.  **Deployment Notes**: - Claude CLI location discovery is robust (handles Finder/Dock minimal PATH) - Tauri IPC surface is complete and well-named - Timeout: 600s for CLI agents, 180s for HTTP, 900ms for Ollama daemon check - No retry logic; failures fail fast  **Codex CLI**: Writes output to tmpfile (~memex-codex-<pid>-<nanos>.txt) and reads it back. File cleanup via remove_file (silently succeeds if missing). No cleanup on panic/crash — orphan tmpfiles possible.  **Declared vs. Implemented**: - All 8 declared providers (anthropic-cli, gemini-cli, codex-cli, anthropic-api, openai-api, google-api, ollama, openrouter) ARE implemented - anthropic-cli is the primary (default, streaming, tool-capable) - gemini-cli and codex-cli are optional CLI agents (no streaming) - HTTP adapters are uniform (no streaming, token counting, consistent error shape)
