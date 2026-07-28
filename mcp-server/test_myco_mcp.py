"""Unit tests for the pure functions in myco_mcp.py / project_registry.py
(backlog DX-01). Run from mcp-server/:  .venv/bin/python -m pytest -q
"""

from pathlib import Path

import pytest

from myco_mcp import (
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


# ─── registry symlink confinement ────────────────────────────────────────────
#
# `projects/` living in a vault means a shared or downloaded vault can ship one.
# The Rust registry (app/src-tauri/src/registry.rs) resolves this deliberately
# and says why in a comment: confining against `canonicalize(projects_dir)`
# resolves a symlinked `projects` component to its TARGET and then confines to
# the target, so `projects -> ../..` plus a slug naming a sibling of the registry
# root escapes. These two registries are mirrors of the same projects.json logic
# and had drifted on exactly that check — while this one backs a long-running
# server with vault write and git tools.


def _registry_with_root(tmp_path, monkeypatch):
    """Reload project_registry against a throwaway vault root."""
    import importlib
    import project_registry

    monkeypatch.setenv("MYCO_PROJECT_ROOT", str(tmp_path))
    return importlib.reload(project_registry)


def test_symlinked_projects_dir_cannot_escape(tmp_path, monkeypatch):
    outside = tmp_path / "outside"
    (outside / "Secrets").mkdir(parents=True)
    vault = tmp_path / "vault"
    vault.mkdir()
    # The hostile shape: projects/ is a symlink pointing out of the vault.
    (vault / "projects").symlink_to(outside, target_is_directory=True)

    reg = _registry_with_root(vault, monkeypatch)
    with pytest.raises(ValueError):
        reg._validate_slug("Secrets")


def test_symlinked_project_entry_cannot_escape(tmp_path, monkeypatch):
    # The subtler shape: projects/ is real, but one project inside it is a
    # symlink elsewhere.
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    vault = tmp_path / "vault2"
    (vault / "projects").mkdir(parents=True)
    (vault / "projects" / "sneaky").symlink_to(outside, target_is_directory=True)

    reg = _registry_with_root(vault, monkeypatch)
    with pytest.raises(ValueError):
        reg._validate_slug("sneaky")


def test_a_real_project_still_resolves(tmp_path, monkeypatch):
    vault = tmp_path / "vault3"
    (vault / "projects" / "real-one").mkdir(parents=True)
    reg = _registry_with_root(vault, monkeypatch)
    assert reg._validate_slug("real-one") == "real-one"


def test_a_slug_whose_directory_is_gone_still_validates(tmp_path, monkeypatch):
    # The check is about escaping, not existence. list_projects must keep
    # listing an entry whose directory vanished — Rust's project_infos does
    # (with a 0 note count) and only refuses when resolving the path for real.
    # Making the two registries disagree the OTHER way is how they drifted here.
    vault = tmp_path / "vault5"
    (vault / "projects").mkdir(parents=True)
    reg = _registry_with_root(vault, monkeypatch)
    assert reg._validate_slug("not-created-yet") == "not-created-yet"


def test_windows_drive_letter_slug_is_rejected(tmp_path, monkeypatch):
    # The Rust validator rejects ':' for this; the mirror did not.
    vault = tmp_path / "vault4"
    (vault / "projects").mkdir(parents=True)
    reg = _registry_with_root(vault, monkeypatch)
    with pytest.raises(ValueError):
        reg._validate_slug("C:")


# ─── app data dir (M1 mirror of the Rust settings_dir) ───────────────────────


def _isolated_home(tmp_path, monkeypatch):
    """Point the data-dir resolution at a throwaway HOME with no overrides."""
    import project_registry as reg

    monkeypatch.delenv("MYCO_DATA_DIR", raising=False)
    monkeypatch.delenv("MEMEX_DATA_DIR", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    monkeypatch.setenv("APPDATA", str(tmp_path / "AppData"))
    args = (reg._os_name(), str(tmp_path), str(tmp_path / "AppData"))
    old = reg._platform_data_dir(*args, "dev.cmblir.memex", "Memex", "memex")
    new = reg._platform_data_dir(*args, "dev.cmblir.myco", "myco", "myco")
    return reg, old, new


def test_app_data_dir_override_prefers_myco_spelling(tmp_path, monkeypatch):
    import project_registry as reg

    monkeypatch.setenv("MEMEX_DATA_DIR", "/tmp/old-spelling")
    monkeypatch.setenv("MYCO_DATA_DIR", "/tmp/new-spelling")
    assert reg._app_data_dir() == Path("/tmp/new-spelling")
    monkeypatch.delenv("MYCO_DATA_DIR")
    assert reg._app_data_dir() == Path("/tmp/old-spelling")


def test_app_data_dir_reads_the_old_dir_and_never_renames_it(tmp_path, monkeypatch):
    # C2: this module resolves READ-ONLY. It used to rename old→new at import
    # time, so a lint, an IDE or a pytest collection moved a user's data dir —
    # and since install.sh registers the checkout's mcp-server, a `git pull`
    # could move it out from under the still-installed OLD app, which then came
    # up on Settings::default(). Only the desktop app may move it.
    reg, old, new = _isolated_home(tmp_path, monkeypatch)
    old.mkdir(parents=True)
    (old / "active-vault").write_text("/some/vault", "utf-8")

    assert reg._app_data_dir() == old
    assert old.exists(), "the old dir must never be renamed from here"
    assert not new.exists(), "nothing may be created from here either"
    assert (old / "active-vault").read_text("utf-8") == "/some/vault"
    # Repeated calls stay a pure read.
    assert reg._app_data_dir() == old
    assert old.exists() and not new.exists()


def test_app_data_dir_prefers_new_once_the_app_has_migrated(tmp_path, monkeypatch):
    reg, _old, new = _isolated_home(tmp_path, monkeypatch)
    new.mkdir(parents=True)
    (new / "active-vault").write_text("/some/vault", "utf-8")
    assert reg._app_data_dir() == new


def test_app_data_dir_prefers_old_when_new_exists_but_is_stateless(tmp_path, monkeypatch):
    # Mirror of the Rust I4 guard: a new dir that exists but holds none of the
    # marker files the app writes is not proof the migration completed, so the
    # old dir (which does hold them) is what we read.
    reg, old, new = _isolated_home(tmp_path, monkeypatch)
    old.mkdir(parents=True)
    new.mkdir(parents=True)
    (old / "settings.json").write_text("{}", "utf-8")

    assert reg._app_data_dir() == old
    # Once the new dir has state of its own it wins again.
    (new / "settings.json").write_text("{}", "utf-8")
    assert reg._app_data_dir() == new


def test_blank_override_is_treated_as_unset(tmp_path, monkeypatch):
    # I3(a): `MYCO_DATA_DIR=` must not shadow a real MEMEX_DATA_DIR, and must
    # not resolve to Path(""). Rust's var_os took "" literally; the two sides
    # resolved to different directories from the same environment.
    import project_registry as reg

    monkeypatch.setenv("MYCO_DATA_DIR", "")
    monkeypatch.setenv("MEMEX_DATA_DIR", "/tmp/old-spelling")
    assert reg._app_data_dir() == Path("/tmp/old-spelling")

    # Both blank → fall all the way through to the platform default.
    _reg, _old, new = _isolated_home(tmp_path, monkeypatch)
    monkeypatch.setenv("MYCO_DATA_DIR", "  ")
    monkeypatch.setenv("MEMEX_DATA_DIR", "")
    assert reg._app_data_dir() == new


def test_windows_without_appdata_fails_like_the_rust_side(tmp_path):
    # I3(b): Python used to fall back to home/"myco" where Rust errored, so the
    # server read a marker the app would never write. Both now refuse.
    import project_registry as reg

    with pytest.raises(ValueError):
        reg.resolve_env_data_dir("windows", "/home/u", None, None, None)
    assert reg.resolve_env_data_dir("windows", "/home/u", "C:/AppData", None, None) == Path(
        "C:/AppData/myco"
    )


def test_app_data_dir_leaves_both_alone_when_new_has_state(tmp_path, monkeypatch):
    reg, old, new = _isolated_home(tmp_path, monkeypatch)
    old.mkdir(parents=True)
    new.mkdir(parents=True)
    (old / "active-vault").write_text("/old", "utf-8")
    (new / "active-vault").write_text("/new", "utf-8")

    assert reg._app_data_dir() == new
    assert (new / "active-vault").read_text("utf-8") == "/new"
    assert (old / "active-vault").read_text("utf-8") == "/old"


def test_app_data_dir_fresh_install_creates_nothing(tmp_path, monkeypatch):
    reg, old, new = _isolated_home(tmp_path, monkeypatch)
    assert reg._app_data_dir() == new
    assert not old.exists()
    assert not new.exists()


# ---- C4: MYCO_* env names with a MEMEX_* fallback -------------------------


def test_env_var_prefers_the_new_spelling_and_falls_back_to_the_old(monkeypatch):
    import project_registry as reg

    monkeypatch.delenv("MYCO_PROJECT_ROOT", raising=False)
    monkeypatch.delenv("MEMEX_PROJECT_ROOT", raising=False)
    assert reg.env_var("MYCO_PROJECT_ROOT") is None

    # An operator whose shell profile still exports the old name keeps working.
    monkeypatch.setenv("MEMEX_PROJECT_ROOT", "/old")
    assert reg.env_var("MYCO_PROJECT_ROOT") == "/old"

    monkeypatch.setenv("MYCO_PROJECT_ROOT", "/new")
    assert reg.env_var("MYCO_PROJECT_ROOT") == "/new"


def test_env_var_only_rewrites_the_myco_prefix(monkeypatch):
    import project_registry as reg

    monkeypatch.setenv("NOT_MYCO_THING", "x")
    assert reg.env_var("NOT_MYCO_THING") == "x"
