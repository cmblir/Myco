"""Invented CPU-only packing tests; mandatory vendored GGUF uses MYCO_GGUF_PY."""

import builtins
import hashlib
import importlib.util
import os
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

from affine4_q4_1 import exact_half_bytes, repack_affine4_q4_1


class Affine4ControlTests(unittest.TestCase):
    def test_import_requires_no_array_model_or_tokenizer_packages(self):
        original = builtins.__import__

        def guarded(name, *args, **kwargs):
            if name.split(".")[0] in {"numpy", "mlx", "torch", "gguf", "transformers", "tokenizers"}:
                raise AssertionError("Unexpected package at primitive import: " + name)
            return original(name, *args, **kwargs)

        path = Path(__file__).with_name("affine4_q4_1.py")
        spec = importlib.util.spec_from_file_location("affine4_import_control", path)
        with patch("builtins.__import__", guarded):
            spec.loader.exec_module(importlib.util.module_from_spec(spec))

    def test_exact_fp16_and_rejections_without_array_imports(self):
        for value in (0.0, -0.0, 2 ** -24, -(2 ** -24), 0.125, -3.5, 65504.0):
            self.assertEqual(struct.unpack("<e", exact_half_bytes(value))[0], value)
        self.assertEqual(exact_half_bytes(-0.0), b"\x00\x80")
        for value in (float("nan"), float("inf"), -float("inf"), 65536.0, 2 ** -25, 0.1):
            with self.subTest(value=value), self.assertRaises(ValueError):
                exact_half_bytes(value)


class Affine4CpuTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        selected = os.environ.get("MYCO_GGUF_PY")
        if not selected:
            raise RuntimeError("Set MYCO_GGUF_PY to the pinned llama.cpp gguf-py directory")
        import numpy as np
        from export_ministral3 import load_gguf
        cls.np, cls.gguf = np, load_gguf(Path(selected))
        path = Path(selected) / "gguf/quants.py"
        if hashlib.sha256(path.read_bytes()).hexdigest() != "2c927a1b3d9f0920dcf4007fb686e1b0999333e9f65ce43dcc689900c0beae8b":
            raise ValueError("Pinned Q4_1 dequantization source hash mismatch")

    def fixture(self):
        np = self.np
        rows = [[(column * 7 + column // 9 + row * 3) % 16 for column in range(128)] for row in range(2)]
        # The test packs words with scalar arithmetic, independently of the vectorized repacker.
        words = [[sum(values[start + nibble] << (4 * nibble) for nibble in range(8))
                  for start in range(0, 128, 8)] for values in rows]
        return (rows, np.array(words, dtype="<u4"),
                np.array([[0.125, 0.5], [2 ** -24, -0.25]], dtype="<f4"),
                np.array([[-1.5, 2.0], [-0.0, 3.5]], dtype="<f4"))

    def test_scalar_code_and_coefficient_oracle_and_chunk_equivalence(self):
        np = self.np
        original_codes, words, scales, biases = self.fixture()
        snapshots = [values.copy() for values in (words, scales, biases)]
        packed = repack_affine4_q4_1(words, scales, biases)
        self.assertEqual(packed.shape, (2, 80))
        self.assertEqual(packed.dtype, np.uint8)
        for row in range(2):
            for block in range(4):
                group = block // 2
                body = packed[row, block * 20:(block + 1) * 20].tobytes()
                self.assertEqual(body[:4], struct.pack("<ee", float(scales[row, group]), float(biases[row, group])))
                d, m = struct.unpack("<ee", body[:4])
                for column in range(32):
                    byte = body[4 + column % 16]
                    code = (byte >> (4 if column >= 16 else 0)) & 15
                    index = block * 32 + column
                    self.assertEqual(code, original_codes[row][index])
                    self.assertEqual(d * code + m, float(scales[row, group]) * code + float(biases[row, group]))
        chunks = np.concatenate([repack_affine4_q4_1(words[row:row + 1], scales[row:row + 1], biases[row:row + 1])
                                 for row in range(2)])
        np.testing.assert_array_equal(packed, chunks)
        for values, snapshot in zip((words, scales, biases), snapshots):
            np.testing.assert_array_equal(values, snapshot)

    def test_actual_vendored_q4_1_dequantization_and_gguf_readback(self):
        np = self.np
        codes, words, scales, biases = self.fixture()
        packed = repack_affine4_q4_1(words, scales, biases)
        gold = np.array([[float(scales[row, column // 64]) * code + float(biases[row, column // 64])
                          for column, code in enumerate(values)] for row, values in enumerate(codes)], dtype=np.float32)
        qtype = self.gguf.GGMLQuantizationType.Q4_1
        np.testing.assert_array_equal(self.gguf.dequantize(packed, qtype), gold)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "synthetic.gguf"
            writer = self.gguf.GGUFWriter(path, "qwen3")
            try:
                writer.add_tensor("invented.weight", packed, raw_dtype=qtype)
                writer.write_header_to_file()
                writer.write_kv_data_to_file()
                writer.write_tensors_to_file()
            finally:
                writer.close()
            tensor = self.gguf.GGUFReader(path, mode="r").tensors[0]
            self.assertEqual(tensor.tensor_type, qtype)
            self.assertEqual(tensor.shape.tolist(), [128, 2])
            np.testing.assert_array_equal(tensor.data, packed)
            np.testing.assert_array_equal(self.gguf.dequantize(tensor.data, qtype), gold)

    def test_rejects_types_shapes_and_inexact_coefficients(self):
        np = self.np
        _, words, scales, biases = self.fixture()
        invalid = [(np.full(words.shape, 2 ** 40, dtype=np.uint64), scales, biases), (words.astype(">u4"), scales, biases),
                   (words.tolist(), scales, biases), (words[:, :-1], scales, biases),
                   (words[:0], scales[:0], biases[:0]), (words[:, :0], scales, biases),
                   (words.reshape(-1), scales, biases), (words, scales[:, :1], biases),
                   (words, scales, biases.astype(np.float64)), (words, scales, biases.reshape(-1))]
        for values in invalid:
            with self.subTest(shapes=[getattr(value, "shape", None) for value in values]), self.assertRaises(ValueError):
                repack_affine4_q4_1(*values)
        for value in (np.nan, np.inf, -np.inf, 65536, 2 ** -25, 0.1):
            for field in ("scale", "bias"):
                changed = (scales if field == "scale" else biases).copy()
                changed[0, 1] = value
                with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                    repack_affine4_q4_1(words, changed if field == "scale" else scales,
                                       changed if field == "bias" else biases)


if __name__ == "__main__":
    unittest.main()
