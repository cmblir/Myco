"""Key a krea.ai green-screen clip of the myco mascot into app assets.

Per frame, the green plate is sampled from the frame border (so a frame whose
plate brightened still keys), alpha comes from green excess over that plate,
edges are despilled, and the whole 640px frame is kept (no crop) so the
character keeps the exact scale of the five pose sprites (full frame -> 384px).

The takes come out about a third more saturated and bluer than the sheet, so
every frame is also graded by one colour fit: a per-channel affine (RGB + 1,
least squares) taking the keyed first frame to the committed start pose
(src/assets/mascot/poses/<from>.png), over the pixels opaque in both with the
eyes left out. One fit per take holds for its whole length, so its first and
last frames land on their poses' colours and a hand-off does not shift hue.

Outputs under OUT/<name>/:
  frames24/NNN.png   RGBA 384px at the source 24 fps (QA + video source)
  <name>.webm        VP9 + alpha, 384px, 24 fps (Chromium)
  <name>.mov         HEVC + alpha (hvc1), 384px, 24 fps (WKWebView)
  <name>.poster.png  first frame, RGBA 384px
  <name>.strip.webp  notch sprite strip, 168px frames at 12 fps, horizontal
  <name>.json        {frames, fps, loop, frameSize, pad}
  sheet.png          QA contact sheet on dark and light grounds
usage: mascot-key-clip.py <clip.mp4> <name> <loop:0|1> <from-pose> [frames]
  frames: key only the take's first N frames (24 fps), so a one-shot whose take
  settles early fits the time its notch state is held.
"""

import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

OUT = Path.cwd() / "mascot-clips"
MASCOT = Path(__file__).resolve().parents[1] / "src/assets/mascot"


def key_frame(rgb: np.ndarray, grade: np.ndarray | None = None) -> np.ndarray:
    px = rgb.astype(np.float32)
    edge = max(1, round(min(px.shape[:2]) * 0.04))
    border = np.concatenate([
        px[:edge].reshape(-1, 3), px[-edge:].reshape(-1, 3),
        px[:, :edge].reshape(-1, 3), px[:, -edge:].reshape(-1, 3),
    ])
    key = np.median(border, axis=0)
    strength = max(key[1] - max(key[0], key[2]), 1.0)
    excess = np.maximum(px[:, :, 1] - np.maximum(px[:, :, 0], px[:, :, 2]), 0)
    coverage = np.clip(1 - excess / strength, 0, 1)
    alpha = np.clip((coverage - 0.14) / 0.86, 0, 1)
    # Recover colour before tightening the matte; the reduced alpha would
    # amplify the edge RGB and clip it into a bright fringe.
    fg = (px - (1 - coverage[:, :, None]) * key) / np.maximum(coverage[:, :, None], 1e-6)
    fg = np.clip(fg, 0, 255)
    fg[:, :, 1] = np.minimum(fg[:, :, 1], np.maximum(fg[:, :, 0], fg[:, :, 2]))
    if grade is not None:
        fg = np.clip(fg @ grade[:3] + grade[3], 0, 255)
    fg[alpha == 0] = 0
    # Encoder noise leaves the odd opaque pixel on the frame's outer ring.
    alpha[:3, :] = 0; alpha[-3:, :] = 0; alpha[:, :3] = 0; alpha[:, -3:] = 0
    return np.dstack((fg, alpha * 255)).round().astype(np.uint8), float(strength)


def resize_rgba(im: Image.Image, size: int) -> Image.Image:
    return im.convert("RGBa").resize((size, size), Image.Resampling.LANCZOS).convert("RGBA")


LUMA = np.float32([0.2126, 0.7152, 0.0722])
CAP_RIM = 8  # strip px: a dark cap's rim light is thinner than this
FADE_IN = 3  # strip frames over which a prop held back while cut fades in


def light_prop_cut(frame: np.ndarray) -> bool:
    """Whether a light prop (an orb, its glow) crosses the strip frame's top row,
    the take's own top edge, with nothing of the dark cap in the top CAP_RIM
    rows: a cap there, rim light and all, is a cap cut flat, which the strip
    test must still see.
    """
    luma = frame[:CAP_RIM, :, :3].astype(np.float32) @ LUMA
    alpha = frame[:CAP_RIM, :, 3]
    return bool(((luma[0] > 96) & (alpha[0] > 32)).any() and not ((luma < 96) & (alpha > 200)).any())


def mix(a: np.ndarray, b: np.ndarray, t: float) -> np.ndarray:
    """`a` blended toward `b` by t, premultiplied so a clear pixel's black does not bleed in."""
    a_, b_ = (Image.fromarray(x, "RGBA").convert("RGBa") for x in (a, b))
    return np.asarray(Image.blend(a_, b_, t).convert("RGBA"))


def fade_in_cut_props(frames: list[np.ndarray]) -> list[np.ndarray]:
    """Hold a light prop back while the take's top edge cuts it, then fade it in.

    gulp's orb drops in from above the take's picture, so the take itself cuts
    its top flat for several frames, and no fade at the edge hides a straight
    line across a bright disc. Instead the last frame before the prop arrived
    holds while it is cut, and the first frames with the prop whole fade in
    from that frame. The whole frame holds, so this assumes the character
    stands still while the prop drops (gulp's catch does; look at the sheet).
    Frames with nothing cut, and the cap and body in every frame, are left as
    they are.
    """
    out: list[np.ndarray] = []
    held, since = None, FADE_IN
    for f in frames:
        if light_prop_cut(f):
            if held is None:
                raise ValueError("a light prop is cut in the take's first frame: no frame to hold")
            out.append(held)
            since = 0
        elif since < FADE_IN:
            since += 1
            out.append(mix(held, f, since / (FADE_IN + 1)))
        else:
            out.append(f)
            held = f
    return out


def fit_grade(first: Image.Image, pose: str) -> np.ndarray:
    """4x3 affine taking the keyed first frame's colours to the start pose's.

    Both are 384px sheets. Only pixels opaque in both count, and the eyes (the
    notch draws its own, and a take's may sit a pixel off) are left out, by
    the anchors gen-notch-mascot.py measured, widened like the strip test's.
    """
    ref = np.asarray(Image.open(MASCOT / "poses" / f"{pose}.png").convert("RGBA")).astype(np.float64)
    got = np.asarray(first).astype(np.float64)
    anchors = json.loads((MASCOT / "notch/anchors.json").read_text())
    x0, y0, x1, _ = anchors["crop"]  # a square, in sheet px
    side = x1 - x0
    yy, xx = np.mgrid[: ref.shape[0], : ref.shape[1]]
    u, v = (xx + 0.5 - x0) / side, (yy + 0.5 - y0) / side
    eyes = np.zeros(ref.shape[:2], bool)
    for e in anchors["poses"][pose]["eyes"]:
        eyes |= ((u - e["cx"]) / (e["rx"] * 2.2)) ** 2 + ((v - e["cy"]) / (e["ry"] * 2)) ** 2 < 1
    m = (ref[..., 3] > 242) & (got[..., 3] > 242) & ~eyes
    grade, *_ = np.linalg.lstsq(np.c_[got[..., :3][m], np.ones(m.sum())], ref[..., :3][m], rcond=None)
    return grade


def main() -> None:
    clip, name, loop, start = Path(sys.argv[1]), sys.argv[2], sys.argv[3] == "1", sys.argv[4]
    out = OUT / name
    f24 = out / "frames24"
    f24.mkdir(parents=True, exist_ok=True)
    for p in f24.glob("*.png"):  # a shorter re-key must not encode the last one's tail
        p.unlink()
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(clip), "-an", f"{tmp}/%03d.png"], check=True)
        raw = sorted(Path(tmp).glob("*.png"))[: int(sys.argv[5]) if len(sys.argv) > 5 else None]
        first, _ = key_frame(np.asarray(Image.open(raw[0]).convert("RGB")))
        grade = fit_grade(resize_rgba(Image.fromarray(first, "RGBA"), 384), start)
        strengths = []
        frames = []
        for i, p in enumerate(raw):
            rgba, s = key_frame(np.asarray(Image.open(p).convert("RGB")), grade)
            strengths.append(s)
            im = resize_rgba(Image.fromarray(rgba, "RGBA"), 384)
            im.save(f24 / f"{i:03d}.png")
            frames.append(im)
    # Videos with alpha at 24 fps.
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-framerate", "24", "-i", f"{f24}/%03d.png",
                    "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "34",
                    "-row-mt", "1", "-auto-alt-ref", "0", str(out / f"{name}.webm")], check=True)
    # VideoToolbox defaults to premultiplied alpha; PNG frames are straight RGBA.
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-framerate", "24", "-i", f"{f24}/%03d.png",
                    "-vf", "format=gbrap,premultiply=planes=7:inplace=1,format=bgra",
                    "-c:v", "hevc_videotoolbox", "-alpha_quality", "0.8", "-q:v", "60",
                    "-tag:v", "hvc1", "-pix_fmt", "bgra", str(out / f"{name}.mov")], check=True)
    frames[0].save(out / f"{name}.poster.png", optimize=True)
    # Notch strip: every other frame (12 fps). Framed like the notch pose
    # layers (sheet crop 60,46-348,334) plus PAD of that box on every side, so
    # hops and props that leave the pose box are not cut; the player draws the
    # frame (1 + 2*pad) times the pose box, centred on it. 45 px a side reaches
    # the take's own top edge (the sheet's y 1): with 36, the sheet's room left
    # and right, a hop the take holds whole still lost its cap's top row. Past
    # the sheet's right edge the frame is clear. The pose box lands on 128 px,
    # the notch layers' size, so the character keeps the still's scale. A light
    # prop that the take's top edge cuts is held back, then fades in whole
    # (fade_in_cut_props).
    base = (60, 46, 348, 334)
    side = 45  # px of the 384 sheet; a multiple of 9, so the frame is whole px
    box = (base[0] - side, base[1] - side, base[2] + side, base[3] + side)
    pad = side / (base[2] - base[0])
    size = (box[2] - box[0]) * 128 // (base[2] - base[0])  # 168
    cropped = [np.asarray(resize_rgba(f.crop(box), size)) for f in frames[::2]]
    notch = [Image.fromarray(f, "RGBA") for f in fade_in_cut_props(cropped)]
    strip = Image.new("RGBA", (size * len(notch), size), (0, 0, 0, 0))
    for i, f in enumerate(notch):
        strip.paste(f, (size * i, 0), f)
    strip.save(out / f"{name}.strip.webp", "WEBP", quality=82, method=6)
    meta = {"frames": len(notch), "fps": 12, "loop": loop, "frameSize": size, "pad": round(pad, 5)}
    (out / f"{name}.json").write_text(json.dumps(meta) + "\n")
    # QA sheet: 8 evenly spaced frames on dark and light grounds.
    pick = [frames[round(i * (len(frames) - 1) / 7)] for i in range(8)]
    sheet = Image.new("RGB", (8 * 192, 2 * 192), (0, 0, 0))
    for row, ground in enumerate([(17, 16, 21), (245, 244, 248)]):
        for i, f in enumerate(pick):
            tile = Image.new("RGB", (192, 192), ground)
            small = resize_rgba(f, 192)
            tile.paste(small, (0, 0), small)
            sheet.paste(tile, (i * 192, row * 192))
    sheet.save(out / "sheet.png")
    sizes = {p.name: p.stat().st_size for p in out.iterdir() if p.is_file()}
    print(json.dumps({"name": name, "frames24": len(frames), "plate_strength_min": round(min(strengths), 1),
                      "plate_strength_max": round(max(strengths), 1), "grade": grade.round(3).tolist(),
                      "sizes": sizes}))


if __name__ == "__main__":
    main()
