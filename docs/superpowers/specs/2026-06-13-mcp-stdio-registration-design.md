# Design — One-Click memex MCP Registration (stdio)

- **Date:** 2026-06-13
- **Status:** approved (design); pending spec review
- **Approach:** stdio — keep the existing Python MCP server; the app makes
  registering it with local Claude clients trivial. No app-hosted server.

## Decision note

The first design (app-hosted Streamable-HTTP server, auto-started on launch) was
rejected in favour of stdio. The owner wants `claude mcp add memex -- …`
(command form, no URL) and accepts the consequence: with stdio the **client**
(Claude Code / Claude Desktop) spawns the server per session, so MCP works
**whether or not the Memex app is open**. This is simpler and more robust for
local use; it cannot serve claude.ai web (out of scope). The app's role shrinks
to surfacing the registration command and the install step.

## Goal

From the Memex app's Settings, a user can (1) install the MCP server's Python
deps if missing, and (2) copy the exact `claude mcp add memex -- …` command and
the Claude Desktop config snippet, with correct absolute paths for this
machine. After registering once, the `memex` tools work in every Claude Code /
Desktop session — no per-session setup, no app dependency at runtime.

Success: Settings shows the correct command → copy → paste → `claude mcp list`
shows `memex` connected → a tool (e.g. `stats`) returns data — and this keeps
working with the Memex app closed.

## Background (current state)

- `mcp-server/memex_mcp.py` (Python / FastMCP), **stdio**, 14 tools, project
  resolution via `project_registry.py`. `REPO_ROOT` is fixed to the repo
  (parent of `mcp-server/`) regardless of the client's cwd.
- `mcp-server/install.sh` already creates `mcp-server/.venv`, installs
  `requirements.txt`, and prints the registration command:
  `claude mcp add --scope user memex -- "<repo>/mcp-server/.venv/bin/python" "<repo>/mcp-server/memex_mcp.py"`
  plus the Desktop `claude_desktop_config.json` JSON. The venv does not exist
  until the script runs.
- The app already locates binaries Finder-safely (`claude.rs::locate_bin`,
  `augmented_path`) and spawns/reaps children — reusable for running
  `install.sh` and (optionally) `claude mcp add`.

## Non-goals (v1)

- No Streamable-HTTP transport, no app-hosted server, no port, no tunnel, no
  auth, no claude.ai web. No change to `memex_mcp.py` (stdio already works).
- No forced auto-registration. Default is "show + copy the command"; running it
  is one explicit optional button, not automatic (owner: "그냥 알려줘").
- No bundling/packaging changes for an installed `.app` (see Limitations).

## Architecture

```
Settings → "MCP Server" panel
   ├─ mcp_registration_info()  ──> { installed, python, script, command, desktop_json }
   ├─ [Install] ─ mcp_install() ──> runs `bash mcp-server/install.sh` (creates venv)
   └─ [Register to Claude Code] (optional) ─ mcp_register() ──> runs the add command

Claude Code / Desktop  ── stdio (spawns) ──>  <venv python> memex_mcp.py
   (registered once; works with the Memex app closed)
```

## Components

### 1. Path resolution (Rust, `mcp_server.rs`)

Resolve the repo root (where `mcp-server/` lives) and derive:

- `script` = `<repo>/mcp-server/memex_mcp.py`
- `python` = `<repo>/mcp-server/.venv/bin/python` (the venv entry install.sh
  creates)
- `installed` = both `script` and `python` exist
- `command` = `claude mcp add --scope user memex -- "<python>" "<script>"`
- `desktop_json` = the `mcpServers.memex` block (`command` + `args`) for
  `claude_desktop_config.json`

Repo-root resolution for v1 (source checkout): derive from the app's known
project location (the app source is `<repo>/app`); resolve `<repo>/mcp-server`.
If `mcp-server/` cannot be found, `mcp_registration_info` returns
`installed=false` with a "MCP server files not found" reason rather than
emitting a wrong path.

### 2. Tauri IPC commands (`commands.rs` + `lib.rs`)

- `mcp_registration_info() -> McpRegInfo { installed, python, script, command, desktop_json, found }`
- `mcp_install() -> Result<String, String>` — run `bash mcp-server/install.sh`
  (reuse child-spawn + `augmented_path`); return stdout tail or the error. This
  creates the venv and installs deps.
- `mcp_register() -> Result<String, String>` (optional, behind a button) — run
  the computed `claude mcp add …`; requires the `claude` CLI (located via
  `locate_bin`). If `claude` is missing, the button is disabled with a note.

No new `Settings` struct fields are required (nothing is persisted; paths are
derived live).

### 3. Settings UI — "MCP Server" section (`PageSettings.tsx` + a tab)

- **Installed state** (`info.installed == true`):
  - The `claude mcp add memex -- …` command in a code box + copy button.
  - The Claude Desktop config JSON in a code box + copy button, with the config
    file path per OS (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`).
  - A short "works even when this app is closed" note.
  - Optional **Register to Claude Code** button (`mcp_register`); disabled if
    `claude` CLI absent.
- **Not-installed state** (`info.installed == false`):
  - Explanation + an **Install** button (`mcp_install`) showing progress and the
    result; on success, re-query `mcp_registration_info` and switch to the
    installed state. Never fail silently — show stderr on failure.
- New i18n keys (en/ko/ja) for all visible strings.

## Data flow

1. User opens Settings → MCP Server. App calls `mcp_registration_info`.
2. If not installed → Install button runs `install.sh` (venv + deps).
3. App shows the exact `claude mcp add` command + Desktop JSON; user copies and
   registers once (or clicks the optional Register button).
4. Thereafter Claude Code / Desktop spawn `memex_mcp.py` over stdio per session;
   tools resolve the active project via `projects.json`. The Memex app need not
   be running.

## Error handling

- **python / venv missing**: `installed=false`; Install button offered;
  `install.sh` failures surface stderr.
- **`claude` CLI missing**: optional Register button disabled with a note; the
  copy-command path still works (user runs it wherever `claude` is available).
- **mcp-server/ not found** (e.g. unexpected layout): `found=false`, clear
  message; no wrong path emitted.
- No swallowed errors; every failure reaches the Settings UI.

## Security

- stdio, fully local: the client spawns the server as a child; nothing listens
  on any network socket. No exposure, no auth needed.
- Existing write guards (`add_raw_source` overwrite refusal, `is_protected_raw`,
  `_safe_wiki_path`) are unchanged.

## Verification items (confirm during implementation; avoid assumptions)

1. Exact `claude mcp add` syntax/flags for the target Claude Code version
   (`--scope user`, `--` separator, command + args) — shown verbatim in the UI.
2. Claude Desktop config file path on the user's OS and the exact JSON shape.
3. `install.sh` runs non-interactively when invoked from the app's spawned
   shell (PATH via `augmented_path`; `python3` present).

## Limitations (v1)

- Targets the **source-checkout** layout (running from the repo, as today): the
  app resolves `<repo>/mcp-server`. A packaged/installed `.app` does not bundle
  `mcp-server/` or a writable venv location; supporting that (bundle as a Tauri
  resource + venv in app-data) is a separate follow-up.
- Server root stays the repo (active project via `projects.json`); vaults
  outside the repo are not served (same as the existing server).

## Testing

- **Rust unit (`mcp_server.rs`)**: command-string assembly produces the expected
  `claude mcp add --scope user memex -- "<python>" "<script>"`; `installed`
  detection is false when the venv path is absent; Desktop JSON shape matches.
- **Manual acceptance** (the real proof): see Success criteria — register via the
  copied command, confirm `claude mcp list` shows memex, call a tool, and verify
  it works with the Memex app closed.

## Success criteria

1. Settings → MCP Server shows the correct, machine-specific
   `claude mcp add memex -- …` command and Desktop JSON; copy buttons work.
2. With the venv absent, the Install button creates it and the panel flips to
   the installed state; failures show stderr, never a silent no-op.
3. After registering with the copied command, `claude mcp list` shows `memex`
   connected and `stats` returns data in a Claude Code session.
4. MCP tools keep working in Claude Code / Desktop with the Memex app closed.
5. Existing `python memex_mcp.py` stdio usage and `install.sh` are unchanged.
