"""Legacy automation boundary and partial-source preservation regressions.

All sources are synthetic temporary files. Injected runners test orchestration;
they do not establish model quality or checked native publication.
"""

import contextlib
import io
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import autoingest as ai


class TestAutoIngestSafety(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="myco-autoingest-safety-")
        self.addCleanup(self.directory.cleanup)
        self.vault = Path(self.directory.name)
        for name in ["_inbox", "raw", "wiki"]:
            (self.vault / name).mkdir()
        self.source = self.vault / "_inbox" / "synthetic.md"
        self.source.write_text("Synthetic source backing a partial page.\n", encoding="utf-8")
        (self.vault / "raw" / "sentinel.md").write_text("Original sentinel.\n", encoding="utf-8")

    def snapshot(self):
        return {
            str(path.relative_to(self.vault)): path.read_bytes()
            for path in self.vault.rglob("*")
            if path.is_file()
        }

    def write_partial_page(self):
        (self.vault / "wiki" / "partial.md").write_text(
            "# Partial\n\nSynthetic claim.[^src-synthetic]\n", encoding="utf-8"
        )

    def assert_preserved_failure(self, result):
        self.assertFalse(result["ok"], result)
        self.assertEqual(self.source.read_text("utf-8"), "Synthetic source backing a partial page.\n")
        self.assertEqual(
            (self.vault / "raw" / "synthetic.md").read_bytes(), self.source.read_bytes()
        )
        self.assertEqual(result["raw"], "raw/synthetic.md")
        self.assertTrue((self.vault / "wiki" / "partial.md").is_file())
        self.assertFalse((self.vault / "_inbox" / ".archived").exists())

    def test_default_ingest_rejects_before_read_write_or_spawn(self):
        before = self.snapshot()
        with patch.object(ai, "_read_source", side_effect=AssertionError("unexpected source read")), \
                patch.object(ai.subprocess, "run", side_effect=AssertionError("unexpected process")) as runner:
            result = ai.ingest_one(self.vault, self.source)
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "unavailable")
        self.assertIn("unavailable", result["error"])
        runner.assert_not_called()
        self.assertEqual(self.snapshot(), before)

    def test_default_runner_cannot_spawn_when_called_directly(self):
        with patch.object(ai.subprocess, "run", side_effect=AssertionError("unexpected process")) as runner:
            code, output, error = ai.default_run_claude(self.vault, "synthetic", "haiku", "Read", 1)
        self.assertNotEqual(code, 0)
        self.assertEqual(output, "")
        self.assertIn("unavailable", error)
        runner.assert_not_called()

    def test_main_reports_unavailable_without_creating_vault_entries(self):
        empty_vault = self.vault / "empty"
        empty_vault.mkdir()
        error = io.StringIO()
        with contextlib.redirect_stderr(error), \
                patch.object(ai.subprocess, "run", side_effect=AssertionError("unexpected process")) as runner:
            code = ai.main(["--vault", str(empty_vault), "--once"])
        self.assertNotEqual(code, 0)
        self.assertIn("unavailable", error.getvalue())
        self.assertEqual(list(empty_vault.iterdir()), [])
        runner.assert_not_called()

    def test_default_daemon_rejects_before_loop_or_sleep(self):
        with patch.object(ai, "run_once", side_effect=AssertionError("unexpected pass")) as run, \
                patch.object(ai.time, "sleep", side_effect=AssertionError("unexpected sleep")) as sleep:
            with self.assertRaisesRegex(RuntimeError, "unavailable"):
                ai.run_daemon(self.vault, 1, logger=lambda _: None)
        run.assert_not_called()
        sleep.assert_not_called()

    def test_default_pass_rejects_before_listing_or_journal_write(self):
        before = self.snapshot()
        with patch.object(ai, "find_pending", side_effect=AssertionError("unexpected listing")) as listing, \
                patch.object(ai, "_append_log", side_effect=AssertionError("unexpected journal")) as journal:
            with self.assertRaisesRegex(RuntimeError, "unavailable"):
                ai.run_once(self.vault)
        listing.assert_not_called()
        journal.assert_not_called()
        self.assertEqual(self.snapshot(), before)

    def test_failed_partial_write_retains_immutable_raw_backing(self):
        def partial_runner(*_):
            self.write_partial_page()
            return 1, "", "synthetic generation failed"

        self.assert_preserved_failure(ai.ingest_one(self.vault, self.source, run_claude=partial_runner))

    def test_timed_out_partial_write_retains_immutable_raw_backing(self):
        def partial_runner(*_):
            self.write_partial_page()
            raise subprocess.TimeoutExpired("synthetic-runner", 1)

        result = ai.ingest_one(self.vault, self.source, run_claude=partial_runner)
        self.assert_preserved_failure(result)
        self.assertIn("timed out", result["error"])

    def test_missing_runner_after_partial_write_retains_immutable_raw_backing(self):
        def partial_runner(*_):
            self.write_partial_page()
            raise FileNotFoundError("synthetic transport disappeared")

        result = ai.ingest_one(self.vault, self.source, run_claude=partial_runner)
        self.assert_preserved_failure(result)
        self.assertIn("not found", result["error"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
