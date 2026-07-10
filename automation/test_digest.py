"""Tests for the digest runner (Feature 7 app-closed path)."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from digest import build_prompt, digest_path, format_note, run, slugify


def _vault(tmp_path: Path, schedules: list[dict]) -> Path:
    (tmp_path / ".memex").mkdir(parents=True)
    (tmp_path / ".memex" / "schedules.json").write_text(
        json.dumps(schedules), "utf-8"
    )
    return tmp_path


def test_slugify():
    assert slugify("Weekly Review!") == "weekly-review"
    assert slugify("") == "digest"


def test_build_prompt_per_kind():
    assert build_prompt({"kind": "query", "prompt": "hi?"}, "") == "hi?"
    assert "what changed" in build_prompt({"kind": "changed"}, "- 2026 x").lower()
    assert "- 2026 x" in build_prompt({"kind": "changed"}, "- 2026 x")
    assert "maintenance" in build_prompt({"kind": "stale"}, "").lower()
    assert "scaling" in build_prompt({"kind": "topic", "prompt": "scaling"}, "")


def test_format_note_has_frontmatter_and_heading():
    md = format_note(
        {"title": "Weekly", "kind": "query", "id": "s1"},
        "Body.",
        "2026-07-11T09:00:00Z",
    )
    assert "kind: query" in md
    assert "schedule: s1" in md
    assert "# Weekly" in md
    assert "Body." in md


def test_digest_path(tmp_path):
    p = digest_path(
        tmp_path, {"title": "Weekly Review", "output_dir": "digests"}, "2026-07-11T00:00:00Z"
    )
    assert p == tmp_path / "digests" / "2026-07-11-weekly-review.md"


def test_run_dry_run_does_not_write(tmp_path):
    v = _vault(tmp_path, [{"id": "s1", "title": "T", "kind": "query", "prompt": "q?"}])
    res = run(v, "s1", now=datetime(2026, 7, 11, tzinfo=timezone.utc), dry_run=True)
    assert res["ok"] and res["dry_run"]
    assert res["prompt"] == "q?"
    assert not (v / "digests").exists()


def test_run_writes_note_and_stamps_last_run(tmp_path):
    v = _vault(tmp_path, [{"id": "s1", "title": "Weekly", "kind": "query", "prompt": "q?"}])

    def fake_claude(vault, prompt, tools, timeout):
        assert tools == "Read,Grep,Glob"  # read-only, never Bash
        return 0, "Digest body [[attention]].", ""

    now = datetime(2026, 7, 11, 9, 0, 0, tzinfo=timezone.utc)
    res = run(v, "s1", now=now, run_claude=fake_claude)
    assert res["ok"]
    note = Path(res["path"])
    assert note.exists()
    assert "Digest body" in note.read_text("utf-8")
    # last_run stamped.
    data = json.loads((v / ".memex" / "schedules.json").read_text("utf-8"))
    assert data[0]["last_run"] == int(now.timestamp())


def test_run_unknown_schedule_errors(tmp_path):
    v = _vault(tmp_path, [])
    res = run(v, "nope", now=datetime(2026, 7, 11, tzinfo=timezone.utc))
    assert not res["ok"]


def test_run_claude_failure_writes_nothing(tmp_path):
    v = _vault(tmp_path, [{"id": "s1", "title": "T", "kind": "query", "prompt": "q?"}])
    res = run(v, "s1", now=datetime(2026, 7, 11, tzinfo=timezone.utc),
              run_claude=lambda *a: (1, "", "boom"))
    assert not res["ok"]
    assert not (v / "digests").exists()
