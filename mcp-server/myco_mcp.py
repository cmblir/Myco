#!/usr/bin/env python3
"""myco MCP server.

Exposes the myco wiki vault as a set of MCP tools so Claude (Desktop, Code,
or any MCP client) can read, search, and maintain the wiki directly.

Design notes
------------
- Standalone: this file is the only entry point. Two transports (see `main`):
  a standalone SSE server (`--sse`, the recommended Obsidian-style setup —
  `claude mcp add --transport sse myco http://localhost:22360/sse`) or stdio
  (default; Claude spawns it per session).
- Uses the sibling `project_registry` module (no side effects) to resolve the
  project layout (legacy or multi-project under `projects/<slug>/`).
- raw/ is immutable: `add_raw_source` refuses to overwrite. wiki/ is writable.
"""

from __future__ import annotations

import difflib
import hmac
import json
import math
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# ─── locate repo + import the sibling project_registry module ────────────────

# Data root resolution lives in project_registry (active-vault marker → env →
# checkout fallback). Import the sibling module first, then mirror its
# PROJECT_ROOT so both modules agree on exactly one vault location.
_THIS_DIR = Path(__file__).resolve().parent
if str(_THIS_DIR) not in sys.path:
    sys.path.insert(0, str(_THIS_DIR))

import project_registry  # type: ignore  # noqa: E402

REPO_ROOT = project_registry.PROJECT_ROOT

# ─── MCP SDK ─────────────────────────────────────────────────────────────────

try:
    from mcp.server.fastmcp import FastMCP
except ImportError:
    sys.stderr.write(
        "myco-mcp: missing dependency. Install with:\n"
        "  pip install --user 'mcp>=1.0' \n"
        "or use the bundled install script:\n"
        f"  bash {Path(__file__).parent / 'install.sh'}\n"
    )
    raise

mcp = FastMCP(
    "myco",
    instructions=(
        "myco is a self-maintaining LLM wiki backed by an Obsidian vault. "
        "Use `get_instructions` once per session to load the wiki schema "
        "(frontmatter rules, citation format, contradiction policy). "
        "Then use the read tools (list_pages, read_page, search) to browse "
        "and the write tools (add_raw_source, create_page, update_page) to "
        "maintain. Never modify files under any raw/ directory; raw is "
        "immutable. Commit groups of related changes with git_commit. "
        "To auto-ingest a backlog: call list_inbox, then for each pending file "
        "read_inbox_source -> create/update wiki pages with [^src-*] citations "
        "-> archive_inbox_source. Repeat until the inbox is empty."
    ),
)

# ─── small helpers (kept local to keep this server lean) ─────────────────────

FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)
WIKILINK_RE = re.compile(r"\[\[([^\]|]+)(?:\|[^\]]*)?\]\]")
WORD_RE = re.compile(r"[\w가-힣]+")

# Secret patterns (SEC-03): high-signal token shapes only — generic "password="
# style matches would drown real hits in prose false positives.
# Kept in sync with app/src-tauri/src/importers/secrets_scan.rs and
# automation/autoingest.py (SECRET_PATTERNS).
SECRET_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("AWS access key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("OpenAI/Anthropic-style API key", re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b")),
    ("GitHub token", re.compile(r"\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b")),
    ("Slack token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b")),
    ("Google API key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("Private key block", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
]


def scan_secrets(text: str) -> list[str]:
    """Names of secret patterns found in `text` (SEC-03). Pure; empty = clean."""
    return [name for name, pat in SECRET_PATTERNS if pat.search(text)]


# PII patterns (Q4 item 13) — a softer tier than credentials: written with a
# warning by default, refused when the app's pii_quarantine_enabled setting is
# on. Kept in sync with app/src-tauri/src/importers/secrets_scan.rs
# (pii_patterns) and automation/autoingest.py (PII_PATTERNS).
PII_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("Email address", re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")),
    ("KR phone number", re.compile(r"\b01[016789][-. ]?\d{4}[-. ]?\d{4}\b")),
    ("KR resident registration number", re.compile(r"\b\d{6}-[1-4]\d{6}\b")),
]


def scan_pii(text: str) -> list[str]:
    """Names of PII patterns found in `text` (Q4 item 13). Pure; empty = clean."""
    return [name for name, pat in PII_PATTERNS if pat.search(text)]


def _pii_quarantine_enabled() -> bool:
    """The app's `pii_quarantine_enabled` setting — one source of truth, read
    from the same settings.json the desktop app writes. Missing/unreadable ⇒
    warn-only, matching the Rust default."""
    try:
        cfg = json.loads(
            (project_registry._app_data_dir() / "settings.json").read_text("utf-8")
        )
        return bool(cfg.get("pii_quarantine_enabled", False))
    except (OSError, ValueError):
        return False


def parse_fm(text: str) -> tuple[dict, str]:
    """Parse YAML-ish frontmatter, returning (meta, body).

    Supports scalar and list values.
    """
    meta: dict[str, Any] = {}
    m = FRONTMATTER_RE.match(text)
    if not m:
        return meta, text
    body = text[m.end():]
    raw = m.group(1)
    for ml in re.finditer(r"^(\w+):\s*\n((?:\s+-\s+.+\n?)+)", raw, re.MULTILINE):
        meta[ml.group(1)] = [
            x.strip().strip("'\"") for x in re.findall(r"-\s+(.+)", ml.group(2))
        ]
    for line in raw.strip().split("\n"):
        if ":" not in line or line.startswith("  "):
            continue
        k, v = line.split(":", 1)
        k, v = k.strip(), v.strip()
        if k in meta:
            continue
        lm = re.search(r"\[(.*?)\]", v)
        if lm:
            meta[k] = [x.strip().strip("'\"") for x in lm.group(1).split(",") if x.strip()]
        elif v:
            meta[k] = v.strip("'\"")
    return meta, body


def extract_links(body: str) -> list[str]:
    return sorted({
        m.group(1).strip() + (".md" if not m.group(1).strip().endswith(".md") else "")
        for m in WIKILINK_RE.finditer(body)
    })


def _resolve(project: str | None) -> "project_registry.Project":
    """Resolve project slug → Project. Empty/None falls back to active/legacy."""
    slug = (project or "").strip() or None
    return project_registry.get_project(slug)


def _rel_to_repo(p: Path) -> str:
    try:
        return str(p.resolve().relative_to(REPO_ROOT))
    except ValueError:
        return str(p)


def _safe_wiki_path(proj, filename: str) -> Path:
    """Resolve filename under wiki_dir and reject path traversal."""
    base = proj.wiki_dir.resolve()
    target = (proj.wiki_dir / filename).resolve()
    if base != target and base not in target.parents:
        raise ValueError(f"path escapes wiki/: {filename}")
    return target


def _safe_wiki_dir(proj, folder: str) -> Path:
    """Resolve a folder under wiki_dir and reject path traversal.

    A caller-supplied `folder` (e.g. on list_pages / create_page) must never
    escape wiki/ via `..` or an absolute path — otherwise it could read or write
    arbitrary directories on disk.
    """
    base = proj.wiki_dir.resolve()
    target = (proj.wiki_dir / folder).resolve() if folder else base
    if base != target and base not in target.parents:
        raise ValueError(f"folder escapes wiki/: {folder}")
    return target


def _safe_inbox_path(proj, filename: str) -> Path | None:
    """Resolve a filename inside the project's _inbox/ and reject path traversal.
    Returns None if the resolved path escapes _inbox/."""
    inbox = (proj.root / "_inbox").resolve()
    target = (proj.root / "_inbox" / filename).resolve()
    if inbox != target and inbox not in target.parents:
        return None
    return target


def _today() -> str:
    return datetime.now().strftime("%Y-%m-%d")


# ─── tools: project ──────────────────────────────────────────────────────────


@mcp.tool()
def list_projects() -> dict:
    """List all myco projects (multi-project) plus legacy if present.

    Returns the active project slug and an array of {slug, title, is_legacy,
    description, model, wiki_dir, raw_dir}. Use the slug as `project` in
    other tools, or pass an empty string to use the active project.
    """
    out: list[dict] = []
    for p in project_registry.list_projects():
        out.append({
            "slug": p.slug,
            "title": p.title,
            "is_legacy": p.is_legacy,
            "description": p.description,
            "model": p.model,
            "wiki_dir": _rel_to_repo(p.wiki_dir),
            "raw_dir": _rel_to_repo(p.raw_dir),
            "independent_vault": p.independent_vault,
        })
    legacy_info: dict | None = None
    if project_registry.LEGACY_WIKI.exists():
        try:
            lp = project_registry._legacy_project()  # type: ignore[attr-defined]
            legacy_info = {
                "slug": "",
                "title": lp.title,
                "is_legacy": True,
                "description": "Legacy single-project layout",
                "model": lp.model,
                "wiki_dir": _rel_to_repo(lp.wiki_dir),
                "raw_dir": _rel_to_repo(lp.raw_dir),
            }
        except Exception:
            pass
    return {
        "active": project_registry.get_active_slug(),
        "projects": out,
        "legacy": legacy_info,
        "has_projects": project_registry.has_projects(),
    }


@mcp.tool()
def get_instructions(project: str = "") -> dict:
    """Return the project's CLAUDE.md (wiki schema, citation rules, ingest workflow).

    Read this once at session start so you follow the wiki conventions for
    frontmatter, inline citations [^src-*], and contradiction resolution.
    """
    proj = _resolve(project)
    if not proj.claude_md.exists():
        return {"project": proj.slug, "found": False, "content": ""}
    return {
        "project": proj.slug,
        "found": True,
        "path": _rel_to_repo(proj.claude_md),
        "content": proj.claude_md.read_text("utf-8"),
    }


# ─── tools: wiki read ────────────────────────────────────────────────────────


@mcp.tool()
def stats(project: str = "") -> dict:
    """Return wiki counts: total pages, type distribution, raw source count, total links."""
    proj = _resolve(project)
    type_counts: dict[str, int] = {}
    pages = 0
    links = 0
    if proj.wiki_dir.exists():
        for md in proj.wiki_dir.rglob("*.md"):
            pages += 1
            text = md.read_text("utf-8")
            meta, body = parse_fm(text)
            t = meta.get("type", "unknown")
            type_counts[t] = type_counts.get(t, 0) + 1
            links += len(WIKILINK_RE.findall(body))
    raw_count = 0
    if proj.raw_dir.exists():
        for f in proj.raw_dir.rglob("*"):
            if f.is_file() and not f.name.startswith(".") and "assets" not in f.parts:
                raw_count += 1
    return {
        "project": proj.slug,
        "total_pages": pages,
        "raw_sources": raw_count,
        "type_counts": type_counts,
        "total_links": links,
    }


@mcp.tool()
def list_pages(
    project: str = "",
    type_filter: str = "",
    folder: str = "",
    limit: int = 200,
) -> dict:
    """List wiki pages with frontmatter summary.

    Args:
        project: Project slug. Empty for active/legacy.
        type_filter: Optional type to filter ("concept", "entity", "technique",
            "source-summary", "analysis", or any custom type).
        folder: Optional folder under wiki/ (relative). E.g. "concepts".
        limit: Cap on number of pages returned (default 200).
    """
    proj = _resolve(project)
    try:
        base = _safe_wiki_dir(proj, folder)
    except ValueError as e:
        return {"project": proj.slug, "pages": [], "truncated": False, "error": str(e)}
    if not base.exists():
        return {"project": proj.slug, "pages": [], "truncated": False}
    items: list[dict] = []
    for md in sorted(base.rglob("*.md")):
        if len(items) >= limit:
            break
        text = md.read_text("utf-8")
        meta, body = parse_fm(text)
        if type_filter and meta.get("type") != type_filter:
            continue
        rel = str(md.relative_to(proj.wiki_dir))
        items.append({
            "filename": rel,
            "title": meta.get("title", md.stem.replace("-", " ").title()),
            "type": meta.get("type", "unknown"),
            "status": meta.get("status", "active"),
            "tags": meta.get("tags", []),
            "last_updated": meta.get("last_updated") or meta.get("updated", ""),
            "word_count": len(body.split()),
        })
    truncated = False
    if len(items) >= limit:
        # one more file would have existed; rough check
        all_count = sum(1 for _ in base.rglob("*.md"))
        truncated = all_count > limit
    return {"project": proj.slug, "pages": items, "truncated": truncated}


@mcp.tool()
def read_page(filename: str, project: str = "") -> dict:
    """Read a wiki page by filename (relative to wiki/, e.g. "concepts/scaling-laws.md").

    Returns frontmatter, body, links, and outbound link targets.
    """
    proj = _resolve(project)
    target = _safe_wiki_path(proj, filename)
    if not target.exists():
        return {"ok": False, "error": f"page not found: {filename}", "project": proj.slug}
    text = target.read_text("utf-8")
    meta, body = parse_fm(text)
    return {
        "ok": True,
        "project": proj.slug,
        "filename": str(target.relative_to(proj.wiki_dir)),
        "frontmatter": meta,
        "body": body,
        "links": extract_links(body),
        "word_count": len(body.split()),
    }


def _search_wiki(proj, q_tokens: list[str], top_k: int) -> list[dict]:
    """TF-IDF over one project's wiki. Shared by search()'s single- and
    all-project modes."""
    if not q_tokens or not proj.wiki_dir.exists():
        return []
    docs: dict[str, dict] = {}
    for md in proj.wiki_dir.rglob("*.md"):
        rel = str(md.relative_to(proj.wiki_dir))
        text = md.read_text("utf-8")
        _, body = parse_fm(text)
        tokens = WORD_RE.findall(body.lower())
        if tokens:
            docs[rel] = {"tokens": tokens, "body": body}
    if not docs:
        return []

    df: dict[str, int] = {}
    for d in docs.values():
        for tok in set(d["tokens"]):
            df[tok] = df.get(tok, 0) + 1
    n = len(docs)

    scores: list[tuple[str, float]] = []
    for path, d in docs.items():
        tf: dict[str, int] = {}
        for tok in d["tokens"]:
            tf[tok] = tf.get(tok, 0) + 1
        score = 0.0
        for qt in q_tokens:
            if qt in tf and qt in df:
                score += (tf[qt] / len(d["tokens"])) * math.log(n / df[qt])
        if score > 0:
            scores.append((path, score))

    scores.sort(key=lambda x: -x[1])
    results: list[dict] = []
    for path, sc in scores[: max(1, top_k)]:
        body = docs[path]["body"]
        snippet = ""
        low = body.lower()
        for qt in q_tokens:
            i = low.find(qt)
            if i >= 0:
                start = max(0, i - 80)
                end = min(len(body), i + 120)
                snippet = body[start:end].replace("\n", " ")
                break
        results.append({"filename": path, "score": round(sc, 4), "snippet": snippet})
    return results


@mcp.tool()
def search(
    query: str, top_k: int = 10, project: str = "", all_projects: bool = False
) -> dict:
    """TF-IDF search across wiki pages. Returns ranked snippets.

    Args:
        query: Search query (Korean and English supported).
        top_k: Number of results (default 10; per project in all-projects mode).
        project: Project slug (empty = active/legacy).
        all_projects: Search EVERY registered project (plus legacy). Each hit
            carries its `project`; scores are per-corpus TF-IDF, so treat the
            merged order as approximate across projects.
    """
    q_tokens = WORD_RE.findall(query.lower())
    if not all_projects:
        proj = _resolve(project)
        return {"project": proj.slug, "results": _search_wiki(proj, q_tokens, top_k)}

    merged: list[dict] = []
    seen_roots: set[str] = set()
    # Registered projects plus the legacy root (when it still has a wiki) —
    # list_projects() alone omits legacy, dedup below handles overlap.
    candidates = list(project_registry.list_projects())
    legacy = project_registry._legacy_project()
    if legacy.wiki_dir.exists():
        candidates.append(legacy)
    for proj in candidates:
        root = str(proj.wiki_dir)
        if root in seen_roots:
            continue
        seen_roots.add(root)
        for hit in _search_wiki(proj, q_tokens, top_k):
            hit["project"] = proj.slug
            merged.append(hit)
    merged.sort(key=lambda h: -h["score"])
    return {"all_projects": True, "results": merged}


@mcp.tool()
def folder_tree(project: str = "") -> dict:
    """Return the folder structure under wiki/ (folders + page filenames)."""
    proj = _resolve(project)
    tree: dict[str, Any] = {"project": proj.slug, "name": "wiki", "path": "", "children": [], "pages": []}
    wd = proj.wiki_dir
    if not wd.exists():
        return tree
    for f in sorted(wd.glob("*.md")):
        tree["pages"].append(f.name)
    for d in sorted(wd.iterdir()):
        if d.is_dir() and not d.name.startswith("."):
            sub: dict[str, Any] = {"name": d.name, "path": d.name, "children": [], "pages": []}
            for f in sorted(d.rglob("*.md")):
                sub["pages"].append(str(f.relative_to(wd)))
            for sd in sorted(d.iterdir()):
                if sd.is_dir() and not sd.name.startswith("."):
                    sub["children"].append({
                        "name": sd.name,
                        "path": str(sd.relative_to(wd)),
                        "pages": [str(f.relative_to(wd)) for f in sorted(sd.rglob("*.md"))],
                    })
            tree["children"].append(sub)
    return tree


@mcp.tool()
def recent_log(n: int = 20, project: str = "") -> dict:
    """Return the most recent N entries from wiki/log.md."""
    proj = _resolve(project)
    lf = proj.wiki_dir / "log.md"
    if not lf.exists():
        return {"project": proj.slug, "entries": []}
    text = lf.read_text("utf-8")
    _, body = parse_fm(text)
    entries: list[dict] = []
    pat = re.compile(r"^## \[(\d{4}-\d{2}-\d{2})\] (\w+) \| (.+)$", re.MULTILINE)
    for m in pat.finditer(body):
        entries.append({"date": m.group(1), "action": m.group(2), "title": m.group(3)})
    entries.reverse()
    return {"project": proj.slug, "entries": entries[: max(1, n)]}


@mcp.tool()
def list_raw_sources(project: str = "") -> dict:
    """List files under raw/ (read-only — raw is immutable).

    Returns relative paths and sizes. Use `add_raw_source` to add new sources.
    """
    proj = _resolve(project)
    out: list[dict] = []
    if proj.raw_dir.exists():
        for f in sorted(proj.raw_dir.rglob("*")):
            if f.is_file() and not f.name.startswith(".") and "assets" not in f.parts:
                out.append({
                    "path": str(f.relative_to(proj.raw_dir)),
                    "size_bytes": f.stat().st_size,
                })
    return {"project": proj.slug, "sources": out}


# ─── tools: write ────────────────────────────────────────────────────────────


@mcp.tool()
def add_raw_source(filename: str, content: str, project: str = "") -> dict:
    """Add a new immutable source file to raw/.

    Filename may include a subfolder (e.g. "papers/attention.md"). If a file
    with the same name already exists, this returns an error rather than
    overwriting — raw/ is append-only.

    After adding, follow the CLAUDE.md ingest workflow: read the source,
    update or create wiki pages with inline [^src-*] citations, update
    wiki/index.md and wiki/log.md, and call `git_commit`.
    """
    proj = _resolve(project)
    return _write_raw_guarded(proj, filename, content)


def _record_inflow(proj, kind: str, n: int = 1) -> None:
    """Append one line to the vault's inflow ledger (.myco/inflow-log.jsonl).

    Mirrors app/src-tauri/src/inflow_log.rs — same file, same shape, both MCP
    servers rule (Q4 item 13 precedent). Strictly best-effort: the ledger is
    telemetry about an ingest, never a participant in it.
    """
    if n <= 0:
        return
    try:
        path = proj.root / ".myco" / "inflow-log.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        entry = {"at": int(time.time()), "ch": "mcp", "kind": kind}
        if n != 1:
            entry["n"] = n
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
    except OSError:
        pass


def _write_raw_guarded(proj, filename: str, content: str) -> dict:
    """The one raw/ write funnel: secret/PII scan → traversal check →
    immutability check → write. Shared by `add_raw_source` and the import
    tools so every path into raw/ carries identical guards.

    Q4 item 13 (scope decision 2): scan BEFORE the write — raw/ is immutable,
    so a secret must never touch disk. The caller still holds the content; a
    structured refusal lets it redact and retry. Refusal strings kept in sync
    with app/src-tauri/src/mcp_native.rs (raw_source_guard) and
    automation/autoingest.py (quarantine move).
    """
    secret_hits = scan_secrets(content)
    if secret_hits:
        return {
            "ok": False,
            "error": "refused: possible secrets (" + ", ".join(secret_hits)
            + ") — redact and re-add. Nothing was written.",
        }
    pii_hits = scan_pii(content)
    if pii_hits and _pii_quarantine_enabled():
        return {
            "ok": False,
            "error": "refused: possible PII (" + ", ".join(pii_hits)
            + ") — redact and re-add. Nothing was written.",
        }
    proj.raw_dir.mkdir(parents=True, exist_ok=True)
    target = (proj.raw_dir / filename).resolve()
    base = proj.raw_dir.resolve()
    if base != target and base not in target.parents:
        return {"ok": False, "error": f"path escapes raw/: {filename}"}
    if target.exists():
        return {"ok": False, "error": f"raw/ file exists (immutable): {filename}"}
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    _record_inflow(proj, "add_raw_source")
    out = {
        "ok": True,
        "project": proj.slug,
        "raw_path": str(target.relative_to(REPO_ROOT)),
        "src_slug": f"src-{target.stem}",
    }
    if pii_hits:
        out["pii_warning"] = (
            "possible PII detected: " + ", ".join(pii_hits) + " — raw/ is "
            "immutable and committed to git; redact and re-add if unintended."
        )
    return out


# ─── import tools (roadmap P0 — the agent-native import path) ────────────────
#
# Vendor-format PARSING lives in Rust (src-tauri/src/importers/) by decision;
# these tools deliberately re-implement none of it. `import_conversation`
# takes transcript text the calling agent already has; `import_session` reads
# one session .jsonl with a minimal turn extractor (the one format an MCP
# client cannot reasonably paste inline). Both funnel through
# `_write_raw_guarded` — the same guards as add_raw_source — and record into
# the Rust importers' ledger (`.myco/ledger.json`).
#
# Fingerprints: Rust stamps entries with a DefaultHasher digest that Python
# cannot reproduce; ours are prefixed "py-". A cross-runtime re-import of the
# same conversation therefore sees a fingerprint MISMATCH and treats it as an
# update — the raw pre-existence check still makes that a no-op write, so the
# worst case is an honest "reimported_update" tally, never a duplicate page.
#
# Wikify state lives in `.myco/wikify-pending.json`, NOT in ledger.json:
# the Rust ledger writer drops unknown keys on save, so anything we added
# there would be silently erased by the next in-app import.

_IMPORT_SOURCE_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")
_IMPORT_ID_RE = re.compile(r"[^a-zA-Z0-9._-]+")


def _ledger_paths(proj) -> tuple[Path, Path]:
    myco_dir = proj.root / ".myco"
    return myco_dir / "ledger.json", myco_dir / "wikify-pending.json"


def _load_json_or(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def _py_fingerprint(text: str) -> str:
    import hashlib

    return "py-" + hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def _load_ledger(proj) -> dict:
    ledger_path, _ = _ledger_paths(proj)
    data = _load_json_or(ledger_path, {})
    if not isinstance(data, dict):
        data = {}
    entries = data.get("entries")
    # Legacy flat map (string values at top level) — same upgrade read as
    # ledger.rs::load.
    if not isinstance(entries, dict):
        entries = {
            k: v for k, v in data.items() if isinstance(v, str)
        } or {}
    files = data.get("files")
    if not isinstance(files, dict):
        files = {}
    return {"entries": entries, "files": files}


def _save_ledger(proj, ledger: dict) -> None:
    ledger_path, _ = _ledger_paths(proj)
    ledger_path.parent.mkdir(parents=True, exist_ok=True)
    ledger_path.write_text(
        json.dumps(
            {"entries": ledger["entries"], "files": ledger["files"]},
            indent=1,
            sort_keys=True,
        ),
        encoding="utf-8",
    )


def _load_pending(proj) -> dict:
    _, pending_path = _ledger_paths(proj)
    data = _load_json_or(pending_path, {})
    if not isinstance(data, dict):
        data = {}
    pending = data.get("pending")
    return {
        "pending": pending if isinstance(pending, list) else [],
        "done_count": int(data.get("done_count") or 0),
    }


def _save_pending(proj, state: dict) -> None:
    _, pending_path = _ledger_paths(proj)
    pending_path.parent.mkdir(parents=True, exist_ok=True)
    pending_path.write_text(
        json.dumps(state, indent=1, ensure_ascii=False), encoding="utf-8"
    )


def _import_transcript(
    proj,
    raw_text: str,
    source: str,
    title: str,
    conversation_id: str,
    created: str,
    extra_fm: dict | None = None,
) -> dict:
    """Shared funnel for both import tools: dedup → guarded raw write →
    ledger record → wikify queue."""
    import hashlib

    source = (source or "").strip().lower()
    if not _IMPORT_SOURCE_RE.match(source):
        return {
            "ok": False,
            "error": "source must be a short slug like 'chatgpt', 'claude', "
            "'claude-code', 'codex' (got: " + repr(source) + ")",
        }
    text = (raw_text or "").strip()
    if not text:
        return {"ok": False, "error": "raw_text is empty"}
    conv_id = _IMPORT_ID_RE.sub("-", (conversation_id or "").strip()).strip("-")
    if not conv_id:
        conv_id = hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]
    key = f"{source}:{conv_id}"
    fp = _py_fingerprint(text)

    ledger = _load_ledger(proj)
    prior = ledger["entries"].get(key)
    if prior == fp:
        return {"ok": True, "status": "skipped_duplicate", "key": key}

    # A changed conversation (same id, new content) imports as an appended
    # revision — raw/ is immutable, so the original is never touched.
    rel = f"conversations/{source}/{conv_id}.md"
    rev = 0
    while (proj.raw_dir / rel).exists():
        rev += 1
        rel = f"conversations/{source}/{conv_id}.r{rev}.md"
    if prior is not None and rev == 0:
        # Ledger says imported but the file is gone (vault moved/pruned):
        # fall through and write it fresh.
        pass

    safe_title = _sanitize_line(title.strip()) if title.strip() else conv_id
    day = (created or "").strip() or _today()
    fm_lines = [
        "---",
        f'title: "{safe_title}"',
        f"source: {source}",
        f"conversation_id: {conv_id}",
        f"created: {day}",
        f"imported: {_today()}",
        "via: mcp",
    ]
    for k, v in (extra_fm or {}).items():
        fm_lines.append(f"{k}: {_sanitize_line(str(v))}")
    fm_lines.append("---")
    content = "\n".join(fm_lines) + "\n\n" + text + "\n"

    wrote = _write_raw_guarded(proj, rel, content)
    if not wrote.get("ok"):
        return wrote

    ledger["entries"][key] = fp
    _save_ledger(proj, ledger)
    state = _load_pending(proj)
    state["pending"] = [p for p in state["pending"] if p.get("key") != key]
    state["pending"].append(
        {
            "key": key,
            "raw_path": wrote["raw_path"],
            "src_slug": wrote["src_slug"],
            "title": safe_title,
            "imported": _today(),
        }
    )
    _save_pending(proj, state)
    out = {
        "ok": True,
        "status": "reimported_update" if prior is not None or rev > 0 else "imported",
        "key": key,
        "raw_path": wrote["raw_path"],
        "src_slug": wrote["src_slug"],
        "pending_total": len(state["pending"]),
        "next": "call wikify_pending() to turn imported transcripts into wiki pages",
    }
    if "pii_warning" in wrote:
        out["pii_warning"] = wrote["pii_warning"]
    return out


@mcp.tool()
def import_conversation(
    raw_text: str,
    source: str,
    title: str = "",
    conversation_id: str = "",
    created: str = "",
    project: str = "",
) -> dict:
    """Import one conversation transcript into raw/conversations/<source>/.

    `raw_text` is the transcript as text (you already have it — paste it, do
    not describe it). `source` is a short slug: chatgpt, claude, claude-code,
    codex, or another lowercase slug. `conversation_id` keeps re-imports
    idempotent; omit it and a content hash is used. Duplicate content is
    skipped; changed content under the same id is appended as a revision
    (raw/ is immutable). Imported items queue for `wikify_pending`.
    """
    proj = _resolve(project)
    return _import_transcript(proj, raw_text, source, title, conversation_id, created)


@mcp.tool()
def import_session(jsonl_path: str, project: str = "") -> dict:
    """Import a coding-session .jsonl (Claude Code project session or Codex
    rollout) into raw/conversations/.

    Reads the file from disk, extracts the user/assistant turns (plus cwd and
    git branch when present) into a clean transcript, and funnels it through
    the same dedup + guards as import_conversation. Point it at files under
    ~/.claude/projects/**.jsonl or ~/.codex/sessions/**.jsonl.
    """
    p = Path(jsonl_path).expanduser()
    if not p.is_file():
        return {"ok": False, "error": f"not a file: {jsonl_path}"}
    if p.suffix != ".jsonl":
        return {"ok": False, "error": "expected a .jsonl session file"}
    if p.stat().st_size > 50 * 1024 * 1024:
        return {"ok": False, "error": "session file over 50 MB"}
    turns, meta = _parse_session_jsonl(p)
    if not turns:
        return {
            "ok": False,
            "error": "no user/assistant turns recognized — supported shapes: "
            "Claude Code project sessions and Codex rollouts",
        }
    body_parts = []
    for role, text in turns:
        body_parts.append(f"## {role.capitalize()}\n\n{text.strip()}")
    transcript = "\n\n".join(body_parts)
    extra = {"turn_count": len(turns)}
    if meta.get("cwd"):
        extra["cwd"] = meta["cwd"]
    if meta.get("git_branch"):
        extra["git_branch"] = meta["git_branch"]
    proj = _resolve(project)
    return _import_transcript(
        proj,
        transcript,
        meta.get("source") or "claude-code",
        meta.get("title") or p.stem,
        meta.get("session_id") or p.stem,
        meta.get("created") or "",
        extra_fm=extra,
    )


def _session_text_blocks(content) -> str:
    """Flatten a message content field: plain string, or a list of typed
    blocks whose text lives under 'text' (Claude Code / Codex alike)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict) and isinstance(block.get("text"), str):
                parts.append(block["text"])
        return "\n".join(parts)
    return ""


def _parse_session_jsonl(p: Path) -> tuple[list[tuple[str, str]], dict]:
    """Minimal turn extractor for the two session formats. Returns
    ([(role, text)...], meta). Unknown lines are skipped, not fatal — a
    session file full of tool events still yields its prose turns."""
    turns: list[tuple[str, str]] = []
    meta: dict = {}
    for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if not isinstance(row, dict):
            continue
        for k_src, k_dst in (
            ("cwd", "cwd"),
            ("gitBranch", "git_branch"),
            ("sessionId", "session_id"),
        ):
            if isinstance(row.get(k_src), str) and row[k_src] and k_dst not in meta:
                meta[k_dst] = row[k_src]
        if "created" not in meta and isinstance(row.get("timestamp"), str):
            meta["created"] = row["timestamp"][:10]
        # Claude Code shape: {type: "user"|"assistant", message: {role, content}}
        msg = row.get("message")
        if row.get("type") in ("user", "assistant") and isinstance(msg, dict):
            meta.setdefault("source", "claude-code")
            text = _session_text_blocks(msg.get("content"))
            if text.strip():
                turns.append((row["type"], text))
            continue
        # Codex rollout shape: {type: "message", role, content: [...]}
        if row.get("type") == "message" and row.get("role") in ("user", "assistant"):
            meta.setdefault("source", "codex")
            text = _session_text_blocks(row.get("content"))
            if text.strip():
                turns.append((row["role"], text))
    return turns, meta


@mcp.tool()
def wikify_pending(limit: int = 3, done: list[str] | None = None, project: str = "") -> dict:
    """List imported-but-not-yet-wikified transcripts, oldest first.

    Returns up to `limit` pending items with the transcript text (truncated)
    so you can create/update wiki pages citing their [^src-*] slugs — the
    CLAUDE.md ingest workflow. When a transcript's pages are written and
    committed, call this again with done=[<key>, ...] to check it off. An
    empty result means the import queue is fully wikified.
    """
    proj = _resolve(project)
    state = _load_pending(proj)
    if done:
        before = len(state["pending"])
        state["pending"] = [p for p in state["pending"] if p.get("key") not in set(done)]
        state["done_count"] += before - len(state["pending"])
        _save_pending(proj, state)
    limit = max(1, min(int(limit or 3), 10))
    items = []
    for row in state["pending"][:limit]:
        raw_rel = row.get("raw_path") or ""
        full = (REPO_ROOT / raw_rel) if raw_rel else None
        excerpt = ""
        if full is not None and full.is_file():
            excerpt = full.read_text(encoding="utf-8", errors="replace")[:2400]
        items.append(
            {
                "key": row.get("key"),
                "raw_path": raw_rel,
                "src_slug": row.get("src_slug"),
                "title": row.get("title"),
                "excerpt": excerpt,
            }
        )
    return {
        "pending_total": len(state["pending"]),
        "wikified_total": state["done_count"],
        "items": items,
        "instructions": (
            "For each item: read the full raw file if the excerpt is not "
            "enough, create or update wiki pages with inline [^" + "src-*] "
            "citations to its src_slug, update wiki/index.md, git_commit, "
            "then call wikify_pending(done=[key])."
            if items
            else "Nothing pending — the import queue is fully wikified."
        ),
    }


@mcp.tool()
def ledger_status(project: str = "") -> dict:
    """Report the import dedup ledger: how many conversations are recorded
    per source, how many session files are stamped, and how much of the
    import queue is still waiting for wikification."""
    proj = _resolve(project)
    ledger = _load_ledger(proj)
    per_source: dict[str, int] = {}
    for key in ledger["entries"]:
        src = key.split(":", 1)[0] if ":" in key else "unknown"
        per_source[src] = per_source.get(src, 0) + 1
    state = _load_pending(proj)
    ledger_path, pending_path = _ledger_paths(proj)
    return {
        "conversations_recorded": len(ledger["entries"]),
        "per_source": per_source,
        "session_files_stamped": len(ledger["files"]),
        "wikify_pending": len(state["pending"]),
        "wikified_total": state["done_count"],
        "ledger_path": _rel_to_repo(ledger_path),
        "pending_path": _rel_to_repo(pending_path),
    }


@mcp.tool()
def create_page(
    title: str,
    page_type: str,
    content: str = "",
    folder: str = "",
    tags: list[str] | None = None,
    sources: list[str] | None = None,
    project: str = "",
) -> dict:
    """Create a new wiki page with proper myco frontmatter.

    Args:
        title: Page title (used to derive slug).
        page_type: One of "concept", "entity", "technique", "source-summary",
            "analysis", or any custom type used in this wiki.
        content: Body markdown (without frontmatter). Caller must include
            inline [^src-*] citations and link footnote definitions if making
            factual claims.
        folder: Optional subfolder under wiki/.
        tags: Optional tag list.
        sources: Optional list of source slugs (without "src-" prefix).
        project: Project slug.
    """
    if not title.strip():
        return {"ok": False, "error": "title required"}
    proj = _resolve(project)
    proj.wiki_dir.mkdir(parents=True, exist_ok=True)
    slug = project_registry.make_slug(title)
    try:
        base = _safe_wiki_dir(proj, folder)
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    base.mkdir(parents=True, exist_ok=True)
    target = base / f"{slug}.md"
    n = 2
    while target.exists():
        target = base / f"{slug}-{n}.md"
        n += 1

    today = _today()
    tag_lines = "\n".join(f"  - {t}" for t in (tags or []))
    src_lines = "\n".join(f"  - {s}" for s in (sources or []))
    fm_parts = [
        "---",
        f'title: "{title}"',
        f"type: {page_type}",
        f"created: {today}",
        f"last_updated: {today}",
        f"source_count: {len(sources or [])}",
        "confidence: medium",
        "status: active",
    ]
    if tags:
        fm_parts.append("tags:")
        fm_parts.append(tag_lines)
    else:
        fm_parts.append("tags: []")
    if sources:
        fm_parts.append("sources:")
        fm_parts.append(src_lines)
    fm_parts.append("---\n")
    body = content or f"# {title}\n\n<!-- TODO: add content with inline [^src-*] citations -->"
    target.write_text("\n".join(fm_parts) + "\n" + body + "\n", encoding="utf-8")
    _record_inflow(proj, "create_page")
    return {
        "ok": True,
        "project": proj.slug,
        "filename": str(target.relative_to(proj.wiki_dir)),
        "path": str(target.relative_to(REPO_ROOT)),
    }


@mcp.tool()
def update_page(filename: str, content: str, project: str = "") -> dict:
    """Overwrite a wiki page's content. Caller is responsible for keeping
    frontmatter present (include the `---` block at the top).

    Refuses if the resolved path is outside wiki/ or under raw/.
    """
    proj = _resolve(project)
    try:
        target = _safe_wiki_path(proj, filename)
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    if project_registry.is_protected_raw(target):
        return {"ok": False, "error": f"raw/ is immutable: {filename}"}
    if not target.exists():
        return {"ok": False, "error": f"page not found: {filename}"}
    target.write_text(content, encoding="utf-8")
    _record_inflow(proj, "update_page")
    return {
        "ok": True,
        "project": proj.slug,
        "filename": str(target.relative_to(proj.wiki_dir)),
    }


@mcp.tool()
def create_folder(name: str, parent: str = "", project: str = "") -> dict:
    """Create a folder under wiki/ (or under wiki/<parent>/)."""
    proj = _resolve(project)
    proj.wiki_dir.mkdir(parents=True, exist_ok=True)
    base = proj.wiki_dir / parent if parent else proj.wiki_dir
    base = base.resolve()
    if proj.wiki_dir.resolve() != base and proj.wiki_dir.resolve() not in base.parents:
        return {"ok": False, "error": f"parent escapes wiki/: {parent}"}
    target = (base / name).resolve()
    if base != target.parent and base not in target.parents:
        return {"ok": False, "error": f"name escapes parent: {name}"}
    target.mkdir(parents=True, exist_ok=True)
    return {
        "ok": True,
        "project": proj.slug,
        "path": str(target.relative_to(proj.wiki_dir)),
    }


@mcp.tool()
def git_commit(message: str, project: str = "") -> dict:
    """Stage wiki/, raw/, ingest-reports/ and commit with the given message.

    Use Conventional Commit format, e.g. "ingest: attention is all you need"
    or "lint: fix orphaned pages". Returns the new commit hash, or no_op
    if there was nothing staged.
    """
    if not message.strip():
        return {"ok": False, "error": "message required"}
    proj = _resolve(project)
    cwd = str(REPO_ROOT)

    if not (REPO_ROOT / ".git").is_dir():
        return {"ok": False, "error": "repository is not a git repo"}

    if proj.is_legacy:
        paths = ["wiki", "raw", "ingest-reports"]
    else:
        rel = str(proj.root.relative_to(REPO_ROOT))
        paths = [
            f"{rel}/wiki",
            f"{rel}/raw",
            f"{rel}/ingest-reports",
            f"{rel}/CLAUDE.md",
            f"{rel}/CHANGELOG.md",
            f"{rel}/.settings.json",
            "projects.json",
        ]
    for p in paths:
        if (REPO_ROOT / p).exists():
            add = subprocess.run(
                ["git", "add", p],
                cwd=cwd, capture_output=True, text=True,
            )
            if add.returncode != 0:
                # Abort instead of committing a stale/partial staging set.
                return {
                    "ok": False,
                    "project": proj.slug,
                    "error": (
                        f"git add failed for {p}: "
                        f"{(add.stderr or add.stdout).strip()}"
                    )[:500],
                }

    diff = subprocess.run(
        ["git", "diff", "--cached", "--name-only"],
        cwd=cwd, capture_output=True, text=True,
    )
    files = [f for f in diff.stdout.strip().split("\n") if f]
    if not files:
        return {"ok": True, "no_op": True, "project": proj.slug, "files": []}

    r = subprocess.run(
        ["git", "commit", "-m", message],
        cwd=cwd, capture_output=True, text=True,
    )
    if r.returncode != 0:
        return {
            "ok": False,
            "project": proj.slug,
            "error": (r.stderr or r.stdout)[:500],
        }
    log = subprocess.run(
        ["git", "log", "-1", "--format=%H"],
        cwd=cwd, capture_output=True, text=True,
    )
    return {
        "ok": True,
        "project": proj.slug,
        "hash": log.stdout.strip(),
        "files": files,
    }


# ─── tools: inbox / auto-ingest ──────────────────────────────────────────────


@mcp.tool()
def list_inbox(project: str = "") -> dict:
    """List source files waiting in the vault's _inbox/ (pending auto-ingest).

    To ingest continuously from a terminal: call list_inbox, then for each
    file read_inbox_source -> create/update the wiki pages with citations ->
    archive_inbox_source. Repeat until the inbox is empty.
    """
    proj = _resolve(project)
    inbox = proj.root / "_inbox"
    out: list[dict] = []
    if inbox.is_dir():
        for f in sorted(inbox.iterdir()):
            if f.is_file() and not f.name.startswith("."):
                out.append({"filename": f.name, "size_bytes": f.stat().st_size})
    return {"project": proj.slug, "inbox": out, "count": len(out)}


@mcp.tool()
def read_inbox_source(filename: str, project: str = "") -> dict:
    """Read one pending _inbox/ source so you can ingest it into the wiki."""
    proj = _resolve(project)
    target = _safe_inbox_path(proj, filename)
    if target is None or not target.is_file():
        return {"ok": False, "error": f"not found in inbox: {filename}"}
    return {
        "ok": True,
        "project": proj.slug,
        "filename": target.name,
        "content": target.read_text("utf-8", errors="replace"),
        "src_slug": f"src-{project_registry.make_slug(target.stem)}",
    }


@mcp.tool()
def archive_inbox_source(filename: str, project: str = "") -> dict:
    """Archive a pending source AFTER you have ingested it.

    Copies the source text into a NEW raw/<slug>.md (raw/ is immutable — never
    overwritten) and moves the original into _inbox/.archived/ so it is not lost
    and won't be ingested again. Call this only once the wiki pages, citations,
    index.md and log.md for this source are written.
    """
    proj = _resolve(project)
    target = _safe_inbox_path(proj, filename)
    if target is None or not target.is_file():
        return {"ok": False, "error": f"not found in inbox: {filename}"}

    proj.raw_dir.mkdir(parents=True, exist_ok=True)
    slug = project_registry.make_slug(target.stem)
    raw_path = proj.raw_dir / f"{slug}.md"
    n = 2
    while raw_path.exists():
        raw_path = proj.raw_dir / f"{slug}-{n}.md"
        n += 1
    raw_path.write_text(target.read_text("utf-8", errors="replace"), encoding="utf-8")

    archive = target.parent / ".archived"
    archive.mkdir(exist_ok=True)
    dest = archive / target.name
    m = 2
    while dest.exists():
        dest = archive / f"{target.stem}-{m}{target.suffix}"
        m += 1
    target.rename(dest)

    raw_rel = _rel_to_repo(raw_path)
    return {"ok": True, "project": proj.slug, "raw_path": raw_rel, "archived": dest.name, "src_slug": f"src-{raw_path.stem}"}


# ─── local lint (no LLM) ─────────────────────────────────────────────────────

# Mirrors Rust's `local_llm::WIKI_TYPES` / `mcp_native::VALID_TYPES` — "map"
# (Phase B, Task 4, myco app) added there too, for the same wiki/maps/ topic
# map pages.
VALID_TYPES = {"concept", "technique", "entity", "source-summary", "analysis", "map"}
# Meta/scaffold pages the schema does not govern — index, log and any page
# declaring a meta type. Content types stay strictly validated.
LINT_SKIP_NAMES = {"index.md", "log.md"}
LINT_META_TYPES = {"overview", "meta"}
FOOTNOTE_REF_RE = re.compile(r"\[\^(src-[\w-]+)\](?!:)")
FOOTNOTE_DEF_RE = re.compile(r"^\[\^(src-[\w-]+)\]:", re.MULTILINE)


def lint_page_text(text: str) -> list[str]:
    """Structural + citation lint of ONE wiki page (pure, regex-only — the
    CLAUDE.md lint checklist items that need no judgement, so no LLM call).
    Returns human-readable problem strings; empty = clean.
    """
    problems: list[str] = []
    meta, body = parse_fm(text)
    if not meta:
        problems.append("missing frontmatter")
        return problems  # everything below reads meta

    ptype = meta.get("type")
    if ptype in LINT_META_TYPES:
        return []  # meta/scaffold page — schema does not apply
    if not ptype:
        problems.append("missing `type`")
    elif ptype not in VALID_TYPES:
        problems.append(f"invalid `type`: {ptype}")

    status = meta.get("status")
    if status == "superseded" and not meta.get("superseded_by"):
        problems.append("status=superseded without `superseded_by`")
    if status == "disputed" and "## Disputed" not in body:
        problems.append("status=disputed without a `## Disputed` section")

    refs = set(FOOTNOTE_REF_RE.findall(body))
    defs = set(FOOTNOTE_DEF_RE.findall(body))
    for r in sorted(refs - defs):
        problems.append(f"citation [^{r}] has no definition")
    for d in sorted(defs - refs):
        problems.append(f"footnote [^{d}] defined but never referenced")

    sc = meta.get("source_count")
    if sc is not None and refs:
        try:
            if int(str(sc)) != len(refs):
                problems.append(
                    f"source_count={sc} but {len(refs)} distinct citations"
                )
        except ValueError:
            problems.append(f"source_count is not a number: {sc!r}")
    return problems


@mcp.tool()
def lint_citations(project: str = "") -> dict:
    """Local structural/citation lint over every wiki page — no LLM, instant.

    Checks: frontmatter presence, valid `type`, superseded/disputed contract,
    undefined or unused [^src-*] footnotes, source_count vs actual citations.
    Use before/after an ingest for a fast consistency pass; the full LLM lint
    remains the deep option.
    """
    proj = _resolve(project)
    pages = [
        p
        for p in sorted(proj.wiki_dir.rglob("*.md"))
        if p.name not in LINT_SKIP_NAMES
    ]
    report: dict[str, list[str]] = {}
    total = 0
    for p in pages:
        problems = lint_page_text(p.read_text("utf-8", errors="replace"))
        if problems:
            report[_rel_to_repo(p)] = problems
            total += len(problems)
    return {
        "ok": True,
        "project": proj.slug,
        "pages_checked": len(pages),
        "pages_with_problems": len(report),
        "problems_total": total,
        "report": report,
    }


@mcp.tool()
def preview_page_update(filename: str, content: str, project: str = "") -> dict:
    """Unified diff of what update_page WOULD write — changes nothing on disk.

    Use to confirm an edit before applying it (especially bulk/ingest edits):
    call this, inspect the diff, then call update_page with the same content.
    """
    proj = _resolve(project)
    target = _safe_wiki_path(proj, filename)
    if not target.is_file():
        return {"ok": False, "error": f"not found: {filename}"}
    old = target.read_text("utf-8", errors="replace")
    if old == content:
        return {"ok": True, "project": proj.slug, "changed": False, "diff": ""}
    diff = "".join(
        difflib.unified_diff(
            old.splitlines(keepends=True),
            content.splitlines(keepends=True),
            fromfile=f"a/{filename}",
            tofile=f"b/{filename}",
        )
    )
    return {"ok": True, "project": proj.slug, "changed": True, "diff": diff}


# ─── governance / cross-project ──────────────────────────────────────────────

# Source trust tiers (GOV-03): a page's `source_type` maps to a trust weight;
# combined with citation count it yields a suggested confidence. Higher = more
# authoritative. Unknown/absent → neutral 0.5.
SOURCE_TRUST = {
    "peer-reviewed": 1.0,
    "paper": 0.95,
    "book": 0.9,
    "official-docs": 0.85,
    "primary": 0.85,
    "news": 0.6,
    "blog": 0.45,
    "forum": 0.35,
    "tweet": 0.25,
    "unknown": 0.5,
}


def suggest_confidence(source_type: str | None, citation_count: int) -> str:
    """Derive a confidence tier from source trust + how many citations back the
    page (GOV-03). Pure; used by the trust-score tool and available to lint.
    """
    trust = SOURCE_TRUST.get((source_type or "unknown").strip().lower(), 0.5)
    # More citations lift confidence, with diminishing returns; trust caps it.
    cite_factor = min(1.0, citation_count / 3.0)
    score = trust * (0.5 + 0.5 * cite_factor)
    return "high" if score >= 0.75 else "medium" if score >= 0.45 else "low"


@mcp.tool()
def trust_report(project: str = "") -> dict:
    """Source-trust audit (GOV-03): for each page report its source_type, its
    trust weight, citation count, and the confidence the schema WOULD suggest —
    flagging pages whose declared `confidence` disagrees with the suggestion.
    Read-only; never edits pages.
    """
    proj = _resolve(project)
    rows: list[dict] = []
    mismatches = 0
    for md in sorted(proj.wiki_dir.rglob("*.md")):
        if md.name in LINT_SKIP_NAMES:
            continue
        meta, body = parse_fm(md.read_text("utf-8", errors="replace"))
        if not meta or meta.get("type") in LINT_META_TYPES:
            continue
        stype = meta.get("source_type")
        cites = len(set(FOOTNOTE_REF_RE.findall(body)))
        suggested = suggest_confidence(stype, cites)
        declared = meta.get("confidence")
        mismatch = declared is not None and declared != suggested
        if mismatch:
            mismatches += 1
        rows.append({
            "filename": str(md.relative_to(proj.wiki_dir)),
            "source_type": stype or "(unset)",
            "trust": SOURCE_TRUST.get((stype or "unknown").lower(), 0.5),
            "citations": cites,
            "declared_confidence": declared or "(unset)",
            "suggested_confidence": suggested,
            "mismatch": mismatch,
        })
    return {
        "ok": True,
        "project": proj.slug,
        "pages": len(rows),
        "mismatches": mismatches,
        "rows": rows,
    }


def find_contradictions(pages: dict[str, dict]) -> list[dict]:
    """Structural contradiction candidates (GOV-01), no LLM: (1) pages marked
    status=disputed, (2) superseded pages still linked by active pages, (3)
    pages sharing a `claims`-style key with an opposite `stance`. `pages` maps
    filename → {meta, body, links}. Pure so it unit-tests cleanly.
    """
    out: list[dict] = []
    active_links: dict[str, list[str]] = {}
    status_of: dict[str, str] = {}
    for fn, p in pages.items():
        st = p["meta"].get("status", "active")
        status_of[fn] = st
        if st == "active":
            active_links[fn] = p.get("links", [])
        if st == "disputed":
            out.append({"kind": "disputed", "page": fn,
                        "detail": "page is flagged disputed"})
    # superseded page still referenced by an active page
    for fn, links in active_links.items():
        for tgt in links:
            tgt_fn = tgt if tgt.endswith(".md") else f"{tgt}.md"
            if status_of.get(tgt_fn) == "superseded":
                out.append({"kind": "stale-link", "page": fn,
                            "detail": f"links to superseded [[{tgt}]]"})
    return out


@mcp.tool()
def contradictions(project: str = "") -> dict:
    """Structural contradiction scan (GOV-01) — no LLM. Flags disputed pages
    and active pages that still link to superseded ones, so you know where a
    human/LLM judgement pass is worth spending. Read-only.
    """
    proj = _resolve(project)
    pages: dict[str, dict] = {}
    for md in sorted(proj.wiki_dir.rglob("*.md")):
        if md.name in LINT_SKIP_NAMES:
            continue
        meta, body = parse_fm(md.read_text("utf-8", errors="replace"))
        pages[str(md.relative_to(proj.wiki_dir))] = {
            "meta": meta, "body": body, "links": extract_links(body),
        }
    found = find_contradictions(pages)
    return {"ok": True, "project": proj.slug, "count": len(found), "found": found}


# Cross-project link syntax (FEAT-02): [[slug::page]] targets a page in another
# project. Parsed here so tools can resolve them without touching the wikilink
# regex used for intra-project links.
CROSS_LINK_RE = re.compile(r"\[\[([a-z0-9][\w-]*?)::([^\]|]+?)(?:\|[^\]]*?)?\]\]")


def parse_cross_links(body: str) -> list[tuple[str, str]]:
    """(project_slug, page) pairs for every [[slug::page]] in body. Pure."""
    out: list[tuple[str, str]] = []
    for m in CROSS_LINK_RE.finditer(body):
        page = m.group(2).strip()
        out.append((m.group(1).strip(), page[:-3] if page.endswith(".md") else page))
    return out


@mcp.tool()
def resolve_cross_links(filename: str, project: str = "") -> dict:
    """Resolve a page's [[slug::page]] cross-project links (FEAT-02): for each,
    report the target project, page, and whether that page exists. Lets a
    reader jump across projects without the intra-project graph conflating them.
    """
    proj = _resolve(project)
    try:
        target = _safe_wiki_path(proj, filename)
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    if not target.is_file():
        return {"ok": False, "error": f"not found: {filename}"}
    _, body = parse_fm(target.read_text("utf-8", errors="replace"))
    by_slug = {p.slug: p for p in project_registry.list_projects()}
    links: list[dict] = []
    for slug, page in parse_cross_links(body):
        tproj = by_slug.get(slug)
        exists = bool(tproj and (tproj.wiki_dir / f"{page}.md").is_file())
        links.append({"project": slug, "page": page, "exists": exists,
                      "known_project": tproj is not None})
    return {"ok": True, "project": proj.slug, "links": links}


@mcp.tool()
def translation_report(project: str = "") -> dict:
    """KO/EN translation-relation audit (FEAT-08). Pages may declare
    `translation_of: <page>` (a translation, NOT a supersession). Reports each
    declared pair and flags dangling targets or missing back-links so KO/EN
    twins stay in sync. Read-only.
    """
    proj = _resolve(project)
    metas: dict[str, dict] = {}
    for md in sorted(proj.wiki_dir.rglob("*.md")):
        meta, _ = parse_fm(md.read_text("utf-8", errors="replace"))
        metas[md.stem] = meta
    pairs: list[dict] = []
    for stem_name, meta in metas.items():
        tgt = meta.get("translation_of")
        if not tgt:
            continue
        tgt_stem = tgt[:-3] if str(tgt).endswith(".md") else str(tgt)
        target_meta = metas.get(tgt_stem)
        back = target_meta and (
            str(target_meta.get("translation_of", "")).replace(".md", "")
            == stem_name
        )
        pairs.append({
            "page": f"{stem_name}.md",
            "translation_of": f"{tgt_stem}.md",
            "target_exists": target_meta is not None,
            "reciprocal": bool(back),
        })
    return {"ok": True, "project": proj.slug, "count": len(pairs), "pairs": pairs}


@mcp.tool()
def append_changelog(entry: str, section: str = "Changed", project: str = "") -> dict:
    """Append an entry to the project's CHANGELOG.md (GOV-04, Keep a Changelog
    format) under the `## [Unreleased]` heading's `### <section>` subsection.
    Creates the file/headers if absent. section ∈ Added/Changed/Fixed/Removed.
    """
    if not entry.strip():
        return {"ok": False, "error": "entry required"}
    sec = section.strip().capitalize()
    if sec not in {"Added", "Changed", "Fixed", "Removed"}:
        return {"ok": False, "error": f"invalid section: {section}"}
    proj = _resolve(project)
    proj.root.mkdir(parents=True, exist_ok=True)
    path = proj.root / "CHANGELOG.md"
    if not path.exists():
        path.write_text(
            "# Changelog\n\n"
            "All notable changes to this wiki are recorded here "
            "(Keep a Changelog format).\n\n"
            "## [Unreleased]\n",
            encoding="utf-8",
        )
    text = path.read_text("utf-8")
    if "## [Unreleased]" not in text:
        text = text.rstrip() + "\n\n## [Unreleased]\n"
    lines = text.splitlines()
    # find the Unreleased block bounds
    ur = next(i for i, ln in enumerate(lines) if ln.startswith("## [Unreleased]"))
    nxt = next((i for i in range(ur + 1, len(lines))
                if lines[i].startswith("## ")), len(lines))
    block = lines[ur + 1 : nxt]
    hdr = f"### {sec}"
    if hdr in block:
        hi = ur + 1 + block.index(hdr)
        lines.insert(hi + 1, f"- {entry.strip()}")
    else:
        ins = ["", hdr, f"- {entry.strip()}"]
        lines[nxt:nxt] = ins
    path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
    return {"ok": True, "project": proj.slug,
            "changelog": str(path.relative_to(REPO_ROOT)), "section": sec}


@mcp.tool()
def register_vault(project: str = "") -> dict:
    """Make a project openable as its OWN standalone Obsidian vault (MP-10):
    scaffolds projects/<slug>/.obsidian/ and flags the registry entry. Then in
    Obsidian use 'Open folder as vault' → the project folder. Does not touch
    Obsidian's global config. The repo root stays a valid vault too, so you can
    work either whole-repo or per-project.
    """
    proj = _resolve(project)
    if proj.is_legacy or not proj.slug:
        return {"ok": False, "error": "legacy project has no slug to register"}
    try:
        obs = project_registry.scaffold_independent_vault(proj.slug)
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    return {
        "ok": True,
        "project": proj.slug,
        "obsidian_dir": str(obs.relative_to(REPO_ROOT)),
        "open_as": str(proj.root.relative_to(REPO_ROOT)),
    }


@mcp.tool()
def export_project(project: str = "") -> dict:
    """Zip a project's vault (wiki/, raw/, CLAUDE.md, CHANGELOG.md, settings)
    to projects/.backups/<slug>-<n>.zip for backup/restore (OPS-04). Returns
    the archive path. Deterministic name with a collision counter (no clock).
    """
    proj = _resolve(project)
    if not proj.root.exists():
        return {"ok": False, "error": f"project root missing: {proj.slug}"}
    backups = project_registry.PROJECTS_DIR / ".backups"
    backups.mkdir(parents=True, exist_ok=True)
    base = proj.slug or "legacy"
    dest = backups / f"{base}.zip"
    n = 2
    while dest.exists():
        dest = backups / f"{base}-{n}.zip"
        n += 1
    import zipfile

    count = 0
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:
        for sub in ("wiki", "raw", "ingest-reports", "reflect-reports"):
            d = proj.root / sub
            if not d.is_dir():
                continue
            for f in sorted(d.rglob("*")):
                if f.is_file():
                    z.write(f, str(f.relative_to(proj.root)))
                    count += 1
        for fn in ("CLAUDE.md", "CHANGELOG.md", ".settings.json"):
            f = proj.root / fn
            if f.is_file():
                z.write(f, fn)
                count += 1
    return {"ok": True, "project": proj.slug,
            "archive": str(dest.relative_to(REPO_ROOT)), "files": count}


# ─── tools: distill (no-LLM, cache-reading) ──────────────────────────────────
#
# Mirrors the read paths of the desktop app's Rust `distill` module
# (app/src-tauri/src/distill.rs) — no scoring, no writes, no embeddings, just
# the `.myco/` state the app already maintains. Two known divergences from
# the Rust source, both because this server has no access to the app's
# embedding pipeline:
#   - `distill-state.json`'s `scored` ledger is read as-is. Rust invalidates
#     the whole ledger when the embedding model changes (it compares
#     `state.model` against the live `VectorStore`, which lives outside the
#     vault in the app's own settings dir, not under `.myco/`); this server
#     has no way to know the current model, so a ledger left stale by a model
#     change is not detected here and can undercount the backlog.
#   - `distill.json` fields are defaulted independently: a present field with
#     the wrong JSON type falls back to just that field's default, where Rust
#     fails the whole-struct parse and defaults every field.

# (start dir, subdir excluded at that dir's own top level only) — mirrors
# `distill.rs::collect_candidates`.
_DISTILL_INFLOW_TREES: tuple[tuple[str, str | None], ...] = (
    ("_inbox", "quarantine"),
    ("raw", "archive"),
    ("sessions", None),
)

# Mirrors `distill.rs` DistillConfig's `d_*` default fns.
_DISTILL_CONFIG_DEFAULTS: dict[str, Any] = {
    "enabled": True,
    "count_trigger": 50,
    "intensity": "standard",
    "gate_preset": "normal",
    "quarantine_ttl_days": 30,
    "run_budget_items": 50,
    "idle_minutes": 10,
    "maturation_hours": 24,
    "dormancy_decay": False,
}

_QUARANTINE_EXPIRING_WINDOW_SECS = 7 * 86_400


def _is_hidden_name(name: str) -> bool:
    """Mirror of the Rust vault walk's hidden-entry filter (index.rs
    `is_hidden_name`): dotfiles plus node_modules/target."""
    return name.startswith(".") or name in ("node_modules", "target")


def _walk_inflow_tree(root: Path, start: str, exclude_top: str | None) -> list[str]:
    """Vault-relative `.md` paths under `root/start`, recursive, skipping
    hidden entries and symlinks, and (at `start`'s own top level only) a
    directory named `exclude_top`. Mirrors `distill.rs::walk_inflow`."""
    out: list[str] = []
    base = root / start
    if not base.is_dir():
        return out

    def walk(d: Path, top: bool) -> None:
        try:
            entries = sorted(d.iterdir())
        except OSError:
            return
        for e in entries:
            if e.is_symlink() or _is_hidden_name(e.name):
                continue
            if e.is_dir():
                if top and exclude_top and e.name == exclude_top:
                    continue
                walk(e, False)
            elif e.is_file() and e.suffix == ".md":
                out.append(e.relative_to(root).as_posix())

    walk(base, True)
    return out


def _distill_candidates(root: Path) -> list[str]:
    """Every inflow candidate across `_inbox/`, `raw/`, `sessions/` — mirrors
    `distill.rs::collect_candidates` (order doesn't matter here, only
    membership; the Rust oldest-mtime-first order only matters for `scan`'s
    own budget selection, not this read-only count)."""
    out: list[str] = []
    for start, exclude in _DISTILL_INFLOW_TREES:
        out.extend(_walk_inflow_tree(root, start, exclude))
    return out


def _distill_quarantine_sidecars(root: Path) -> list[Path]:
    """`.verdict.json` sidecars directly under `_inbox/quarantine/` (not
    recursive) — mirrors `distill.rs::quarantine_item_count`."""
    d = root / "_inbox" / "quarantine"
    if not d.is_dir():
        return []
    try:
        entries = sorted(d.iterdir())
    except OSError:
        return []
    return [
        e for e in entries
        if e.is_file() and not e.is_symlink() and not _is_hidden_name(e.name)
        and e.name.endswith(".verdict.json")
    ]


def _distill_state(root: Path) -> dict:
    """Read `.myco/distill-state.json` as-is. Missing/corrupt -> `{}` (every
    field then reads as its empty/zero value below). See the module-header
    note above: unlike Rust's `state_load`, this never invalidates the ledger
    on an embedding-model change (no access to the live model here)."""
    try:
        data = json.loads((root / ".myco" / "distill-state.json").read_text("utf-8", errors="replace"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _distill_config(root: Path) -> dict:
    """Read `.myco/distill.json`, filling in Rust's per-field defaults for
    anything missing, wrong-typed, or if the file is absent/corrupt."""
    cfg = dict(_DISTILL_CONFIG_DEFAULTS)
    try:
        data = json.loads((root / ".myco" / "distill.json").read_text("utf-8", errors="replace"))
    except (OSError, json.JSONDecodeError):
        return cfg
    if not isinstance(data, dict):
        return cfg
    for key, default in _DISTILL_CONFIG_DEFAULTS.items():
        value = data.get(key, default)
        if isinstance(value, type(default)):
            cfg[key] = value
    return cfg


def _distill_backlog_count(root: Path, state: dict) -> int:
    """Unscored inflow candidates plus current quarantine size — mirrors
    `distill.rs::backlog_count`."""
    scored = state.get("scored")
    scored = scored if isinstance(scored, dict) else {}
    unscored = sum(1 for rel in _distill_candidates(root) if rel not in scored)
    return unscored + len(_distill_quarantine_sidecars(root))


def _distill_feedback_proposals(root: Path) -> list[tuple[Path, dict, str]]:
    """Every `type: distill-proposal` file directly under `work/feedback/`,
    any status, in filename order — (path, frontmatter, body) triples. Shared
    walk for `_distill_pending_proposals` and
    `_distill_awaiting_resolution_count` below, which each filter by status."""
    fb = root / "work" / "feedback"
    if not fb.is_dir():
        return []
    try:
        entries = sorted(fb.iterdir())
    except OSError:
        return []
    out: list[tuple[Path, dict, str]] = []
    for e in entries:
        if e.is_symlink() or _is_hidden_name(e.name) or not e.is_file() or e.suffix != ".md":
            continue
        try:
            content = e.read_text("utf-8", errors="replace")
        except OSError:
            continue
        meta, body = parse_fm(content)
        if meta.get("type") != "distill-proposal":
            continue
        out.append((e, meta, body))
    return out


def _distill_pending_proposals(root: Path) -> list[tuple[Path, dict, str]]:
    """Pending (`status` missing or `pending`) distill-proposal files —
    mirrors `distill.rs::is_pending_map`. Used by `distill_report`'s listing
    of proposals still awaiting a user decision (not `distill_status`'s
    count — see `_distill_awaiting_resolution_count` for that one)."""
    return [
        t for t in _distill_feedback_proposals(root) if t[1].get("status") in (None, "pending")
    ]


def _distill_awaiting_resolution_count(root: Path) -> int:
    """Pending OR approved distill-proposal count — mirrors
    `distill.rs::pending_proposal_count`: both states await resolution
    (approved means the frontend flagged it but `apply_proposal` hasn't run
    yet, or ran and failed). Kept in parity with the Rust side so
    `distill_status`'s count and the app's badge never disagree on a stuck
    approved-but-unapplied proposal."""
    return sum(
        1
        for _, meta, _ in _distill_feedback_proposals(root)
        if meta.get("status") in (None, "pending", "approved")
    )


def _proposal_title(body: str) -> str:
    """First `# ` heading in a proposal's body — `write_proposal` in
    distill.rs always writes one right after the frontmatter."""
    for line in body.splitlines():
        line = line.strip()
        if line.startswith("# "):
            return line[2:].strip()
    return ""


@mcp.tool()
def distill_status() -> dict:
    """Backlog counts, pending proposals, last run, and whether triggers are exceeded.
    No-LLM: reads .myco/ state the desktop app maintains.

    `pending_proposals` counts `pending` OR `approved` proposals (parity with
    `distill.rs::pending_proposal_count`) — approved-but-unapplied still
    awaits resolution, not a new decision."""
    proj = _resolve("")
    root = proj.root
    cfg = _distill_config(root)
    state = _distill_state(root)
    backlog = _distill_backlog_count(root, state)
    trigger_exceeded = cfg["enabled"] and backlog >= cfg["count_trigger"]

    last_run_unix = state.get("last_run")
    last_run_iso = (
        datetime.fromtimestamp(last_run_unix, tz=timezone.utc).isoformat()
        if isinstance(last_run_unix, (int, float))
        else None
    )

    return {
        "backlog": backlog,
        "pending_proposals": _distill_awaiting_resolution_count(root),
        "last_run": last_run_iso,
        "trigger_exceeded": trigger_exceeded,
        "hint": "run distillation in the myco app" if trigger_exceeded else None,
    }


@mcp.tool()
def distill_report() -> dict:
    """No-LLM detection pass: unscored counts by folder, quarantine expiring soon,
    proposals list. Writes nothing unless write=True is added later — v1 read-only."""
    proj = _resolve("")
    root = proj.root
    state = _distill_state(root)
    scored = state.get("scored")
    scored = scored if isinstance(scored, dict) else {}

    unscored_by_folder = {
        start: sum(1 for rel in _walk_inflow_tree(root, start, exclude) if rel not in scored)
        for start, exclude in _DISTILL_INFLOW_TREES
    }

    now = time.time()
    expiring_soon: list[dict] = []
    for sidecar in _distill_quarantine_sidecars(root):
        try:
            data = json.loads(sidecar.read_text("utf-8", errors="replace"))
        except (OSError, json.JSONDecodeError):
            continue
        expires = data.get("expires")
        if not isinstance(expires, (int, float)):
            continue
        if expires - now <= _QUARANTINE_EXPIRING_WINDOW_SECS:
            expiring_soon.append({
                "path": sidecar.relative_to(root).as_posix(),
                "expires": datetime.fromtimestamp(expires, tz=timezone.utc).isoformat(),
            })
    expiring_soon.sort(key=lambda x: x["expires"])

    proposals = [
        {
            "path": path.relative_to(root).as_posix(),
            "action": meta.get("action", ""),
            "title": _proposal_title(body),
        }
        for path, meta, body in _distill_pending_proposals(root)
    ]

    return {
        "unscored_by_folder": unscored_by_folder,
        "quarantine_expiring_soon": expiring_soon,
        "proposals": proposals,
    }


# ─── tools: profile (Phase B, Task 5) ────────────────────────────────────────

# profile.md's header comment, written by every serializer, verbatim in every
# language this personalisation surface has (the app's `profile.ts::
# serializeProfile`, Rust's identity layer only READS the file so it has no
# writer to keep in sync) — a fixed sentence, not localised to the caller.
_PROFILE_HEADER = (
    "<!-- Sent to configured AI providers when profile injection is on (Settings → 증류). -->"
)

# "## <heading>" text (lowercased) -> Profile field — the exact headings
# `_serialize_profile` writes; `_parse_profile` matches case-insensitively so
# a hand-edited file still parses.
_PROFILE_HEADING_FIELD: dict[str, str] = {
    "role": "role",
    "goals": "goals",
    "interests": "interests",
    "working style": "style",
}

INTERVIEW_QUESTIONS: list[dict[str, str]] = [
    {"field": "role", "question": "What is your role/profession?"},
    {"field": "goals", "question": "What are you working toward right now — top 2-3 goals?"},
    {"field": "interests", "question": "Which topics should this knowledge base prioritize? List 3-8."},
    {"field": "style", "question": "How do you like answers — depth, format, tone?"},
]


def _parse_profile(text: str) -> dict:
    """Tiny plain-string scan over profile.md's frontmatter-less sections —
    independently mirrors the app's `profile.ts::parseProfile` and Rust's
    `distill.rs::read_profile_interests`; no code is shared cross-language,
    so keep all three in sync if the section format ever changes. "## Goals"/
    "## Interests" collect bullet lines; "## Role"/"## Working style" join
    every non-empty line under the heading into one line."""
    profile: dict[str, Any] = {"role": "", "goals": [], "interests": [], "style": ""}
    section: str | None = None
    for line in text.splitlines():
        s = line.strip()
        m = re.match(r"^#{2}\s+(.+)$", s)
        if m:
            section = _PROFILE_HEADING_FIELD.get(m.group(1).strip().lower())
            continue
        if section in ("goals", "interests"):
            bm = re.match(r"^[-*]\s+(.+)$", s)
            if bm:
                profile[section].append(bm.group(1).strip())
        elif section in ("role", "style") and s:
            profile[section] = f"{profile[section]} {s}".strip()
    return profile


def _sanitize_line(s: str) -> str:
    """Collapses embedded newlines to a single space — mirrors the app's
    `profile.ts::sanitizeLine` (review-caught bug: an interests/goals item,
    or role/style, containing e.g. "foo\\n## Working style\\ninjected"
    corrupted the round-trip: later items were dropped and the injected
    text landed under the wrong field). `setup_profile` takes raw
    strings/lists straight through — no textarea to rely on — so this has
    to happen here at serialize. Applied to every field, including Working
    style: `injectionText`'s contract is one paragraph anyway."""
    return re.sub(r"\s*\n+\s*", " ", s).strip()


def _serialize_profile(p: dict) -> str:
    """Inverse of `_parse_profile` — the only writer of profile.md's shape."""
    def bullets(items: list) -> str:
        return "\n".join(f"- {_sanitize_line(i)}" for i in items)

    return (
        f"{_PROFILE_HEADER}\n\n"
        f"## Role\n{_sanitize_line(p.get('role') or '')}\n\n"
        f"## Goals\n{bullets(p.get('goals') or [])}\n\n"
        f"## Interests\n{bullets(p.get('interests') or [])}\n\n"
        f"## Working style\n{_sanitize_line(p.get('style') or '')}\n"
    )


@mcp.tool()
def setup_profile(role: str = "", goals: list[str] | None = None,
                   interests: list[str] | None = None, style: str = "",
                   project: str = "") -> dict:
    """Interview-driven personalisation. Call with NO arguments to receive the interview
    questions; ask the user conversationally, then call again with the collected answers
    to write/update <vault>/profile.md (merges: empty args keep existing values).
    The profile weights distillation priorities and, in the app, Ask/ingest context."""
    proj = _resolve(project)
    path = proj.root / "profile.md"
    existing: dict | None = None
    if path.exists():
        try:
            existing = _parse_profile(path.read_text(encoding="utf-8"))
        except OSError:
            existing = None

    if not role and not goals and not interests and not style:
        return {"questions": INTERVIEW_QUESTIONS, "existing": existing}

    merged = dict(existing or {"role": "", "goals": [], "interests": [], "style": ""})
    if role:
        merged["role"] = role
    if goals:
        merged["goals"] = goals
    if interests:
        merged["interests"] = interests
    if style:
        merged["style"] = style

    content = _serialize_profile(merged)
    path.write_text(content, encoding="utf-8")
    # Vault-root-relative, not `_rel_to_repo` (repo-root-relative): profile.md
    # always lives at the vault root regardless of which project this is, so
    # this is always exactly "profile.md" — the more useful and more stable
    # answer for a caller that only knows `project`, not this server's repo
    # layout.
    out = {"ok": True, "path": str(path.relative_to(proj.root)), "profile": merged}
    # SEC-03: warn (not block) — profile.md is mutable, so a redact-and-resave
    # fixes it (unlike raw/, where add_raw_source refuses before writing).
    hits = scan_secrets(content)
    if hits:
        out["secret_warning"] = (
            "possible secrets detected: " + ", ".join(hits) + " — profile.md is sent "
            "to configured AI providers when injection is on; redact and re-save if unintended."
        )
    return out


# ─── entry point ─────────────────────────────────────────────────────────────


DEFAULT_SSE_PORT = 22360  # matches the Obsidian Local REST API MCP convention


def _run_sse(host: str, port: int) -> None:
    """Serve SSE, requiring a bearer token when MYCO_MCP_TOKEN is set.

    The server binds loopback and the MCP SDK turns on DNS-rebinding protection
    for a 127.0.0.1 host, so a web page cannot reach it. Another LOCAL process
    can, and there was nothing to stop it: with no credential at all, anything
    running as this user could list the tools and call create_page / update_page
    / add_raw_source / git_commit against whatever vault the app has open. That
    is a real escalation for a caller that has network access but not file access
    — a sandboxed helper, say.

    The app mints a token per launch and passes it in the environment; the
    registration string it shows the user carries the matching header. Run by
    hand with no token set, the server keeps its old open behaviour: this is a
    local dev tool and demanding a credential a hand-runner does not have would
    only teach people to work around it.
    """
    token = (project_registry.env_var("MYCO_MCP_TOKEN") or "").strip()
    if not token:
        mcp.run(transport="sse")
        return

    import uvicorn
    from starlette.responses import JSONResponse

    expected = f"Bearer {token}".encode()

    class RequireToken:
        """Raw ASGI middleware: check the header, then get out of the way.

        Deliberately not Starlette's BaseHTTPMiddleware, which wraps the
        response and breaks on a long-lived stream — with it in place the SSE
        endpoint raised `AssertionError: Unexpected message` on every client
        disconnect. This one never touches the response, so the stream is
        exactly what the SDK produced.
        """

        def __init__(self, app):  # type: ignore[no-untyped-def]
            self.app = app

        async def __call__(self, scope, receive, send):  # type: ignore[no-untyped-def]
            if scope["type"] != "http":
                await self.app(scope, receive, send)
                return
            got = b""
            for k, v in scope.get("headers") or []:
                if k == b"authorization":
                    got = v
                    break
            # compare_digest: a plain == leaks the token's prefix through timing
            # to a caller that can retry, which is precisely the caller this
            # exists to keep out.
            if not hmac.compare_digest(got, expected):
                await JSONResponse({"error": "unauthorized"}, status_code=401)(
                    scope, receive, send
                )
                return
            await self.app(scope, receive, send)

    app = RequireToken(mcp.sse_app())

    sys.stderr.write("myco-mcp: bearer token required (MYCO_MCP_TOKEN)\n")
    sys.stderr.flush()
    uvicorn.run(app, host=host, port=port, log_level="error")


def main() -> None:
    """Run the MCP server.

    Two transports:

    - **stdio** (default) — Claude spawns the process per session:
        claude mcp add myco -- python <abs path>/myco_mcp.py

    - **sse** — run ONCE as a standalone HTTP server, then point Claude at it
      (the Obsidian style, far simpler to manage):
        python myco_mcp.py --sse            # serves http://127.0.0.1:22360/sse
        claude mcp add --transport sse myco http://localhost:22360/sse

    Flags/env: --sse (or MYCO_MCP_TRANSPORT=sse), --port/-p (MYCO_MCP_PORT),
    --host (MYCO_MCP_HOST). Env vars are the fallback for each flag.
    """
    import argparse
    import os

    parser = argparse.ArgumentParser(prog="myco_mcp", add_help=True)
    parser.add_argument(
        "--sse",
        action="store_true",
        default=(project_registry.env_var("MYCO_MCP_TRANSPORT") or "").lower() == "sse",
        help="serve over HTTP/SSE instead of stdio",
    )
    parser.add_argument(
        "--host",
        default=project_registry.env_var("MYCO_MCP_HOST") or "127.0.0.1",
        help="SSE bind host (default 127.0.0.1)",
    )
    parser.add_argument(
        "-p", "--port",
        type=int,
        default=int(project_registry.env_var("MYCO_MCP_PORT") or DEFAULT_SSE_PORT),
        help=f"SSE port (default {DEFAULT_SSE_PORT})",
    )
    args = parser.parse_args()

    if args.sse:
        mcp.settings.host = args.host
        mcp.settings.port = args.port
        # Startup banner on stderr (stdout must stay clean for stdio clients;
        # here it's just informational for the operator running the server).
        sys.stderr.write(
            f"myco-mcp: serving over SSE at http://{args.host}:{args.port}"
            f"{mcp.settings.sse_path}\n"
            f"  register: claude mcp add --transport sse myco "
            f"http://{args.host if args.host != '0.0.0.0' else 'localhost'}:{args.port}{mcp.settings.sse_path}\n"
        )
        sys.stderr.flush()
        _run_sse(args.host, args.port)
    else:
        mcp.run()


if __name__ == "__main__":
    main()
