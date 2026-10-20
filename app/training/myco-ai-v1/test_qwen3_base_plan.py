"""Synthetic metadata-only tests; no model files, arrays or heavy imports."""

import builtins
from copy import deepcopy
import unittest
from unittest.mock import patch

from qwen3_base_plan import base_tensor_plan


def config():
    return {
        "model_type": "qwen3", "architectures": ["Qwen3ForCausalLM"],
        "num_hidden_layers": 36, "hidden_size": 4096, "intermediate_size": 12288,
        "head_dim": 128, "num_attention_heads": 32, "num_key_value_heads": 8,
        "vocab_size": 151936, "max_position_embeddings": 40960,
        "tie_word_embeddings": False, "attention_bias": False,
        "use_sliding_window": False, "sliding_window": None, "rope_scaling": None,
        "rope_theta": 1000000, "rms_norm_eps": 1e-6, "hidden_act": "silu",
        "quantization": {"group_size": 64, "bits": 4},
        "quantization_config": {"group_size": 64, "bits": 4},
    }


def descriptors(coefficient_dtype="BF16", norm_dtype="BF16"):
    # Independent source shape oracle, without importing implementation mappings.
    matrices = {"model.embed_tokens": (151936, 4096), "lm_head": (151936, 4096)}
    norms = {"model.norm": (4096,)}
    for layer in range(36):
        prefix = f"model.layers.{layer}."
        matrices.update({prefix + name: shape for name, shape in {
            "self_attn.q_proj": (4096, 4096), "self_attn.k_proj": (1024, 4096),
            "self_attn.v_proj": (1024, 4096), "self_attn.o_proj": (4096, 4096),
            "mlp.gate_proj": (12288, 4096), "mlp.up_proj": (12288, 4096),
            "mlp.down_proj": (4096, 12288),
        }.items()})
        norms.update({prefix + name: shape for name, shape in {
            "input_layernorm": (4096,), "post_attention_layernorm": (4096,),
            "self_attn.q_norm": (128,), "self_attn.k_norm": (128,),
        }.items()})
    tensors = {name + ".weight": {"shape": shape, "dtype": norm_dtype}
               for name, shape in norms.items()}
    for name, (rows, width) in matrices.items():
        tensors[name + ".weight"] = {"shape": (rows, width // 8), "dtype": "U32"}
        for suffix in ("scales", "biases"):
            tensors[f"{name}.{suffix}"] = {"shape": (rows, width // 64),
                                          "dtype": coefficient_dtype}
    return tensors


class Qwen3BasePlanTests(unittest.TestCase):
    def test_full_mapping_counts_shapes_and_untied_head(self):
        tensors = descriptors()
        plan = base_tensor_plan(config(), tensors)
        self.assertEqual(len(tensors), 907)
        self.assertEqual(len(plan), 399)
        targets = {entry.target_name: entry for entry in plan}
        expected = {"token_embd.weight", "output.weight", "output_norm.weight"}
        expected.update(f"blk.{layer}.{kind}.weight" for layer in range(36) for kind in (
            "attn_q", "attn_k", "attn_v", "attn_output", "ffn_gate", "ffn_up", "ffn_down",
            "attn_norm", "ffn_norm", "attn_q_norm", "attn_k_norm"))
        self.assertEqual(set(targets), expected)
        self.assertEqual(sum(entry.ggml_type == "Q4_1" for entry in plan), 254)
        self.assertEqual(sum(entry.ggml_type == "F32" for entry in plan), 145)
        for target, source in (("token_embd.weight", "model.embed_tokens"),
                               ("output.weight", "lm_head")):
            entry = targets[target]
            self.assertEqual(entry.source_names, tuple(source + "." + suffix
                             for suffix in ("weight", "scales", "biases")))
            self.assertEqual(entry.logical_shape, (151936, 4096))
            self.assertEqual(entry.storage_shape, (151936, 2560))
            self.assertEqual(entry.ggml_shape, (4096, 151936))
        for layer in range(36):
            for target, (source, shape) in {
                "attn_q": ("self_attn.q_proj", (4096, 4096)),
                "attn_k": ("self_attn.k_proj", (1024, 4096)),
                "attn_v": ("self_attn.v_proj", (1024, 4096)),
                "attn_output": ("self_attn.o_proj", (4096, 4096)),
                "ffn_gate": ("mlp.gate_proj", (12288, 4096)),
                "ffn_up": ("mlp.up_proj", (12288, 4096)),
                "ffn_down": ("mlp.down_proj", (4096, 12288)),
            }.items():
                entry = targets[f"blk.{layer}.{target}.weight"]
                self.assertEqual(entry.source_names, tuple(f"model.layers.{layer}.{source}.{suffix}"
                                 for suffix in ("weight", "scales", "biases")))
                self.assertEqual(entry.logical_shape, shape)
                self.assertEqual(entry.ggml_shape, shape[::-1])
                self.assertEqual(entry.storage_shape, (shape[0], shape[1] // 32 * 20))
            for target, source, shape in (
                ("attn_norm", "input_layernorm", (4096,)),
                ("ffn_norm", "post_attention_layernorm", (4096,)),
                ("attn_q_norm", "self_attn.q_norm", (128,)),
                ("attn_k_norm", "self_attn.k_norm", (128,)),
            ):
                entry = targets[f"blk.{layer}.{target}.weight"]
                self.assertEqual(entry.source_names, (f"model.layers.{layer}.{source}.weight",))
                self.assertEqual(entry.logical_shape, shape)
        consumed = [name for entry in plan for name in entry.source_names]
        self.assertEqual(len(consumed), len(set(consumed)))
        self.assertEqual(set(consumed), set(tensors))
        self.assertTrue(all(not entry.transpose and not entry.qk_permutation for entry in plan))

    def test_supported_float_metadata_never_claims_coefficient_values_verified(self):
        for dtype in ("BF16", "F16", "F32"):
            plan = base_tensor_plan(config(), descriptors(dtype, dtype))
            for entry in plan:
                quantized = entry.ggml_type == "Q4_1"
                self.assertEqual(entry.source_dtypes, ("U32", dtype, dtype) if quantized else (dtype,))
                self.assertEqual(entry.requires_exact_fp16_coefficients, quantized)
                if not quantized:
                    self.assertEqual(entry.ggml_type, "F32")
                    self.assertEqual(entry.storage_shape, entry.logical_shape)
        tensors = descriptors()
        tensors["lm_head.scales"]["dtype"] = tensors["lm_head.biases"]["dtype"] = "F32"
        self.assertEqual(base_tensor_plan(config(), tensors)[1].source_dtypes, ("U32", "F32", "F32"))
        # Raw-header offsets belong to the reader, not the architecture planner.
        tensors["lm_head.scales"]["data_offsets"] = [0, 151936 * 64 * 4]
        self.assertEqual(base_tensor_plan(config(), tensors)[1].source_dtypes, ("U32", "F32", "F32"))

    def test_missing_extra_alias_layer_and_tied_head_are_rejected(self):
        for name in ("lm_head.weight", "model.layers.0.self_attn.q_proj.scales",
                     "model.layers.35.mlp.down_proj.biases", "model.norm.weight"):
            tensors = descriptors()
            tensors.pop(name)
            with self.subTest(missing=name), self.assertRaisesRegex(ValueError, "907"):
                base_tensor_plan(config(), tensors)
        for name in ("model.layers.36.self_attn.q_proj.weight", "model.rotary_emb.inv_freq",
                     "model.layers.0.self_attn.q_proj.bias", "model.layers.0.self_attn.q_proj.lora_a",
                     "model.lm_head.weight", "__metadata__"):
            tensors = descriptors()
            tensors[name] = {"shape": (1,), "dtype": "F32"}
            with self.subTest(extra=name), self.assertRaisesRegex(ValueError, "907"):
                base_tensor_plan(config(), tensors)

    def test_wrong_shapes_and_types_fail_before_any_conversion(self):
        cases = (
            ("model.layers.0.self_attn.k_proj.weight", "shape", (4096, 128)),
            ("model.layers.0.self_attn.q_norm.weight", "shape", (4096,)),
            ("model.layers.35.mlp.down_proj.scales", "shape", (4096, 384)),
            ("lm_head.weight", "shape", (151936, 4096)),
            ("model.norm.weight", "shape", (True,)),
            ("model.norm.weight", "shape", (4096.0,)),
            ("model.norm.weight", "shape", None),
            ("lm_head.weight", "dtype", "I32"),
            ("lm_head.scales", "dtype", "F64"),
            ("lm_head.biases", "dtype", "U32"),
            ("model.norm.weight", "dtype", "F8_E4M3"),
            ("lm_head.biases", "dtype", "F16"),
        )
        for name, field, value in cases:
            tensors = descriptors()
            tensors[name][field] = value
            with self.subTest(name=name, field=field, value=value), self.assertRaises(ValueError):
                base_tensor_plan(config(), tensors)
        for replacement in (None, {"shape": [4096]}, {"shape": [4096], "dtype": "F32", "extra": 1}):
            tensors = descriptors()
            tensors["model.norm.weight"] = replacement
            with self.subTest(replacement=replacement), self.assertRaises(ValueError):
                base_tensor_plan(config(), tensors)

    def test_non_8b_or_changed_configuration_is_rejected(self):
        for changes in (
            {"hidden_size": 2560, "intermediate_size": 9728}, {"head_dim": 256},
            {"num_hidden_layers": 35}, {"num_key_value_heads": 32},
            {"vocab_size": 151935}, {"tie_word_embeddings": True},
            {"attention_bias": True}, {"rope_scaling": {"type": "linear", "factor": 2}},
            {"rope_parameters": {"rope_type": "linear", "factor": 2}},
            {"quantization": {"group_size": 128, "bits": 4}},
            {"quantization_config": {"group_size": 64, "bits": True}},
        ):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                base_tensor_plan({**config(), **changes}, descriptors())

    def test_planning_is_deterministic_read_only_and_needs_no_heavy_import(self):
        tensors = descriptors()
        before = deepcopy(tensors)
        original_import = builtins.__import__

        def guarded_import(name, *args, **kwargs):
            if name.split(".")[0] in {"mlx", "mlx_lm", "numpy", "torch", "gguf", "safetensors"}:
                raise AssertionError("Heavy import attempted by metadata-only planner")
            return original_import(name, *args, **kwargs)

        with patch("builtins.__import__", guarded_import), patch(
                "builtins.open", side_effect=AssertionError("File access attempted by planner")):
            first = base_tensor_plan(config(), tensors)
            second = base_tensor_plan(config(), dict(reversed(list(tensors.items()))))
        self.assertEqual(first, second)
        self.assertEqual(tensors, before)
        with self.assertRaises(AttributeError):
            first[0].transpose = True


if __name__ == "__main__":
    unittest.main()
