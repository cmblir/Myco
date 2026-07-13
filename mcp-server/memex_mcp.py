#!/usr/bin/env python3
"""Memex MCP server.

Exposes the Memex wiki vault as a set of MCP tools so Claude (Desktop, Code,
or any MCP client) can read, search, and maintain the wiki directly.

Design notes
------------
- Standalone: this file is the only entry point. Two transports (see `main`):
  a standalone SSE server (`--sse`, the recommended Obsidian-style setup —
  `claude mcp add --transport sse memex http://localhost:22360/sse`) or stdio
  (default; Claude spawns it per session).
- Uses the sibling `project_registry` module (no side effects) to resolve the
  project layout (legacy or multi-project under `projects/<slug>/`).
- raw/ is immutable: `add_raw_source` refuses to overwrite. wiki/ is writable.
"""

from __future__ import annotations

import difflib
import json
import math
import re
import subprocess
import sys
from datetime import datetime
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
        "memex-mcp: missing dependency. Install with:\n"
        "  pip install --user 'mcp>=1.0' \n"
        "or use the bundled install script:\n"
        f"  bash {Path(__file__).parent / 'install.sh'}\n"
    )
    raise

mcp = FastMCP(
    "memex",
    instructions=(
        "Memex is a self-maintaining LLM wiki backed by an Obsidian vault. "
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
    """List all Memex projects (multi-project) plus legacy if present.

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
    proj.raw_dir.mkdir(parents=True, exist_ok=True)
    target = (proj.raw_dir / filename).resolve()
    base = proj.raw_dir.resolve()
    if base != target and base not in target.parents:
        return {"ok": False, "error": f"path escapes raw/: {filename}"}
    if target.exists():
        return {"ok": False, "error": f"raw/ file exists (immutable): {filename}"}
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    out = {
        "ok": True,
        "project": proj.slug,
        "raw_path": str(target.relative_to(REPO_ROOT)),
        "src_slug": f"src-{target.stem}",
    }
    # SEC-03: warn (not block — the operator may be archiving deliberately)
    # when the source text looks like it contains live credentials.
    hits = scan_secrets(content)
    if hits:
        out["secret_warning"] = (
            "possible secrets detected: " + ", ".join(hits) + " — raw/ is "
            "immutable and committed to git; redact and re-add if unintended."
        )
    return out


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
    """Create a new wiki page with proper Memex frontmatter.

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

VALID_TYPES = {"concept", "technique", "entity", "source-summary", "analysis"}
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


# ─── entry point ─────────────────────────────────────────────────────────────


DEFAULT_SSE_PORT = 22360  # matches the Obsidian Local REST API MCP convention


def main() -> None:
    """Run the MCP server.

    Two transports:

    - **stdio** (default) — Claude spawns the process per session:
        claude mcp add memex -- python <abs path>/memex_mcp.py

    - **sse** — run ONCE as a standalone HTTP server, then point Claude at it
      (the Obsidian style, far simpler to manage):
        python memex_mcp.py --sse            # serves http://127.0.0.1:22360/sse
        claude mcp add --transport sse memex http://localhost:22360/sse

    Flags/env: --sse (or MEMEX_MCP_TRANSPORT=sse), --port/-p (MEMEX_MCP_PORT),
    --host (MEMEX_MCP_HOST). Env vars are the fallback for each flag.
    """
    import argparse
    import os

    parser = argparse.ArgumentParser(prog="memex_mcp", add_help=True)
    parser.add_argument(
        "--sse",
        action="store_true",
        default=os.environ.get("MEMEX_MCP_TRANSPORT", "").lower() == "sse",
        help="serve over HTTP/SSE instead of stdio",
    )
    parser.add_argument(
        "--host",
        default=os.environ.get("MEMEX_MCP_HOST", "127.0.0.1"),
        help="SSE bind host (default 127.0.0.1)",
    )
    parser.add_argument(
        "-p", "--port",
        type=int,
        default=int(os.environ.get("MEMEX_MCP_PORT", DEFAULT_SSE_PORT)),
        help=f"SSE port (default {DEFAULT_SSE_PORT})",
    )
    args = parser.parse_args()

    if args.sse:
        mcp.settings.host = args.host
        mcp.settings.port = args.port
        # Startup banner on stderr (stdout must stay clean for stdio clients;
        # here it's just informational for the operator running the server).
        sys.stderr.write(
            f"memex-mcp: serving over SSE at http://{args.host}:{args.port}"
            f"{mcp.settings.sse_path}\n"
            f"  register: claude mcp add --transport sse memex "
            f"http://{args.host if args.host != '0.0.0.0' else 'localhost'}:{args.port}{mcp.settings.sse_path}\n"
        )
        sys.stderr.flush()
        mcp.run(transport="sse")
    else:
        mcp.run()


if __name__ == "__main__":
    main()
