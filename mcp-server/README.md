# Memex MCP server

Expose this Memex vault as a Model Context Protocol (MCP) server so any MCP
client (Claude Code, Claude Desktop, Cursor, etc.) can read, search, and
maintain the wiki directly, alongside the Memex desktop app.

## What it gives Claude

14 tools, all scoped to this repository's wiki and raw/ directories.

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

The server **never** modifies anything under `raw/` after the file is first
written. `update_page` and `create_folder` validate the resolved path is
inside `wiki/`.

## Install

Requires Python 3.10+. The MCP SDK (`mcp` on PyPI) is installed into a local
virtualenv so it does not pollute the rest of the Memex repo (which keeps a
zero-pip-deps core).

```bash
bash mcp-server/install.sh
```

The script prints the exact `claude mcp add` command to register the server
in user scope (so it is available in every Claude Code session) or project
scope.

### Manual install

```bash
python3 -m venv mcp-server/.venv
source mcp-server/.venv/bin/activate
pip install -r mcp-server/requirements.txt
```

## Register with Claude Code

```bash
claude mcp add --scope user memex \
  -- "$PWD/mcp-server/.venv/bin/python" "$PWD/mcp-server/memex_mcp.py"
```

Verify:

```bash
claude mcp list
```

Inside any Claude Code session you should now see `memex` listed and the 14
tools available. Try:

> Use `memex` to list pages of type `concept` in this wiki.

## Register with Claude Desktop

Note: `claude.ai` (web) does **not** support local stdio MCP servers; it
only accepts remote HTTP/SSE Connectors. Use the desktop app for a local
Memex vault.

**Quit Claude Desktop fully before editing the config** — Cmd+Q on macOS,
or right-click the Dock icon → Quit. Closing the window alone leaves the
background process running and your edits get overwritten on shutdown.

Open the config file:

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

Add `memex` under `mcpServers` (replace the absolute paths with what
`install.sh` printed):

```json
{
  "mcpServers": {
    "memex": {
      "command": "/Users/<you>/Memex/mcp-server/.venv/bin/python",
      "args": ["/Users/<you>/Memex/mcp-server/memex_mcp.py"]
    }
  }
}
```

If the file already has other MCP servers, just add the `memex` entry
inside the existing `mcpServers` block. Restart Claude Desktop. The 14
tools appear under the plug icon.

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
