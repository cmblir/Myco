"""Repack supplied affine4/group64 rows into Q4_1 without changing codes or coefficients.

This primitive neither reads weights nor converts a model. Actual cached coefficient
ranges, full-model/tokenizer metadata and numerical/semantic native parity remain
unverified. Model export stays subject to the independent qualification gates.
"""

import math
import struct


def exact_half_bytes(value):
    """Reject coefficients that do not round-trip exactly through native FP16."""
    value = float(value)
    if not math.isfinite(value):
        raise ValueError("Q4_1 scale and bias must be finite")
    try:
        encoded = struct.pack("<e", value)
    except (OverflowError, struct.error) as error:
        raise ValueError("Q4_1 coefficient exceeds FP16 range") from error
    restored = struct.unpack("<e", encoded)[0]
    if restored != value or (value == 0 and math.copysign(1, restored) != math.copysign(1, value)):
        raise ValueError("Q4_1 coefficient is not exactly representable in FP16")
    return encoded


def repack_affine4_q4_1(codes, scales, biases):
    """Return little-endian Q4_1 bytes shaped (rows, width / 32 * 20).

    Inputs are two-dimensional little-endian U32 packed words and F32 scale/bias
    arrays. Each word contains eight codes, lowest nibble first; each coefficient
    pair covers 64 columns. Every bit is retained. Width must be a positive multiple
    of 64, with at least one row. Inputs are not modified. Scratch storage is bounded
    to one supplied row; the returned buffer covers only the supplied rows, so a
    caller must supply bounded row chunks rather than a whole model.

    MLX core quantize/dequantize specifies w = scale * code + bias. Pinned
    llama.cpp@9e3b928fd8c9d14dbf15a8768b9fdd7e5c721d66 ggml-common.h/Q4_1 and
    ggml-quants.c/dequantize_row_q4_1 specify two FP16 values and 16 nibble-pair
    bytes per 32 columns. This preserves that coefficient formula, not BF16
    dequantization rounding or any matmul/kernel output.
    """
    import numpy as np

    for name, values, dtype in (("codes", codes, "<u4"), ("scales", scales, "<f4"),
                                ("biases", biases, "<f4")):
        if not isinstance(values, np.ndarray) or values.ndim != 2 or values.dtype != np.dtype(dtype):
            raise ValueError(f"{name} must be a two-dimensional little-endian {dtype} array")
    rows, words = codes.shape
    if rows < 1 or words < 1 or words % 8:
        raise ValueError("Packed width must contain a positive multiple of eight U32 words (64 columns)")
    groups = words // 8
    if scales.shape != (rows, groups) or biases.shape != (rows, groups):
        raise ValueError("Scale and bias shapes must equal rows by width/64")
    packed = np.empty((rows, groups * 2, 20), dtype=np.uint8)
    shifts = np.arange(0, 32, 4, dtype=np.uint32)
    for row in range(rows):
        for group in range(groups):
            header = exact_half_bytes(scales[row, group]) + exact_half_bytes(biases[row, group])
            packed[row, 2 * group:2 * group + 2, :4] = np.frombuffer(header, dtype=np.uint8)
        nibbles = ((codes[row, :, None] >> shifts) & np.uint32(15)).astype(np.uint8)
        blocks = nibbles.reshape(groups * 2, 32)
        packed[row, :, 4:] = blocks[:, :16] | (blocks[:, 16:] << np.uint8(4))
    return packed.reshape(rows, groups * 40)
