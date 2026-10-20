"""Read pinned affine-model tensors in bounded row chunks, without model runtimes."""

import hashlib
import json
import math
import os
from pathlib import Path
import stat
import struct

ITEM_BYTES = {"U32": 4, "F32": 4, "BF16": 2, "F16": 2}
CHUNK_BYTES = 8 * 1024 * 1024


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate safetensors JSON key")
        result[key] = value
    return result


def _identity(value):
    return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)


class PinnedTensorRows:
    """Keep one verified file descriptor and read only caller-selected rows.

    The caller supplies a previously frozen size and SHA256. This reader checks
    file identity before and after hashing and each read. It validates the entire
    header/layout, but neither interprets model names nor loads a tokenizer.
    """

    def __init__(self, path, expected_bytes, expected_sha256):
        self.path = Path(path)
        self.fd = None
        if (not self.path.is_absolute() or self.path != self.path.resolve()
                or type(expected_bytes) is not int or expected_bytes <= 8
                or not isinstance(expected_sha256, str) or len(expected_sha256) != 64
                or any(char not in "0123456789abcdef" for char in expected_sha256)):
            raise ValueError("Require canonical absolute path, frozen size and SHA256")
        before = self.path.lstat()
        if not stat.S_ISREG(before.st_mode) or before.st_size != expected_bytes:
            raise ValueError("Expected a regular file with the frozen size")
        self.stamp = _identity(before)
        self.fd = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            self.verify_unchanged()
            digest = hashlib.sha256()
            offset = 0
            while offset < expected_bytes:
                block = os.pread(self.fd, min(CHUNK_BYTES, expected_bytes - offset), offset)
                if not block:
                    raise ValueError("Truncated pinned tensor file")
                digest.update(block)
                offset += len(block)
            self.verify_unchanged()
            if digest.hexdigest() != expected_sha256:
                raise ValueError("Pinned tensor SHA256 mismatch")
            self.sha256 = expected_sha256
            self._read_header(expected_bytes)
        except BaseException:
            self.close()
            raise

    def _read_header(self, file_bytes):
        prefix = os.pread(self.fd, 8, 0)
        if len(prefix) != 8:
            raise ValueError("Missing safetensors header length")
        header_bytes = struct.unpack("<Q", prefix)[0]
        if not 2 <= header_bytes <= CHUNK_BYTES or header_bytes + 8 >= file_bytes:
            raise ValueError("Invalid bounded safetensors header length")
        encoded = os.pread(self.fd, header_bytes, 8)
        if len(encoded) != header_bytes:
            raise ValueError("Truncated safetensors header")
        header = json.loads(encoded, object_pairs_hook=_unique_object)
        if not isinstance(header, dict) or not header:
            raise ValueError("Expected a safetensors header object")
        metadata = header.pop("__metadata__", {})
        if not isinstance(metadata, dict) or any(not isinstance(value, str) for value in metadata.values()):
            raise ValueError("Invalid safetensors string metadata")
        self.data_start = 8 + header_bytes
        intervals = []
        for name, descriptor in header.items():
            if (not name or not isinstance(descriptor, dict)
                    or set(descriptor) != {"dtype", "shape", "data_offsets"}
                    or descriptor["dtype"] not in ITEM_BYTES):
                raise ValueError("Unsupported tensor descriptor or dtype")
            shape, offsets = descriptor["shape"], descriptor["data_offsets"]
            if (not isinstance(shape, list) or len(shape) not in (1, 2)
                    or any(type(size) is not int or size <= 0 for size in shape)
                    or not isinstance(offsets, list) or len(offsets) != 2
                    or any(type(offset) is not int or offset < 0 for offset in offsets)
                    or offsets[1] - offsets[0] != math.prod(shape) * ITEM_BYTES[descriptor["dtype"]]):
                raise ValueError("Invalid tensor shape or byte bounds")
            intervals.append(tuple(offsets))
        position = 0
        for start, end in sorted(intervals):
            if start != position:
                raise ValueError("Tensor payload has a gap or overlap")
            position = end
        if not intervals or position != file_bytes - self.data_start:
            raise ValueError("Tensor payload length differs from the complete layout")
        self.header = header
        self.verify_unchanged()

    def verify_unchanged(self):
        """Reject descriptor/path replacement or content metadata changes."""
        if self.fd is None:
            raise ValueError("Tensor reader is closed")
        current = self.path.lstat()
        if (not stat.S_ISREG(current.st_mode)
                or _identity(current) != self.stamp
                or _identity(os.fstat(self.fd)) != self.stamp
                or self.path != self.path.resolve()):
            raise ValueError("Pinned tensor file changed")

    def read_rows(self, name, start, count):
        """Return U32 codes or exact F32 expansion of a bounded floating chunk.

        A vector is treated as scalar rows. A matrix keeps its original row/column
        orientation. BF16/F16 widening is exact; nonfinite floats are rejected.
        """
        self.verify_unchanged()
        descriptor = self.header[name]
        shape, dtype = descriptor["shape"], descriptor["dtype"]
        if (type(start) is not int or type(count) is not int
                or start < 0 or count <= 0 or start + count > shape[0]):
            raise ValueError("Requested tensor rows are outside the shape")
        width = shape[1] if len(shape) == 2 else 1
        byte_count = count * width * ITEM_BYTES[dtype]
        if byte_count > CHUNK_BYTES:
            raise ValueError("Requested tensor rows exceed the chunk bound")
        offset = self.data_start + descriptor["data_offsets"][0] + start * width * ITEM_BYTES[dtype]
        encoded = os.pread(self.fd, byte_count, offset)
        self.verify_unchanged()
        if len(encoded) != byte_count:
            raise ValueError("Truncated tensor row chunk")
        import numpy as np
        if dtype == "BF16":
            values = (np.frombuffer(encoded, dtype="<u2").astype("<u4") << 16).view("<f4")
        else:
            values = np.frombuffer(encoded, dtype={"U32": "<u4", "F32": "<f4", "F16": "<f2"}[dtype])
            if dtype == "F16":
                values = values.astype("<f4")
        if dtype != "U32" and not np.isfinite(values).all():
            raise ValueError("Tensor row chunk contains nonfinite values")
        return values.reshape((count, width) if len(shape) == 2 else (count,))

    def close(self):
        """Release the descriptor; returned chunks own their input bytes."""
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None

    def __enter__(self):
        return self

    def __exit__(self, *exception):
        self.close()
