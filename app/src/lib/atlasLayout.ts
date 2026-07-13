// Atlas layout — the GRAPH-01 backlog engine: a second, STATIC layout mode
// with a Gephi / ForceAtlas2 look (dense per-community clumps on a flat plane,
// connected by their links) as an alternative to the 3D galaxy sim. Runs
// graphology-layout-forceatlas2 synchronously on the main thread once at build
// (the vault graph already lives here), writes the 2D result into each node's
// x/y/z attributes (z≈0, a hair of jitter so co-planar sprites don't z-fight),
// scaled to the same world units the galaxy layout uses. No worker, no live
// settle — the positions are fixed, so the scene just renders them.
import forceAtlas2 from "graphology-layout-forceatlas2";
import type { VaultGraph } from "./graphData";

// Centre a set of 2D points on the origin and scale so the bounding radius
// lands near `targetRadius` world units. Pure — unit-tested. Returns the
// transform to apply; degenerate/empty input yields identity.
export function fitTransform(
  points: { x: number; y: number }[],
  targetRadius: number,
): { cx: number; cy: number; scale: number } {
  if (points.length === 0) return { cx: 0, cy: 0, scale: 1 };
  let cx = 0;
  let cy = 0;
  for (const p of points) {
    cx += p.x;
    cy += p.y;
  }
  cx /= points.length;
  cy /= points.length;
  let r = 0;
  for (const p of points) {
    r = Math.max(r, Math.hypot(p.x - cx, p.y - cy));
  }
  return { cx, cy, scale: r > 1e-6 ? targetRadius / r : 1 };
}

export interface AtlasOpts {
  // World-unit radius the laid-out graph should roughly fill. Scales with
  // linkDistance so atlas mode frames like the galaxy layout.
  targetRadius: number;
  // Iteration budget. FA2 is O(n log n)/iter (Barnes-Hut); cap so a 12k graph
  // stays a ~1-2s one-time settle, not a hang.
  iterations?: number;
}

// Run FA2 over the vault graph and write flat 2D positions into node attrs.
// Deterministic: FA2 reads each node's current x/y as its seed, and buildGraph
// seeds those from a hash, so the same vault lays out identically each time.
export function applyAtlasLayout(graph: VaultGraph, opts: AtlasOpts): void {
  const n = graph.order;
  if (n === 0) return;
  const iterations =
    opts.iterations ?? Math.max(120, Math.min(600, Math.round(30000 / Math.sqrt(n))));
  // inferSettings tunes gravity/scaling to the graph size; LinLog + outbound-
  // attraction distribution give the tight-community, spread-hub Gephi look.
  const settings = forceAtlas2.inferSettings(graph);
  const positions = forceAtlas2(graph, {
    iterations,
    settings: {
      ...settings,
      linLogMode: true,
      outboundAttractionDistribution: true,
      adjustSizes: true,
      barnesHutOptimize: n > 800,
      gravity: settings.gravity ?? 1,
    },
  }) as Record<string, { x: number; y: number }>;

  const pts = graph.nodes().map((id) => positions[id] ?? { x: 0, y: 0 });
  const { cx, cy, scale } = fitTransform(pts, opts.targetRadius);
  graph.forEachNode((id) => {
    const p = positions[id] ?? { x: 0, y: 0 };
    graph.setNodeAttribute(id, "x", (p.x - cx) * scale);
    graph.setNodeAttribute(id, "y", (p.y - cy) * scale);
    // A deterministic sub-unit z spread keeps additive sprites from perfectly
    // overlapping (z-fight / moiré) while the layout still reads as a flat map.
    const h = hashUnit(id);
    graph.setNodeAttribute(id, "z", (h - 0.5) * 2);
  });
}

function hashUnit(id: string): number {
  let h = 2166136261;
  for (let k = 0; k < id.length; k++) {
    h ^= id.charCodeAt(k);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}
