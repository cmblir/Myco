#!/usr/bin/env python3
"""Generate the notch mascot's layers from the five character-sheet poses.

The notch draws the eyes itself (blink, look-at, squint, spiral, closed), so
each pose's own eyes are painted out once, here, and their position is measured
from the original so the drawn eyes land exactly where the sheet put them.

Outputs, in src/assets/mascot/notch/:
  <pose>.<px>.png     the pose with its eyes painted out (64 and 128 px, the
                      1x/2x pair for the 28-64 px notch sizes)
  <pose>-fx.<px>.png  the pose's detached props (thinking's bubbles, success's
                      sparkles), split off so they can bob or twinkle alone
  anchors.json        per pose, in 0..1 units of the square crop: the two eye
                      centres and radii, the cap-underside glow, whether fx exist

Nothing is redrawn: the layers are the original pixels, cropped to one common
square (so poses swap without a jump), with only the eye ovals filled from the
surrounding body shading (a harmonic fill, which matches a smooth gradient).

    python3 scripts/gen-notch-mascot.py [--preview out.png]
"""

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

APP = Path(__file__).resolve().parents[1]
POSES_DIR = APP / "src/assets/mascot/poses"
OUT = APP / "src/assets/mascot/notch"
POSES = ("resting", "reading", "thinking", "attention", "success")
SIZES = (64, 128)
# One square for every pose, in 384-px sheet coordinates: the union of the
# poses' alpha bounds (x 67..342, y 59..320) plus a few px of air.
CROP = (60, 46, 348, 334)
# Where the eyes sit on the sheet; the book's ivory pages (from y 238) and the
# cap's rim light are bright too, and stay outside this window.
FACE = (140, 185, 215, 238)


def bright_marks(rgba: np.ndarray) -> list[dict]:
    """White marks in the face window, left to right."""
    rgb = rgba[..., :3].astype(float)
    lum = rgb.mean(-1)
    sat = rgb.max(-1) - rgb.min(-1)
    bright = (lum > 150) & (sat < 60) & (rgba[..., 3] > 200)
    window = np.zeros_like(bright)
    x0, y0, x1, y1 = FACE
    window[y0:y1, x0:x1] = True
    labels, count = ndi.label(bright & window)
    found = []
    for i in range(1, count + 1):
        ys, xs = np.nonzero(labels == i)
        if len(ys) < 60:  # specks of rim light, not an eye
            continue
        found.append(
            {
                "mask": labels == i,
                "cx": float(xs.mean()),
                "cy": float(ys.mean()),
                "w": int(xs.max() - xs.min() + 1),
                "h": int(ys.max() - ys.min() + 1),
            }
        )
    found.sort(key=lambda c: c["cx"])
    return found


def eye_components(rgba: np.ndarray) -> list[dict]:
    found = bright_marks(rgba)
    if len(found) != 2:
        raise ValueError(f"expected two eyes, found {len(found)}")
    return found


def harmonic_fill(rgb: np.ndarray, hole: np.ndarray, iterations: int = 1500) -> np.ndarray:
    """Fill `hole` by repeated 4-neighbour averaging: the Laplace solution,
    i.e. the smoothest shading that meets the body around the hole."""
    out = rgb.astype(float).copy()
    ys, xs = np.nonzero(hole)
    y0, y1, x0, x1 = ys.min() - 2, ys.max() + 3, xs.min() - 2, xs.max() + 3
    patch, mask = out[y0:y1, x0:x1], hole[y0:y1, x0:x1]
    # Start from the ring's mean so the iteration has less to travel.
    ring = ndi.binary_dilation(mask, iterations=2) & ~mask
    patch[mask] = patch[ring].mean(0)
    for _ in range(iterations):
        avg = (
            np.roll(patch, 1, 0) + np.roll(patch, -1, 0) + np.roll(patch, 1, 1) + np.roll(patch, -1, 1)
        ) / 4
        patch[mask] = avg[mask]
    out[y0:y1, x0:x1] = patch
    return out


# The cap's lit underside, left of the eyes; reading's lavender book cover,
# thinking's bubbles and success's sparkles are lavender too and lie outside.
UNDERSIDE = (60, 150, 150, 236)


def glow_anchor(rgba: np.ndarray) -> dict:
    """The luminous lavender under the cap: its bright saturated pixels."""
    r, g, b = (rgba[..., i].astype(float) for i in range(3))
    lav = (b > 150) & (b - g > 60) & (r > g) & (rgba[..., 3] > 200)
    window = np.zeros_like(lav)
    x0, y0, x1, y1 = UNDERSIDE
    window[y0:y1, x0:x1] = True
    lav &= window
    ys, xs = np.nonzero(lav)
    return {"cx": float(xs.mean()), "cy": float(ys.mean()), "w": int(np.ptp(xs) + 1), "h": int(np.ptp(ys) + 1)}


def resize(img: Image.Image, px: int) -> Image.Image:
    # Premultiplied, as in prepare_sprites.py: straight-alpha LANCZOS bleeds
    # the transparent black into the silhouette's edge.
    return img.convert("RGBa").resize((px, px), Image.Resampling.LANCZOS).convert("RGBA")


def norm_x(v: float) -> float:
    return round((v - CROP[0]) / (CROP[2] - CROP[0]), 4)


def norm_y(v: float) -> float:
    return round((v - CROP[1]) / (CROP[3] - CROP[1]), 4)


def norm_len(v: float) -> float:
    return round(v / (CROP[2] - CROP[0]), 4)


def build(name: str) -> tuple[dict, Image.Image, Image.Image]:
    rgba = np.asarray(Image.open(POSES_DIR / f"{name}.png").convert("RGBA")).copy()
    eyes = eye_components(rgba)
    # The eyes' soft edge and faint halo reach ~3 px past the bright core.
    hole = ndi.binary_dilation(eyes[0]["mask"] | eyes[1]["mask"], iterations=4)
    # ...but never into reading's book, 3 px under the eyes: ivory pages and
    # the lavender cover are kept as they are.
    rgb = rgba[..., :3].astype(int)
    lum = rgb.mean(-1)
    book = ((lum > 110) & (rgb[..., 0] > rgb[..., 2] + 10)) | ((rgb.max(-1) - rgb.min(-1) > 50) & (lum > 100))
    hole &= ~book
    rgba[..., :3] = np.clip(harmonic_fill(rgba[..., :3], hole), 0, 255).round().astype(np.uint8)
    if bright_marks(rgba):
        raise ValueError(f"{name}: an eye survived the paint-out")

    # Detached props: every alpha island but the body.
    labels, count = ndi.label(rgba[..., 3] > 8)
    sizes = ndi.sum(np.ones_like(labels), labels, range(1, count + 1))
    body = int(np.argmax(sizes)) + 1
    # Islands under 40 px are anti-aliasing dust at the silhouette, not props.
    fx_islands = [i for i in range(1, count + 1) if i != body and sizes[i - 1] >= 40]
    fx_mask = np.isin(labels, fx_islands)
    fx = rgba.copy()
    fx[~fx_mask] = 0
    base = rgba.copy()
    base[fx_mask] = 0

    crop = lambda a: Image.fromarray(a, "RGBA").crop(CROP)  # noqa: E731
    closed = name == "resting"  # the sheet draws resting's eyes shut
    anchor = {
        "eyes": [
            {
                "cx": norm_x(e["cx"]),
                "cy": norm_y(e["cy"]),
                "rx": norm_len(e["w"] / 2),
                "ry": norm_len(e["h"] / 2),
            }
            for e in eyes
        ],
        "closed": closed,
        "glow": {k: (norm_x(v) if k == "cx" else norm_y(v) if k == "cy" else norm_len(v)) for k, v in glow_anchor(rgba).items()},
        "fx": bool(fx_islands),
    }
    return anchor, crop(base), crop(fx)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--preview", type=Path, help="write an originals-vs-layers contact sheet here")
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    anchors: dict[str, dict] = {}
    rows = []
    for name in POSES:
        anchor, base, fx = build(name)
        for px in SIZES:
            resize(base, px).save(OUT / f"{name}.{px}.png", optimize=True)
            if anchor["fx"]:
                resize(fx, px).save(OUT / f"{name}-fx.{px}.png", optimize=True)
        anchors[name] = anchor
        rows.append((name, base, fx))

    # A closed (resting) pose still needs open-eye radii for the blink and
    # look-at it does in the notch: borrow the open poses' median.
    open_eyes = [e for a in anchors.values() if not a["closed"] for e in a["eyes"]]
    rx = float(np.median([e["rx"] for e in open_eyes]))
    ry = float(np.median([e["ry"] for e in open_eyes]))
    for a in anchors.values():
        if a["closed"]:
            for e in a["eyes"]:
                e["arc"] = {"rx": e["rx"], "ry": e["ry"]}
                # The crescent is the lower lid: the open oval's centre is above it.
                e["cy"] = round(e["cy"] - (ry - e["ry"]) * 0.6, 4)
                e["rx"], e["ry"] = round(rx, 4), round(ry, 4)

    (OUT / "anchors.json").write_text(
        json.dumps({"crop": list(CROP), "sheet": 384, "poses": anchors}, indent=2) + "\n"
    )

    if args.preview:
        cell = 192
        sheet = Image.new("RGBA", (cell * 3, cell * len(rows)), (90, 104, 128, 255))
        for i, (name, base, fx) in enumerate(rows):
            orig = Image.open(POSES_DIR / f"{name}.png").convert("RGBA").crop(CROP)
            for j, img in enumerate((orig, base, Image.alpha_composite(base, fx))):
                tile = resize(img, cell)
                sheet.alpha_composite(tile, (j * cell, i * cell))
        sheet.save(args.preview)
    print(json.dumps(anchors, indent=1))


if __name__ == "__main__":
    main()
