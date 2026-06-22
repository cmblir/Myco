#!/usr/bin/env python3
"""Unit tests for automation/autoingest.py. Run: python automation/test_autoingest.py

The claude CLI call is injected (run_claude), so these exercise the full
orchestration — extraction dispatch, raw/ creation, change detection, archiving,
and rollback — with no network and no real model.
"""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import autoingest as ai  # noqa: E402


def make_vault() -> Path:
    d = Path(tempfile.mkdtemp(prefix="memex-autoingest-test-"))
    (d / "_inbox").mkdir()
    (d / "raw").mkdir()
    (d / "wiki").mkdir()
    (d / "wiki" / "index.md").write_text("# Index\n", encoding="utf-8")
    return d


class TestAutoIngest(unittest.TestCase):
    def test_find_pending_skips_dot_and_archive(self):
        v = make_vault()
        (v / "_inbox" / "a.md").write_text("x")
        (v / "_inbox" / ".hidden.md").write_text("x")
        (v / "_inbox" / ".archived").mkdir()
        (v / "_inbox" / ".archived" / "old.md").write_text("x")
        names = [p.name for p in ai.find_pending(v)]
        self.assertEqual(names, ["a.md"])

    def test_slugify(self):
        self.assertEqual(ai.slugify("Hello World"), "hello-world")
        self.assertEqual(ai.slugify("GPT-4: A Review!"), "gpt-4-a-review")
        self.assertTrue(ai.slugify("!!!").startswith("source-"))

    def test_unique_raw_path_avoids_collision(self):
        v = make_vault()
        (v / "raw" / "note.md").write_text("existing")
        p = ai.unique_raw_path(v, "note")
        self.assertEqual(p.name, "note-2.md")

    def test_ingest_one_success_archives_source(self):
        v = make_vault()
        src = v / "_inbox" / "my-source.md"
        src.write_text("Some source text about transformers.", encoding="utf-8")

        # Mock CLI: simulate a successful ingest by writing a wiki page.
        def fake_claude(vault, prompt, model, tools, timeout):
            (vault / "wiki" / "transformers.md").write_text("# Transformers\n", encoding="utf-8")
            self.assertIn("raw/my-source.md", prompt)
            self.assertNotIn("Bash", tools)  # H1: ingest must not pre-authorize Bash
            return 0, "ingested", ""

        res = ai.ingest_one(v, src, run_claude=fake_claude)
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["slug"], "my-source")
        # raw/ gained the source; _inbox source moved to .archived (not deleted).
        self.assertTrue((v / "raw" / "my-source.md").is_file())
        self.assertFalse(src.exists())
        self.assertTrue((v / "_inbox" / ".archived" / "my-source.md").is_file())

    def test_ingest_one_noop_rolls_back_and_keeps_source(self):
        v = make_vault()
        src = v / "_inbox" / "dud.md"
        src.write_text("text", encoding="utf-8")

        def fake_claude(vault, prompt, model, tools, timeout):
            return 0, "nothing changed", ""  # no wiki write -> no change

        res = ai.ingest_one(v, src, run_claude=fake_claude)
        self.assertFalse(res["ok"])
        # The raw/ file we created is rolled back; the source stays for retry.
        self.assertFalse((v / "raw" / "dud.md").exists())
        self.assertTrue(src.exists())

    def test_ingest_one_unsupported_binary(self):
        v = make_vault()
        src = v / "_inbox" / "image.png"
        src.write_bytes(b"\x89PNG\r\n")
        res = ai.ingest_one(v, src, run_claude=lambda *a: (0, "", ""), app_bin=None)
        self.assertFalse(res["ok"])
        self.assertIn("unsupported", res["error"])

    def test_run_once_processes_all_pending(self):
        v = make_vault()
        for i in range(3):
            (v / "_inbox" / f"s{i}.md").write_text(f"source {i}", encoding="utf-8")
        calls = {"n": 0}

        def fake_claude(vault, prompt, model, tools, timeout):
            calls["n"] += 1
            (vault / "wiki" / f"page{calls['n']}.md").write_text("# p\n", encoding="utf-8")
            return 0, "ok", ""

        results = ai.run_once(v, run_claude=fake_claude)
        self.assertEqual(len(results), 3)
        self.assertTrue(all(r["ok"] for r in results))
        self.assertEqual(calls["n"], 3)
        # A JSONL pass log was written.
        self.assertTrue((v / "_inbox" / "autoingest.log.jsonl").is_file())


if __name__ == "__main__":
    unittest.main(verbosity=2)
