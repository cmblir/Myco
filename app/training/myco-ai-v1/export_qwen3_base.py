"""Export the qualified cached affine4 Qwen3-8B base; never select or install it.

Run only after the learned candidate passes development and unseen qualification.
This command exports the base dependency, not the learned adapter. Numerical and
semantic native parity and installation remain separate acceptance requirements.
"""

import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import resource
import stat
import tempfile
import time

from export import output_directory
from export_ministral3 import load_gguf
from qwen3_base_metadata import write_qwen3_base_metadata, validate_qwen3_special_vocab
from qwen3_base_payload import write_base_payload, verify_base_payload
from qwen3_base_plan import base_tensor_plan
from safetensor_rows import PinnedTensorRows

MODEL_FILES = {"model.safetensors", "config.json", "tokenizer.json", "tokenizer_config.json"}
MODEL_WEIGHT_PIN = {
    "sha256": "f2d29621aab300336ad645567ff38c42aac755513006ef4e8a579cf7ef5256d8",
    "bytes": 4607835174,
}


def _stamp(value):
    return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)


def read_metadata(path, expected_sha256, expected_bytes=None):
    """Read a bounded pinned metadata file without following path aliases."""
    path = Path(path)
    if (not path.is_absolute() or path != path.resolve()
            or not isinstance(expected_sha256, str) or len(expected_sha256) != 64
            or any(char not in "0123456789abcdef" for char in expected_sha256)):
        raise ValueError("Expected canonical metadata path and frozen SHA256")
    before = path.lstat()
    if (not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= 16 * 1024 * 1024
            or (expected_bytes is not None and before.st_size != expected_bytes)):
        raise ValueError("Metadata file size/type differs from the bounded pin")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        if _stamp(os.fstat(descriptor)) != _stamp(before):
            raise ValueError("Metadata changed before read")
        with os.fdopen(descriptor, "rb", closefd=False) as handle:
            content = handle.read(before.st_size + 1)
        if (len(content) != before.st_size or _stamp(os.fstat(descriptor)) != _stamp(before)
                or _stamp(path.lstat()) != _stamp(before) or path != path.resolve()
                or hashlib.sha256(content).hexdigest() != expected_sha256):
            raise ValueError("Metadata changed or SHA256 mismatched")
    finally:
        os.close(descriptor)
    return content


def digest_file(path):
    """Hash a completed output with bounded buffers."""
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--model-pin", type=Path, required=True)
    parser.add_argument("--model-pin-sha256", required=True)
    parser.add_argument("--pretokenizer-sha256", required=True)
    parser.add_argument("--chat-template-sha256", required=True)
    parser.add_argument("--gguf-py", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    started = time.monotonic()
    destination = output_directory(args.output)
    model = args.model.resolve(strict=True)
    if model == destination or model in destination.parents:
        raise ValueError("Export output must be outside the cached model")
    pin = json.loads(read_metadata(args.model_pin, args.model_pin_sha256))
    if (set(pin) != {"model", "model_files"} or Path(pin["model"]).resolve(strict=True) != model
            or set(pin["model_files"]) != MODEL_FILES
            or pin["model_files"]["model.safetensors"] != MODEL_WEIGHT_PIN):
        raise ValueError("Expected the selected single-shard Qwen3-8B cache origin")
    snapshots = {}
    for name in sorted(MODEL_FILES - {"model.safetensors"}):
        entry = pin["model_files"][name]
        if set(entry) != {"bytes", "sha256"} or type(entry["bytes"]) is not int:
            raise ValueError("Invalid metadata pin descriptor")
        snapshots[name] = read_metadata(model / name, entry["sha256"], entry["bytes"])
    config = json.loads(snapshots["config.json"])
    versions = {name: importlib.metadata.version(name) for name in ("numpy", "transformers")}
    if versions != {"numpy": "2.5.4", "transformers": "5.20.1"}:
        raise ValueError("Use the inspected NumPy/Transformers environment")
    os.environ.update(HF_HUB_OFFLINE="1", HF_HUB_DISABLE_IMPLICIT_TOKEN="1",
                      HF_HUB_DISABLE_TELEMETRY="1", TOKENIZERS_PARALLELISM="false")
    if digest_file(args.gguf_py / "gguf/vocab.py") != (
        "8769c2ce1ccfa04484dd81125360ec13cfad43dae6cdf9ebfbf1427ab2f574e7"
    ):
        raise ValueError("Pinned GGUF SpecialVocab source changed")
    gguf = load_gguf(args.gguf_py)
    from transformers import AutoTokenizer

    with PinnedTensorRows(model / "model.safetensors", MODEL_WEIGHT_PIN["bytes"],
                          MODEL_WEIGHT_PIN["sha256"]) as reader:
        plans = base_tensor_plan(config, reader.header)
        destination.mkdir(mode=0o700, parents=False, exist_ok=False)
        # Only the pinned metadata can be consulted by the tokenizer helpers.
        with tempfile.TemporaryDirectory(dir=destination, prefix=".tokenizer-") as temporary:
            snapshot = Path(temporary)
            for name, content in snapshots.items():
                (snapshot / name).write_bytes(content)
            tokenizer = AutoTokenizer.from_pretrained(
                snapshot, local_files_only=True, trust_remote_code=False)
            special = gguf.SpecialVocab(snapshot, load_merges=True, n_vocab=151936)
            special_receipt = validate_qwen3_special_vocab(
                special, expected_chat_template_sha256=args.chat_template_sha256)
            metadata_receipt = {}

            def configure(writer):
                metadata_receipt.update(write_qwen3_base_metadata(
                    config, tokenizer, writer, gguf,
                    expected_probe_sha256=args.pretokenizer_sha256))
                special.add_to_gguf(writer)
                writer.add_name("Qwen3-8B affine4 base dependency")

            output = destination / "base.gguf"
            tensors = write_base_payload(output, plans, reader, configure, gguf)
            verify_base_payload(output, tensors, gguf)
            reader.verify_unchanged()
    receipt = {
        "kind": "qwen3_8b_cached_affine4_base_export",
        "model_pin_sha256": args.model_pin_sha256, "model_files": pin["model_files"],
        "gguf_sha256": digest_file(output), "gguf_bytes": output.stat().st_size,
        "tensors": tensors, "metadata": metadata_receipt, "special_vocab": special_receipt,
        "versions": versions, "seconds": time.monotonic() - started,
        "max_rss_platform_units": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
        "max_rss_unit": "bytes" if platform.system() == "Darwin" else "KiB",
        "coefficient_formula_preserved": True, "emitted_tensor_bytes_verified": True,
        "mlx_kernel_rounding_preserved": False, "tokenizer_parity_verified": False,
        "native_equivalence_verified": False, "production_adoption": False,
        "source_sha256": {name: digest_file(Path(__file__).with_name(name)) for name in (
            "export_qwen3_base.py", "safetensor_rows.py", "qwen3_base_plan.py",
            "qwen3_base_payload.py", "qwen3_base_metadata.py", "affine4_q4_1.py")},
    }
    with (destination / "export-result.json").open("x", encoding="utf-8") as handle:
        json.dump(receipt, handle, indent=2, ensure_ascii=False, allow_nan=False)
        handle.write("\n")
    print(json.dumps({"output": str(output), "tensor_count": len(tensors),
                      "seconds": receipt["seconds"], "production_adoption": False}))


if __name__ == "__main__":
    main()
