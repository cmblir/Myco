# Memex MCP server

Expose this Memex vault as a Model Context Protocol (MCP) server so any MCP
client (Claude Code, Claude Desktop, Cursor, etc.) can read, search, and
maintain the wiki directly, alongside the Memex desktop app.

## What it gives Claude

25 tools, all scoped to this repository's wiki and raw/ directories.

| Tool | Purpose |
|---|---|
| `list_projects` | Enumerate Memex projects (legacy + multi-project). |
| `get_instructions` | Return the project's CLAUDE.md (schema + ingest workflow). |
| `stats` | Page count, type distribution, raw source count. |
| `list_pages` | List pages with frontmatter, optionally filtered by type/folder. |
| `read_page` | Read frontmatter + body + outbound links. |
| `search` | TF-IDF search across the wiki (Korean and English tokens). |
| `folder_tree` | Folder structure under wiki/. |
| `recent_log` | Tail of wiki/log.md. |
| `list_raw_sources` | List immutable source files under raw/. |
| `add_raw_source` | Append-only write to raw/ (refuses to overwrite). |
| `create_page` | New wiki page with proper Memex frontmatter. |
| `update_page` | Overwrite an existing wiki page. |
| `create_folder` | Create a folder under wiki/. |
| `git_commit` | Stage wiki/, raw/, ingest-reports/ and commit. |
| `list_inbox` | List pending sources in _inbox/. |
| `read_inbox_source` | Read one pending _inbox/ source for ingestion. |
| `archive_inbox_source` | Copy an ingested source to raw/ and archive the original. |
| `lint_citations` | Local structural/citation lint of every page — regex only, no LLM. |
| `preview_page_update` | Unified diff of what update_page would write; touches nothing. |
| `trust_report` | Source-trust audit: source_type → trust weight, suggested vs declared confidence (GOV-03). |
| `contradictions` | Structural contradiction scan: disputed pages + active→superseded links (GOV-01), no LLM. |
| `resolve_cross_links` | Resolve a page's `[[slug::page]]` cross-project links (FEAT-02). |
| `translation_report` | KO/EN `translation_of` relation audit — dangling / non-reciprocal twins (FEAT-08). |
| `append_changelog` | Append to the project CHANGELOG.md (Keep a Changelog, GOV-04). |
| `export_project` | Zip a project's vault to projects/.backups/ (OPS-04). |

The server **never** modifies anything under `raw/` after the file is first
written. `update_page` and `create_folder` validate the resolved path is
inside `wiki/`.

## Install & run (SSE server — recommended)

Requires Python 3.10+. The MCP SDK is installed into a local virtualenv so it
doesn't pollute the rest of the Memex repo (which keeps a zero-pip-deps core).

Run Memex as a standalone HTTP/SSE server — start it once, leave it running,
and every client connects over a URL (the Obsidian Local REST API style). No
per-session subprocess, no absolute paths in the client config.

```bash
bash mcp-server/serve.sh          # bootstraps the venv, serves http://127.0.0.1:22360/sse
```

Register it with Claude Code — **one line, no paths**:

```bash
claude mcp add --transport sse memex http://localhost:22360/sse
```

That's it. `claude mcp list` should show `memex`; the tools are available in
every session while the server is running. Try:

> Use `memex` to list pages of type `concept` in this wiki.

Custom port: `bash mcp-server/serve.sh --port 9001` then register with the
matching URL. The server binds `127.0.0.1` (localhost only) by default; set
`--host 0.0.0.0` to expose it on the network.

### Claude Desktop / claude.ai

An SSE server is a remote-style HTTP connector, so it works with Claude
Desktop **and** claude.ai (web) — unlike a stdio server. Point the client at
the URL:

```json
{
  "mcpServers": {
    "memex": { "url": "http://localhost:22360/sse" }
  }
}
```

(claude.ai reaches `localhost` only if the server is on the same machine and
exposed appropriately; for the desktop app the localhost URL just works.)

## Alternative: stdio (per-session subprocess)

If you'd rather Claude spawn the process itself instead of running a server:

```bash
bash mcp-server/install.sh   # prints the exact command for your checkout
# → claude mcp add --scope user memex -- "<venv>/bin/python" "<repo>/mcp-server/memex_mcp.py"
```

The same file serves both transports; `--sse` selects the server, the default
is stdio.

## Use chat content as wiki sources

Once registered, no special syntax is needed — just ask in plain
language and Claude composes the right tool calls.

**Save the current conversation as a source**

> Save this conversation to my Memex wiki as a source titled
> "Transformer scaling discussion".

Behavior: Claude composes a markdown summary of the chat, calls
`add_raw_source` to write it under `raw/` (append-only), creates or
updates entity / concept pages with inline `[^src-*]` citations, appends
`wiki/log.md`, and runs `git_commit`.

**Drop a one-shot concept**

> Add what we just discussed about "scaling laws vs data quality" as an
> analysis page.

Claude calls `search` to find related pages, creates a new page with
`create_page(type=analysis)`, links it from existing entities, and
commits.

**Pin the schema once per session**

For longer sessions, ask Claude to load the rules first so frontmatter,
citation format, and contradiction policy are followed:

> Call `memex.get_instructions` once, then we will treat this whole chat
> as a wiki ingestion session — anything factual goes into the wiki with
> citations, anything I mark as "draft" stays just in chat.

## Suggested first prompt

```
You now have the `memex` MCP tools. Call `get_instructions` once, then
list the existing pages and tell me which sources you would ingest next.
Do not modify raw/. When you create or update wiki pages, include inline
[^src-*] citations and call git_commit when a coherent change is ready.
```

## How it relates to the desktop app

The Memex desktop app (`app/`) is the human-driven UI: a visual graph,
ingest-via-form, editor, etc. The MCP server is the same vault exposed as
agent-callable tools. They share the same `projects.json` and the same
`wiki/` tree, so changes made via either surface are immediately visible
in the other.

Both are read-safe to run concurrently. Writes are last-writer-wins on
disk; if you are doing heavy concurrent ingests, drive one surface at a
time.

## Limitations

- The MCP server does **not** spawn `claude -p` subprocesses. The
  connecting MCP client (Claude itself) does the synthesis using the
  primitives. That is why there is no `run_ingest`, `run_query`, or
  `run_lint` tool — Claude can do those itself by composing
  `add_raw_source`, `read_page`, `search`, `update_page`, etc.
- `git_commit` does not run git hooks differently from a normal commit.
  If you have pre-commit hooks that need a TTY, run those manually.
- Frontmatter parsing uses a loose YAML-ish parser. Stick to the
  documented schema in `CLAUDE.md`.
