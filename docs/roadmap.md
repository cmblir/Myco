# Memex Roadmap — Conversation & Session Wikification

## Where Memex is today

Memex is a Tauri 2 (Rust) + React desktop app over a plain-markdown Obsidian vault, plus a stdio MCP server (Python/FastMCP, `mcp-server/memex_mcp.py`). The vault schema is enforced by `CLAUDE.md`: `raw/` is immutable sources, `wiki/` holds LLM-maintained pages with YAML frontmatter, `[^src-*]` inline citations, and `[[wikilinks]]`, and every ingest writes an `ingest-reports/` WHY report. Today the **only ingest path is manual and single-file**: the `Ingest` page (`app/src/pages/PageIngest.tsx`) takes one dropped/pasted document, writes `raw/<slug>.md` via the `write_file` IPC command, then spawns the system `claude` CLI (`src-tauri/src/claude.rs`, `--print --allowedTools Read,Write,Edit,Glob,Grep,Bash`) with a fixed `INGEST_PROMPT` so Claude maintains the wiki per `CLAUDE.md`. Success is verified by snapshotting `wiki/` mtimes (`file_mtimes`) before/after. The MCP server already exposes the durable write primitives — `add_raw_source` (refuses overwrite = immutability), `create_page`, `update_page`, `git_commit`, `_safe_wiki_path`/`is_protected_raw` guards, multi-project registry. Provider-wise, only `anthropic-cli` is tool-capable (can write the vault); HTTP providers (`providers.rs`) are read-only chat. **What is missing for the owner's goal:** no folder watcher, no conversation/session parsers (ChatGPT/Claude/Claude Code/Codex), no dedup/idempotency ledger, no batch/bulk importer, no scheduled auto-ingest, and no chunk→extract→merge pipeline — every source today is hand-fed one at a time.

## Prioritized roadmap

Effort: **S** ≈ ≤1 day, **M** ≈ 2–4 days, **L** ≈ 1–2 weeks.

| P | Feature | Why | Effort | Where it lives |
|---|---------|-----|--------|----------------|
| **P0** | **Conversation parsers** (ChatGPT `conversations.json`, Claude export, Claude Code `*.jsonl`, Codex rollouts) → normalized `Conversation{id, source, title, created, turns[]}` | Nothing can be imported without first turning vendor formats into clean transcripts; foundation for every other feature | **M** | CLI script (`mcp-server/importers/`) + mirror in Rust `src-tauri/src/importers/` |
| **P0** | **Dedup ledger** — SHA-256 of normalized transcript → `.memex/ledger.json`, check-before-write so re-imports are no-ops | Owner re-drops the same export repeatedly; without idempotency `raw/` fills with duplicates and wiki double-counts | **S** | Rust command `ingest_ledger_check`/`record` + MCP tool `ledger_status` |
| **P0** | **Standalone CLI batch importer** — `memex-import <dir|file> --vault <path> --provider …` walks an export, parses, writes `raw/conversations/<src>/<id>.md`, ingests, commits | The "files in, wiki out" automation the owner asked for; works headless, scriptable, no GUI needed for the initial 1000-conversation backfill | **L** | CLI script (`mcp-server/memex_import.py`, reuses MCP write tools in-process) |
| **P0** | **MCP import tools** — `import_conversation(raw_text, source, meta)`, `import_session(jsonl_path)`, `wikify_pending()` | Lets any MCP client (Claude Desktop/Code) drive imports + wikification using the existing `add_raw_source`/`create_page` guards; the agent-native path | **M** | MCP tools in `memex_mcp.py` |
| **P1** | **Drop-folder watcher in the Tauri app** — watch `<vault>/raw/_inbox/`, debounce, enqueue, auto-ingest | Owner drops an export ZIP/folder and walks away; the "hot folder" UX with live progress in the app | **M** | Rust command `watch_inbox` (add `@tauri-apps/plugin-fs` `watch`) + React `PageImport` |
| **P1** | **Wikification pipeline v2** — chunk (≈600–1000 tok on turn boundaries) → schema-constrained extract → embed+retrieve candidate pages → LLM ADD/UPDATE/MERGE/NOOP → cite (select-then-generate) | The single-prompt "Claude, ingest this" approach does not scale to long transcripts or dedup across hundreds of sessions; this is the quality core | **L** | Rust orchestrator `src-tauri/src/pipeline.rs` + MCP `wikify_pending`; embeddings via `ollama.rs` |
| **P1** | **Bulk-import UX** — two-level progress (X of Y + per-file status), partial-failure report, "retry failed only" | Importing an entire history is the headline flow; needs trustworthy counts and recoverable failures, not a spinner | **M** | React `PageImport.tsx` + ingest store; Rust progress events |
| **P1** | **Coding-session wikifier** — Claude Code/Codex sessions → `entity` (repos, files, tools) + `technique`/`analysis` pages, not just raw dumps | The owner's second explicit ask; sessions are structurally different from chats (tool calls, diffs, cwd, git branch) and need their own extractor | **M** | CLI/MCP `import_session` + session-specific extract prompt |
| **P2** | **Scheduled / auto ingest** — periodic sweep of `~/.claude/projects` + `~/.codex/sessions` for new `*.jsonl` since last run | Coding sessions are produced continuously; the wiki should self-update without a manual drop | **M** | Rust background task + `cron`/`launchd`/systemd `.timer` for the CLI |
| **P2** | **Contradiction & supersede automation** — wire pipeline's `tinvalid`/`disputed` decision into the `## Historical claims` / `## Disputed` schema | `CLAUDE.md` already specifies the policy; automate Case 1/2/3 instead of relying on the model to remember it | **M** | Pipeline step + MCP `supersede_claim` |
| **P2** | **Incremental session tailing** — only ingest new lines of an append-only `*.jsonl` since last byte offset | Active Claude Code sessions grow; re-parsing the whole file every sweep is wasteful and re-triggers dedup churn | **S** | CLI offset state in `.memex/ledger.json` |
| **P2** | **Import provenance surfacing** — extend `scan_provenance` so the Provenance page shows source = which conversation/session a claim came from | Trust: owner wants to see "this claim came from my 2025-03 chat about X"; closes the loop on cited automation | **S** | `provenance.rs` + `PageProvenance.tsx` |

---

## Conversation & session → wiki automation (design)

All four approaches share one **normalized intermediate** and one **wikification pipeline**; they differ only in *trigger* and *runtime*. Build the parsers and pipeline once (P0), then the four entry points are thin shells.

### Shared normalized form

```jsonc
Conversation {
  id:        string,   // vendor id (UUID/sessionId) — stable dedup key per source
  source:    "chatgpt" | "claude" | "claude-code" | "codex",
  title:     string,   // vendor title, else first user turn
  created:   string,   // ISO-8601, normalized from epoch/ISO per source
  cwd?:      string,   // coding sessions only
  gitBranch?: string,  // coding sessions only
  turns: [{ role: "user"|"assistant", text: string, ts?: string }]
}
```

Each `Conversation` is serialized to one `raw/` markdown file with frontmatter (`source`, vendor `id`, `created`, `turn_count`) + a clean transcript body. **`raw/` immutability is preserved identically in all four paths** because every path funnels writes through the same guard: MCP `add_raw_source` refuses to overwrite (returns error), the Tauri `write_file` ingest path writes only to `raw/conversations/<source>/<id>.md` with a pre-existence check, and the CLI uses `add_raw_source` in-process. `raw/` is never edited or deleted — corrections go to a `wiki/` page per `CLAUDE.md`. (Optional hard guard: `chflags uchg` on macOS / `chattr +i` on Linux for the `raw/` tree.)

### Idempotency / dedup (shared)

Two-level key, stored in `<vault>/.memex/ledger.json` (gitignored):

1. **Per-conversation id** (`source:id`) — primary key; skip if already imported.
2. **Content SHA-256** of the normalized transcript — catches the same conversation re-exported under a new filename, and detects edits (new hash ⇒ re-ingest as an UPDATE, not a duplicate page).
3. **Byte offset** per append-only `*.jsonl` (Claude Code/Codex) — for incremental tailing of growing sessions (P2).

Re-runs are no-ops: check ledger → skip; this makes re-dropping an entire export folder safe and is what lets the watcher and scheduler run repeatedly without damage. Pipeline writes are **replace-over-append** at page granularity (`update_page` overwrites; never blind append) so partial re-runs converge.

### Wikification pipeline (shared: chunk → extract → dedup/merge → cite → commit)

1. **Chunk** — split the transcript on **speaker-turn / topic boundaries**, target ≈600–1000 tokens. Smaller chunks measurably recover ~2× more entities than 2400-tok chunks (GraphRAG), so prefer more, smaller chunks over fewer large ones.
2. **Extract** — per chunk, one **schema-constrained** call (JSON Schema / function-calling, not "return JSON" prompting) emitting typed records: `{entities[], claims[{text, source_span_offsets}], relationships[]}`. Run **1–2 gleaning passes** (feed back extracted entities, ask for missed ones) instead of enlarging chunks. For the `anthropic-cli` provider this is a structured sub-prompt; for HTTP providers use the provider's structured-output mode.
3. **Dedup / merge** — for each new entity/claim: embed (local, via `ollama.rs`) + TF-IDF (existing MCP `search`) to retrieve top-k candidate pages cheaply, then **one LLM adjudication** call deciding **ADD / UPDATE / MERGE / NOOP** (Mem0/Zep pattern — never compare all pairs). MERGE → `update_page`; ADD → `create_page`.
4. **Cite** — **select-then-generate**: the source span chosen during extraction *is* the citation. Emit `[^src-conv-<id>]` (or `[^src-session-<id>]`) inline, with the footnote resolving to the `raw/conversations/.../<id>.md` summary page, exactly matching the `CLAUDE.md` citation contract. NLI-verify the claim entails its span before committing (drop unverifiable claims).
5. **Contradiction** — compare each new claim to retrieved related claims; on conflict apply `CLAUDE.md` Case 1/2/3 (Historical / Disputed / superseded) with date stamps rather than overwriting (soft, time-aware invalidation).
6. **Commit** — group related page writes and call MCP `git_commit` / a Rust git step with a Conventional Commit message (`ingest: <title>`), then write the `ingest-reports/` WHY report. Index (`wiki/index.md`) and `wiki/log.md` are updated as the last step.

> Map-reduce the **extraction** (chunks are independent — parallelizable) but **refine** the page composition (respect transcript chronology so a page reads coherently). This hybrid matches the ordered nature of transcripts.

### Approach 1 — Drop-folder watcher in the Tauri app

- **When to use:** interactive desktop use; owner drags an export folder/ZIP and wants live progress. Best for *occasional* bulk drops and ongoing ad-hoc imports.
- **Data flow:** add `@tauri-apps/plugin-fs` (`watch` feature) and a Rust command `watch_inbox(vault)` that watches `<vault>/raw/_inbox/` (debounced ~500 ms; the equivalent of chokidar's `awaitWriteFinish` — only process after writes settle so partial copies aren't parsed). On a settled `add`, Rust emits an event → React enqueues → for each file: detect format → parse → `write_file` to `raw/conversations/<source>/<id>.md` (skip if ledger hit) → run the pipeline via `complete({task:"ingest"})` → refresh tree/graph. The `_inbox/` file is moved to `raw/conversations/...` (inbox doubles as the "pending" state).
- **Idempotency/dedup:** ledger check before write; same SHA-256 logic as shared. The watcher is naturally re-entrant because processed files leave `_inbox/`.
- **`raw/` immutability:** the inbox is a *staging* area, not part of immutable `raw/` content; the canonical write target is `raw/conversations/...` via the pre-existence-checked `write_file`. `_inbox/` can live outside `raw/` (e.g. `<vault>/_inbox/`) to keep `raw/` semantically pure.
- **Pipeline:** full shared pipeline, with the `PageImport` two-level progress UI driving the loop.

### Approach 2 — MCP import tools

- **When to use:** agent-native — Claude Desktop/Code (or any MCP client) orchestrates the import and can reason between steps (e.g. "import these 5 sessions, then reconcile contradictions"). Best when a human or agent is already in an MCP conversation.
- **Data flow:** new tools in `memex_mcp.py`: `import_conversation(raw_text, source, meta)` (parse → `add_raw_source` → return src slug), `import_session(jsonl_path)` (parse Claude Code/Codex JSONL → `add_raw_source`), and `wikify_pending(project)` (run the pipeline over un-wikified raw sources). These compose the *existing* `add_raw_source`/`create_page`/`update_page`/`git_commit`/`_safe_wiki_path` primitives, so all guards (immutability, path-escape) apply unchanged.
- **Idempotency/dedup:** add a `ledger_status` tool; `import_*` consult the ledger and return `{skipped: true, reason}` on a hit.
- **`raw/` immutability:** inherited from `add_raw_source` (refuses overwrite) and `is_protected_raw` (blocks `update_page` into `raw/`).
- **Pipeline:** the agent can run the pipeline steps as discrete tool calls, or call `wikify_pending` to run it server-side.

### Approach 3 — Standalone CLI batch importer

- **When to use:** the **initial backfill** of the owner's entire history (hundreds/thousands of conversations), and any headless/scripted run (CI, cron). No GUI, fully parallel, resumable.
- **Data flow:** `memex_import.py <dir|file> --vault <path> [--source auto] [--provider anthropic-cli] [--concurrency 4] [--dry-run]`. Walks the export (recursively), parses each conversation/session, writes to `raw/conversations/...` via the in-process `add_raw_source`, runs the pipeline, batches `git_commit`s (e.g. one commit per N pages). Bounded concurrency (`--concurrency`). CLI UX: "X of Y" line for measurable progress, `--plain` for non-TTY/CI, past-tense verbs on completion; partial failures summarized ("Imported 97, skipped 3, failed 2") with a `--retry-failed` mode reading the ledger's failure set.
- **Idempotency/dedup:** the ledger makes the whole run resumable — re-running after a crash skips everything already done. `--dry-run` parses + dedups without writing.
- **`raw/` immutability:** same `add_raw_source` guard; the CLI never edits existing `raw/` files.
- **Pipeline:** full shared pipeline; map-reduce extraction parallelized across `--concurrency` workers.

### Approach 4 — Scheduled / auto ingest

- **When to use:** **continuous** coding-session capture — Claude Code (`~/.claude/projects/`) and Codex (`~/.codex/sessions/`) write new `*.jsonl` constantly; the wiki should absorb them without manual action.
- **Data flow:** two layers. (a) In-app: a Rust background task on an interval (or a Tauri `watch` on the two session dirs) finds `*.jsonl` newer than `last_sweep` and feeds them to the pipeline. (b) Headless: a `launchd` plist (macOS) / systemd `.timer` (Linux — preferred over cron: `Persistent=` catches up after downtime, journald logging) invoking `memex_import.py --since-last-sweep --source claude-code,codex`.
- **Idempotency/dedup:** ledger by `source:sessionId` + **byte-offset tailing** (P2) so only new lines of a growing session are parsed; `last_sweep` timestamp bounds the file scan.
- **`raw/` immutability:** unchanged; sessions land in `raw/conversations/{claude-code,codex}/<sessionId>.md` via the guarded writer. Active sessions are re-ingested as UPDATEs (same id, new hash), never as new raw files.
- **Pipeline:** session-specific extractor (see coding-session notes below), otherwise the shared pipeline. Auto-commit with `chore(auto-ingest): <session title>`.

**Recommended sequencing:** build parsers + ledger + pipeline (P0) → CLI batch importer for the one-time backfill (P0) → MCP tools (P0) → app watcher + bulk UX (P1) → scheduler for ongoing sessions (P2).

---

## Parser notes (per source)

> All parsers output the shared `Conversation`. Date normalization is the most common footgun: ChatGPT `create_time`, Claude `created_at`, and Codex `history.ts` are **epoch seconds**; Cursor is **epoch milliseconds**; Claude Code `timestamp` and Codex rollout `timestamp` are **ISO-8601 strings**.

### ChatGPT — `conversations.json`

- Top level is a **JSON array** of conversation objects: `{id, title, create_time (epoch sec), update_time, mapping, current_node, ...}`. **No flat message list** — messages live only in the `mapping` tree.
- **Reconstruct the active thread:** start at `current_node`, walk `parent` links to the root, then reverse. `mapping[nodeId] = {id, message, parent, children}`; the root has `message: null`.
- **Per message:** `message.author.role` (`system|user|assistant|tool`); content by `content.content_type`: `text` → join `content.parts` (strings); `code` → `content.text`; `multimodal_text` → mixed strings + `{content_type:"image_asset_pointer"}` dicts (skip images).
- **Filter out:** `author.role == "system"`, `metadata.is_visually_hidden_from_conversation == true`, `weight == 0`. Keep user + assistant.
- **Title:** `conversation.title` (fallback: first user message). **Date:** `create_time` (already seconds — multiply nothing). **Dedup id:** conversation `id`.

### Claude.ai export — `conversations.json` / `.jsonl`

- Each conversation: `{uuid, name (title, may be empty), summary, created_at / updated_at (ISO-8601), chat_messages[]}`. Already **linear** (current branch only) — no tree walk. Some builds ship one-object-per-line `.jsonl`.
- **Per message:** `sender` is `"human"` | `"assistant"` (**note: `human`, not `user`** — map `human` → `user`); text via `text` (flattened plaintext, easiest) or join `content[].text` where `type == "text"` (other block types: `tool_use`, `tool_result`).
- **Title:** `name` (fallback: first human text). **Date:** `created_at`. **Dedup id:** `uuid`. Very old conversations may have a different schema; model is usually not stored.

### Claude Code — `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`

- Append-only, **one JSON object per line**. Encoded dir = absolute cwd with `/` and `.` → `-` (e.g. `-Users-yoo-project-Memex`). Line `type` ∈ `{user, assistant, system, summary, file-history-snapshot, attachment, mode, last-prompt, ai-title, queue-operation}`.
- **Envelope (user/assistant):** `{type, uuid, parentUuid, sessionId, cwd, gitBranch, version, timestamp (ISO-8601), userType, isSidechain, isMeta}`.
- **user line:** `message.content` is a **string** (plain prompt) **or array** of blocks (`{type:"tool_result", tool_use_id, content}`). **assistant line:** `message:{id, role, model (e.g. "claude-opus-4-8"), content:[blocks], stop_reason, usage}`; blocks: `{type:"text", text}`, `{type:"thinking", thinking}`, `{type:"tool_use", id, name, input}`.
- **Clean transcript:** keep `type ∈ {user, assistant}`; user → `content` if string else join `tool_result`/text; assistant → join `content[]` where `type == "text"` (drop `thinking`/`tool_use`). **Skip `isSidechain == true` and `isMeta == true`** (sub-agent/internal noise). Filter user strings wrapped in `<local-command-caveat>`/`<command-name>` (slash-command injections).
- **Title:** dedicated `{type:"ai-title", aiTitle, sessionId}` line (fallback: first user text). `{type:"summary"}` lines hold compaction summaries (`summary` text + `leafUuid`). **Date:** first line's `timestamp`. **Dedup id:** `sessionId` (+ byte offset for tailing).

### Codex CLI — `~/.codex` (`$CODEX_HOME`)

- **Sessions:** `sessions/YYYY/MM/DD/rollout-<ISO-ts>-<uuid>.jsonl`. Every line `{timestamp (ISO-8601), type, payload}`. `type` ∈ `{session_meta (exactly 1, first line), turn_context, response_item, event_msg}`.
- **`session_meta.payload`:** `{id (session UUID), timestamp (ISO start), cwd, originator, cli_version, model_provider, base_instructions}`. **`turn_context.payload`:** `{turn_id, cwd, current_date, model (e.g. "gpt-5.5"), ...}`.
- **`response_item` message:** `{type:"message", role:"user"|"assistant"|"developer"|"system", content:[{type:"input_text", text} | {type:"output_text", text}]}`. `function_call`/`function_call_output` carry tool I/O; `reasoning` is opaque/encrypted (skip).
- **Cleanest text** comes from the `event_msg` duplicates: `{type:"user_message", message, ...}` and `{type:"agent_message"|"task_complete", message|last_agent_message}` — already-rendered strings, simpler than walking `response_item` content. Alternatively `response_item` message: `role=="user"` → `input_text`, `role=="assistant"` → `output_text`; **skip `developer`/`system`**.
- **Title:** no native field — derive from first `user_message`. **Date:** `session_meta.payload.timestamp` (or the rollout filename). **Dedup id:** session UUID.
- **Bonus:** `~/.codex/history.jsonl` is a flat global prompt log `{session_id, ts (epoch sec), text}` (user prompts only) — handy for titles/search; persistence may be disabled (`history=none`).

### Coding-session extraction (Claude Code & Codex differ from chats)

Sessions carry `cwd`, `gitBranch`, tool calls, and file diffs. The session extractor should:
- Emit **`entity`** pages for repos/projects (from `cwd`), and notable files/tools touched (from `tool_use`/`function_call` names + inputs).
- Emit **`technique`**/**`analysis`** pages for the *problem solved* (e.g. "fixing the stdin/stdout deadlock in `claude.rs`"), not a raw turn dump.
- Use `gitBranch` + repo as a stable cross-link key so multiple sessions on the same project converge onto one project entity page.
- Cite `[^src-session-<sessionId>]`.

---

## Risks & open questions

- **Token cost of the backfill.** Hundreds of long transcripts through a chunk→extract→glean→merge pipeline is expensive on metered APIs. The `anthropic-cli` provider (uses the user's Pro/Max subscription, no per-token billing — see `claude.rs`) is the natural default; consider a local-Ollama extraction pass (`ollama.rs`) to pre-filter, with Claude only for merge/cite. **Open:** acceptable cost ceiling per backfill run?
- **Structured output on the CLI path.** `claude --print` returns free text, not guaranteed JSON; schema-constrained extraction is straightforward over HTTP providers but needs a robust JSON-extraction/repair step on the CLI. **Open:** add a JSON-mode flag to `claude_run`, or parse fenced JSON from stdout?
- **Embeddings dependency for dedup.** Step 3 wants embeddings; `ollama.rs` can host a local embedding model, but that's a new runtime dependency. Fallback: the existing TF-IDF `search` for candidate retrieval (lower recall, zero new deps). **Open:** require Ollama for high-quality dedup, or ship TF-IDF-only and treat embeddings as an upgrade?
- **`@tauri-apps/plugin-fs` not yet a dependency.** The watcher needs it (with the `watch` Cargo feature + capability scoping `fs:allow-watch`). Adds surface area and a permissions story. **Open:** in-app `notify`-crate watcher (no new JS plugin) vs the official `plugin-fs`?
- **Privacy / secret leakage.** Transcripts and Codex/Claude Code sessions can contain API keys, tokens, file paths, and PII. The pipeline must scrub secrets before they land in `raw/` (which is then immutable and committed to git). **Open:** what redaction pass runs pre-write, and is a default `.gitignore` for `raw/conversations/` safer than committing them?
- **Dedup across *sources*.** The same idea discussed in both ChatGPT and a Claude session should merge into one wiki page — but ids/hashes are per-source. The semantic MERGE step (3) handles this, but cross-source merge quality is unproven at scale. **Open:** accept some duplicate pages initially and add a periodic "merge similar pages" maintenance pass?
- **Branch handling in ChatGPT.** Walking `current_node`→root captures only the active branch; abandoned branches are dropped. Acceptable for a wiki, but worth confirming. **Open:** ever ingest non-active branches?
- **Active-session churn.** Tailing a live Claude Code session re-ingests as UPDATE on every sweep; rapid edits could thrash the wiki/git history. **Open:** quiet-period gate (only ingest sessions idle > N minutes / marked complete)?
- **MCP server is Python, app importers would be Rust.** Two parser implementations risk drift. **Open:** single source of truth — Python importers invoked by the app via subprocess, or a shared Rust crate the MCP server binds to?
