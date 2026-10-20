"""Frame a shipped app clip (src/assets/mascot/clips/<name>.webm) as a notch strip.

For a clip whose green-plate take is not at hand: the app clip is already
keyed, so this decodes its VP9 alpha, scales each frame back to the 384 px
sheet and frames it as scripts/mascot-key-clip.py frames a strip (the notch
pose crop 60,46-348,334 plus 36 px a side: 160 px frames, pad 0.125, every
other frame for 12 fps). The app clips are not graded, so one colour fit per
clip (mascot-key-clip.py's fit_grade, the same 4x3 affine) takes its first
frame onto the start pose's colours, as the strip test asks.

Writes src/assets/mascot/motion/<name>.webp and <name>.json.
usage: python3 scripts/mascot-strip-from-clip.py <name> <loop:0|1> <from-pose>  (run from app/)
"""

import importlib.util
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

MASCOT = Path(__file__).resolve().parents[1] / "src/assets/mascot"
_spec = importlib.util.spec_from_file_location("keyer", Path(__file__).with_name("mascot-key-clip.py"))
keyer = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(keyer)


def main() -> None:
    name, loop, start = sys.argv[1], sys.argv[2] == "1", sys.argv[3]
    with tempfile.TemporaryDirectory() as tmp:
        # libvpx-vp9 as the decoder: ffmpeg's native one drops the alpha plane.
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-c:v", "libvpx-vp9", "-i",
                        str(MASCOT / "clips" / f"{name}.webm"), "-an", f"{tmp}/%03d.png"], check=True)
        frames = [keyer.resize_rgba(Image.open(p), 384) for p in sorted(Path(tmp).glob("*.png"))]
    grade = keyer.fit_grade(frames[0], start)

    def graded(im: Image.Image) -> Image.Image:
        a = np.asarray(im).astype(np.float64)
        rgb = np.clip(a[..., :3] @ grade[:3] + grade[3], 0, 255)
        rgb[a[..., 3] == 0] = 0
        return Image.fromarray(np.dstack((rgb, a[..., 3])).round().astype(np.uint8), "RGBA")

    base = (60, 46, 348, 334)
    side = 36
    box = (base[0] - side, base[1] - side, base[2] + side, base[3] + side)
    size = (box[2] - box[0]) * 128 // (base[2] - base[0])  # 160
    notch = [keyer.resize_rgba(graded(f).crop(box), size) for f in frames[::2]]
    strip = Image.new("RGBA", (size * len(notch), size), (0, 0, 0, 0))
    for i, f in enumerate(notch):
        strip.paste(f, (size * i, 0), f)
    out = MASCOT / "motion"
    strip.save(out / f"{name}.webp", "WEBP", quality=82, method=6)
    meta = {"frames": len(notch), "fps": 12, "loop": loop, "frameSize": size,
            "pad": round(side / (base[2] - base[0]), 5)}
    (out / f"{name}.json").write_text(json.dumps(meta) + "\n")
    print(json.dumps({"name": name, **meta, "bytes": (out / f"{name}.webp").stat().st_size}))


if __name__ == "__main__":
    main()
