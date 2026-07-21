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

/** One date gridline of the chronicle's time axis: a world-x position and the
 * date/period text that sits under it. Returned so the scene can draw the axis
 * with the SAME time→x mapping the nodes use. */
export interface TimeTick {
  x: number;
  label: string;
  /** The "before memory" column (unknown mtimes) is styled dimmer + no gridline. */
  unknown?: boolean;
}

export interface StrataResult {
  ticks: TimeTick[];
  /** World-y extent of the note bands, so the axis draws gridlines to fit. */
  yTop: number;
  yBottom: number;
}

// Format a tick date at the granularity the span calls for: multi-year history
// reads as years, a tighter span as "Mon YYYY". Intl keeps it locale-correct.
function tickLabel(ms: number, spanDays: number): string {
  const d = new Date(ms);
  if (spanDays > 900) {
    return new Intl.DateTimeFormat(undefined, { year: "numeric" }).format(d);
  }
  if (spanDays > 90) {
    return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short" }).format(d);
  }
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(d);
}

// The vault as a CHRONICLE: notes laid on a real time axis (x), stacked into
// community swim-lanes (y). Unlike a rank plot, x is ACTUAL elapsed time, so a
// burst of activity clumps into a dense column and a quiet stretch opens a gap —
// the reader sees the rhythm of the vault's history, not just its order. Returns
// the date ticks + y-extent so the scene can label the axis.
export function applyStrataLayout(g: VaultGraph, o: StrataOpts): StrataResult {
  const empty: StrataResult = { ticks: [], yTop: 0, yBottom: 0 };
  const n = g.order;
  if (n === 0) return empty;
  const R = o.targetRadius;
  const groups = communitiesBySize(g);

  // Real-time x: files with a known mtime map linearly across [minT, maxT] →
  // [-0.8R, R] so gaps and bursts show. Files with no mtime (ghosts, unindexed)
  // pin to a thin "before memory" column at the far-left edge — a rank spread
  // would fake a history they don't have.
  const known = g.nodes().filter((id) => o.mtimes?.has(id));
  const unknown = g.nodes().filter((id) => !o.mtimes?.has(id));
  const times = known.map((id) => o.mtimes?.get(id) ?? 0);
  const minT = times.length ? Math.min(...times) : 0;
  const maxT = times.length ? Math.max(...times) : 0;
  const spanT = Math.max(1, maxT - minT);
  const X0 = -0.8 * R; // oldest known note
  const X1 = R; // newest known note
  const timeToX = (ms: number): number => X0 + ((ms - minT) / spanT) * (X1 - X0);

  const xOf = new Map<string, number>();
  for (const id of known) {
    xOf.set(id, timeToX(o.mtimes?.get(id) ?? minT));
  }
  const unknownX = -R; // the "before memory" column
  for (const id of unknown) {
    xOf.set(id, unknownX + seededGauss(id, 29) * R * 0.015);
  }

  // y: one horizontal swim-lane per community, big communities near the middle.
  const bands = groups.size;
  const bandSpan = R * 1.2;
  const laneY = (rank: number): number => {
    const step = Math.ceil(rank / 2) * (rank % 2 === 0 ? 1 : -1); // 0,+1,-1,+2,-2…
    return bands > 1 ? (step * bandSpan) / bands : 0;
  };
  let rank = 0;
  let yMax = 0;
  for (const [, members] of groups) {
    const yc = laneY(rank);
    yMax = Math.max(yMax, Math.abs(yc));
    const jitter = (bandSpan / Math.max(2, bands)) * 0.28;
    for (const id of members) {
      g.setNodeAttribute(id, "x", xOf.get(id) ?? 0);
      g.setNodeAttribute(id, "y", yc + seededGauss(id, 23) * jitter);
      g.setNodeAttribute(id, "z", 0);
    }
    rank++;
  }

  // Date ticks: ~6 evenly-spaced markers across the known span, at their true x.
  // Drop a tick whose label repeats the previous one (year granularity over a
  // multi-year span lands two markers in the same year → "2024 2024").
  const ticks: TimeTick[] = [];
  if (times.length >= 2) {
    const spanDays = spanT / 86_400_000;
    const STEPS = Math.min(6, Math.max(2, known.length));
    let prev = "";
    for (let i = 0; i < STEPS; i++) {
      const ms = minT + (spanT * i) / (STEPS - 1);
      const label = tickLabel(ms, spanDays);
      if (label === prev) continue;
      prev = label;
      ticks.push({ x: timeToX(ms), label });
    }
  } else if (times.length === 1) {
    ticks.push({ x: timeToX(minT), label: tickLabel(minT, 1) });
  }
  if (unknown.length > 0) {
    ticks.unshift({ x: unknownX, label: "—", unknown: true });
  }
  const yPad = bandSpan / Math.max(2, bands) + R * 0.12;
  return { ticks, yTop: yMax + yPad, yBottom: -(yMax + yPad) };
}

export interface WalrusOpts {
  targetRadius: number;
}

// An orthonormal pair perpendicular to unit vector `a` — the plane a child cone
// spreads in. Picks the more stable of two cross products to avoid degeneracy.
function perpBasis(a: [number, number, number]): [number[], number[]] {
  const ref: [number, number, number] =
    Math.abs(a[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let ux = a[1] * ref[2] - a[2] * ref[1];
  let uy = a[2] * ref[0] - a[0] * ref[2];
  let uz = a[0] * ref[1] - a[1] * ref[0];
  const ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul;
  uy /= ul;
  uz /= ul;
  const wx = a[1] * uz - a[2] * uy;
  const wy = a[2] * ux - a[0] * uz;
  const wz = a[0] * uy - a[1] * ux;
  return [
    [ux, uy, uz],
    [wx, wy, wz],
  ];
}

// "walrus": the vault as a 3D HYPERBOLIC SPANNING TREE (the CAIDA Walrus look).
// A BFS spanning tree is rooted at the busiest hub and grown OUTWARD into a
// ball: the root's children fan across the whole sphere on long spokes, and
// every deeper node bursts its children into a tight cone around its own outward
// axis. Edge length decays geometrically with depth, so deep subtrees compress
// into "firework" bundles near the boundary — the hyperbolic fisheye that makes
// a huge tree legible from its root. Disconnected components root at their own
// hub on the boundary shell. The scene draws the real wikilink edges over this,
// so the tree spokes AND the cross-links both show.
export function applyWalrusLayout(g: VaultGraph, o: WalrusOpts): void {
  const n = g.order;
  if (n === 0) return;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const DECAY = 0.64; // radial-step shrink per depth. The step is measured from
  // ORIGIN (r(d) = R·(1−DECAY^d)), so fireworks land at MANY radii — 0.36R,
  // 0.59R, 0.74R… — filling the ball. A "long root spoke" instead shoved every
  // first-level branch onto one shell, hollowing the centre on vaults whose hub
  // has few big branches (the broken ring look).
  const CONE = 1.0; // fallback cone half-angle when a node has no allocated share

  // Degree lookup (attribute, falling back to live degree) for hub selection.
  const degOf = (id: string): number =>
    (g.getNodeAttribute(id, "deg") as number) ?? g.degree(id);

  const parent = new Map<string, string | null>();
  const depth = new Map<string, number>();
  const children = new Map<string, string[]>();
  const order: string[] = []; // BFS order — every parent precedes its children

  // BFS a whole component from `start`, recording the spanning tree.
  const bfs = (start: string): void => {
    parent.set(start, null);
    depth.set(start, 0);
    children.set(start, []);
    order.push(start);
    const q = [start];
    let h = 0;
    while (h < q.length) {
      const cur = q[h++];
      const d = depth.get(cur) ?? 0;
      // Deterministic, and hubs first so the biggest sub-bursts get placed early.
      const nbs = g
        .neighbors(cur)
        .slice()
        .sort((x, y) => degOf(y) - degOf(x) || (x < y ? -1 : 1));
      for (const nb of nbs) {
        if (depth.has(nb)) continue;
        depth.set(nb, d + 1);
        parent.set(nb, cur);
        children.set(nb, []);
        children.get(cur)!.push(nb);
        order.push(nb);
        q.push(nb);
      }
    }
  };

  // Main root = global max-degree node; then each disconnected component roots
  // at its own max-degree node (both deterministic).
  const all = g.nodes().slice().sort();
  let root = all[0];
  for (const id of all) if (degOf(id) > degOf(root)) root = id;
  bfs(root);
  const roots: string[] = [root];
  for (const id of all) {
    if (depth.has(id)) continue;
    // `all` is degree-agnostic but sorted; the first unvisited node of a
    // component roots it. (Components are small tails — orphans and pairs — so a
    // perfect per-component hub buys nothing over determinism here.)
    bfs(id);
    roots.push(id);
  }

  // Subtree weight (nodes in each subtree), bottom-up — the KEY to a real cone
  // tree: a child is given a cone whose solid angle is proportional to its
  // subtree's weight, so a heavy branch gets room to spread and a light one
  // stays a thin twig. Without this, big subtrees pile on top of each other into
  // an unreadable blob (the earlier fixed-cone version's failure).
  const weight = new Map<string, number>();
  for (let i = order.length - 1; i >= 0; i--) {
    const v = order[i];
    let wsum = 1;
    for (const c of children.get(v) ?? []) wsum += weight.get(c) ?? 1;
    weight.set(v, wsum);
  }

  const pos = new Map<string, [number, number, number]>();
  const axis = new Map<string, [number, number, number]>();
  const coneHalf = new Map<string, number>(); // half-angle a node may spread kids into

  const fibDir = (i: number, N: number, seed: string): [number, number, number] => {
    const t = N > 1 ? i / (N - 1) : 0.5;
    const y = 1 - 2 * t;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const a = golden * i + seededUnit(seed, 71) * 0.4;
    return [Math.cos(a) * r, y, Math.sin(a) * r];
  };

  // Component roots: main at the centre spreading over the FULL sphere; others
  // out on the rim as compact local bursts so a disconnected tail never becomes
  // its own giant lonely firework floating off in space.
  roots.forEach((rt, ri) => {
    if (ri === 0) {
      pos.set(rt, [0, 0, 0]);
      axis.set(rt, [0, 1, 0]);
      coneHalf.set(rt, Math.PI); // the root fans children over the whole sphere
    } else {
      const d = fibDir(ri, roots.length, rt);
      pos.set(rt, [d[0] * 0.9, d[1] * 0.9, d[2] * 0.9]);
      axis.set(rt, d);
      coneHalf.set(rt, 0.85);
    }
  });

  // Grow each node's children in BFS order (parent already placed). Children are
  // distributed over the parent's spherical cap by CUMULATIVE weight (area ∝
  // angle², so polar ∝ √cumFrac spreads them evenly by subtree mass), with the
  // azimuth on a golden spiral. Radial step decays with depth so the tree fills
  // a ball and deep subtrees settle into distinct fireworks near the boundary.
  for (const v of order) {
    const kids = children.get(v) ?? [];
    if (kids.length === 0) continue;
    const d = depth.get(v) ?? 0;
    // Radial increment from parent = r(d+1) − r(d) with r(d)=1−DECAY^d, so the
    // cumulative distance from origin converges toward the boundary and each
    // depth lands at its own radius → the ball fills evenly, no hollow shell.
    const step = Math.pow(DECAY, d) * (1 - DECAY);
    const H = coneHalf.get(v) ?? CONE;
    const [px, py, pz] = pos.get(v)!;
    const a = axis.get(v)!;
    const [u, w] = perpBasis(a);
    // Heaviest branches first → they claim the axis-adjacent room, light twigs
    // fill the rim of the cap. Deterministic tie-break.
    const sorted = kids
      .slice()
      .sort((x, y) => (weight.get(y) ?? 1) - (weight.get(x) ?? 1) || (x < y ? -1 : 1));
    const totalW = sorted.reduce((s, c) => s + (weight.get(c) ?? 1), 0);
    let cum = 0;
    const capCos = Math.cos(Math.min(Math.PI, H));
    sorted.forEach((c, j) => {
      const frac = (weight.get(c) ?? 1) / totalW;
      // Equal-AREA polar within the cap (cos is linear in area on a sphere), so
      // children spread evenly by subtree mass instead of bunching at the pole —
      // for the root (H=π) this is the standard even-sphere distribution.
      const areaFrac = cum + frac * 0.5;
      const polar = Math.acos(Math.max(-1, Math.min(1, 1 - areaFrac * (1 - capCos))));
      cum += frac;
      const az = golden * j + seededUnit(c, 71) * 0.5;
      const ca = Math.cos(az);
      const sa = Math.sin(az);
      const cs = Math.cos(polar);
      const sn = Math.sin(polar);
      let dx = a[0] * cs + (u[0] * ca + w[0] * sa) * sn;
      let dy = a[1] * cs + (u[1] * ca + w[1] * sa) * sn;
      let dz = a[2] * cs + (u[2] * ca + w[2] * sa) * sn;
      const dl = Math.hypot(dx, dy, dz) || 1;
      dx /= dl;
      dy /= dl;
      dz /= dl;
      const jit = 1 + (seededUnit(c, 59) - 0.5) * 0.1;
      pos.set(c, [px + dx * step * jit, py + dy * step * jit, pz + dz * step * jit]);
      axis.set(c, [dx, dy, dz]);
      // The child's own cone ∝ √(its weight share), capped tight so a firework
      // stays a compact burst (a wide cone smears neighbouring bursts together).
      coneHalf.set(c, Math.min(1.0, H * Math.sqrt(frac) * 1.15));
    });
  }

  // Normalise so the farthest node sits at targetRadius (the ball boundary).
  let maxR = 1e-6;
  for (const p of pos.values()) maxR = Math.max(maxR, Math.hypot(p[0], p[1], p[2]));
  const s = o.targetRadius / maxR;
  for (const id of all) {
    const p = pos.get(id) ?? [0, 0, 0];
    g.setNodeAttribute(id, "x", p[0] * s);
    g.setNodeAttribute(id, "y", p[1] * s);
    g.setNodeAttribute(id, "z", p[2] * s);
  }
}
