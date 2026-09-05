// THE NO-OVERLAP INVARIANT, layout by layout.
//
// "행성 노드는 겹치지 않게끔 해줘. 모든 뷰에서 겹치기 금지." — planet nodes must
// not overlap, in EVERY view. A node is drawn as a world-space sprite of radius
// renderedRadius(size); two of them overlap when their centres are closer than
// r_i + r_j. The app-wide contract adds NODE_MARGIN of clear void on top, so
// each world reads as its own disc rather than a body just touching its
// neighbour.
//
// Every layout the app offers is exercised here through its REAL layout
// function — not a reimplementation — over a graph with the real vault's
// shape. The per-layout loop runs at 400 notes: overlap is a local property,
// so a pair that collides at the vault's 1244 notes collides at 400 too, and
// the pair check below is deliberate brute force (O(n^2)) — if it shared
// layoutSeparation's spatial hash, a bug in that hash would hide the very
// violations this file exists to catch. One layout (the semantic map, the
// worst offender) still runs at the full 1244 as the scale canary.
import { describe, expect, it } from "vitest";
import Graph from "graphology";
import type { VaultGraph } from "./graphData";
import { applyAtlasLayout } from "./atlasLayout";
import { galaxyAnchorsBySize } from "./galaxyLayout";
import {
  NODE_MARGIN,
  renderedRadius,
  separateGraphLayout,
  separateLayout,
  type SizedPoint,
} from "./layoutSeparation";
import {
  applyCelestialLayout,
  applyRadialLayout,
  applySpiralLayout,
  applyStrataLayout,
  applyWalrusLayout,
  buildMyceliumMat,
} from "./staticLayouts";

const N = 400;
/** The real vault's note count — exactly one case below runs at it. */
const VAULT_N = 1244;

/** The real vault's shape at `n` notes: one 34-link hub and wikilinks scaled
 *  from the vault's ~440 at 1244 notes (so about half the notes stay edgeless,
 *  as they really are) — plus the `size` attribute graphData derives from
 *  degree, so the radii under test are the radii the renderer really draws. */
function makeVaultGraph(n = N): VaultGraph {
  const ids = Array.from({ length: n }, (_, i) => `note-${i}.md`);
  const g = new Graph({ multi: false, type: "undirected" }) as VaultGraph;
  for (const id of ids) {
    g.addNode(id, {
      label: id,
      x: 0,
      y: 0,
      z: 0,
      deg: 0,
      size: 1,
      color: "#ffffff",
      community: 0,
      galaxy: -1,
      isHub: false,
      intensity: 0.3,
    });
  }
  const addEdge = (a: string, b: string): void => {
    if (a !== b && !g.hasEdge(a, b)) g.addEdge(a, b);
  };
  for (let k = 1; k <= 34; k++) addEdge(ids[0], ids[k]);
  let budget = Math.round((440 * n) / VAULT_N) - 34;
  for (let i = 40; i < n - 1 && budget > 0; i += 3) {
    addEdge(ids[i], ids[i + 1]);
    budget--;
    if (i + 2 < n && budget > 0) {
      addEdge(ids[i], ids[i + 2]);
      budget--;
    }
  }
  // graphData.ts's own size/community derivation, so radii and community count
  // match a real build instead of a flat size 1.
  let maxDeg = 0;
  g.forEachNode((id) => {
    maxDeg = Math.max(maxDeg, g.degree(id));
  });
  g.forEachNode((id, a) => {
    const deg = g.degree(id);
    const jit = 1 + ((hash(id) % 1000) / 1000 - 0.5) * 0.36;
    const logSize =
      maxDeg > 0
        ? 0.85 + 2.5 * Math.pow(Math.log2(1 + deg) / Math.log2(1 + maxDeg), 1.25)
        : 0.85;
    g.setNodeAttribute(id, "deg", deg);
    g.setNodeAttribute(id, "size", logSize * jit);
    g.setNodeAttribute(id, "isHub", deg >= 10);
    // ~20 topics, the shape Louvain lands on for a vault this size.
    g.setNodeAttribute(id, "community", (a.label as string).length % 20);
  });
  return g;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let k = 0; k < s.length; k++) {
    h ^= s.charCodeAt(k);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

interface Body {
  x: number;
  y: number;
  z: number;
  r: number;
}

function bodies(g: VaultGraph): Body[] {
  return g.nodes().map((id) => ({
    x: g.getNodeAttribute(id, "x") as number,
    y: g.getNodeAttribute(id, "y") as number,
    z: g.getNodeAttribute(id, "z") as number,
    // Same radius separateGraphLayout actually packed against — see its own
    // starKind/intensity read — so this checks the guarantee that was really
    // made, not a looser stand-in that happens to also pass.
    r: renderedRadius(
      g.getNodeAttribute(id, "size") as number,
      (g.getNodeAttribute(id, "starKind") as number | undefined) ?? 0,
      (g.getNodeAttribute(id, "intensity") as number | undefined) ?? 0,
    ),
  }));
}

/** Brute-force violating-pair count — the acceptance number is 0. */
function violations(b: Body[], margin = NODE_MARGIN): number {
  let bad = 0;
  for (let i = 0; i < b.length; i++) {
    for (let j = i + 1; j < b.length; j++) {
      const d = Math.hypot(b[j].x - b[i].x, b[j].y - b[i].y, b[j].z - b[i].z);
      if (d < b[i].r + b[j].r + margin - 1e-6) bad++;
    }
  }
  return bad;
}

/** Median distance to a body's nearest neighbour — the "can I actually SEE
 *  individual worlds" measure. A field that merely satisfies the invariant by
 *  jamming everything into contact would sit right at the minimum; an open
 *  field sits comfortably above it. */
function medianNearest(b: Body[]): number {
  const d = b.map((p, i) => {
    let best = Infinity;
    for (let j = 0; j < b.length; j++) {
      if (j === i) continue;
      const dd = Math.hypot(b[j].x - p.x, b[j].y - p.y, b[j].z - p.z);
      if (dd < best) best = dd;
    }
    return best;
  });
  d.sort((x, y) => x - y);
  return d[Math.floor(d.length / 2)];
}

function medianRadius(b: Body[]): number {
  const r = b.map((p) => p.r).sort((x, y) => x - y);
  return r[Math.floor(r.length / 2)];
}

/** Every layout must clear the invariant AND read as an open field. */
function expectSeparated(g: VaultGraph): void {
  const b = bodies(g);
  for (const p of b) {
    expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)).toBe(true);
  }
  expect(violations(b)).toBe(0);
  // Nearest neighbours sit at least ~2.2 median radii apart — i.e. beyond
  // touching, with real void between bodies.
  expect(medianNearest(b)).toBeGreaterThan(medianRadius(b) * 2.2);
}

// linkDistance 45 (the default) x ATLAS_RADIUS_MUL 26 — what PageGraph hands
// the static layouts.
const RADIUS = 45 * 26;

describe("no-overlap invariant", () => {
  it("spiral", () => {
    const g = makeVaultGraph();
    applySpiralLayout(g, { targetRadius: RADIUS * 1.3 });
    expectSeparated(g);
  });

  it("celestial", () => {
    const g = makeVaultGraph();
    applyCelestialLayout(g, { targetRadius: RADIUS * 1.1 });
    expectSeparated(g);
  });

  it("radial", () => {
    const g = makeVaultGraph();
    applyRadialLayout(g, { targetRadius: RADIUS * 1.2 });
    expectSeparated(g);
  });

  it("walrus", () => {
    const g = makeVaultGraph();
    applyWalrusLayout(g, { targetRadius: RADIUS * 1.25 });
    expectSeparated(g);
  });

  it("strata (2D chronicle) — and its date axis scales with the widened chart", () => {
    const g = makeVaultGraph();
    const mtimes = new Map(g.nodes().map((id, i) => [id, 1_700_000_000_000 + i * 3_600_000]));
    const axis = applyStrataLayout(g, { mtimes, targetRadius: RADIUS * 1.2 });
    expectSeparated(g);
    // Flat: separation must not lift the chart out of its plane.
    expect(Math.max(...bodies(g).map((p) => Math.abs(p.z)))).toBe(0);
    // The axis is drawn in world units from the SAME time→x mapping, so it has
    // to ride the widening — ticks must still bracket the notes they label.
    const xs = bodies(g).map((p) => p.x);
    expect(axis.ticks.length).toBeGreaterThan(1);
    expect(axis.ticks[axis.ticks.length - 1].x).toBeGreaterThan(Math.min(...xs));
    expect(axis.ticks[0].x).toBeLessThan(Math.max(...xs));
    expect(axis.yTop).toBeGreaterThan(0);
  });

  it("atlas (2D ForceAtlas2 map)", async () => {
    const g = makeVaultGraph();
    await applyAtlasLayout(g, {
      targetRadius: 90 * 26,
      iterations: 60,
      noWorker: true,
      variant: "atlas",
    });
    expectSeparated(g);
  }, 60_000);

  it("synapse (2D ganglia map)", async () => {
    const g = makeVaultGraph();
    await applyAtlasLayout(g, {
      targetRadius: 60 * 26 * 1.6,
      iterations: 60,
      noWorker: true,
      variant: "synapse",
    });
    expectSeparated(g);
  }, 60_000);

  it("semantic (PCA meaning-map, as PageGraph bakes it) — at the vault's full 1244 notes", () => {
    // The scale canary: the one case kept at the real vault's size, because the
    // raw semantic map was the worst offender and every layout ends in the same
    // separateGraphLayout post-process this drives at full density.
    const g = makeVaultGraph(VAULT_N);
    // Stand-in for the Rust PCA: unit-square coords with deliberate exact ties
    // (near-synonymous notes land on the same point) plus the unembedded-ghost
    // ring PageGraph parks the rest on — the two shapes that made the raw
    // semantic map the worst offender of the lot.
    g.forEachNode((id) => {
      const i = Number(id.slice(5, -3));
      if (i % 7 === 0) {
        const ang = (((i * 2654435761) >>> 0) % 4096) / 4096 * Math.PI * 2;
        g.setNodeAttribute(id, "x", Math.cos(ang) * RADIUS * 1.14);
        g.setNodeAttribute(id, "y", Math.sin(ang) * RADIUS * 1.14);
        g.setNodeAttribute(id, "z", 0);
      } else {
        const k = Math.floor(i / 4); // 4 notes share every coordinate
        g.setNodeAttribute(id, "x", ((k % 20) / 20 - 0.5) * RADIUS);
        g.setNodeAttribute(id, "y", (Math.floor(k / 20) / 20 - 0.5) * RADIUS);
        g.setNodeAttribute(id, "z", 0);
      }
    });
    // The graph-attribute flavour — the exact call PageGraph makes.
    separateGraphLayout(g);
    expectSeparated(g);
  });

  it("galaxy / synapse3d (force sim) — the worker's settle-time guarantee", () => {
    // The sim worker cannot be imported (it installs a self.onmessage at load),
    // so this drives the exact call it makes at settle — separateLayout over
    // the sim's node array — against the sim's own resting SHAPE: nodes packed
    // around the real galaxyAnchorsBySize anchors, the way computeAnchors seeds
    // and the cluster force holds them.
    const g = makeVaultGraph();
    const counts = new Map<number, number>();
    g.forEachNode((_id, a) => counts.set(a.community, (counts.get(a.community) ?? 0) + 1));
    const ids = [...counts.keys()].sort((a, b) => a - b);
    const anchors = galaxyAnchorsBySize(ids.map((c) => counts.get(c)!), 45);
    const anchorOf = new Map(ids.map((c, i) => [c, anchors[i]]));
    const pts: SizedPoint[] = g.nodes().map((id, i) => {
      const a = anchorOf.get(g.getNodeAttribute(id, "community") as number)!;
      // A tight puff around the anchor — denser than the settled sim, so the
      // post-process is tested against the WORST case it can be handed.
      const t = (i * 2.399963);
      const rr = 45 * 0.32 * Math.sqrt(((i * 7919) % 1000) / 1000);
      return {
        x: a.x + Math.cos(t) * rr,
        y: a.y + Math.sin(t) * rr,
        z: a.z + Math.cos(t * 1.7) * rr,
        size: g.getNodeAttribute(id, "size") as number,
      };
    });
    const res = separateLayout(pts);
    expect(res.overlaps).toBe(0);
    const b = pts.map((p) => ({ x: p.x, y: p.y, z: p.z, r: renderedRadius(p.size) }));
    expect(violations(b)).toBe(0);
    expect(medianNearest(b)).toBeGreaterThan(medianRadius(b) * 2.2);
  });

  it("mycelium: no two notes share a septum, and every septum keeps its own room", () => {
    // Mycelium septa are drawn at a FIXED SCREEN size (myceliumScene: 6..14
    // device px, not distance-attenuated), so "rendered world radius" has no
    // meaning there — zooming in always separates them. What the layout owes is
    // that no two notes are assigned the same mat node, and that assigned mat
    // nodes are a real hyphal step apart rather than adjacent points on one
    // strand. Measured against the mat's own growth step, in whatever space
    // the view actually PAINTS — MyceliumView flattens z to 0 for the "2d"
    // dim (both septa and hyphae), so checking the un-flattened 3D distance
    // here would pass even while two septa collapse onto the same point once
    // z is squashed away (this is exactly how that regression shipped once).
    const g = makeVaultGraph();
    const { matIndexOf, mat } = buildMyceliumMat(g, { targetRadius: 1800, dim: "2d" });
    expect(matIndexOf.size).toBe(N);
    expect(new Set(matIndexOf.values()).size).toBe(N);
    // The mat's growth step, xy-only (parent→child distance, median) — same
    // dimensionality as the flattened render.
    const steps = mat
      .filter((h) => h.parent >= 0 && h.bridgeTo == null)
      .map((h) => Math.hypot(h.x - mat[h.parent].x, h.y - mat[h.parent].y))
      .sort((a, b) => a - b);
    const step = steps[Math.floor(steps.length / 2)];
    const pts = [...matIndexOf.values()].map((i) => mat[i]);
    let closest = Infinity;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const d = Math.hypot(pts[j].x - pts[i].x, pts[j].y - pts[i].y); // flattened: z omitted
        if (d < closest) closest = d;
      }
    }
    expect(closest).toBeGreaterThan(step * 0.9);
  }, 60_000);
});

describe("separateLayout", () => {
  it("resolves a pathological pile — 500 bodies at the exact same point", () => {
    const pts: SizedPoint[] = Array.from({ length: 500 }, () => ({
      x: 0,
      y: 0,
      z: 0,
      size: 1,
    }));
    expect(separateLayout(pts).overlaps).toBe(0);
  });

  it("is deterministic — the same input lays out identically twice", () => {
    const seed = (): SizedPoint[] =>
      Array.from({ length: 400 }, (_, i) => ({
        x: Math.cos(i) * 40,
        y: Math.sin(i * 1.3) * 40,
        z: Math.cos(i * 0.7) * 40,
        size: 0.85 + ((i * 37) % 100) / 100,
      }));
    const a = seed();
    const b = seed();
    separateLayout(a);
    separateLayout(b);
    expect(a).toEqual(b);
  });

  it("leaves an already-valid layout alone (scale 1, no drift)", () => {
    const pts: SizedPoint[] = Array.from({ length: 100 }, (_, i) => ({
      x: i * 200,
      y: 0,
      z: 0,
      size: 1,
    }));
    const before = pts.map((p) => ({ ...p }));
    expect(separateLayout(pts).scale).toBe(1);
    expect(pts).toEqual(before);
  });

  it("dims: 2 never lifts a flat map out of its plane", () => {
    const pts: SizedPoint[] = Array.from({ length: 300 }, (_, i) => ({
      x: (i % 20) * 2,
      y: Math.floor(i / 20) * 2,
      z: 0,
      size: 1,
    }));
    expect(separateLayout(pts, { dims: 2 }).overlaps).toBe(0);
    expect(Math.max(...pts.map((p) => Math.abs(p.z)))).toBe(0);
  });
});
