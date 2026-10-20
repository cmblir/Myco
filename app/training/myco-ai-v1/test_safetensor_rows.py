"""Small invented tensor files only; no model, tokenizer or inference imports."""

import hashlib
import json
from pathlib import Path
import struct
import tempfile
import unittest

from safetensor_rows import PinnedTensorRows


def fixture(directory, header=None, body=None):
    if body is None:
        body = struct.pack("<4I", 0x76543210, 0xFEDCBA98, 7, 9)
        body += struct.pack("<4H", 0x3F80, 0x8000, 0x3E00, 0xC060)
        body += struct.pack("<2e", 0.5, -2.0)
        body += struct.pack("<2f", 3.25, -0.0)
    if header is None:
        header = {
            "codes": {"dtype": "U32", "shape": [2, 2], "data_offsets": [0, 16]},
            "coefficients": {"dtype": "BF16", "shape": [2, 2], "data_offsets": [16, 24]},
            "halves": {"dtype": "F16", "shape": [2], "data_offsets": [24, 28]},
            "norm": {"dtype": "F32", "shape": [2], "data_offsets": [28, 36]},
        }
    encoded = header if isinstance(header, bytes) else json.dumps(header).encode()
    content = struct.pack("<Q", len(encoded)) + encoded + body
    path = Path(directory) / "invented.safetensors"
    path.write_bytes(content)
    return path.resolve(), len(content), hashlib.sha256(content).hexdigest()


class PinnedTensorRowsTests(unittest.TestCase):
    def test_codes_and_exact_float_expansion_keep_rows_and_signed_zero(self):
        with tempfile.TemporaryDirectory() as directory:
            inputs = fixture(directory)
            with PinnedTensorRows(*inputs) as reader:
                self.assertEqual(reader.read_rows("codes", 0, 1).tolist(), [[0x76543210, 0xFEDCBA98]])
                self.assertEqual(reader.read_rows("codes", 1, 1).tolist(), [[7, 9]])
                values = reader.read_rows("coefficients", 0, 2)
                self.assertEqual(values.tolist(), [[1.0, -0.0], [0.125, -3.5]])
                self.assertEqual(values.tobytes(), struct.pack("<4f", 1.0, -0.0, 0.125, -3.5))
                self.assertEqual(reader.read_rows("halves", 1, 1).tolist(), [-2.0])
                self.assertEqual(reader.read_rows("norm", 0, 2).tobytes(), struct.pack("<2f", 3.25, -0.0))
            self.assertEqual(values[1, 1], -3.5)
            with self.assertRaisesRegex(ValueError, "closed"):
                reader.read_rows("codes", 0, 1)

    def test_frozen_identity_and_symlink_are_required(self):
        with tempfile.TemporaryDirectory() as directory:
            path, size, digest = fixture(directory)
            for length, checksum in ((size + 1, digest), (size, "0" * 64)):
                with self.subTest(length=length), self.assertRaises(ValueError):
                    PinnedTensorRows(path, length, checksum)
            alias = path.with_name("alias")
            alias.symlink_to(path)
            with self.assertRaises(ValueError):
                PinnedTensorRows(alias, size, digest)
            with PinnedTensorRows(path, size, digest) as reader:
                path.rename(path.with_suffix(".old"))
                path.write_bytes(b"replacement")
                with self.assertRaisesRegex(ValueError, "changed"):
                    reader.read_rows("codes", 0, 1)

    def test_in_place_mutation_is_rejected_before_next_read(self):
        with tempfile.TemporaryDirectory() as directory:
            inputs = fixture(directory)
            with PinnedTensorRows(*inputs) as reader:
                with inputs[0].open("r+b") as output:
                    output.seek(-1, 2)
                    output.write(b"\x01")
                with self.assertRaisesRegex(ValueError, "changed"):
                    reader.read_rows("codes", 0, 1)

    def test_invalid_rows_nonfinite_values_and_chunk_bound(self):
        with tempfile.TemporaryDirectory() as directory:
            with PinnedTensorRows(*fixture(directory)) as reader:
                for start, count in ((-1, 1), (0, 0), (1, 2), (True, 1), (0, 1.0)):
                    with self.subTest(start=start, count=count), self.assertRaises(ValueError):
                        reader.read_rows("codes", start, count)
            for dtype, body in (("F32", struct.pack("<f", float("nan"))),
                                ("F16", struct.pack("<H", 0x7C00)),
                                ("BF16", struct.pack("<H", 0xFF80))):
                header = {"bad": {"dtype": dtype, "shape": [1], "data_offsets": [0, len(body)]}}
                with PinnedTensorRows(*fixture(directory, header, body)) as reader:
                    with self.assertRaisesRegex(ValueError, "nonfinite"):
                        reader.read_rows("bad", 0, 1)
            # A low injected bound tests rejection without allocating a large fixture.
            from unittest.mock import patch
            with PinnedTensorRows(*fixture(directory)) as reader:
                with patch("safetensor_rows.CHUNK_BYTES", 4):
                    with self.assertRaisesRegex(ValueError, "chunk bound"):
                        reader.read_rows("codes", 0, 1)

    def test_header_rejects_duplicates_bad_types_gaps_overlaps_and_trailing_bytes(self):
        variants = [
            ({"a": {"dtype": "U64", "shape": [1], "data_offsets": [0, 8]}}, b"\0" * 8),
            ({"a": {"dtype": "F32", "shape": [True], "data_offsets": [0, 4]}}, b"\0" * 4),
            ({"a": {"dtype": "F32", "shape": [1], "data_offsets": [1, 5]}}, b"\0" * 5),
            ({"a": {"dtype": "F32", "shape": [1], "data_offsets": [0, 4]},
              "b": {"dtype": "F32", "shape": [1], "data_offsets": [0, 4]}}, b"\0" * 4),
            ({"a": {"dtype": "F32", "shape": [1], "data_offsets": [0, 4]}}, b"\0" * 5),
            ({"a": {"dtype": "F32", "shape": [1], "data_offsets": [0, 4]},
              "__metadata__": {"invalid": 1}}, b"\0" * 4),
            (b'{"a":{},"a":{}}', b"\0" * 4),
            ({}, b"\0" * 4),
            ([], b"\0" * 4),
        ]
        with tempfile.TemporaryDirectory() as directory:
            for header, body in variants:
                with self.subTest(header=header), self.assertRaises(ValueError):
                    PinnedTensorRows(*fixture(directory, header, body))


if __name__ == "__main__":
    unittest.main()
