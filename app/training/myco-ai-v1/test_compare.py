"""Protect development evaluation inputs and experiment artifact boundaries."""

from pathlib import Path
import json
import tempfile
import unittest

from compare import REPO, encode_prompt, fresh_output, model_fingerprint, output_failures
import compare


class CompareTests(unittest.TestCase):
    def test_adapter_identity_binds_exact_consumed_files(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            with self.assertRaisesRegex(ValueError, "adapter"):
                compare.adapter_fingerprint(path)
            (path / "adapter_config.json").write_text('{"rank":8}')
            (path / "adapters.safetensors").write_bytes(b"synthetic adapter bytes")
            measured = compare.adapter_fingerprint(path)
            self.assertEqual(set(measured), {"adapter_config.json", "adapters.safetensors"})
            (path / "0000032_adapters.safetensors").write_bytes(b"unconsumed checkpoint")
            self.assertEqual(compare.adapter_fingerprint(path), measured)
            (path / "adapters.safetensors").write_bytes(b"different synthetic adapter")
            self.assertNotEqual(compare.adapter_fingerprint(path), measured)
            (path / "adapters.safetensors").write_bytes(b"")
            with self.assertRaisesRegex(ValueError, "adapter"):
                compare.adapter_fingerprint(path)

    def test_fingerprints_weight_and_tokenizer_bytes_without_models(self):
        import hashlib
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            with self.assertRaisesRegex(ValueError, "no safetensors"):
                model_fingerprint(path)
            (path / "model.safetensors").write_bytes(b"invented test bytes, not a model")
            (path / "tokenizer.json").write_bytes(b"{}")
            measured = model_fingerprint(path)
            self.assertEqual(measured["tokenizer.json"], {"bytes": 2, "sha256": hashlib.sha256(b"{}").hexdigest()})
            self.assertEqual(measured["model.safetensors"]["bytes"], 32)

    def test_generation_stop_configuration_is_part_of_model_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / "model.safetensors").write_bytes(b"synthetic model bytes")
            settings = path / "generation_config.json"
            settings.write_text('{"eos_token_id":[11,12]}')
            original = model_fingerprint(path)
            self.assertIn("generation_config.json", original)
            settings.write_text('{"eos_token_id":[11,13]}')
            self.assertNotEqual(model_fingerprint(path), original)

    def test_planner_output_contract_is_distinct_from_writer_abstention(self):
        rubric = {"task": "planner", "expected": {"schema": "RecallPeriodV1"}}
        messages = [{"role": "system", "content": "policy"},
                    {"role": "user", "content": json.dumps({"today": "2034-06-18"})}]
        self.assertEqual(output_failures('{"answer":"2034-04-01..2034-04-16","sources":[]}', rubric, "stop", messages), [])
        self.assertTrue(output_failures('{"answer":"2034-06-19..2034-06-20","sources":[]}', rubric, "stop", messages))
        self.assertTrue(output_failures('{"answer":"2034-04-01..2034-04-16","sources":[]}', rubric, "length", messages))

    def test_duplicate_output_keys_are_rejected_without_last_value_repair(self):
        examples = [
            ("writer", "AskAnswerV1", {"allowed_source_ids": ["S1"]},
             '{"answer":"Synthetic first answer","answer":"Synthetic replacement","sources":["S1"]}'),
            ("session", "SessionStructureV1", {"allowedClaimIds": ["C1"]},
             '{"version":"SessionStructureV1","title":"Synthetic project","titleClaimIds":["C1"],'
             '"entities":[{"kind":"project","name":"Synthetic project","claimIds":["C1"],"kind":"topic"}]}'),
        ]
        for task, schema, packet, output in examples:
            rubric = {"task": task, "expected": {"schema": schema}}
            messages = [{"role": "system", "content": "policy"},
                        {"role": "user", "content": json.dumps(packet)}]
            with self.subTest(task=task):
                failures = output_failures(output, rubric, "stop", messages)
                self.assertTrue(any("duplicate JSON key" in failure for failure in failures), failures)

    def test_answer_messages_cannot_enter_model_input(self):
        for roles in (("system", "user", "assistant"), ("user",), ("user", "system")):
            with self.assertRaisesRegex(ValueError, "only system and user"):
                encode_prompt([{"role": role, "content": "invented"} for role in roles], None, 4096, 768)

    def test_preserves_whole_prompt_and_reserves_output(self):
        class Tokenizer:
            def apply_chat_template(self, messages, **kwargs):
                self.messages = messages
                self.kwargs = kwargs
                return [1, 2, 3]
        tokenizer = Tokenizer()
        messages = [{"role": "system", "content": "policy"}, {"role": "user", "content": "complete original"}]
        self.assertEqual(encode_prompt(messages, tokenizer, 7, 4), [1, 2, 3])
        self.assertEqual(tokenizer.messages, messages)
        self.assertEqual(tokenizer.kwargs, {"add_generation_prompt": True, "enable_thinking": False, "return_dict": False})
        with self.assertRaisesRegex(ValueError, "no truncation"):
            encode_prompt(messages, tokenizer, 6, 4)

    def test_prevents_overwriting_old_runs_or_writing_in_checkout(self):
        with self.assertRaisesRegex(ValueError, "outside the repository"):
            fresh_output(REPO / "training-output")
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "run"
            self.assertEqual(fresh_output(output), output.resolve())
            with self.assertRaises(FileExistsError):
                fresh_output(output)


if __name__ == "__main__":
    unittest.main()
