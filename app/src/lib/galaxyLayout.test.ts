// Multi-galaxy layout geometry + folder grouping (pure logic).
import { describe, expect, it } from "vitest";
import {
  clusterOrbitRadius,
  galaxyAnchorsBySize,
  galaxyFootprint,
  galaxyNormal,
  galaxySizeBoost,
} from "./galaxyLayout";
import { folderGroups } from "./graphData";

describe("galaxyFootprint", () => {
  it("grows with node count", () => {
    expect(galaxyFootprint(1000, 45)).toBeGreaterThan(galaxyFootprint(50, 45));
  });

  // The cross-module invariant that used to be a silently-drifting comment:
  // a cluster's packing footprint must contain its worker orbit ring (members
  // orbit at ring × jitter ≤ ring), even for densely-boosted clusters —
  // otherwise packed neighbours visually overlap and the separation collapses.
  it("contains the worker orbit ring at every size (boost ≤ 2×)", () => {
    for (const count of [1, 4, 10, 50, 200, 1000, 10000]) {
      for (const boost of [1, 1.5, 2]) {
        expect(galaxyFootprint(count, 45)).toBeGreaterThan(
          clusterOrbitRadius(count, 45, boost),
        );
      }
    }
  });
});

describe("clusterOrbitRadius", () => {
  it("grows with member count and size boost", () => {
    expect(clusterOrbitRadius(100, 45)).toBeGreaterThan(clusterOrbitRadius(10, 45));
    expect(clusterOrbitRadius(10, 45, 1.5)).toBeGreaterThan(clusterOrbitRadius(10, 45, 1));
  });
});

describe("galaxyAnchorsBySize", () => {
  const dist = (p: { x: number; y: number; z: number }): number =>
    Math.hypot(p.x, p.y, p.z);

  it("returns one anchor per galaxy; origin for one, [] for none", () => {
    expect(galaxyAnchorsBySize([], 45)).toEqual([]);
    expect(galaxyAnchorsBySize([5], 45)).toEqual([{ x: 0, y: 0, z: 0 }]);
    expect(galaxyAnchorsBySize([5, 5, 5], 45)).toHaveLength(3);
  });

  it("anchors the biggest galaxy at the origin, packs the rest around it", () => {
    const a = galaxyAnchorsBySize([200, 9984], 45);
    // Biggest (index 1) is placed first → sits at the origin; the small one is
    // pushed out to clear it.
    expect(dist(a[1])).toBeCloseTo(0, 6);
    expect(dist(a[0])).toBeGreaterThan(0);
  });

  it("scatters irregularly — not an even shell (high radius variance)", () => {
    const counts = [80, 60, 50, 40, 30, 25, 20, 15];
    const a = galaxyAnchorsBySize(counts, 45);
    const radii = a.map(dist);
    const mean = radii.reduce((s, r) => s + r, 0) / radii.length;
    const variance =
      radii.reduce((s, r) => s + (r - mean) ** 2, 0) / radii.length;
    // A uniform shell would have ~zero variance; irregular packing spreads it.
    expect(Math.sqrt(variance) / mean).toBeGreaterThan(0.15);
  });

  it("keeps galaxies from fully overlapping (loose packing)", () => {
    const a = galaxyAnchorsBySize([50, 50, 50, 50], 45);
    for (let i = 0; i < a.length; i++) {
      for (let j = i + 1; j < a.length; j++) {
        const d = Math.hypot(a[i].x - a[j].x, a[i].y - a[j].y, a[i].z - a[j].z);
        expect(d).toBeGreaterThan(0);
      }
    }
  });

  it("is deterministic", () => {
    expect(galaxyAnchorsBySize([10, 20, 30], 45)).toEqual(
      galaxyAnchorsBySize([10, 20, 30], 45),
    );
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
