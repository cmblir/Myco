// separateCommunities — the synapse-layout post-process that turns one FA2
// disc into spread ganglia. Pure geometry over node attrs.
import { describe, expect, it } from "vitest";
import Graph from "graphology";
import { separateCommunities } from "./atlasLayout";
import type { VaultGraph } from "./graphData";

// Build a graph where several communities all overlap near the origin (the
// "one disc" FA2 result on a densely cross-linked vault).
function overlappingCommunities(nComm: number, per: number): VaultGraph {
  const g = new Graph({ type: "undirected", multi: false });
  for (let c = 0; c < nComm; c++) {
    for (let i = 0; i < per; i++) {
      // every community sits in the same small blob around (0,0)
      g.addNode(`c${c}n${i}`, {
        x: Math.cos(i) * 5 + 0.1,
        y: Math.sin(i) * 5,
        z: 0,
        size: 4,
        community: c,
      });
    }
  }
  return g as unknown as VaultGraph;
}

function centroids(g: VaultGraph): Map<number, { x: number; y: number; n: number }> {
  const m = new Map<number, { x: number; y: number; n: number }>();
  g.forEachNode((_id, a) => {
    const e = m.get(a.community) ?? { x: 0, y: 0, n: 0 };
    e.x += a.x;
    e.y += a.y;
    e.n += 1;
    m.set(a.community, e);
  });
  for (const e of m.values()) {
    e.x /= e.n;
    e.y /= e.n;
  }
  return m;
}

describe("separateCommunities", () => {
  it("pushes overlapping community centroids apart", () => {
    const g = overlappingCommunities(6, 30);
    const before = centroids(g);
    // Before: every centroid is ~at the origin (min pair distance tiny).
    const bc = [...before.values()];
    let beforeMin = Infinity;
    for (let i = 0; i < bc.length; i++)
      for (let j = i + 1; j < bc.length; j++)
        beforeMin = Math.min(beforeMin, Math.hypot(bc[i].x - bc[j].x, bc[i].y - bc[j].y));
    expect(beforeMin).toBeLessThan(5);

    separateCommunities(g);

    const after = [...centroids(g).values()];
    let afterMin = Infinity;
    for (let i = 0; i < after.length; i++)
      for (let j = i + 1; j < after.length; j++)
        afterMin = Math.min(afterMin, Math.hypot(after[i].x - after[j].x, after[i].y - after[j].y));
    // After: every pair of ganglia sits well apart.
    expect(afterMin).toBeGreaterThan(40);
  });

  it("keeps each core's internal shape (relative offsets preserved up to scale)", () => {
    const g = overlappingCommunities(3, 20);
    separateCommunities(g);
    // Within a community, the spread (RMS radius) is non-zero → the FA2 shape
    // was scaled, not collapsed to a point.
    const c0: { x: number; y: number }[] = [];
    g.forEachNode((_id, a) => {
      if (a.community === 0) c0.push({ x: a.x, y: a.y });
    });
    let cx = 0;
    let cy = 0;
    for (const a of c0) {
      cx += a.x;
      cy += a.y;
    }
    cx /= c0.length;
    cy /= c0.length;
    let rms = 0;
    for (const a of c0) rms += (a.x - cx) ** 2 + (a.y - cy) ** 2;
    rms = Math.sqrt(rms / c0.length);
    expect(rms).toBeGreaterThan(1);
  });

  it("no-ops for a single community (nothing to separate)", () => {
    const g = overlappingCommunities(1, 20);
    const before = centroids(g).get(0)!;
    separateCommunities(g);
    const after = centroids(g).get(0)!;
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it("leaves community -1 (orphans / field stars) untouched", () => {
    const g = overlappingCommunities(3, 10);
    (g as unknown as Graph).addNode("orphan", {
      x: 999,
      y: -999,
      z: 0,
      size: 4,
      community: -1,
    });
    separateCommunities(g);
    const a = g.getNodeAttributes("orphan");
    expect(a.x).toBe(999);
    expect(a.y).toBe(-999);
  });
});
