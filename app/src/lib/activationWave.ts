// Neural activation wave — pure scheduling for the "click a node and watch the
// signal ripple outward" effect. BFS rings around the origin fire in timed
// steps: the ring-d nodes flash while sparks travel the tree edges toward ring
// d+1, like an action potential propagating through a network. This module is
// DOM/three-free so the plan and the timing envelopes are unit-testable; the
// rendering lives in waveLayer.ts.

export interface WaveNode {
  id: string;
  depth: number;
}

// A tree edge discovered by the BFS: fires FROM a depth-d node TO its depth-d+1
// child. Cross edges are skipped — re-lighting an already-lit node reads as
// noise, and tree edges alone draw the clean expanding ring.
export interface WaveEdge {
  s: string;
  t: string;
  depth: number;
}

export interface WavePlan {
  origin: string;
  nodes: WaveNode[];
  edges: WaveEdge[];
  /** deepest node ring in the plan (0 = origin only) */
  maxDepth: number;
}

// One ring step: sparks depart ring d at d*WAVE_STEP and arrive at ring d+1
// exactly when it starts flashing — the timings interlock, so the spark travel
// time IS the step.
export const WAVE_STEP = 0.22;
// Node flash envelope length (overlaps the next ring for a soft afterglow).
export const WAVE_FLASH_DUR = 0.55;

export interface WavePlanOpts {
  maxDepth?: number;
  maxNodes?: number;
  maxEdges?: number;
}

// BFS rings around `origin`, capped in depth and size so a hub click on a 10k
// vault stays a bounded effect (the caps also bound the render buffers).
export function planWave(
  neighbors: (id: string) => string[],
  origin: string,
  opts: WavePlanOpts = {},
): WavePlan {
  const maxDepth = opts.maxDepth ?? 3;
  const maxNodes = opts.maxNodes ?? 400;
  const maxEdges = opts.maxEdges ?? 300;
  const nodes: WaveNode[] = [{ id: origin, depth: 0 }];
  const edges: WaveEdge[] = [];
  const seen = new Set<string>([origin]);
  let frontier = [origin];
  let depth = 0;
  let reached = 0;
  while (frontier.length > 0 && depth < maxDepth) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const nb of neighbors(id)) {
        if (seen.has(nb)) continue;
        if (nodes.length >= maxNodes || edges.length >= maxEdges) {
          return { origin, nodes, edges, maxDepth: reached };
        }
        seen.add(nb);
        nodes.push({ id: nb, depth: depth + 1 });
        edges.push({ s: id, t: nb, depth });
        next.push(nb);
        reached = depth + 1;
      }
    }
    frontier = next;
    depth++;
  }
  return { origin, nodes, edges, maxDepth: reached };
}

// Total run time of a plan's animation.
export function waveDuration(plan: WavePlan): number {
  return plan.maxDepth * WAVE_STEP + WAVE_FLASH_DUR;
}

// Spark position along a depth-d edge at time t — 0..1 while the spark is in
// flight, null outside its window.
export function edgeProgress(depth: number, t: number): number | null {
  const p = (t - depth * WAVE_STEP) / WAVE_STEP;
  return p >= 0 && p <= 1 ? p : null;
}

// Flash intensity of a depth-d node at time t — a sin arch (0 → 1 → 0) over
// WAVE_FLASH_DUR starting the moment the ring is reached.
export function nodeFlash(depth: number, t: number): number {
  const p = (t - depth * WAVE_STEP) / WAVE_FLASH_DUR;
  if (p <= 0 || p >= 1) return 0;
  return Math.sin(Math.PI * p);
}
