// Atlas layout — the GRAPH-01 backlog engine: a second, STATIC layout mode
// with a Gephi / ForceAtlas2 look (dense per-community clumps on a flat plane,
// connected by their links) as an alternative to the 3D galaxy sim.
//
// FREEZE POSTMORTEM (2026-07-14): v1 ran the full FA2 budget SYNCHRONOUSLY on
// the main thread — a 34s+19s single task at the user's 10.5k-node vault in
// Chromium, minutes in the packaged WKWebView until WebKit killed the
// renderer; the persisted layout choice re-froze every relaunch. v2 sliced
// the SAME work on the main thread but cut the budget to keep it short — and
// 40 iterations left LinLog mid-collapse: every node in one white ball.
// v3 (this): run FA2 in the library's own WEB WORKER (FA2LayoutSupervisor,
// blob worker — CSP worker-src blob: allows it) for a node-count-scaled wall
// time. Full layout quality, zero main-thread cost, live position streaming;
// the main thread only re-syncs buffers and fits the camera. A chunked
// main-thread path (1 iteration/slice) remains as fallback when Worker
// construction fails.
import forceAtlas2 from "graphology-layout-forceatlas2";
import FA2LayoutSupervisor from "graphology-layout-forceatlas2/worker";
import type { VaultGraph } from "./graphData";
import { galaxyAnchorsBySize, galaxyFootprint } from "./galaxyLayout";

// Centre a set of 2D points on the origin and scale so the bounding radius
// lands near `targetRadius` world units. Pure — unit-tested. Returns the
// transform to apply; degenerate/empty input yields identity.
//
// `percentile` (default 1 = max) picks which radius maps onto targetRadius.
// The layout consumer passes 0.95: FA2 on a sparse vault flings a handful of
// disconnected outliers VERY far, and a max-radius fit let one runaway node
// crush the whole map into a white dot at the origin (the 2026-07-14 atlas
// regression, and the same lesson the camera fit learned in an earlier round).
export function fitTransform(
  points: { x: number; y: number }[],
  targetRadius: number,
  percentile = 1,
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
  let r: number;
  if (percentile >= 1) {
    r = 0;
    for (const p of points) {
      r = Math.max(r, Math.hypot(p.x - cx, p.y - cy));
    }
  } else {
    const dists = points
      .map((p) => Math.hypot(p.x - cx, p.y - cy))
      .sort((a, b) => a - b);
    r = dists[Math.min(dists.length - 1, Math.floor((dists.length - 1) * percentile))];
  }
  return { cx, cy, scale: r > 1e-6 ? targetRadius / r : 1 };
}

// Worker wall-time budget: FA2 needs its expansion phase to escape the LinLog
// early-collapse (the white-ball failure), and bigger graphs need longer.
//   1k → 5s · 5k → 8s · 10k → 15s · cap 25s
export function atlasWorkerBudgetMs(n: number): number {
  return Math.max(5000, Math.min(25000, Math.round(n * 1.5)));
}

// Fallback (main-thread slices) budget/slicing — the v2 numbers, but with the
// FULL iteration count so the map actually expands; slices just make it slow
// AND responsive instead of frozen.
export function atlasIterationBudget(n: number): number {
  if (n <= 0) return 0;
  return Math.max(120, Math.min(400, Math.round(1_200_000 / Math.max(1, n))));
}
export function atlasSliceSize(n: number): number {
  if (n > 5000) return 1;
  if (n > 2000) return 3;
  if (n > 500) return 10;
  return 30;
}

export type AtlasVariant = "atlas" | "synapse";

function fa2Settings(graph: VaultGraph, variant: AtlasVariant): Record<string, unknown> {
  const n = graph.order;
  // inferSettings tunes gravity/scaling to the graph size; LinLog + outbound-
  // attraction distribution give the tight-community, spread-hub Gephi look.
  // adjustSizes (overlap prevention) is the classic FA2 perf trap — collision
  // passes per iteration; big maps render nodes as dots and don't need it.
  const inferred = forceAtlas2.inferSettings(graph);
  // Synapse: a nervous-system arrangement — communities fling FAR apart into
  // separate bright cores (ganglia) with clear voids between, joined by long
  // nerve-fibre bridges. Weaker gravity lets clusters drift out; higher
  // scalingRatio pushes stronger repulsion so the voids open; LinLog still
  // contracts each cluster into a tight core. Atlas keeps the compact Gephi
  // territory-map spacing.
  const scalingRatio =
    variant === "synapse"
      ? (inferred.scalingRatio as number) * 3
      : (inferred.scalingRatio as number);
  return {
    ...inferred,
    linLogMode: true,
    outboundAttractionDistribution: true,
    adjustSizes: n <= 2000,
    barnesHutOptimize: n > 800,
    scalingRatio,
    // Vault graphs are SPARSE (≈1 edge/node, many orphans and disconnected
    // star-clusters). Plain gravity can't hold the pieces LinLog repulsion
    // flings apart — the layout exploded to a 51-MILLION-unit spread on the
    // real 10k vault and never recovered. Strong gravity (force ∝ distance,
    // the Gephi remedy for disconnected graphs) keeps every component in
    // orbit; its coefficient must be SMALL or it crushes the map.
    strongGravityMode: true,
    gravity: variant === "synapse" ? 0.02 : 0.05,
  };
}

export interface AtlasOpts {
  // World-unit radius the laid-out graph should roughly fill. Scales with
  // linkDistance so atlas mode frames like the galaxy layout.
  targetRadius: number;
  /** Override the worker wall-time (tests / harnesses). */
  budgetMs?: number;
  /** Fallback path: override total iterations (tests). */
  iterations?: number;
  /** Called periodically while the layout runs (positions already updated in
   * the graph attrs — sync buffers for a live unfold preview). */
  onProgress?: (done: number, total: number) => void;
  /** Return true to abort (unmount / layout switched). */
  shouldAbort?: () => boolean;
  /** Force the main-thread fallback (tests). */
  noWorker?: boolean;
  /** "atlas" (compact territory map) or "synapse" (spread ganglia + bridges). */
  variant?: AtlasVariant;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Run FA2 over the vault graph (worker-first) and write flat 2D positions
 * into node attrs. Resolves true when the layout completed, false if aborted. */
export async function applyAtlasLayout(
  graph: VaultGraph,
  opts: AtlasOpts,
): Promise<boolean> {
  const n = graph.order;
  if (n === 0) return true;

  // Re-seed x/y on a uniform 2D disc before FA2 starts. buildGraph seeds
  // positions on a 3D SPHERE SHELL (right for the galaxy sim) — but FA2 is
  // 2D, and the shell's projection piles every polar node near (0,0). That
  // density singularity catapulted nodes to ±150M units on the first
  // repulsion passes (max/p95 ≈ 1900×) and the map never recovered — the
  // "one white ball" atlas regression. A √u disc is uniform in 2D; the same
  // vault then converges cleanly (max/p95 ≈ 1.3) within ~100 iterations.
  // Deterministic per id, so reloads produce the identical map.
  graph.forEachNode((id) => {
    const r = Math.sqrt(hashUnit(`${id}:ax`)) * 600;
    const t = hashUnit(`${id}:ay`) * Math.PI * 2;
    graph.setNodeAttribute(id, "x", Math.cos(t) * r);
    graph.setNodeAttribute(id, "y", Math.sin(t) * r);
  });

  // Synapse: weight the FA2 attraction so INTRA-community links pull hard
  // (each topic contracts into a tight bright core / ganglion) while
  // INTER-community links pull weakly (the few cross-topic bridges stretch
  // long into nerve fibres). Without this, one dominant densely-interlinked
  // folder — the real-vault shape — lays out as a single big disc instead of
  // separated cores. FA2's supervisor reads the "weight" edge attribute at
  // start; galaxy mode never reads it, and the graph is rebuilt on layout
  // change, so this stays local to the synapse layout.
  if ((opts.variant ?? "atlas") === "synapse") {
    graph.forEachEdge((e, _a, s, t) => {
      const cs = graph.getNodeAttribute(s, "community");
      const ct = graph.getNodeAttribute(t, "community");
      const intra = cs >= 0 && cs === ct;
      graph.setEdgeAttribute(e, "weight", intra ? 6 : 0.15);
    });
  }

  let ok: boolean;
  if (opts.noWorker) {
    ok = await runChunkedFallback(graph, opts);
  } else {
    try {
      ok = await runWorker(graph, opts);
    } catch {
      // Worker construction failed (odd embedder) — degrade to slices.
      ok = await runChunkedFallback(graph, opts);
    }
  }
  if (!ok) return false;

  // Synapse: FA2 gave each community its organic tight-core SHAPE, but a
  // densely cross-linked vault still lays them in one disc. Relocate each
  // core to its own spread anchor (reusing the galaxy layout's irregular
  // size-packing) so communities become SEPARATED ganglia and their few
  // cross-links stretch into long nerve-fibre bridges — the reference look,
  // guaranteed on any vault regardless of how interlinked its topics are.
  if ((opts.variant ?? "atlas") === "synapse") {
    separateCommunities(graph);
  }

  // Fit to world units + a deterministic sub-unit z spread so co-planar
  // additive sprites don't z-fight / moiré.
  const pts: { x: number; y: number }[] = [];
  graph.forEachNode((_id, a) => {
    pts.push({ x: a.x, y: a.y });
  });
  const { cx, cy, scale } = fitTransform(pts, opts.targetRadius, 0.95);
  graph.forEachNode((id, a) => {
    graph.setNodeAttribute(id, "x", (a.x - cx) * scale);
    graph.setNodeAttribute(id, "y", (a.y - cy) * scale);
    graph.setNodeAttribute(id, "z", (hashUnit(id) - 0.5) * 2);
  });

  // Link-less notes: strong gravity piles every isolate into a blinding
  // additive puck at the origin (thousands of white sprites in one spot).
  // Scatter them across the whole map as background texture instead — the
  // atlas equivalent of the galaxy mode's field stars. Deterministic per id.
  graph.forEachNode((id) => {
    if (graph.degree(id) > 0) return;
    const r = Math.sqrt(hashUnit(`${id}:or`)) * opts.targetRadius * 1.1;
    const t = hashUnit(`${id}:ot`) * Math.PI * 2;
    graph.setNodeAttribute(id, "x", Math.cos(t) * r);
    graph.setNodeAttribute(id, "y", Math.sin(t) * r);
  });
  return true;
}

// The supervisor streams positions back into the graph continuously; we just
// wake up every ~400ms to report progress until the time budget elapses.
async function runWorker(graph: VaultGraph, opts: AtlasOpts): Promise<boolean> {
  const budget = opts.budgetMs ?? atlasWorkerBudgetMs(graph.order);
  const layout = new FA2LayoutSupervisor(graph, {
    settings: fa2Settings(graph, opts.variant ?? "atlas") as never,
  });
  try {
    layout.start();
    const t0 = Date.now();
    let elapsed = 0;
    while (elapsed < budget) {
      if (opts.shouldAbort?.()) return false;
      await sleep(Math.min(400, budget - elapsed));
      elapsed = Date.now() - t0;
      opts.onProgress?.(Math.min(elapsed, budget), budget);
    }
    return !opts.shouldAbort?.();
  } finally {
    layout.kill(); // terminates the worker; positions stay in the graph
  }
}

async function runChunkedFallback(
  graph: VaultGraph,
  opts: AtlasOpts,
): Promise<boolean> {
  const n = graph.order;
  const total = opts.iterations ?? atlasIterationBudget(n);
  const slice = atlasSliceSize(n);
  const settings = fa2Settings(graph, opts.variant ?? "atlas");
  let done = 0;
  while (done < total) {
    if (opts.shouldAbort?.()) return false;
    const step = Math.min(slice, total - done);
    // assign() reads current x/y attrs as its starting state, so repeated
    // small calls accumulate exactly like one big run.
    forceAtlas2.assign(graph, { iterations: step, settings: settings as never });
    done += step;
    opts.onProgress?.(done, total);
    await sleep(0);
  }
  return !opts.shouldAbort?.();
}

// Reposition each community's FA2-laid nodes around its own spread anchor so
// topics become separated cores joined by long bridges (the synapse look).
// FA2 gives each community its organic SHAPE; we normalise that shape to a
// controlled size (its footprint) and drop it on a packed anchor, so cores
// and anchor spacing share ONE unit scale (a mismatch left every core piled
// at the centre). Pure geometry over node attrs; exported for tests.
const SYNAPSE_LD = 60; // pseudo link-distance for footprint + packing units
export function separateCommunities(graph: VaultGraph): void {
  // Per-community centroid, count, and RMS radius of the FA2 layout.
  const sx = new Map<number, number>();
  const sy = new Map<number, number>();
  const sn = new Map<number, number>();
  graph.forEachNode((_id, a) => {
    if (a.community < 0) return;
    sx.set(a.community, (sx.get(a.community) ?? 0) + a.x);
    sy.set(a.community, (sy.get(a.community) ?? 0) + a.y);
    sn.set(a.community, (sn.get(a.community) ?? 0) + 1);
  });
  if (sn.size < 2) return; // nothing to separate

  const cx = new Map<number, number>();
  const cy = new Map<number, number>();
  for (const [c, n] of sn) {
    cx.set(c, sx.get(c)! / n);
    cy.set(c, sy.get(c)! / n);
  }
  const r2 = new Map<number, number>();
  graph.forEachNode((_id, a) => {
    if (a.community < 0) return;
    const dx = a.x - cx.get(a.community)!;
    const dy = a.y - cy.get(a.community)!;
    r2.set(a.community, (r2.get(a.community) ?? 0) + dx * dx + dy * dy);
  });

  // Anchor centres from the galaxy layout's irregular size-packing (biggest at
  // the origin, the rest greedily spread with real voids), in footprint units.
  const ids = [...sn.keys()].sort((a, b) => (sn.get(b)! - sn.get(a)!) || a - b);
  const counts = ids.map((c) => sn.get(c)!);
  const anchors = galaxyAnchorsBySize(counts, SYNAPSE_LD);
  const anchorOf = new Map<number, { x: number; y: number }>();
  ids.forEach((c, i) => anchorOf.set(c, { x: anchors[i].x, y: anchors[i].z }));

  graph.forEachNode((id, a) => {
    if (a.community < 0) return;
    const c = a.community;
    const n = sn.get(c)!;
    const rms = Math.sqrt((r2.get(c) ?? 0) / n) || 1;
    // Normalise the FA2 core to sit well inside its footprint so clear voids
    // open between the ganglia (0.38 keeps cores tight, voids wide).
    const coreR = galaxyFootprint(n, SYNAPSE_LD) * 0.38;
    const k = coreR / rms;
    const ax = anchorOf.get(c)!;
    graph.setNodeAttribute(id, "x", ax.x + (a.x - cx.get(c)!) * k);
    graph.setNodeAttribute(id, "y", ax.y + (a.y - cy.get(c)!) * k);
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
