// Inter-community edge bundling — aggregation, arc sampling and width tiers.
import { describe, expect, it } from "vitest";
import { aggregateBundles, bundleArc, bundleTier, type Vec3 } from "./edgeBundles";

describe("aggregateBundles", () => {
  it("ignores same-community and negative-community edges", () => {
    const out = aggregateBundles(
      [
        { a: 1, b: 1 },
        { a: 1, b: 1 },
        { a: 1, b: 1 },
        { a: -1, b: 2 },
        { a: 2, b: -1 },
        { a: -1, b: -1 },
      ],
      { minCount: 1 },
    );
    expect(out).toEqual([]);
  });

  it("collapses (a,b) and (b,a) into one canonical pair with a < b", () => {
    const out = aggregateBundles(
      [
        { a: 2, b: 5 },
        { a: 5, b: 2 },
        { a: 2, b: 5 },
      ],
      { minCount: 1 },
    );
    expect(out).toEqual([{ a: 2, b: 5, count: 3 }]);
  });

  it("filters pairs below minCount (default 3)", () => {
    const edges = [
      { a: 0, b: 1 },
      { a: 0, b: 1 },
      { a: 0, b: 1 },
      { a: 0, b: 2 },
      { a: 0, b: 2 },
    ];
    // Default minCount = 3 drops the count-2 pair.
    expect(aggregateBundles(edges)).toEqual([{ a: 0, b: 1, count: 3 }]);
    // Explicit minCount = 2 keeps both.
    expect(aggregateBundles(edges, { minCount: 2 })).toHaveLength(2);
  });

  it("caps at maxBundles keeping the heaviest strands", () => {
    const edges: { a: number; b: number }[] = [];
    const push = (a: number, b: number, times: number): void => {
      for (let i = 0; i < times; i++) edges.push({ a, b });
    };
    push(0, 1, 5);
    push(0, 2, 4);
    push(0, 3, 3);
    const out = aggregateBundles(edges, { minCount: 1, maxBundles: 2 });
    expect(out).toHaveLength(2);
    expect(out.map((s) => s.count)).toEqual([5, 4]); // heaviest survive the cap
  });

  it("backbone: maxPerCommunity keeps only each side's heaviest strands", () => {
    const edges: { a: number; b: number }[] = [];
    const push = (a: number, b: number, times: number): void => {
      for (let i = 0; i < times; i++) edges.push({ a, b });
    };
    // Hub 0 relates to four others; each spoke community has only that one tie.
    push(0, 1, 9);
    push(0, 2, 8);
    push(0, 3, 7);
    push(0, 4, 6);
    push(3, 4, 5); // spoke-to-spoke strand
    const out = aggregateBundles(edges, { minCount: 1, maxPerCommunity: 2 });
    // Hub 0 is capped at its 2 heaviest (0-1, 0-2)... but 0-3 and 0-4 SURVIVE
    // because communities 3 and 4 still have quota — every topic keeps its own
    // strongest relations even to a saturated hub.
    expect(out).toContainEqual({ a: 0, b: 1, count: 9 });
    expect(out).toContainEqual({ a: 0, b: 2, count: 8 });
    expect(out).toContainEqual({ a: 0, b: 3, count: 7 });
    expect(out).toContainEqual({ a: 0, b: 4, count: 6 });
    // 3-4: both sides already at quota (3 spent it on 0-3, 4 on 0-4... 3 and 4
    // each have 1 strand — still under 2) → kept as well.
    expect(out).toContainEqual({ a: 3, b: 4, count: 5 });
    // Tighter quota of 1: hub keeps 0-1 only; 0-2/0-3/0-4 survive via the
    // spokes' own quota; 3-4 dies (both spokes spent).
    const tight = aggregateBundles(edges, { minCount: 1, maxPerCommunity: 1 });
    expect(tight).toContainEqual({ a: 0, b: 1, count: 9 });
    expect(tight).toContainEqual({ a: 0, b: 2, count: 8 });
    expect(tight).not.toContainEqual({ a: 3, b: 4, count: 5 });
  });

  it("sorts by count desc, then community ids asc for ties", () => {
    const edges: { a: number; b: number }[] = [];
    const push = (a: number, b: number, times: number): void => {
      for (let i = 0; i < times; i++) edges.push({ a, b });
    };
    push(3, 4, 2);
    push(0, 9, 2); // ties with (3,4) → lower a first
    push(1, 2, 6);
    const out = aggregateBundles(edges, { minCount: 1 });
    expect(out).toEqual([
      { a: 1, b: 2, count: 6 },
      { a: 0, b: 9, count: 2 },
      { a: 3, b: 4, count: 2 },
    ]);
  });
});

describe("bundleArc", () => {
  const len = (v: { x: number; y: number; z: number }): number =>
    Math.hypot(v.x, v.y, v.z);

  it("starts exactly at p0 and ends exactly at p1", () => {
    // Integer coords are exactly representable in the Float32Array output.
    const p0: Vec3 = { x: 10, y: 2, z: -4 };
    const p1: Vec3 = { x: -6, y: 8, z: 12 };
    const pts = bundleArc(p0, p1);
    expect(pts[0]).toBe(10);
    expect(pts[1]).toBe(2);
    expect(pts[2]).toBe(-4);
    expect(pts[pts.length - 3]).toBe(-6);
    expect(pts[pts.length - 2]).toBe(8);
    expect(pts[pts.length - 1]).toBe(12);
  });

  it("returns (segments+1)*3 floats", () => {
    const p0: Vec3 = { x: 1, y: 0, z: 0 };
    const p1: Vec3 = { x: 0, y: 1, z: 0 };
    expect(bundleArc(p0, p1)).toHaveLength(25 * 3); // default 24 segments
    expect(bundleArc(p0, p1, 10)).toHaveLength(11 * 3);
    expect(bundleArc(p0, p1, 1)).toHaveLength(2 * 3);
  });

  it("bows outward: the arc midpoint sits farther from the origin than the chord midpoint", () => {
    const p0: Vec3 = { x: 10, y: 0, z: 0 };
    const p1: Vec3 = { x: 0, y: 10, z: 0 };
    const pts = bundleArc(p0, p1, 24);
    const midIdx = 12 * 3; // t = 0.5
    const arcMid = { x: pts[midIdx], y: pts[midIdx + 1], z: pts[midIdx + 2] };
    const chordMid = {
      x: (p0.x + p1.x) / 2,
      y: (p0.y + p1.y) / 2,
      z: (p0.z + p1.z) / 2,
    };
    expect(len(arcMid)).toBeGreaterThan(len(chordMid));
  });

  it("a degenerate chord through the origin produces no NaN", () => {
    const pts = bundleArc({ x: -5, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }, 8);
    for (const v of pts) {
      expect(Number.isFinite(v)).toBe(true);
    }
    // The fallback bows along a chord-perpendicular, so the midpoint leaves
    // the chord line instead of collapsing onto it.
    const mid = { x: pts[4 * 3], y: pts[4 * 3 + 1], z: pts[4 * 3 + 2] };
    expect(len(mid)).toBeGreaterThan(0);
  });
});

describe("bundleTier", () => {
  it("maps counts onto width tiers at the 10 / 30 boundaries", () => {
    expect(bundleTier(9)).toBe(0);
    expect(bundleTier(10)).toBe(1);
    expect(bundleTier(29)).toBe(1);
    expect(bundleTier(30)).toBe(2);
  });
});
