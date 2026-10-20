#!/usr/bin/env python3
"""Legacy auto-ingest orchestration; the unchecked CLI route is unavailable.

Use myco's local import workflow. These helpers retain an injected runner for
synthetic regression tests; they are not a checked native publication adapter.

Design:
- `_inbox/` is the drop zone (separate from `raw/`, which stays immutable).
- With an explicitly injected test runner, each source gets a new raw file.
- Every created raw file is retained after failure, including partial wiki
  writes, timeout and missing transport; references must keep source backing.
- Injected success/change checks do not prove meaning or native authority.

Usage:
    python automation/autoingest.py --vault ~/Documents/Memex --once
    python automation/autoingest.py --vault ~/Documents/Memex --interval 3600
These historical commands now report unavailable. See automation/README.md.
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
QUARANTINE_DIRNAME = "quarantine"

# Redaction gate (Q4 item 13). automation/ imports nothing from the app, so
# this is a second copy — kept in sync with
# app/src-tauri/src/importers/secrets_scan.rs (SECRET_PATTERNS / PII_PATTERNS).
SECRET_PATTERNS: "list[tuple[str, re.Pattern]]" = [
    ("AWS access key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("OpenAI/Anthropic-style API key", re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b")),
    ("GitHub token", re.compile(r"\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b")),
    ("Slack token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b")),
    ("Google API key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("Private key block", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
]
PII_PATTERNS: "list[tuple[str, re.Pattern]]" = [
    ("Email address", re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")),
    ("KR phone number", re.compile(r"\b01[016789][-. ]?\d{4}[-. ]?\d{4}\b")),
    ("KR resident registration number", re.compile(r"\b\d{6}-[1-4]\d{6}\b")),
]


def scan_secrets(text: str) -> "list[str]":
    """Names of secret patterns found in `text`. Pure; empty = clean."""
    return [name for name, pat in SECRET_PATTERNS if pat.search(text)]


def scan_pii(text: str) -> "list[str]":
    """Names of PII patterns found in `text`. Pure; empty = clean."""
    return [name for name, pat in PII_PATTERNS if pat.search(text)]
# Tools the ingest agent may use. Deliberately NO Bash: _inbox content is
# untrusted, mirroring the app's hardened default (see claude.rs).
DEFAULT_TOOLS = "Read,Write,Edit,Glob,Grep"
DEFAULT_MODEL = "haiku"
DEFAULT_TIMEOUT = 600
LEGACY_UNAVAILABLE = (
    "Legacy CLI auto-ingest is unavailable until a checked publisher is implemented. "
    "Use the local import workflow in myco."
)

# Read straight through; extract via the app binary; or skip.
TEXT_EXTS = {".md", ".txt", ".markdown", ".csv", ".tsv", ".json", ".yaml", ".yml", ".html", ""}
EXTRACT_EXTS = {".pdf", ".xlsx", ".xls", ".xlsm", ".xlsb", ".ods", ".docx", ".pptx"}

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
    """Reject the deprecated unchecked route without spawning a process."""
    return 126, "", LEGACY_UNAVAILABLE


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
    pii_quarantine: bool = False,
) -> dict:
    """Ingest one inbox source. Returns a result dict (ok / error + details)."""
    if run_claude is default_run_claude:
        return {"ok": False, "source": source.name, "status": "unavailable", "error": LEGACY_UNAVAILABLE}
    text = _read_source(source, app_bin)
    if text is None:
        return {"ok": False, "source": source.name, "error": f"unsupported or unreadable: {source.name}"}

    # Redaction gate (Q4 item 13): scan BEFORE anything touches raw/. Secrets
    # always quarantine; PII quarantines only under --pii-quarantine. The
    # source moves to _inbox/quarantine/ (it would otherwise loop every pass)
    # and nothing is written to raw/, which is immutable and git-committed.
    # Kept in sync with app/src-tauri/src/mcp_native.rs (raw_source_guard).
    hits, kind = scan_secrets(text), "secrets"
    if not hits and pii_quarantine:
        hits, kind = scan_pii(text), "PII"
    if hits:
        dest = _quarantine(source)
        return {
            "ok": False,
            "quarantined": str(dest.relative_to(vault)),
            "source": source.name,
            "error": f"possible {kind} ({', '.join(hits)}) — moved to _inbox/{QUARANTINE_DIRNAME}/, nothing written to raw/",
        }

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
        return {
            "ok": False, "source": source.name, "raw": str(raw_path.relative_to(vault)),
            "error": "claude CLI not found on PATH",
        }
    after = _wiki_signature(vault)
    changed = after != before

    if rc == 0 and changed:
        _archive(source)
        return {"ok": True, "source": source.name, "slug": slug, "raw": str(raw_path.relative_to(vault))}

    # A failed runner can already have cited this raw file in partial writes.
    # Preserve both the immutable backing and the pending inbox source.
    detail = (err or out or "ingest produced no wiki change").strip()
    return {
        "ok": False, "source": source.name, "raw": str(raw_path.relative_to(vault)),
        "error": detail[:200],
    }


def _archive(source: Path) -> None:
    archive = source.parent / ARCHIVE_DIRNAME
    archive.mkdir(exist_ok=True)
    dest = archive / source.name
    n = 2
    while dest.exists():
        dest = archive / f"{source.stem}-{n}{source.suffix}"
        n += 1
    source.rename(dest)


def _quarantine(source: Path) -> Path:
    """Move a flagged source into `_inbox/quarantine/` (never deleted)."""
    qdir = source.parent / QUARANTINE_DIRNAME
    qdir.mkdir(parents=True, exist_ok=True)
    dest = qdir / source.name
    n = 2
    while dest.exists():
        dest = qdir / f"{source.stem}-{n}{source.suffix}"
        n += 1
    source.rename(dest)
    return dest


def run_once(vault: Path, *, logger: Callable[[str], None] | None = None, **kw) -> list[dict]:
    """One pass: ingest every pending source. Returns per-source results."""
    if kw.get("run_claude", default_run_claude) is default_run_claude:
        raise RuntimeError(LEGACY_UNAVAILABLE)
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
        elif "quarantined" in res:
            log(f"{_now()}   quarantined  {res['source']} -> {res['quarantined']}")
        else:
            log(f"{_now()}   FAIL  {res['source']}: {res['error']}")
    _append_log(vault, results)
    return results


def run_daemon(vault: Path, interval: int, *, logger: Callable[[str], None] | None = None, **kw) -> None:
    """Loop forever: run a pass, then sleep `interval` seconds."""
    if kw.get("run_claude", default_run_claude) is default_run_claude:
        raise RuntimeError(LEGACY_UNAVAILABLE)
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
    ap.add_argument(
        "--pii-quarantine",
        action="store_true",
        help="Quarantine sources containing PII (email / KR phone / RRN), not just secrets",
    )
    ap.add_argument("--interval", type=int, default=0, help="Seconds between passes (0 or --once = one pass)")
    ap.add_argument("--once", action="store_true", help="Run a single pass and exit")
    ap.parse_args(argv)
    print(f"error: {LEGACY_UNAVAILABLE}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
