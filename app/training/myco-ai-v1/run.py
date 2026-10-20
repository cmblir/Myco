"""Run a bounded, offline MLX writer-adapter experiment on synthetic records."""

import argparse
import hashlib
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

REPO = Path(__file__).resolve().parents[3]


def write_json(path, value):
    with path.open("x", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_rows(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line]


def tokenize(rows, tokenizer, max_length):
    """Mask the complete chat prefix and reject truncation or template drift."""
    encoded = []
    for index, row in enumerate(rows):
        messages = row["messages"]
        prefix = tokenizer.apply_chat_template(
            messages[:-1], add_generation_prompt=True, enable_thinking=False,
            return_dict=False,
        )
        tokens = tokenizer.apply_chat_template(
            messages, enable_thinking=False, return_dict=False,
        )
        if tokens[:len(prefix)] != prefix:
            raise ValueError(f"Chat prefix mismatch in sample {index}")
        if len(tokens) > max_length:
            raise ValueError(f"Sample {index}: {len(tokens)} exceeds {max_length}; no truncation allowed")
        if len(prefix) >= len(tokens):
            raise ValueError(f"Sample {index} has no supervised completion")
        completion = tokenizer.decode(tokens[len(prefix):], skip_special_tokens=False)
        target = messages[-1]["content"]
        eos = tokenizer.eos_token
        token_id = getattr(tokenizer, "convert_tokens_to_ids", None)
        is_phi4 = (eos == "<|endoftext|>" and callable(token_id)
                   and token_id("<|end|>") == 200020 and token_id(eos) == 199999)
        if is_phi4:
            # The inspected Phi-4 template terminates each turn, then the sequence.
            is_exact = (completion == target + "<|end|><|endoftext|>"
                        and tokens[len(prefix):][-2:] == [200020, 199999])
        elif (eos == "<eos>" and getattr(tokenizer, "bos_token", None) == "<bos>"
              and getattr(tokenizer, "sot_token", None) == "<|turn>"
              and getattr(tokenizer, "eot_token", None) == "<turn|>"):
            # The inspected text-only Gemma 4 template closes with EOT, not EOS.
            is_exact = completion == target + "<turn|>\n"
        else:
            is_exact = (isinstance(eos, str) and bool(eos)
                        and completion in (target + eos, target + eos + "\n"))
        if not is_exact:
            raise ValueError(f"Sample {index}: supervised completion differs from the exact target and EOS")
        encoded.append((tokens, len(prefix)))
    return encoded


def grade(text, expected, finish_reason):
    """Apply frozen structural and scenario checks; these are not a semantic judge."""
    failures = []
    if finish_reason != "stop":
        failures.append("incomplete_generation")
    try:
        answer = json.loads(text)
    except json.JSONDecodeError:
        return failures + ["invalid_json"]
    if not isinstance(answer, dict) or set(answer) != {"answer", "sources"}:
        return failures + ["wrong_schema"]
    body, sources = answer["answer"], answer["sources"]
    if not isinstance(body, str) or not isinstance(sources, list):
        return failures + ["wrong_types"]
    if (not all(isinstance(source, str) for source in sources)
            or len(sources) != len(set(sources))
            or set(sources) != set(expected["sources"])):
        failures.append("source_ids")
    if (body == "") != expected["empty"]:
        failures.append("abstention")
    for phrase in expected.get("must_include", []):
        if phrase not in body:
            failures.append(f"missing:{phrase}")
    for phrase in expected.get("must_exclude", []):
        if phrase in body:
            failures.append(f"forbidden:{phrase}")
    return failures


def response_loss(model, batch, lengths):
    """Exclude padding: MLX-LM 0.32.2 uses an inclusive target-index bound."""
    import mlx.core as mx
    from mlx_lm.tuner.trainer import default_loss
    return default_loss(model, batch, lengths - mx.array([0, 1]))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["check", "train", "evaluate"])
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--adapter", type=Path)
    parser.add_argument("--iters", type=int, default=5)
    parser.add_argument("--max-seq-length", type=int, default=2304)
    parser.add_argument("--max-tokens", type=int, default=320)
    args = parser.parse_args()
    if args.iters < 1 or args.max_tokens < 1 or args.max_seq_length < 1:
        parser.error("Iteration and token budgets must be positive")
    model_path = args.model.resolve(strict=True)
    data_path = args.data.resolve(strict=True)
    output = args.output.resolve()
    if output == REPO or REPO in output.parents:
        parser.error("Experiment output must be outside the repository")
    output.mkdir(parents=True, exist_ok=False)
    started = time.perf_counter()
    rows = {split: read_rows(data_path / f"{split}.jsonl") for split in ("train", "valid", "test")}
    manifest = json.loads((data_path / "manifest.json").read_text())
    from prepare import validate_dataset
    if manifest.get("synthetic_only") is not True:
        raise ValueError("This pilot accepts generated synthetic data only")
    validate_dataset(rows, manifest["splits"])
    for split in rows:
        if digest(data_path / f"{split}.jsonl") != manifest["sha256"][f"{split}.jsonl"]:
            raise ValueError(f"Dataset digest mismatch: {split}")
    write_json(output / "run.json", {
        "mode": args.mode, "model": str(model_path), "adapter": str(args.adapter),
        "mlx_lm": importlib.metadata.version("mlx-lm"),
        "mlx": importlib.metadata.version("mlx"), "seed": 42,
        "iters": args.iters, "max_seq_length": args.max_seq_length,
        "max_tokens": args.max_tokens, "thinking": False, "temperature": 0,
        "loss_mask": "prompt <= target_index < original_sequence_length",
        "data_sha256": {split: digest(data_path / f"{split}.jsonl") for split in rows},
        "manifest_sha256": digest(data_path / "manifest.json"),
        "source_sha256": {path.name: digest(path) for path in [Path(__file__), Path(__file__).with_name("prepare.py")]},
        "production_adoption": False,
    })
    from mlx_lm.utils import load_tokenizer
    tokenizer = load_tokenizer(model_path, {"trust_remote_code": False})
    encoded = {split: tokenize(samples, tokenizer, args.max_seq_length) for split, samples in rows.items()}
    lengths = {split: {"samples": len(samples), "max": max(len(tokens) for tokens, _ in samples),
                       "min": min(len(tokens) for tokens, _ in samples),
                       "supervised_tokens": sum(len(tokens) - offset for tokens, offset in samples)}
               for split, samples in encoded.items()}
    write_json(output / "tokenization.json", lengths)
    print(json.dumps({"tokenization": lengths}, ensure_ascii=False), flush=True)
    if args.mode == "check":
        return

    import mlx.core as mx
    import numpy as np
    from mlx_lm import load
    mx.set_memory_limit(8 * 1024 ** 3)
    mx.set_cache_limit(256 * 1024 * 1024)
    mx.random.seed(42)
    np.random.seed(42)
    model, tokenizer = load(str(model_path), adapter_path=str(args.adapter) if args.adapter else None,
                            tokenizer_config={"trust_remote_code": False}, trust_remote_code=False)
    print(json.dumps({"loaded_seconds": time.perf_counter() - started}), flush=True)
    if args.mode == "train":
        if args.adapter:
            parser.error("This pilot starts a fresh adapter; resume is deliberately unavailable")
        import mlx.optimizers as optim
        from mlx.utils import tree_flatten
        from mlx_lm.tuner.callbacks import TrainingCallback
        from mlx_lm.tuner.trainer import TrainingArgs, train
        from mlx_lm.tuner.utils import linear_to_lora_layers
        config = {"fine_tune_type": "lora", "num_layers": 1,
                  "lora_parameters": {"rank": 8, "scale": 16.0, "dropout": 0.0}}
        write_json(output / "adapter_config.json", config)
        model.freeze()
        linear_to_lora_layers(model, config["num_layers"], config["lora_parameters"])
        if model.model_type != "qwen3_5" or getattr(model.layers[-1], "linear_attn", None) is not None:
            raise ValueError("The pilot requires a final full-attention layer")

        def prefix_frozen_loss(model, batch, lengths):
            # Frozen recurrent blocks need no VJP; retain their inference kernel.
            for layer in model.layers[:-1]:
                layer.eval()
            return response_loss(model, batch, lengths)
        parameters = dict(tree_flatten(model.trainable_parameters()))
        trainable_count = sum(array.size for array in parameters.values())
        initial = {name: mx.array(array) for name, array in parameters.items()}
        mx.eval(initial)
        with (output / "metrics.jsonl").open("x") as metrics:
            class Recorder(TrainingCallback):
                def record(self, kind, values):
                    if any(isinstance(value, float) and not math.isfinite(value) for value in values.values()):
                        raise ValueError("Non-finite training metric")
                    record = {"kind": kind, "elapsed_seconds": time.perf_counter() - started, **values}
                    metrics.write(json.dumps(record) + "\n")
                    metrics.flush()
                    print(json.dumps(record), flush=True)

                def on_train_loss_report(self, values):
                    self.record("train", values)

                def on_val_loss_report(self, values):
                    self.record("valid", values)

            train(model, optim.Adam(learning_rate=1e-4), encoded["train"], encoded["valid"],
                  loss=prefix_frozen_loss,
                  args=TrainingArgs(batch_size=1, iters=args.iters, val_batches=1,
                                    steps_per_report=1, steps_per_eval=args.iters,
                                    steps_per_save=args.iters, max_seq_length=args.max_seq_length,
                                    adapter_file=str(output / "adapters.safetensors"),
                                    grad_checkpoint=True, clear_cache_threshold=256 * 1024 * 1024),
                  training_callback=Recorder())
        saved = mx.load(str(output / "adapters.safetensors"))
        finite = all(bool(mx.all(mx.isfinite(array)).item()) for array in saved.values())
        changed = sum(bool(mx.any(saved[name] != initial[name]).item()) for name in saved)
        if not finite or not changed:
            raise ValueError("Adapter is non-finite or unchanged; training was not successful")
        write_json(output / "training-result.json", {
            "iterations": args.iters, "trainable_parameters": trainable_count,
            "changed_tensors": changed, "finite": finite,
            "elapsed_seconds": time.perf_counter() - started, "peak_memory_gb": mx.get_peak_memory() / 1e9,
            "adapter_sha256": digest(output / "adapters.safetensors"), "production_adoption": False,
        })
    else:
        from mlx_lm import stream_generate
        from mlx_lm.sample_utils import make_sampler
        model.eval()
        passed = 0
        answered_passed = refusal_passed = answered_cases = refusal_cases = 0
        with (output / "answers.jsonl").open("x", encoding="utf-8") as answers:
            for row, metadata in zip(rows["test"], manifest["splits"]["test"], strict=True):
                tokens = tokenizer.apply_chat_template(row["messages"][:-1], add_generation_prompt=True,
                                                        enable_thinking=False, return_dict=False)
                case_started = time.perf_counter()
                text = ""
                for response in stream_generate(model, tokenizer, tokens, max_tokens=args.max_tokens,
                                                sampler=make_sampler(temp=0), prefill_step_size=256):
                    text += response.text
                failures = grade(text, metadata["expected"], response.finish_reason)
                passed += not failures
                if metadata["expected"]["empty"]:
                    refusal_cases += 1
                    refusal_passed += not failures
                else:
                    answered_cases += 1
                    answered_passed += not failures
                result = {"id": metadata["id"], "family": metadata["family"], "text": text,
                          "failures": failures, "finish_reason": response.finish_reason,
                          "seconds": time.perf_counter() - case_started,
                          "generation_tokens": response.generation_tokens}
                answers.write(json.dumps(result, ensure_ascii=False) + "\n")
                answers.flush()
                print(json.dumps(result, ensure_ascii=False), flush=True)
                mx.clear_cache()
        write_json(output / "evaluation.json", {
            "scenario_checks_passed": passed, "cases": len(rows["test"]),
            "answer_checks": {"passed": answered_passed, "cases": answered_cases},
            "refusal_probes": {"passed": refusal_passed, "cases": refusal_cases},
            "native_validator_executed": False, "decoding": "unconstrained_greedy",
            "elapsed_seconds": time.perf_counter() - started,
            "peak_memory_gb": mx.get_peak_memory() / 1e9,
            "semantic_review_required": True, "production_adoption": False,
        })


if __name__ == "__main__":
    main()
