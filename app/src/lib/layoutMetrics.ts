// Settled-layout metrics (backlog A1) — computed by the sim worker when the
// simulation reaches alphaMin and posted with the "settle" message, so the
// main thread frames the camera / sizes LOD / rebuilds bundle strands from the
// layout's ACTUAL extent instead of re-guessing it from linkDistance
// heuristics (the guesses were the other half of the layout-churn problem:
// every force retune silently invalidated them).
//
// Pure math, dependency-free: shared by the worker (producer), the scene
// (consumer) and vitest.

export interface ClusterMetric {
  community: number;
  x: number;
  y: number;
  z: number;
  /** RMS distance of members from the centroid — the cluster's "puff" radius. */
  r: number;
  n: number;
}

export interface LayoutMetrics {
  /** Centroid of all measured nodes. */
  cx: number;
  cy: number;
  cz: number;
  /** 95th-percentile distance from the centroid — matches the camera-fit rule
   * (a few drifted orphans must not blow the frame up). */
  radius: number;
  n: number;
  clusters: ClusterMetric[];
}

export interface MetricNode {
  x: number;
  y: number;
  z: number;
  community: number;
}

export function computeLayoutMetrics(nodes: readonly MetricNode[]): LayoutMetrics {
  const n = nodes.length;
  if (n === 0) return { cx: 0, cy: 0, cz: 0, radius: 0, n: 0, clusters: [] };
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const p of nodes) {
    cx += p.x;
    cy += p.y;
    cz += p.z;
  }
  cx /= n;
  cy /= n;
  cz /= n;
  const dists = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = nodes[i];
    dists[i] = Math.hypot(p.x - cx, p.y - cy, p.z - cz);
  }
  dists.sort();
  const radius = Math.max(1, dists[Math.floor((n - 1) * 0.95)]);

  // Per-community centroid + RMS radius (same definition the scene's LOD uses).
  const sx = new Map<number, number>();
  const sy = new Map<number, number>();
  const sz = new Map<number, number>();
  const sn = new Map<number, number>();
  for (const p of nodes) {
    if (p.community < 0) continue;
    sx.set(p.community, (sx.get(p.community) ?? 0) + p.x);
    sy.set(p.community, (sy.get(p.community) ?? 0) + p.y);
    sz.set(p.community, (sz.get(p.community) ?? 0) + p.z);
    sn.set(p.community, (sn.get(p.community) ?? 0) + 1);
  }
  const r2 = new Map<number, number>();
  for (const p of nodes) {
    const c = p.community;
    const m = sn.get(c);
    if (c < 0 || !m) continue;
    const dx = p.x - sx.get(c)! / m;
    const dy = p.y - sy.get(c)! / m;
    const dz = p.z - sz.get(c)! / m;
    r2.set(c, (r2.get(c) ?? 0) + dx * dx + dy * dy + dz * dz);
  }
  const clusters: ClusterMetric[] = [];
  for (const [c, m] of sn) {
    clusters.push({
      community: c,
      x: sx.get(c)! / m,
      y: sy.get(c)! / m,
      z: sz.get(c)! / m,
      r: Math.sqrt((r2.get(c) ?? 0) / m),
      n: m,
    });
  }
  clusters.sort((a, b) => b.n - a.n || a.community - b.community);
  return { cx, cy, cz, radius, n, clusters };
}
