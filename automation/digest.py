#!/usr/bin/env python3
"""Memex digest runner — the app-CLOSED half of recurring schedules (Feature 7).

The desktop app fires due schedules with its in-app timer while it's open; this
standalone runner is what a launchd/cron job invokes so a digest still runs when
the app is closed. It reads the vault's `.memex/schedules.json`, builds the
prompt for one schedule, runs the user's `claude` CLI (their subscription — no
API key) with the hardened Read/Grep/Glob toolset (never Bash), writes a plain
markdown note into `digests/`, and stamps `last_run`.

Usage:
    python -m automation.digest --vault ~/Documents/Memex --schedule <id>
    python -m automation.digest --vault ~/Documents/Memex --schedule <id> --dry-run

`--dry-run` prints the prompt it WOULD send and exits without calling claude or
writing anything — so the wiring is verifiable without a subscription.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

# Read-only toolset: a digest never mutates the wiki, only summarizes it.
DEFAULT_TOOLS = "Read,Grep,Glob"
DEFAULT_TIMEOUT = 600

SYSTEM = (
    "You are Memex's digest writer. Produce a concise, well-structured markdown "
    "digest grounded ONLY in the user's wiki (use Read/Grep/Glob to look things "
    "up). Cite pages inline as [[page-stem]]. Do not invent sources."
)

# (vault, prompt, tools, timeout) -> (returncode, stdout, stderr)
RunClaude = Callable[[Path, str, str, int], "tuple[int, str, str]"]


def slugify(name: str) -> str:
    s = re.sub(r"[^\w\s-]", "", (name or "").lower(), flags=re.UNICODE)
    s = re.sub(r"[\s_]+", "-", s)
    s = re.sub(r"-+", "-", s).strip("-")
    return s or "digest"


def schedules_path(vault: Path) -> Path:
    return vault / ".memex" / "schedules.json"


def load_schedule(vault: Path, sid: str) -> dict | None:
    path = schedules_path(vault)
    try:
        data = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return None
    for s in data if isinstance(data, list) else []:
        if s.get("id") == sid:
            return s
    return None


def git_log(vault: Path) -> str:
    """Recent commit log for the `changed` kind (empty string if not a repo)."""
    try:
        proc = subprocess.run(
            ["git", "log", "-20", "--pretty=format:- %ad %s", "--date=short"],
            cwd=str(vault),
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return proc.stdout.strip() if proc.returncode == 0 else ""


def build_prompt(sched: dict, git_log_text: str) -> str:
    kind = sched.get("kind", "query")
    if kind == "changed":
        return (
            "Summarize what changed in the wiki recently, grouping related edits "
            "and highlighting new or substantially updated pages. Recent commits:\n\n"
            + (git_log_text or "(no git history available)")
        )
    if kind == "stale":
        return (
            "Review the wiki for maintenance needs: orphan pages (no links), "
            "under-cited claims, and any contradictions between pages. List the "
            "weakest pages with a concrete next action for each."
        )
    if kind == "topic":
        return (
            f"Gather and summarize what the wiki currently says about: "
            f"{sched.get('prompt', '')}. Note gaps worth researching next."
        )
    return sched.get("prompt", "")


def format_note(sched: dict, body: str, date_iso: str) -> str:
    title = sched.get("title", "Digest")
    return (
        "---\n"
        f"title: {json.dumps(title)}\n"
        f"kind: {sched.get('kind', 'query')}\n"
        f"schedule: {sched.get('id', '')}\n"
        f"generated: {date_iso}\n"
        "---\n\n"
        f"# {title}\n\n"
        f"{body.strip()}\n"
    )


def digest_path(vault: Path, sched: dict, date_iso: str) -> Path:
    out_dir = sched.get("output_dir") or "digests"
    day = date_iso[:10]
    return vault / out_dir / f"{day}-{slugify(sched.get('title', 'digest'))}.md"


def resolve_claude() -> str | None:
    """Locate the claude CLI robustly. launchd/cron give a stripped PATH that
    usually lacks ~/.local/bin, Homebrew, etc., so we augment PATH with the
    common install dirs (and honor MEMEX_CLAUDE_PATH) before probing — mirroring
    the desktop app's Rust PATH-augmentation."""
    override = os.environ.get("MEMEX_CLAUDE_PATH")
    if override and Path(override).is_file():
        return override
    home = os.path.expanduser("~")
    extra = [
        f"{home}/.local/bin",
        f"{home}/.claude/local",
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
    ]
    path = os.environ.get("PATH", "")
    os.environ["PATH"] = os.pathsep.join([*extra, *path.split(os.pathsep)])
    return shutil.which("claude")


def default_run_claude(
    vault: Path, prompt: str, tools: str, timeout: int
) -> "tuple[int, str, str]":
    claude = resolve_claude()
    if not claude:
        return (127, "", "claude CLI not found (set MEMEX_CLAUDE_PATH or add it to PATH)")
    proc = subprocess.run(
        [claude, "--print", "--allowedTools", tools],
        input=f"{SYSTEM}\n\n{prompt}",
        cwd=str(vault),
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    return proc.returncode, proc.stdout, proc.stderr


def stamp_last_run(vault: Path, sid: str, now_epoch: int) -> None:
    """Best-effort update of last_run in schedules.json (atomic-ish rewrite)."""
    path = schedules_path(vault)
    try:
        data = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return
    if not isinstance(data, list):
        return
    for s in data:
        if s.get("id") == sid:
            s["last_run"] = now_epoch
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2) + "\n", "utf-8")
    tmp.replace(path)


def run(
    vault: Path,
    sid: str,
    *,
    now: datetime,
    dry_run: bool = False,
    run_claude: RunClaude = default_run_claude,
    timeout: int = DEFAULT_TIMEOUT,
) -> dict:
    sched = load_schedule(vault, sid)
    if sched is None:
        return {"ok": False, "error": f"schedule not found: {sid}"}
    prompt = build_prompt(sched, git_log(vault) if sched.get("kind") == "changed" else "")
    if dry_run:
        return {"ok": True, "dry_run": True, "prompt": prompt}
    code, out, err = run_claude(vault, prompt, DEFAULT_TOOLS, timeout)
    if code != 0 or not out.strip():
        return {"ok": False, "error": (err or "empty response").strip()[:400]}
    date_iso = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    note_path = digest_path(vault, sched, date_iso)
    note_path.parent.mkdir(parents=True, exist_ok=True)
    note_path.write_text(format_note(sched, out.strip(), date_iso), "utf-8")
    stamp_last_run(vault, sid, int(now.timestamp()))
    return {"ok": True, "path": str(note_path)}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Run a Memex digest schedule.")
    ap.add_argument("--vault", required=True)
    ap.add_argument("--schedule", required=True)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)
    result = run(
        Path(args.vault).expanduser(),
        args.schedule,
        now=datetime.now(timezone.utc),
        dry_run=args.dry_run,
    )
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
