#!/usr/bin/env bash
# Run the Memex MCP server as a standalone HTTP/SSE server (Obsidian style).
#
# Start it once and leave it running; every Claude session then connects over
# SSE — no per-session subprocess, no absolute paths in the client config.
#
# Usage:
#   bash mcp-server/serve.sh              # http://127.0.0.1:22360/sse
#   bash mcp-server/serve.sh --port 9001  # custom port
#
# Then register (once):
#   claude mcp add --transport sse memex http://localhost:22360/sse
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="${HERE}/.venv"
PY_BIN="${PYTHON:-python3}"

# Bootstrap the venv on first run.
if [ ! -x "${VENV}/bin/python" ]; then
    echo "[memex-mcp] creating venv at ${VENV}"
    "${PY_BIN}" -m venv "${VENV}"
    # shellcheck disable=SC1091
    source "${VENV}/bin/activate"
    pip install --quiet --upgrade pip
    pip install --quiet -r "${HERE}/requirements.txt"
else
    # shellcheck disable=SC1091
    source "${VENV}/bin/activate"
fi

exec "${VENV}/bin/python" "${HERE}/memex_mcp.py" --sse "$@"
