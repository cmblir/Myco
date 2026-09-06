// convexHull — pure 2D monotone-chain hull used by the community hull layer.
// Only the exported function is exercised; the THREE-backed class is never
// instantiated (importing the module is safe in the node environment).
import { describe, expect, it } from "vitest";
import { convexHull } from "./communityHullLayer";

// Shoelace signed area: positive for counter-clockwise winding.
function signedArea(pts: { x: number; y: number }[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

describe("convexHull", () => {
  it("returns fewer than 3 unique points as-is (sorted, deduped)", () => {
    expect(convexHull([])).toEqual([]);
    expect(convexHull([{ x: 3, y: 4 }])).toEqual([{ x: 3, y: 4 }]);
    // Two points come back sorted by x then y.
    expect(
      convexHull([
        { x: 2, y: 2 },
        { x: 1, y: 1 },
      ]),
    ).toEqual([
      { x: 1, y: 1 },
      { x: 2, y: 2 },
    ]);
    // Duplicates collapse (dedup key rounds to 2 decimals) before the <3 check.
    expect(
      convexHull([
        { x: 1, y: 1 },
        { x: 1, y: 1 },
        { x: 2, y: 2 },
      ]),
    ).toEqual([
      { x: 1, y: 1 },
      { x: 2, y: 2 },
    ]);
  });

  it("square corners plus interior points yield exactly the 4 corners", () => {
    const corners = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 0, y: 4 },
    ];
    const hull = convexHull([
      ...corners,
      { x: 2, y: 2 },
      { x: 1, y: 3 },
      { x: 3, y: 1 },
    ]);
    expect(hull).toHaveLength(4);
    // Same 4 corners regardless of starting index; compare as sets of keys.
    const keys = (ps: { x: number; y: number }[]): string[] =>
      ps.map((p) => `${p.x},${p.y}`).sort();
    expect(keys(hull)).toEqual(keys(corners));
  });

  it("collinear points collapse to the two extreme endpoints (no crash)", () => {
    // The strict (<= 0) pop drops interior collinear points on both chains, so
    // the degenerate all-on-a-line input reduces to the segment's endpoints.
    const hull = convexHull([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
    ]);
    expect(hull.length).toBeLessThanOrEqual(2);
    expect(hull).toEqual([
      { x: 0, y: 0 },
      { x: 3, y: 3 },
    ]);
  });

  it("winds counter-clockwise (positive signed area) for a known polygon", () => {
    const hull = convexHull([
      { x: 0, y: 0 },
      { x: 6, y: 0 },
      { x: 7, y: 3 },
      { x: 3, y: 6 },
      { x: -1, y: 3 },
      { x: 3, y: 2 }, // interior
    ]);
    expect(hull.length).toBeGreaterThanOrEqual(3);
    expect(signedArea(hull)).toBeGreaterThan(0);
    // The square case winds CCW too, with the expected area of 16.
    const square = convexHull([
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 0, y: 4 },
      { x: 2, y: 2 },
    ]);
    expect(signedArea(square)).toBeCloseTo(16, 9);
  });
});
