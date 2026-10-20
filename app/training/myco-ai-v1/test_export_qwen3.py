"""Verify synthetic Qwen3 exports; CPU GGUF round-trips require MYCO_GGUF_PY."""

import builtins
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from export import REPO
from export_qwen3 import (adapter_metadata, base_profile, convert_matrices, main,
                          output_directory, tensor_plan, validate_training_result,
                          validate_values, verify_digest, write_adapter)


def base_config():
    return {"model_type": "qwen3", "architectures": ["Qwen3ForCausalLM"],
            "num_hidden_layers": 36, "hidden_size": 2560, "head_dim": 128,
            "num_attention_heads": 32, "num_key_value_heads": 8, "intermediate_size": 9728}


def adapter_config():
    return {"fine_tune_type": "lora", "num_layers": 4,
            "lora_parameters": {"rank": 8, "scale": 16.0, "dropout": 0.0}}


def shapes():
    widths = {"self_attn.q_proj": (2560, 4096), "self_attn.k_proj": (2560, 1024),
              "self_attn.v_proj": (2560, 1024), "self_attn.o_proj": (4096, 2560),
              "mlp.gate_proj": (2560, 9728), "mlp.up_proj": (2560, 9728),
              "mlp.down_proj": (9728, 2560)}
    return {f"model.layers.{layer}.{name}.lora_{side}": shape
            for layer in range(32, 36) for name, (width, height) in widths.items()
            for side, shape in (("a", (width, 8)), ("b", (8, height)))}


def base_config_8b():
    return {**base_config(), "hidden_size": 4096, "intermediate_size": 12288,
            "vocab_size": 151936, "max_position_embeddings": 40960,
            "tie_word_embeddings": False, "attention_bias": False,
            "use_sliding_window": False, "sliding_window": None,
            "rope_scaling": None, "rope_theta": 1000000,
            "rms_norm_eps": 1e-6, "hidden_act": "silu",
            "quantization": {"group_size": 64, "bits": 4},
            "quantization_config": {"group_size": 64, "bits": 4}}


def shapes_8b():
    widths = {"self_attn.q_proj": (4096, 4096), "self_attn.k_proj": (4096, 1024),
              "self_attn.v_proj": (4096, 1024), "self_attn.o_proj": (4096, 4096),
              "mlp.gate_proj": (4096, 12288), "mlp.up_proj": (4096, 12288),
              "mlp.down_proj": (12288, 4096)}
    return {f"model.layers.{layer}.{name}.lora_{side}": shape
            for layer in range(32, 36) for name, (width, height) in widths.items()
            for side, shape in (("a", (width, 8)), ("b", (8, height)))}


class Qwen3ExportTests(unittest.TestCase):
    def test_metadata_and_scale(self):
        metadata = adapter_metadata(base_config(), adapter_config())
        self.assertEqual(metadata, {"general.architecture": "qwen3", "general.type": "adapter",
                                   "adapter.type": "lora", "adapter.lora.alpha": 128.0})
        self.assertEqual(metadata["adapter.lora.alpha"] / 8, 16.0)

    def test_exact_8b_profile_and_parameter_count(self):
        self.assertEqual(base_profile(base_config()), "4b")
        self.assertEqual(base_profile(base_config_8b()), "8b")
        self.assertEqual(adapter_metadata(base_config_8b(), adapter_config()),
                         adapter_metadata(base_config(), adapter_config()))
        for profile, matrices, parameters in (("4b", shapes(), 1835008), ("8b", shapes_8b(), 2424832)):
            plan = tensor_plan(matrices, profile)
            self.assertEqual(len(plan), 56)
            self.assertEqual(sum(width * height for width, height in matrices.values()), parameters)
            result = {"finite": True, "adapter_tensors": 56, "changed_tensors": 56,
                      "trainable_parameters": parameters}
            validate_training_result(result, profile)
            for key, value in (("trainable_parameters", 2424832 if profile == "4b" else 1835008),
                               ("trainable_parameters", True), ("adapter_tensors", 55),
                               ("changed_tensors", 55), ("finite", 1)):
                with self.subTest(profile=profile, field=key), self.assertRaises(ValueError):
                    validate_training_result({**result, key: value}, profile)

    def test_rejects_mixed_8b_dimensions_quantization_and_tensor_counts(self):
        for changes in ({"hidden_size": 2560}, {"intermediate_size": 9728},
                        {"hidden_size": [4096]}, {"vocab_size": 151935},
                        {"tie_word_embeddings": True}, {"attention_bias": 0},
                        {"rope_theta": 10000}, {"rms_norm_eps": float("nan")},
                        {"quantization": {"group_size": 64, "bits": 8}},
                        {"quantization_config": {"group_size": True, "bits": 4}}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                adapter_metadata({**base_config_8b(), **changes}, adapter_config())
        for profile, matrices in (("4b", shapes_8b()), ("8b", shapes())):
            with self.subTest(profile=profile), self.assertRaises(ValueError):
                tensor_plan(matrices, profile)
        for failure in ("missing", "extra", "mixed"):
            matrices = shapes_8b()
            name = "model.layers.32.self_attn.q_proj.lora_a"
            if failure == "missing":
                matrices.pop(name)
            elif failure == "extra":
                matrices["unknown"] = (8, 8)
            else:
                matrices[name] = shapes()[name]
            with self.subTest(failure=failure), self.assertRaises(ValueError):
                tensor_plan(matrices, "8b")

    def test_refuses_other_architectures_dimensions_and_recipes(self):
        for changes in ({"model_type": "qwen3_5"}, {"num_hidden_layers": 32},
                        {"hidden_size": 4096}, {"head_dim": True}, {"num_attention_heads": 16}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                adapter_metadata({**base_config(), **changes}, adapter_config())
        for changes in ({"num_layers": 1}, {"extra": True}, {"lora_parameters":
                        {"rank": True, "scale": 16, "dropout": 0}}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                adapter_metadata(base_config(), {**adapter_config(), **changes})

    def test_maps_all_layers_and_standard_query_without_joint_gate(self):
        plan = tensor_plan(shapes())
        targets = {target: shape for _, target, shape in plan}
        self.assertEqual(len(targets), 56)
        self.assertEqual(targets["blk.32.attn_q.weight.lora_b"], (4096, 8))
        self.assertEqual(targets["blk.35.ffn_down.weight.lora_a"], (8, 9728))
        self.assertEqual(set(targets), {f"blk.{layer}.{name}.weight.lora_{side}"
                         for layer in range(32, 36) for name in ("attn_q", "attn_k", "attn_v",
                         "attn_output", "ffn_gate", "ffn_up", "ffn_down") for side in ("a", "b")})

    def test_rejects_missing_unknown_wrong_layer_rank_and_query_width(self):
        for suffix, replacement in (("self_attn.q_proj.lora_b", (8, 8192)),
                                    ("self_attn.k_proj.lora_a", (2560, 4)),
                                    ("mlp.down_proj.lora_a", (9728, True))):
            matrices = shapes()
            matrices["model.layers.32." + suffix] = replacement
            with self.subTest(suffix=suffix), self.assertRaises(ValueError):
                tensor_plan(matrices)
        for replacement in (None, "unknown", "model.layers.31.self_attn.q_proj.lora_a"):
            matrices = shapes()
            shape = matrices.pop("model.layers.32.self_attn.q_proj.lora_a")
            if replacement:
                matrices[replacement] = shape
            with self.subTest(replacement=replacement), self.assertRaises(ValueError):
                tensor_plan(matrices)

    def test_digest_and_finite_f32_guards(self):
        verify_digest("a" * 64, "a" * 64)
        for expected in (None, "", "A" * 64, "b" * 64):
            with self.subTest(expected=expected), self.assertRaises(ValueError):
                verify_digest("a" * 64, expected)
        validate_values("float32", True)
        for dtype, finite in (("float16", True), ("bfloat16", True), ("float32", False)):
            with self.subTest(dtype=dtype, finite=finite), self.assertRaises(ValueError):
                validate_values(dtype, finite)

    def test_output_refuses_relative_internal_alias_and_overwrite(self):
        for path in (Path("relative"), REPO / "forbidden-export"):
            with self.assertRaises(ValueError):
                output_directory(path)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(FileExistsError):
                output_directory(root)
            (root / "alias").symlink_to(REPO, target_is_directory=True)
            with self.assertRaises(ValueError):
                output_directory(root / "alias" / "forbidden")

    def test_cli_rejects_each_hash_before_heavy_import_or_output_creation(self):
        original_import = builtins.__import__

        def guard_import(name, *args, **kwargs):
            if name.split(".")[0] in {"mlx", "numpy", "gguf"}:
                raise AssertionError("Heavy import attempted during stdlib control test")
            return original_import(name, *args, **kwargs)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            adapter = root / "adapter"
            adapter.mkdir()
            base = root / "config.json"
            base_bytes = json.dumps(base_config()).encode()
            base.write_bytes(base_bytes)
            # Invented bytes exercise preflight rejection; they are not model weights.
            (adapter / "adapters.safetensors").write_bytes(b"synthetic control fixture")
            (adapter / "adapter_config.json").write_text(json.dumps(adapter_config()))
            output = root.parent / (root.name + "-export")
            for mismatch in ("base", "adapter"):
                recipe = {"model_files": {"config.json": {"sha256":
                    "0" * 64 if mismatch == "base" else hashlib.sha256(base_bytes).hexdigest()}}}
                result = {"finite": True, "adapter_tensors": 56, "changed_tensors": 56,
                          "trainable_parameters": 1835008, "adapter_sha256": "0" * 64}
                (adapter / "recipe.json").write_text(json.dumps(recipe))
                (adapter / "training-result.json").write_text(json.dumps(result))
                with self.subTest(mismatch=mismatch), patch("builtins.__import__", guard_import), patch(
                        "sys.argv", ["export_qwen3", "--base-config", str(base), "--adapter",
                                     str(adapter), "--output", str(output)]), self.assertRaisesRegex(ValueError, "SHA256"):
                    main()
                self.assertFalse(output.exists())


class Qwen3CpuRoundTripTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        selected = os.environ.get("MYCO_GGUF_PY")
        if not selected:
            raise RuntimeError("Set MYCO_GGUF_PY to the pinned llama.cpp gguf-py directory; CPU round-trip is mandatory")
        import numpy as np
        from export_ministral3 import load_gguf
        cls.np, cls.gguf = np, load_gguf(Path(selected))

    def test_synthetic_4b_and_8b_gguf_roundtrip_and_independent_update_oracle(self):
        np = self.np
        mapping = {"self_attn.q_proj": "attn_q", "self_attn.k_proj": "attn_k",
                   "self_attn.v_proj": "attn_v", "self_attn.o_proj": "attn_output",
                   "mlp.gate_proj": "ffn_gate", "mlp.up_proj": "ffn_up", "mlp.down_proj": "ffn_down"}
        for profile, base, dimensions in (("4b", base_config(), shapes()), ("8b", base_config_8b(), shapes_8b())):
            matrices = {name: ((np.arange(width * height, dtype=np.float32).reshape(width, height) % 29)
                        + index * 3 - 17) / 1024
                        for index, (name, (width, height)) in enumerate(dimensions.items(), 1)}
            metadata = adapter_metadata(base, adapter_config())
            converted = convert_matrices(matrices, profile)
            with tempfile.TemporaryDirectory() as directory:
                destination = Path(directory) / "export"
                output = write_adapter(destination, metadata, converted, self.gguf)
                reader = self.gguf.GGUFReader(output, mode="r")
                for key, value in metadata.items():
                    field = reader.get_field(key)
                    self.assertEqual(field.contents(), value)
                    self.assertEqual(field.types, [self.gguf.GGUFValueType.FLOAT32 if isinstance(value, float)
                                                  else self.gguf.GGUFValueType.STRING])
                tensors = {tensor.name: tensor for tensor in reader.tensors}
                self.assertEqual(len(tensors), 56)
                expected_names = set()
                for name, values in matrices.items():
                    parts = name.split(".")
                    target = f"blk.{parts[2]}.{mapping['.'.join(parts[3:5])]}.weight.{parts[5]}"
                    expected_names.add(target)
                    tensor = tensors[target]
                    self.assertEqual(tensor.tensor_type, self.gguf.GGMLQuantizationType.F32)
                    self.assertEqual(tensor.shape.tolist(), list(values.shape))
                    np.testing.assert_array_equal(tensor.data, values.T)
                self.assertEqual(set(tensors), expected_names)
                alpha = reader.get_field("adapter.lora.alpha").contents()
                for projection, target in mapping.items():
                    source = f"model.layers.32.{projection}.lora_"
                    a, b = matrices[source + "a"], matrices[source + "b"]
                    positions, coefficients = (0, 3, a.shape[0] - 1), (1.0, -2.0, 0.5)
                    latent = [sum(coefficient * float(a[position, rank])
                                  for position, coefficient in zip(positions, coefficients)) for rank in range(8)]
                    columns = [0, 1, b.shape[1] // 2, b.shape[1] - 1]
                    gold = np.array([16 * sum(latent[rank] * float(b[rank, column]) for rank in range(8))
                                     for column in columns])
                    x = np.zeros(a.shape[0], dtype=np.float32)
                    x[list(positions)] = coefficients
                    native_a = tensors[f"blk.32.{target}.weight.lora_a"].data
                    native_b = tensors[f"blk.32.{target}.weight.lora_b"].data
                    native = (native_b @ (native_a @ x))[columns] * (alpha / 8)
                    with self.subTest(profile=profile, projection=projection):
                        np.testing.assert_allclose(native, gold, rtol=1e-6, atol=1e-6)
                        self.assertFalse(np.allclose(native / 8, gold, rtol=1e-6, atol=1e-6))
                    if projection in {"self_attn.q_proj", "self_attn.k_proj"}:
                        # A Llama-style rotary permutation would replace row 1 with row 64.
                        self.assertFalse(np.array_equal(native_b[1], b[:, 64]))
                with self.assertRaises(FileExistsError):
                    write_adapter(destination, metadata, converted, self.gguf)

    def test_refuses_nonfinite_and_non_f32_synthetic_8b_values(self):
        np = self.np
        matrices = {name: np.zeros(shape, dtype=np.float32) for name, shape in shapes_8b().items()}
        name = next(iter(matrices))
        for value in (np.nan, np.inf, -np.inf):
            changed = dict(matrices)
            changed[name] = changed[name].copy()
            changed[name][0, 0] = value
            with self.subTest(value=value), self.assertRaises(ValueError):
                convert_matrices(changed, "8b")
        changed = {**matrices, name: matrices[name].astype(np.float16)}
        with self.assertRaises(ValueError):
            convert_matrices(changed, "8b")


if __name__ == "__main__":
    unittest.main()
