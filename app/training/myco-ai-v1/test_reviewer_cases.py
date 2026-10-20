"""Source-only checks for exposed paired review fixtures, never model acceptance."""

import copy
import json
import tempfile
from pathlib import Path
import unittest

from reviewer_cases import (EVAL, EXPECTED, STEM, build_cases, checked_json,
                            validate_verdict, verify_case)


class ReviewerCaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = build_cases()
        cls.artifact = checked_json(EVAL / (STEM + ".json"))
        cls.corpus = checked_json(EVAL / "local-wiki-development-meaning-v1.json")

    def test_four_pairs_eight_verdicts_are_exposed_automated_development_only(self):
        fixture = self.fixture
        self.assertEqual(len(fixture["rows"]), 8)
        self.assertEqual({row["pair_id"] for row in fixture["rubrics"]}, set(EXPECTED))
        self.assertEqual(sum(row["reference"]["expectedVerdict"] == "accept"
                             for row in fixture["rubrics"]), 4)
        metadata = fixture["metadata"]
        self.assertEqual(metadata["independent_source_families"], 3)
        self.assertEqual(len({row["family"] for row in fixture["rubrics"]}), 3)
        self.assertTrue(all(row["expected"] == {"schema": "WikiClaimReviewV1"} for row in fixture["rubrics"]))
        self.assertEqual(metadata["source_review"], "automated_source_text_review_not_human")
        for flag in ("final_holdout", "human_reviewed", "native_validator_executed",
                     "answer_review_gate_verified", "app_success_verified", "production_adoption"):
            self.assertIs(metadata[flag], False)

    def test_no_gold_labels_or_reference_rationales_enter_runtime_messages(self):
        for row in self.fixture["rows"]:
            self.assertEqual([message["role"] for message in row["messages"]], ["system", "user"])
            payload = json.loads(row["messages"][1]["content"])
            for forbidden in ('"reference":', '"expectedVerdict":', '"rationale":', "source_supported", "comparison"):
                self.assertNotIn(forbidden, row["messages"][1]["content"])
            self.assertEqual(payload["coverageRequiredSpanIds"], [span["id"] for span in payload["originalSpans"]])
            self.assertEqual(payload["requiredClaimIds"], [claim["id"] for claim in payload["claims"]])

    def test_all_frozen_reference_fields_fit_the_actual_review_shape(self):
        for row, rubric in zip(self.fixture["rows"], self.fixture["rubrics"]):
            payload = json.loads(row["messages"][1]["content"])
            reference = rubric["reference"]
            verdict = {"version": "WikiClaimReviewV1", "claims": [
                {"id": item["id"], "disposition": item["disposition"], "reason": "Synthetic shape check only."}
                for item in reference["expectedDecisions"]], "sourceCoverage": reference["sourceCoverage"],
                "missingSpanIds": reference["missingSpanIds"]}
            validate_verdict(verdict, payload)
            if rubric["id"].endswith("rollout-invention-comparison"):
                self.assertEqual(verdict["claims"][-1]["disposition"], "unsupported")
                self.assertEqual(verdict["sourceCoverage"], "covered")
            elif rubric["id"].endswith("comparison"):
                self.assertTrue(all(item["disposition"] == "supported" for item in verdict["claims"]))
                self.assertEqual(verdict["sourceCoverage"], "missing")

    def test_changed_original_preview_proposal_context_or_reference_is_rejected(self):
        case = self.artifact["cases"][0]
        packet = self.artifact["packets"][0]
        original = next(item for item in self.corpus["cases"] if item["id"] == case["sourceCaseId"])
        for mutation in ("original", "preview", "proposal", "context", "scope", "reference"):
            changed_case, changed_original = copy.deepcopy(case), copy.deepcopy(original)
            if mutation == "original":
                changed_original["source"]["original"] += " changed"
            elif mutation == "preview":
                changed_case["userPreview"]["originalSpans"][0]["speaker"] = "user"
            elif mutation == "proposal":
                changed_case["proposalBatch"]["claims"][0]["status"] = "requested"
            elif mutation == "context":
                changed_case["request"]["question"] = "Changed question"
            elif mutation == "scope":
                changed_case["request"]["scope"] = "notes"
            else:
                changed_case["reference"]["sourceCoverage"] = "missing"
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                verify_case(changed_case, packet, changed_original)

    def test_unbound_missing_source_and_incomplete_decisions_do_not_pass_shape(self):
        payload = json.loads(self.fixture["rows"][0]["messages"][1]["content"])
        base = {"version": "WikiClaimReviewV1", "claims": [{"id": claim, "disposition": "supported",
                 "reason": "Synthetic shape check only."} for claim in payload["requiredClaimIds"]],
                "sourceCoverage": "covered", "missingSpanIds": []}
        for mutation in ("missing_decision", "duplicate", "citation_as_span", "long_reason", "control", "extra", "bad_id_type"):
            value = copy.deepcopy(base)
            if mutation == "missing_decision": value["claims"].pop()
            elif mutation == "duplicate": value["claims"][1] = value["claims"][0]
            elif mutation == "citation_as_span": value.update(sourceCoverage="missing", missingSpanIds=["S1"])
            elif mutation == "long_reason": value["claims"][0]["reason"] = "x" * 129
            elif mutation == "control": value["claims"][0]["reason"] = "Incomplete\nreason"
            elif mutation == "bad_id_type": value["claims"][0]["id"] = ["C0"]
            else: value["nativeApproval"] = True
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                validate_verdict(value, payload)

    def test_pinned_source_changes_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / (STEM + ".json")
            path.write_text("{}")
            with self.assertRaisesRegex(ValueError, "changed"):
                checked_json(path)

    def test_native_missing_coverage_allows_empty_ids_but_does_not_mean_acceptance(self):
        payload = json.loads(self.fixture["rows"][0]["messages"][1]["content"])
        verdict = {"version": "WikiClaimReviewV1", "claims": [{"id": claim, "disposition": "supported",
                   "reason": "Synthetic shape check only."} for claim in payload["requiredClaimIds"]],
                   "sourceCoverage": "missing", "missingSpanIds": []}
        validate_verdict(verdict, payload)


if __name__ == "__main__":
    unittest.main()
