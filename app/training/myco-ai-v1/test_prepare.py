"""Semantic and filesystem boundaries for the source-only synthetic pilot."""
import importlib.util
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("myco_prepare", Path(__file__).with_name("prepare.py"))
prepare = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(prepare)


class PrepareTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.records, cls.metadata = prepare.build_dataset()

    def test_writer_wire_and_original_evidence_ids(self):
        for split, examples in self.records.items():
            for example, meta in zip(examples, self.metadata[split]):
                self.assertEqual(set(example), {"messages"})
                system, user, assistant = example["messages"]
                self.assertEqual([item["role"] for item in (system, user, assistant)], ["system", "user", "assistant"])
                payload, answer = json.loads(user["content"]), json.loads(assistant["content"])
                self.assertEqual(set(answer), {"answer", "sources"})
                self.assertEqual(answer["sources"], meta["expected"]["sources"])
                self.assertTrue(set(answer["sources"]) <= set(payload["allowed_source_ids"]))
                self.assertEqual(payload["allowed_source_ids"], [f"S{i}" for i in range(1, len(payload["sources"]) + 1)])
                self.assertNotRegex(answer["answer"], r"\bS\d+\b|\[\[|```")
                self.assertTrue(all(source["path"].startswith("sessions/invented-") for source in payload["sources"]))
                for source in payload["sources"]:
                    self.assertEqual(set(source), {"id", "path", "title", "originalSpans"})
                    self.assertNotIn("passage", source)
                    span = source["originalSpans"][0]
                    self.assertEqual(set(span), {"id", "sourceId", "sourcePath", "selectionPath", "sourceRevision", "start", "end", "sha256", "text", "turnId", "speaker", "recordTime", "turnTime", "sourcePhase"})
                    self.assertEqual(set(span), prepare.serde_fields("wiki_claims.rs", "SourceSpan"))
                    self.assertEqual((span["start"], span["end"]), (0, len(span["text"].encode("utf-8"))))
                    self.assertEqual(span["sha256"], hashlib.sha256(span["text"].encode("utf-8")).hexdigest())
                    self.assertEqual(span["sourceRevision"], span["sha256"])
                if meta["task"] != "ask":
                    self.assertEqual(payload["activityPeriod"], {**prepare.PERIOD, "startEpoch": None, "endEpoch": None})
                    self.assertNotIn("output_reminder", payload)
                    self.assertIn("recordPeriodContext", payload)
                    span_ids = {span["id"] for item in payload["sources"] for span in item["originalSpans"]}
                    for claim in payload["claimProposals"]:
                        self.assertEqual(set(claim), {"action", "anchorSpanId", "supportSpanIds", "actor", "eventTime", "speechAct", "status", "verificationId"})
                        self.assertEqual(set(claim), prepare.serde_fields("wiki_claims/schema.rs", "ClaimProposal"))
                        self.assertIn(claim["anchorSpanId"], span_ids)
                        self.assertTrue(set(claim["supportSpanIds"]) <= span_ids)
                        self.assertIsNone(claim["eventTime"]["value"])
                    self.assertEqual(payload["currentStateIndependentlyVerified"], False)
                else:
                    self.assertIn("contextRevision", payload)
                    self.assertEqual(payload["context"]["question"], payload["question"])
                    self.assertIn("complete supplied original spans", system["content"])

    def test_production_activity_policy_and_advice_suffix(self):
        for split, examples in self.records.items():
            for example, meta in zip(examples, self.metadata[split]):
                if meta["task"] == "ask":
                    continue
                system = example["messages"][0]["content"]
                self.assertTrue(system.startswith("Answer the user's question directly in Korean."))
                self.assertIn("recordPeriodContext is native record-selection metadata", system)
                self.assertEqual(" Give a conditional next action" in system, meta["task"] == "advice")

    def test_activity_proposals_include_distractors_and_nonwork_without_gold_selection(self):
        for split, examples in self.records.items():
            for example, meta in zip(examples, self.metadata[split]):
                if meta["task"] != "ask":
                    payload = json.loads(example["messages"][1]["content"])
                    self.assertEqual([claim["anchorSpanId"] for claim in payload["claimProposals"]], [span["id"] for source in payload["sources"] for span in source["originalSpans"]])

    def test_changing_gold_answer_citations_or_abstention_cannot_change_model_input(self):
        policies, reminder = prepare.contract()
        passages = [prepare.source("가상 잎맥기차의 종이표 교체가 보고됐다.", "Assistant"), prepare.source("가상 솔방울역의 물컵은 청색이다.")]
        for task in ("ask", "activity", "advice"):
            outputs = [prepare.writer_messages("same-case", task, "관련 기록을 알려줘.", passages, answer, ids, policies, reminder) for answer, ids in (("교체가 보고됐습니다.", ["S1"]), ("물컵은 청색입니다.", ["S2"]), ("", []))]
            self.assertEqual(outputs[0][:2], outputs[1][:2])
            self.assertEqual(outputs[0][:2], outputs[2][:2])
            self.assertNotEqual(outputs[0][2], outputs[1][2])
            if task != "ask":
                self.assertEqual(len(json.loads(outputs[2][1]["content"])["claimProposals"]), 2)

    def test_holdout_scenario_families_and_examples_are_separate(self):
        self.assertEqual({split: len(rows) for split, rows in self.records.items()}, {"train": 64, "valid": 8, "test": 8})
        families = {split: {row["family"] for row in rows} for split, rows in self.metadata.items()}
        for left, right in (("train", "valid"), ("train", "test"), ("valid", "test")):
            self.assertFalse(families[left] & families[right])
            self.assertFalse({prepare.dump(row) for row in self.records[left]} & {prepare.dump(row) for row in self.records[right]})
        self.assertIn("conditional_dependency_advice", families["test"])
        self.assertIn("ordered_rollback_events", families["valid"])
        self.assertNotIn("conditional_dependency_advice", families["train"])

    def test_critical_heldout_semantics(self):
        cases = {meta["family"]: (json.loads(record["messages"][1]["content"]), json.loads(record["messages"][2]["content"])) for record, meta in zip(self.records["test"], self.metadata["test"])}
        _, filtered = cases["topic_filter_across_projects"]
        self.assertEqual(filtered["sources"], ["S1"])
        self.assertNotIn("노을정원", filtered["answer"])
        _, request = cases["partial_request_fulfilment"]
        self.assertIn("통로 표식의 결과는 기록되지", request["answer"])
        self.assertNotIn("미완료", request["answer"])
        _, advice = cases["conditional_dependency_advice"]
        for term in ("규격이 확정됐다면", "봉투 예제 한 건", "선행 조건"):
            self.assertIn(term, advice["answer"])
        _, quantities = cases["mixed_units_without_invented_totals"]
        self.assertIn("4.2–6.1초", quantities["answer"])
        self.assertIn("31개 중 27개", quantities["answer"])
        _, injection = cases["forged_id_in_distractor"]
        self.assertEqual(injection["sources"], ["S2"])
        self.assertIn("강철은 사용하지", injection["answer"])

    def test_abstentions_have_no_prose_or_citations(self):
        for split, examples in self.records.items():
            empty = [record for record, meta in zip(examples, self.metadata[split]) if meta["expected"]["empty"]]
            self.assertTrue(empty)
            for record in empty:
                self.assertEqual(record["messages"][2]["content"], '{"answer":"","sources":[]}')
            for meta in self.metadata[split]:
                if meta["expected"]["empty"]:
                    self.assertIn("reject", meta["native_disposition"])
                    self.assertFalse(meta["app_success_verified"])

    def test_validator_rejects_unsupported_citation(self):
        records = json.loads(json.dumps(self.records))
        records["test"][0]["messages"][2]["content"] = prepare.dump({"answer": "합성 주장입니다.", "sources": ["S9"]})
        with self.assertRaisesRegex(ValueError, "references"):
            prepare.validate_dataset(records, self.metadata)

    def test_output_is_external_new_directory_and_manifest_is_separate(self):
        with tempfile.TemporaryDirectory(prefix="myco-source-only-") as parent:
            destination = Path(parent) / "dataset"
            prepare.write_dataset(destination)
            manifest = json.loads((destination / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["splits"], self.metadata)
            before = (destination / "train.jsonl").read_bytes()
            with self.assertRaises(FileExistsError):
                prepare.write_dataset(destination)
            self.assertEqual((destination / "train.jsonl").read_bytes(), before)
            for split in ("train", "valid", "test"):
                lines = (destination / f"{split}.jsonl").read_text(encoding="utf-8").splitlines()
                self.assertTrue(all(set(json.loads(line)) == {"messages"} for line in lines))
            alias = Path(parent) / "checkout-alias"
            alias.symlink_to(prepare.REPO_ROOT, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "outside"):
                prepare.write_dataset(alias / "forbidden-dataset")
            broken = Path(parent) / "broken-alias"
            broken.symlink_to(Path(parent) / "missing")
            with self.assertRaises(FileExistsError):
                prepare.write_dataset(broken)
        for destination in (prepare.REPO_ROOT, prepare.REPO_ROOT / "app/training/forbidden-dataset"):
            with self.assertRaisesRegex(ValueError, "outside"):
                prepare.write_dataset(destination)


if __name__ == "__main__":
    unittest.main()
