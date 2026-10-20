"""Export inspected Qwen3-4B/8B last-four-layer MLX adapters; no base weights."""

import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path

from export import output_directory, validate_values

LAYERS = range(32, 36)
PROJECTIONS = {
    "self_attn.q_proj": ("attn_q", 2560, 4096),
    "self_attn.k_proj": ("attn_k", 2560, 1024),
    "self_attn.v_proj": ("attn_v", 2560, 1024),
    "self_attn.o_proj": ("attn_output", 4096, 2560),
    "mlp.gate_proj": ("ffn_gate", 2560, 9728),
    "mlp.up_proj": ("ffn_up", 2560, 9728),
    "mlp.down_proj": ("ffn_down", 9728, 2560),
}
PROJECTIONS_8B = {
    "self_attn.q_proj": ("attn_q", 4096, 4096),
    "self_attn.k_proj": ("attn_k", 4096, 1024),
    "self_attn.v_proj": ("attn_v", 4096, 1024),
    "self_attn.o_proj": ("attn_output", 4096, 4096),
    "mlp.gate_proj": ("ffn_gate", 4096, 12288),
    "mlp.up_proj": ("ffn_up", 4096, 12288),
    "mlp.down_proj": ("ffn_down", 12288, 4096),
}
PROFILE_PARAMETERS = {"4b": 1835008, "8b": 2424832}


def base_profile(base):
    """Select one inspected dimension tuple; never combine 4B and 8B fields."""
    if not isinstance(base, dict):
        raise ValueError("Expected a Qwen3 base configuration object")
    common = {"num_hidden_layers": 36, "head_dim": 128,
              "num_attention_heads": 32, "num_key_value_heads": 8}
    dimensions = (base.get("hidden_size"), base.get("intermediate_size"))
    profile = ({(2560, 9728): "4b", (4096, 12288): "8b"}.get(dimensions)
               if all(type(value) is int for value in dimensions) else None)
    if (base.get("model_type") != "qwen3" or base.get("architectures") != ["Qwen3ForCausalLM"]
            or profile is None or any(type(value) is not int for value in dimensions)
            or any(type(base.get(key)) is not int or base[key] != value for key, value in common.items())):
        raise ValueError("Expected an inspected 36-layer Qwen3-4B or Qwen3-8B configuration")
    if profile == "8b":
        exact = {"vocab_size": 151936, "max_position_embeddings": 40960,
                 "tie_word_embeddings": False, "attention_bias": False,
                 "use_sliding_window": False, "sliding_window": None,
                 "rope_scaling": None, "rope_theta": 1000000,
                 "rms_norm_eps": 1e-6, "hidden_act": "silu"}
        quantization = {"group_size": 64, "bits": 4}
        if (any(key not in base or type(base[key]) is not type(value) or base[key] != value
                for key, value in exact.items())
                or any(base.get(key) != quantization for key in ("quantization", "quantization_config"))
                or any(type(base[key][field]) is not int for key in ("quantization", "quantization_config")
                       for field in quantization)):
            raise ValueError("Expected the pinned affine4bit Qwen3-8B configuration")
    return profile


def adapter_metadata(base, config):
    """Accept only the inspected Qwen3 dimensions and frozen LoRA recipe."""
    base_profile(base)
    expected = {"fine_tune_type": "lora", "num_layers": 4,
                "lora_parameters": {"rank": 8, "scale": 16.0, "dropout": 0.0}}
    if (config != expected or type(config.get("num_layers")) is not int
            or type(config.get("lora_parameters", {}).get("rank")) is not int
            or any(type(config["lora_parameters"][key]) not in (int, float) for key in ("scale", "dropout"))):
        raise ValueError("Expected last-four-layer LoRA: rank=8, scale=16, dropout=0")
    # MLX scale=16 equals llama.cpp alpha/rank=128/8 at native adapter scale=1.
    return {"general.architecture": "qwen3", "general.type": "adapter",
            "adapter.type": "lora", "adapter.lora.alpha": 128.0}


def tensor_plan(shapes, profile="4b"):
    """Require all 56 exact MLX shapes and transpose A/B without Q/K permutation."""
    if profile not in PROFILE_PARAMETERS:
        raise ValueError("Unknown Qwen3 export profile")
    projections = PROJECTIONS if profile == "4b" else PROJECTIONS_8B
    expected, plan = {}, []
    for layer in LAYERS:
        for projection, (target, width, height) in projections.items():
            for side, shape in (("a", (width, 8)), ("b", (8, height))):
                source = f"model.layers.{layer}.{projection}.lora_{side}"
                expected[source] = shape
                plan.append((source, f"blk.{layer}.{target}.weight.lora_{side}", shape[::-1]))
    if (set(shapes) != set(expected)
            or any(not isinstance(shapes[name], (tuple, list)) or tuple(shapes[name]) != shape
                   or any(type(size) is not int for size in shapes[name])
                   for name, shape in expected.items())):
        raise ValueError("Expected exactly 56 rank-eight tensors with the fixed Qwen3 shapes")
    return plan


def validate_training_result(result, profile):
    """Bind the saved finite/changed result to this profile's exact parameter count."""
    required = {"finite": True, "adapter_tensors": 56, "changed_tensors": 56,
                "trainable_parameters": PROFILE_PARAMETERS[profile]}
    if any(type(result.get(key)) is not type(value) or result[key] != value for key, value in required.items()):
        raise ValueError("Expected a completed finite training result with 56 changed tensors and exact parameters")


def convert_matrices(matrices, profile="4b"):
    """Preserve finite F32 values and transpose A/B without rotary permutation."""
    import numpy as np
    plan = tensor_plan({name: tuple(value.shape) for name, value in matrices.items()}, profile)
    converted = {}
    for name, target, shape in plan:
        values = np.asarray(matrices[name])
        validate_values(str(values.dtype), bool(np.isfinite(values).all()))
        converted[target] = np.ascontiguousarray(values.T)
        if converted[target].shape != shape:
            raise ValueError(f"Unexpected transposed shape: {name}")
    return converted


def write_adapter(destination, metadata, converted, gguf):
    """Write only to a fresh external directory using the supplied GGUF writer."""
    destination = output_directory(destination)
    destination.mkdir(parents=True, exist_ok=False)
    output = destination / "adapter.gguf"
    writer = gguf.GGUFWriter(output, metadata["general.architecture"])
    try:
        writer.add_type(metadata["general.type"])
        writer.add_string("adapter.type", metadata["adapter.type"])
        writer.add_float32("adapter.lora.alpha", metadata["adapter.lora.alpha"])
        for name, values in converted.items():
            writer.add_tensor(name, values)
        writer.write_header_to_file()
        writer.write_kv_data_to_file()
        writer.write_tensors_to_file()
    finally:
        writer.close()
    return output


def verify_digest(actual, expected):
    """Reject absent or mismatched provenance hashes before accessing arrays."""
    if (not isinstance(expected, str) or len(expected) != 64
            or any(character not in "0123456789abcdef" for character in expected)
            or actual != expected):
        raise ValueError("SHA256 provenance mismatch")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-config", type=Path, required=True)
    parser.add_argument("--adapter", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    destination = output_directory(args.output)
    adapter, base_file = args.adapter.resolve(strict=True), args.base_config.resolve(strict=True)
    if any(root == destination or root in destination.parents for root in (adapter, base_file.parent)):
        raise ValueError("Output must be outside the input directories")
    inputs = {"base_config": base_file, "adapter_config": adapter / "adapter_config.json",
              "recipe": adapter / "recipe.json", "training_result": adapter / "training-result.json"}
    raw = {name: path.read_bytes() for name, path in inputs.items()}
    parsed = {name: json.loads(content) for name, content in raw.items()}
    metadata = adapter_metadata(parsed["base_config"], parsed["adapter_config"])
    profile = base_profile(parsed["base_config"])
    hashes = {name: hashlib.sha256(content).hexdigest() for name, content in raw.items()}
    verify_digest(hashes["base_config"], parsed["recipe"]["model_files"]["config.json"]["sha256"])
    result = parsed["training_result"]
    validate_training_result(result, profile)
    weights_file = adapter / "adapters.safetensors"
    if not weights_file.is_file() or not 0 < weights_file.stat().st_size <= 16 * 1024 * 1024:
        raise ValueError("Expected an adapter file no larger than 16 MiB")
    adapter_sha = hashlib.sha256(weights_file.read_bytes()).hexdigest()
    verify_digest(adapter_sha, result["adapter_sha256"])
    # Dependencies and adapter arrays are accessed only by explicit CLI execution.
    import mlx.core as mx
    import gguf
    if importlib.metadata.version("gguf") != "0.19.0":
        raise ValueError("This exporter requires gguf==0.19.0")
    matrices = mx.load(str(weights_file))
    converted = convert_matrices(matrices, profile)
    verify_digest(hashlib.sha256(weights_file.read_bytes()).hexdigest(), adapter_sha)
    output = write_adapter(destination, metadata, converted, gguf)
    receipt = {"metadata": metadata, "profile": profile, "parameters": PROFILE_PARAMETERS[profile],
               "tensors": len(converted), "dtype": "float32",
               "input_sha256": hashes, "adapter_sha256": adapter_sha,
               "exporter_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
               "gguf_version": "0.19.0", "gguf_sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
               "conversion_reference": "ggml-org/llama.cpp@9e3b928fd8c9d14dbf15a8768b9fdd7e5c721d66",
               "base_weights_identity_verified": False, "native_equivalence_verified": False,
               "production_adoption": False}
    with (destination / "export-result.json").open("x", encoding="utf-8") as handle:
        json.dump(receipt, handle, indent=2)
        handle.write("\n")
    print(json.dumps({"output": str(output), **receipt}))


if __name__ == "__main__":
    main()
