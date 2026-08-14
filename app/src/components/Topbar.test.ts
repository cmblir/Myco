// computeModelPopPos is the clamping logic behind the model popover's
// position — the thing the "밀려서 나와" (pushed off-screen) bug report was
// about. Covers the branches that matter: right-aligned in the common case,
// clamped on both edges at a very narrow viewport, width shrunk when the
// popover would otherwise be wider than the viewport, and a floor on
// max-height for a very short window.

import { describe, expect, it } from "vitest";
import { computeModelPopPos } from "./Topbar";

describe("computeModelPopPos", () => {
  it("right-aligns to the pill on an ordinary desktop width", () => {
    const anchor = { right: 1264, bottom: 44 };
    const pos = computeModelPopPos(anchor, { width: 1280, height: 800 });
    expect(pos.width).toBe(340);
    expect(pos.left).toBe(1264 - 340);
    expect(pos.left + pos.width).toBeLessThanOrEqual(1280 - 8);
  });

  it("never crosses the left edge at a 320px viewport", () => {
    // A pill near the right edge of a 320px window would naively put
    // left = right - 340, deep negative — must clamp to the margin instead.
    const anchor = { right: 312, bottom: 44 };
    const pos = computeModelPopPos(anchor, { width: 320, height: 640 });
    expect(pos.left).toBeGreaterThanOrEqual(8);
    expect(pos.left + pos.width).toBeLessThanOrEqual(320 - 4); // 4px slack for rounding
  });

  it("never crosses the right edge even if the anchor reports past it", () => {
    const anchor = { right: 400, bottom: 44 }; // wider than the 320px viewport
    const pos = computeModelPopPos(anchor, { width: 320, height: 640 });
    expect(pos.left).toBeGreaterThanOrEqual(8);
    expect(pos.left + pos.width).toBeLessThanOrEqual(320 - 4);
  });

  it("shrinks to viewport width minus margins when 340px would overflow", () => {
    const anchor = { right: 300, bottom: 44 };
    const pos = computeModelPopPos(anchor, { width: 320, height: 640 });
    expect(pos.width).toBe(320 - 16);
  });

  it("floors max-height instead of going negative on a very short window", () => {
    const anchor = { right: 1264, bottom: 44 };
    const pos = computeModelPopPos(anchor, { width: 1280, height: 60 });
    expect(pos.maxHeight).toBeGreaterThanOrEqual(80);
  });

  it("fits fully within the viewport at every checked width (320/375/768/1280)", () => {
    for (const width of [320, 375, 768, 1280]) {
      const anchor = { right: width - 16, bottom: 44 };
      const pos = computeModelPopPos(anchor, { width, height: 800 });
      expect(pos.left).toBeGreaterThanOrEqual(4);
      expect(pos.left + pos.width).toBeLessThanOrEqual(width - 4);
    }
  });
});
