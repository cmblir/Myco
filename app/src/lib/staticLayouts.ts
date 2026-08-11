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
import { hexToRgb01, seededUnit } from "./graphData";

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
  const DECAY = 0.6; // deep-burst step shrink per depth (compact fireworks)
  const BURST_STEP = 0.13; // radial step for a depth≥1 node off its parent —
  // small, so a subtree stays a tight firework instead of a diffuse cloud
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
    // Deep steps decay so a subtree stays a compact burst. The ROOT's step is
    // overridden per-child below (its branches scatter through the ball volume,
    // not onto one shell — the fix for the hollow-centre "broken ring" on a
    // shallow-wide vault whose hub has many topic branches).
    const step = d === 0 ? 0 : BURST_STEP * Math.pow(DECAY, d - 1);
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
      // Root's branches scatter through the ball by VOLUME (radius ∝ cbrt of
      // their cumulative fraction → uniform density, some near the core, some at
      // the rim) so the centre fills instead of shelling. Deeper nodes take the
      // decaying `step` for a tight firework off their parent.
      const stepC =
        d === 0
          ? 0.22 + 0.72 * Math.cbrt(Math.min(1, cum))
          : step;
      const jit = 1 + (seededUnit(c, 59) - 0.5) * 0.1;
      pos.set(c, [px + dx * stepC * jit, py + dy * stepC * jit, pz + dz * stepC * jit]);
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

/** Hyphae grouped by stroke width. `LineMaterial` carries ONE width per set, so
 *  taper is expressed as several sets rather than a per-vertex attribute.
 *  Cluster colour, in contrast, rides PER-VERTEX colour on top of these same
 *  width buckets (LineMaterial.vertexColors) rather than further bucketing by
 *  (width x cluster) — that would multiply draw calls by the community count
 *  for no benefit, since colour and taper are independent axes and colour
 *  already needs to blend smoothly segment-to-segment (see buildMyceliumMat). */
export interface HyphaBucket {
  /** Screen-pixel line width for this bucket. */
  width: number;
  /** Flat [x1,y1,z1, x2,y2,z2, …] in world space. */
  positions: Float32Array;
  /** Flat [r1,g1,b1, r2,g2,b2, …] (0..1), one colour per endpoint, same
   *  layout/order as `positions` — see LineSegmentsGeometry.setColors. */
  colors: Float32Array;
  /** Growth index of each segment, ascending — see myceliumScene.ts
   *  setProgress, which reveals segments up to a threshold via binary search. */
  birth: Float32Array;
}

/** One grown hypha point: a position plus the parent it extended or branched
 *  from. Exported so tests (and the note-embedding below) can walk the mat as
 *  a graph. */
export interface HyphaNode {
  x: number;
  y: number;
  z: number;
  /** Index into the same array, or -1 for a spore. */
  parent: number;
  /** Branch generation. Drives stroke width (taper) — see buildMyceliumMat. */
  order: number;
  /** Set on an anastomosis bridge: the index of the pre-existing hypha point
   *  this one fused with. The bridge is still drawn as a real segment
   *  (parent → this, positioned at bridgeTo's coordinates), and this field
   *  additionally makes it an adjacency edge to bridgeTo — the loop that lets
   *  the note-embedding BFS shortcut across the mat instead of only ever
   *  walking back through the trunk. */
  bridgeTo?: number;
}

// Hyphal growth: tip extension + branching + anastomosis. The mat's SHAPE is
// independent of the wikilink graph on purpose — see buildMyceliumMat for how
// notes get embedded into it afterward.
//
// Proven in a standalone prototype before landing here, which is how two
// confident-but-wrong ideas got caught:
//
//   1. A spanning tree over the wikilinks. The real vault's tree is four levels
//      deep with one hub holding 34 children, so there was no lineage for a
//      thread to run along and it rendered as a starburst.
//   2. "Anastomosis is the missing ingredient." Fusing tips DID add loops, but
//      retiring a tip on every fusion thinned the mat faster than the loops
//      filled it, so more fusion produced a SPARSER picture. Fusion now records
//      the bridge and lets the tip carry on.
//
// A third bug surfaced while measuring: the fusion radius is larger than the
// growth step, so every tip kept re-touching its own fresh trail and half the
// mat became bridges — a rate that did not even respond to the fusion radius.
// A GLOBAL recent-window cannot fix that (with many tips it holds none of any
// one tip's own points), so each tip carries its own trail instead.
export function growMycelium(
  count: number,
  opts: {
    spores?: number;
    step?: number;
    branchPct?: number;
    fuse?: number;
    maxNodes?: number;
    /** Wander and branch through all three dimensions and retire tips on a
     *  SPHERE instead of a circle, so the mat fills a rounded volume rather
     *  than a disc with cosmetic z jitter. Off by default: every existing
     *  caller — and the flattened 2D view, which zeroes z afterward anyway —
     *  keeps the original planar-wander shape byte-for-byte. See
     *  buildMyceliumMat's `dim` option, which is what actually turns this on. */
    volumetric?: boolean;
  } = {},
): HyphaNode[] {
  const SEED = "mycelium-mat"; // fixed: the shape must not depend on the graph
  const VOL = opts.volumetric ?? false;
  // A volumetric mat spreads the SAME node budget over a ball instead of a
  // disc — roughly 30x more space (measured: z-extent alone grows from ~3%
  // to ~94% of the xy-extent). With only 4 spores, the note-embedding's many
  // separate small/disconnected components round-robin onto those same 4
  // seed regions and exhaust them locally faster than the now-sparser mat can
  // route around (fewer nearby bridges once density drops) — measured on the
  // real vault shape (1244 notes/~440 edges): hop distance for graph-adjacent
  // notes blew out to max 63 (was 5) with 4 spores, but a clean, STABLE 5
  // (matching 2D exactly) at 16 — a smooth minimum (13 at 8, 6 at 12, 6 at 24,
  // 9 at 32), unlike fuse-radius tuning, which was noisy and non-monotonic.
  // More seed regions is the direct fix: less crowding per region.
  const SPORES = opts.spores ?? (VOL ? 16 : 4);
  const STEP = opts.step ?? 0.021;
  const BRANCH_PCT = opts.branchPct ?? 3.2; // per tip per step
  const FUSE = opts.fuse ?? 0.049; // world units, ~7px at the prototype's scale
  const MAX_NODES = opts.maxNodes ?? Math.min(9000, Math.max(900, count * 4));
  const MAX_TIPS = 260;
  const MAX_LIFE = 260;
  const MAX_ORDER = 5;
  const BOUND = 1.15;

  let draw = 0;
  const rnd = (): number => seededUnit(SEED, draw++);
  // A uniformly random direction on the unit sphere (Archimedes' hat-box: y
  // uniform in [-1,1], azimuth uniform) — volumetric tips seed their first
  // heading from this instead of one in-plane angle.
  const randDir = (): [number, number, number] => {
    const y = 1 - 2 * rnd();
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const az = rnd() * Math.PI * 2;
    return [Math.cos(az) * r, y, Math.sin(az) * r];
  };

  const nodes: HyphaNode[] = [];
  interface Tip {
    node: number;
    a: number; // planar heading — the 2D path only
    dir: [number, number, number]; // 3D heading — the volumetric path only
    order: number;
    life: number;
    /** This tip's own recent points — see the anastomosis note above. */
    trail: number[];
  }
  let tips: Tip[] = [];

  // Uniform grid over laid-down points, so a tip can ask "is another hypha
  // within FUSE of me" without scanning the whole mat. Planar mode keys by
  // (x,y) only (unchanged); volumetric adds the z cell — a 2D-only proximity
  // check would let a bridge fuse with a target far away in z, which is
  // exactly the long-chord defect this mat exists to avoid.
  const cell = Math.max(FUSE, 1e-4);
  const grid = new Map<string, number[]>();
  const key = (x: number, y: number, z: number): string =>
    VOL
      ? `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`
      : `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  const remember = (i: number): void => {
    const n = nodes[i];
    const k = key(n.x, n.y, n.z);
    const b = grid.get(k);
    if (b) b.push(i);
    else grid.set(k, [i]);
  };
  // Nearest earlier point, skipping the tip's own fresh trail.
  const nearest = (x: number, y: number, z: number, own: Set<number>): number => {
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    const cz = Math.floor(z / cell);
    let best = -1;
    let bestD = FUSE;
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        for (let oz = VOL ? -1 : 0; oz <= (VOL ? 1 : 0); oz++) {
          const k = VOL ? `${cx + ox},${cy + oy},${cz + oz}` : `${cx + ox},${cy + oy}`;
          const b = grid.get(k);
          if (!b) continue;
          for (const i of b) {
            if (own.has(i)) continue;
            const d = VOL
              ? Math.hypot(x - nodes[i].x, y - nodes[i].y, z - nodes[i].z)
              : Math.hypot(x - nodes[i].x, y - nodes[i].y);
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          }
        }
      }
    }
    return best;
  };

  // Spores spread over the field, not stacked at one origin — one origin
  // makes an early puffball instead of a mat. Volumetric spores fan their
  // centres over a full sphere (fibonacci spread) instead of a ring on z=0,
  // and each seeds 3 tips in independent random directions instead of one
  // in-plane fan — spores distribute THROUGH the volume, not across a disc.
  const spores = Math.max(1, Math.min(SPORES, Math.ceil(MAX_NODES / 40)));
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let s = 0; s < spores; s++) {
    if (VOL) {
      const t = spores > 1 ? s / (spores - 1) : 0.5;
      const cy = 1 - 2 * t;
      const cr = Math.sqrt(Math.max(0, 1 - cy * cy));
      const ca = golden * s;
      const d = 0.16 * (0.3 + rnd() * 0.7);
      nodes.push({
        x: Math.cos(ca) * cr * d,
        y: cy * d,
        z: Math.sin(ca) * cr * d,
        parent: -1,
        order: 0,
      });
      const spore = nodes.length - 1;
      remember(spore);
      for (let k = 0; k < 3; k++) {
        tips.push({ node: spore, a: 0, dir: randDir(), order: 0, life: 0, trail: [spore] });
      }
    } else {
      const a = (s / spores) * Math.PI * 2 + rnd() * 0.9;
      const d = 0.16 * (0.3 + rnd() * 0.7);
      nodes.push({ x: Math.cos(a) * d, y: Math.sin(a) * d, z: 0, parent: -1, order: 0 });
      const spore = nodes.length - 1;
      remember(spore);
      for (let k = 0; k < 3; k++) {
        tips.push({
          node: spore,
          a: (k / 3) * Math.PI * 2 + rnd(),
          dir: [0, 0, 0],
          order: 0,
          life: 0,
          trail: [spore],
        });
      }
    }
  }

  while (tips.length > 0 && nodes.length < MAX_NODES) {
    const next: Tip[] = [];
    for (const t of tips) {
      if (nodes.length >= MAX_NODES) break;
      const from = nodes[t.node];
      let nx: number;
      let ny: number;
      let nz: number;
      if (VOL) {
        // Isotropic wander: nudge the heading vector by a small random
        // vector and renormalize, so a tip can curve toward ANY neighbouring
        // direction on the sphere — not just left/right within one plane,
        // which is what actually makes the mat explore real depth.
        const wx = t.dir[0] + (rnd() - 0.5) * 0.6;
        const wy = t.dir[1] + (rnd() - 0.5) * 0.6;
        const wz = t.dir[2] + (rnd() - 0.5) * 0.6;
        const wl = Math.hypot(wx, wy, wz) || 1;
        t.dir = [wx / wl, wy / wl, wz / wl];
        nx = from.x + t.dir[0] * STEP;
        ny = from.y + t.dir[1] * STEP;
        nz = from.z + t.dir[2] * STEP;
      } else {
        t.a += (rnd() - 0.5) * 0.42; // wander ~±0.21 rad per step
        nx = from.x + Math.cos(t.a) * STEP;
        ny = from.y + Math.sin(t.a) * STEP;
        nz = from.z + (rnd() - 0.5) * STEP * 0.25;
      }

      // Anastomosis: record the bridge, keep the tip alive. Volumetric
      // bridges copy the target's FULL position (not just x,y) so the bridge
      // point coincides exactly with it — a zero-length adjacency edge — and
      // the search that found `hit` was itself 3D-aware, so parent->bridge
      // stays a short local step in every axis, never a long vertical chord.
      const hit = nearest(nx, ny, nz, new Set(t.trail));
      if (hit >= 0) {
        nodes.push(
          VOL
            ? {
                x: nodes[hit].x,
                y: nodes[hit].y,
                z: nodes[hit].z,
                parent: t.node,
                order: t.order,
                bridgeTo: hit,
              }
            : { x: nodes[hit].x, y: nodes[hit].y, z: from.z, parent: t.node, order: t.order, bridgeTo: hit },
        );
      }

      nodes.push({ x: nx, y: ny, z: nz, parent: t.node, order: t.order });
      const grown = nodes.length - 1;
      remember(grown);
      t.node = grown;
      t.life++;
      t.trail.push(grown);
      if (t.trail.length > 24) t.trail.shift();

      const dist = VOL ? Math.hypot(nx, ny, nz) : Math.hypot(nx, ny);
      if (dist > BOUND || t.life > MAX_LIFE) continue; // retire
      next.push(t);
      if (rnd() * 100 < BRANCH_PCT && t.order < MAX_ORDER && next.length < MAX_TIPS) {
        if (VOL) {
          // Branch into a real 3D cone around the parent's heading — same
          // perpendicular-basis trick applyWalrusLayout uses to spread a cone
          // tree, instead of one fixed in-plane rotation.
          const polar = 0.5 + rnd() * 0.55;
          const az = rnd() * Math.PI * 2;
          const [u, w] = perpBasis(t.dir);
          const cs = Math.cos(polar);
          const sn = Math.sin(polar);
          const ca = Math.cos(az);
          const sa = Math.sin(az);
          const bx = t.dir[0] * cs + (u[0] * ca + w[0] * sa) * sn;
          const by = t.dir[1] * cs + (u[1] * ca + w[1] * sa) * sn;
          const bz = t.dir[2] * cs + (u[2] * ca + w[2] * sa) * sn;
          const bl = Math.hypot(bx, by, bz) || 1;
          next.push({
            node: grown,
            a: t.a,
            dir: [bx / bl, by / bl, bz / bl],
            order: t.order + 1,
            life: 0,
            trail: t.trail.slice(-12),
          });
        } else {
          const off = (rnd() < 0.5 ? 1 : -1) * (0.5 + rnd() * 0.55);
          next.push({
            node: grown,
            a: t.a + off,
            dir: [0, 0, 0],
            order: t.order + 1,
            life: 0,
            trail: t.trail.slice(-12),
          });
        }
      }
    }
    tips = next;
  }
  return nodes;
}

export interface MyceliumOpts {
  targetRadius: number;
  /** "3d" grows tips through a real ball volume (genuine depth to orbit
   *  through); "2d" (the default) keeps the original planar-wander mat that
   *  the flattened view has always used. See growMycelium's `volumetric`. */
  dim?: "2d" | "3d";
  /** Flat base colour (hex) every strand's cluster hue blends toward — see
   *  the colour-propagation pass below. Defaults to the old flat cream. */
  hyphaColor?: string;
}

export interface MyceliumResult {
  /** Width-bucketed, birth-ordered hypha segments. Every point is a real grown
   *  mat coordinate — nothing here is a chord drawn between two notes. */
  buckets: HyphaBucket[];
  /** Note id → index into `mat`, the mat node the embedding assigned it to. */
  matIndexOf: Map<string, number>;
  /** The grown network itself (already scaled to `targetRadius`), for
   *  adjacency introspection — e.g. proving two linked notes' assigned mat
   *  nodes are connected within a few hyphal hops. */
  mat: HyphaNode[];
}

/** Adjacency of the grown mat: parent<->child hyphal links plus anastomosis
 *  bridges (a bridge is a second path between two points already on the mat
 *  — the loop a search can shortcut through instead of only ever walking the
 *  trunk). Shared by the note-embedding BFS below and MyceliumView's
 *  neighbour-highlight path search, which needs the REAL hyphal route
 *  between two notes' mat nodes — never a chord. */
export function buildMatAdjacency(mat: HyphaNode[]): number[][] {
  const adj: number[][] = mat.map(() => []);
  mat.forEach((h, i) => {
    if (h.parent >= 0) {
      adj[i].push(h.parent);
      adj[h.parent].push(i);
    }
    if (h.bridgeTo != null) {
      adj[i].push(h.bridgeTo);
      adj[h.bridgeTo].push(i);
    }
  });
  return adj;
}

/** Shortest path between two mat-node indices (BFS over buildMatAdjacency),
 *  inclusive of both ends, or null if disconnected. Index-based sibling of
 *  graphData's shortestPath — used to draw the real hyphal route a
 *  neighbour-highlight lights up, never a note-to-note chord. */
export function matPath(adj: number[][], a: number, b: number): number[] | null {
  if (a === b) return [a];
  const prev = new Map<number, number>();
  const seen = new Set<number>([a]);
  const queue = [a];
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    if (cur === b) break;
    for (const nb of adj[cur]) {
      if (seen.has(nb)) continue;
      seen.add(nb);
      prev.set(nb, cur);
      queue.push(nb);
    }
  }
  if (!seen.has(b)) return null;
  const path = [b];
  let cur = b;
  while (cur !== a) {
    const p = prev.get(cur);
    if (p == null) return null;
    path.push(p);
    cur = p;
  }
  path.reverse();
  return path;
}

// "mycelium": GROW a real mat (space colonization, above — the shape a
// wikilink graph could never produce on its own), then EMBED the note graph
// into it so a link reads as a path of real hyphae, never a drawn chord.
//
// The embedding walks the note graph breadth-first from its busiest note. The
// root note takes a spore; every note visited after that takes the NEAREST
// still-free mat node to whichever already-placed note discovered it — so a
// graph edge always becomes a short walk to an adjacent (or near-adjacent)
// mat node, not just "the next slot in some other traversal."
//
// That distinction is why an earlier version of this (pairing the note BFS's
// k-th visit with the mat BFS's k-th visit, one global index shared by both)
// measured wrong: the mat BFS interleaves many simultaneously-growing tips,
// so its k-th and (k+1)-th visited nodes are frequently on DIFFERENT tips
// whose only common ancestor is many generations back — index-adjacency in a
// breadth-first VISIT ORDER is not mat-adjacency. Measured on the real vault
// shape (1244 notes / ~440 edges): that version put linked notes an average
// 14.3 hyphal hops apart (up to 81). Searching outward from each note's own
// placed neighbour instead of from a shared global counter fixes it — see
// staticLayouts.test.ts for the current measured numbers.
export function buildMyceliumMat(g: VaultGraph, o: MyceliumOpts): MyceliumResult {
  const empty: MyceliumResult = { buckets: [], matIndexOf: new Map(), mat: [] };
  if (g.order === 0) return empty;

  const mat = growMycelium(g.order, { volumetric: o.dim === "3d" });

  // Scale the grown (roughly unit-radius) mat to the caller's world radius.
  let maxR = 1e-6;
  for (const h of mat) maxR = Math.max(maxR, Math.hypot(h.x, h.y, h.z));
  const scale = o.targetRadius / maxR;
  for (const h of mat) {
    h.x *= scale;
    h.y *= scale;
    h.z *= scale;
  }

  const matAdj = buildMatAdjacency(mat);
  const spores = mat.map((_, i) => i).filter((i) => mat[i].parent === -1);
  // A bridge duplicates an existing point's coordinates, so it is never an
  // assignment target — two notes must not land exactly on top of each other.
  const isAssignable = (i: number): boolean => mat[i].bridgeTo == null;

  const used = new Set<number>();
  // Nearest unused, assignable mat node to `start` — BFS outward, first match
  // wins. `start` itself counts (a fresh spore, or a note's own mat node
  // before any of ITS neighbours have claimed it).
  const nearestFree = (start: number): number => {
    if (isAssignable(start) && !used.has(start)) return start;
    const seen = new Set([start]);
    let frontier = [start];
    while (frontier.length > 0) {
      const next: number[] = [];
      for (const cur of frontier) {
        for (const nb of matAdj[cur]) {
          if (seen.has(nb)) continue;
          seen.add(nb);
          if (isAssignable(nb) && !used.has(nb)) return nb;
          next.push(nb);
        }
      }
      frontier = next;
    }
    // ponytail: mat exhausted (every reachable node already used) — reuse
    // `start` rather than crash. maxNodes scales with note count so this
    // shouldn't trigger on a real vault; a repeated slot is a visual overlap,
    // not a broken layout.
    return start;
  };

  const degOf = (id: string): number => (g.getNodeAttribute(id, "deg") as number) ?? g.degree(id);
  const allNotes = g.nodes().slice().sort();
  let hub = allNotes[0];
  for (const id of allNotes) if (degOf(id) > degOf(hub)) hub = id;
  // Hubs first among a note's neighbours, same convention as
  // applyRadialLayout/applyWalrusLayout — a hub's OWN links claim the nearest
  // slots before its lighter neighbours' links compete for what is left.
  const noteNeighbors = (id: string): string[] =>
    g.neighbors(id).slice().sort((a, b) => degOf(b) - degOf(a) || (a < b ? -1 : 1));

  const matIndexOf = new Map<string, number>();
  let sporeCursor = 0;
  // One full BFS per note-graph component (same shape as applyWalrusLayout's
  // multi-root bfs()): `root` seeds at the nearest free node to a spore
  // (round-robin, so disconnected components spread across spores instead of
  // piling onto one), then every note reached from it takes the nearest free
  // node to whichever note discovered it.
  const embedComponent = (root: string): void => {
    if (matIndexOf.has(root)) return;
    const seed = nearestFree(spores[sporeCursor % spores.length]);
    sporeCursor++;
    used.add(seed);
    matIndexOf.set(root, seed);
    const queue = [root];
    let head = 0;
    while (head < queue.length) {
      const u = queue[head++];
      const mu = matIndexOf.get(u)!;
      for (const v of noteNeighbors(u)) {
        if (matIndexOf.has(v)) continue;
        const mv = nearestFree(mu);
        used.add(mv);
        matIndexOf.set(v, mv);
        queue.push(v);
      }
    }
  };
  embedComponent(hub);
  for (const id of allNotes) embedComponent(id); // remaining components

  // Colour every mat node from the NEAREST note it's near (multi-source BFS
  // over the mat's own adjacency, seeded at every note-carrying node at
  // once) — "derive a strand's colour from the notes it carries, or its
  // local neighbourhood if it carries none." A note's `color` attribute is
  // already the app's community-hue tint (colorByCommunity in graphData.ts),
  // so a bare stretch of hyphae between two notes blends smoothly between
  // their two colours instead of a second, invented palette. Blended toward
  // a flat base (HYPHA_MIX) so the mat still reads as one tinted organism
  // (and any community-less vault falls back to the old flat cream).
  const HYPHA_MIX = 0.3;
  const base = hexToRgb01(o.hyphaColor ?? "#d8d0bd") ?? { r: 0.847, g: 0.816, b: 0.741 };
  const matColor = new Float32Array(mat.length * 3);
  {
    const seen = new Uint8Array(mat.length);
    let frontier: number[] = [];
    for (const [noteId, idx] of matIndexOf) {
      const c = hexToRgb01((g.getNodeAttribute(noteId, "color") as string) ?? "") ?? base;
      matColor[idx * 3] = c.r;
      matColor[idx * 3 + 1] = c.g;
      matColor[idx * 3 + 2] = c.b;
      seen[idx] = 1;
      frontier.push(idx);
    }
    while (frontier.length > 0) {
      const next: number[] = [];
      for (const cur of frontier) {
        for (const nb of matAdj[cur]) {
          if (seen[nb]) continue;
          seen[nb] = 1;
          matColor[nb * 3] = matColor[cur * 3];
          matColor[nb * 3 + 1] = matColor[cur * 3 + 1];
          matColor[nb * 3 + 2] = matColor[cur * 3 + 2];
          next.push(nb);
        }
      }
      frontier = next;
    }
    // A mat node unreachable from any note (a disconnected mat fragment, or
    // no notes at all) keeps the flat base rather than rendering black.
    for (let i = 0; i < mat.length; i++) {
      if (seen[i]) continue;
      matColor[i * 3] = base.r;
      matColor[i * 3 + 1] = base.g;
      matColor[i * 3 + 2] = base.b;
    }
    for (let i = 0; i < mat.length; i++) {
      matColor[i * 3] = matColor[i * 3] * (1 - HYPHA_MIX) + base.r * HYPHA_MIX;
      matColor[i * 3 + 1] = matColor[i * 3 + 1] * (1 - HYPHA_MIX) + base.g * HYPHA_MIX;
      matColor[i * 3 + 2] = matColor[i * 3 + 2] * (1 - HYPHA_MIX) + base.b * HYPHA_MIX;
    }
  }

  // Bucket every hyphal segment by branch order → stroke width. Widths and
  // taper come from the prototype: base 2.6px, ×0.62 per generation. Colour
  // rides per-vertex on top of these same buckets (see HyphaBucket) rather
  // than a further (width x cluster) bucketing.
  const BASE_W = 2.6;
  const TAPER = 0.62;
  const bucketsByOrder = new Map<number, { pts: number[]; cols: number[]; birth: number[] }>();
  const lastIdx = Math.max(1, mat.length - 1);
  mat.forEach((h, i) => {
    if (h.parent < 0) return;
    const p2 = mat[h.parent];
    const b = bucketsByOrder.get(h.order) ?? { pts: [], cols: [], birth: [] };
    b.pts.push(p2.x, p2.y, p2.z, h.x, h.y, h.z);
    b.cols.push(
      matColor[h.parent * 3], matColor[h.parent * 3 + 1], matColor[h.parent * 3 + 2],
      matColor[i * 3], matColor[i * 3 + 1], matColor[i * 3 + 2],
    );
    // `i` is the growth index: nodes are pushed in the order they grew, so
    // this is already ascending within every bucket.
    b.birth.push(i / lastIdx);
    bucketsByOrder.set(h.order, b);
  });
  const buckets = [...bucketsByOrder.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([order, b]) => ({
      width: Math.max(0.6, BASE_W * Math.pow(TAPER, order)),
      colors: new Float32Array(b.cols),
      positions: new Float32Array(b.pts),
      birth: new Float32Array(b.birth),
    }));

  return { buckets, matIndexOf, mat };
}
