"""Check only invented Phi-4 shapes and provenance; never load model arrays."""

import builtins
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from export import REPO
from export_phi4 import (adapter_metadata, main, output_directory, tensor_plan,
                         validate_training_result, validate_values, verify_digest)


def base_config():
    return {"model_type": "phi3", "architectures": ["Phi3ForCausalLM"],
            "num_hidden_layers": 32, "hidden_size": 3072, "intermediate_size": 8192,
            "num_attention_heads": 24, "num_key_value_heads": 8,
            "partial_rotary_factor": 0.75, "rope_theta": 10000.0,
            "max_position_embeddings": 131072, "original_max_position_embeddings": 4096,
            "tie_word_embeddings": True,
            "rope_scaling": {"type": "longrope", "short_factor": [1.0] * 48,
                             "long_factor": [2.0] * 48}}


def adapter_config():
    return {"fine_tune_type": "lora", "num_layers": 4,
            "lora_parameters": {"rank": 8, "scale": 16.0, "dropout": 0.0,
                "keys": ["self_attn.qkv_proj", "self_attn.o_proj",
                         "mlp.gate_up_proj", "mlp.down_proj"]}}


def shapes():
    dimensions = {"self_attn.qkv_proj": (3072, 5120), "self_attn.o_proj": (3072, 3072),
                  "mlp.gate_up_proj": (3072, 16384), "mlp.down_proj": (8192, 3072)}
    return {f"model.layers.{layer}.{name}.lora_{side}": shape
            for layer in range(28, 32) for name, (width, height) in dimensions.items()
            for side, shape in (("a", (width, 8)), ("b", (8, height)))}


def completed_result():
    return {"iterations": 123, "finite": True, "adapter_tensors": 32,
            "changed_tensors": 32, "final_validation_loss": 1.25,
            "adapter_sha256": "a" * 64}


def recipe():
    return {"iters": 123, "lora_layers": 4, "rank": 8}


class Phi4ExportTests(unittest.TestCase):
    def test_metadata_matches_phi3_and_direct_scale(self):
        metadata = adapter_metadata(base_config(), adapter_config())
        self.assertEqual(metadata, {"general.architecture": "phi3", "general.type": "adapter",
                                   "adapter.type": "lora", "adapter.lora.alpha": 128.0})
        self.assertEqual(metadata["adapter.lora.alpha"] / 8, 16.0)

    def test_rejects_other_dimensions_rotary_contracts_and_fused_keys(self):
        for changes in ({"model_type": "phi4"}, {"architectures": ["PhiForCausalLM"]},
                        {"num_hidden_layers": 36}, {"hidden_size": 2560},
                        {"num_attention_heads": 32}, {"num_key_value_heads": True},
                        {"intermediate_size": 9728}, {"partial_rotary_factor": 1.0},
                        {"tie_word_embeddings": False}, {"max_position_embeddings": 4096}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                adapter_metadata({**base_config(), **changes}, adapter_config())
        for key, value in (("type", "linear"), ("short_factor", [1.0] * 64),
                           ("long_factor", [float("nan")] * 48), ("long_factor", [True] * 48)):
            base = base_config()
            base["rope_scaling"][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                adapter_metadata(base, adapter_config())
        for alteration in ("rank", "scale", "dropout", "keys"):
            config = adapter_config()
            config["lora_parameters"][alteration] = {"rank": True, "scale": 8,
                "dropout": False, "keys": ["self_attn.q_proj"]}[alteration]
            with self.subTest(alteration=alteration), self.assertRaises(ValueError):
                adapter_metadata(base_config(), config)

    def test_maps_all_fused_matrices_and_keeps_full_qkv_gate_up_channels(self):
        plan = tensor_plan(shapes())
        targets = {name: shape for _, name, shape in plan}
        self.assertEqual(len(plan), 32)
        self.assertEqual(targets["blk.28.attn_qkv.weight.lora_a"], (8, 3072))
        self.assertEqual(targets["blk.28.attn_qkv.weight.lora_b"], (3072 + 1024 + 1024, 8))
        self.assertEqual(targets["blk.31.ffn_up.weight.lora_b"], (8192 + 8192, 8))
        self.assertEqual(targets["blk.31.ffn_down.weight.lora_a"], (8, 8192))
        self.assertEqual(set(targets), {f"blk.{layer}.{name}.weight.lora_{side}"
            for layer in range(28, 32) for name in ("attn_qkv", "attn_output", "ffn_up", "ffn_down")
            for side in ("a", "b")})

    def test_rejects_splits_missing_unknown_layers_rank_and_wrong_fused_widths(self):
        for suffix, shape in (("self_attn.qkv_proj.lora_b", (8, 9216)),
                              ("mlp.gate_up_proj.lora_b", (8, 8192)),
                              ("mlp.down_proj.lora_a", (8192, 4)),
                              ("self_attn.o_proj.lora_a", (3072, True))):
            changed = shapes()
            changed["model.layers.28." + suffix] = shape
            with self.subTest(suffix=suffix), self.assertRaises(ValueError):
                tensor_plan(changed)
        for substitute in (None, "model.layers.27.self_attn.qkv_proj.lora_a",
                           "model.layers.28.self_attn.q_proj.lora_a"):
            changed = shapes()
            shape = changed.pop("model.layers.28.self_attn.qkv_proj.lora_a")
            if substitute:
                changed[substitute] = shape
            with self.subTest(substitute=substitute), self.assertRaises(ValueError):
                tensor_plan(changed)

    def test_requires_completed_full_recipe_not_rejected_feasibility(self):
        validate_training_result(completed_result(), recipe())
        for changes in ({"iterations": 4}, {"finite": False}, {"changed_tensors": 31},
                        {"adapter_tensors": 32.0}, {"final_validation_loss": float("nan")},
                        {"final_validation_loss": True}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                validate_training_result({**completed_result(), **changes}, recipe())
        for changes in ({"iters": 4}, {"lora_layers": 1}, {"rank": True}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                validate_training_result(completed_result(), {**recipe(), **changes})

    def test_digest_and_finite_f32_guards(self):
        verify_digest("a" * 64, "a" * 64)
        for expected in (None, "", "A" * 64, "b" * 64):
            with self.subTest(expected=expected), self.assertRaises(ValueError):
                verify_digest("a" * 64, expected)
        validate_values("float32", True)
        for dtype, finite in (("float16", True), ("bfloat16", True), ("float32", False)):
            with self.subTest(dtype=dtype, finite=finite), self.assertRaises(ValueError):
                validate_values(dtype, finite)

    def test_output_rejects_checkout_aliases_relative_paths_and_existing_directories(self):
        for path in (Path("relative"), REPO / "forbidden-phi-export"):
            with self.assertRaises(ValueError):
                output_directory(path)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(FileExistsError):
                output_directory(root)
            (root / "alias").symlink_to(REPO, target_is_directory=True)
            with self.assertRaises(ValueError):
                output_directory(root / "alias/forbidden")

    def test_cli_rejects_hashes_and_incomplete_result_before_heavy_imports(self):
        original_import = builtins.__import__

        def guard_import(name, *args, **kwargs):
            if name.split(".")[0] in {"mlx", "numpy", "gguf"}:
                raise AssertionError("Heavy import attempted in a stdlib control test")
            return original_import(name, *args, **kwargs)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            base, adapter, output = root / "base/config.json", root / "adapter", root / "output"
            base.parent.mkdir()
            adapter.mkdir()
            base_bytes = json.dumps(base_config()).encode()
            base.write_bytes(base_bytes)
            # These are invented fixture bytes, never an actual adapter.
            (adapter / "adapters.safetensors").write_bytes(b"invented Phi control fixture")
            (adapter / "adapter_config.json").write_text(json.dumps(adapter_config()))
            for failure in ("base_hash", "adapter_hash", "incomplete"):
                selected_recipe = {**recipe(), "model_files": {"config.json": {"sha256":
                    "0" * 64 if failure == "base_hash" else hashlib.sha256(base_bytes).hexdigest()}}}
                result = {**completed_result(), "adapter_sha256": "0" * 64}
                if failure == "incomplete":
                    result["iterations"] = 4
                (adapter / "recipe.json").write_text(json.dumps(selected_recipe))
                (adapter / "training-result.json").write_text(json.dumps(result))
                with self.subTest(failure=failure), patch("builtins.__import__", guard_import), patch(
                        "sys.argv", ["export_phi4", "--base-config", str(base), "--adapter", str(adapter),
                                     "--output", str(output)]), self.assertRaises(ValueError):
                    main()
                self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
