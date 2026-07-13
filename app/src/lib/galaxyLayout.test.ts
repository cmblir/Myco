// Multi-galaxy layout geometry + folder grouping (pure logic).
import { describe, expect, it } from "vitest";
import {
  galaxyAnchors,
  galaxyNormal,
  galaxyRingRadius,
  galaxySizeBoost,
} from "./galaxyLayout";
import { folderGroups } from "./graphData";

describe("galaxyAnchors", () => {
  it("returns the origin for a single galaxy and [] for none", () => {
    expect(galaxyAnchors(0, 45, 10)).toEqual([]);
    expect(galaxyAnchors(1, 45, 10)).toEqual([{ x: 0, y: 0, z: 0 }]);
  });

  it("scatters G galaxies on a flattened shell with a seeded radius wobble", () => {
    const anchors = galaxyAnchors(5, 45, 30);
    const r = galaxyRingRadius(5, 45, 30);
    expect(anchors).toHaveLength(5);
    for (const a of anchors) {
      const d = Math.hypot(a.x, a.y, a.z);
      expect(d).toBeGreaterThan(r * 0.5);
      expect(d).toBeLessThanOrEqual(r * 1.21); // wobble ceiling 1.2×
      expect(Math.abs(a.y)).toBeLessThanOrEqual(r * 0.67); // oblate
    }
    // Every anchor pair sits farther apart than a group's own orbit ring —
    // galaxies must not overlap.
    const groupR = 45 * (0.35 + 0.07 * Math.sqrt(30));
    for (let i = 0; i < anchors.length; i++) {
      for (let j = i + 1; j < anchors.length; j++) {
        const d = Math.hypot(
          anchors[i].x - anchors[j].x,
          anchors[i].y - anchors[j].y,
          anchors[i].z - anchors[j].z,
        );
        expect(d).toBeGreaterThan(groupR * 2);
      }
    }
    // Deterministic: identical inputs, identical scatter.
    expect(galaxyAnchors(5, 45, 30)).toEqual(anchors);
  });

  it("ring radius grows with galaxy count and group size", () => {
    expect(galaxyRingRadius(8, 45, 30)).toBeGreaterThan(galaxyRingRadius(3, 45, 30));
    expect(galaxyRingRadius(3, 45, 200)).toBeGreaterThan(galaxyRingRadius(3, 45, 10));
  });
});

describe("galaxyNormal", () => {
  it("returns a deterministic unit axis, never edge-on", () => {
    for (const g of [0, 1, 5, 42]) {
      const n = galaxyNormal(g);
      expect(Math.hypot(n.x, n.y, n.z)).toBeCloseTo(1, 6);
      expect(n.y).toBeGreaterThan(0.4); // tilt capped ~63° from upright
      expect(galaxyNormal(g)).toEqual(n);
    }
    expect(galaxyNormal(1)).not.toEqual(galaxyNormal(2));
  });
});

describe("galaxySizeBoost", () => {
  it("grows with intra-link density from a 1× floor", () => {
    expect(galaxySizeBoost(10, 0)).toBe(1);
    expect(galaxySizeBoost(10, 20)).toBeGreaterThan(galaxySizeBoost(10, 5));
    // Same edge count, more members → lower density → smaller boost.
    expect(galaxySizeBoost(40, 20)).toBeLessThan(galaxySizeBoost(10, 20));
  });
});

describe("folderGroups", () => {
  const ROOT = "/vault";
  const noNb = (): string[] => [];
  const zero = (): number => 0; // single Louvain community for flat galaxies

  it("groups top-level folders into separate galaxies", () => {
    const ids = [
      "/vault/wiki/a.md",
      "/vault/wiki/b.md",
      "/vault/wiki/c.md",
      "/vault/raw/x.md",
      "/vault/raw/y.md",
      "/vault/raw/z.md",
    ];
    const g = folderGroups(ids, ROOT, noNb, zero)!;
    expect(g).not.toBeNull();
    expect(g.community["/vault/wiki/a.md"]).toBe(g.community["/vault/wiki/b.md"]);
    expect(g.community["/vault/raw/x.md"]).toBe(g.community["/vault/raw/y.md"]);
    expect(g.galaxy["/vault/wiki/a.md"]).not.toBe(g.galaxy["/vault/raw/x.md"]);
  });

  it("returns null for a flat vault (fewer than two clusters)", () => {
    const ids = ["/vault/wiki/a.md", "/vault/wiki/b.md", "/vault/wiki/c.md"];
    expect(folderGroups(ids, ROOT, noNb, zero)).toBeNull();
  });

  it("marks tiny folders (<3 members) as field stars (-1)", () => {
    const ids = [
      "/vault/wiki/a.md",
      "/vault/wiki/b.md",
      "/vault/wiki/c.md",
      "/vault/raw/x.md",
      "/vault/raw/y.md",
      "/vault/raw/z.md",
      "/vault/misc/only.md",
    ];
    const g = folderGroups(ids, ROOT, noNb, zero)!;
    expect(g.community["/vault/misc/only.md"]).toBe(-1);
  });

  it("ghost nodes adopt their first real neighbour's folder", () => {
    const ids = [
      "/vault/wiki/a.md",
      "/vault/wiki/b.md",
      "/vault/wiki/c.md",
      "/vault/raw/x.md",
      "/vault/raw/y.md",
      "/vault/raw/z.md",
      "ghost:missing",
    ];
    const nb = (id: string): string[] =>
      id === "ghost:missing" ? ["/vault/raw/x.md"] : [];
    const g = folderGroups(ids, ROOT, nb, zero)!;
    expect(g.community["ghost:missing"]).toBe(g.community["/vault/raw/x.md"]);
  });

  it("bigger clusters rank first (stable palette order)", () => {
    const ids = [
      "/vault/a/1.md",
      "/vault/a/2.md",
      "/vault/a/3.md",
      "/vault/b/1.md",
      "/vault/b/2.md",
      "/vault/b/3.md",
      "/vault/b/4.md",
    ];
    const g = folderGroups(ids, ROOT, noNb, zero)!;
    expect(g.community["/vault/b/1.md"]).toBe(0); // b has 4 members → rank 0
    expect(g.community["/vault/a/1.md"]).toBe(1);
  });
});
