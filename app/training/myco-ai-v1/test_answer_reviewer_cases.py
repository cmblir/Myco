"""Source and schema controls only, never model or semantic acceptance tests."""

import builtins
import copy
import json
import unittest
from unittest.mock import patch

import answer_reviewer_cases as cases


class AnswerReviewerCaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = cases.build_cases()

    def test_two_correct_two_critical_wrong_answers_stay_exposed_development(self):
        fixture = self.fixture
        self.assertEqual(len(fixture["rows"]), 4)
        self.assertTrue(all(rubric["synthetic_only"] is True for rubric in fixture["rubrics"]))
        self.assertEqual({rubric["family"] for rubric in fixture["rubrics"]}, {"F01", "F02"})
        expected = {"F01-P01": "accept", "F01-P02": "reject", "F02-P01": "reject", "F02-P02": "accept"}
        self.assertEqual({rubric["id"]: rubric["reference"]["expected_verdict"] for rubric in fixture["rubrics"]}, expected)
        self.assertEqual(sum(rubric["reference"]["critical"] for rubric in fixture["rubrics"]), 2)
        for flag in ("human_reviewed", "final_holdout", "context_binding_native_authorized",
                     "native_draft_validator_executed", "native_review_validator_executed",
                     "token_fit_verified", "semantic_acceptance", "app_success_verified", "production_adoption"):
            self.assertIs(fixture["metadata"][flag], False)

    def test_gold_mutation_does_not_change_any_model_input(self):
        changed = copy.deepcopy(cases.REFERENCES)
        for reference in changed.values():
            reference.update(expected_verdict="REFERENCE_ONLY_SENTINEL", meaning="OTHER_GOLD_SENTINEL")
        with patch.object(cases, "REFERENCES", changed):
            self.assertEqual(cases.build_cases()["rows"], self.fixture["rows"])
        for row in self.fixture["rows"]:
            self.assertEqual([message["role"] for message in row["messages"]], ["system", "user"])
            for forbidden in ('"reference":', '"required_axes":', '"expected_verdict":', "REFERENCE_ONLY_SENTINEL"):
                self.assertNotIn(forbidden, row["messages"][1]["content"])

    def test_exact_deduplicated_answer_and_citation_revision_fields(self):
        for row, rubric in zip(self.fixture["rows"], self.fixture["rubrics"], strict=True):
            payload = json.loads(row["messages"][1]["content"])
            self.assertEqual(set(payload), {"context", "contextRevision", "answer", "answerInputRevision",
                                            "originalSpans", "citations", "independentVerificationReceipts"})
            self.assertEqual(set(payload["answer"]), {"proseWithoutModelLinkLabels", "sourceIds"})
            self.assertEqual(payload["answerInputRevision"], cases.digest(rubric["raw_draft"].encode()))
            self.assertEqual(payload["answer"]["sourceIds"], ["S1", "S2"])
            self.assertEqual(len(payload["originalSpans"]), 3)
            self.assertTrue(all(len(span) == 14 for span in payload["originalSpans"]))
            self.assertIsNone(payload["context"]["activityPeriod"])
            self.assertIsNotNone(payload["context"]["requestedPeriod"])
            self.assertNotIn("recordPeriodContext", payload)

    def test_complete_original_turn_hash_speaker_and_membership_fail_closed(self):
        runtime = json.loads(cases.RUNTIME.read_bytes())
        family = next(family for family in runtime["families"] if family["familyId"] == "F01")
        for mutation in ("raw", "span_text", "speaker", "membership"):
            changed = copy.deepcopy(family)
            if mutation == "raw": changed["documents"][0]["raw"] += " changed"
            elif mutation == "span_text": changed["originalSpans"][0]["text"] = "changed"
            elif mutation == "speaker": changed["originalSpans"][0]["speaker"] = "assistant"
            else: changed["originalSpans"].pop()
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                cases.verify_family(changed)

    def test_existing_wrong_drafts_preserve_the_actual_counterevidence(self):
        by_id = {rubric["id"]: row for row, rubric in zip(self.fixture["rows"], self.fixture["rubrics"], strict=True)}
        shipping = json.loads(by_id["F01-P02"]["messages"][1]["content"])
        date = json.loads(by_id["F02-P01"]["messages"][1]["content"])
        self.assertIn("발송과 발주를 마쳤다", shipping["answer"]["proseWithoutModelLinkLabels"])
        self.assertTrue(any("발송한 것은 아니며" in span["text"] for span in shipping["originalSpans"]))
        self.assertIn("사건 날짜는 3월 14일", date["answer"]["proseWithoutModelLinkLabels"])
        self.assertTrue(any("그 일을 한 날짜는 메모에 적지 않았다" in span["text"] for span in date["originalSpans"]))

    def test_unbound_citations_or_wrong_draft_shape_never_enter_review_inputs(self):
        runtime = json.loads(cases.RUNTIME.read_bytes())
        family = next(family for family in runtime["families"] if family["familyId"] == "F01")
        for answer in ({"answer": "Synthetic prose", "sources": ["S99"]},
                       {"answer": "Synthetic prose", "sources": []},
                       {"answer": True, "sources": ["S1"]},
                       {"answer": "Synthetic prose", "sources": ["S1"], "nativeApproved": True}):
            with self.subTest(answer=answer), self.assertRaises(ValueError):
                cases.model_payload(family, {"rawDraft": json.dumps(answer)})

    def test_shape_checks_are_separate_from_reference_meaning_and_native_acceptance(self):
        payload = json.loads(self.fixture["rows"][0]["messages"][1]["content"])
        base = {"version": "AskAnswerReviewV1", "answerDisposition": "supported", "taskResponse": "adequate",
                "sourceCoverage": "covered", "missingSpanIds": [], "reason": "Synthetic shape check only."}
        cases.validate_verdict(base, payload)
        wrong_meaning = {**base, "answerDisposition": "unsupported"}
        cases.validate_verdict(wrong_meaning, payload)
        cases.validate_verdict({**base, "sourceCoverage": "missing"}, payload)
        for changes in ({"version": "WikiClaimReviewV1"}, {"taskResponse": "supported"},
                        {"sourceCoverage": "missing", "missingSpanIds": ["S1"]},
                        {"missingSpanIds": [payload["originalSpans"][0]["id"]]},
                        {"reason": "x" * 129}, {"reason": "Broken\nreason"}, {"nativeApproved": True}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                cases.validate_verdict({**base, **changes}, payload)

    def test_source_builder_imports_no_model_or_tokenizer_package(self):
        original_import = builtins.__import__

        def guarded(name, *args, **kwargs):
            if name.split(".")[0] in {"mlx", "mlx_lm", "torch", "transformers", "tokenizers", "numpy", "gguf"}:
                raise AssertionError("Forbidden model package import: " + name)
            return original_import(name, *args, **kwargs)

        with patch("builtins.__import__", side_effect=guarded):
            self.assertEqual(len(cases.build_cases()["rows"]), 4)


if __name__ == "__main__":
    unittest.main()
