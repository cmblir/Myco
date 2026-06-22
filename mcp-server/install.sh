#!/usr/bin/env bash
# Bootstrap the Memex MCP server in a local venv and print the
# `claude mcp add` command tuned to this checkout.
#
# Usage:
#   bash mcp-server/install.sh
#
# After this prints the command, run it to register Memex with Claude Code.
# For Claude Desktop, copy the JSON snippet from mcp-server/README.md.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${HERE}/.." && pwd)"
VENV="${HERE}/.venv"
PY_BIN="${PYTHON:-python3}"

if ! command -v "${PY_BIN}" >/dev/null 2>&1; then
    echo "error: ${PY_BIN} not found on PATH" >&2
    exit 1
fi

if [ ! -d "${VENV}" ]; then
    echo "[memex-mcp] creating venv at ${VENV}"
    "${PY_BIN}" -m venv "${VENV}"
fi

# shellcheck disable=SC1091
source "${VENV}/bin/activate"
pip install --quiet --upgrade pip
pip install --quiet -r "${HERE}/requirements.txt"

ENTRY="${VENV}/bin/python"
SCRIPT="${HERE}/memex_mcp.py"

echo
echo "[memex-mcp] installed."
echo
echo "Register with Claude Code (user scope, available in every session):"
echo
echo "  claude mcp add --scope user memex -- \"${ENTRY}\" \"${SCRIPT}\""
echo
echo "Or project scope (only when CWD is inside this repo):"
echo
echo "  claude mcp add --scope project memex -- \"${ENTRY}\" \"${SCRIPT}\""
echo
echo "For Claude Desktop, add this to claude_desktop_config.json:"
cat <<JSON
  {
    "mcpServers": {
      "memex": {
        "command": "${ENTRY}",
        "args": ["${SCRIPT}"]
      }
    }
  }
JSON
echo
