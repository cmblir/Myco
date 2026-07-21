import { describe, it, expect } from "vitest";
import Graph from "graphology";
import type { VaultGraph } from "./graphData";
import {
  applyCelestialLayout,
  applyRadialLayout,
  applySpiralLayout,
  applyStrataLayout,
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
