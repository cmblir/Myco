"""Invented small tensors exercise the pinned real GGUF writer and reader."""

from dataclasses import replace
import hashlib
import json
import os
from pathlib import Path
import struct
import tempfile
import unittest

from qwen3_base_payload import write_base_payload, verify_base_payload
from qwen3_base_plan import BaseTensorPlan
from safetensor_rows import PinnedTensorRows


class BasePayloadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import numpy as np
        from export_ministral3 import load_gguf
        cls.np = np
        selected = os.environ.get("MYCO_GGUF_PY")
        if not selected:
            raise RuntimeError("Set MYCO_GGUF_PY to the pinned gguf-py directory")
        cls.gguf = load_gguf(Path(selected))

    def fixture(self, directory, scale=0.125):
        np = self.np
        codes = [[(row * 3 + column * 7) % 16 for column in range(128)] for row in range(3)]
        words = [[sum(values[start + n] << (4 * n) for n in range(8))
                  for start in range(0, 128, 8)] for values in codes]
        arrays = {
            "weight": np.array(words, dtype="<u4"),
            "scales": np.full((3, 2), scale, dtype="<f4"),
            "biases": np.array([[-1.5, 2.0]] * 3, dtype="<f4"),
            "norm": np.array([1.0, -0.0, 2.5], dtype="<f4"),
        }
        header, payload = {}, bytearray()
        for name, values in arrays.items():
            start = len(payload)
            payload.extend(values.tobytes())
            header[name] = {"dtype": "U32" if name == "weight" else "F32",
                            "shape": list(values.shape), "data_offsets": [start, len(payload)]}
        encoded = json.dumps(header).encode()
        content = struct.pack("<Q", len(encoded)) + encoded + payload
        path = Path(directory).resolve() / "synthetic.safetensors"
        path.write_bytes(content)
        plans = (
            BaseTensorPlan(("weight", "scales", "biases"), ("U32", "F32", "F32"),
                           "invented.weight", (3, 128), (3, 80), (128, 3), "Q4_1", True),
            BaseTensorPlan(("norm",), ("F32",), "invented_norm.weight",
                           (3,), (3,), (3,), "F32", False),
        )
        return (path, len(content), hashlib.sha256(content).hexdigest()), plans, codes, arrays

    def test_real_gguf_bytes_shapes_scalar_meanings_and_chunk_equivalence(self):
        np, gguf = self.np, self.gguf
        with tempfile.TemporaryDirectory() as directory:
            inputs, plans, codes, arrays = self.fixture(directory)
            receipts = []
            for chunk in (1, 2, 128):
                output = Path(directory).resolve() / f"synthetic-{chunk}.gguf"
                with PinnedTensorRows(*inputs) as reader:
                    emitted = write_base_payload(output, plans, reader, lambda writer: writer.add_name(
                        "Synthetic payload test"), gguf, chunk)
                verify_base_payload(output, emitted, gguf, row_chunk=1)
                receipts.append(emitted)
                tensors = gguf.GGUFReader(output).tensors
                actual = gguf.dequantize(tensors[0].data, gguf.GGMLQuantizationType.Q4_1)
                expected = np.array([[0.125 * code + float(arrays["biases"][row, column // 64])
                                      for column, code in enumerate(values)]
                                     for row, values in enumerate(codes)], dtype="<f4")
                np.testing.assert_array_equal(actual, expected)
                self.assertEqual(tensors[1].data.tobytes(), arrays["norm"].tobytes())
            self.assertEqual(receipts[0], receipts[1])
            self.assertEqual(receipts[0], receipts[2])

    def test_inexact_coefficient_fails_and_existing_output_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            inputs, plans, _, _ = self.fixture(directory, scale=0.1)
            output = Path(directory).resolve() / "rejected.gguf"
            with PinnedTensorRows(*inputs) as reader:
                with self.assertRaisesRegex(ValueError, "exactly representable"):
                    write_base_payload(output, plans, reader, lambda _: None, self.gguf)
            output.write_bytes(b"preserve existing output")
            with PinnedTensorRows(*inputs) as reader:
                with self.assertRaisesRegex(ValueError, "new canonical"):
                    write_base_payload(output, plans, reader, lambda _: None, self.gguf)
            self.assertEqual(output.read_bytes(), b"preserve existing output")

    def test_bad_plan_and_changed_readback_cannot_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            inputs, plans, _, _ = self.fixture(directory)
            output = Path(directory).resolve() / "synthetic.gguf"
            with PinnedTensorRows(*inputs) as reader:
                for change in ({"transpose": True}, {"storage_shape": (3, 64)},
                               {"ggml_shape": (3, 128)}, {"ggml_type": "Q4_0"}):
                    with self.subTest(change=change), self.assertRaises(ValueError):
                        write_base_payload(output, (replace(plans[0], **change),), reader,
                                           lambda _: None, self.gguf)
                emitted = write_base_payload(output, plans, reader, lambda _: None, self.gguf)
            broken = [{**entry, "sha256": "0" * 64} for entry in emitted]
            with self.assertRaisesRegex(ValueError, "bytes differ"):
                verify_base_payload(output, broken, self.gguf)
            with self.assertRaisesRegex(ValueError, "count"):
                verify_base_payload(output, emitted[:1], self.gguf)


if __name__ == "__main__":
    unittest.main()
