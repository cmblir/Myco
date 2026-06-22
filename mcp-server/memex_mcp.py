#!/usr/bin/env python3
"""Memex MCP server.

Exposes the Memex wiki vault as a set of MCP tools so Claude (Desktop, Code,
or any MCP client) can read, search, and maintain the wiki directly.

Design notes
------------
- Standalone: this file is the only entry point. It runs over stdio so it is
  registered with `claude mcp add memex -- python <abs path>/memex_mcp.py`.
- Uses the sibling `project_registry` module (no side effects) to resolve the
  project layout (legacy or multi-project under `projects/<slug>/`).
- raw/ is immutable: `add_raw_source` refuses to overwrite. wiki/ is writable.
"""

from __future__ import annotations

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
        "immutable. Commit groups of related changes with git_commit."
    ),
)

# ─── small helpers (kept local to keep this server lean) ─────────────────────

FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)
WIKILINK_RE = re.compile(r"\[\[([^\]|]+)(?:\|[^\]]*)?\]\]")
WORD_RE = re.compile(r"[\w가-힣]+")


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


@mcp.tool()
def search(query: str, top_k: int = 10, project: str = "") -> dict:
    """TF-IDF search across wiki pages. Returns ranked snippets.

    Args:
        query: Search query (Korean and English supported).
        top_k: Number of results (default 10).
        project: Project slug (empty = active/legacy).
    """
    proj = _resolve(project)
    q_tokens = WORD_RE.findall(query.lower())
    if not q_tokens or not proj.wiki_dir.exists():
        return {"project": proj.slug, "results": []}

    docs: dict[str, dict] = {}
    for md in proj.wiki_dir.rglob("*.md"):
        rel = str(md.relative_to(proj.wiki_dir))
        text = md.read_text("utf-8")
        _, body = parse_fm(text)
        tokens = WORD_RE.findall(body.lower())
        if tokens:
            docs[rel] = {"tokens": tokens, "body": body}
    if not docs:
        return {"project": proj.slug, "results": []}

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
    top = scores[: max(1, top_k)]
    results: list[dict] = []
    for path, sc in top:
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
    return {"project": proj.slug, "results": results}


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
    return {
        "ok": True,
        "project": proj.slug,
        "raw_path": str(target.relative_to(REPO_ROOT)),
        "src_slug": f"src-{target.stem}",
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


# ─── entry point ─────────────────────────────────────────────────────────────


def main() -> None:
    """Run over stdio (default). Used by `claude mcp add memex -- ...`."""
    mcp.run()


if __name__ == "__main__":
    main()
