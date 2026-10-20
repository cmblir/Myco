"""Encode the keyed mascot clips for the app surfaces (MascotClip).

Input is what scripts/mascot-key-clip.py writes per clip: frames24/NNN.png,
RGBA 384px at 24 fps. Each clip ships at 2x the largest CSS box a surface
draws it in, as a pair the engine sniff picks from plus a still:

  <name>.webm        VP9 + alpha (Chromium)
  <name>.mov         HEVC + alpha, hvc1 (WKWebView)
  <name>.poster.png  frame 0, the pose the clip starts and ends on

The keyer's despill clamps green to max(red, blue), which leaves light that
picked up the green plate (the absorb orb's halo, celebrate's sparkles, the
cap's rim) teal. Green above red is spill in this character's palette, so it
is moved onto red and blue: the halo comes out lavender, like the cap's
underside, instead of teal on both grounds.

absorb's orb drops in from above the source frame, so its first frames cut it
on a hard line that sits mid-tile in the app; a fade over the top rows lets it
arrive instead. The fade covers only the frames the orb falls through: on the
later hop it turned the cap's dome see-through.

celebrate is a second take (celebrate-retake): the first one's hops cut the
cap flat on the frame top and its big sparkle on the right edge.
check_edges stops the build on any frame that runs off the frame.

usage: python3 scripts/mascot-app-clips.py <keyed-clips-dir>  (run from app/)
"""

import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

OUT = Path("src/assets/mascot/clips")

# name -> (source clip, px, top fade in source px, last faded frame). px = 2x
# the largest box in lib/mascotClips.ts' SURFACE_CLIPS; the test holds the two
# in step. absorb's orb has left the fade band by frame 17 (nothing opaque in
# it from there to the hop at 68).
CLIPS = {
    "welcome": ("welcome", 256, 0, 0),  # About hero 128, wizard step 1 96
    "not-found": ("not-found", 224, 0, 0),  # abstain card 112, spotlight 56
    "worried": ("worried", 224, 0, 0),  # crash screen 112
    "celebrate": ("celebrate-retake", 192, 0, 0),  # ingest hero 96, study end 96
    "absorb": ("absorb-v2", 192, 40, 16),  # ingest hero 96
    "read-loop": ("read-loop", 192, 0, 0),  # ingest hero 96
    "think": ("think", 192, 0, 0),  # Ask pending 96
    "look-around": ("look-around", 288, 0, 0),  # Ask empty 144
}


def despill(rgba: np.ndarray) -> np.ndarray:
    px = rgba.astype(np.float32)
    spill = np.maximum(px[:, :, 1] - px[:, :, 0], 0)
    px[:, :, 1] -= spill
    px[:, :, 0] += spill * 0.5
    px[:, :, 2] += spill * 0.5
    return np.clip(px, 0, 255).round().astype(np.uint8)


def fade_top(rgba: np.ndarray, rows: int) -> np.ndarray:
    # The keyer zeroes the outer 3px ring; ramp alpha up from there (smoothstep).
    t = np.clip((np.arange(rgba.shape[0], dtype=np.float32) - 3) / rows, 0, 1)
    out = rgba.astype(np.float32)
    out[:, :, 3] *= (t * t * (3 - 2 * t))[:, None]
    return out.round().astype(np.uint8)


def resize_rgba(im: Image.Image, size: int) -> Image.Image:
    return im.convert("RGBa").resize((size, size), Image.Resampling.LANCZOS).convert("RGBA")


# Nothing may run off the frame (the motion spec's "no clipping"). Once
# resized, a cap or sparkle cut by the frame leaves 30 to 60 alpha on the
# outermost row or column (the first celebrate take). A silhouette that only
# touches the frame (absorb's hop apex, which loses under a source pixel)
# leaves Lanczos ringing of 5 at most.
EDGE_ALPHA = 16


def check_edges(name: str, i: int, out: Image.Image) -> None:
    a = np.asarray(out)[:, :, 3]
    edge = int(max(a[0].max(), a[-1].max(), a[:, 0].max(), a[:, -1].max()))
    if edge > EDGE_ALPHA:
        sys.exit(f"{name}: frame {i} runs off the frame (edge alpha {edge}); use a take that stays inside it")


def encode(name: str, frames: Path, size: int, fade: int, fade_until: int) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        src = sorted(frames.glob("*.png"))
        for i, p in enumerate(src):
            px = despill(np.asarray(Image.open(p).convert("RGBA")))
            im = Image.fromarray(fade_top(px, fade) if fade and i <= fade_until else px, "RGBA")
            out = resize_rgba(im, size)
            check_edges(name, i, out)
            out.save(f"{tmp}/{i:03d}.png")
            if i == 0:
                out.save(OUT / f"{name}.poster.png", optimize=True)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-framerate", "24", "-i", f"{tmp}/%03d.png",
                        "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "34",
                        "-row-mt", "1", "-auto-alt-ref", "0", "-an", str(OUT / f"{name}.webm")], check=True)
        # VideoToolbox defaults to premultiplied alpha; PNG frames are straight RGBA.
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-framerate", "24", "-i", f"{tmp}/%03d.png",
                        "-vf", "format=gbrap,premultiply=planes=7:inplace=1,format=bgra",
                        "-c:v", "hevc_videotoolbox", "-alpha_quality", "0.8", "-q:v", "60",
                        "-tag:v", "hvc1", "-pix_fmt", "bgra", "-an", str(OUT / f"{name}.mov")], check=True)


def main() -> None:
    keyed = Path(sys.argv[1])
    OUT.mkdir(parents=True, exist_ok=True)
    for name, (source, size, fade, fade_until) in CLIPS.items():
        encode(name, keyed / source / "frames24", size, fade, fade_until)
        sizes = {p.name: p.stat().st_size for p in OUT.glob(f"{name}.*")}
        print(name, size, sizes)
    total = sum(p.stat().st_size for p in OUT.iterdir() if p.is_file())
    print(f"total {total / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
