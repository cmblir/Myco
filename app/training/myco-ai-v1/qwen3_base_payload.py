"""Write planned tensors with bounded row buffers and one disk-backed tensor."""

import hashlib
import math
import mmap
from pathlib import Path
import tempfile

from affine4_q4_1 import repack_affine4_q4_1


def write_base_payload(path, plans, reader, configure_metadata, gguf, row_chunk=128):
    """Write one new GGUF file using an already validated complete tensor plan.

    The caller owns configuration/provenance and semantic qualification. Only
    supplied rows are accessed. GGUFWriter requires a complete ndarray per tensor,
    so each tensor is backed by a temporary file, never a full in-memory model.
    Returned hashes cover the exact emitted tensor bytes in row-major order.
    """
    import numpy as np

    path = Path(path)
    if not path.is_absolute() or path != path.resolve() or path.exists():
        raise ValueError("GGUF payload output must be a new canonical absolute path")
    if type(row_chunk) is not int or not 1 <= row_chunk <= 256:
        raise ValueError("Row chunk must be an integer between one and 256")
    plans = tuple(plans)
    if not plans or len({entry.target_name for entry in plans}) != len(plans):
        raise ValueError("Expected unique nonempty output tensor plans")
    for entry in plans:
        if (entry.ggml_type not in ("Q4_1", "F32") or entry.transpose or entry.qk_permutation
                or tuple(entry.logical_shape[::-1]) != entry.ggml_shape):
            raise ValueError("Unsupported tensor conversion plan")
        quantized = entry.ggml_type == "Q4_1"
        if (len(entry.source_names) != (3 if quantized else 1)
                or len(entry.logical_shape) != (2 if quantized else 1)
                or any(type(size) is not int or size <= 0 for size in entry.logical_shape)):
            raise ValueError("Invalid source count or logical shape")
        if quantized:
            rows, width = entry.logical_shape
            if width % 64 or entry.storage_shape != (rows, width // 32 * 20):
                raise ValueError("Invalid affine4 storage shape")
        elif entry.storage_shape != entry.logical_shape:
            raise ValueError("Invalid F32 storage shape")

    # The production caller provides a new private output directory.
    with path.open("xb"):
        pass
    writer = gguf.GGUFWriter(path, "qwen3", endianess=gguf.GGUFEndian.LITTLE)
    emitted = []
    try:
        configure_metadata(writer)
        for entry in plans:
            dtype = np.dtype("uint8" if entry.ggml_type == "Q4_1" else "<f4")
            writer.add_tensor_info(
                entry.target_name, entry.storage_shape, dtype,
                math.prod(entry.storage_shape) * dtype.itemsize,
                raw_dtype=getattr(gguf.GGMLQuantizationType, entry.ggml_type),
            )
        writer.write_header_to_file()
        writer.write_kv_data_to_file()
        writer.write_ti_data_to_file()
        for entry in plans:
            dtype = np.dtype("uint8" if entry.ggml_type == "Q4_1" else "<f4")
            byte_count = math.prod(entry.storage_shape) * dtype.itemsize
            digest = hashlib.sha256()
            with tempfile.TemporaryFile(dir=path.parent, prefix=".tensor-") as scratch:
                scratch.truncate(byte_count)
                with mmap.mmap(scratch.fileno(), byte_count, access=mmap.ACCESS_WRITE) as mapping:
                    values = np.ndarray(entry.storage_shape, dtype=dtype, buffer=mapping)
                    try:
                        for start in range(0, entry.logical_shape[0], row_chunk):
                            count = min(row_chunk, entry.logical_shape[0] - start)
                            chunks = [reader.read_rows(name, start, count) for name in entry.source_names]
                            if entry.ggml_type == "Q4_1":
                                width = entry.logical_shape[1]
                                if [chunk.shape for chunk in chunks] != [
                                    (count, width // 8), (count, width // 64), (count, width // 64)
                                ]:
                                    raise ValueError("Source chunks differ from the planned matrix")
                                packed = repack_affine4_q4_1(*chunks)
                            else:
                                packed = chunks[0]
                                if packed.shape != (count,) or packed.dtype != dtype or not np.isfinite(packed).all():
                                    raise ValueError("Expected a finite F32 norm chunk")
                            values[start:start + count] = packed
                            digest.update(packed.tobytes(order="C"))
                        reader.verify_unchanged()
                        writer.write_tensor_data(values, tensor_endianess=gguf.GGUFEndian.LITTLE)
                    finally:
                        del values
            emitted.append({
                "name": entry.target_name, "ggmlType": entry.ggml_type,
                "ggmlShape": list(entry.ggml_shape), "bytes": byte_count,
                "sha256": digest.hexdigest(),
            })
        reader.verify_unchanged()
    finally:
        writer.close()
    return emitted


def verify_base_payload(path, expected, gguf, row_chunk=128):
    """Read every emitted byte back in bounded slices, without loading a model."""
    import numpy as np

    if type(row_chunk) is not int or not 1 <= row_chunk <= 256:
        raise ValueError("Invalid verification chunk size")
    reader = gguf.GGUFReader(path, mode="r")
    if len(reader.tensors) != len(expected):
        raise ValueError("GGUF tensor count differs from the emitted plan")
    for tensor, entry in zip(reader.tensors, expected):
        if (tensor.name != entry["name"] or tensor.shape.tolist() != entry["ggmlShape"]
                or tensor.tensor_type != getattr(gguf.GGMLQuantizationType, entry["ggmlType"])
                or tensor.n_bytes != entry["bytes"]):
            raise ValueError("GGUF tensor identity differs from the emitted plan")
        digest = hashlib.sha256()
        if entry["ggmlType"] == "F32" and not np.isfinite(tensor.data).all():
            raise ValueError("Nonfinite GGUF norm")
        for start in range(0, tensor.data.shape[0], row_chunk):
            digest.update(tensor.data[start:start + row_chunk].tobytes(order="C"))
        if digest.hexdigest() != entry["sha256"]:
            raise ValueError("GGUF tensor bytes differ from the converted rows")
