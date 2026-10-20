"""Plan the inspected affine4/group64 Qwen3-8B tensors without opening weights.

Source contract: installed mlx_lm/models/qwen3.py and mlx/nn/layers/quantized.py;
MLX core/__init__.pyi documents row-wise U32 packing and input-typed coefficients.
Target contract: llama.cpp@9e3b928fd8c9d14dbf15a8768b9fdd7e5c721d66
conversion/{qwen,base}.py, gguf/{tensor_mapping,constants,gguf_writer}.py and
src/models/qwen3.cpp. Qwen3 uses NEOX RoPE and no Q/K weight permutation.

This is metadata validation, not an exporter or qualification. Actual cache
headers, finite norm values, coefficient ranges, tokenizer metadata, provenance,
bounded file access and native equivalence must be checked after qualification.
Every affine coefficient must pass affine4_q4_1.exact_half_bytes before writing;
accepting BF16/F16/F32 metadata does not establish exact FP16 representability
or preserve MLX dequantization/matmul rounding.
"""

from dataclasses import dataclass

from export_qwen3 import PROJECTIONS_8B, base_profile

FLOAT_DTYPES = frozenset(("BF16", "F16", "F32"))


@dataclass(frozen=True)
class BaseTensorPlan:
    """One output tensor; source_names orders packed weight, scales, biases."""

    source_names: tuple[str, ...]
    source_dtypes: tuple[str, ...]
    target_name: str
    logical_shape: tuple[int, ...]
    storage_shape: tuple[int, ...]
    ggml_shape: tuple[int, ...]
    ggml_type: str
    requires_exact_fp16_coefficients: bool
    transpose: bool = False
    qk_permutation: bool = False


def _tensor_specs():
    yield "model.embed_tokens", "token_embd", (151936, 4096)
    yield "lm_head", "output", (151936, 4096)
    yield "model.norm", "output_norm", (4096,)
    for layer in range(36):
        for source, (target, width, height) in PROJECTIONS_8B.items():
            yield f"model.layers.{layer}.{source}", f"blk.{layer}.{target}", (height, width)
        for source, target, width in (
            ("input_layernorm", "attn_norm", 4096),
            ("post_attention_layernorm", "ffn_norm", 4096),
            ("self_attn.q_norm", "attn_q_norm", 128),
            ("self_attn.k_norm", "attn_k_norm", 128),
        ):
            yield f"model.layers.{layer}.{source}", f"blk.{layer}.{target}", (width,)


def base_tensor_plan(config, tensors):
    """Require all 907 descriptors and return 399 Q4_1/F32 output plans.

    ``tensors`` maps names to shape/dtype descriptors, optionally with
    ``data_offsets`` already verified by the bounded reader. No offsets or
    tensor values are inspected here. Coefficient dtype may vary between
    matrices but scales and biases of each matrix must agree. Norms become
    finite F32 without arithmetic changes. All shapes are row-major except
    ``ggml_shape``, whose reversed dimensions describe the file header, not a
    transpose. Q4_1 ``storage_shape`` describes U8 bytes (32 values per 20-byte
    block); F32 ``storage_shape`` describes F32 elements.
    """
    if base_profile(config) != "8b":
        raise ValueError("Base tensor planning requires the inspected Qwen3-8B profile")
    if config.get("rope_parameters") not in (None, {}):
        raise ValueError("Expected unscaled Qwen3 NEOX RoPE without rope_parameters overrides")
    expected, specs = {}, list(_tensor_specs())
    for source, _, shape in specs:
        if len(shape) == 2:
            rows, width = shape
            for suffix, divisor, dtypes in (
                ("weight", 8, ("U32",)), ("scales", 64, FLOAT_DTYPES),
                ("biases", 64, FLOAT_DTYPES),
            ):
                expected[f"{source}.{suffix}"] = ((rows, width // divisor), dtypes)
        else:
            expected[f"{source}.weight"] = (shape, FLOAT_DTYPES)
    if not isinstance(tensors, dict) or set(tensors) != set(expected):
        raise ValueError("Expected exactly 907 Qwen3-8B tensors; missing or unknown names")
    for name, (shape, dtypes) in expected.items():
        descriptor = tensors[name]
        if (not isinstance(descriptor, dict)
                or not {"shape", "dtype"} <= set(descriptor) <= {"shape", "dtype", "data_offsets"}
                or not isinstance(descriptor["shape"], (tuple, list))
                or any(type(size) is not int for size in descriptor["shape"])
                or tuple(descriptor["shape"]) != shape
                or not isinstance(descriptor["dtype"], str) or descriptor["dtype"] not in dtypes):
            raise ValueError(f"Unexpected Qwen3-8B shape/dtype descriptor: {name}")
    plan = []
    for source, target, shape in specs:
        quantized = len(shape) == 2
        names = tuple(f"{source}.{suffix}" for suffix in
                      (("weight", "scales", "biases") if quantized else ("weight",)))
        dtypes = tuple(tensors[name]["dtype"] for name in names)
        if quantized and dtypes[1] != dtypes[2]:
            raise ValueError(f"Affine scales/biases must have matching dtypes: {source}")
        storage = (shape[0], shape[1] // 32 * 20) if quantized else shape
        plan.append(BaseTensorPlan(
            source_names=names, source_dtypes=dtypes, target_name=f"{target}.weight",
            logical_shape=shape, storage_shape=storage, ggml_shape=shape[::-1],
            ggml_type="Q4_1" if quantized else "F32",
            requires_exact_fp16_coefficients=quantized,
        ))
    return tuple(plan)
