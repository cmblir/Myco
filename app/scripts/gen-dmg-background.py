#!/usr/bin/env python3
"""Generate the macOS DMG install-window background.

Regenerates src-tauri/dmg-background.png, the only new artwork in the installer
surface — the app icon and the Applications folder icon are composited by the
bundler from existing bundle assets, not by this script.

Design source: the myco design mockup, "설치 창 (DMG)" section. Quiet warm-white
ground, a single purple radial glow at top centre, and a wordless arrow standing
in for the drag-to-install caption (a caption could not be localised into a
baked PNG). No text is rendered, so this script has no font dependency.

Output is 2x the window size with a 144 dpi pHYs chunk, so AppKit reports the
image as 600x400 points and Finder draws it at full retina resolution.

Usage: python3 scripts/gen-dmg-background.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

# Window geometry in points — must match bundle.macOS.dmg.windowSize in
# src-tauri/tauri.conf.json, and the arrow is centred between the two
# icon positions declared there.
WINDOW_W, WINDOW_H = 600, 400
RETINA = 2  # 2x pixels, tagged 144 dpi (72 * RETINA)

GROUND = (0xFB, 0xFA, 0xF8)
GLOW = (0x6D, 0x45, 0xD6)
GLOW_PEAK = 0.08  # 8% at the centre, per the mockup
ARROW = (0xB8, 0xB1, 0xA5)

# Glow: centred at 50% / 8% of the window, fading out over 90% x 70% of the
# window scaled by the mockup's 70% transparent stop.
GLOW_CX, GLOW_CY = WINDOW_W * 0.5, WINDOW_H * 0.08
GLOW_RX, GLOW_RY = WINDOW_W * 0.9 * 0.7, WINDOW_H * 0.7 * 0.7

ARROW_CX, ARROW_CY = WINDOW_W * 0.5, 200  # icon row centre
SUPERSAMPLE = 3  # ImageDraw has no antialiasing; draw big, shrink down

OUT = Path(__file__).resolve().parent.parent / "src-tauri" / "dmg-background.png"


def glow_mask(width: int, height: int) -> Image.Image:
    """Radial alpha mask with a linear falloff, mirroring the mockup's
    `radial-gradient(90% 70% at 50% 8%, <purple>, transparent 70%)` at the 8%
    peak opacity the spec calls for."""
    mask = Image.new("L", (width, height))
    pixels = mask.load()
    for y in range(height):
        dy = ((y + 0.5) / RETINA - GLOW_CY) / GLOW_RY
        for x in range(width):
            dx = ((x + 0.5) / RETINA - GLOW_CX) / GLOW_RX
            falloff = 1.0 - (dx * dx + dy * dy) ** 0.5
            if falloff > 0:
                pixels[x, y] = round(255 * GLOW_PEAK * falloff)
    return mask


def draw_arrow(canvas: Image.Image) -> None:
    """Left-to-right arrow between the two icons. Geometry is the mockup's
    60x24 SVG, scaled to device pixels."""
    s = RETINA * SUPERSAMPLE
    big = Image.new("L", (canvas.width * SUPERSAMPLE, canvas.height * SUPERSAMPLE), 0)
    pen = ImageDraw.Draw(big)
    left, top = (ARROW_CX - 30) * s, (ARROW_CY - 12) * s
    pen.line(
        [(left + 4 * s, top + 12 * s), (left + 49 * s, top + 12 * s)],
        fill=255,
        width=round(2 * s),
    )
    pen.polygon(
        [
            (left + 48 * s, top + 6 * s),
            (left + 58 * s, top + 12 * s),
            (left + 48 * s, top + 18 * s),
        ],
        fill=255,
    )
    canvas.paste(
        ARROW, (0, 0), big.resize((canvas.width, canvas.height), Image.LANCZOS)
    )


def main() -> None:
    width, height = WINDOW_W * RETINA, WINDOW_H * RETINA
    canvas = Image.new("RGB", (width, height), GROUND)
    canvas.paste(GLOW, (0, 0), glow_mask(width, height))
    draw_arrow(canvas)
    canvas.save(OUT, "PNG", dpi=(72 * RETINA, 72 * RETINA))
    print(f"{OUT}  {canvas.size[0]}x{canvas.size[1]} {canvas.mode} @ {72 * RETINA}dpi")


if __name__ == "__main__":
    main()
