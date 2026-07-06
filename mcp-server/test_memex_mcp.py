"""Unit tests for the pure functions in memex_mcp.py / project_registry.py
(backlog DX-01). Run from mcp-server/:  .venv/bin/python -m pytest -q
"""

import pytest

from memex_mcp import (
    extract_links,
    find_contradictions,
    lint_page_text,
    parse_cross_links,
    parse_fm,
    scan_secrets,
    suggest_confidence,
)
from project_registry import _validate_slug, make_slug


# ─── parse_fm ────────────────────────────────────────────────────────────────


def test_parse_fm_scalars_and_lists():
    meta, body = parse_fm(
        "---\n"
        "title: \"Scaling Laws\"\n"
        "type: concept\n"
        "tags:\n  - ai\n  - ml\n"
        "aliases: [a, 'b']\n"
        "source_count: 2\n"
        "---\n"
        "Body text.\n"
    )
    assert meta["title"] == "Scaling Laws"
    assert meta["type"] == "concept"
    assert meta["tags"] == ["ai", "ml"]
    assert meta["aliases"] == ["a", "b"]
    assert meta["source_count"] == "2"
    assert body == "Body text.\n"


def test_parse_fm_without_frontmatter_returns_whole_text():
    meta, body = parse_fm("no frontmatter here")
    assert meta == {}
    assert body == "no frontmatter here"


# ─── extract_links ───────────────────────────────────────────────────────────


def test_extract_links_dedupes_sorts_and_appends_md():
    body = "See [[b]] and [[a|Alias]] and [[b]] and [[c.md]]."
    assert extract_links(body) == ["a.md", "b.md", "c.md"]


def test_extract_links_empty_body():
    assert extract_links("plain text") == []


# ─── make_slug / _validate_slug ──────────────────────────────────────────────


def test_make_slug_normalizes():
    assert make_slug("  Scaling Laws!  ") == "scaling-laws"
    assert make_slug("A__B   C") == "a-b-c"


def test_make_slug_empty_falls_back_to_untitled():
    assert make_slug("!!!").startswith("untitled-")


@pytest.mark.parametrize(
    "bad", ["", "../x", "a/b", "a\\b", ".hidden", "a\x00b"]
)
def test_validate_slug_rejects_traversal(bad):
    with pytest.raises(ValueError):
        _validate_slug(bad)


def test_validate_slug_accepts_normal():
    assert _validate_slug("karpathy-llm") == "karpathy-llm"


# ─── scan_secrets (SEC-03) ───────────────────────────────────────────────────


def test_scan_secrets_detects_common_token_shapes():
    text = (
        "aws AKIAIOSFODNN7EXAMPLE and openai sk-abcdefghijklmnopqrstuv123 "
        "and gh ghp_" + "a" * 36 + "\n-----BEGIN RSA PRIVATE KEY-----\n"
    )
    hits = scan_secrets(text)
    assert "AWS access key" in hits
    assert "OpenAI/Anthropic-style API key" in hits
    assert "GitHub token" in hits
    assert "Private key block" in hits


def test_scan_secrets_ignores_prose():
    assert scan_secrets("Discussing api keys and passwords in general.") == []


# ─── suggest_confidence (GOV-03) ─────────────────────────────────────────────


def test_suggest_confidence_scales_with_trust_and_citations():
    assert suggest_confidence("peer-reviewed", 3) == "high"
    assert suggest_confidence("tweet", 0) == "low"
    assert suggest_confidence("blog", 3) == "medium"
    # unknown/absent source → neutral trust
    assert suggest_confidence(None, 0) == "low"
    assert suggest_confidence(None, 3) in {"medium", "high"}


# ─── parse_cross_links (FEAT-02) ─────────────────────────────────────────────


def test_parse_cross_links_extracts_project_and_page():
    body = "See [[other-proj::some-page]] and [[proj2::deep/note|Alias]]."
    assert parse_cross_links(body) == [
        ("other-proj", "some-page"),
        ("proj2", "deep/note"),
    ]


def test_parse_cross_links_ignores_plain_wikilinks():
    assert parse_cross_links("just [[a-normal-link]] here") == []


# ─── find_contradictions (GOV-01) ────────────────────────────────────────────


def test_find_contradictions_flags_disputed_and_stale_links():
    pages = {
        "a.md": {"meta": {"status": "active"}, "links": ["old.md"]},
        "old.md": {"meta": {"status": "superseded"}, "links": []},
        "b.md": {"meta": {"status": "disputed"}, "links": []},
    }
    found = find_contradictions(pages)
    kinds = {(f["kind"], f["page"]) for f in found}
    assert ("disputed", "b.md") in kinds
    assert ("stale-link", "a.md") in kinds


def test_find_contradictions_clean_graph():
    pages = {
        "a.md": {"meta": {"status": "active"}, "links": ["b.md"]},
        "b.md": {"meta": {"status": "active"}, "links": []},
    }
    assert find_contradictions(pages) == []


# ─── lint_page_text (GOV-02) ─────────────────────────────────────────────────

CLEAN_PAGE = (
    "---\n"
    "title: \"X\"\n"
    "type: concept\n"
    "source_count: 1\n"
    "status: active\n"
    "---\n"
    "A claim.[^src-a]\n\n"
    "[^src-a]: [[source-a]]\n"
)


def test_lint_clean_page_has_no_problems():
    assert lint_page_text(CLEAN_PAGE) == []


def test_lint_missing_frontmatter():
    assert lint_page_text("just text") == ["missing frontmatter"]


def test_lint_invalid_type_and_missing_type():
    bad = CLEAN_PAGE.replace("type: concept", "type: banana")
    assert "invalid `type`: banana" in lint_page_text(bad)
    missing = CLEAN_PAGE.replace("type: concept\n", "")
    assert "missing `type`" in lint_page_text(missing)


def test_lint_undefined_and_unused_citations():
    page = (
        "---\ntitle: x\ntype: concept\n---\n"
        "Claim.[^src-used]\n\n"
        "[^src-used]: [[source-used]]\n"
        "[^src-orphan]: [[source-orphan]]\n"
    )
    problems = lint_page_text(page + "More.[^src-missing]\n")
    assert "citation [^src-missing] has no definition" in problems
    assert "footnote [^src-orphan] defined but never referenced" in problems


def test_lint_source_count_mismatch():
    bad = CLEAN_PAGE.replace("source_count: 1", "source_count: 3")
    assert any("source_count=3 but 1" in p for p in lint_page_text(bad))


def test_lint_meta_pages_are_exempt():
    meta_page = "---\ntitle: Log\ntype: overview\n---\nNo citations here.\n"
    assert lint_page_text(meta_page) == []


def test_lint_superseded_and_disputed_contracts():
    sup = CLEAN_PAGE.replace("status: active", "status: superseded")
    assert "status=superseded without `superseded_by`" in lint_page_text(sup)
    disp = CLEAN_PAGE.replace("status: active", "status: disputed")
    assert "status=disputed without a `## Disputed` section" in lint_page_text(disp)
    disp_ok = disp + "\n## Disputed\n\n> contested\n"
    assert lint_page_text(disp_ok) == []
