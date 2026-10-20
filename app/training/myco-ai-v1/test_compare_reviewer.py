"""Synthetic loader/dispatch controls only; no final cases, model or tokenizer."""

import builtins
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import compare
from reviewer_cases import canonical


def controls():
    text = "Synthetic original with 한글 and an unchanged qualification."
    span = {"id": "Q1", "sourceId": "R1", "sourcePath": "synthetic/control.md",
            "selectionPath": "synthetic/control.md", "sourceRevision": hashlib.sha256(text.encode()).hexdigest(),
            "start": 0, "end": len(text.encode()), "sha256": hashlib.sha256(text.encode()).hexdigest(),
            "text": text, "turnId": "T1", "speaker": "unknown", "recordTime": "2040-03-04",
            "turnTime": None, "sourcePhase": None}
    payload = {"context": {"question": "Review the synthetic claim.", "language": "en", "scope": "all",
                "activityPeriod": None, "requestedPeriod": None, "resolutionWindow": None, "previousQuestion": None},
               "contextRevision": "0" * 64, "coverageRequiredSpanIds": ["Q1"], "referenceSpanIds": [],
               "originalSpans": [span], "requiredClaimIds": ["C0"],
               "claims": [{"id": "C0", "proposal": {"action": "Synthetic source claim."}}],
               "independentVerificationReceipts": []}
    rows, rubrics = [], []
    for pair in range(4):
        for variant in ("accept", "reject"):
            messages = [{"role": "system", "content": "Synthetic control policy, never a model fixture."},
                        {"role": "user", "content": canonical(payload)}]
            rows.append({"messages": messages})
            rubrics.append({"id": f"control-{pair}-{variant}", "pair_id": f"control-{pair}",
                            "family": f"synthetic-family-{pair % 3}", "task": "claim_review_development",
                            "expected": {"schema": "WikiClaimReviewV1"},
                            "input_sha256": hashlib.sha256(canonical(messages).encode()).hexdigest(),
                            "reference": {"expectedVerdict": variant, "expectedDecisions": [{"id": "C0",
                                "disposition": "supported" if variant == "accept" else "unsupported"}],
                                "sourceCoverage": "covered", "missingSpanIds": [],
                                "rationale": "REFERENCE_ONLY_SENTINEL"}})
    metadata = {"purpose": "exposed_development_diagnostic", "synthetic_only": True,
                "pairs": 4, "scheduled_verdicts": 8, "independent_source_families": 3,
                "source_review": "automated_source_text_review_not_human", "human_reviewed": False,
                "final_holdout": False, "prior_development_outputs_known": True,
                "claim_review_only": True, "answer_review_gate_verified": False,
                "native_validator_executed": False, "native_token_fit_verified": False,
                "app_success_verified": False, "production_adoption": False,
                "source_sha256": {"synthetic-author.py": "a" * 64}}
    return {"rows": rows, "rubrics": rubrics, "metadata": metadata}


def freeze(path, fixture):
    (path / "frozen-cases.json").write_text(canonical(fixture), encoding="utf-8")


class ReviewerCompareTests(unittest.TestCase):
    def test_reads_frozen_rows_exactly_and_keeps_references_separate(self):
        fixture = controls()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            freeze(path, fixture)
            with patch("reviewer_cases.build_cases", side_effect=AssertionError("Never regenerate frozen inputs")):
                rows, rubrics, provenance = compare.load_reviewer(path)
            self.assertEqual(rows, fixture["rows"])
            self.assertEqual(rubrics, fixture["rubrics"])
            self.assertNotIn("REFERENCE_ONLY_SENTINEL", canonical(rows))
            self.assertEqual(provenance["frozen_cases_sha256"], hashlib.sha256((path / "frozen-cases.json").read_bytes()).hexdigest())
            self.assertEqual(provenance["source_sha256"], fixture["metadata"]["source_sha256"])
            for rubric in fixture["rubrics"]:
                rubric["reference"]["rationale"] = "DIFFERENT_REFERENCE_ONLY_SENTINEL"
            freeze(path, fixture)
            self.assertEqual(compare.load_reviewer(path)[0], rows)

    def test_loaded_provenance_cannot_claim_unseen_or_native_acceptance(self):
        fixture = controls()
        fixture["metadata"].update(kind="unseen_qualification", native_accepted=True, semantic_acceptance=True)
        with tempfile.TemporaryDirectory() as directory:
            freeze(Path(directory), fixture)
            provenance = compare.load_reviewer(Path(directory))[2]
        self.assertEqual(provenance["kind"], "exposed_claim_review_development")
        for flag in ("final_holdout", "native_accepted", "semantic_acceptance", "production_adoption"):
            self.assertIs(provenance[flag], False)

    def test_exposure_binding_schedule_wire_and_message_leakage_fail_closed(self):
        for change in ("unseen", "human", "native", "rows", "pairs", "family", "schema", "binding", "assistant", "wire"):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as directory:
                fixture = controls()
                if change == "unseen": fixture["metadata"]["final_holdout"] = True
                elif change == "human": fixture["metadata"]["human_reviewed"] = True
                elif change == "native": fixture["metadata"]["native_validator_executed"] = True
                elif change == "rows": fixture["rows"].pop()
                elif change == "pairs": fixture["rubrics"][1]["reference"]["expectedVerdict"] = "accept"
                elif change == "family": fixture["rubrics"][0]["family"] = "fourth-family"
                elif change == "schema": fixture["rubrics"][0]["expected"]["schema"] = "AskAnswerReviewV1"
                elif change == "binding": fixture["rows"][0]["messages"][1]["content"] += " "
                elif change == "assistant": fixture["rows"][0]["messages"].append({"role": "assistant", "content": "REFERENCE_ONLY_SENTINEL"})
                else:
                    payload = json.loads(fixture["rows"][0]["messages"][1]["content"])
                    payload["reference"] = "REFERENCE_ONLY_SENTINEL"
                    fixture["rows"][0]["messages"][1]["content"] = canonical(payload)
                    fixture["rubrics"][0]["input_sha256"] = hashlib.sha256(canonical(fixture["rows"][0]["messages"]).encode()).hexdigest()
                freeze(Path(directory), fixture)
                with self.assertRaises(ValueError):
                    compare.load_reviewer(Path(directory))

    def test_all_three_case_modes_are_mutually_exclusive_before_loading(self):
        for first, second in (("--data", "--heldout"), ("--data", "--reviewer"), ("--heldout", "--reviewer")):
            with self.subTest(first=first, second=second), patch("sys.argv", ["compare.py", "--model", "unused",
                    "--output", "unused", first, "unused", second, "unused"]), patch("sys.stderr"):
                with self.assertRaises(SystemExit) as error:
                    compare.main()
                self.assertEqual(error.exception.code, 2)

    def test_dispatch_checks_claim_schema_without_asserting_reference_correctness(self):
        fixture = controls()
        messages, rubric = fixture["rows"][0]["messages"], fixture["rubrics"][0]
        verdict = {"version": "WikiClaimReviewV1", "claims": [{"id": "C0", "disposition": "supported",
                    "reason": "Synthetic shape check only."}], "sourceCoverage": "covered", "missingSpanIds": []}
        self.assertEqual(compare.output_failures(canonical(verdict), rubric, "stop", messages), [])
        verdict["claims"][0]["disposition"] = "unsupported"
        self.assertEqual(compare.output_failures(canonical(verdict), rubric, "stop", messages), [])
        verdict.update(sourceCoverage="missing", missingSpanIds=[])
        self.assertEqual(compare.output_failures(canonical(verdict), rubric, "stop", messages), [])
        self.assertIn("incomplete_generation", compare.output_failures(canonical(verdict), rubric, "length", messages))
        verdict["missingSpanIds"] = ["S1"]
        self.assertTrue(compare.output_failures(canonical(verdict), rubric, "stop", messages))

    def test_loader_and_dispatch_import_no_model_packages(self):
        original_import = builtins.__import__

        def source_only_import(name, *args, **kwargs):
            if name.split(".")[0] in {"mlx", "mlx_lm", "torch", "transformers", "tokenizers", "numpy", "gguf"}:
                raise AssertionError(f"Forbidden model package import: {name}")
            return original_import(name, *args, **kwargs)

        with tempfile.TemporaryDirectory() as directory:
            freeze(Path(directory), controls())
            with patch("builtins.__import__", side_effect=source_only_import):
                rows, rubrics, _ = compare.load_reviewer(Path(directory))
                self.assertTrue(compare.output_failures("{}", rubrics[0], "stop", rows[0]["messages"]))


if __name__ == "__main__":
    unittest.main()
