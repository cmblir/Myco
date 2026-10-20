"""Synthetic frozen answer-review loader controls; no model or final case access."""

import builtins
import hashlib
import itertools
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import compare
from answer_reviewer_cases import canonical


def controls():
    text = "Synthetic original with 한글; the event date is not recorded."
    span = {"id": "Q1", "sourceId": "R1", "sourcePath": "synthetic/control.md",
            "selectionPath": "synthetic/control.md", "sourceRevision": hashlib.sha256(text.encode()).hexdigest(),
            "start": 0, "end": len(text.encode()), "sha256": hashlib.sha256(text.encode()).hexdigest(),
            "text": text, "turnId": "T1", "speaker": "user", "recordTime": "2040-03-04",
            "turnTime": None, "sourcePhase": None}
    payload = {"context": {"question": "Review the fixed answer.", "language": "en", "scope": "all",
                "activityPeriod": None, "requestedPeriod": None, "resolutionWindow": None, "previousQuestion": None},
               "contextRevision": "0" * 64, "answerInputRevision": "1" * 64,
               "answer": {"proseWithoutModelLinkLabels": "Synthetic fixed answer.", "sourceIds": ["S1"]},
               "originalSpans": [span], "citations": [{"id": "S1", "path": "synthetic/control.md"}],
               "independentVerificationReceipts": []}
    rows, rubrics = [], []
    for pair in range(2):
        for variant in ("accept", "reject"):
            messages = [{"role": "system", "content": "Synthetic policy control only."},
                        {"role": "user", "content": canonical(payload)}]
            rows.append({"messages": messages})
            rubrics.append({"id": f"synthetic-{pair}-{variant}", "pair_id": f"synthetic-{pair}",
                "family": f"synthetic-{pair}", "task": "answer_review_development",
                "expected": {"schema": "AskAnswerReviewV1"},
                "input_sha256": hashlib.sha256(canonical(messages).encode()).hexdigest(),
                "reference": {"expected_verdict": variant, "meaning": "REFERENCE_ONLY_SENTINEL",
                              "required_axes": {"answerDisposition": "supported" if variant == "accept" else "unsupported"}}})
    metadata = {"kind": "exposed_answer_review_development", "synthetic_only": True,
                "pairs": 2, "scheduled_verdicts": 4, "independent_source_families": 2,
                "source_review": "automated_source_text_review_not_human", "human_reviewed": False,
                "prior_development_outputs_known": True, "final_holdout": False,
                "context_binding_native_authorized": False, "native_draft_validator_executed": False,
                "native_review_validator_executed": False, "token_fit_verified": False,
                "semantic_acceptance": False, "app_success_verified": False, "production_adoption": False,
                "source_sha256": {"synthetic-author.py": "a" * 64}}
    return {"rows": rows, "rubrics": rubrics, "metadata": metadata}


def freeze(path, fixture):
    (path / "frozen-cases.json").write_text(canonical(fixture), encoding="utf-8")


class AnswerReviewerCompareTests(unittest.TestCase):
    def test_frozen_inputs_are_exact_and_gold_is_never_regenerated_or_appended(self):
        fixture = controls()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            freeze(path, fixture)
            with patch("answer_reviewer_cases.build_cases", side_effect=AssertionError("Never rebuild frozen cases")):
                rows, rubrics, provenance = compare.load_answer_reviewer(path)
            self.assertEqual(rows, fixture["rows"])
            self.assertEqual(rubrics, fixture["rubrics"])
            self.assertNotIn("REFERENCE_ONLY_SENTINEL", canonical(rows))
            self.assertEqual(provenance["frozen_cases_sha256"], hashlib.sha256((path / "frozen-cases.json").read_bytes()).hexdigest())
            self.assertEqual(provenance["source_sha256"], fixture["metadata"]["source_sha256"])
            for rubric in fixture["rubrics"]:
                rubric["reference"]["meaning"] = "OTHER_REFERENCE_ONLY_SENTINEL"
            freeze(path, fixture)
            self.assertEqual(compare.load_answer_reviewer(path)[0], rows)

    def test_provenance_forces_development_and_never_native_or_semantic_acceptance(self):
        fixture = controls()
        fixture["metadata"]["native_accepted"] = True
        with tempfile.TemporaryDirectory() as directory:
            freeze(Path(directory), fixture)
            provenance = compare.load_answer_reviewer(Path(directory))[2]
        self.assertEqual(provenance["kind"], "exposed_answer_review_development")
        for flag in ("final_holdout", "native_accepted", "semantic_acceptance", "production_adoption"):
            self.assertIs(provenance[flag], False)

    def test_exposure_schedule_message_binding_schema_and_wire_fail_closed(self):
        for change in ("kind", "unseen", "human", "native", "rows", "pairs", "family", "schema", "binding", "assistant", "wire"):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as directory:
                fixture = controls()
                if change == "kind": fixture["metadata"]["kind"] = "unseen_qualification"
                elif change == "unseen": fixture["metadata"]["final_holdout"] = True
                elif change == "human": fixture["metadata"]["human_reviewed"] = True
                elif change == "native": fixture["metadata"]["native_review_validator_executed"] = True
                elif change == "rows": fixture["rows"].pop()
                elif change == "pairs": fixture["rubrics"][1]["reference"]["expected_verdict"] = "accept"
                elif change == "family": fixture["rubrics"][0]["family"] = "unexpected-third-family"
                elif change == "schema": fixture["rubrics"][0]["expected"]["schema"] = "WikiClaimReviewV1"
                elif change == "binding": fixture["rows"][0]["messages"][1]["content"] += " "
                elif change == "assistant": fixture["rows"][0]["messages"].append({"role": "assistant", "content": "REFERENCE_ONLY_SENTINEL"})
                else:
                    payload = json.loads(fixture["rows"][0]["messages"][1]["content"])
                    payload["reference"] = "REFERENCE_ONLY_SENTINEL"
                    fixture["rows"][0]["messages"][1]["content"] = canonical(payload)
                    fixture["rubrics"][0]["input_sha256"] = hashlib.sha256(canonical(fixture["rows"][0]["messages"]).encode()).hexdigest()
                freeze(Path(directory), fixture)
                with self.assertRaises(ValueError):
                    compare.load_answer_reviewer(Path(directory))

    def test_all_four_modes_are_mutually_exclusive_before_model_access(self):
        for first, second in itertools.combinations(("--data", "--heldout", "--reviewer", "--answer-reviewer"), 2):
            with self.subTest(first=first, second=second), patch("sys.argv", ["compare.py", "--model", "unused",
                    "--output", "unused", first, "unused", second, "unused"]), patch("sys.stderr"):
                with self.assertRaises(SystemExit) as error:
                    compare.main()
                self.assertEqual(error.exception.code, 2)

    def test_dispatch_checks_shape_without_grading_meaning_or_acceptance(self):
        fixture = controls()
        messages, rubric = fixture["rows"][0]["messages"], fixture["rubrics"][0]
        verdict = {"version": "AskAnswerReviewV1", "answerDisposition": "supported", "taskResponse": "adequate",
                   "sourceCoverage": "covered", "missingSpanIds": [], "reason": "Synthetic shape check only."}
        self.assertEqual(compare.output_failures(canonical(verdict), rubric, "stop", messages), [])
        verdict["answerDisposition"] = "unsupported"
        self.assertEqual(compare.output_failures(canonical(verdict), rubric, "stop", messages), [])
        verdict.update(sourceCoverage="missing", missingSpanIds=[])
        self.assertEqual(compare.output_failures(canonical(verdict), rubric, "stop", messages), [])
        self.assertIn("incomplete_generation", compare.output_failures(canonical(verdict), rubric, "length", messages))
        verdict["missingSpanIds"] = ["S1"]
        self.assertTrue(compare.output_failures(canonical(verdict), rubric, "stop", messages))

    def test_source_only_loader_and_dispatch_never_import_model_packages(self):
        original_import = builtins.__import__

        def guarded(name, *args, **kwargs):
            if name.split(".")[0] in {"mlx", "mlx_lm", "torch", "transformers", "tokenizers", "numpy", "gguf"}:
                raise AssertionError("Forbidden model package import: " + name)
            return original_import(name, *args, **kwargs)

        with tempfile.TemporaryDirectory() as directory:
            freeze(Path(directory), controls())
            with patch("builtins.__import__", side_effect=guarded):
                rows, rubrics, _ = compare.load_answer_reviewer(Path(directory))
                self.assertTrue(compare.output_failures("{}", rubrics[0], "stop", rows[0]["messages"]))


if __name__ == "__main__":
    unittest.main()
