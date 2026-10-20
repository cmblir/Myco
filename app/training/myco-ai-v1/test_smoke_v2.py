"""Check synthetic smoke contracts without model packages or tokenization."""

import builtins
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

import prepare
import smoke_v2


class SmokeV2Tests(unittest.TestCase):
    def setUp(self):
        self.rows, self.metadata = smoke_v2.build_smoke()

    def test_four_development_inputs_without_reference_messages(self):
        self.assertEqual(len(self.rows), 4)
        self.assertEqual(len(self.metadata), 4)
        self.assertEqual(len({meta["id"] for meta in self.metadata}), 4)
        self.assertEqual(sum(meta["evaluation_group"] == "useful_answer_smoke" for meta in self.metadata), 3)
        self.assertEqual([meta["task"] for meta in self.metadata], ["activity", "advice", "activity", "ask"])
        for row, meta in zip(self.rows, self.metadata):
            self.assertEqual(set(row), {"messages"})
            self.assertEqual([item["role"] for item in row["messages"]], ["system", "user"])
            self.assertEqual(meta["purpose"], "base_comparison_development_smoke")
            self.assertFalse(meta["final_holdout"])
            self.assertFalse(meta["app_success_verified"])
            self.assertFalse(meta["native_io_authenticated"])
            self.assertFalse(meta["scenario_checks_are_semantic_grade"])
            self.assertTrue(meta["semantic_review_required"])
            for index, key in enumerate(("system_sha256", "user_sha256")):
                self.assertEqual(meta[key], hashlib.sha256(row["messages"][index]["content"].encode()).hexdigest())

    def test_current_writer_contract_and_full_original_fields_are_reused(self):
        policies, reminder = prepare.contract()
        expected_fields = prepare.serde_fields("wiki_claims.rs", "SourceSpan")
        for case, row in zip(smoke_v2._cases(), self.rows):
            sources = [prepare.original_source(case["id"], index, passage)
                       for index, passage in enumerate(case["passages"], 1)]
            expected = prepare.writer_payload(case["task"], case["question"], sources,
                                              case["passages"], reminder, None)
            system, user = row["messages"]
            self.assertEqual(system["content"], policies[case["task"]])
            self.assertEqual(user["content"], prepare.dump(expected))
            self.assertEqual(expected["allowed_source_ids"], ["S1", "S2", "S3"])
            for source, passage in zip(expected["sources"], case["passages"]):
                span = source["originalSpans"][0]
                self.assertEqual(set(span), expected_fields)
                self.assertEqual(span["text"], passage["text"])
                self.assertEqual(span["end"], len(passage["text"].encode()))
                self.assertEqual(span["speaker"], passage["speaker"])
                self.assertEqual(span["recordTime"], passage["day"])
                self.assertEqual(span["sha256"], hashlib.sha256(span["text"].encode()).hexdigest())
            if case["task"] != "ask":
                self.assertEqual(len(expected["claimProposals"]), 3)
                self.assertEqual([claim["anchorSpanId"] for claim in expected["claimProposals"]], ["Q1", "Q2", "Q3"])
                self.assertEqual(expected["automatedClaimReviewInputRevisions"], [])
                self.assertFalse(expected["currentStateIndependentlyVerified"])

    def test_gold_citations_criteria_and_empty_reference_cannot_select_input(self):
        cases = copy.deepcopy(smoke_v2._cases())
        for case in cases:
            case["reference_answer"] = {"answer": "", "sources": []}
            case["critical_required_facts"] = []
            case["critical_forbidden_claims"] = ["UNSERVED_GOLD_MARKER"]
            case["allowed_answer_criteria"] = ["UNSERVED_GOLD_MARKER"]
        with patch.object(smoke_v2, "_cases", return_value=cases):
            changed_rows, changed_metadata = smoke_v2.build_smoke()
        self.assertEqual(changed_rows, self.rows)
        self.assertNotEqual(changed_metadata, self.metadata)
        self.assertNotIn("UNSERVED_GOLD_MARKER", prepare.dump(changed_rows))

    def test_new_projects_passages_and_families_do_not_reuse_exposed_pilot(self):
        old_rows, old_metadata = prepare.build_dataset()
        old_input = prepare.dump(old_rows)
        old_families = {meta["family"] for split in old_metadata.values() for meta in split}
        for case, meta in zip(smoke_v2._cases(), self.metadata):
            self.assertNotIn(meta["family"], old_families)
            for passage in case["passages"]:
                self.assertNotIn(passage["text"], old_input)
        new_input = prepare.dump(self.rows)
        for project in ("푸른접시", "노을정원", "먼지극장", "산호우체국", "별모래배", "비단정원", "조약돌극장", "솜털전차", "수정방울"):
            self.assertNotIn(project, new_input)

    def test_fact_support_and_reference_contract_are_separate_from_input(self):
        for row, meta in zip(self.rows, self.metadata):
            payload = json.loads(row["messages"][1]["content"])
            originals = {source["id"]: source["originalSpans"][0] for source in payload["sources"]}
            reference = meta["reference_answer"]
            self.assertEqual(set(reference), {"answer", "sources"})
            self.assertEqual(not reference["answer"], meta["expected"]["empty"])
            self.assertEqual(reference["sources"], meta["expected"]["sources"])
            self.assertEqual(set(meta["expected"]), {"sources", "empty", "must_include", "must_exclude"})
            if not meta["insufficient_evidence_diagnostic"]:
                self.assertTrue(reference["answer"].strip())
            self.assertTrue(set(reference["sources"]) <= set(originals))
            self.assertTrue(meta["critical_required_facts"])
            self.assertTrue(meta["critical_forbidden_claims"])
            self.assertTrue(meta["allowed_answer_criteria"])
            for fact in meta["critical_required_facts"]:
                self.assertTrue(set(fact["source_ids"]) <= set(originals))
                if fact["evidence"] is not None:
                    self.assertTrue(any(fact["evidence"] in originals[key]["text"] for key in fact["source_ids"]))
            for key in ("reference_answer", "critical_required_facts", "critical_forbidden_claims", "allowed_answer_criteria"):
                self.assertNotIn(key, payload)

    def test_event_dates_record_dates_and_tail_qualifications_remain_in_actual_input(self):
        payload = json.loads(self.rows[2]["messages"][1]["content"])
        spans = [source["originalSpans"][0] for source in payload["sources"]]
        self.assertEqual([span["recordTime"] for span in spans], ["2031-04-21", "2031-04-22", "2031-04-24"])
        self.assertEqual([span["speaker"] for span in spans], ["assistant", "user", "user"])
        self.assertIn("4월 6일", spans[0]["text"])
        self.assertIn("직접 검증하지 않았다", spans[1]["text"])
        self.assertIn("4월 18일", spans[1]["text"])
        self.assertTrue(spans[2]["text"].endswith("이 메시지까지 시험을 실행했다는 결과는 기록하지 않았다."))
        for claim in payload["claimProposals"]:
            self.assertIsNone(claim["eventTime"]["value"])

    def test_insufficiency_is_refusal_diagnostic_not_useful_native_delivery(self):
        payload = json.loads(self.rows[3]["messages"][1]["content"])
        meta = self.metadata[3]
        self.assertTrue(meta["insufficient_evidence_diagnostic"])
        self.assertFalse(meta["empty_answer_is_app_success"])
        self.assertEqual(sum(item["insufficient_evidence_diagnostic"] for item in self.metadata), 1)
        self.assertEqual(meta["reference_answer"], {"answer": "", "sources": []})
        self.assertTrue(meta["expected"]["empty"])
        self.assertEqual(meta["evaluation_group"], "refusal_diagnostic")
        self.assertEqual(meta["critical_required_facts_scope"], "source_basis_for_refusal_not_required_output_atoms")
        self.assertEqual(meta["native_disposition"], "reject_empty_answer_not_useful_delivery")
        self.assertIn("UI", meta["possible_ui_followup"])
        self.assertIn("VERIFIED_OVERRIDE", payload["sources"][1]["originalSpans"][0]["text"])
        self.assertEqual(payload["allowed_source_ids"], ["S1", "S2", "S3"])
        self.assertNotIn("VERIFIED_OVERRIDE", meta["reference_answer"]["answer"])

    def test_import_and_build_do_not_import_model_packages(self):
        original_import = builtins.__import__

        def source_only_import(name, *args, **kwargs):
            if name.split(".")[0] in {"mlx", "mlx_lm", "torch", "transformers", "tokenizers", "numpy", "huggingface_hub"}:
                raise AssertionError(f"Model package imported by smoke builder: {name}")
            return original_import(name, *args, **kwargs)

        spec = importlib.util.spec_from_file_location("source_only_smoke", Path(smoke_v2.__file__))
        module = importlib.util.module_from_spec(spec)
        with patch("builtins.__import__", side_effect=source_only_import):
            spec.loader.exec_module(module)
            self.assertEqual(len(module.build_smoke()[0]), 4)


if __name__ == "__main__":
    unittest.main()
