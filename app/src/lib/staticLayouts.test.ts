import { describe, it, expect } from "vitest";
import Graph from "graphology";
import type { VaultGraph } from "./graphData";
import {
  applyCelestialLayout,
  applyRadialLayout,
  applySpiralLayout,
  applyStrataLayout,
  applyWalrusLayout,
  buildMatAdjacency,
  buildMyceliumMat,
  growMycelium,
  matPath,
  type HyphaNode,
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

// The real vault's shape (see the mycelium redesign brief): 1244 notes, ~440
// wikilinks, hub-heavy — one note holds 34 links. Deterministic (no
// Math.random) so a failing assertion reproduces every run.
function makeRealScaleGraph(): VaultGraph {
  const N = 1244;
  const ids = Array.from({ length: N }, (_, i) => `note-${i}.md`);
  const g = makeGraph(ids.map((id) => ({ id, community: 0 })));
  const addEdge = (a: string, b: string): void => {
    if (a !== b && !g.hasEdge(a, b)) g.addEdge(a, b);
  };
  for (let k = 1; k <= 34; k++) addEdge(ids[0], ids[k]);
  // The rest: small deterministic 2-3 node clusters spread across the
  // remaining notes, leaving plenty of true orphans between them (the real
  // vault's 440 edges over 1244 notes average under one link per note).
  let budget = 440 - 34;
  for (let i = 40; i < N - 1 && budget > 0; i += 3) {
    addEdge(ids[i], ids[i + 1]);
    budget--;
  }
  g.forEachNode((id) => g.setNodeAttribute(id, "deg", g.degree(id)));
  return g;
}

// BFS hop distance between two mat-node indices, over parent/child + bridge
// adjacency — built once and reused across many (a, b) queries.
function matHopDistances(mat: HyphaNode[]): (a: number, b: number) => number {
  const adj: number[][] = mat.map(() => []);
  mat.forEach((h, i) => {
    if (h.parent >= 0) {
      adj[i].push(h.parent);
      adj[h.parent].push(i);
    }
    if (h.bridgeTo != null) {
      adj[i].push(h.bridgeTo);
      adj[h.bridgeTo].push(i);
    }
  });
  return (a: number, b: number): number => {
    if (a === b) return 0;
    const visited = new Set([a]);
    let frontier = [a];
    let hops = 0;
    while (frontier.length > 0) {
      hops++;
      const next: number[] = [];
      for (const cur of frontier) {
        for (const nb of adj[cur]) {
          if (visited.has(nb)) continue;
          if (nb === b) return hops;
          visited.add(nb);
          next.push(nb);
        }
      }
      frontier = next;
    }
    return Infinity;
  };
}

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

describe("growMycelium", () => {
  it("is deterministic — same count grows the identical mat twice", () => {
    expect(growMycelium(50)).toEqual(growMycelium(50));
  });

  it("branches (order > 0 appears) and fuses (bridgeTo appears) at a real vault's node count", () => {
    const mat = growMycelium(1244);
    expect(mat.some((h) => h.order > 0)).toBe(true);
    expect(mat.some((h) => h.bridgeTo != null)).toBe(true);
  });

  it("every non-spore node's parent is an EARLIER index — a valid, drawable tree", () => {
    const mat = growMycelium(300);
    mat.forEach((h, i) => {
      if (h.parent < 0) return;
      expect(h.parent).toBeLessThan(i);
    });
  });

  it("stays within the field (one step of overshoot is the retirement check, not a hard clamp)", () => {
    const mat = growMycelium(300);
    for (const h of mat) {
      expect(Math.hypot(h.x, h.y)).toBeLessThan(1.15 + 0.05);
    }
  });

  describe("volumetric", () => {
    it("is deterministic — same count grows the identical mat twice", () => {
      expect(growMycelium(50, { volumetric: true })).toEqual(growMycelium(50, { volumetric: true }));
    });

    it("branches and fuses at a real vault's node count", () => {
      const mat = growMycelium(1244, { volumetric: true });
      expect(mat.some((h) => h.order > 0)).toBe(true);
      expect(mat.some((h) => h.bridgeTo != null)).toBe(true);
    });

    it("every non-spore node's parent is an EARLIER index — a valid, drawable tree", () => {
      const mat = growMycelium(300, { volumetric: true });
      mat.forEach((h, i) => {
        if (h.parent < 0) return;
        expect(h.parent).toBeLessThan(i);
      });
    });

    it("stays within a SPHERICAL field (retirement checks the full 3D radius, not just x,y)", () => {
      const mat = growMycelium(300, { volumetric: true });
      for (const h of mat) {
        expect(Math.hypot(h.x, h.y, h.z)).toBeLessThan(1.15 + 0.05);
      }
    });

    it("actually explores z — this is the difference from the planar mat: z spread is a real fraction of x/y spread, not jitter", () => {
      const mat = growMycelium(1244, { volumetric: true });
      const extent = (pick: (h: HyphaNode) => number): number =>
        Math.max(...mat.map(pick)) - Math.min(...mat.map(pick));
      const xy = Math.max(extent((h) => h.x), extent((h) => h.y));
      const z = extent((h) => h.z);
      // Measured on a 1244-node grow: z/xy ≈ 0.87 — a rounded volume, not a
      // disc (the planar path's z/xy is ~0.03, all cosmetic jitter).
      expect(z / xy).toBeGreaterThan(0.5);
    });

    it("an anastomosis bridge coincides exactly with its target — never a mismatched-z chord", () => {
      const mat = growMycelium(1244, { volumetric: true });
      for (const h of mat) {
        if (h.bridgeTo == null) continue;
        const target = mat[h.bridgeTo];
        expect(h.x).toBe(target.x);
        expect(h.y).toBe(target.y);
        expect(h.z).toBe(target.z);
      }
    });
  });
});

// A fixed field radius every buildMyceliumMat test lays out against, so "is
// this a chord" has a concrete threshold to compare against.
const FIELD_R = 900;

describe("matPath", () => {
  // A trunk chain 0-1-2-...-7, plus node 8 bridged from 7 back onto 1 (an
  // anastomosis loop) and node 9 disconnected. The bridge makes 0->7 via
  // 0,1,8,7 (3 hops) strictly shorter than the trunk-only 7 hops, so a BFS
  // that ignores bridges would get a provably worse answer, not just a tie.
  const mat: HyphaNode[] = [
    { x: 0, y: 0, z: 0, parent: -1, order: 0 }, // 0
    { x: 1, y: 0, z: 0, parent: 0, order: 0 }, // 1
    { x: 2, y: 0, z: 0, parent: 1, order: 0 }, // 2
    { x: 3, y: 0, z: 0, parent: 2, order: 0 }, // 3
    { x: 4, y: 0, z: 0, parent: 3, order: 0 }, // 4
    { x: 5, y: 0, z: 0, parent: 4, order: 0 }, // 5
    { x: 6, y: 0, z: 0, parent: 5, order: 0 }, // 6
    { x: 7, y: 0, z: 0, parent: 6, order: 0 }, // 7
    { x: 1, y: 0, z: 0, parent: 7, order: 0, bridgeTo: 1 }, // 8
    { x: 9, y: 9, z: 0, parent: -1, order: 0 }, // 9 — disconnected
  ];
  const adj = buildMatAdjacency(mat);

  it("finds the trunk route when there is no shorter option", () => {
    expect(matPath(adj, 0, 3)).toEqual([0, 1, 2, 3]);
  });

  it("a node to itself is a length-1 path", () => {
    expect(matPath(adj, 2, 2)).toEqual([2]);
  });

  it("shortcuts across an anastomosis bridge instead of the longer trunk", () => {
    expect(matPath(adj, 0, 7)).toEqual([0, 1, 8, 7]);
  });

  it("returns null for a disconnected pair", () => {
    expect(matPath(adj, 0, 9)).toBeNull();
  });
});

describe("buildMyceliumMat", () => {
  it("does not throw on an edgeless/empty graph and returns nothing to draw", () => {
    const g = makeGraph([]);
    expect(() => buildMyceliumMat(g, { targetRadius: FIELD_R })).not.toThrow();
    const result = buildMyceliumMat(g, { targetRadius: FIELD_R });
    expect(result.buckets).toEqual([]);
    expect(result.matIndexOf.size).toBe(0);
  });

  it("never draws a chord: every segment is a short local hyphal step, not a long straight span", () => {
    // The exact defect being fixed — a wireframe polyhedron is built from
    // segments that cross a big fraction of the field. A real growth step (or
    // an anastomosis bridge) is short no matter how big the vault is.
    const g = makeGraph(
      Array.from({ length: 120 }, (_, i) => ({ id: `n${i}.md`, community: 0, deg: 1 })),
    );
    for (let i = 0; i < 119; i++) g.addEdge(`n${i}.md`, `n${i + 1}.md`);
    const { buckets } = buildMyceliumMat(g, { targetRadius: FIELD_R });
    let maxSeg = 0;
    for (const b of buckets) {
      for (let i = 0; i < b.positions.length; i += 6) {
        const len = Math.hypot(
          b.positions[i + 3] - b.positions[i],
          b.positions[i + 4] - b.positions[i + 1],
          b.positions[i + 5] - b.positions[i + 2],
        );
        maxSeg = Math.max(maxSeg, len);
      }
    }
    expect(maxSeg).toBeGreaterThan(0);
    expect(maxSeg).toBeLessThan(FIELD_R * 0.1); // ~10x a growth step's own share of the field
  });

  it("assigns every note a mat position", () => {
    const g = makeGraph([
      { id: "a.md", community: 0 },
      { id: "b.md", community: 0 },
      { id: "c.md", community: -1 },
    ]);
    g.addEdge("a.md", "b.md");
    const { matIndexOf, mat } = buildMyceliumMat(g, { targetRadius: FIELD_R });
    for (const id of ["a.md", "b.md", "c.md"]) {
      expect(matIndexOf.has(id)).toBe(true);
      const h = mat[matIndexOf.get(id)!];
      expect(h).toBeDefined();
      expect(Number.isFinite(h.x)).toBe(true);
    }
  });

  it("graph-adjacent notes land mat-adjacent: linked notes' mat nodes are close in hyphal hops", () => {
    const g = makeRealScaleGraph();
    const { matIndexOf, mat } = buildMyceliumMat(g, { targetRadius: FIELD_R });
    const hops = matHopDistances(mat);
    const sampled: number[] = [];
    const hubSampled: number[] = [];
    g.forEachEdge((_e, _a, u, v) => {
      const iu = matIndexOf.get(u);
      const iv = matIndexOf.get(v);
      if (iu == null || iv == null) return;
      const d = hops(iu, iv);
      sampled.push(d);
      if (u === "note-0.md" || v === "note-0.md") hubSampled.push(d);
    });
    expect(sampled.length).toBeGreaterThan(50);
    const avg = sampled.reduce((s, n) => s + n, 0) / sampled.length;
    const hubAvg = hubSampled.reduce((s, n) => s + n, 0) / hubSampled.length;
    console.info(
      `[mycelium] linked-note mat-hop distance over ${sampled.length} real edges: avg=${avg.toFixed(2)} max=${Math.max(...sampled)}; ` +
        `hub(34 links) only: n=${hubSampled.length} avg=${hubAvg.toFixed(2)} max=${Math.max(...hubSampled)} sample=${hubSampled.slice(0, 34)}`,
    );
    // A handful of hyphal hops, not "somewhere in the mat" — the embedding's
    // whole job is to make this small. Measured: avg 1.21, max 5 (hub-only:
    // avg 3.12, max 5) — thresholds below leave headroom, not padding out a
    // known-bad number.
    expect(avg).toBeLessThan(4);
    expect(Math.max(...sampled)).toBeLessThan(15);
  });

  it("is deterministic — same graph lays out identically twice", () => {
    const g = makeGraph([
      { id: "a.md", community: 0, deg: 2 },
      { id: "b.md", community: 0, deg: 2 },
      { id: "c.md", community: 0, deg: 1 },
    ]);
    g.addEdge("a.md", "b.md");
    g.addEdge("b.md", "c.md");
    const a = buildMyceliumMat(g, { targetRadius: FIELD_R });
    const b = buildMyceliumMat(g, { targetRadius: FIELD_R });
    expect(a.mat).toEqual(b.mat);
    expect([...a.matIndexOf.entries()]).toEqual([...b.matIndexOf.entries()]);
  });

  it("reveals segments in ascending, non-decreasing growth order per bucket", () => {
    const g = makeRealScaleGraph();
    const { buckets } = buildMyceliumMat(g, { targetRadius: FIELD_R });
    for (const b of buckets) {
      for (let i = 1; i < b.birth.length; i++) {
        expect(b.birth[i]).toBeGreaterThanOrEqual(b.birth[i - 1]);
      }
    }
  });

  it("growth animates: revealing more of the birth range monotonically reveals more segments", () => {
    const g = makeRealScaleGraph();
    const { buckets } = buildMyceliumMat(g, { targetRadius: FIELD_R });
    const revealedAt = (t: number): number =>
      buckets.reduce((sum, b) => {
        let lo = 0;
        let hi = b.birth.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (b.birth[mid] <= t) lo = mid + 1;
          else hi = mid;
        }
        return sum + lo;
      }, 0);
    const samples = [0, 0.25, 0.5, 0.75, 1].map(revealedAt);
    console.info(`[mycelium] revealed segment counts over time: ${samples.join(" -> ")}`);
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1]);
    }
    expect(samples[samples.length - 1]).toBeGreaterThan(samples[0]);
  });

  it("real-scale (1244 notes / ~440 edges, one 34-link hub): grows and embeds inside a real frame budget", () => {
    const g = makeRealScaleGraph();
    const start = performance.now();
    const { buckets, matIndexOf, mat } = buildMyceliumMat(g, { targetRadius: FIELD_R });
    const ms = performance.now() - start;
    const segCount = buckets.reduce((s, b) => s + b.birth.length, 0);
    console.info(
      `[mycelium] real scale: ${g.order} notes / ${g.size} edges -> ${mat.length} mat nodes, ` +
        `${segCount} segments, ${matIndexOf.size} notes placed, ${ms.toFixed(1)}ms`,
    );
    expect(matIndexOf.size).toBe(g.order);
    expect(mat.length).toBeGreaterThan(g.order); // the mat is denser than the note count on purpose
    expect(ms).toBeLessThan(2000);
  });

  // dim: "3d" — the volumetric mat. Same invariants as the planar (default)
  // mat above, re-measured: growing through a real ball must not quietly
  // break the no-chord guarantee or the embedding's whole point (a wikilink
  // is a SHORT walk along real hyphae).
  describe("dim: 3d (volumetric)", () => {
    it("fills a rounded volume: z-extent is a real fraction of x/y-extent, not the ~0 of the flattened 2D mat", () => {
      const g = makeRealScaleGraph();
      const flat = buildMyceliumMat(g, { targetRadius: FIELD_R, dim: "2d" });
      const vol = buildMyceliumMat(g, { targetRadius: FIELD_R, dim: "3d" });
      const extent = (mat: HyphaNode[], pick: (h: HyphaNode) => number): number =>
        Math.max(...mat.map(pick)) - Math.min(...mat.map(pick));
      const ratio = (mat: HyphaNode[]): number => {
        const xy = Math.max(extent(mat, (h) => h.x), extent(mat, (h) => h.y));
        return extent(mat, (h) => h.z) / xy;
      };
      const flatRatio = ratio(flat.mat);
      const volRatio = ratio(vol.mat);
      console.info(`[mycelium] z/xy extent ratio: 2d=${flatRatio.toFixed(3)} 3d=${volRatio.toFixed(3)}`);
      expect(flatRatio).toBeLessThan(0.1); // planar: z is cosmetic jitter only
      expect(volRatio).toBeGreaterThan(0.5); // volumetric: a real rounded fill
    });

    it("never draws a chord, same as the planar mat: every segment is a short local hyphal step", () => {
      const g = makeRealScaleGraph();
      const { buckets } = buildMyceliumMat(g, { targetRadius: FIELD_R, dim: "3d" });
      let maxSeg = 0;
      for (const b of buckets) {
        for (let i = 0; i < b.positions.length; i += 6) {
          const len = Math.hypot(
            b.positions[i + 3] - b.positions[i],
            b.positions[i + 4] - b.positions[i + 1],
            b.positions[i + 5] - b.positions[i + 2],
          );
          maxSeg = Math.max(maxSeg, len);
        }
      }
      expect(maxSeg).toBeGreaterThan(0);
      expect(maxSeg).toBeLessThan(FIELD_R * 0.1);
    });

    it("graph-adjacent notes still land mat-adjacent — the embedding survives growing in a volume", () => {
      const g = makeRealScaleGraph();
      const { matIndexOf, mat } = buildMyceliumMat(g, { targetRadius: FIELD_R, dim: "3d" });
      const hops = matHopDistances(mat);
      const sampled: number[] = [];
      g.forEachEdge((_e, _a, u, v) => {
        const iu = matIndexOf.get(u);
        const iv = matIndexOf.get(v);
        if (iu == null || iv == null) return;
        sampled.push(hops(iu, iv));
      });
      const avg = sampled.reduce((s, n) => s + n, 0) / sampled.length;
      console.info(
        `[mycelium] 3D linked-note mat-hop distance over ${sampled.length} real edges: ` +
          `avg=${avg.toFixed(2)} max=${Math.max(...sampled)}`,
      );
      // Measured: avg 1.22, max 5 — matching the planar mat's 1.21/5. An
      // earlier volumetric pass (4 spores, same as the planar default)
      // measured avg 1.56 max 63: with node count fixed but the mat spread
      // over a ~30x bigger volume, many of the vault's small/disconnected
      // components round-robin onto the same 4 seed regions and exhaust them
      // faster than the now-sparser mat can route around. More seed regions
      // (16, see growMycelium's SPORES) fixed it directly and stayed stable
      // across a spore-count sweep, unlike fuse-radius tuning, which was
      // noisy. Thresholds below leave headroom, not padding a known-bad number.
      expect(avg).toBeLessThan(4);
      expect(Math.max(...sampled)).toBeLessThan(15);
    });

    it("is deterministic — same graph lays out identically twice", () => {
      const g = makeRealScaleGraph();
      const a = buildMyceliumMat(g, { targetRadius: FIELD_R, dim: "3d" });
      const b = buildMyceliumMat(g, { targetRadius: FIELD_R, dim: "3d" });
      expect(a.mat).toEqual(b.mat);
      expect([...a.matIndexOf.entries()]).toEqual([...b.matIndexOf.entries()]);
    });
  });
});
