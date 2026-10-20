"""CLI input tests use only invented metadata; no base export is executed."""

import builtins
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from export_qwen3_base import read_metadata


class BaseExportInputTests(unittest.TestCase):
    def test_module_import_does_not_load_model_or_tokenizer_packages(self):
        original = builtins.__import__

        def guarded(name, *args, **kwargs):
            if name.split(".")[0] in {"numpy", "mlx", "mlx_lm", "torch", "gguf", "transformers", "tokenizers"}:
                raise AssertionError("Unexpected runtime import: " + name)
            return original(name, *args, **kwargs)

        path = Path(__file__).with_name("export_qwen3_base.py")
        spec = importlib.util.spec_from_file_location("base_export_import_test", path)
        with patch("builtins.__import__", guarded):
            spec.loader.exec_module(importlib.util.module_from_spec(spec))

    def test_only_exact_pinned_regular_metadata_bytes_are_returned(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory).resolve() / "invented.json"
            content = b'{"synthetic":true}\n'
            path.write_bytes(content)
            digest = hashlib.sha256(content).hexdigest()
            self.assertEqual(read_metadata(path, digest, len(content)), content)
            self.assertEqual(read_metadata(path, digest), content)
            for expected_digest, size in (("0" * 64, len(content)), (digest, len(content) + 1), ("invalid", None)):
                with self.subTest(digest=expected_digest, size=size), self.assertRaises(ValueError):
                    read_metadata(path, expected_digest, size)
            alias = path.with_name("alias.json")
            alias.symlink_to(path)
            with self.assertRaises(ValueError):
                read_metadata(alias, digest)
            with self.assertRaises(ValueError):
                read_metadata(path.parent, digest)

    def test_replacement_during_read_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory).resolve() / "invented.json"
            content = b'{"synthetic":true}\n'
            path.write_bytes(content)
            digest = hashlib.sha256(content).hexdigest()
            import os
            original = os.fdopen

            def replace_then_open(descriptor, *args, **kwargs):
                path.rename(path.with_suffix(".old"))
                path.write_bytes(content)
                return original(descriptor, *args, **kwargs)

            with patch("export_qwen3_base.os.fdopen", side_effect=replace_then_open):
                with self.assertRaisesRegex(ValueError, "changed"):
                    read_metadata(path, digest)


if __name__ == "__main__":
    unittest.main()
