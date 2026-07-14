// Atlas layout — the GRAPH-01 backlog engine: a second, STATIC layout mode
// with a Gephi / ForceAtlas2 look (dense per-community clumps on a flat plane,
// connected by their links) as an alternative to the 3D galaxy sim.
//
// FREEZE POSTMORTEM (2026-07-14): the first version ran the full FA2 iteration
// budget SYNCHRONOUSLY on the main thread. At the user's 10.5k-node vault that
// was a 34s+19s single task in Chromium — and in the packaged app's WKWebView
// (JSC hit its slow path) it burned 5+ CPU-minutes until WebKit killed the
// renderer. Because the layout choice persists to localStorage, every relaunch
// re-entered the same wedge: "opening the app freezes it". The layout now runs
// in SLICES (a few iterations per event-loop turn, budget scaled down at
// scale, adjustSizes only on small graphs), reports progress, and aborts
// cleanly when the caller unmounts or the user switches layouts.
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

// Total FA2 iteration budget. LinLog with strong communities converges to a
// readable MAP long before numeric convergence; the point is an overview, not
// a physics solution. Scales DOWN with node count — big graphs pay more per
// iteration and need fewer of them to look laid out.
//   1k → 300 · 4k → 100 · 10k → 40
export function atlasIterationBudget(n: number): number {
  if (n <= 0) return 0;
  return Math.max(30, Math.min(300, Math.round(400_000 / n)));
}

// Iterations per slice: keep every slice comfortably under ~150ms so the UI
// (and WebKit's responsiveness watchdog) never sees a long task. Measured
// ~120-190ms/iteration at 10k with Barnes-Hut in dev — hence 1 at large n.
export function atlasSliceSize(n: number): number {
  if (n > 5000) return 1;
  if (n > 2000) return 3;
  if (n > 500) return 10;
  return 30;
}

export interface AtlasOpts {
  // World-unit radius the laid-out graph should roughly fill. Scales with
  // linkDistance so atlas mode frames like the galaxy layout.
  targetRadius: number;
  // Override the total iteration budget (tests).
  iterations?: number;
  /** Called between slices with 0..1 progress. */
  onProgress?: (done: number, total: number) => void;
  /** Return true to abort (unmount / layout switched). Positions written so
   * far stay — harmless, the next layout overwrites them. */
  shouldAbort?: () => boolean;
}

// Yield to the event loop between slices. rAF is throttled/paused in hidden
// tabs and WKWebView occasionally starves it under load — a macrotask timeout
// always runs.
const nextTurn = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Run FA2 over the vault graph in event-loop-friendly slices and write flat
 * 2D positions into node attrs. Resolves true when the layout completed,
 * false when aborted. Deterministic for a given vault: FA2 reads each node's
 * current x/y as its seed, and buildGraph seeds those from a hash. */
export async function applyAtlasLayout(
  graph: VaultGraph,
  opts: AtlasOpts,
): Promise<boolean> {
  const n = graph.order;
  if (n === 0) return true;
  const total = opts.iterations ?? atlasIterationBudget(n);
  const slice = atlasSliceSize(n);
  // inferSettings tunes gravity/scaling to the graph size; LinLog + outbound-
  // attraction distribution give the tight-community, spread-hub Gephi look.
  // adjustSizes (overlap prevention) is the classic FA2 perf trap — its
  // per-iteration collision pass is what pushed the big-vault layout into
  // minutes. Small maps keep it; big maps don't need it (nodes are dots).
  const inferred = forceAtlas2.inferSettings(graph);
  const settings = {
    ...inferred,
    linLogMode: true,
    outboundAttractionDistribution: true,
    adjustSizes: n <= 2000,
    barnesHutOptimize: n > 800,
    gravity: inferred.gravity ?? 1,
  };

  let done = 0;
  while (done < total) {
    if (opts.shouldAbort?.()) return false;
    const step = Math.min(slice, total - done);
    // assign() reads the current x/y attrs as its starting state, so repeated
    // small calls accumulate exactly like one big run.
    forceAtlas2.assign(graph, { iterations: step, settings });
    done += step;
    opts.onProgress?.(done, total);
    await nextTurn();
  }
  if (opts.shouldAbort?.()) return false;

  // Fit to world units + a deterministic sub-unit z spread so co-planar
  // additive sprites don't z-fight / moiré.
  const pts: { x: number; y: number }[] = [];
  graph.forEachNode((_id, a) => {
    pts.push({ x: a.x, y: a.y });
  });
  const { cx, cy, scale } = fitTransform(pts, opts.targetRadius);
  graph.forEachNode((id, a) => {
    graph.setNodeAttribute(id, "x", (a.x - cx) * scale);
    graph.setNodeAttribute(id, "y", (a.y - cy) * scale);
    graph.setNodeAttribute(id, "z", (hashUnit(id) - 0.5) * 2);
  });
  return true;
}

function hashUnit(id: string): number {
  let h = 2166136261;
  for (let k = 0; k < id.length; k++) {
    h ^= id.charCodeAt(k);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}
