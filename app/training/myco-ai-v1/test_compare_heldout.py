"""Exercise the heldout loader using synthetic controls, never final cases."""

import builtins
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import compare


def dump(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def controls():
    roles = {"planner": "RecallPeriodV1", "extraction": "WikiClaimsV1",
             "session": "SessionStructureV1", "writer": "AskAnswerV1"}
    rows, metadata = [], []
    text = "Synthetic original with 한글 and an unchanged contrary tail."
    span = {"id": "Q1", "sourceId": "R1", "sourcePath": "sessions/control.md",
            "selectionPath": "sessions/control.md", "sourceRevision": hashlib.sha256(text.encode()).hexdigest(),
            "start": 0, "end": len(text.encode()), "sha256": hashlib.sha256(text.encode()).hexdigest(),
            "text": text, "turnId": "T1", "speaker": "unknown", "recordTime": "2040-03-04",
            "turnTime": None, "sourcePhase": None}
    for role, schema in roles.items():
        for _ in range(3):
            identifier = f"H{len(rows) + 1:02d}"
            packet = {"today": "2040-03-04", "originalSpans": [span],
                      "allowedClaimIds": ["C1"], "allowed_source_ids": ["S1"]}
            reference = {
                "planner": {"answer": "2040-03-01..2040-03-04", "sources": []},
                "extraction": {"outcome": "insufficient_evidence", "claims": []},
                "session": {"version": "SessionStructureV1", "title": "REFERENCE_ONLY_SENTINEL",
                            "titleClaimIds": ["C1"], "entities": []},
                "writer": {"answer": "REFERENCE_ONLY_SENTINEL", "sources": ["S1"]},
            }[role]
            messages = [{"role": "system", "content": "Synthetic policy only"},
                        {"role": "user", "content": dump(packet)}]
            rows.append({"messages": messages})
            rubric = {"id": identifier, "family": f"synthetic-control-family-{identifier}",
                      "task": role, "final_evaluation_only": True, "use_for_training_or_selection": False,
                      "input_sha256": hashlib.sha256(dump(messages).encode()).hexdigest(),
                      "expected": {"schema": schema, "reference": reference},
                      "rubric": ["REFERENCE_ONLY_SENTINEL"]}
            if role == "planner":
                rubric["period_constraints"] = {"start_min": "2040-03-01", "start_max": "2040-03-02",
                                                "end_min": "2040-03-03", "end_max": "2040-03-04"}
            metadata.append(rubric)
    manifest = {"version": "myco-heldout-v1", "synthetic_only": True, "cases": metadata,
                "family_count": 12, "task_count": 12, "role_counts": {role: 3 for role in roles},
                "model_inputs_file": "inputs.jsonl", "references_must_not_be_model_input": True,
                "source_sha256": {"author.py": "a" * 64},
                "production_source_sha256": {"policy.rs": "b" * 64},
                "comparison_training_manifest_sha256": "c" * 64,
                "limitations": ["Synthetic controls only; not semantic acceptance."]}
    return rows, manifest


def freeze(directory, rows, manifest):
    body = "".join(dump(row) + "\n" for row in rows).encode()
    manifest = copy.deepcopy(manifest)
    manifest["sha256"] = {"inputs.jsonl": hashlib.sha256(body).hexdigest()}
    (directory / "inputs.jsonl").write_bytes(body)
    (directory / "manifest.json").write_text(dump(manifest), encoding="utf-8")
    return manifest


class HeldoutCompareTests(unittest.TestCase):
    def test_external_inputs_stay_exact_and_references_remain_separate(self):
        rows, manifest = controls()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            frozen = freeze(path, rows, manifest)
            with patch("heldout_v1.build_heldout", side_effect=AssertionError("Do not regenerate final cases")):
                actual, metadata, provenance = compare.load_heldout(path)
            self.assertEqual(actual, rows)
            self.assertEqual(metadata, frozen["cases"])
            self.assertNotIn("REFERENCE_ONLY_SENTINEL", dump(actual))
            self.assertEqual(provenance["inputs_sha256"], frozen["sha256"]["inputs.jsonl"])
            self.assertEqual(provenance["manifest_sha256"], hashlib.sha256((path / "manifest.json").read_bytes()).hexdigest())
            self.assertEqual(provenance["source_sha256"], frozen["source_sha256"])
            self.assertEqual(provenance["production_source_sha256"], frozen["production_source_sha256"])
            for rubric in manifest["cases"]:
                rubric["rubric"] = ["OTHER_REFERENCE_ONLY_MARKER"]
            freeze(path, rows, manifest)
            self.assertEqual(compare.load_heldout(path)[0], rows)

    def test_changed_input_bytes_fail_before_parsing_or_model_access(self):
        rows, manifest = controls()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            freeze(path, rows, manifest)
            with (path / "inputs.jsonl").open("ab") as handle:
                handle.write(b" ")
            with self.assertRaisesRegex(ValueError, "input digest mismatch"):
                compare.load_heldout(path)

    def test_binding_schedule_role_and_message_leakage_are_rejected(self):
        for change in ("binding", "schedule", "role", "assistant", "extra_message_key", "selection"):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as directory:
                rows, manifest = controls()
                if change == "binding":
                    rows[0]["messages"][1]["content"] += " "
                elif change == "schedule":
                    manifest["task_count"] = 11
                elif change == "role":
                    manifest["cases"][0]["task"] = "writer"
                elif change == "assistant":
                    rows[0]["messages"].append({"role": "assistant", "content": "REFERENCE_ONLY_SENTINEL"})
                elif change == "extra_message_key":
                    rows[0]["messages"][0]["reference"] = "REFERENCE_ONLY_SENTINEL"
                    manifest["cases"][0]["input_sha256"] = hashlib.sha256(dump(rows[0]["messages"]).encode()).hexdigest()
                else:
                    manifest["cases"][0]["use_for_training_or_selection"] = True
                freeze(Path(directory), rows, manifest)
                with self.assertRaises(ValueError):
                    compare.load_heldout(Path(directory))

    def test_data_and_heldout_are_mutually_exclusive_before_loading(self):
        with patch("sys.argv", ["compare.py", "--model", "unused", "--output", "unused",
                                "--data", "unused", "--heldout", "unused"]), patch("sys.stderr"):
            with self.assertRaises(SystemExit) as error:
                compare.main()
        self.assertEqual(error.exception.code, 2)

    def test_loader_imports_no_model_package_and_preserves_existing_contract_checker(self):
        original_import = builtins.__import__

        def source_only_import(name, *args, **kwargs):
            if name.split(".")[0] in {"mlx", "mlx_lm", "torch", "transformers", "tokenizers", "numpy"}:
                raise AssertionError(f"Model package import forbidden: {name}")
            return original_import(name, *args, **kwargs)

        rows, manifest = controls()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            freeze(path, rows, manifest)
            with patch("builtins.__import__", side_effect=source_only_import):
                loaded, metadata, _ = compare.load_heldout(path)
                self.assertEqual(compare.output_failures('{"answer":"2040-03-02..2040-03-03","sources":[]}',
                                                        metadata[0], "stop", loaded[0]["messages"]), [])
                self.assertTrue(compare.output_failures("{}", metadata[0], "stop", loaded[0]["messages"]))


if __name__ == "__main__":
    unittest.main()
