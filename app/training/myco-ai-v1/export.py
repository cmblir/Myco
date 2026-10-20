"""Export only this pilot's final-layer MLX LoRA to a new external GGUF directory."""

import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
PREFIX = "language_model.model.layers.31."
PROJECTIONS = {
    "self_attn.q_proj": "attn_q", "self_attn.k_proj": "attn_k",
    "self_attn.v_proj": "attn_v", "self_attn.o_proj": "attn_output",
    "mlp.gate_proj": "ffn_gate", "mlp.up_proj": "ffn_up", "mlp.down_proj": "ffn_down",
}


def adapter_metadata(config):
    """Reject configurations outside the frozen rank-eight pilot."""
    expected = {"fine_tune_type": "lora", "num_layers": 1,
                "lora_parameters": {"rank": 8, "scale": 16.0, "dropout": 0.0}}
    if (config != expected or type(config.get("num_layers")) is not int
            or type(config.get("lora_parameters", {}).get("rank")) is not int):
        raise ValueError("Expected fresh last-layer LoRA: num_layers=1, rank=8, scale=16, dropout=0")
    # MLX multiplies by scale directly; llama.cpp multiplies by alpha / rank.
    return {"general.architecture": "qwen35", "general.type": "adapter",
            "adapter.type": "lora", "adapter.lora.alpha": 128.0}


def tensor_plan(shapes):
    """Check all fourteen matrices and preserve the complete joint Q/gate output."""
    expected = {PREFIX + projection + ".lora_" + side
                for projection in PROJECTIONS for side in ("a", "b")}
    if set(shapes) != expected:
        raise ValueError("Expected exactly seven layer-31 A/B pairs; unknown or missing tensors")
    dimensions, plan = {}, []
    for projection, target in PROJECTIONS.items():
        pairs = [shapes[PREFIX + projection + ".lora_" + side] for side in ("a", "b")]
        if any(len(shape) != 2 or any(type(size) is not int or size <= 0 for size in shape)
               for shape in pairs):
            raise ValueError("LoRA matrices must have two positive integer dimensions")
        first, second = pairs
        if first[1] != 8 or second[0] != 8:
            raise ValueError("Every LoRA pair must have rank eight in MLX orientation")
        dimensions[projection] = (first[0], second[1])
        for side, shape in zip(("a", "b"), pairs):
            plan.append((PREFIX + projection + ".lora_" + side,
                         f"blk.31.{target}.weight.lora_{side}", (shape[1], shape[0])))
    hidden = dimensions["self_attn.q_proj"][0]
    attention = dimensions["self_attn.o_proj"][0]
    feed_forward = dimensions["mlp.down_proj"][0]
    expected_dimensions = {
        "self_attn.q_proj": (hidden, attention * 2),
        "self_attn.k_proj": (hidden, dimensions["self_attn.v_proj"][1]),
        "self_attn.v_proj": (hidden, dimensions["self_attn.k_proj"][1]),
        "self_attn.o_proj": (attention, hidden),
        "mlp.gate_proj": (hidden, feed_forward), "mlp.up_proj": (hidden, feed_forward),
        "mlp.down_proj": (feed_forward, hidden),
    }
    if dimensions != expected_dimensions:
        raise ValueError("Inconsistent projection shapes or incomplete joint Q/gate output")
    return plan


def validate_values(dtype, is_finite):
    """Preserve F32 adapter values; refuse narrowing or invalid floating point."""
    if dtype != "float32" or is_finite is not True:
        raise ValueError("All adapter values must be finite float32")


def output_directory(requested):
    """Require a new absolute directory outside the checkout and resolved aliases."""
    requested = Path(requested)
    if not requested.is_absolute():
        raise ValueError("Output must be an absolute external directory")
    destination = requested.resolve()
    if destination == REPO or REPO in destination.parents:
        raise ValueError("Output must be outside the repository")
    if requested.exists() or requested.is_symlink() or destination.exists():
        raise FileExistsError("Output already exists; refusing overwrite")
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--adapter", type=Path, required=True, help="Pilot adapter directory")
    parser.add_argument("--output", type=Path, required=True, help="New absolute external directory")
    args = parser.parse_args()
    destination = output_directory(args.output)
    adapter = args.adapter.resolve(strict=True)
    config_file, weights_file = adapter / "adapter_config.json", adapter / "adapters.safetensors"
    metadata = adapter_metadata(json.loads(config_file.read_text(encoding="utf-8")))
    if not weights_file.is_file() or weights_file.stat().st_size > 16 * 1024 * 1024:
        raise ValueError("Expected a pilot adapters.safetensors file no larger than 16 MiB")
    # Heavy dependencies and adapter bytes are accessed only by explicit CLI execution.
    import mlx.core as mx
    import numpy as np
    import gguf
    matrices = mx.load(str(weights_file))
    plan = tensor_plan({name: tuple(value.shape) for name, value in matrices.items()})
    converted = {}
    for name, target, shape in plan:
        values = np.asarray(matrices[name])
        validate_values(str(values.dtype), bool(np.isfinite(values).all()))
        converted[target] = np.ascontiguousarray(values.T)
        if converted[target].shape != shape:
            raise ValueError(f"Unexpected transposed shape: {name}")
    # A fresh directory prevents GGUFWriter's internal wb open from overwriting a file.
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
               "adapter_sha256": hashlib.sha256(weights_file.read_bytes()).hexdigest(),
               "config_sha256": hashlib.sha256(config_file.read_bytes()).hexdigest(),
               "exporter_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
               "gguf_version": importlib.metadata.version("gguf"),
               "gguf_sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
               "native_equivalence_verified": False, "production_adoption": False}
    with (destination / "export-result.json").open("x", encoding="utf-8") as handle:
        json.dump(receipt, handle, indent=2)
        handle.write("\n")
    print(json.dumps({"output": str(output), **receipt}))


if __name__ == "__main__":
    main()
