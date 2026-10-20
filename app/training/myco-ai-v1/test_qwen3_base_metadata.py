"""Synthetic mechanics only; real pinned tokenizer/native parity is not tested."""

import builtins
from hashlib import sha256
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import qwen3_base_metadata as metadata

PROBE_SHA256 = "e636dc30a262dcc0d8c323492e32ae2b70728f4df7dfe9737d9f920a282b8aea"
GGUF = SimpleNamespace(GGML_QUANT_VERSION=2, LlamaFileType=SimpleNamespace(MOSTLY_Q4_1=3))


def base_config():
    return {"model_type": "qwen3", "architectures": ["Qwen3ForCausalLM"],
            "num_hidden_layers": 36, "hidden_size": 4096, "head_dim": 128,
            "num_attention_heads": 32, "num_key_value_heads": 8, "intermediate_size": 12288,
            "vocab_size": 151936, "max_position_embeddings": 40960,
            "tie_word_embeddings": False, "attention_bias": False,
            "use_sliding_window": False, "sliding_window": None,
            "rope_scaling": None, "rope_theta": 1000000,
            "rms_norm_eps": 1e-6, "hidden_act": "silu",
            "quantization": {"group_size": 64, "bits": 4},
            "quantization_config": {"group_size": 64, "bits": 4}}


class FakeTokenizer:
    def __init__(self):
        self.vocab = {"plain": 0, "▁normal": 1, "<pad>": 2, "<|stop|>": 3,
                      "added▁text": 4, "raw": 5, "<unused42>": 6, "<｜control｜>": 7}
        self.added = {token: index for token, index in self.vocab.items() if index >= 2}
        self.added_tokens_decoder = {
            index: SimpleNamespace(normalized=index != 5, special=index == 3)
            for index in self.added.values()}
        self.calls = []

    def get_added_vocab(self):
        return self.added

    def encode(self, text, **kwargs):
        self.calls.append(("encode", text, kwargs))
        return [5] if text == "raw" else [0, 4, 3]

    def decode(self, token_ids):
        self.calls.append(("decode", token_ids))
        return "normalized▁value"


class HeaderWriter:
    arch = "qwen3"

    def __init__(self):
        self.values = {}

    def __getattr__(self, name):
        if not name.startswith("add_"):
            raise AttributeError(name)
        return lambda value: self.values.__setitem__(name[4:], value)


def special_vocab():
    return SimpleNamespace(load_merges=True, n_vocab=151936, merges=["a b", "Ġx y"],
                           special_token_ids={"bos": 2, "eos": 3, "pad": 2},
                           add_special_token={"bos": False}, normalizer_lowercase=None,
                           chat_template="invented {{ messages }}\n")


class Qwen3MetadataTests(unittest.TestCase):
    def test_fresh_module_import_has_no_array_model_or_tokenizer_packages(self):
        original = builtins.__import__

        def guarded(name, *args, **kwargs):
            if name.split(".")[0] in {"numpy", "torch", "mlx", "gguf", "transformers", "tokenizers"}:
                raise AssertionError("Heavy import at metadata helper load: " + name)
            return original(name, *args, **kwargs)

        path = Path(__file__).with_name("qwen3_base_metadata.py")
        spec = importlib.util.spec_from_file_location("qwen3_metadata_import_control", path)
        with patch("builtins.__import__", guarded):
            spec.loader.exec_module(importlib.util.module_from_spec(spec))

    def test_probe_uses_default_encode_and_official_list_serialization(self):
        tokenizer = FakeTokenizer()
        self.assertEqual(metadata.tokenizer_probe_sha256(tokenizer), sha256(b"[0, 4, 3]").hexdigest())
        self.assertEqual(tokenizer.calls, [("encode", metadata.PRETOKENIZER_PROBE, {})])

    def test_unknown_unpinned_and_invalid_probe_ids_fail_before_header_writes(self):
        for expected in (PROBE_SHA256, "0" * 64, None, [], {}):
            writer = HeaderWriter()
            with self.subTest(expected=expected), self.assertRaises(ValueError):
                metadata.write_qwen3_base_metadata(base_config(), FakeTokenizer(), writer, GGUF,
                                                   expected_probe_sha256=expected)
            self.assertEqual(writer.values, {})
        for token_ids in ([], [True], [-1], [151936], (0, 1)):
            tokenizer = FakeTokenizer()
            tokenizer.encode = lambda text, result=token_ids: result
            with self.subTest(token_ids=token_ids), self.assertRaises(ValueError):
                metadata.tokenizer_probe_sha256(tokenizer)

    def test_metadata_matches_the_dense_8b_converter_fields(self):
        writer = HeaderWriter()
        # Fake tokens cannot satisfy the real probe; patching is mechanics only.
        with patch.object(metadata, "tokenizer_probe_sha256", return_value=PROBE_SHA256):
            receipt = metadata.write_qwen3_base_metadata(
                base_config(), FakeTokenizer(), writer, GGUF, expected_probe_sha256=PROBE_SHA256)
        expected = {"type": "model", "quantization_version": 2, "block_count": 36,
                    "context_length": 40960, "embedding_length": 4096,
                    "feed_forward_length": 12288, "head_count": 32, "head_count_kv": 8,
                    "rope_freq_base": 1000000, "layer_norm_rms_eps": 1e-6,
                    "key_length": 128, "value_length": 128, "file_type": 3,
                    "tokenizer_model": "gpt2", "tokenizer_pre": "qwen2"}
        for key, value in expected.items():
            self.assertEqual(writer.values[key], value)
        self.assertEqual(set(writer.values), set(expected) | {"token_list", "token_types"})
        self.assertEqual(receipt, {"vocab_size": 151936, "pretokenizer_probe_sha256": PROBE_SHA256,
                                  "tokenizer_parity_verified": False, "native_equivalence_verified": False})

    def test_vocab_keeps_id_order_holes_normal_tokens_and_official_added_rules(self):
        tokenizer, writer = FakeTokenizer(), HeaderWriter()
        with patch.object(metadata, "tokenizer_probe_sha256", return_value=PROBE_SHA256):
            metadata.write_qwen3_base_metadata(base_config(), tokenizer, writer, GGUF,
                                               expected_probe_sha256=PROBE_SHA256)
        tokens, kinds = writer.values["token_list"], writer.values["token_types"]
        self.assertEqual(tokens[:9], ["plain", "▁normal", "<pad>", "<|stop|>", "added text",
                                     "normalized value", "<unused42>", "<｜control｜>", "[PAD8]"])
        self.assertEqual(kinds[:9], [1, 1, 3, 3, 4, 4, 3, 3, 5])
        self.assertEqual((len(tokens), len(kinds)), (151936, 151936))
        self.assertEqual((tokens[-1], kinds[-1]), ("[PAD151935]", 5))
        self.assertEqual(tokenizer.calls, [("encode", "raw", {"add_special_tokens": False}), ("decode", [5])])

    def test_invalid_profile_writer_and_vocabulary_fail_before_header_writes(self):
        invalid = []
        for replacement in (True, -1, 151936):
            tokenizer = FakeTokenizer()
            tokenizer.vocab["plain"] = replacement
            invalid.append(tokenizer)
        tokenizer = FakeTokenizer()
        tokenizer.vocab["duplicate"] = 0
        invalid.append(tokenizer)
        tokenizer = FakeTokenizer()
        tokenizer.added["raw"] = 999
        invalid.append(tokenizer)
        tokenizer = FakeTokenizer()
        tokenizer.added_tokens_decoder[5].normalized = None
        invalid.append(tokenizer)
        for tokenizer in invalid:
            writer = HeaderWriter()
            with self.subTest(vocab=tokenizer.vocab), patch.object(
                    metadata, "tokenizer_probe_sha256", return_value=PROBE_SHA256), self.assertRaises(ValueError):
                metadata.write_qwen3_base_metadata(base_config(), tokenizer, writer, GGUF,
                                                   expected_probe_sha256=PROBE_SHA256)
            self.assertEqual(writer.values, {})
        for config, writer in (({**base_config(), "hidden_size": 2560}, HeaderWriter()),
                               (base_config(), SimpleNamespace(arch="qwen2"))):
            with self.assertRaises(ValueError):
                metadata.write_qwen3_base_metadata(config, FakeTokenizer(), writer, GGUF,
                                                   expected_probe_sha256=PROBE_SHA256)

    def test_special_vocab_guard_binds_the_pinned_projection_without_reparsing_files(self):
        special = special_vocab()
        digest = sha256(special.chat_template.encode()).hexdigest()
        receipt = metadata.validate_qwen3_special_vocab(special, expected_chat_template_sha256=digest)
        self.assertEqual(receipt["special_token_ids"], {"bos": 2, "eos": 3, "pad": 2})
        self.assertEqual(receipt["add_special_token"], {"bos": False})
        self.assertEqual(receipt["merges"], 2)
        self.assertEqual(receipt["chat_template_sha256"], digest)
        self.assertFalse(receipt["tokenizer_parity_verified"])
        self.assertEqual(special.merges, ["a b", "Ġx y"])

    def test_special_vocab_rejects_missing_or_unsupported_metadata(self):
        changes = [
            {"load_merges": False}, {"n_vocab": None}, {"n_vocab": True},
            {"merges": []}, {"merges": ["three raw parts"]}, {"merges": ["a\0 b"]},
            {"special_token_ids": {"eos": True}}, {"special_token_ids": {"eos": 151936}},
            {"special_token_ids": {"bos": 2}}, {"special_token_ids": {"eos": 3, "cls": 4}},
            {"add_special_token": {"bos": 0}}, {"add_special_token": {"pad": False}},
            {"normalizer_lowercase": "false"}, {"chat_template": []}, {"chat_template": ""},
        ]
        digest = sha256(special_vocab().chat_template.encode()).hexdigest()
        for changed in changes:
            special = special_vocab()
            special.__dict__.update(changed)
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                metadata.validate_qwen3_special_vocab(special, expected_chat_template_sha256=digest)
        for expected in (None, "0" * 64, "A" * 64):
            with self.subTest(expected=expected), self.assertRaises(ValueError):
                metadata.validate_qwen3_special_vocab(special_vocab(), expected_chat_template_sha256=expected)


if __name__ == "__main__":
    unittest.main()
