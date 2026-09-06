// fitTransform — pure centre+scale fit used by the atlas layout (no FA2 run).
import { describe, expect, it } from "vitest";
import { fitTransform } from "./atlasLayout";

describe("fitTransform", () => {
  it("returns the identity transform for empty input", () => {
    expect(fitTransform([], 40)).toEqual({ cx: 0, cy: 0, scale: 1 });
  });

  it("degenerate spread (single point) keeps scale 1 and centres on the point", () => {
    const t = fitTransform([{ x: 5, y: -3 }], 40);
    expect(t.cx).toBe(5);
    expect(t.cy).toBe(-3);
    expect(t.scale).toBe(1);
  });

  it("degenerate spread (all-identical points) keeps scale 1, centroid = the point", () => {
    const pts = [
      { x: 2.5, y: 7 },
      { x: 2.5, y: 7 },
      { x: 2.5, y: 7 },
    ];
    const t = fitTransform(pts, 100);
    expect(t.cx).toBeCloseTo(2.5, 12);
    expect(t.cy).toBeCloseTo(7, 12);
    expect(t.scale).toBe(1);
  });

  it("centres an offset square on its centroid and scales its radius to targetRadius", () => {
    // Square of side 2 centred at (11, 11): corner radius = sqrt(2).
    const pts = [
      { x: 10, y: 10 },
      { x: 12, y: 10 },
      { x: 12, y: 12 },
      { x: 10, y: 12 },
    ];
    const targetRadius = 40;
    const { cx, cy, scale } = fitTransform(pts, targetRadius);
    expect(cx).toBeCloseTo(11, 12);
    expect(cy).toBeCloseTo(11, 12);
    // Applying (p - c) * scale must land the farthest point at targetRadius.
    let maxR = 0;
    for (const p of pts) {
      maxR = Math.max(maxR, Math.hypot((p.x - cx) * scale, (p.y - cy) * scale));
    }
    expect(maxR).toBeCloseTo(targetRadius, 9);
  });

  it("scale is inversely proportional to spread", () => {
    const square = (side: number): { x: number; y: number }[] => [
      { x: 0, y: 0 },
      { x: side, y: 0 },
      { x: side, y: side },
      { x: 0, y: side },
    ];
    const small = fitTransform(square(2), 40);
    const big = fitTransform(square(4), 40);
    // Doubling the spread must halve the scale.
    expect(small.scale / big.scale).toBeCloseTo(2, 9);
  });
});
