"""Check invented Ministral3 adapters only; CPU NumPy/GGUF tests require MYCO_GGUF_PY."""

import builtins
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

from export import REPO
from export_ministral3 import (adapter_header, adapter_metadata,
                               convert_matrices, load_gguf, main, output_directory,
                               permute_rows, tensor_plan)

EXPECTED_PROJECTIONS = {
    "self_attn.q_proj": ("attn_q", 3072, 4096, 32),
    "self_attn.k_proj": ("attn_k", 3072, 1024, 8),
    "self_attn.v_proj": ("attn_v", 3072, 1024, None),
    "self_attn.o_proj": ("attn_output", 4096, 3072, None),
    "mlp.gate_proj": ("ffn_gate", 3072, 9216, None),
    "mlp.up_proj": ("ffn_up", 3072, 9216, None),
    "mlp.down_proj": ("ffn_down", 9216, 3072, None),
}


def base_config():
    return {"model_type": "mistral3", "architectures": ["Mistral3ForConditionalGeneration"],
            "quantization": {"group_size": 64, "bits": 4, "mode": "affine"},
            "quantization_config": {"group_size": 64, "bits": 4, "mode": "affine"},
            "text_config": {"model_type": "ministral3", "num_hidden_layers": 26,
                "hidden_size": 3072, "intermediate_size": 9216, "head_dim": 128,
                "num_attention_heads": 32, "num_key_value_heads": 8, "vocab_size": 131072,
                "max_position_embeddings": 262144, "tie_word_embeddings": True,
                "sliding_window": None, "rms_norm_eps": 1e-5, "hidden_act": "silu",
                "rope_parameters": {"rope_type": "yarn", "type": "yarn", "factor": 16.0,
                    "original_max_position_embeddings": 16384, "rope_theta": 1000000.0,
                    "beta_fast": 32.0, "beta_slow": 1.0, "mscale": 1.0,
                    "mscale_all_dim": 1.0, "llama_4_scaling_beta": 0.1}}}


def adapter_config():
    return {"fine_tune_type": "lora", "num_layers": 4,
            "lora_parameters": {"rank": 8, "scale": 16.0, "dropout": 0.0}}


def shapes():
    widths = {"self_attn.q_proj": (3072, 4096), "self_attn.k_proj": (3072, 1024),
              "self_attn.v_proj": (3072, 1024), "self_attn.o_proj": (4096, 3072),
              "mlp.gate_proj": (3072, 9216), "mlp.up_proj": (3072, 9216),
              "mlp.down_proj": (9216, 3072)}
    return {f"language_model.model.layers.{layer}.{projection}.lora_{side}": shape
            for layer in range(22, 26) for projection, (width, height) in widths.items()
            for side, shape in (("a", (width, 8)), ("b", (8, height)))}


def packed_adapter(matrices, alter_header=None):
    """Create invented safetensors bytes without MLX/Torch/safetensors imports."""
    header, payload, offset = {"__metadata__": {"purpose": "invented CPU test fixture"}}, [], 0
    for name, values in matrices.items():
        body = values.astype("<f4", copy=False).tobytes(order="C")
        header[name] = {"dtype": "F32", "shape": list(values.shape), "data_offsets": [offset, offset + len(body)]}
        payload.append(body)
        offset += len(body)
    if alter_header:
        alter_header(header)
    encoded = json.dumps(header, separators=(",", ":")).encode()
    encoded += b" " * (-len(encoded) % 8)
    return struct.pack("<Q", len(encoded)) + encoded + b"".join(payload)


def write_fixture(root, matrices):
    """Write synthetic contracts; the fixture does not claim real training occurred."""
    model, adapter = root / "model", root / "adapter"
    model.mkdir()
    adapter.mkdir()
    base = json.dumps(base_config()).encode()
    (model / "config.json").write_bytes(base)
    (adapter / "adapter_config.json").write_text(json.dumps(adapter_config()))
    body = packed_adapter(matrices)
    (adapter / "adapters.safetensors").write_bytes(body)
    (adapter / "recipe.json").write_text(json.dumps({"model": str(model.resolve()),
        "iters": 540, "lora_layers": 4, "rank": 8,
        "model_files": {"config.json": {"sha256": hashlib.sha256(base).hexdigest()}}}))
    (adapter / "training-result.json").write_text(json.dumps({"iterations": 540,
        "trainable_parameters": 1900544, "adapter_tensors": 56, "changed_tensors": 56,
        "finite": True, "final_validation_loss": 1.25,
        "adapter_sha256": hashlib.sha256(body).hexdigest()}))
    return model, adapter


class Ministral3ContractTests(unittest.TestCase):
    def test_module_import_does_not_load_array_model_or_tokenizer_packages(self):
        original = builtins.__import__

        def guarded(name, *args, **kwargs):
            if name.split(".")[0] in {"mlx", "torch", "numpy", "gguf", "transformers", "tokenizers"}:
                raise AssertionError("Unexpected dependency at module import: " + name)
            return original(name, *args, **kwargs)

        path = Path(__file__).with_name("export_ministral3.py")
        spec = importlib.util.spec_from_file_location("ministral3_import_control", path)
        with patch("builtins.__import__", guarded):
            spec.loader.exec_module(importlib.util.module_from_spec(spec))

    def test_metadata_uses_mistral3_and_alpha128(self):
        metadata = adapter_metadata(base_config(), adapter_config())
        self.assertEqual(metadata, {"general.architecture": "mistral3", "general.type": "adapter",
                                   "adapter.type": "lora", "adapter.lora.alpha": 128.0})
        self.assertEqual(metadata["adapter.lora.alpha"] / 8, 16.0)

    def test_rejects_other_base_rope_quantization_and_adapter_contracts(self):
        for section, key, value in ((None, "model_type", "ministral3"),
                (None, "architectures", ["LlamaForCausalLM"]), ("text_config", "num_hidden_layers", 27),
                ("text_config", "head_dim", True), ("text_config", "num_key_value_heads", 32),
                ("text_config", "hidden_size", 4096), ("text_config", "tie_word_embeddings", False),
                ("text_config", "layer_types", ["sliding_attention"] * 26),
                ("quantization", "bits", 8), ("quantization_config", "group_size", True)):
            base = base_config()
            (base if section is None else base[section])[key] = value
            with self.subTest(section=section, key=key), self.assertRaises(ValueError):
                adapter_metadata(base, adapter_config())
        for key, value in (("rope_type", "default"), ("factor", 8), ("mscale_all_dim", True),
                           ("llama_4_scaling_beta", 0), ("rope_theta", float("nan"))):
            base = base_config()
            base["text_config"]["rope_parameters"][key] = value
            with self.subTest(rope=key), self.assertRaises(ValueError):
                adapter_metadata(base, adapter_config())
        for changes in ({"num_layers": 1}, {"extra": True},
                        {"lora_parameters": {"rank": True, "scale": 16, "dropout": 0}},
                        {"lora_parameters": {"rank": 8, "scale": 8, "dropout": 0}},
                        {"lora_parameters": {"rank": 8, "scale": 16, "dropout": False}}):
            with self.subTest(adapter=changes), self.assertRaises(ValueError):
                adapter_metadata(base_config(), {**adapter_config(), **changes})

    def test_exact56_names_shapes_and_only_qk_b_permutation(self):
        plan = tensor_plan(shapes())
        self.assertEqual(len(plan), 56)
        self.assertEqual(sum(heads is not None for _, _, _, heads in plan), 8)
        self.assertEqual({target for _, target, _, _ in plan},
            {f"blk.{layer}.{projection}.weight.lora_{side}" for layer in range(22, 26)
             for projection in ("attn_q", "attn_k", "attn_v", "attn_output", "ffn_gate", "ffn_up", "ffn_down")
             for side in ("a", "b")})
        targets = {target: (shape, heads) for _, target, shape, heads in plan}
        self.assertEqual(targets["blk.22.attn_q.weight.lora_b"], ((4096, 8), 32))
        self.assertEqual(targets["blk.25.attn_k.weight.lora_b"], ((1024, 8), 8))
        self.assertEqual(targets["blk.22.attn_q.weight.lora_a"], ((8, 3072), None))
        for alteration in ("missing", "extra", "wrong_layer", "wrong_prefix", "wrong_shape"):
            changed = shapes()
            name = "language_model.model.layers.22.self_attn.q_proj.lora_a"
            if alteration == "extra":
                changed["unknown"] = (8, 8)
            elif alteration == "wrong_shape":
                changed[name] = (3072, True)
            else:
                shape = changed.pop(name)
                if alteration != "missing":
                    changed[name.replace(".22.", ".21.") if alteration == "wrong_layer"
                            else name.removeprefix("language_model.")] = shape
            with self.subTest(alteration=alteration), self.assertRaises(ValueError):
                tensor_plan(changed)

    def test_refuses_existing_relative_repo_and_symlink_outputs(self):
        for path in (Path("relative"), REPO / "forbidden-ministral-export"):
            with self.assertRaises(ValueError):
                output_directory(path)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(FileExistsError):
                output_directory(root)
            (root / "alias").symlink_to(REPO, target_is_directory=True)
            with self.assertRaises(ValueError):
                output_directory(root / "alias/forbidden")
            (root / "broken").symlink_to(root / "missing")
            with self.assertRaises(FileExistsError):
                output_directory(root / "broken")

    def test_same_gguf_version_label_does_not_replace_pinned_writer_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "pyproject.toml").write_text('[project]\nversion = "0.19.0"\n')
            with self.assertRaisesRegex(ValueError, "SHA256"):
                load_gguf(root)


class Ministral3CpuRoundTripTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        selected = os.environ.get("MYCO_GGUF_PY")
        if not selected:
            raise RuntimeError("Set MYCO_GGUF_PY to the pinned llama.cpp gguf-py directory; CPU round-trip is mandatory")
        import numpy as np
        cls.np, cls.gguf_path, cls.gguf = np, Path(selected), load_gguf(Path(selected))
        cls.matrices = {name: ((np.arange(shape[0] * shape[1], dtype=np.float32).reshape(shape) % 13) - 6 + index) / 1024
                        for index, (name, shape) in enumerate(shapes().items(), 1)}

    def invoke(self, model, adapter, output):
        with patch("sys.argv", ["export_ministral3", "--model", str(model), "--adapter", str(adapter),
                                "--output", str(output), "--gguf-py", str(self.gguf_path)]):
            main()

    def expected_native_matrices(self):
        """Use test-side mapping and row-index gathers, independent of exporter planning."""
        np, expected = self.np, {}
        for layer in range(22, 26):
            for projection, (target, _, height, heads) in EXPECTED_PROJECTIONS.items():
                source = f"language_model.model.layers.{layer}.{projection}.lora_"
                expected[f"blk.{layer}.{target}.weight.lora_a"] = self.matrices[source + "a"].T.copy()
                rows = self.matrices[source + "b"].T.copy()
                if heads is not None:
                    indices = np.array([index for offset in range(0, height, 128)
                        for pair in zip(range(offset, offset + 64), range(offset + 64, offset + 128))
                        for index in pair])
                    rows = rows[indices]
                expected[f"blk.{layer}.{target}.weight.lora_b"] = rows
        return expected

    def test_q32_and_k8_permutations_match_hardcoded_gold(self):
        np = self.np
        for heads in (32, 8):
            # Four output rows per head: the independent gold order is [0,2,1,3].
            values = np.arange(heads * 4, dtype=np.float32).reshape(-1, 1)
            gold = np.array([0, 2, 1, 3] * heads, dtype=np.float32)
            gold += np.repeat(np.arange(heads, dtype=np.float32) * 4, 4)
            np.testing.assert_array_equal(permute_rows(values, heads)[:, 0], gold)
            self.assertEqual(gold[:8].tolist(), [0, 2, 1, 3, 4, 6, 5, 7])
        for heads, rows in ((32, 4096), (8, 1024)):
            values = np.arange(rows, dtype=np.float32).reshape(-1, 1)
            actual = permute_rows(values, heads)[:, 0]
            self.assertEqual(actual[:8].tolist(), [0, 64, 1, 65, 2, 66, 3, 67])
            self.assertEqual(actual[124:132].tolist(), [62, 126, 63, 127, 128, 192, 129, 193])
        for heads in (0, True, 3):
            with self.subTest(heads=heads), self.assertRaises(ValueError):
                permute_rows(np.zeros((128, 8), dtype=np.float32), heads)

    def test_all_projection_effective_updates_equal_mlx_scale16(self):
        np = self.np
        converted = convert_matrices(self.matrices)
        self.assertEqual(len({float(values[0, 0]) for values in self.matrices.values()}), 56)
        for layer in range(22, 26):
            for projection, (target, width, height, heads) in EXPECTED_PROJECTIONS.items():
                source = f"language_model.model.layers.{layer}.{projection}.lora_"
                x = np.zeros(width, dtype=np.float32)
                x[:4] = [1, -2, 3, -4]
                mlx_update = ((x @ self.matrices[source + "a"]) @ self.matrices[source + "b"]) * 16
                if heads is not None:
                    # Independent row-index gather, rather than the exporter's reshape/swap.
                    indices = np.array([index for offset in range(0, height, 128)
                        for pair in zip(range(offset, offset + 64), range(offset + 64, offset + 128))
                        for index in pair])
                    mlx_update = mlx_update[indices]
                native_update = (converted[f"blk.{layer}.{target}.weight.lora_b"] @
                    (converted[f"blk.{layer}.{target}.weight.lora_a"] @ x)) * (128 / 8) * 1.0
                base_output = np.arange(height, dtype=np.float32) / 4096
                with self.subTest(layer=layer, projection=projection):
                    np.testing.assert_array_equal(native_update + base_output, mlx_update + base_output)

    def test_real_gguf_readback_preserves_metadata_names_shapes_and_f32_values(self):
        np = self.np
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model, adapter = write_fixture(root, self.matrices)
            output = root / "export"
            self.invoke(model, adapter, output)
            reader = self.gguf.GGUFReader(output / "adapter.gguf", mode="r")
            expected_metadata = {"general.architecture": "mistral3", "general.type": "adapter",
                                 "adapter.type": "lora", "adapter.lora.alpha": 128.0}
            for key, value in expected_metadata.items():
                field = reader.get_field(key)
                self.assertEqual(field.contents(), value)
                self.assertEqual(field.types, [self.gguf.GGUFValueType.FLOAT32 if isinstance(value, float)
                                              else self.gguf.GGUFValueType.STRING])
            tensors = {tensor.name: tensor for tensor in reader.tensors}
            expected = self.expected_native_matrices()
            self.assertEqual(set(tensors), set(expected))
            self.assertEqual(len(tensors), 56)
            for name, values in expected.items():
                tensor = tensors[name]
                self.assertEqual(tensor.tensor_type, self.gguf.GGMLQuantizationType.F32)
                self.assertEqual(tensor.shape.tolist(), list(values.shape[::-1]))
                self.assertEqual(tensor.data.shape, values.shape)
                np.testing.assert_array_equal(tensor.data, values)
            receipt = json.loads((output / "export-result.json").read_text())
            self.assertEqual(receipt["parameters"], 1900544)
            self.assertEqual(receipt["gguf_sha256"], hashlib.sha256((output / "adapter.gguf").read_bytes()).hexdigest())
            self.assertFalse(receipt["base_weights_exported"])
            self.assertFalse(receipt["native_equivalence_verified"])
            self.assertFalse(receipt["production_adoption"])
            with self.assertRaises(FileExistsError):
                self.invoke(model, adapter, output)

    def test_rejects_nonfinite_or_non_f32_arrays(self):
        np = self.np
        name = next(iter(self.matrices))
        for value in (np.nan, np.inf, -np.inf):
            changed = dict(self.matrices)
            changed[name] = changed[name].copy()
            changed[name][0, 0] = value
            with self.subTest(value=value), self.assertRaises(ValueError):
                convert_matrices(changed)
        changed = dict(self.matrices)
        changed[name] = changed[name].astype(np.float16)
        with self.assertRaises(ValueError):
            convert_matrices(changed)

    def test_safetensors_rejects_dtype_shape_offsets_truncation_and_extra_tensor(self):
        body = packed_adapter(self.matrices)
        self.assertEqual(len(adapter_header(body)[0]), 56)
        name = next(iter(self.matrices))
        mutations = [lambda h: h[name].update(dtype="F16"),
                     lambda h: h[name].update(shape=[3072, 4]),
                     lambda h: h[name].update(data_offsets=[1, 98305]),
                     lambda h: h.update(unknown={"dtype": "F32", "shape": [8, 8], "data_offsets": [0, 256]})]
        for mutate in mutations:
            with self.subTest(mutation=mutate), self.assertRaises(ValueError):
                adapter_header(packed_adapter(self.matrices, mutate))
        for invalid in (body[:-1], body + b"x", b"short", struct.pack("<Q", 2 ** 32) + b"x"):
            with self.subTest(length=len(invalid)), self.assertRaises(ValueError):
                adapter_header(invalid)

    def test_cli_rejects_bad_provenance_or_nonfinite_before_creating_output(self):
        for failure in ("base_hash", "adapter_hash", "incomplete", "nonfinite"):
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                matrices = dict(self.matrices)
                if failure == "nonfinite":
                    name = next(iter(matrices))
                    matrices[name] = matrices[name].copy()
                    matrices[name][0, 0] = self.np.nan
                model, adapter = write_fixture(root, matrices)
                if failure != "nonfinite":
                    path = adapter / ("recipe.json" if failure == "base_hash" else "training-result.json")
                    altered = json.loads(path.read_text())
                    if failure == "base_hash":
                        altered["model_files"]["config.json"]["sha256"] = "0" * 64
                    elif failure == "adapter_hash":
                        altered["adapter_sha256"] = "0" * 64
                    else:
                        altered["iterations"] = 135
                    path.write_text(json.dumps(altered))
                output = root / "export"
                with self.subTest(failure=failure), self.assertRaises(ValueError):
                    self.invoke(model, adapter, output)
                self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
