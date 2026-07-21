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

export interface CelestialOpts {
  /** Sphere radius the constellations sit on. */
  targetRadius: number;
}

/** The vault as a celestial sphere: every note on one shell, each community a
 * constellation patch (a spherical cap sized by member count), hubs at the
 * patch centre. Fly inside and it's a planetarium; orbit outside and it's a
 * star globe. Patch directions come from a fibonacci spiral over communities,
 * so patches spread evenly and deterministically. */
export function applyCelestialLayout(g: VaultGraph, o: CelestialOpts): void {
  if (g.order === 0) return;
  const R = o.targetRadius;
  const groups = communitiesBySize(g);
  const total = g.order;
  const golden = Math.PI * (3 - Math.sqrt(5));
  let ci = 0;
  const count = groups.size;
  for (const [, members] of groups) {
    // Patch centre: fibonacci-sphere direction #ci (even spread, no poles bias).
    const t = count > 1 ? ci / (count - 1) : 0.5;
    const cy = 1 - 2 * t;
    const cr = Math.sqrt(Math.max(0, 1 - cy * cy));
    const ca = golden * ci;
    const centre = {
      x: Math.cos(ca) * cr,
      y: cy,
      z: Math.sin(ca) * cr,
    };
    // Angular patch radius grows with membership (sqrt keeps big topics from
    // swallowing the sky); floor keeps tiny topics visibly a PATCH, not a dot.
    const cap = Math.max(0.1, Math.sqrt(members.length / total) * 0.85);
    // Tangent basis at the patch centre.
    const up = Math.abs(centre.y) > 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
    let tx = {
      x: up.y * centre.z - up.z * centre.y,
      y: up.z * centre.x - up.x * centre.z,
      z: up.x * centre.y - up.y * centre.x,
    };
    const tl = Math.hypot(tx.x, tx.y, tx.z) || 1;
    tx = { x: tx.x / tl, y: tx.y / tl, z: tx.z / tl };
    const ty = {
      x: centre.y * tx.z - centre.z * tx.y,
      y: centre.z * tx.x - centre.x * tx.z,
      z: centre.x * tx.y - centre.y * tx.x,
    };
    members.sort(
      (a, b) => (g.getNodeAttribute(b, "deg") ?? 0) - (g.getNodeAttribute(a, "deg") ?? 0),
    );
    for (let i = 0; i < members.length; i++) {
      const id = members[i];
      // Hubs central: angular distance grows with rank (sunflower packing).
      const rr = cap * Math.sqrt((i + 0.5) / members.length);
      const aa = golden * i + seededUnit(id, 41) * 0.35;
      const ox = Math.cos(aa) * rr;
      const oy = Math.sin(aa) * rr;
      let px = centre.x + tx.x * ox + ty.x * oy;
      let py = centre.y + tx.y * ox + ty.y * oy;
      let pz = centre.z + tx.z * ox + ty.z * oy;
      const pl = Math.hypot(px, py, pz) || 1;
      // Back onto the shell, with a whisper of radial jitter for depth twinkle.
      const rad = R * (1 + (seededUnit(id, 43) - 0.5) * 0.04);
      px = (px / pl) * rad;
      py = (py / pl) * rad;
      pz = (pz / pl) * rad;
      g.setNodeAttribute(id, "x", px);
      g.setNodeAttribute(id, "y", py);
      g.setNodeAttribute(id, "z", pz);
    }
    ci++;
  }
}

export interface RadialOpts {
  /** World radius of the outermost shell. */
  targetRadius: number;
}

/** The vault as a solar system around its heaviest hub: BFS-depth shells in 3D
 * (depth 1 inner shell, depth 2 next…), each shell's nodes spread by community
 * sector. Reads "how far is everything from the centre of my thinking".
 * Disconnected notes take the outermost shell. */
export function applyRadialLayout(g: VaultGraph, o: RadialOpts): void {
  if (g.order === 0) return;
  const R = o.targetRadius;
  // Centre: the highest-degree node (ties broken by id for determinism).
  let hub: string | null = null;
  let best = -1;
  g.forEachNode((id, a) => {
    const deg = (a.deg as number) ?? 0;
    if (deg > best || (deg === best && (hub === null || id < hub))) {
      best = deg;
      hub = id;
    }
  });
  if (!hub) return;
  // BFS depths.
  const depth = new Map<string, number>([[hub, 0]]);
  const queue: string[] = [hub];
  let head = 0;
  let maxDepth = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    const d = depth.get(cur) ?? 0;
    for (const nb of g.neighbors(cur)) {
      if (depth.has(nb)) continue;
      depth.set(nb, d + 1);
      maxDepth = Math.max(maxDepth, d + 1);
      queue.push(nb);
    }
  }
  const outer = maxDepth + 1; // disconnected notes orbit past everything
  const shells = Math.max(1, outer);
  const golden = Math.PI * (3 - Math.sqrt(5));
  // Group members per shell for even fibonacci spread within each.
  const byShell = new Map<number, string[]>();
  g.forEachNode((id) => {
    const d = depth.get(id) ?? outer;
    const arr = byShell.get(d) ?? [];
    arr.push(id);
    byShell.set(d, arr);
  });
  for (const [d, members] of byShell) {
    if (d === 0) {
      g.setNodeAttribute(members[0], "x", 0);
      g.setNodeAttribute(members[0], "y", 0);
      g.setNodeAttribute(members[0], "z", 0);
      continue;
    }
    members.sort(); // deterministic order within a shell
    const rad = (R * d) / shells;
    for (let i = 0; i < members.length; i++) {
      const id = members[i];
      // Fibonacci sphere within the shell + per-node jitter so successive
      // shells don't moiré against each other.
      const t = members.length > 1 ? i / (members.length - 1) : 0.5;
      const y = 1 - 2 * t;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const a = golden * i + seededUnit(id, 47) * 0.5;
      const wob = 1 + (seededUnit(id, 53) - 0.5) * 0.08;
      g.setNodeAttribute(id, "x", Math.cos(a) * r * rad * wob);
      g.setNodeAttribute(id, "y", y * rad * wob);
      g.setNodeAttribute(id, "z", Math.sin(a) * r * rad * wob);
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
