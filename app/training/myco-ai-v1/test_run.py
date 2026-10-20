"""Check evaluation failures, masking, and the real MLX trainer padding boundary."""

import unittest

from run import grade, response_loss, tokenize


class Template:
    eos_token = "<eos>"

    def apply_chat_template(self, messages, **kwargs):
        if kwargs["enable_thinking"]:
            raise AssertionError("Thinking must stay disabled")
        return [1, 2] if kwargs.get("add_generation_prompt") else [1, 2, 3, 4]

    def decode(self, tokens, **kwargs):
        return 'target<eos>\n'


def training_row():
    return {"messages": [{"role": "system", "content": "policy"},
                         {"role": "user", "content": "invented source"},
                         {"role": "assistant", "content": "target"}]}


class PhiTemplate(Template):
    eos_token = "<|endoftext|>"
    suffix = [200020, 199999]
    completion = "target<|end|><|endoftext|>"

    def convert_tokens_to_ids(self, token):
        return {"<|end|>": 200020, "<|endoftext|>": 199999}.get(token)

    def apply_chat_template(self, messages, **kwargs):
        if kwargs["enable_thinking"]:
            raise AssertionError("Thinking must stay disabled")
        return [1, 2] if kwargs.get("add_generation_prompt") else [1, 2, 3] + self.suffix

    def decode(self, tokens, **kwargs):
        return self.completion


class Gemma4Template(Template):
    bos_token = "<bos>"
    eos_token = "<eos>"
    sot_token = "<|turn>"
    eot_token = "<turn|>"
    completion = "target<turn|>\n"

    def decode(self, tokens, **kwargs):
        return self.completion


class RunnerTest(unittest.TestCase):
    def test_real_trainer_excludes_padding_without_losing_final_response_token(self):
        import mlx.core as mx
        import mlx.nn as nn
        from mlx_lm.tuner.trainer import default_loss, iterate_batches
        previous_device = mx.default_device()
        mx.set_default_device(mx.cpu)
        try:
            batch, lengths = next(iterate_batches([([7, 8, 9, 10], 2)], 1, 64))
            scores = mx.zeros((1, batch.shape[1] - 1, 16))
            scores[0, 1, 9] = 2
            scores[0, 2, 10] = 3
            scores[0, 3, 1] = 8
            model = lambda inputs: scores
            legacy, legacy_tokens = default_loss(model, batch, lengths)
            corrected, corrected_tokens = response_loss(model, batch, lengths)
            expected = nn.losses.cross_entropy(scores[:, 1:3], mx.array([[9, 10]])).mean()
            self.assertEqual(legacy_tokens.item(), 3)
            self.assertEqual(corrected_tokens.item(), 2)
            self.assertAlmostEqual(corrected.item(), expected.item(), places=5)
            self.assertGreater(legacy.item(), corrected.item())
        finally:
            mx.set_default_device(previous_device)

    def test_masks_entire_prompt_and_preserves_complete_target(self):
        self.assertEqual(tokenize([training_row()], Template(), 4),
                         [([1, 2, 3, 4], 2)])

    def test_gemma4_requires_exact_inspected_turn_closure_and_preserves_mask(self):
        self.assertEqual(tokenize([training_row()], Gemma4Template(), 4),
                         [([1, 2, 3, 4], 2)])

    def test_gemma4_rejects_eos_reasoning_trim_and_extra_suffix_changes(self):
        for completion in ("target<eos>", "target<eos>\n", "target<turn|>",
                           "target<turn|>\nextra", "target<turn|>\n\n",
                           " target<turn|>\n", "target <turn|>\n",
                           "<|channel>thought\nreason<channel|>target<turn|>\n",
                           "<think>reason</think>target<turn|>\n"):
            tokenizer = Gemma4Template()
            tokenizer.completion = completion
            with self.subTest(completion=completion), self.assertRaisesRegex(ValueError, "supervised completion"):
                tokenize([training_row()], tokenizer, 4)

    def test_gemma4_turn_suffix_is_not_enabled_for_incomplete_marker_metadata(self):
        for key in ("bos_token", "sot_token", "eot_token"):
            tokenizer = Gemma4Template()
            setattr(tokenizer, key, None)
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "supervised completion"):
                tokenize([training_row()], tokenizer, 4)

    def test_phi_requires_both_inspected_terminators_without_mask_changes(self):
        self.assertEqual(tokenize([training_row()], PhiTemplate(), 5),
                         [([1, 2, 3, 200020, 199999], 2)])

    def test_phi_single_eos_is_not_the_inspected_assistant_completion(self):
        tokenizer = PhiTemplate()
        tokenizer.suffix = [199999]
        tokenizer.completion = "target<|endoftext|>"
        with self.assertRaisesRegex(ValueError, "supervised completion"):
            tokenize([training_row()], tokenizer, 5)

    def test_phi_rejects_changed_ids_reasoning_and_any_extra_suffix(self):
        for completion in ("<think>reasoning</think>target<|end|><|endoftext|>",
                           "target<|end|><|endoftext|>extra", "target<|end|><|endoftext|>\n",
                           "target <|end|><|endoftext|>"):
            tokenizer = PhiTemplate()
            tokenizer.completion = completion
            with self.subTest(completion=completion), self.assertRaisesRegex(ValueError, "supervised completion"):
                tokenize([training_row()], tokenizer, 5)
        tokenizer = PhiTemplate()
        tokenizer.suffix = [200021, 199999]
        with self.assertRaisesRegex(ValueError, "supervised completion"):
            tokenize([training_row()], tokenizer, 5)
        tokenizer = PhiTemplate()
        tokenizer.convert_tokens_to_ids = lambda token: 199998
        with self.assertRaisesRegex(ValueError, "supervised completion"):
            tokenize([training_row()], tokenizer, 5)

    def test_rejects_template_injected_reasoning_and_post_target_content(self):
        class Injected(Template):
            def decode(self, tokens, **kwargs):
                return self.injected
        tokenizer = Injected()
        for content in ('<think>\n\n</think>\n\ntarget<eos>\n', 'target<eos>extra'):
            tokenizer.injected = content
            with self.subTest(content=content), self.assertRaisesRegex(ValueError, "supervised completion"):
                tokenize([training_row()], tokenizer, 4)

    def test_refuses_overflow_instead_of_cutting_source_or_answer(self):
        with self.assertRaisesRegex(ValueError, "no truncation"):
            tokenize([training_row()], Template(), 3)

    def test_refuses_misaligned_mask(self):
        class Drifted(Template):
            def apply_chat_template(self, messages, **kwargs):
                return [9] if kwargs.get("add_generation_prompt") else [1, 2]
        with self.assertRaisesRegex(ValueError, "prefix mismatch"):
            tokenize([training_row()], Drifted(), 4)

    def test_invalid_json_or_truncation_cannot_pass(self):
        expected = {"sources": [], "empty": True}
        self.assertIn("invalid_json", grade("```json\n{}", expected, "stop"))
        self.assertIn("incomplete_generation", grade('{"answer":"","sources":[]}', expected, "length"))

    def test_citation_order_is_irrelevant_but_unknown_or_duplicate_ids_fail(self):
        expected = {"sources": ["S1", "S2"], "empty": False}
        self.assertEqual(grade('{"answer":"합성 결과","sources":["S2","S1"]}', expected, "stop"), [])
        for sources in ('["S1","S1"]', '["S1","S9"]', '[1]'):
            self.assertIn("source_ids", grade('{"answer":"합성 결과","sources":' + sources + '}', expected, "stop"))

    def test_records_assertion_failures_without_substituting_reference_answer(self):
        expected = {"sources": ["S1"], "empty": False, "must_include": ["42"], "must_exclude": ["완료"]}
        failures = grade('{"answer":"전체 완료","sources":["S1"]}', expected, "stop")
        self.assertEqual(failures, ["missing:42", "forbidden:완료"])


if __name__ == "__main__":
    unittest.main()
