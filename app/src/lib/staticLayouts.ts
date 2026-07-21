// Deterministic static layouts — pure math over the built graph, no force sim.
//
// "spiral": the vault as a spiral galaxy (the cosmic-refs Andromeda/M101 look).
// Communities are laid along log-spiral arms in size order — the biggest sits
// at the core, so the centre bulges bright and the arms thin outward. Each
// node scatters around its arm segment with a gaussian spread and a thin
// z-thickness, so from a tilt the disc reads as a real galaxy.
//
// "strata": the vault as time strata. x = when the note was last touched
// (rank-scaled, oldest left), y = its community band — reading left to right
// IS the history of the vault, and each band shows when that topic grew.
//
// Both are O(n log n), synchronous (safe on the main thread at 10k nodes),
// seeded per node id — the same vault always lays out the same way.

import type { VaultGraph } from "./graphData";
import { seededUnit } from "./graphData";

// Box-Muller from two seeded uniforms — deterministic gaussian per (id, salt).
function seededGauss(id: string, salt: number): number {
  const u1 = Math.max(1e-6, seededUnit(id, salt));
  const u2 = seededUnit(id, salt + 1);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Communities in size order (largest first); nodes without one (-1) last. */
function communitiesBySize(g: VaultGraph): Map<number, string[]> {
  const byCommunity = new Map<number, string[]>();
  g.forEachNode((id, a) => {
    const cm = (a.community as number) ?? -1;
    const arr = byCommunity.get(cm) ?? [];
    arr.push(id);
    byCommunity.set(cm, arr);
  });
  return new Map(
    [...byCommunity.entries()].sort((a, b) => {
      // Field stars (-1) always trail, regardless of how many there are.
      if (a[0] === -1) return 1;
      if (b[0] === -1) return -1;
      return b[1].length - a[1].length;
    }),
  );
}

export interface SpiralOpts {
  /** World radius of the outermost arm end. */
  targetRadius: number;
  arms?: number;
}

export function applySpiralLayout(g: VaultGraph, o: SpiralOpts): void {
  const n = g.order;
  if (n === 0) return;
  const arms = Math.max(1, o.arms ?? 2);
  const R = o.targetRadius;
  const groups = communitiesBySize(g);

  // Whole communities go to one arm each (round-robin big→small, hubs first
  // within) — a topic reads as a contiguous stretch of arm, and both arms
  // start bright at the core because the two biggest communities anchor them.
  const armSeqs: string[][] = Array.from({ length: arms }, () => []);
  let ci = 0;
  for (const ids of groups.values()) {
    ids.sort((a, b) => (g.getNodeAttribute(b, "deg") ?? 0) - (g.getNodeAttribute(a, "deg") ?? 0));
    armSeqs[ci % arms].push(...ids);
    ci++;
  }

  // Log spiral r = r0·e^(kθ), θ ∈ [0.5π, 3.4π] per arm; r0 chosen so the arm
  // end lands on targetRadius. k tuned to the M101 pitch (~0.2 gives the open
  // pinwheel; smaller coils tighter).
  const thetaMin = Math.PI * 0.5;
  const thetaMax = Math.PI * 3.4;
  const k = 0.2;
  const r0 = R / Math.exp(k * thetaMax);

  for (let arm = 0; arm < arms; arm++) {
    const seq = armSeqs[arm];
    for (let i = 0; i < seq.length; i++) {
      const id = seq[i];
      const t = seq.length > 1 ? i / (seq.length - 1) : 0; // 0 core → 1 rim
      const theta = thetaMin + t * (thetaMax - thetaMin);
      const r = r0 * Math.exp(k * theta);
      const phase = theta + (arm * 2 * Math.PI) / arms;
      // Arm width tapers outward; the core is a fat bulge, the rim a thin wisp.
      const width = R * (0.085 - 0.05 * t);
      const across = seededGauss(id, 11) * width;
      const along = seededGauss(id, 13) * width * 1.6;
      // Perpendicular (in-plane) and tangential unit vectors of the arm.
      const px = Math.cos(phase);
      const py = Math.sin(phase);
      g.setNodeAttribute(id, "x", px * r + px * across - py * along * 0.4);
      g.setNodeAttribute(id, "y", py * r + py * across + px * along * 0.4);
      // Thin disc with a thicker core bulge — the galaxy silhouette from a tilt.
      g.setNodeAttribute(id, "z", seededGauss(id, 17) * R * (0.05 - 0.032 * t));
    }
  }
}

export interface StrataOpts {
  /** Absolute path → mtime ms (missing/unknown files sink to the oldest edge). */
  mtimes: Map<string, number> | null;
  targetRadius: number;
}

export function applyStrataLayout(g: VaultGraph, o: StrataOpts): void {
  const n = g.order;
  if (n === 0) return;
  const R = o.targetRadius;
  const groups = communitiesBySize(g);

  // x: time rank (oldest left). Files with no mtime (ghosts, unindexed) pin to
  // a thin "before memory" column at the far-left edge instead of spreading —
  // rank-spreading ties would fake a history that isn't there.
  const known = g.nodes().filter((id) => o.mtimes?.has(id));
  const unknown = g.nodes().filter((id) => !o.mtimes?.has(id));
  known.sort((a, b) => (o.mtimes?.get(a) ?? 0) - (o.mtimes?.get(b) ?? 0));
  const xOf = new Map<string, number>();
  for (let i = 0; i < known.length; i++) {
    // Known history spans [-0.85R, R]; the left margin belongs to the unknowns.
    const t = known.length > 1 ? i / (known.length - 1) : 0.5;
    xOf.set(known[i], -0.85 * R + t * 1.85 * R);
  }
  for (const id of unknown) {
    xOf.set(id, -R + seededGauss(id, 29) * R * 0.02);
  }

  // y: one horizontal band per community, big communities near the middle.
  const bands = groups.size;
  const bandSpan = R * 1.2;
  let rank = 0;
  for (const [, members] of groups) {
    // Centre-out ordering: 0, +1, -1, +2, -2… so the largest sits mid-chart.
    const step = Math.ceil(rank / 2) * (rank % 2 === 0 ? 1 : -1);
    const yc = bands > 1 ? (step * bandSpan) / bands : 0;
    const jitter = (bandSpan / Math.max(2, bands)) * 0.28;
    for (const id of members) {
      g.setNodeAttribute(id, "x", xOf.get(id) ?? 0);
      g.setNodeAttribute(id, "y", yc + seededGauss(id, 23) * jitter);
      g.setNodeAttribute(id, "z", 0);
    }
    rank++;
  }
}
