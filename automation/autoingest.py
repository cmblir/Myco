#!/usr/bin/env python3
"""Memex auto-ingest — scheduled inbox watcher.

Watches a vault's `_inbox/` folder and ingests pending source files into the
wiki on a schedule, using the user's own `claude` CLI (their Pro/Max
subscription — no API key, no per-token billing). Drop a file into `_inbox/`,
and the next pass turns it into wiki pages with citations following CLAUDE.md.

Design:
- `_inbox/` is the drop zone (separate from `raw/`, which stays immutable).
- Each source is written to `raw/<slug>.md` (a NEW file — raw/ is never
  modified), then the claude CLI is run with cwd = vault to ingest it.
- Ingest tools are Read/Write/Edit/Glob/Grep — NOT Bash — matching the app's
  hardened default, since `_inbox/` content is untrusted.
- On success the original is moved to `_inbox/.archived/` (never deleted), so
  nothing is lost. On failure it stays in `_inbox/` to retry next pass, and the
  raw/ file this run created is rolled back.

Usage:
    python automation/autoingest.py --vault ~/Documents/Memex --once
    python automation/autoingest.py --vault ~/Documents/Memex --interval 3600
See automation/README.md for crontab / launchd setup.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

INBOX_DIRNAME = "_inbox"
ARCHIVE_DIRNAME = ".archived"
# Tools the ingest agent may use. Deliberately NO Bash: _inbox content is
# untrusted, mirroring the app's hardened default (see claude.rs).
DEFAULT_TOOLS = "Read,Write,Edit,Glob,Grep"
DEFAULT_MODEL = "haiku"
DEFAULT_TIMEOUT = 600

# Read straight through; extract via the app binary; or skip.
TEXT_EXTS = {".md", ".txt", ".markdown", ".csv", ".tsv", ".json", ".yaml", ".yml", ".html", ""}
EXTRACT_EXTS = {".pdf", ".xlsx", ".xls", ".xlsm", ".ods"}

# Type of the injectable CLI runner: (vault, prompt, model, tools, timeout)
#   -> (returncode, stdout, stderr)
RunClaude = Callable[[Path, str, str, str, int], "tuple[int, str, str]"]

INGEST_PROMPT = (
    'A new source has been added at `raw/{slug}.md` (title: "{title}"). '
    "Ingest it into the wiki following the workflow in CLAUDE.md:\n"
    "1. Read the source completely.\n"
    "2. Update existing pages with inline [^src-{slug}] citations, or create new "
    "pages with the required frontmatter.\n"
    "3. Create the source-summary page `wiki/source-{slug}.md`.\n"
    "4. Update `wiki/index.md` and append a `wiki/log.md` entry.\n"
    "5. Write an ingest report under `ingest-reports/`.\n"
    "Output a one-line confirmation when done."
)


def find_pending(vault: Path) -> list[Path]:
    """Source files waiting in `_inbox/` (skips dotfiles and the archive)."""
    inbox = vault / INBOX_DIRNAME
    if not inbox.is_dir():
        return []
    return sorted(
        p for p in inbox.iterdir() if p.is_file() and not p.name.startswith(".")
    )


def slugify(name: str) -> str:
    s = re.sub(r"[^\w\s-]", "", name.lower(), flags=re.UNICODE)
    s = re.sub(r"[\s_]+", "-", s)
    s = re.sub(r"-+", "-", s).strip("-")
    return s or f"source-{int(time.time())}"


def unique_raw_path(vault: Path, slug: str) -> Path:
    """A raw/<slug>.md path that does not collide with an existing file, so we
    only ever CREATE in raw/, never overwrite (raw/ is immutable)."""
    raw = vault / "raw"
    p = raw / f"{slug}.md"
    n = 2
    while p.exists():
        p = raw / f"{slug}-{n}.md"
        n += 1
    return p


def default_run_claude(
    vault: Path, prompt: str, model: str, tools: str, timeout: int
) -> "tuple[int, str, str]":
    """The proven CLI ingest path (matches the desktop app)."""
    proc = subprocess.run(
        ["claude", "--print", "--allowedTools", tools, "--model", model],
        input=prompt,
        cwd=str(vault),
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    return proc.returncode, proc.stdout, proc.stderr


def _read_source(source: Path, app_bin: str | None) -> str | None:
    """Source text: read text-like files directly; extract pdf/spreadsheet via
    the Memex app binary (`--extract-text`) when available; otherwise skip."""
    ext = source.suffix.lower()
    if ext in TEXT_EXTS:
        try:
            return source.read_text("utf-8", errors="replace")
        except OSError:
            return None
    if ext in EXTRACT_EXTS and app_bin:
        try:
            proc = subprocess.run(
                [app_bin, "--extract-text", str(source)],
                capture_output=True,
                text=True,
                timeout=180,
            )
        except (OSError, subprocess.TimeoutExpired):
            return None
        if proc.returncode == 0 and proc.stdout.strip():
            return proc.stdout
        return None
    return None


def _wiki_signature(vault: Path) -> "tuple[int, int]":
    """(file count, total bytes) of wiki/ — used to detect that an ingest
    actually changed the wiki (mirrors the app's wikiChanged check)."""
    wiki = vault / "wiki"
    if not wiki.is_dir():
        return (0, 0)
    files = list(wiki.rglob("*.md"))
    return (len(files), sum(f.stat().st_size for f in files if f.is_file()))


def ingest_one(
    vault: Path,
    source: Path,
    *,
    model: str = DEFAULT_MODEL,
    tools: str = DEFAULT_TOOLS,
    app_bin: str | None = None,
    timeout: int = DEFAULT_TIMEOUT,
    run_claude: RunClaude = default_run_claude,
) -> dict:
    """Ingest one inbox source. Returns a result dict (ok / error + details)."""
    text = _read_source(source, app_bin)
    if text is None:
        return {"ok": False, "source": source.name, "error": f"unsupported or unreadable: {source.name}"}

    title = source.stem.replace("-", " ").replace("_", " ").strip().title() or source.stem
    raw_path = unique_raw_path(vault, slugify(source.stem))
    slug = raw_path.stem
    raw_path.parent.mkdir(parents=True, exist_ok=True)
    raw_path.write_text(text, encoding="utf-8")

    before = _wiki_signature(vault)
    prompt = INGEST_PROMPT.format(slug=slug, title=title)
    try:
        rc, out, err = run_claude(vault, prompt, model, tools, timeout)
    except subprocess.TimeoutExpired:
        rc, out, err = 124, "", f"timed out after {timeout}s"
    except FileNotFoundError:
        # roll back our raw/ write so nothing is left dangling
        _safe_unlink(raw_path)
        return {"ok": False, "source": source.name, "error": "claude CLI not found on PATH"}
    after = _wiki_signature(vault)
    changed = after != before

    if rc == 0 and changed:
        _archive(source)
        return {"ok": True, "source": source.name, "slug": slug, "raw": str(raw_path.relative_to(vault))}

    # Failed or no-op: roll back the raw/ file WE created and leave the source
    # in _inbox for the next pass.
    _safe_unlink(raw_path)
    detail = (err or out or "ingest produced no wiki change").strip()
    return {"ok": False, "source": source.name, "error": detail[:200]}


def _archive(source: Path) -> None:
    archive = source.parent / ARCHIVE_DIRNAME
    archive.mkdir(exist_ok=True)
    dest = archive / source.name
    n = 2
    while dest.exists():
        dest = archive / f"{source.stem}-{n}{source.suffix}"
        n += 1
    source.rename(dest)


def _safe_unlink(p: Path) -> None:
    try:
        p.unlink()
    except OSError:
        pass


def run_once(vault: Path, *, logger: Callable[[str], None] | None = None, **kw) -> list[dict]:
    """One pass: ingest every pending source. Returns per-source results."""
    log = logger or (lambda _m: None)
    results: list[dict] = []
    pending = find_pending(vault)
    if not pending:
        return results
    log(f"{_now()} pass: {len(pending)} pending source(s)")
    for src in pending:
        res = ingest_one(vault, src, **kw)
        results.append(res)
        if res["ok"]:
            log(f"{_now()}   ok    {res['source']} -> {res['raw']}")
        else:
            log(f"{_now()}   FAIL  {res['source']}: {res['error']}")
    _append_log(vault, results)
    return results


def run_daemon(vault: Path, interval: int, *, logger: Callable[[str], None] | None = None, **kw) -> None:
    """Loop forever: run a pass, then sleep `interval` seconds."""
    log = logger or print
    log(f"{_now()} auto-ingest watching {vault / INBOX_DIRNAME} every {interval}s")
    while True:
        try:
            run_once(vault, logger=log, **kw)
        except Exception as e:  # never let one bad pass kill the daemon
            log(f"{_now()} pass error: {e}")
        time.sleep(interval)


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _append_log(vault: Path, results: list[dict]) -> None:
    """Append a JSONL record of this pass for monitoring."""
    if not results:
        return
    log_file = vault / INBOX_DIRNAME / "autoingest.log.jsonl"
    try:
        with log_file.open("a", encoding="utf-8") as f:
            for r in results:
                f.write(json.dumps({"ts": _now(), **r}, ensure_ascii=False) + "\n")
    except OSError:
        pass


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Memex auto-ingest inbox watcher")
    ap.add_argument("--vault", required=True, help="Path to the Memex vault")
    ap.add_argument("--model", default=DEFAULT_MODEL, help="claude CLI model (default: haiku)")
    ap.add_argument("--tools", default=DEFAULT_TOOLS, help="claude --allowedTools (no Bash by default)")
    ap.add_argument("--app-bin", default=None, help="Path to the Memex binary for PDF/spreadsheet extraction")
    ap.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT, help="Per-ingest timeout seconds")
    ap.add_argument("--interval", type=int, default=0, help="Seconds between passes (0 or --once = one pass)")
    ap.add_argument("--once", action="store_true", help="Run a single pass and exit")
    args = ap.parse_args(argv)

    vault = Path(args.vault).expanduser()
    if not vault.is_dir():
        print(f"error: vault is not a directory: {vault}", file=sys.stderr)
        return 2
    (vault / INBOX_DIRNAME).mkdir(exist_ok=True)

    kw = dict(model=args.model, tools=args.tools, app_bin=args.app_bin, timeout=args.timeout)
    if args.once or args.interval <= 0:
        results = run_once(vault, logger=print, **kw)
        ok = sum(1 for r in results if r["ok"])
        print(f"{_now()} done: {ok}/{len(results)} ingested")
        return 0
    run_daemon(vault, args.interval, logger=print, **kw)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
