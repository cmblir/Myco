#!/usr/bin/env python3
"""Prepare preserved green-screen pose masters without changing the original logo.

    python3 scripts/prepare-mascot-poses.py <source-directory> [poses ...]
"""

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image


DESTINATION = Path(__file__).resolve().parents[1] / "src/assets/mascot/poses"
POSES = ("reading", "thinking", "success", "attention", "resting")


def prepare(name: str, sources: Path, destination: Path = DESTINATION) -> dict:
    """Remove the sampled green plate, despill edges, and resize with premultiplied alpha."""
    source = Image.open(sources / f"{name}.png").convert("RGB")
    if source.width != source.height:
        raise ValueError(f"{name}: expected a square green-screen master")
    pixels = np.asarray(source, dtype=np.float32)
    edge = max(1, round(min(source.size) * 0.06))
    border = np.concatenate((pixels[:edge].reshape(-1, 3), pixels[-edge:].reshape(-1, 3)))
    key = np.median(border, axis=0)
    key_strength = key[1] - max(key[0], key[2])
    if key_strength < 150:
        raise ValueError(f"{name}: expected the generated green-screen master")

    green_excess = np.maximum(pixels[:, :, 1] - np.maximum(pixels[:, :, 0], pixels[:, :, 2]), 0)
    coverage = np.clip(1 - green_excess / key_strength, 0, 1)
    # The generator adds slight plate variation. Remove that residual plate
    # while leaving opaque purple, ivory, and white character pixels intact.
    alpha = np.clip((coverage - 0.14) / 0.86, 0, 1)
    # Recover colour before tightening the matte; cleaned alpha would amplify
    # the original green-plate composite into a bright, clipped edge.
    foreground = (pixels - (1 - coverage[:, :, None]) * key) / np.maximum(coverage[:, :, None], 1e-6)
    foreground = np.clip(foreground, 0, 255)
    foreground[:, :, 1] = np.minimum(foreground[:, :, 1], np.maximum(foreground[:, :, 0], foreground[:, :, 2]))
    foreground[alpha == 0] = 0
    rgba = np.dstack((foreground, alpha * 255)).round().astype(np.uint8)
    prepared = Image.fromarray(rgba, "RGBA").convert("RGBa").resize(
        (384, 384), Image.Resampling.LANCZOS,
    ).convert("RGBA")
    output = np.asarray(prepared)
    if any(output[y, x, 3] != 0 for x, y in ((0, 0), (383, 0), (0, 383), (383, 383))):
        raise ValueError(f"{name}: opaque background remains at a corner")
    if output[192, 192, 3] < 240:
        raise ValueError(f"{name}: character center lost opacity")

    destination.mkdir(parents=True, exist_ok=True)
    target = destination / f"{name}.png"
    prepared.save(target, optimize=True)
    return {
        "pose": name,
        "source_dimensions": list(source.size),
        "sampled_background_rgb": key.tolist(),
        "output_dimensions": list(prepared.size),
        "mode": prepared.mode,
        "bytes": target.stat().st_size,
        "transparent_fraction": float(np.mean(output[:, :, 3] == 0)),
        "semi_transparent_pixels": int(np.sum((output[:, :, 3] > 0) & (output[:, :, 3] < 255))),
        "alpha_bounds": list(prepared.getchannel("A").getbbox()),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sources", type=Path)
    parser.add_argument("poses", nargs="*", choices=POSES)
    arguments = parser.parse_args()
    measurements = [prepare(name, arguments.sources) for name in (arguments.poses or POSES)]
    print(json.dumps(measurements, indent=2))
