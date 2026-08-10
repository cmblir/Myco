import { describe, it, expect } from "vitest";
import Graph from "graphology";
import type { VaultGraph } from "./graphData";
import {
  applyCelestialLayout,
  applyRadialLayout,
  applySpiralLayout,
  applyStrataLayout,
  applyWalrusLayout,
  buildHyphaMat,
  clusterStart,
  type Position,
} from "./staticLayouts";

function makeGraph(
  nodes: { id: string; community: number; deg?: number }[],
): VaultGraph {
  const g = new Graph({ multi: false, type: "undirected" }) as VaultGraph;
  for (const n of nodes) {
    g.addNode(n.id, {
      label: n.id,
      x: 0,
      y: 0,
      z: 0,
      deg: n.deg ?? 1,
      size: 1,
      color: "#ffffff",
      community: n.community,
      galaxy: -1,
      isHub: false,
      intensity: 0.3,
    });
  }
  return g;
}

const pos = (g: VaultGraph, id: string): { x: number; y: number; z: number } => ({
  x: g.getNodeAttribute(id, "x"),
  y: g.getNodeAttribute(id, "y"),
  z: g.getNodeAttribute(id, "z"),
});

describe("applySpiralLayout", () => {
  const nodes = [
    ...Array.from({ length: 20 }, (_, i) => ({ id: `a${i}.md`, community: 0, deg: 20 - i })),
    ...Array.from({ length: 10 }, (_, i) => ({ id: `b${i}.md`, community: 1 })),
    ...Array.from({ length: 4 }, (_, i) => ({ id: `c${i}.md`, community: -1 })),
  ];

  it("keeps every node within the target radius envelope", () => {
    const g = makeGraph(nodes);
    applySpiralLayout(g, { targetRadius: 1000 });
    g.forEachNode((id) => {
      const p = pos(g, id);
      expect(Math.hypot(p.x, p.y)).toBeLessThan(1000 * 1.4);
      expect(Math.abs(p.z)).toBeLessThan(1000 * 0.3);
    });
  });

  it("puts the biggest community nearer the core than the field stars", () => {
    const g = makeGraph(nodes);
    applySpiralLayout(g, { targetRadius: 1000 });
    const meanR = (ids: string[]): number =>
      ids.reduce((s, id) => s + Math.hypot(pos(g, id).x, pos(g, id).y), 0) / ids.length;
    const big = meanR(nodes.filter((n) => n.community === 0).map((n) => n.id));
    const field = meanR(nodes.filter((n) => n.community === -1).map((n) => n.id));
    expect(big).toBeLessThan(field);
  });

  it("is deterministic", () => {
    const g1 = makeGraph(nodes);
    const g2 = makeGraph(nodes);
    applySpiralLayout(g1, { targetRadius: 800 });
    applySpiralLayout(g2, { targetRadius: 800 });
    g1.forEachNode((id) => {
      expect(pos(g1, id)).toEqual(pos(g2, id));
    });
  });
});

describe("applyStrataLayout", () => {
  const nodes = [
    { id: "old.md", community: 0 },
    { id: "mid.md", community: 0 },
    { id: "new.md", community: 0 },
    { id: "other.md", community: 1 },
    { id: "ghost.md", community: -1 },
  ];
  const mtimes = new Map([
    ["old.md", 1_000],
    ["mid.md", 2_000],
    ["new.md", 3_000],
    ["other.md", 2_500],
  ]);

  it("orders x by mtime with unknowns at the oldest edge", () => {
    const g = makeGraph(nodes);
    applyStrataLayout(g, { mtimes, targetRadius: 500 });
    const x = (id: string): number => pos(g, id).x;
    expect(x("ghost.md")).toBeLessThan(x("old.md"));
    expect(x("old.md")).toBeLessThan(x("mid.md"));
    expect(x("mid.md")).toBeLessThan(x("other.md"));
    expect(x("other.md")).toBeLessThan(x("new.md"));
  });

  it("separates communities into distinct y bands", () => {
    const g = makeGraph(nodes);
    applyStrataLayout(g, { mtimes, targetRadius: 500 });
    const yA = pos(g, "old.md").y;
    const yB = pos(g, "other.md").y;
    expect(Math.abs(yA - yB)).toBeGreaterThan(50);
  });

  it("survives a null mtimes map (everything ranks equal-old)", () => {
    const g = makeGraph(nodes);
    applyStrataLayout(g, { mtimes: null, targetRadius: 500 });
    g.forEachNode((id) => {
      expect(Number.isFinite(pos(g, id).x)).toBe(true);
    });
  });

  it("returns a date axis whose ticks ascend in x and carry no duplicate labels", () => {
    const g = makeGraph(nodes);
    // A multi-year span so year-granularity labels could collide without dedup.
    const yr = 365 * 86_400_000;
    const spread = new Map([
      ["old.md", 0],
      ["mid.md", yr],
      ["new.md", 2 * yr],
      ["other.md", 3 * yr],
    ]);
    const { ticks, yTop, yBottom } = applyStrataLayout(g, {
      mtimes: spread,
      targetRadius: 500,
    });
    expect(ticks.length).toBeGreaterThan(1);
    // The "before memory" marker (unknown) leads, then dated ticks ascend in x.
    const dated = ticks.filter((t) => !t.unknown);
    for (let i = 1; i < dated.length; i++) {
      expect(dated[i].x).toBeGreaterThan(dated[i - 1].x);
    }
    const labels = dated.map((t) => t.label);
    expect(new Set(labels).size).toBe(labels.length); // no duplicate period labels
    expect(yTop).toBeGreaterThan(yBottom);
  });
});

describe("applyCelestialLayout", () => {
  const nodes = [
    ...Array.from({ length: 12 }, (_, i) => ({ id: `a${i}.md`, community: 0, deg: 12 - i })),
    ...Array.from({ length: 6 }, (_, i) => ({ id: `b${i}.md`, community: 1 })),
    ...Array.from({ length: 3 }, (_, i) => ({ id: `c${i}.md`, community: 2 })),
  ];

  it("puts every note on the sphere shell (small radial jitter allowed)", () => {
    const g = makeGraph(nodes);
    applyCelestialLayout(g, { targetRadius: 900 });
    g.forEachNode((id) => {
      const p = pos(g, id);
      const r = Math.hypot(p.x, p.y, p.z);
      expect(r).toBeGreaterThan(900 * 0.95);
      expect(r).toBeLessThan(900 * 1.05);
    });
  });

  it("keeps a community's constellation patch tighter than the whole sky", () => {
    const g = makeGraph(nodes);
    applyCelestialLayout(g, { targetRadius: 900 });
    const ids = nodes.filter((n) => n.community === 1).map((n) => n.id);
    const ps = ids.map((id) => pos(g, id));
    const c = ps.reduce(
      (s, p) => ({ x: s.x + p.x / ps.length, y: s.y + p.y / ps.length, z: s.z + p.z / ps.length }),
      { x: 0, y: 0, z: 0 },
    );
    for (const p of ps) {
      expect(Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z)).toBeLessThan(900);
    }
  });

  it("is deterministic", () => {
    const g1 = makeGraph(nodes);
    const g2 = makeGraph(nodes);
    applyCelestialLayout(g1, { targetRadius: 700 });
    applyCelestialLayout(g2, { targetRadius: 700 });
    g1.forEachNode((id) => expect(pos(g1, id)).toEqual(pos(g2, id)));
  });
});

describe("applyRadialLayout", () => {
  // hub links to m1..m3; m1 links to leaf; orphan is disconnected.
  const nodes = [
    { id: "hub.md", community: 0, deg: 3 },
    { id: "m1.md", community: 0, deg: 2 },
    { id: "m2.md", community: 0, deg: 1 },
    { id: "m3.md", community: 1, deg: 1 },
    { id: "leaf.md", community: 1, deg: 1 },
    { id: "orphan.md", community: -1, deg: 0 },
  ];
  const wire = (g: VaultGraph): void => {
    g.addEdge("hub.md", "m1.md");
    g.addEdge("hub.md", "m2.md");
    g.addEdge("hub.md", "m3.md");
    g.addEdge("m1.md", "leaf.md");
  };

  it("centres the top hub and orders shells by BFS depth", () => {
    const g = makeGraph(nodes);
    wire(g);
    applyRadialLayout(g, { targetRadius: 600 });
    const r = (id: string): number => {
      const p = pos(g, id);
      return Math.hypot(p.x, p.y, p.z);
    };
    expect(r("hub.md")).toBe(0);
    expect(r("m1.md")).toBeGreaterThan(0);
    expect(r("leaf.md")).toBeGreaterThan(r("m1.md"))
    expect(r("orphan.md")).toBeGreaterThan(r("leaf.md")); // outermost orbit
  });

  it("is deterministic", () => {
    const g1 = makeGraph(nodes);
    const g2 = makeGraph(nodes);
    wire(g1);
    wire(g2);
    applyRadialLayout(g1, { targetRadius: 600 });
    applyRadialLayout(g2, { targetRadius: 600 });
    g1.forEachNode((id) => expect(pos(g1, id)).toEqual(pos(g2, id)));
  });
});

describe("applyWalrusLayout", () => {
  // A small tree: hub → 3 children, one of which has 2 grandchildren.
  const build = (): VaultGraph => {
    const g = makeGraph([
      { id: "hub.md", community: 0, deg: 3 },
      { id: "a.md", community: 0, deg: 2 },
      { id: "b.md", community: 1, deg: 1 },
      { id: "c.md", community: 1, deg: 1 },
      { id: "a1.md", community: 0, deg: 1 },
      { id: "a2.md", community: 0, deg: 1 },
      { id: "lonely.md", community: -1, deg: 0 }, // disconnected
    ]);
    g.addEdge("hub.md", "a.md");
    g.addEdge("hub.md", "b.md");
    g.addEdge("hub.md", "c.md");
    g.addEdge("a.md", "a1.md");
    g.addEdge("a.md", "a2.md");
    return g;
  };

  it("roots the busiest hub at the centre and gives every node a finite position", () => {
    const g = build();
    applyWalrusLayout(g, { targetRadius: 500 });
    const hub = pos(g, "hub.md");
    expect(Math.hypot(hub.x, hub.y, hub.z)).toBeLessThan(1); // root at origin
    g.forEachNode((id) => {
      const p = pos(g, id);
      expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)).toBe(true);
    });
  });

  it("grows children outward — a grandchild sits farther from the root than its parent", () => {
    const g = build();
    applyWalrusLayout(g, { targetRadius: 500 });
    const r = (id: string): number => {
      const p = pos(g, id);
      return Math.hypot(p.x, p.y, p.z);
    };
    expect(r("a.md")).toBeGreaterThan(r("hub.md"));
    expect(r("a1.md")).toBeGreaterThan(r("a.md"));
  });

  it("places a disconnected component out on the boundary shell, not on the root", () => {
    const g = build();
    applyWalrusLayout(g, { targetRadius: 500 });
    const p = pos(g, "lonely.md");
    expect(Math.hypot(p.x, p.y, p.z)).toBeGreaterThan(100);
  });

  it("spreads a hub's heavy branches into DISTINCT directions (no collapsed blob)", () => {
    // Root → 6 branches, each a fan of 24 leaves. The 6 branch subtrees must
    // point in clearly different directions, or the layout is an unreadable ball.
    const nodes: { id: string; community: number; deg?: number }[] = [
      { id: "root", community: 0, deg: 100 }, // the vault hub — highest degree
    ];
    for (let b = 0; b < 6; b++) {
      nodes.push({ id: `b${b}`, community: b, deg: 25 });
      for (let i = 0; i < 24; i++) nodes.push({ id: `b${b}_${i}`, community: b, deg: 1 });
    }
    const g = makeGraph(nodes);
    for (let b = 0; b < 6; b++) {
      g.addEdge("root", `b${b}`);
      for (let i = 0; i < 24; i++) g.addEdge(`b${b}`, `b${b}_${i}`);
    }
    applyWalrusLayout(g, { targetRadius: 600 });
    // Each branch's outward direction = its hub node's unit position.
    const dirs = Array.from({ length: 6 }, (_, b) => {
      const p = pos(g, `b${b}`);
      const r = Math.hypot(p.x, p.y, p.z) || 1;
      return [p.x / r, p.y / r, p.z / r];
    });
    // The closest pair of branch directions must still be well separated
    // (dot < 0.9 ≈ >25° apart) — a blob would have them nearly parallel.
    let maxDot = -1;
    for (let i = 0; i < 6; i++)
      for (let j = i + 1; j < 6; j++) {
        const d = dirs[i][0] * dirs[j][0] + dirs[i][1] * dirs[j][1] + dirs[i][2] * dirs[j][2];
        maxDot = Math.max(maxDot, d);
      }
    expect(maxDot).toBeLessThan(0.9);
    // And the field genuinely fills space (bounding sphere near targetRadius).
    let far = 0;
    g.forEachNode((id) => {
      const p = pos(g, id);
      far = Math.max(far, Math.hypot(p.x, p.y, p.z));
    });
    expect(far).toBeGreaterThan(400);
  });
});

describe("clusterStart", () => {
  it("is deterministic per id and differs across ids", () => {
    expect(clusterStart("a.md", 30)).toEqual(clusterStart("a.md", 30));
    expect(clusterStart("a.md", 30)).not.toEqual(clusterStart("b.md", 30));
  });

  it("stays within the requested radius", () => {
    for (const id of ["a.md", "b.md", "c.md"]) {
      const p = clusterStart(id, 30);
      expect(Math.abs(p.x)).toBeLessThanOrEqual(15);
      expect(Math.abs(p.y)).toBeLessThanOrEqual(15);
      expect(Math.abs(p.z)).toBeLessThanOrEqual(15);
    }
  });
});

describe("buildHyphaMat", () => {
  // A fixed lookup table posOf reads from, so tests control exact positions
  // instead of depending on any layout algorithm.
  const posMap = (table: Record<string, Position>) => (id: string): Position =>
    table[id] ?? { x: 0, y: 0, z: 0 };

  it("every hypha starts and ends EXACTLY at its edge's two note positions", () => {
    // The one thing the old growMycelium picture got wrong: threads that
    // passed near two notes without actually connecting them. A single-edge
    // graph makes the check unambiguous — the whole bucket is that one edge.
    const g = makeGraph([
      { id: "a.md", community: 0, deg: 1 },
      { id: "b.md", community: 0, deg: 1 },
    ]);
    g.addEdge("a.md", "b.md");
    const table = { "a.md": { x: 10, y: 20, z: 30 }, "b.md": { x: 110, y: -40, z: 5 } };
    const buckets = buildHyphaMat(g, posMap(table));
    expect(buckets.length).toBe(1);
    const p = buckets[0].positions;
    expect([p[0], p[1], p[2]]).toEqual([10, 20, 30]);
    const last = p.length;
    expect([p[last - 3], p[last - 2], p[last - 1]]).toEqual([110, -40, 5]);
  });

  it("wanders off the straight line between the two notes — organic, not a graph line", () => {
    const g = makeGraph([
      { id: "a.md", community: 0, deg: 1 },
      { id: "b.md", community: 0, deg: 1 },
    ]);
    g.addEdge("a.md", "b.md");
    const table = { "a.md": { x: 0, y: 0, z: 0 }, "b.md": { x: 1000, y: 0, z: 0 } };
    const buckets = buildHyphaMat(g, posMap(table));
    const p = buckets[0].positions;
    let maxOffLine = 0;
    for (let i = 0; i < p.length; i += 3) {
      // The straight line runs along X, so any Y/Z component IS the deviation.
      maxOffLine = Math.max(maxOffLine, Math.abs(p[i + 1]), Math.abs(p[i + 2]));
    }
    expect(maxOffLine).toBeGreaterThan(1);
    // But it must not wander wildly off — still reads as running BETWEEN them.
    expect(maxOffLine).toBeLessThan(1000 * 0.3);
  });

  it("buckets a hub-to-hub edge thicker than a leaf-to-leaf edge", () => {
    const g = makeGraph([
      { id: "hub1.md", community: 0 },
      { id: "hub2.md", community: 0 },
      { id: "leaf1.md", community: 0 },
      { id: "leaf2.md", community: 0 },
      ...Array.from({ length: 18 }, (_, i) => ({ id: `filler${i}.md`, community: 0 })),
    ]);
    g.addEdge("hub1.md", "hub2.md");
    g.addEdge("leaf1.md", "leaf2.md");
    // buildHyphaMat reads LIVE graph.degree(), not a stored attribute — give
    // both hubs plenty of other neighbours so they actually outrank the leaves.
    for (let i = 0; i < 18; i++) {
      g.addEdge("hub1.md", `filler${i}.md`);
      g.addEdge("hub2.md", `filler${i}.md`);
    }
    // Every node gets its own unique, well-separated x — a bucket can then be
    // found unambiguously by which node's coordinate it contains.
    const table: Record<string, Position> = {};
    g.nodes().forEach((id, i) => {
      table[id] = { x: i * 1000, y: 0, z: 0 };
    });
    const buckets = buildHyphaMat(g, posMap(table));
    const widthContaining = (id: string): number => {
      const target = table[id].x;
      for (const b of buckets) {
        for (let i = 0; i < b.positions.length; i += 3) {
          if (Math.abs(b.positions[i] - target) < 1e-6) return b.width;
        }
      }
      throw new Error(`no bucket contains ${id}`);
    };
    // hub1.md's coordinate appears in its own hub-hub edge FIRST (buckets are
    // scanned thickest-first), so this reads that edge's width, not a filler's.
    expect(widthContaining("hub1.md")).toBeGreaterThan(widthContaining("leaf1.md"));
  });

  it("reveals edges in ascending, non-decreasing growth order per bucket", () => {
    const g = makeGraph([
      { id: "hub.md", community: 0, deg: 5 },
      ...Array.from({ length: 5 }, (_, i) => ({ id: `n${i}.md`, community: 0, deg: 1 })),
    ]);
    for (let i = 0; i < 5; i++) g.addEdge("hub.md", `n${i}.md`);
    const table: Record<string, Position> = { "hub.md": { x: 0, y: 0, z: 0 } };
    for (let i = 0; i < 5; i++) table[`n${i}.md`] = { x: (i + 1) * 10, y: 0, z: 0 };
    const buckets = buildHyphaMat(g, posMap(table));
    for (const b of buckets) {
      for (let i = 1; i < b.birth.length; i++) {
        expect(b.birth[i]).toBeGreaterThanOrEqual(b.birth[i - 1]);
      }
    }
  });

  it("is deterministic — same graph and positions lay out identically twice", () => {
    const g = makeGraph([
      { id: "a.md", community: 0, deg: 2 },
      { id: "b.md", community: 0, deg: 2 },
      { id: "c.md", community: 0, deg: 1 },
    ]);
    g.addEdge("a.md", "b.md");
    g.addEdge("b.md", "c.md");
    const table: Record<string, Position> = {
      "a.md": { x: 0, y: 0, z: 0 },
      "b.md": { x: 50, y: 10, z: 0 },
      "c.md": { x: 90, y: -5, z: 20 },
    };
    const a = buildHyphaMat(g, posMap(table));
    const b = buildHyphaMat(g, posMap(table));
    expect(a).toEqual(b);
  });

  it("does not throw on an edgeless graph", () => {
    const g = makeGraph([{ id: "solo.md", community: -1 }]);
    expect(() => buildHyphaMat(g, () => ({ x: 0, y: 0, z: 0 }))).not.toThrow();
    expect(buildHyphaMat(g, () => ({ x: 0, y: 0, z: 0 }))).toEqual([]);
  });

  it("produces only finite coordinates", () => {
    const g = makeGraph([
      { id: "a.md", community: 0 },
      { id: "b.md", community: 0 },
    ]);
    g.addEdge("a.md", "b.md");
    const buckets = buildHyphaMat(g, () => ({ x: 12, y: -8, z: 3 }));
    for (const b of buckets) {
      expect(b.positions.every((v) => Number.isFinite(v))).toBe(true);
    }
  });
});
