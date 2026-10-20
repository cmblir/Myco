"""Check narrow adapter-export contracts without importing MLX, NumPy or GGUF."""

import copy
from pathlib import Path
import tempfile
import unittest

from export import PREFIX, REPO, adapter_metadata, output_directory, tensor_plan, validate_values


def config():
    return {"fine_tune_type": "lora", "num_layers": 1,
            "lora_parameters": {"rank": 8, "scale": 16.0, "dropout": 0.0}}


def shapes():
    dimensions = {"self_attn.q_proj": (16, 32), "self_attn.k_proj": (16, 8),
                  "self_attn.v_proj": (16, 8), "self_attn.o_proj": (16, 16),
                  "mlp.gate_proj": (16, 24), "mlp.up_proj": (16, 24),
                  "mlp.down_proj": (24, 16)}
    return {PREFIX + name + ".lora_" + side: shape
            for name, (width, height) in dimensions.items()
            for side, shape in (("a", (width, 8)), ("b", (8, height)))}


class ExportTests(unittest.TestCase):
    def test_exact_metadata_preserves_mlx_scale_at_native_scale_one(self):
        metadata = adapter_metadata(config())
        self.assertEqual(metadata, {"general.architecture": "qwen35", "general.type": "adapter",
                                   "adapter.type": "lora", "adapter.lora.alpha": 128.0})
        self.assertEqual(metadata["adapter.lora.alpha"] / 8, 16.0)

    def test_rejects_other_training_configs(self):
        changes = [{"fine_tune_type": "dora"}, {"num_layers": 4}, {"num_layers": True},
                   {"extra": "unknown"}, {"lora_parameters": {"rank": 4, "scale": 16, "dropout": 0}},
                   {"lora_parameters": {"rank": 8, "scale": 2, "dropout": 0}},
                   {"lora_parameters": {"rank": 8, "scale": 16, "dropout": 0.1}}]
        for changeset in changes:
            with self.subTest(changeset=changeset), self.assertRaises(ValueError):
                adapter_metadata({**config(), **changeset})

    def test_maps_all_fourteen_and_keeps_full_joint_query_output(self):
        plan = tensor_plan(shapes())
        targets = {target: shape for _, target, shape in plan}
        self.assertEqual(len(plan), 14)
        self.assertEqual(targets["blk.31.attn_q.weight.lora_b"], (32, 8))
        self.assertEqual(targets["blk.31.attn_output.weight.lora_a"], (8, 16))
        self.assertEqual(set(targets), {f"blk.31.{name}.weight.lora_{side}"
                         for name in ("attn_q", "attn_k", "attn_v", "attn_output",
                                      "ffn_gate", "ffn_up", "ffn_down") for side in ("a", "b")})

    def test_refuses_unknown_missing_or_other_layer_tensor(self):
        for mutation in ("missing", "unknown", "wrong_layer"):
            matrices = shapes()
            name = next(iter(matrices))
            shape = matrices.pop(name)
            if mutation != "missing":
                matrices[name.replace(".31.", ".30.") if mutation == "wrong_layer" else "unknown"] = shape
            with self.subTest(mutation=mutation), self.assertRaisesRegex(ValueError, "exactly seven"):
                tensor_plan(matrices)

    def test_rejects_rank_shape_and_partial_query_gate_errors(self):
        changes = {"self_attn.q_proj.lora_a": [(16,), (0, 8), (True, 8), (16, 4)],
                   "self_attn.q_proj.lora_b": [(4, 32), (8, 16)],
                   "self_attn.k_proj.lora_b": [(8, 4)],
                   "mlp.gate_proj.lora_a": [(17, 8)]}
        for suffix, alternatives in changes.items():
            for shape in alternatives:
                matrices = copy.deepcopy(shapes())
                matrices[PREFIX + suffix] = shape
                with self.subTest(suffix=suffix, shape=shape), self.assertRaises(ValueError):
                    tensor_plan(matrices)

    def test_requires_finite_float32(self):
        validate_values("float32", True)
        for dtype, finite in (("float16", True), ("float64", True), ("float32", False)):
            with self.subTest(dtype=dtype, finite=finite), self.assertRaises(ValueError):
                validate_values(dtype, finite)

    def test_output_must_be_absolute_external_and_new(self):
        for path in (Path("relative"), REPO / "forbidden-export"):
            with self.assertRaises(ValueError):
                output_directory(path)
        with tempfile.TemporaryDirectory() as parent:
            root = Path(parent)
            self.assertEqual(output_directory(root / "new"), (root / "new").resolve())
            with self.assertRaises(FileExistsError):
                output_directory(root)
            (root / "alias").symlink_to(REPO, target_is_directory=True)
            with self.assertRaises(ValueError):
                output_directory(root / "alias" / "forbidden")
            (root / "broken").symlink_to(root / "missing")
            with self.assertRaises(FileExistsError):
                output_directory(root / "broken")


if __name__ == "__main__":
    unittest.main()
