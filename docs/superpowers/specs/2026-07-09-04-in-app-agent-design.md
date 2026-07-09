# Feature 4 — In-app Autonomous Agent — Design

Date: 2026-07-09
Priority: 4. Depends on: none (stronger with #1 semantic search as a tool).
Scope: `app/src-tauri` (Rust: in-process tool dispatch, `claude.rs` reuse),
`app/src/lib` (chat/agent loop), `app/src/pages/PageQuery.tsx`,
`app/src/components` (agent step UI, task-agent manager), `app/src/stores`,
`app/src/lib/i18n.ts`.

## Problem / opportunity

Memex exposes ~25 wiki tools to *external* MCP clients, and the Claude Code CLI
provider already runs a streaming tool-loop with `run_id` cancellation — but the
Ask/Query page itself only does one-shot Q&A. There is no autonomous *in-app*
agent that plans and calls its own tools (search vault, traverse graph, read
pages, optionally web) iteratively to answer complex questions or run multi-step
wiki tasks ("find every page that contradicts X and draft a reconciliation note").
Competitors ship this: Obsidian Copilot Agent Mode, Khoj agents.

## Decisions (proposed; some open — see below)

- **Agent mode is a toggle on the Ask/Query page**, not a new route — it reuses the
  chat transcript UI, adding a visible tool-step trace.
- **Two execution backends, one UX:**
  - **Claude CLI (default, cheapest to ship):** the CLI already tool-loops; point it
    at the vault with a curated tool allowlist and stream its steps. Minimal new code.
  - **HTTP providers (Anthropic/OpenAI/Google/OpenRouter):** need an **in-app
    tool-loop** driver (send tools schema → model emits tool_use → we dispatch →
    feed results → repeat until final). Larger effort; ship after the CLI path.
- **Tools = an in-process registry** mirroring the read-mostly MCP tool set, calling
  the same Rust functions the MCP server wraps (search, read_page, folder_tree,
  graph neighbours, lint/contradictions, semantic_search from #1) — NOT by spawning
  the external MCP server. Write tools (create/update/commit) are gated (below).
- **Task agents:** user-saved presets = `{ name, system_prompt, tool_subset,
  model }` (e.g. "weekly reviewer", "contradiction finder"), stored as markdown+YAML
  under the vault (`agents/<slug>.md`) so they are portable and no-lock-in.

## Architecture

### A. Tool registry (Rust, `src-tauri/src/agent_tools.rs` — new)
- A typed list of tool descriptors `{ name, json_schema, handler }` reusing existing
  domain fns (`vault::search_vault`, `index`/graph neighbours, `vector_index::
  semantic_search` from #1, provenance `lint`/`contradictions`, `vault::read_file`).
- Read tools always allowed. **Write tools** (`create_page`, `update_page`,
  `git_commit`) require explicit per-call user confirmation in the UI and are
  refused entirely against `raw/` (immutability outranks the agent).
- Optional **web_search** tool: opt-in in Settings, provider-backed (keychain);
  off by default to preserve offline/no-telemetry.
- IPC: `agent_tool_call(name, args)` → JSON result (used by the HTTP-loop driver);
  the CLI path instead gets the allowlist via Claude CLI's own tool config.

### B. Agent loop
- **CLI path:** extend the existing `claude.rs` streaming run with an agent
  system-prompt + tool allowlist scoped to the vault; reuse `run_id` for
  cancellation. Steps stream as-is.
- **HTTP path (`app/src/lib/agentLoop.ts` — new):** loop `model.chat(tools) →
  parse tool_use → agent_tool_call → append tool_result → repeat`, max-N iterations
  + token/step budget (respects the existing budget guard), abortable via the same
  cancellation channel. Bundled SEED model: **too weak for reliable multi-step tool
  use — disable agent mode for `builtin-local`** and say so in the UI.

### C. UI (`PageQuery.tsx` + `components/AgentTrace.tsx`, `TaskAgentBar.tsx`)
- Mode toggle: "Ask" (one-shot) vs "Agent". Agent runs stream a collapsible step
  trace: each tool call shows name + args + a result summary; final answer carries
  citations like normal Q&A.
- Task-agent picker (dropdown) + a small manager to create/edit/delete presets
  (writes `agents/*.md`). A run can be launched from a preset.
- Cancel button wired to `run_id`.

### D. Settings / stores
- `agentStore` for live run state (steps, streaming, cancel). Settings: enable web
  tool (+ provider), default agent model, max iterations. No telemetry.

## Constraints fit
- Local-first: read tools + bundled/local models work offline; web tool is opt-in.
  Write tools confirm before touching the vault and never touch `raw/`. Task agents
  are plain markdown in the vault (portable, no lock-in). Keys stay in the keychain.

## Error handling
- Tool call errors return a structured error to the model (so it can recover) and
  surface in the trace; never crash the run.
- Loop guardrails: hard cap on iterations + budget; on cap, stop with a partial
  answer labelled "stopped at limit".
- Cancellation mid-tool leaves the vault consistent (writes are atomic already).

## Testing / verification
- Rust unit: each tool handler returns valid JSON for the schema; write tools refuse
  `raw/` paths; confirmation gate blocks unconfirmed writes.
- TS unit: `agentLoop` drives a mocked provider through tool_use → tool_result →
  final; respects max-iteration + abort.
- Playwright: toggle Agent mode, ask a multi-step question, see ≥2 tool steps stream
  and a cited final answer; a write action prompts confirmation; a task-agent preset
  round-trips to `agents/*.md`.
- `tsc -b`, `eslint`, `vitest run` clean; existing tests pass.

## Open decisions (resolve at implementation)
1. In-process tool registry (proposed) vs delegating to the bundled MCP server over
   stdio (heavier, but single source of truth for tools).
2. Web-search tool provider (Brave/Tavily/SerpAPI/provider-native) — pick one,
   keychain-keyed, opt-in.
3. Task-agent storage: `agents/*.md` in the vault (proposed, portable) vs
   `settings.json` (private, not synced with the vault).
4. Ship CLI-only agent first, or build the HTTP in-app loop in the same pass.

## Rollout
Phase A: Claude-CLI agent mode + read tools + step trace. Phase B: HTTP in-app
loop + task agents + optional web tool. Gated behind an "Agent mode" toggle; hidden
for the bundled-local provider.
