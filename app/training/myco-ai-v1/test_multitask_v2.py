"""Stdlib-only contract and label-independence checks; no model imports."""
import json
from collections import Counter
from pathlib import Path
import tempfile
import unittest

import multitask_v2 as subject


class MultitaskTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.records, cls.metadata = subject.build_dataset()

    def test_expanded_counts_and_independent_families_preserve_the_reviewed_prefix(self):
        expected = {"train": {"planner": 16, "extraction": 36, "session": 16, "writer": 55}, "valid": {"planner": 4, "extraction": 5, "session": 4, "writer": 9}}
        for split in ("train", "valid"):
            self.assertEqual(Counter(meta["task"] for meta in self.metadata[split]), expected[split])
            self.assertEqual([meta["task"] for meta in self.metadata[split][:4]], ["planner", "extraction", "session", "writer"])
            self.assertEqual({meta["task"] for meta in self.metadata[split]}, {"planner", "extraction", "session", "writer"})
        self.assertFalse({meta["family"] for meta in self.metadata["train"]} & {meta["family"] for meta in self.metadata["valid"]})
        self.assertNotIn("test", self.records)
        identifiers = [meta["id"] for rows in self.metadata.values() for meta in rows]
        self.assertEqual(len(identifiers), len(set(identifiers)))

    def test_gold_changes_never_change_system_or_user_input(self):
        for split, rows in self.records.items():
            for row, meta in zip(rows, self.metadata[split]):
                packet = json.loads(row["messages"][1]["content"])
                altered, _ = subject.make_record(meta["id"], meta["task"], meta["family"], packet, {"deliberately_different_gold": []}, row["messages"][0]["content"], [])
                self.assertEqual(altered["messages"][:2], row["messages"][:2])
                self.assertNotEqual(altered["messages"][2], row["messages"][2])

    def test_scenario_family_labels_are_manifest_only(self):
        for split, rows in self.records.items():
            for row, meta in zip(rows, self.metadata[split]):
                self.assertNotIn(meta["family"], row["messages"][1]["content"])

    def test_extraction_packet_revision_binds_one_complete_session(self):
        for split, rows in self.records.items():
            for row, meta in zip(rows, self.metadata[split]):
                if meta["task"] != "extraction":
                    continue
                packet = json.loads(row["messages"][1]["content"])
                spans = packet["originalSpans"]
                revision = subject.sha("\n\n".join(span["text"] for span in spans))
                self.assertEqual(packet["sourceRevision"], revision)
                self.assertEqual({span["provenance"]["sourceRevision"] for span in spans}, {revision})
                self.assertEqual(len({span["provenance"]["sourcePath"] for span in spans}), 1)

    def test_extraction_uses_production_reading_view_and_preserves_negation(self):
        row = self.records["train"][1]
        packet = json.loads(row["messages"][1]["content"])
        self.assertEqual(set(packet), {"task", "language", "sessionKey", "originalSpans", "sourceRevision", "derivedSource", "allowedSpanIds", "independentVerificationReceipts"})
        for span in packet["originalSpans"]:
            self.assertEqual(set(span), {"id", "speaker", "text", "sourceContext", "provenance"})
            self.assertEqual(span["provenance"]["end"] - span["provenance"]["start"], len(span["text"].encode("utf-8")))
            self.assertEqual(span["provenance"]["sha256"], subject.sha(span["text"]))
        claims = json.loads(row["messages"][2]["content"])["claims"]
        self.assertEqual([claim["status"] for claim in claims], ["requested", "requested", "reported_completed", "unknown"])
        self.assertTrue(any("변경하지 않음" in claim["action"] for claim in claims))
        self.assertEqual(json.loads(self.records["valid"][1]["messages"][2]["content"]), {"outcome": "insufficient_evidence", "claims": []})

    def test_session_has_no_generated_summary_and_writer_has_no_empty_gold(self):
        for split, rows in self.records.items():
            for row, meta in zip(rows, self.metadata[split]):
                target = json.loads(row["messages"][2]["content"])
                if meta["task"] == "session":
                    self.assertEqual(set(target), {"version", "title", "titleClaimIds", "entities"})
                    self.assertNotIn("summaries", target)
                if meta["task"] == "writer":
                    self.assertTrue(target["answer"].strip())
                    self.assertTrue(target["sources"])

    def test_role_specific_rejections(self):
        with self.assertRaises(ValueError):
            subject.validate_target("planner", {"today": "2034-01-01"}, {"answer": "2034-01-01..2034-01-02", "sources": []})
        with self.assertRaises(ValueError):
            subject.validate_target("extraction", {"allowedSpanIds": []}, {"outcome": "claims", "claims": []})
        with self.assertRaises(ValueError):
            subject.validate_target("writer", {"allowed_source_ids": ["S1"]}, {"answer": "", "sources": []})
        with self.assertRaises(ValueError):
            subject.validate_target("session", {"allowedClaimIds": ["C1"]}, {"version": "SessionStructureV1", "title": "합성 제목", "titleClaimIds": ["C9"], "entities": []})

    def test_extraction_actor_and_status_are_not_promoted(self):
        row = self.records["train"][1]
        packet = json.loads(row["messages"][1]["content"])
        target = json.loads(row["messages"][2]["content"])
        target["claims"][0]["status"] = "reported_completed"
        with self.assertRaisesRegex(ValueError, "coupling"):
            subject.validate_target("extraction", packet, target)
        target = json.loads(row["messages"][2]["content"])
        target["claims"][2]["actor"]["role"] = "user"
        with self.assertRaisesRegex(ValueError, "actor"):
            subject.validate_target("extraction", packet, target)

    def test_observed_failure_types_have_distinct_source_grounded_targets(self):
        extraction = {meta["family"]: json.loads(row["messages"][2]["content"])["claims"] for row, meta in zip(self.records["train"], self.metadata["train"]) if meta["task"] == "extraction"}
        manager = extraction["reported_completion_actor_not_named"]
        self.assertEqual(manager[0]["actor"]["role"], "unknown")
        self.assertEqual(manager[0]["status"], "reported_completed")
        self.assertEqual(extraction["assistant_plan_is_not_user_performance"][0]["actor"]["role"], "assistant")
        self.assertEqual(extraction["assistant_plan_is_not_user_performance"][0]["status"], "planned")
        self.assertTrue(all(claim["eventTime"]["value"] is None for claim in extraction["record_timestamp_not_action_timestamp"]))
        self.assertEqual(extraction["explicit_old_action_new_record"][0]["eventTime"]["value"], "2033-10-14")
        self.assertEqual(extraction["speaker_differs_from_user_actor"][0]["actor"], {"role": "user", "basis": "explicit_subject", "subjectSpanId": "Q1"})

    def test_distinct_results_and_remaining_work_have_atomic_claims(self):
        extraction = {meta["family"]: json.loads(row["messages"][2]["content"])["claims"] for row, meta in zip(self.records["train"], self.metadata["train"]) if meta["task"] == "extraction"}
        repair = extraction["repair_and_remaining_check"]
        self.assertEqual(len(repair), 3)
        self.assertEqual([claim["status"] for claim in repair], ["reported_completed", "reported_completed", "unknown"])
        self.assertTrue(any("19개" in claim["action"] for claim in repair))
        counts = extraction["range_and_count_distinct_units"]
        self.assertEqual(len(counts), 3)
        self.assertEqual([claim["status"] for claim in counts[1:]], ["reported_completed", "unknown"])

    def test_writer_references_can_select_one_of_multiple_admitted_originals(self):
        selected_second = []
        for row, meta in zip(self.records["train"], self.metadata["train"]):
            if meta["task"] == "writer":
                packet, target = (json.loads(message["content"]) for message in row["messages"][1:])
                if target["sources"] == ["S2"]:
                    selected_second.append(meta["family"])
                    self.assertEqual(packet["allowed_source_ids"], ["S1", "S2"])
                    self.assertEqual(len(packet["sources"]), 2)
        self.assertIn("range_and_count_distinct_units", selected_second)

    def test_insufficient_evidence_is_extraction_output_never_writer_empty(self):
        for split, rows in self.records.items():
            negative_families = []
            for row, meta in zip(rows, self.metadata[split]):
                target = json.loads(row["messages"][2]["content"])
                if meta["task"] == "extraction" and not target["claims"]:
                    self.assertEqual(target, {"outcome": "insufficient_evidence", "claims": []})
                    negative_families.append(meta["family"])
            self.assertEqual(len(negative_families), 8 if split == "train" else 1)

    def test_external_new_output_manifest_and_no_test_holdout(self):
        with tempfile.TemporaryDirectory(prefix="myco-v2-source-only-") as parent:
            output = subject.write_dataset(Path(parent) / "samples")
            manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
            self.assertTrue(manifest["synthetic_only"])
            self.assertEqual(manifest["splits"], self.metadata)
            self.assertEqual(set(manifest["sha256"]), {"train.jsonl", "valid.jsonl"})
            self.assertFalse((output / "test.jsonl").exists())
            for filename, expected in manifest["sha256"].items():
                self.assertEqual(subject.sha((output / filename).read_text(encoding="utf-8")), expected)
            with self.assertRaises(FileExistsError):
                subject.write_dataset(output)
            alias = Path(parent) / "checkout"
            alias.symlink_to(subject.ROOT, target_is_directory=True)
            with self.assertRaises(ValueError):
                subject.write_dataset(alias / "forbidden")
        with self.assertRaises(ValueError):
            subject.write_dataset(subject.ROOT / "forbidden")


if __name__ == "__main__":
    unittest.main()
