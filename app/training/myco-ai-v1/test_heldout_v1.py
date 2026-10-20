"""Check final-role data isolation with stdlib only; no model execution."""

import builtins
from collections import Counter
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import heldout_v1 as subject
import multitask_v2 as shared
import prepare
import smoke_v2


class HeldoutTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rows, cls.metadata = subject.build_heldout()

    def test_fixed_twelve_role_schedule_and_two_message_only_inputs(self):
        self.assertEqual(len(self.rows), 12)
        self.assertEqual(Counter(meta["task"] for meta in self.metadata), {role: 3 for role in shared.SCHEMAS})
        for row, meta in zip(self.rows, self.metadata):
            self.assertEqual(set(row), {"messages"})
            self.assertEqual([message["role"] for message in row["messages"]], ["system", "user"])
            self.assertTrue(meta["final_evaluation_only"])
            self.assertFalse(meta["use_for_training_or_selection"])
            self.assertFalse(meta["semantic_acceptance"])
            self.assertFalse(meta["native_io_authenticated"])
            self.assertFalse(meta["expected"]["structural_pass_is_semantic_pass"])
            self.assertEqual(meta["input_sha256"], shared.sha(shared.dump(row["messages"])))

    def test_current_policies_and_native_target_shapes_are_reused(self):
        policies = shared.policies()
        for row, meta in zip(self.rows, self.metadata):
            expected = policies[meta["task"]]["ask"] if meta["task"] == "writer" else policies[meta["task"]]
            self.assertEqual(row["messages"][0]["content"], expected)
            shared.validate_target(meta["task"], json.loads(row["messages"][1]["content"]), meta["expected"]["reference"])
            self.assertEqual(meta["expected"]["schema"], shared.SCHEMAS[meta["task"]])

    def test_references_and_family_labels_cannot_change_model_inputs(self):
        cases = copy.deepcopy(subject._cases())
        for case in cases:
            case["family"] += "_UNSERVED_REFERENCE_MARKER"
            case["critical_required_facts"] = ["UNSERVED_REFERENCE_MARKER"]
            case["critical_forbidden_claims"] = ["UNSERVED_REFERENCE_MARKER"]
            case["rubric"] = ["UNSERVED_REFERENCE_MARKER"]
            role, reference = case["task"], case["reference"]
            if role == "planner":
                reference["answer"] = case["period_constraints"]["start_min"] + ".." + case["period_constraints"]["end_min"]
            elif role == "session":
                reference["title"] = "다른 허용 형식의 참조 제목"
            elif role == "writer":
                reference["answer"] = "참조만 변경한 출력입니다."
            elif reference["claims"]:
                reference["claims"][0]["action"] = "참조만 변경한 주장"
        with patch.object(subject, "_cases", return_value=cases):
            changed_rows, changed_metadata = subject.build_heldout()
        self.assertEqual(changed_rows, self.rows)
        self.assertNotEqual(changed_metadata, self.metadata)
        self.assertNotIn("UNSERVED_REFERENCE_MARKER", shared.dump(changed_rows))

    def test_original_byte_ranges_hashes_roles_times_and_complete_tail(self):
        fields = prepare.serde_fields("wiki_claims.rs", "SourceSpan")
        for row, meta in zip(self.rows, self.metadata):
            packet = json.loads(row["messages"][1]["content"])
            if meta["task"] == "planner":
                continue
            if meta["task"] == "writer":
                spans = [span for source in packet["sources"] for span in source["originalSpans"]]
            elif meta["task"] == "session":
                spans = packet["originalSpans"]
            else:
                spans = []
                for view in packet["originalSpans"]:
                    span = {"id": view["id"], "speaker": view["speaker"], "text": view["text"], **view["sourceContext"], **view["provenance"]}
                    self.assertEqual(set(span), fields)
                    spans.append(span)
            original = "\n\n".join(span["text"] for span in spans).encode()
            for span in spans:
                self.assertEqual(set(span), fields)
                self.assertEqual(original[span["start"]:span["end"]].decode(), span["text"])
                self.assertEqual(span["sha256"], shared.sha(span["text"]))
                self.assertEqual(span["sourceRevision"], hashlib.sha256(original).hexdigest())
                self.assertEqual(span["sourcePath"], span["selectionPath"])
                self.assertIsNone(span["sourcePhase"])
            self.assertEqual(spans[-1]["end"], len(original))
            if meta["task"] == "extraction":
                self.assertEqual(packet["sourceRevision"], hashlib.sha256(original).hexdigest())
            if meta["task"] == "writer":
                self.assertEqual(packet["coverage"]["suppliedOriginalSpans"], len(spans))
                self.assertEqual(packet["coverage"]["omittedSuppliedOriginalSpans"], 0)
                self.assertEqual(packet["contextRevision"], shared.sha(prepare.dump({"syntheticContext": packet["context"]})))

    def test_families_and_literal_originals_are_disjoint_from_training_and_smoke(self):
        frozen = json.loads(subject.TRAINING_MANIFEST.read_text())
        excluded = {meta["family"] for split in frozen["splits"].values() for meta in split}
        _, smoke_meta = smoke_v2.build_smoke()
        excluded.update(meta["family"] for meta in smoke_meta)
        self.assertFalse(excluded & {meta["family"] for meta in self.metadata})
        old_rows, _ = shared.build_dataset()
        smoke_rows, _ = smoke_v2.build_smoke()
        old_text = shared.dump(old_rows) + shared.dump(smoke_rows)
        for row, meta in zip(self.rows, self.metadata):
            self.assertNotIn(meta["family"], shared.dump(row))
            packet = json.loads(row["messages"][1]["content"])
            if meta["task"] == "planner":
                self.assertNotIn(row["messages"][1]["content"], old_text)
            else:
                spans = [span for source in packet["sources"] for span in source["originalSpans"]] if meta["task"] == "writer" else packet["originalSpans"]
                for span in spans:
                    self.assertNotIn(span["text"], old_text)

    def test_planner_allows_multiple_intervals_without_activity_inference(self):
        for meta in self.metadata[:3]:
            constraints = meta["period_constraints"]
            self.assertFalse(constraints["reference_is_unique"])
            self.assertFalse(meta["expected"]["reference_wording_is_unique"])
            ranges = {(constraints["start_min"], constraints["end_max"]), (constraints["start_max"], constraints["end_min"])}
            self.assertEqual(len(ranges), 2)
            for start, end in ranges:
                self.assertLessEqual(start, end)

    def test_original_three_questions_are_writer_tasks_and_rejection_is_separate(self):
        questions = [json.loads(row["messages"][1]["content"])["question"] for row, meta in zip(self.rows, self.metadata) if meta["task"] == "writer"]
        self.assertEqual(questions, ["내가 최근에 한 일들에 대해서 정리해줘.", "내가 최근 한달동안 한 일에 대해서 알려줘", "내가 앞으로 어떤 작업을 하는게 좋을까?"])
        self.assertTrue(all(meta["expected"]["reference"]["answer"].strip() for meta in self.metadata if meta["task"] == "writer"))
        negative = [meta for meta in self.metadata if meta["task"] == "extraction" and meta["expected"]["reference"]["outcome"] == "insufficient_evidence"]
        self.assertEqual(len(negative), 1)
        self.assertEqual(negative[0]["expected"]["reference"]["claims"], [])

    def test_external_freeze_keeps_references_out_of_input_file_and_never_overwrites(self):
        with tempfile.TemporaryDirectory(prefix="myco-heldout-source-only-") as parent:
            output = subject.write_heldout(Path(parent) / "frozen")
            body = (output / "inputs.jsonl").read_text()
            manifest = json.loads((output / "manifest.json").read_text())
            self.assertEqual(manifest["sha256"]["inputs.jsonl"], shared.sha(body))
            self.assertEqual(manifest["cases"], self.metadata)
            self.assertEqual((manifest["family_count"], manifest["task_count"]), (12, 12))
            self.assertEqual(manifest["comparison_training_manifest_sha256"], subject.TRAINING_MANIFEST_SHA256)
            self.assertEqual(manifest["role_counts"], {role: 3 for role in shared.SCHEMAS})
            self.assertEqual([json.loads(line) for line in body.splitlines()], self.rows)
            self.assertTrue(manifest["references_must_not_be_model_input"])
            with self.assertRaises(FileExistsError):
                subject.write_heldout(output)
            alias = Path(parent) / "checkout-alias"
            alias.symlink_to(subject.ROOT, target_is_directory=True)
            with self.assertRaises(ValueError):
                subject.write_heldout(alias / "forbidden")
        with self.assertRaises(ValueError):
            subject.write_heldout(subject.ROOT / "forbidden")

    def test_import_and_build_never_import_model_packages(self):
        original_import = builtins.__import__

        def source_only_import(name, *args, **kwargs):
            if name.split(".")[0] in {"mlx", "mlx_lm", "torch", "transformers", "tokenizers", "numpy", "huggingface_hub"}:
                raise AssertionError(f"Model package import forbidden: {name}")
            return original_import(name, *args, **kwargs)

        spec = importlib.util.spec_from_file_location("source_only_heldout", Path(subject.__file__))
        module = importlib.util.module_from_spec(spec)
        with patch("builtins.__import__", side_effect=source_only_import):
            spec.loader.exec_module(module)
            self.assertEqual(len(module.build_heldout()[0]), 12)


if __name__ == "__main__":
    unittest.main()
