#!/usr/bin/env bash
# Bootstrap the myco MCP server in a local venv and print the
# `claude mcp add` command tuned to this checkout.
#
# Usage:
#   bash mcp-server/install.sh
#
# After this prints the command, run it to register myco with Claude Code.
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
    echo "[myco-mcp] creating venv at ${VENV}"
    "${PY_BIN}" -m venv "${VENV}"
fi

# shellcheck disable=SC1091
source "${VENV}/bin/activate"
pip install --quiet --upgrade pip
pip install --quiet -r "${HERE}/requirements.txt"

ENTRY="${VENV}/bin/python"
SCRIPT="${HERE}/myco_mcp.py"
PORT="${MYCO_MCP_PORT:-22360}"

echo
echo "[myco-mcp] installed."
echo
echo "════════════════════════════════════════════════════════════════════"
echo " Recommended: run as a standalone SSE server (Obsidian style)"
echo "════════════════════════════════════════════════════════════════════"
echo
echo "1. Start the server (leave it running):"
echo
echo "     bash ${HERE}/serve.sh"
echo
echo "2. Register it with Claude Code — ONE line, no paths:"
echo
echo "     claude mcp add --transport sse myco http://localhost:${PORT}/sse"
echo
echo "   For Claude Desktop, add to claude_desktop_config.json:"
cat <<JSON
     {
       "mcpServers": {
         "myco": { "url": "http://localhost:${PORT}/sse" }
       }
     }
JSON
echo
echo "────────────────────────────────────────────────────────────────────"
echo " Alternative: stdio (Claude spawns the process per session)"
echo "────────────────────────────────────────────────────────────────────"
echo
echo "     claude mcp add --scope user myco -- \"${ENTRY}\" \"${SCRIPT}\""
echo
