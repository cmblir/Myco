// Inter-community edge bundling (backlog GRAPH-01) — pure math.
//
// With per-cluster packing every topic is a separated coloured puff and the
// individual cross-cluster links render as near-invisible threads (their
// strength AND opacity are deliberately floored so clusters don't merge). The
// STRUCTURE between topics disappears with them. Bundling restores it at the
// aggregate level: all links between the same two communities collapse into
// ONE thick arced strand whose weight shows how strongly the topics relate —
// the classic hierarchical-edge-bundling / cosmic-filament look.
//
// This module is pure (no three.js) and unit-tested; edgeBundleLayer.ts turns
// the specs into fat-line geometry.

export interface BundleSpec {
  /** Community ids, a < b. */
  a: number;
  b: number;
  /** Number of raw vault links collapsed into this strand. */
  count: number;
}

export interface BundleOpts {
  /** Pairs with fewer raw links than this are noise — leave them to the faint
   * per-edge threads. */
  minCount?: number;
  /** Hard cap on strands (heaviest first) so a hyper-connected vault can't
   * explode the layer into thousands of arcs. */
  maxBundles?: number;
  /** Backbone extraction: each community keeps at most this many strands (its
   * heaviest). A vault whose topics all cross-link a little produces a near-
   * complete pair graph — drawn in full it reads as a woven cocoon around the
   * clusters, which is exactly the "뭉침" impression the layout works to avoid.
   * Keeping only each topic's strongest relations preserves the structure
   * story with a fraction of the ink. */
  maxPerCommunity?: number;
}

export function aggregateBundles(
  edges: readonly { a: number; b: number }[],
  opts: BundleOpts = {},
): BundleSpec[] {
  const minCount = opts.minCount ?? 3;
  const maxBundles = opts.maxBundles ?? 200;
  const maxPerCommunity = opts.maxPerCommunity ?? Infinity;
  const counts = new Map<number, number>();
  for (const e of edges) {
    if (e.a < 0 || e.b < 0 || e.a === e.b) continue;
    const lo = Math.min(e.a, e.b);
    const hi = Math.max(e.a, e.b);
    // Pack the pair into one number key — community ids are small ints.
    const key = lo * 1048576 + hi;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let out: BundleSpec[] = [];
  for (const [key, count] of counts) {
    if (count < minCount) continue;
    out.push({ a: Math.floor(key / 1048576), b: key % 1048576, count });
  }
  out.sort((p, q) => q.count - p.count || p.a - q.a || p.b - q.b);
  if (Number.isFinite(maxPerCommunity)) {
    // Greedy backbone: walk heaviest-first, keep a strand while EITHER side
    // still has quota — every topic keeps its strongest relations, but a hub
    // topic can't fan out to every other cluster.
    const deg = new Map<number, number>();
    out = out.filter((b) => {
      const da = deg.get(b.a) ?? 0;
      const db = deg.get(b.b) ?? 0;
      if (da >= maxPerCommunity && db >= maxPerCommunity) return false;
      deg.set(b.a, da + 1);
      deg.set(b.b, db + 1);
      return true;
    });
  }
  return out.slice(0, maxBundles);
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

// Sample a quadratic bezier from p0 to p1 whose control point bows OUTWARD
// (away from the origin — the vault's centre of mass), so strands arc through
// the void between clusters instead of cutting straight through them.
// `lift` scales the bow as a fraction of the chord length. Returns
// (segments+1) points as a flat xyz array.
export function bundleArc(
  p0: Vec3,
  p1: Vec3,
  segments = 24,
  lift = 0.25,
): Float32Array {
  const mx = (p0.x + p1.x) / 2;
  const my = (p0.y + p1.y) / 2;
  const mz = (p0.z + p1.z) / 2;
  const chord = Math.hypot(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z);
  let ox = mx;
  let oy = my;
  let oz = mz;
  const ol = Math.hypot(ox, oy, oz);
  if (ol < 1e-6) {
    // Midpoint sits on the origin — bow along any chord-perpendicular instead.
    const dx = p1.x - p0.x;
    const dz = p1.z - p0.z;
    const pl = Math.hypot(dz, dx) || 1;
    ox = -dz / pl;
    oy = 0;
    oz = dx / pl;
  } else {
    ox /= ol;
    oy /= ol;
    oz /= ol;
  }
  const cxp = mx + ox * chord * lift;
  const cyp = my + oy * chord * lift;
  const czp = mz + oz * chord * lift;
  const pts = new Float32Array((segments + 1) * 3);
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const u = 1 - t;
    const o = i * 3;
    pts[o] = u * u * p0.x + 2 * u * t * cxp + t * t * p1.x;
    pts[o + 1] = u * u * p0.y + 2 * u * t * cyp + t * t * p1.y;
    pts[o + 2] = u * u * p0.z + 2 * u * t * czp + t * t * p1.z;
  }
  return pts;
}

// Width tier for a strand (0 thin / 1 medium / 2 thick). Screen-space fat-line
// width is per-MATERIAL in three, so the layer draws three batches — a smooth
// per-strand width would need one draw call each, which a 200-strand vault
// can't afford.
export function bundleTier(count: number): 0 | 1 | 2 {
  if (count >= 30) return 2;
  if (count >= 10) return 1;
  return 0;
}
