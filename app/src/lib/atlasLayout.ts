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

function fa2Settings(graph: VaultGraph): Record<string, unknown> {
  const n = graph.order;
  // inferSettings tunes gravity/scaling to the graph size; LinLog + outbound-
  // attraction distribution give the tight-community, spread-hub Gephi look.
  // adjustSizes (overlap prevention) is the classic FA2 perf trap — collision
  // passes per iteration; big maps render nodes as dots and don't need it.
  const inferred = forceAtlas2.inferSettings(graph);
  return {
    ...inferred,
    linLogMode: true,
    outboundAttractionDistribution: true,
    adjustSizes: n <= 2000,
    barnesHutOptimize: n > 800,
    // Vault graphs are SPARSE (≈1 edge/node, many orphans and disconnected
    // star-clusters). Plain gravity can't hold the pieces LinLog repulsion
    // flings apart — the layout exploded to a 51-MILLION-unit spread on the
    // real 10k vault and never recovered. Strong gravity (force ∝ distance,
    // the Gephi remedy for disconnected graphs) keeps every component in
    // orbit; its coefficient must be SMALL or it crushes the map.
    strongGravityMode: true,
    gravity: 0.05,
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
    settings: fa2Settings(graph) as never,
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
  const settings = fa2Settings(graph);
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

function hashUnit(id: string): number {
  let h = 2166136261;
  for (let k = 0; k < id.length; k++) {
    h ^= id.charCodeAt(k);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}
