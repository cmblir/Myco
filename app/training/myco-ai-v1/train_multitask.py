"""Train a local multitask LoRA candidate with source-masked, padding-free loss."""

import argparse
import importlib.metadata
import json
import math
import os
from pathlib import Path
import time

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"

from compare import fresh_output, model_fingerprint
from run import digest, read_rows, response_loss, tokenize, write_json


def adapter_configuration(model_type, layer_count, selected_layers, rank):
    """Limit this recipe to inspected standard-attention implementations."""
    if model_type not in {"qwen3", "ministral3", "mistral3", "phi3", "gemma4"}:
        raise ValueError(f"Unqualified training architecture: {model_type}")
    if not 1 <= selected_layers <= layer_count or rank < 1:
        raise ValueError("LoRA layer count and rank must be positive and within the model")
    parameters = {"rank": rank, "scale": 16.0, "dropout": 0.0}
    if model_type == "phi3":
        if layer_count != 32:
            raise ValueError("Only the inspected 32-layer Phi-4-mini recipe is supported")
        parameters["keys"] = ["self_attn.qkv_proj", "self_attn.o_proj",
                              "mlp.gate_up_proj", "mlp.down_proj"]
    elif model_type == "gemma4":
        if layer_count != 35:
            raise ValueError("Only the inspected 35-layer Gemma-4 E2B recipe is supported")
        parameters["keys"] = ["self_attn.q_proj", "self_attn.o_proj",
                              "mlp.gate_proj", "mlp.up_proj", "mlp.down_proj"]
    return {"fine_tune_type": "lora", "num_layers": selected_layers,
            "lora_parameters": parameters}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--iters", type=int, required=True)
    parser.add_argument("--lora-layers", type=int, default=4)
    parser.add_argument("--rank", type=int, default=8)
    parser.add_argument("--learning-rate", type=float, default=1e-5)
    parser.add_argument("--max-seq-length", type=int, default=4096)
    parser.add_argument("--eval-interval", type=int, default=32)
    parser.add_argument("--save-interval", type=int, default=32)
    args = parser.parse_args()
    if (min(args.iters, args.lora_layers, args.rank, args.max_seq_length, args.eval_interval, args.save_interval) < 1
            or not math.isfinite(args.learning_rate) or args.learning_rate <= 0):
        parser.error("Iteration, layer, rank, length and learning-rate values must be positive and finite")
    model_path = args.model.resolve(strict=True)
    data_path = args.data.resolve(strict=True)
    manifest = json.loads((data_path / "manifest.json").read_text())
    rows = {split: read_rows(data_path / f"{split}.jsonl") for split in ("train", "valid")}
    from multitask_v2 import validate_dataset
    if manifest.get("synthetic_only") is not True or any(not split for split in rows.values()):
        raise ValueError("This recipe requires nonempty, synthetic-only train and validation splits")
    validate_dataset(rows, manifest["splits"])
    for split in rows:
        if digest(data_path / f"{split}.jsonl") != manifest["sha256"][f"{split}.jsonl"]:
            raise ValueError(f"Dataset digest mismatch: {split}")
    output = fresh_output(args.output)
    started = time.perf_counter()
    from mlx_lm.utils import load_tokenizer
    tokenizer = load_tokenizer(model_path, {"trust_remote_code": False})
    encoded = {split: tokenize(samples, tokenizer, args.max_seq_length) for split, samples in rows.items()}
    token_counts = {split: {"samples": len(samples), "max_tokens": max(len(tokens) for tokens, _ in samples),
                            "total_tokens": sum(len(tokens) for tokens, _ in samples),
                            "supervised_tokens": sum(len(tokens) - offset for tokens, offset in samples)}
                    for split, samples in encoded.items()}
    write_json(output / "recipe.json", {
        "model": str(model_path), "token_counts": token_counts,
        "model_files": model_fingerprint(model_path),
        "iters": args.iters, "lora_layers": args.lora_layers, "rank": args.rank,
        "learning_rate": args.learning_rate, "optimizer": "mlx.optimizers.Adam",
        "seed": 42, "batch_size": 1, "gradient_checkpointing": True,
        "max_seq_length": args.max_seq_length, "eval_interval": args.eval_interval,
        "save_interval": args.save_interval,
        "validation_batches": "all", "prompt_masked": True, "padding_supervised": False,
        "mlx_lm": importlib.metadata.version("mlx-lm"), "mlx": importlib.metadata.version("mlx"),
        "manifest_sha256": digest(data_path / "manifest.json"),
        "data_sha256": {split: digest(data_path / f"{split}.jsonl") for split in rows},
        "source_sha256": {path.name: digest(path) for path in (
            Path(__file__), Path(__file__).with_name("multitask_v2.py"),
            Path(__file__).with_name("compare.py"), Path(__file__).with_name("run.py"))},
        "production_adoption": False,
    })
    print(json.dumps({"event": "training_inputs_frozen", "token_counts": token_counts}), flush=True)
    import mlx.core as mx
    import mlx.optimizers as optim
    import numpy as np
    from mlx.utils import tree_flatten
    from mlx_lm import load
    from mlx_lm.tuner.callbacks import TrainingCallback
    from mlx_lm.tuner.trainer import TrainingArgs, evaluate, train
    from mlx_lm.tuner.utils import linear_to_lora_layers
    mx.set_memory_limit(8 * 1024 ** 3)
    mx.set_cache_limit(256 * 1024 ** 2)
    mx.random.seed(42)
    np.random.seed(42)
    model, _ = load(str(model_path), tokenizer_config={"trust_remote_code": False}, trust_remote_code=False)
    config = adapter_configuration(model.model_type, len(model.layers), args.lora_layers, args.rank)
    write_json(output / "adapter_config.json", config)
    model.freeze()
    linear_to_lora_layers(model, config["num_layers"], config["lora_parameters"])
    initial = {name: mx.array(value) for name, value in tree_flatten(model.trainable_parameters())}
    mx.eval(initial)
    trainable_count = sum(value.size for value in initial.values())

    def frozen_prefix_loss(current_model, batch, lengths):
        for layer in current_model.layers[:-args.lora_layers]:
            layer.eval()
        return response_loss(current_model, batch, lengths)

    with (output / "metrics.jsonl").open("x", encoding="utf-8") as handle:
        class Recorder(TrainingCallback):
            def record(self, kind, values):
                if any(isinstance(value, float) and not math.isfinite(value) for value in values.values()):
                    raise ValueError("Non-finite training metric")
                record = {"kind": kind, "seconds": time.perf_counter() - started, **values}
                handle.write(json.dumps(record) + "\n")
                handle.flush()
                print(json.dumps(record), flush=True)

            def on_train_loss_report(self, values):
                self.record("train", values)

            def on_val_loss_report(self, values):
                self.record("valid", values)

        train(model, optim.Adam(learning_rate=args.learning_rate), encoded["train"], encoded["valid"],
              loss=frozen_prefix_loss, training_callback=Recorder(),
              args=TrainingArgs(batch_size=1, iters=args.iters, val_batches=-1,
                                steps_per_report=1, steps_per_eval=args.eval_interval,
                                steps_per_save=args.save_interval, max_seq_length=args.max_seq_length,
                                adapter_file=str(output / "adapters.safetensors"),
                                grad_checkpoint=True, clear_cache_threshold=256 * 1024 ** 2))
    saved = mx.load(str(output / "adapters.safetensors"))
    if set(saved) != set(initial):
        raise ValueError("Saved adapter tensors differ from trained parameter names")
    finite = all(bool(mx.all(mx.isfinite(value)).item()) for value in saved.values())
    changed = sum(bool(mx.any(value != initial[name]).item()) for name, value in saved.items())
    if not finite or not changed:
        raise ValueError("Training did not produce finite, changed adapter weights")
    model.eval()
    final_validation_loss = evaluate(model, encoded["valid"], loss=frozen_prefix_loss,
                                     batch_size=1, num_batches=-1,
                                     max_seq_length=args.max_seq_length,
                                     clear_cache_threshold=256 * 1024 ** 2)
    if not math.isfinite(final_validation_loss):
        raise ValueError("Final validation loss is not finite")
    result = {"iterations": args.iters, "trainable_parameters": trainable_count,
              "adapter_tensors": len(saved), "changed_tensors": changed, "finite": finite,
              "seconds": time.perf_counter() - started, "peak_mlx_memory_gb": mx.get_peak_memory() / 1e9,
              "adapter_sha256": digest(output / "adapters.safetensors"),
              "final_validation_loss": final_validation_loss,
              "semantic_acceptance": False, "native_verified": False, "production_adoption": False}
    write_json(output / "training-result.json", result)
    print(json.dumps({"event": "training_finished", **result}), flush=True)


if __name__ == "__main__":
    main()
