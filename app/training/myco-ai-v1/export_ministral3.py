"""Export the inspected Ministral3-3B last-four-layer MLX LoRA without loading a model."""

import argparse
import hashlib
import importlib
import json
import math
from pathlib import Path
import struct
import sys

from export import output_directory, validate_values

LAYERS = range(22, 26)
PROJECTIONS = {
    "self_attn.q_proj": ("attn_q", 3072, 4096, 32),
    "self_attn.k_proj": ("attn_k", 3072, 1024, 8),
    "self_attn.v_proj": ("attn_v", 3072, 1024, None),
    "self_attn.o_proj": ("attn_output", 4096, 3072, None),
    "mlp.gate_proj": ("ffn_gate", 3072, 9216, None),
    "mlp.up_proj": ("ffn_up", 3072, 9216, None),
    "mlp.down_proj": ("ffn_down", 9216, 3072, None),
}
GGUF_SOURCE_SHA256 = {
    "pyproject.toml": "820c0fa41085815a60d5e4939a08b91af5eee95e9cabf7270f779f3b6acf9746",
    "gguf/__init__.py": "3ccfc0104cd7ea88c6028743b7bf3f2c89b5f474425de03a217a6072320d7c2f",
    "gguf/gguf_writer.py": "9b54bac930458d262f6a1d65877742c9476a11b04015cede05d325063af70dcb",
    "gguf/gguf_reader.py": "91cb9e81f1a67f5856f012cf3f526ad9ffdb6b887d2aa66e2593ee6f63764aad",
    "gguf/constants.py": "654c37f1c771737638c3632054422a08c094263d2d1d5cddeb3a44b9e7f7261d",
}


def digest(body):
    return hashlib.sha256(body).hexdigest()


def adapter_metadata(base, config):
    """Require the cached affine4bit wrapper, text dimensions, RoPE and fixed recipe."""
    if not isinstance(base, dict) or not isinstance(config, dict) or not isinstance(base.get("text_config"), dict):
        raise ValueError("Expected model and adapter configuration objects")
    dimensions = {"num_hidden_layers": 26, "hidden_size": 3072, "intermediate_size": 9216,
                  "head_dim": 128, "num_attention_heads": 32, "num_key_value_heads": 8,
                  "vocab_size": 131072, "max_position_embeddings": 262144}
    text = base.get("text_config", {})
    rope = {"rope_type": "yarn", "type": "yarn", "factor": 16.0,
            "original_max_position_embeddings": 16384, "rope_theta": 1000000.0,
            "beta_fast": 32.0, "beta_slow": 1.0, "mscale": 1.0,
            "mscale_all_dim": 1.0, "llama_4_scaling_beta": 0.1}
    quantization = {"group_size": 64, "bits": 4, "mode": "affine"}
    expected = {"fine_tune_type": "lora", "num_layers": 4,
                "lora_parameters": {"rank": 8, "scale": 16.0, "dropout": 0.0}}
    if (base.get("model_type") != "mistral3"
            or base.get("architectures") != ["Mistral3ForConditionalGeneration"]
            or text.get("model_type") != "ministral3"
            or any(type(text.get(key)) is not int or text[key] != value for key, value in dimensions.items())
            or text.get("tie_word_embeddings") is not True or text.get("sliding_window") is not None
            or text.get("layer_types", ["full_attention"] * 26) != ["full_attention"] * 26
            or text.get("rms_norm_eps") != 1e-5 or text.get("hidden_act") != "silu"
            or text.get("rope_parameters") != rope
            or any(type(text["rope_parameters"][key]) not in (int, float)
                   for key in rope if key not in {"rope_type", "type"})
            or any(base.get(key) != quantization for key in ("quantization", "quantization_config"))
            or any(type(base["quantization"][key]) is not int for key in ("group_size", "bits"))
            or any(type(base["quantization_config"][key]) is not int for key in ("group_size", "bits"))):
        raise ValueError("Expected the inspected affine4bit Mistral3 wrapper and Ministral3-3B text configuration")
    if (config != expected or type(config.get("num_layers")) is not int
            or type(config.get("lora_parameters", {}).get("rank")) is not int
            or any(type(config["lora_parameters"][key]) not in (int, float) for key in ("scale", "dropout"))):
        raise ValueError("Expected last-four-layer LoRA: rank=8, scale=16, dropout=0")
    # The nested text model is Ministral3; its actual GGUF architecture is MISTRAL3.
    return {"general.architecture": "mistral3", "general.type": "adapter",
            "adapter.type": "lora", "adapter.lora.alpha": 128.0}


def tensor_plan(shapes):
    """Require all 56 exact tensors and identify only Q/K B output permutations."""
    expected, plan = {}, []
    for layer in LAYERS:
        for projection, (target, width, height, heads) in PROJECTIONS.items():
            for side, shape in (("a", (width, 8)), ("b", (8, height))):
                source = f"language_model.model.layers.{layer}.{projection}.lora_{side}"
                expected[source] = shape
                plan.append((source, f"blk.{layer}.{target}.weight.lora_{side}",
                             shape[::-1], heads if side == "b" else None))
    if (set(shapes) != set(expected)
            or any(not isinstance(shapes[name], (tuple, list)) or tuple(shapes[name]) != shape
                   or any(type(size) is not int for size in shapes[name]) for name, shape in expected.items())):
        raise ValueError("Expected exactly 56 rank-eight tensors with the fixed Ministral3 shapes")
    return plan


def permute_rows(values, heads):
    """Match pinned conversion/llama.py LlamaModel.permute on Q/K output rows."""
    if (len(values.shape) != 2 or type(heads) is not int or heads < 1
            or values.shape[0] % (2 * heads) != 0):
        raise ValueError("Q/K rows must contain two equal rotary halves per head")
    return values.reshape(heads, 2, values.shape[0] // heads // 2,
                          values.shape[1]).swapaxes(1, 2).reshape(values.shape)


def convert_matrices(matrices):
    """Transpose MLX A/B, then permute only Q/K B; preserve finite F32 values."""
    import numpy as np
    plan = tensor_plan({name: tuple(value.shape) for name, value in matrices.items()})
    converted = {}
    for name, target, shape, heads in plan:
        values = np.asarray(matrices[name])
        validate_values(str(values.dtype), bool(np.isfinite(values).all()))
        values = values.T
        if heads is not None:
            values = permute_rows(values, heads)
        converted[target] = np.ascontiguousarray(values)
        if converted[target].shape != shape:
            raise ValueError("Unexpected transposed/permuted shape: " + name)
    return converted


def unique_object(pairs):
    parsed = dict(pairs)
    if len(parsed) != len(pairs):
        raise ValueError("Duplicate JSON key")
    return parsed


def adapter_header(body):
    """Validate exact F32 safetensors layout before importing array dependencies."""
    if not 8 < len(body) <= 16 * 1024 * 1024:
        raise ValueError("Expected an adapter file no larger than 16 MiB")
    length = struct.unpack("<Q", body[:8])[0]
    if not 0 < length <= 1024 * 1024 or length + 8 >= len(body):
        raise ValueError("Invalid adapter header length")
    header = json.loads(body[8:8 + length], object_pairs_hook=unique_object)
    if not isinstance(header, dict):
        raise ValueError("Expected an adapter tensor header")
    header.pop("__metadata__", None)
    tensor_plan({name: item.get("shape") if isinstance(item, dict) else None for name, item in header.items()})
    ranges = []
    for name, item in header.items():
        offsets = item.get("data_offsets")
        if (set(item) != {"dtype", "shape", "data_offsets"} or item["dtype"] != "F32"
                or not isinstance(offsets, list) or len(offsets) != 2
                or any(type(value) is not int for value in offsets)
                or not 0 <= offsets[0] < offsets[1] <= len(body) - 8 - length
                or offsets[1] - offsets[0] != math.prod(item["shape"]) * 4):
            raise ValueError("Invalid F32 adapter tensor layout: " + name)
        ranges.append(tuple(offsets))
    ranges.sort()
    if (ranges[0][0] != 0 or ranges[-1][1] != len(body) - 8 - length
            or any(left[1] != right[0] for left, right in zip(ranges, ranges[1:]))):
        raise ValueError("Adapter payload must be contiguous without gaps, overlaps or extra bytes")
    return header, 8 + length


def load_gguf(directory):
    """Use the inspected vendored writer bytes, not another same-version installation."""
    directory = Path(directory).resolve(strict=True)
    for name, expected in GGUF_SOURCE_SHA256.items():
        if digest((directory / name).read_bytes()) != expected:
            raise ValueError("Pinned gguf source SHA256 mismatch: " + name)
    package = directory / "gguf" / "__init__.py"
    if "gguf" in sys.modules and Path(sys.modules["gguf"].__file__).resolve() != package:
        raise ValueError("Another gguf package is already imported")
    sys.path.insert(0, str(directory))
    gguf = importlib.import_module("gguf")
    if (Path(gguf.__file__).resolve() != package
            or Path(sys.modules[gguf.GGUFWriter.__module__].__file__).resolve()
            != directory / "gguf" / "gguf_writer.py"):
        raise ValueError("Imported gguf is not the pinned vendored source")
    return gguf


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--adapter", type=Path, required=True)
    parser.add_argument("--model", type=Path, required=True, help="Original cached MLX model directory; only config.json is read")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--gguf-py", type=Path, required=True, help="Pinned llama.cpp gguf-py directory")
    args = parser.parse_args()
    destination = output_directory(args.output)
    adapter, model = args.adapter.resolve(strict=True), args.model.resolve(strict=True)
    if any(root == destination or root in destination.parents for root in (adapter, model)):
        raise ValueError("Output must be outside the adapter and model directories")
    paths = {"base_config": model / "config.json", "adapter_config": adapter / "adapter_config.json",
             "recipe": adapter / "recipe.json", "training_result": adapter / "training-result.json",
             "adapter": adapter / "adapters.safetensors"}
    if not paths["adapter"].is_file() or not 0 < paths["adapter"].stat().st_size <= 16 * 1024 * 1024:
        raise ValueError("Expected an adapter file no larger than 16 MiB")
    raw = {name: path.read_bytes() for name, path in paths.items()}
    parsed = {name: json.loads(body, object_pairs_hook=unique_object)
              for name, body in raw.items() if name != "adapter"}
    hashes = {name: digest(body) for name, body in raw.items()}
    metadata = adapter_metadata(parsed["base_config"], parsed["adapter_config"])
    recipe, result = parsed["recipe"], parsed["training_result"]
    if (recipe.get("model") != str(model) or hashes["base_config"] != recipe["model_files"]["config.json"]["sha256"]
            or hashes["adapter"] != result.get("adapter_sha256")):
        raise ValueError("Base configuration or saved adapter SHA256 provenance mismatch")
    required = {"iterations": 540, "trainable_parameters": 1900544, "adapter_tensors": 56,
                "changed_tensors": 56, "finite": True}
    if (any(type(result.get(key)) is not type(value) or result[key] != value for key, value in required.items())
            or any(type(recipe.get(key)) is not int or recipe[key] != value
                   for key, value in {"iters": 540, "lora_layers": 4, "rank": 8}.items())
            or type(result.get("final_validation_loss")) not in (int, float)
            or not math.isfinite(result["final_validation_loss"])):
        raise ValueError("Expected completed540 training with 56 finite, changed tensors")
    header, start = adapter_header(raw["adapter"])
    # Only adapter arrays are accessed. No MLX, Torch, model or tokenizer is imported.
    import numpy as np
    matrices = {name: np.frombuffer(raw["adapter"], dtype="<f4", count=math.prod(item["shape"]),
                offset=start + item["data_offsets"][0]).reshape(item["shape"]) for name, item in header.items()}
    converted = convert_matrices(matrices)
    gguf = load_gguf(args.gguf_py)
    if any(digest(path.read_bytes()) != hashes[name] for name, path in paths.items()):
        raise ValueError("Export inputs changed during conversion")
    destination.mkdir(parents=True, exist_ok=False)
    output = destination / "adapter.gguf"
    writer = gguf.GGUFWriter(output, metadata["general.architecture"])
    try:
        writer.add_type(gguf.GGUFType.ADAPTER)
        writer.add_string("adapter.type", "lora")
        writer.add_float32("adapter.lora.alpha", 128.0)
        for name, values in converted.items():
            writer.add_tensor(name, values, tensor_endianess=gguf.GGUFEndian.LITTLE)
        writer.write_header_to_file()
        writer.write_kv_data_to_file()
        writer.write_tensors_to_file()
    finally:
        writer.close()
    if any(digest(path.read_bytes()) != hashes[name] for name, path in paths.items()):
        raise ValueError("Export inputs changed while writing GGUF")
    receipt = {"metadata": metadata, "tensors": len(converted), "parameters": 1900544, "dtype": "float32",
               "input_sha256": hashes, "model": str(model), "adapter": str(adapter),
               "exporter_sha256": digest(Path(__file__).read_bytes()), "gguf_sha256": digest(output.read_bytes()),
               "gguf_py": str(args.gguf_py.resolve()), "gguf_version": "0.19.0", "gguf_source_sha256": GGUF_SOURCE_SHA256,
               "conversion_reference": "ggml-org/llama.cpp@9e3b928fd8c9d14dbf15a8768b9fdd7e5c721d66",
               "layout": "MLX A/B transposed; only q32/k8 B output rows permuted once by LlamaModel.permute",
               "required_native_adapter_scale": 1.0, "base_weights_exported": False,
               "base_weights_identity_verified": False, "native_equivalence_verified": False,
               "semantic_acceptance": False, "production_adoption": False}
    with (destination / "export-result.json").open("x", encoding="utf-8") as handle:
        json.dump(receipt, handle, indent=2)
        handle.write("\n")
    print(json.dumps({"output": str(output), **receipt}))


if __name__ == "__main__":
    main()
