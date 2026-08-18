// NO-OVERLAP INVARIANT — the one rule every layout in the app must satisfy:
//
//   for every pair (i, j):  |p_i - p_j|  >=  r_i + r_j + NODE_MARGIN
//
// where r is the world radius the RENDERER actually draws the body at
// (renderedRadius below, the same quantity graphScene's vertex shader and the
// sim worker's forceCollide use). Nodes stopped being ~2px dots and became
// 16x16 pixel sprites with real visual area; every layout was still packing
// them as if they were points, so the worlds merged into one unreadable mass
// ("행성이 섞여서 보기 어렵다").
//
// The fix is one deterministic post-process shared by ALL layouts rather than
// per-layout tuning: grid-accelerated push-apart sweeps that let a dense knot
// relax outward into the void beside it, preserving the field's overall extent.
//
// Sweeps, NOT a uniform blow-up, are the mechanism — and that is the whole
// point. Scaling a layout up is invisible: the camera fits the layout, so
// positions x k plus camera distance x k is the same picture with every body k
// times SMALLER. An early version pre-scaled by the measured over-packing
// factor and grew the 1244-node atlas map from 2574 to 5579 world units for
// exactly zero visible improvement. The field is therefore only grown when no
// valid packing could exist inside it at all (a global area/volume argument),
// or as the terminating fallback when sweeps run out — at some scale the
// packing is trivially valid, so the loop always ends.
//
// Dependency-free apart from layoutConfig — it is imported by the sim worker
// bundle, the static layouts, the FA2 atlas and vitest alike.

import {
  GLOW_SCALE,
  NODE_RADIUS,
  INTENSITY_SIZE_COEF,
  STAR_KIND_SCALE,
  LIGHT_BG_SIZE_MUL,
  SIGMA_SKIN_NODE_SCALE,
} from "./layoutConfig";
// Type-only (fully erased at build) — the runtime dependency stays layoutConfig
// alone, so the sim worker bundle never pulls graphology in.
import type { VaultGraph } from "./graphData";

/** Clear world-space gap demanded between two node SURFACES.
 *
 *  6 units against a median body radius of ~4.8 (a_size 1) is ~1.25 body radii
 *  of void between neighbours — enough that each world reads as its own disc at
 *  a glance, while still letting ~1250 bodies pack inside a field the camera
 *  can frame. It also covers the near-field planet LOD, whose lit spheres are
 *  radius 3.0..5.0 for ordinary notes (planetLayer) — larger than the smallest
 *  sprite (3.3) but inside sprite+margin. (Their decorative MOONS orbit out to
 *  ~3.4x the host radius and can still cross a neighbour; opening the field far
 *  enough for moons would shrink every world on screen for a satellite.) */
export const NODE_MARGIN = 6;

// Worst-case STATIC multiplier graphScene's shader can apply on top of the
// base a_size * NODE_RADIUS * GLOW_SCALE quad, for a theme/skin the layout
// might be VIEWED under — not necessarily the one active when the layout ran.
// A light/dark flip and a skin switch both recolour an ALREADY-LAID-OUT graph
// IN PLACE (see PageGraph's theme effect: lightBg and settings.skin are
// deliberately absent from the rebuild-triggering deps) — they never rerun
// separation. So the margin reserved here has to cover the largest sprite the
// node could be drawn at under ANY reachable theme/skin, or flipping themes
// after a layout settles reintroduces the exact overlap this module exists to
// prevent (this is what the shipped white-skin vibes — paper/atlas,
// chronicle/strata — were actually hitting: the layout ran fine, the sprite
// just grew past the room reserved for it once painted on paper).
// web skin (0.34) is smaller, so it is not part of the worst case.
// Pixel sprites take the smaller LIGHT_BG_PIXEL_SIZE_MUL on light backgrounds,
// but pixelNodes is itself a live toggle (no re-layout), so the glow-dot path's
// full LIGHT_BG_SIZE_MUL stays reachable and stays the worst case here.
const STATIC_SPRITE_SCALE = LIGHT_BG_SIZE_MUL * SIGMA_SKIN_NODE_SCALE;

/** World RADIUS a node of the given `size`/stellar-`kind`/`intensity` is drawn
 *  at, worst-case over theme/skin (see STATIC_SPRITE_SCALE above).
 *  graphScene: gl_PointSize = a_size * NODE_RADIUS * GLOW_SCALE * u_sizeScale *
 *  (1 + a_intensity*INTENSITY_SIZE_COEF) * STAR_KIND_SCALE[kind] *
 *  lightBgMul * skinScale * (px per world unit at unit distance) / dist —
 *  i.e. the sprite is a world-space quad of that same DIAMETER. `kind` and
 *  `intensity` are per-node data (fixed at graph build, unlike theme/skin) so
 *  they are read exactly rather than worst-cased. NOT modelled: transient
 *  multipliers that only apply while a specific node is being interacted with
 *  (selection ×1.35, search-hit ×1.22, hover pop ×1.3) or that animate every
 *  frame (breathing ≤×1.07, depth-of-field — and DOF is skipped entirely for
 *  the pixel-sprite planet look this module packs for). A transient overlap is
 *  a graze that lasts a gesture or a frame, on whichever single node the user
 *  is already looking at; a static one is the picture itself being wrong every
 *  time the user looks. */
export function renderedRadius(size: number, kind = 0, intensity = 0): number {
  const kindScale = STAR_KIND_SCALE[kind] ?? 1;
  const intensityScale = 1 + Math.max(0, intensity) * INTENSITY_SIZE_COEF;
  return (size * NODE_RADIUS * GLOW_SCALE * kindScale * intensityScale * STATIC_SPRITE_SCALE) / 2;
}

/** The minimum a layout is allowed to put between two bodies' centres. */
export function requiredGap(
  a: { size: number; kind?: number; intensity?: number },
  b: { size: number; kind?: number; intensity?: number },
  margin = NODE_MARGIN,
): number {
  return renderedRadius(a.size, a.kind, a.intensity) + renderedRadius(b.size, b.kind, b.intensity) + margin;
}

/** A laid-out body: position plus the attributes the renderer scales by.
 *  Deliberately structural so the sim worker's SimNode and a plain
 *  {x,y,z,size} record from graph attrs both satisfy it. `kind`/`intensity`
 *  default to main-sequence/0 when absent (test fixtures, ghosts). */
export interface SizedPoint {
  x: number;
  y: number;
  z: number;
  size: number;
  /** Stellar class — 0 main / 1 dwarf / 2 giant / 3 neutron (graphData's a.starKind). */
  kind?: number;
  intensity?: number;
}

export interface SeparateOpts {
  /** 2 pins z (flat maps: strata, atlas, synapse); 3 relaxes in space. */
  dims?: 2 | 3;
  margin?: number;
  /** Push-apart sweeps per expansion round. */
  passes?: number;
  /** Expansion rounds allowed before giving up. */
  rounds?: number;
  /** Uniform blow-up applied when a round still leaves overlaps. */
  expand?: number;
  /** separateGraphLayout only: separate just this subset of node ids (e.g. one
   *  universe's cloud in the multiverse view) instead of every node in `g`.
   *  Defaults to all of `g`'s nodes. */
  ids?: string[];
}

export interface SeparateResult {
  /** Total uniform scale applied to the field (1 = the layout already fit). */
  scale: number;
  /** Violating pairs left. 0 is the acceptance number. */
  overlaps: number;
}

// Spatial hash of a cell triple. Collisions only ever ADD candidate points to a
// bucket (every candidate is distance-checked anyway), never hide one — a cell's
// own points are always in the bucket its own key maps to.
function cellKey(ix: number, iy: number, iz: number): number {
  return (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) | 0;
}

/** Push overlapping bodies apart IN PLACE, expanding the field as needed.
 *  Deterministic: same input array → same output, no Math.random. */
export function separateLayout(pts: SizedPoint[], o: SeparateOpts = {}): SeparateResult {
  const n = pts.length;
  if (n < 2) return { scale: 1, overlaps: 0 };
  const dims = o.dims ?? 3;
  const margin = o.margin ?? NODE_MARGIN;
  // Sweeps are the main mechanism now (see the feasibility note below), and a
  // jammed core needs roughly its own diameter in cells' worth of sweeps for
  // the pressure to reach its centre — hence a few hundred, not a few dozen.
  const passes = o.passes ?? 300;
  const rounds = o.rounds ?? 16;
  const expand = o.expand ?? 1.18;

  // Resolve a collision to a HAIR past the required gap, not exactly onto it.
  // Landing exactly on `need` leaves float rounding to decide the next pass's
  // comparison, so the same pair kept re-"moving" by ~1e-13 forever and every
  // sweep budget ran to exhaustion (measured: 300 passes and 1.4s on a spiral
  // that was actually finished after ~10). A hundredth of a world unit is
  // invisible and makes the fixed point stable.
  const SLACK = 0.01;

  const rad = new Float64Array(n);
  let maxR = 0;
  for (let i = 0; i < n; i++) {
    rad[i] = renderedRadius(pts[i].size, pts[i].kind, pts[i].intensity);
    if (rad[i] > maxR) maxR = rad[i];
  }
  // One cell holds the worst-case interaction range, so a colliding pair is
  // always within the 3x3(x3) neighbourhood of either point's cell.
  const cell = 2 * maxR + margin;
  const oz0 = dims === 3 ? -1 : 0;
  const oz1 = dims === 3 ? 1 : 0;

  // Open-addressed bucket table as two typed arrays (head + next links) rather
  // than a Map<number, number[]>: the grid is rebuilt once per sweep and there
  // are hundreds of sweeps, so per-pass Map churn and per-bucket array
  // allocation dominated the cost (measured 1244 nodes: 2.5s with Maps, 0.3s
  // with this). Rebuilding is two typed-array writes per node, no allocation.
  let tableSize = 1;
  while (tableSize < n * 2) tableSize <<= 1;
  const mask = tableSize - 1;
  const head = new Int32Array(tableSize);
  const next = new Int32Array(n);
  const slotOf = (ix: number, iy: number, iz: number): number => cellKey(ix, iy, iz) & mask;

  const rebuild = (): void => {
    head.fill(-1);
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const s = slotOf(
        Math.floor(p.x / cell),
        Math.floor(p.y / cell),
        dims === 3 ? Math.floor(p.z / cell) : 0,
      );
      next[i] = head[s];
      head[s] = i;
    }
  };

  // Visit every pair that could possibly collide, exactly once per pass.
  const forEachCandidate = (fn: (i: number, j: number) => void): void => {
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const ix = Math.floor(p.x / cell);
      const iy = Math.floor(p.y / cell);
      const iz = dims === 3 ? Math.floor(p.z / cell) : 0;
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          for (let oz = oz0; oz <= oz1; oz++) {
            for (let j = head[slotOf(ix + ox, iy + oy, iz + oz)]; j >= 0; j = next[j]) {
              if (j > i) fn(i, j);
            }
          }
        }
      }
    }
  };

  const countOverlaps = (): number => {
    rebuild();
    let bad = 0;
    forEachCandidate((i, j) => {
      const a = pts[i];
      const b = pts[j];
      const dz = dims === 3 ? b.z - a.z : 0;
      const d = Math.hypot(b.x - a.x, b.y - a.y, dz);
      if (d < rad[i] + rad[j] + margin - 1e-9) bad++;
    });
    return bad;
  };

  // Scales about the ORIGIN, not the centroid. Every layout here is built
  // origin-centred, and strata's date-axis ticks are an affine function of the
  // same x, so one shared factor keeps nodes and axis in step (see the `scale`
  // returned to applyStrataLayout).
  const scaleField = (f: number): void => {
    for (let i = 0; i < n; i++) {
      pts[i].x *= f;
      pts[i].y *= f;
      if (dims === 3) pts[i].z *= f;
    }
  };

  // One push-apart sweep. Returns how many pairs it had to move.
  const sweep = (): number => {
    rebuild();
    let moved = 0;
    forEachCandidate((i, j) => {
      const a = pts[i];
      const b = pts[j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let dz = dims === 3 ? b.z - a.z : 0;
      let d = Math.hypot(dx, dy, dz);
      const need = rad[i] + rad[j] + margin;
      if (d >= need) return;
      if (d < 1e-9) {
        // Exactly coincident — pick a deterministic direction from the pair's
        // indices so the tie always breaks the same way across runs.
        const t = (((Math.imul(i + 1, 2654435761) ^ (j + 1)) >>> 0) / 4294967296) * Math.PI * 2;
        dx = Math.cos(t);
        dy = Math.sin(t);
        dz = dims === 3 ? Math.cos(t * 1.7) : 0;
        d = Math.hypot(dx, dy, dz) || 1;
      }
      const push = (need + SLACK - d) / 2 / d;
      a.x -= dx * push;
      a.y -= dy * push;
      b.x += dx * push;
      b.y += dy * push;
      if (dims === 3) {
        a.z -= dz * push;
        b.z += dz * push;
      }
      moved++;
    });
    return moved;
  };

  // FEASIBILITY pre-scale, NOT a density fix. Blowing the field up uniformly is
  // a no-op on screen: the camera fits the layout, so scaling positions by k
  // and pulling the camera back by k leaves the same picture with every body k
  // times SMALLER — the opposite of "let me see the worlds". So the field only
  // grows when no valid packing exists inside it at all, and the sweeps (which
  // genuinely redistribute a dense core outward into the void around it) do all
  // the rest. Measured on a 1244-node atlas map: the earlier
  // nearest-neighbour-ratio pre-scale blew the map from 2574 to 5579 units and
  // changed nothing visible, because a uniform scale cannot change relative
  // density.
  const bodyArea = (r: number): number => {
    const rr = r + margin / 2;
    return dims === 2 ? Math.PI * rr * rr : (4 / 3) * Math.PI * rr * rr * rr;
  };
  let scale = 1;
  {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const p of pts) {
      cx += p.x;
      cy += p.y;
      cz += p.z;
    }
    cx /= n;
    cy /= n;
    cz /= n;
    // p95 from the centroid — the same extent the camera frames, so a couple of
    // drifted orphans can't declare the field roomy.
    const ds = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      ds[i] = Math.hypot(pts[i].x - cx, pts[i].y - cy, dims === 3 ? pts[i].z - cz : 0);
    }
    ds.sort();
    const rField = Math.max(1e-6, ds[Math.floor((n - 1) * 0.95)]);
    let needed = 0;
    for (let i = 0; i < n; i++) needed += bodyArea(rad[i]);
    // Random close packing leaves ~64% (3D) / ~82% (2D) of the space filled;
    // stay well under it, a layout is not a packing puzzle.
    const have = (dims === 2 ? Math.PI * rField * rField : (4 / 3) * Math.PI * rField ** 3) * 0.5;
    if (have < needed) {
      scale = Math.pow(needed / have, dims === 2 ? 1 / 2 : 1 / 3);
      scaleField(scale);
    }
  }

  for (let round = 0; round < rounds; round++) {
    for (let p = 0; p < passes; p++) {
      if (sweep() === 0) break;
    }
    const bad = countOverlaps();
    if (bad === 0) return { scale, overlaps: 0 };
    scaleField(expand);
    scale *= expand;
  }
  return { scale, overlaps: countOverlaps() };
}

/** Graph-attribute flavour of separateLayout: reads x/y/z/size off the nodes,
 *  separates, writes the positions back. Returns the uniform scale applied so a
 *  caller that also emits WORLD-SPACE furniture derived from the same layout
 *  (strata's date-axis ticks) can scale it to match. */
export function separateGraphLayout(g: VaultGraph, o: SeparateOpts = {}): SeparateResult {
  const ids = o.ids ?? g.nodes(); // insertion order — deterministic
  if (ids.length < 2) return { scale: 1, overlaps: 0 };
  const pts: SizedPoint[] = ids.map((id) => ({
    x: g.getNodeAttribute(id, "x") ?? 0,
    y: g.getNodeAttribute(id, "y") ?? 0,
    z: g.getNodeAttribute(id, "z") ?? 0,
    size: g.getNodeAttribute(id, "size") ?? 1,
    kind: g.getNodeAttribute(id, "starKind") ?? 0,
    intensity: g.getNodeAttribute(id, "intensity") ?? 0,
  }));
  const res = separateLayout(pts, o);
  for (let i = 0; i < ids.length; i++) {
    g.setNodeAttribute(ids[i], "x", pts[i].x);
    g.setNodeAttribute(ids[i], "y", pts[i].y);
    g.setNodeAttribute(ids[i], "z", pts[i].z);
  }
  return res;
}
