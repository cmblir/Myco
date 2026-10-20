"""Compare local instruction checkpoints on frozen, synthetic development cases."""

import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import resource
import time

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"

from run import REPO, digest, grade, write_json


def model_fingerprint(model_path):
    """Bind local weights and tokenizer bytes without allocating whole shards."""
    weights = sorted(model_path.glob("*.safetensors"))
    if not weights:
        raise ValueError("Local model has no safetensors weights")
    files = weights + [model_path / name for name in (
        "config.json", "generation_config.json", "tokenizer.json", "tokenizer_config.json", "chat_template.jinja")
        if (model_path / name).is_file()]
    fingerprints = {}
    for path in files:
        hasher = hashlib.sha256()
        with path.open("rb") as handle:
            for block in iter(lambda: handle.read(1024 * 1024), b""):
                hasher.update(block)
        fingerprints[path.name] = {"sha256": hasher.hexdigest(), "bytes": path.stat().st_size}
    return fingerprints


def adapter_fingerprint(adapter_path):
    """Bind the two files actually consumed by MLX-LM's adapter loader."""
    files = [adapter_path / name for name in ("adapter_config.json", "adapters.safetensors")]
    if any(not path.is_file() or path.stat().st_size == 0 for path in files):
        raise ValueError("Expected nonempty adapter configuration and weights")
    return {path.name: {"sha256": digest(path), "bytes": path.stat().st_size} for path in files}


def load_cases(data_path=None, split="valid"):
    """Separate supervised targets from inference inputs before tokenization."""
    if data_path is None:
        from smoke_v2 import build_smoke
        return build_smoke()
    from run import read_rows
    from multitask_v2 import validate_dataset
    manifest = json.loads((data_path / "manifest.json").read_text())
    if manifest.get("synthetic_only") is not True:
        raise ValueError("This development runner accepts synthetic data only")
    path = data_path / f"{split}.jsonl"
    if digest(path) != manifest["sha256"][path.name]:
        raise ValueError("Evaluation dataset digest mismatch")
    supervised = read_rows(path)
    metadata = manifest["splits"][split]
    validate_dataset({split: supervised}, {split: metadata})
    return [{"messages": row["messages"][:2]} for row in supervised], metadata


def load_heldout(data_path):
    """Read frozen final inputs; never regenerate cases or append references."""
    from heldout_v1 import VERSION, validate_heldout
    from multitask_v2 import SCHEMAS
    manifest_body = (data_path / "manifest.json").read_bytes()
    manifest = json.loads(manifest_body)
    if (manifest.get("version") != VERSION or manifest.get("synthetic_only") is not True
            or manifest.get("model_inputs_file") != "inputs.jsonl"
            or manifest.get("references_must_not_be_model_input") is not True):
        raise ValueError("Expected a frozen synthetic heldout manifest")
    input_body = (data_path / "inputs.jsonl").read_bytes()
    input_sha256 = hashlib.sha256(input_body).hexdigest()
    if input_sha256 != manifest["sha256"]["inputs.jsonl"]:
        raise ValueError("Heldout input digest mismatch")
    rows = [json.loads(line) for line in input_body.decode("utf-8").splitlines() if line]
    metadata = manifest["cases"]
    validate_heldout(rows, metadata)
    if (manifest.get("family_count") != 12 or manifest.get("task_count") != 12
            or manifest.get("role_counts") != {role: 3 for role in SCHEMAS}):
        raise ValueError("Heldout manifest schedule changed")
    for row, rubric in zip(rows, metadata, strict=True):
        if (any(set(message) != {"role", "content"} or not isinstance(message["content"], str)
                for message in row["messages"])
                or rubric.get("final_evaluation_only") is not True
                or rubric.get("use_for_training_or_selection") is not False
                or rubric["expected"]["schema"] != SCHEMAS[rubric["task"]]):
            raise ValueError("Heldout messages or final-role metadata changed")
    provenance = {key: manifest[key] for key in (
        "source_sha256", "production_source_sha256", "comparison_training_manifest_sha256",
        "family_count", "task_count", "role_counts", "limitations")}
    provenance.update(manifest_sha256=hashlib.sha256(manifest_body).hexdigest(),
                      inputs_sha256=input_sha256, author_created_synthetic=True,
                      references_must_not_be_model_input=True)
    return rows, metadata, provenance


def load_reviewer(data_path):
    """Read an explicitly frozen exposed-development fixture without rebuilding it."""
    from reviewer_cases import canonical, validate_verdict
    body = (data_path / "frozen-cases.json").read_bytes()
    fixture = json.loads(body)
    rows, rubrics, metadata = fixture["rows"], fixture["rubrics"], fixture["metadata"]
    expected = {"purpose": "exposed_development_diagnostic", "synthetic_only": True,
                "pairs": 4, "scheduled_verdicts": 8, "independent_source_families": 3,
                "source_review": "automated_source_text_review_not_human", "human_reviewed": False,
                "final_holdout": False, "prior_development_outputs_known": True,
                "claim_review_only": True, "answer_review_gate_verified": False,
                "native_validator_executed": False, "native_token_fit_verified": False,
                "app_success_verified": False, "production_adoption": False}
    if any(type(metadata.get(key)) is not type(value) or metadata[key] != value
           for key, value in expected.items()) or len(rows) != 8 or len(rubrics) != 8:
        raise ValueError("Expected eight exposed synthetic claim-review development cases")
    ids, pairs, families = set(), {}, set()
    for row, rubric in zip(rows, rubrics, strict=True):
        messages = row["messages"]
        if (set(row) != {"messages"} or len(messages) != 2
                or [item.get("role") for item in messages] != ["system", "user"]
                or any(set(item) != {"role", "content"} or not isinstance(item["content"], str)
                       for item in messages)
                or rubric.get("task") != "claim_review_development"
                or rubric.get("expected") != {"schema": "WikiClaimReviewV1"}
                or not isinstance(rubric.get("family"), str) or not rubric["family"]
                or rubric["id"] in ids
                or hashlib.sha256(canonical(messages).encode()).hexdigest() != rubric["input_sha256"]):
            raise ValueError("Reviewer message, task or frozen input binding changed")
        payload = json.loads(messages[1]["content"])
        if set(payload) != {"context", "contextRevision", "coverageRequiredSpanIds", "referenceSpanIds",
                            "originalSpans", "requiredClaimIds", "claims", "independentVerificationReceipts"}:
            raise ValueError("Expected the exact production claim-review model wire")
        reference = rubric["reference"]
        validate_verdict({"version": "WikiClaimReviewV1", "claims": [
            {"id": item["id"], "disposition": item["disposition"], "reason": "Synthetic shape check only."}
            for item in reference["expectedDecisions"]], "sourceCoverage": reference["sourceCoverage"],
            "missingSpanIds": reference["missingSpanIds"]}, payload)
        ids.add(rubric["id"])
        families.add(rubric["family"])
        pairs.setdefault(rubric["pair_id"], []).append(reference["expectedVerdict"])
    if len(families) != 3 or len(pairs) != 4 or any(sorted(values) != ["accept", "reject"] for values in pairs.values()):
        raise ValueError("Reviewer paired schedule or source-family count changed")
    return rows, rubrics, {**metadata, "kind": "exposed_claim_review_development",
                           "frozen_cases_sha256": hashlib.sha256(body).hexdigest(),
                           "native_accepted": False, "semantic_acceptance": False}


def load_answer_reviewer(data_path):
    """Read four frozen exposed answer reviews without creating model inputs."""
    from answer_reviewer_cases import canonical
    body = (data_path / "frozen-cases.json").read_bytes()
    fixture = json.loads(body)
    rows, rubrics, metadata = fixture["rows"], fixture["rubrics"], fixture["metadata"]
    expected = {"kind": "exposed_answer_review_development", "synthetic_only": True,
                "pairs": 2, "scheduled_verdicts": 4, "independent_source_families": 2,
                "source_review": "automated_source_text_review_not_human", "human_reviewed": False,
                "prior_development_outputs_known": True, "final_holdout": False,
                "context_binding_native_authorized": False, "native_draft_validator_executed": False,
                "native_review_validator_executed": False, "token_fit_verified": False,
                "semantic_acceptance": False, "app_success_verified": False, "production_adoption": False}
    if (any(type(metadata.get(key)) is not type(value) or metadata[key] != value
            for key, value in expected.items()) or len(rows) != 4 or len(rubrics) != 4):
        raise ValueError("Expected four exposed synthetic answer-review development cases")
    ids, pairs, families = set(), {}, set()
    for row, rubric in zip(rows, rubrics, strict=True):
        messages = row["messages"]
        if (set(row) != {"messages"} or len(messages) != 2
                or [item.get("role") for item in messages] != ["system", "user"]
                or any(set(item) != {"role", "content"} or not isinstance(item["content"], str)
                       for item in messages)
                or rubric.get("task") != "answer_review_development"
                or rubric.get("expected") != {"schema": "AskAnswerReviewV1"}
                or not isinstance(rubric.get("family"), str) or not rubric["family"]
                or rubric.get("pair_id") != rubric["family"] or rubric["id"] in ids
                or hashlib.sha256(canonical(messages).encode()).hexdigest() != rubric["input_sha256"]):
            raise ValueError("Answer-review message, task or frozen input binding changed")
        payload = json.loads(messages[1]["content"])
        if (set(payload) != {"context", "contextRevision", "answer", "answerInputRevision",
                             "originalSpans", "citations", "independentVerificationReceipts"}
                or set(payload["answer"]) != {"proseWithoutModelLinkLabels", "sourceIds"}):
            raise ValueError("Expected the ordinary Flat deduplicated answer-review wire")
        ids.add(rubric["id"])
        families.add(rubric["family"])
        pairs.setdefault(rubric["pair_id"], []).append(rubric["reference"]["expected_verdict"])
    if len(families) != 2 or len(pairs) != 2 or any(sorted(values) != ["accept", "reject"] for values in pairs.values()):
        raise ValueError("Answer-review paired schedule or source-family count changed")
    return rows, rubrics, {**metadata, "kind": "exposed_answer_review_development",
                           "frozen_cases_sha256": hashlib.sha256(body).hexdigest(),
                           "native_accepted": False, "semantic_acceptance": False}


def output_failures(text, rubric, finish_reason, messages):
    """Report structure/reference checks separately from semantic acceptance."""
    if "schema" not in rubric["expected"]:
        return grade(text, rubric["expected"], finish_reason)
    from multitask_v2 import validate_target
    failures = [] if finish_reason == "stop" else ["incomplete_generation"]
    try:
        def unique_object(pairs):
            parsed = dict(pairs)
            if len(parsed) != len(pairs):
                raise ValueError("duplicate JSON key in model output")
            return parsed

        target = json.loads(text, object_pairs_hook=unique_object)
        if not isinstance(target, dict):
            raise ValueError("Expected an output object")
        if rubric["expected"]["schema"] == "WikiClaimReviewV1":
            from reviewer_cases import validate_verdict
            validate_verdict(target, json.loads(messages[1]["content"]))
        elif rubric["expected"]["schema"] == "AskAnswerReviewV1":
            from answer_reviewer_cases import validate_verdict
            validate_verdict(target, json.loads(messages[1]["content"]))
        else:
            validate_target(rubric["task"], json.loads(messages[1]["content"]), target)
    except (ValueError, TypeError, KeyError) as error:
        failures.append(f"output_contract:{type(error).__name__}:{error}")
    return failures


def encode_prompt(messages, tokenizer, context_size, output_tokens):
    """Reject target leakage and reserve output space without cutting originals."""
    if ([item.get("role") for item in messages] != ["system", "user"]
            or not all(isinstance(item.get("content"), str) for item in messages)):
        raise ValueError("Development inputs must contain only system and user text")
    tokens = tokenizer.apply_chat_template(
        messages, add_generation_prompt=True, enable_thinking=False, return_dict=False,
    )
    if not tokens or len(tokens) + output_tokens > context_size:
        raise ValueError(f"Prompt {len(tokens)} + output {output_tokens} exceeds {context_size}; no truncation")
    return tokens


def fresh_output(requested):
    """Keep experimental artifacts outside the checkout and preserve past runs."""
    destination = requested.resolve()
    if destination == REPO or REPO in destination.parents:
        raise ValueError("Experiment output must be outside the repository")
    if requested.is_symlink() or requested.exists() or destination.exists():
        raise FileExistsError("Experiment output already exists")
    destination.mkdir(parents=True)
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--adapter", type=Path)
    cases = parser.add_mutually_exclusive_group()
    cases.add_argument("--data", type=Path)
    cases.add_argument("--heldout", type=Path, help="Frozen directory containing inputs.jsonl and manifest.json")
    cases.add_argument("--reviewer", type=Path, help="Exposed development directory containing frozen-cases.json")
    cases.add_argument("--answer-reviewer", type=Path, help="Exposed answer-review directory containing frozen-cases.json")
    parser.add_argument("--split", choices=["valid"], default="valid")
    parser.add_argument("--max-tokens", type=int, default=768)
    parser.add_argument("--context-size", type=int, default=4096)
    args = parser.parse_args()
    if args.max_tokens < 1 or args.context_size <= args.max_tokens:
        parser.error("Context must reserve positive prompt and output budgets")
    model_path = args.model.resolve(strict=True)
    adapter_path = args.adapter.resolve(strict=True) if args.adapter else None
    output = fresh_output(args.output)
    heldout = reviewer = answer_reviewer = None
    if args.answer_reviewer:
        rows, metadata, answer_reviewer = load_answer_reviewer(args.answer_reviewer.resolve(strict=True))
    elif args.reviewer:
        rows, metadata, reviewer = load_reviewer(args.reviewer.resolve(strict=True))
    elif args.heldout:
        rows, metadata, heldout = load_heldout(args.heldout.resolve(strict=True))
    else:
        rows, metadata = load_cases(args.data.resolve(strict=True) if args.data else None, args.split)
    if not rows or len(rows) != len(metadata):
        raise ValueError("Synthetic case and rubric counts differ")
    write_json(output / "frozen-cases.json", {"rows": rows, "rubrics": metadata})
    started = time.perf_counter()
    from mlx_lm.utils import load_tokenizer
    tokenizer = load_tokenizer(model_path, {"trust_remote_code": False})
    prompts = [encode_prompt(row["messages"], tokenizer, args.context_size, args.max_tokens) for row in rows]
    recipe = {
        "kind": answer_reviewer["kind"] if answer_reviewer else (reviewer["kind"] if reviewer else (
            "unseen_qualification" if heldout else (
            "validation_not_final_test" if args.data else "development_smoke_not_unseen_qualification"))),
        "model": str(model_path),
        "adapter": str(adapter_path) if adapter_path else None, "cases": len(rows),
        "adapter_files": adapter_fingerprint(adapter_path) if adapter_path else None,
        "context_size": args.context_size, "max_tokens": args.max_tokens,
        "temperature": 0, "thinking": False, "prefill_step_size": 256,
        "mlx_lm": importlib.metadata.version("mlx-lm"),
        "mlx": importlib.metadata.version("mlx"),
        "model_files": model_fingerprint(model_path),
        "data_manifest_sha256": heldout["manifest_sha256"] if heldout else (
            digest(args.data / "manifest.json") if args.data else None),
        "frozen_cases_sha256": digest(output / "frozen-cases.json"),
        "source_sha256": {path.name: digest(path) for path in (
            Path(__file__), Path(__file__).with_name("smoke_v2.py"),
            Path(__file__).with_name("prepare.py"), Path(__file__).with_name("run.py"),
            Path(__file__).with_name("multitask_v2.py"))},
        "prompt_tokens": [len(prompt) for prompt in prompts],
        "prompt_token_sha256": [hashlib.sha256(json.dumps(prompt).encode()).hexdigest() for prompt in prompts],
        "semantic_acceptance": False, "production_adoption": False,
    }
    if heldout:
        recipe["heldout"] = heldout
        recipe["source_sha256"]["heldout_v1.py"] = digest(Path(__file__).with_name("heldout_v1.py"))
    if reviewer:
        recipe["reviewer"] = reviewer
        recipe["source_sha256"]["reviewer_cases.py"] = digest(Path(__file__).with_name("reviewer_cases.py"))
    if answer_reviewer:
        recipe["answer_reviewer"] = answer_reviewer
        recipe["source_sha256"]["answer_reviewer_cases.py"] = digest(Path(__file__).with_name("answer_reviewer_cases.py"))
    write_json(output / "recipe.json", recipe)
    print(json.dumps({"event": "inputs_frozen", "prompt_tokens": recipe["prompt_tokens"]}), flush=True)
    import mlx.core as mx
    from mlx_lm import load, stream_generate
    from mlx_lm.sample_utils import make_sampler
    mx.set_memory_limit(8 * 1024 ** 3)
    mx.set_cache_limit(256 * 1024 ** 2)
    mx.random.seed(42)
    model, tokenizer = load(str(model_path),
                            adapter_path=str(adapter_path) if adapter_path else None,
                            tokenizer_config={"trust_remote_code": False}, trust_remote_code=False)
    if adapter_path and adapter_fingerprint(adapter_path) != recipe["adapter_files"]:
        raise ValueError("Adapter files changed while loading")
    model.eval()
    print(json.dumps({"event": "model_loaded", "seconds": time.perf_counter() - started}), flush=True)
    completed = 0
    with (output / "answers.jsonl").open("x", encoding="utf-8") as handle:
        for prompt, row, rubric in zip(prompts, rows, metadata, strict=True):
            case_started = time.perf_counter()
            answer_text = ""
            final_response = None
            try:
                for response in stream_generate(model, tokenizer, prompt, max_tokens=args.max_tokens,
                                                sampler=make_sampler(temp=0), prefill_step_size=256):
                    answer_text += response.text
                    final_response = response
            except BaseException as error:
                failed = {"id": rubric["id"], "text": answer_text,
                          "finish_reason": "error", "error_type": type(error).__name__,
                          "error": str(error), "seconds": time.perf_counter() - case_started,
                          "semantic_review_required": True, "native_app_success_verified": False}
                if "task" in rubric:
                    failed.update(task=rubric["task"], family=rubric["family"])
                handle.write(json.dumps(failed, ensure_ascii=False) + "\n")
                handle.flush()
                print(json.dumps(failed, ensure_ascii=False), flush=True)
                raise
            if final_response is None:
                raise RuntimeError("Model produced no generation event")
            completed += 1
            result = {
                "id": rubric["id"], "family": rubric["family"], "text": answer_text,
                "finish_reason": final_response.finish_reason,
                "structural_literal_failures": output_failures(answer_text, rubric, final_response.finish_reason, row["messages"]),
                "generation_tokens": final_response.generation_tokens,
                "seconds": time.perf_counter() - case_started,
                "semantic_review_required": True, "native_app_success_verified": False,
            }
            if "task" in rubric:
                result["task"] = rubric["task"]
            handle.write(json.dumps(result, ensure_ascii=False) + "\n")
            handle.flush()
            print(json.dumps(result, ensure_ascii=False), flush=True)
            mx.clear_cache()
    if adapter_path and adapter_fingerprint(adapter_path) != recipe["adapter_files"]:
        raise ValueError("Adapter files changed during evaluation")
    write_json(output / "result.json", {
        "completed_cases": completed, "seconds": time.perf_counter() - started,
        "peak_mlx_memory_gb": mx.get_peak_memory() / 1e9,
        "peak_process_rss_bytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
        "native_validator_executed": False, "semantic_review_required": True,
        "production_adoption": False,
    })


if __name__ == "__main__":
    main()
