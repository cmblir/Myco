"""Export only the completed full123 Phi-4-mini last-four-layer MLX adapter."""

import argparse
import hashlib
import importlib.metadata
import json
import math
from pathlib import Path

from export import output_directory, validate_values
from export_qwen3 import verify_digest

LAYERS = range(28, 32)
PROJECTIONS = {
    "self_attn.qkv_proj": ("attn_qkv", 3072, 5120),
    "self_attn.o_proj": ("attn_output", 3072, 3072),
    "mlp.gate_up_proj": ("ffn_up", 3072, 16384),
    "mlp.down_proj": ("ffn_down", 8192, 3072),
}


def adapter_metadata(base, config):
    """Accept only the inspected Phi3 dimensions, partial RoPE, and fused recipe."""
    dimensions = {"num_hidden_layers": 32, "hidden_size": 3072, "intermediate_size": 8192,
                  "num_attention_heads": 24, "num_key_value_heads": 8,
                  "max_position_embeddings": 131072, "original_max_position_embeddings": 4096}
    if (base.get("model_type") != "phi3" or base.get("architectures") != ["Phi3ForCausalLM"]
            or any(type(base.get(key)) is not int or base[key] != value
                   for key, value in dimensions.items())
            or base.get("tie_word_embeddings") is not True
            or base.get("rope_traditional", False) is not False
            or any(type(base.get(key)) not in (int, float) or base[key] != value
                   for key, value in {"partial_rotary_factor": 0.75, "rope_theta": 10000.0}.items())):
        raise ValueError("Expected the inspected 32-layer Phi-4-mini partial-RoPE configuration")
    rotary = base.get("rope_scaling", {})
    if (not isinstance(rotary, dict) or rotary.get("type") != "longrope"
            or any(not isinstance(rotary.get(key), list) or len(rotary[key]) != 48
                   or any(type(value) not in (int, float) or not math.isfinite(value) or value <= 0
                          for value in rotary[key]) for key in ("short_factor", "long_factor"))):
        raise ValueError("Expected 48 positive finite LongRoPE factors for 96 rotary dimensions")
    expected = {"fine_tune_type": "lora", "num_layers": 4,
                "lora_parameters": {"rank": 8, "scale": 16.0, "dropout": 0.0,
                                    "keys": list(PROJECTIONS)}}
    if (config != expected or type(config.get("num_layers")) is not int
            or type(config.get("lora_parameters", {}).get("rank")) is not int
            or any(type(config["lora_parameters"][key]) not in (int, float) for key in ("scale", "dropout"))):
        raise ValueError("Expected last-four-layer fused LoRA: rank=8, scale=16, dropout=0")
    # MLX scale=16 equals llama.cpp alpha/rank=128/8 at native adapter scale=1.
    return {"general.architecture": "phi3", "general.type": "adapter",
            "adapter.type": "lora", "adapter.lora.alpha": 128.0}


def tensor_plan(shapes):
    """Require all 32 fused shapes; transpose A/B without splitting or permutation."""
    expected, plan = {}, []
    for layer in LAYERS:
        for projection, (target, width, height) in PROJECTIONS.items():
            for side, shape in (("a", (width, 8)), ("b", (8, height))):
                source = f"model.layers.{layer}.{projection}.lora_{side}"
                expected[source] = shape
                plan.append((source, f"blk.{layer}.{target}.weight.lora_{side}", shape[::-1]))
    if (set(shapes) != set(expected)
            or any(tuple(shapes[name]) != shape or any(type(size) is not int for size in shapes[name])
                   for name, shape in expected.items())):
        raise ValueError("Expected exactly 32 rank-eight tensors with the fixed fused Phi3 shapes")
    return plan


def validate_training_result(result, recipe):
    """Exclude incomplete or earlier feasibility artifacts from this conditional export."""
    if (any(type(recipe.get(key)) is not int or recipe[key] != value
            for key, value in {"iters": 123, "lora_layers": 4, "rank": 8}.items())
            or any(type(result.get(key)) is not int or result[key] != value
                   for key, value in {"iterations": 123, "adapter_tensors": 32, "changed_tensors": 32}.items())
            or result.get("finite") is not True
            or type(result.get("final_validation_loss")) not in (int, float)
            or not math.isfinite(result["final_validation_loss"]) or result["final_validation_loss"] < 0):
        raise ValueError("Expected completed finite full123 training with all 32 tensors changed")


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
    hashes = {name: hashlib.sha256(content).hexdigest() for name, content in raw.items()}
    verify_digest(hashes["base_config"], parsed["recipe"]["model_files"]["config.json"]["sha256"])
    result = parsed["training_result"]
    validate_training_result(result, parsed["recipe"])
    weights_file = adapter / "adapters.safetensors"
    if not weights_file.is_file() or not 0 < weights_file.stat().st_size <= 16 * 1024 * 1024:
        raise ValueError("Expected an adapter file no larger than 16 MiB")
    adapter_sha = hashlib.sha256(weights_file.read_bytes()).hexdigest()
    verify_digest(adapter_sha, result["adapter_sha256"])
    # Dependencies and real adapter arrays are accessed only by explicit CLI execution.
    import mlx.core as mx
    import numpy as np
    import gguf
    if importlib.metadata.version("gguf") != "0.19.0":
        raise ValueError("This exporter requires gguf==0.19.0")
    matrices = mx.load(str(weights_file))
    plan = tensor_plan({name: tuple(value.shape) for name, value in matrices.items()})
    converted = {}
    for name, target, shape in plan:
        values = np.asarray(matrices[name])
        validate_values(str(values.dtype), bool(np.isfinite(values).all()))
        # Preserve fused Q/K/V and gate-then-up row order from the inspected Phi3 sources.
        converted[target] = np.ascontiguousarray(values.T)
        if converted[target].shape != shape:
            raise ValueError(f"Unexpected transposed shape: {name}")
    verify_digest(hashlib.sha256(weights_file.read_bytes()).hexdigest(), adapter_sha)
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
    receipt = {"metadata": metadata, "tensors": len(converted), "dtype": "float32",
               "input_sha256": hashes, "adapter_sha256": adapter_sha,
               "exporter_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
               "helper_sha256": {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
                                 for name in ("export.py", "export_qwen3.py")},
               "gguf_version": "0.19.0", "gguf_sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
               "conversion_reference": "ggml-org/llama.cpp@9e3b928fd8c9d14dbf15a8768b9fdd7e5c721d66",
               "base_weights_identity_verified": False, "native_equivalence_verified": False,
               "semantic_acceptance": False, "production_adoption": False}
    with (destination / "export-result.json").open("x", encoding="utf-8") as handle:
        json.dump(receipt, handle, indent=2)
        handle.write("\n")
    print(json.dumps({"output": str(output), **receipt}))


if __name__ == "__main__":
    main()
