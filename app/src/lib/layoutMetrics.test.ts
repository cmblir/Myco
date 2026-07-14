// computeLayoutMetrics — settled-layout centroid / p95 radius / per-community
// cluster metrics (pure math shared by the sim worker and the scene).
import { describe, expect, it } from "vitest";
import { computeLayoutMetrics, type MetricNode } from "./layoutMetrics";

const node = (x: number, y: number, z: number, community: number): MetricNode => ({
  x,
  y,
  z,
  community,
});

describe("computeLayoutMetrics", () => {
  it("empty input yields zeroed metrics and no clusters", () => {
    expect(computeLayoutMetrics([])).toEqual({
      cx: 0,
      cy: 0,
      cz: 0,
      radius: 0,
      n: 0,
      clusters: [],
    });
  });

  it("single cluster at a known offset: centroid correct, r = RMS of members", () => {
    // Four members around centre (5, -3, 2): deltas (±1,0,0) and (0,±2,0).
    const nodes = [
      node(6, -3, 2, 3),
      node(4, -3, 2, 3),
      node(5, -1, 2, 3),
      node(5, -5, 2, 3),
    ];
    const m = computeLayoutMetrics(nodes);
    expect(m.n).toBe(4);
    expect(m.cx).toBeCloseTo(5, 12);
    expect(m.cy).toBeCloseTo(-3, 12);
    expect(m.cz).toBeCloseTo(2, 12);
    expect(m.clusters).toHaveLength(1);
    const c = m.clusters[0];
    expect(c.community).toBe(3);
    expect(c.n).toBe(4);
    expect(c.x).toBeCloseTo(5, 12);
    expect(c.y).toBeCloseTo(-3, 12);
    expect(c.z).toBeCloseTo(2, 12);
    // RMS distance: sqrt((1 + 1 + 4 + 4) / 4) = sqrt(2.5).
    expect(c.r).toBeCloseTo(Math.sqrt(2.5), 9);
  });

  it("two clusters are sorted by size desc with correct centroids", () => {
    const nodes = [
      // Community 7: 3 members centred on (10, 0, 0).
      node(9, 0, 0, 7),
      node(11, 0, 0, 7),
      node(10, 0, 0, 7),
      // Community 2: 2 members centred on (-10, 4, 0).
      node(-11, 4, 0, 2),
      node(-9, 4, 0, 2),
    ];
    const m = computeLayoutMetrics(nodes);
    expect(m.clusters).toHaveLength(2);
    expect(m.clusters[0].community).toBe(7); // bigger first
    expect(m.clusters[0].n).toBe(3);
    expect(m.clusters[0].x).toBeCloseTo(10, 12);
    expect(m.clusters[0].y).toBeCloseTo(0, 12);
    expect(m.clusters[1].community).toBe(2);
    expect(m.clusters[1].n).toBe(2);
    expect(m.clusters[1].x).toBeCloseTo(-10, 12);
    expect(m.clusters[1].y).toBeCloseTo(4, 12);
  });

  it("community -1 nodes are excluded from clusters but counted globally", () => {
    const nodes = [
      node(0, 0, 0, 0),
      node(2, 0, 0, 0),
      node(10, 0, 0, -1), // orphan
    ];
    const m = computeLayoutMetrics(nodes);
    // Global centroid includes the orphan: (0 + 2 + 10) / 3 = 4.
    expect(m.n).toBe(3);
    expect(m.cx).toBeCloseTo(4, 12);
    // Distances from centroid: 4, 2, 6 → p95 index floor(2*0.95)=1 → 4.
    expect(m.radius).toBeCloseTo(4, 12);
    // But the orphan forms no cluster.
    expect(m.clusters).toHaveLength(1);
    expect(m.clusters[0].community).toBe(0);
    expect(m.clusters[0].n).toBe(2);
    expect(m.clusters[0].x).toBeCloseTo(1, 12);
  });

  it("radius is the 95th-percentile distance — one far outlier does not dominate", () => {
    // 100 points on a radius-5 ring around the origin plus one node 1000 away.
    const nodes: MetricNode[] = [];
    for (let i = 0; i < 100; i++) {
      const a = (i / 100) * Math.PI * 2;
      nodes.push(node(Math.cos(a) * 5, Math.sin(a) * 5, 0, 0));
    }
    nodes.push(node(1000, 0, 0, 0));
    const m = computeLayoutMetrics(nodes);
    // Centroid drifts to x ≈ 9.9; ring points sit ≤ ~15 from it while the
    // outlier sits ~990 away. p95 of 101 samples picks a ring point.
    expect(m.radius).toBeGreaterThanOrEqual(1);
    expect(m.radius).toBeLessThan(20);
  });
});
