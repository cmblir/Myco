// Web Worker: runs the d3-force-3d galaxy simulation OFF the main thread.
//
// At 10k+ nodes a single force tick (Barnes-Hut charge + collide octrees) costs
// ~120ms. Run on the main thread it froze the UI for the whole settle (and every
// drag reheat), and the freeze grew with node count. Here the force model runs
// in a worker; each tick posts a transferable Float32Array of node positions
// (in init order) back to the main thread, which draws them. The main thread
// never blocks on physics.
//
// The Survey graph is 2D: the same force model runs with z pinned to 0 (the
// third dimension bought occlusion and camera work, not answers), so the
// cluster anchors are packed on the xy plane and z is zeroed after every tick.

import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceX,
  forceY,
  forceCollide,
  type Simulation,
  type Force,
} from "d3-force-3d";
import { bigGraphDecay } from "./simCooling";
import {
  clusterOrbitRadius,
  galaxyAnchorsBySize,
  galaxySizeBoost,
  type GalaxyAnchor,
} from "./galaxyLayout";
import {
  REPEL_SCALE,
  CENTER_SCALE,
  CLUSTER_SCALE,
  HUB_PIN,
  DUST_PULL,
  SIM_ALPHA_MIN,
  SIM_FORCES,
  INTER_LINK_DIST_MUL,
  INTER_LINK_STR_MUL,
  INTER_GALAXY_STR_MUL,
  ORPHAN_GRAVITY_MUL,
  CHARGE_RANGE_MUL,
  ANCHOR_SCALE,
  ANCHOR_HUB_MUL,
} from "./layoutConfig";
import { computeLayoutMetrics } from "./layoutMetrics";
import { NODE_MARGIN, renderedRadius, separateLayout } from "./layoutSeparation";

// Deterministic RNG — copied from graphData so the worker bundle doesn't pull in
// graphology. Must stay identical to graphData's.
function hash32(id: string): number {
  let h = 2166136261;
  for (let k = 0; k < id.length; k++) {
    h ^= id.charCodeAt(k);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function seededUnit(id: string, salt = 0): number {
  return (hash32(`${id}:${salt}`) % 100000) / 100000;
}

interface SimNode {
  id: string;
  x: number;
  y: number;
  z: number;
  size: number;
  deg: number;
  community: number;
  galaxy: number;
  isHub: boolean;
  rJitter: number;
  /** Stellar class + HDR intensity — see layoutSeparation.renderedRadius. */
  kind: number;
  intensity: number;
  fx?: number | null;
  fy?: number | null;
  fz?: number | null;
  vx?: number;
  vy?: number;
  vz?: number;
}
interface SimLink {
  source: SimNode | string;
  target: SimNode | string;
}

interface NodeInit {
  id: string;
  x: number;
  y: number;
  z: number;
  size: number;
  deg: number;
  community: number;
  galaxy: number;
  isHub: boolean;
  rJitter: number;
  kind: number;
  intensity: number;
}

const F = SIM_FORCES;

// In the worker the tick loop yields 0ms — it isn't the UI thread, so the only
// reason to yield is to let queued messages (drag/setFixed) run between ticks.
const WORKER_YIELD_MS = 0;

// Sustained alpha while a node is being dragged. A one-shot reheat cools toward
// 0, so a held drag would re-settle within ~1s and the neighbours would freeze
// mid-drag. Holding alphaTarget here keeps the tick driver running so the whole
// neighbourhood keeps following the pinned node until the drag ends.
const DRAG_ALPHA_TARGET = 0.3;

interface SimState {
  nodes: SimNode[];
  sim: Simulation<SimNode, SimLink>;
  reheat: (a: number) => void;
  setFixed: (id: string, x: number | null, y?: number) => void;
  /** Keep the sim warm+ticking for the duration of a drag (true), then let it
   *  cool and settle (false). */
  dragWarm: (on: boolean) => void;
  stop: () => void;
}

let state: SimState | null = null;

function build(initNodes: NodeInit[], initLinks: [number, number][]): SimState {
  const nodes: SimNode[] = initNodes.map((n) => ({ ...n, z: 0 }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const links: SimLink[] = initLinks.map(([si, ti]) => ({
    source: nodes[si],
    target: nodes[ti],
  }));

  const sameComm = (l: SimLink): boolean =>
    typeof l.source === "object" &&
    typeof l.target === "object" &&
    l.source.community >= 0 &&
    l.source.community === l.target.community;
  const sameGalaxy = (l: SimLink): boolean =>
    typeof l.source === "object" &&
    typeof l.target === "object" &&
    l.source.galaxy >= 0 &&
    l.source.galaxy === l.target.galaxy;

  const linkStrength = (l: SimLink): number => {
    const sN = typeof l.source === "object" ? l.source.deg : 1;
    const tN = typeof l.target === "object" ? l.target.deg : 1;
    const base = F.linkForce / (1 + Math.min(sN, tN));
    // Different folder → near-zero pull (galaxies must not merge).
    if (!sameGalaxy(l)) return base * INTER_GALAXY_STR_MUL;
    return !sameComm(l) ? base * INTER_LINK_STR_MUL : base;
  };
  // Deterministic per-edge distance jitter (0.7×..1.3×). A uniform intra-
  // community distance settles every leaf onto ONE equal-radius shell around
  // its hub — the "dandelion/starburst" silhouette. The jitter spreads leaves
  // into a cloud instead; seeded from the edge ids so reloads are identical.
  const edgeJitter = (l: SimLink): number => {
    const a = typeof l.source === "object" ? l.source.id : String(l.source);
    const b = typeof l.target === "object" ? l.target.id : String(l.target);
    return 0.7 + 0.6 * seededUnit(`${a}|${b}`, 21);
  };
  // Degree-based distance: hub–hub bridges stretch long, leaf links stay short.
  const degMul = (l: SimLink): number => {
    const sD = typeof l.source === "object" ? l.source.deg : 1;
    const tD = typeof l.target === "object" ? l.target.deg : 1;
    return 1 + 0.18 * Math.log2(1 + Math.min(sD, tD));
  };
  const linkDist = (l: SimLink): number =>
    (!sameComm(l) ? F.linkDistance * INTER_LINK_DIST_MUL : F.linkDistance * edgeJitter(l)) *
    degMul(l);
  // Anchored nodes: ZERO origin pull (any pull tails the galaxy). Orphans (no
  // anchor): a small pull so they cluster near the origin instead of drifting
  // off and inflating the fit bounding box.
  const center = Math.max(0.005, F.centerForce * CENTER_SCALE);
  const gravity = (n: SimNode): number => (n.community >= 0 ? 0 : center * ORPHAN_GRAVITY_MUL);

  // --- cluster anchors ---------------------------------------------------------
  // One anchor per sized cluster, packed on the xy plane by member count
  // (galaxyLayout); every member is pulled toward its anchor (hubs hardest), so
  // clusters settle as separate coloured puffs with real void between them.
  // sizeBoost (intra-link density) feeds the cluster force's orbit ring.
  const anchors = new Map<number, GalaxyAnchor>();
  const sizeBoost = new Map<number, number>();
  const computeAnchors = (): void => {
    anchors.clear();
    sizeBoost.clear();
    const clusterCount = new Map<number, number>();
    for (const n of nodes) {
      if (n.community < 0) continue;
      clusterCount.set(n.community, (clusterCount.get(n.community) ?? 0) + 1);
    }
    if (clusterCount.size < 2) return;
    const intra = new Map<number, number>();
    for (const l of links) {
      if (sameComm(l)) {
        const c = (l.source as SimNode).community;
        intra.set(c, (intra.get(c) ?? 0) + 1);
      }
    }
    const clusterIds = [...clusterCount.keys()].sort(
      (a, b) => (clusterCount.get(b) ?? 0) - (clusterCount.get(a) ?? 0) || a - b,
    );
    const counts = clusterIds.map((c) => clusterCount.get(c)!);
    const centers = galaxyAnchorsBySize(counts, F.linkDistance);
    clusterIds.forEach((c, i) => {
      // The packer spreads on x/z and flattens y; the plane we draw is x/y.
      anchors.set(c, { x: centers[i].x, y: centers[i].z, z: 0 });
      sizeBoost.set(c, galaxySizeBoost(clusterCount.get(c) ?? 1, intra.get(c) ?? 0));
    });
  };
  const anchorForce = (): Force<SimNode, SimLink> => {
    let ns: SimNode[] = [];
    const force: Force<SimNode, SimLink> = (alpha) => {
      if (anchors.size === 0) return;
      const k = ANCHOR_SCALE * alpha;
      for (const n of ns) {
        if (n.fx != null) continue;
        const a = anchors.get(n.community);
        if (!a) continue;
        const m = n.isHub ? ANCHOR_HUB_MUL : 1;
        n.vx = (n.vx ?? 0) + (a.x - n.x) * k * m;
        n.vy = (n.vy ?? 0) + (a.y - n.y) * k * m;
      }
    };
    force.initialize = (init: SimNode[]): void => {
      ns = init;
    };
    return force;
  };

  const linkF = forceLink<SimNode, SimLink>(links)
    .id((d) => d.id)
    .distance(linkDist)
    .strength(linkStrength)
    .iterations(1);
  const chargeF = forceManyBody<SimNode>()
    .strength(() => -F.repelForce * REPEL_SCALE)
    .theta(0.9)
    .distanceMin(2)
    .distanceMax(F.linkDistance * CHARGE_RANGE_MUL);
  const xF = forceX<SimNode>(0).strength(gravity);
  const yF = forceY<SimNode>(0).strength(gravity);

  const clusterStrength = F.clusterForce * CLUSTER_SCALE;
  const clusterForce = (): Force<SimNode, SimLink> => {
    let ns: SimNode[] = [];
    const cx = new Map<number, number>();
    const cy = new Map<number, number>();
    const cw = new Map<number, number>();
    const cn = new Map<number, number>();
    const hub = new Map<number, SimNode>();
    const cents: { x: number; y: number }[] = [];
    const force: Force<SimNode, SimLink> = (alpha) => {
      cx.clear();
      cy.clear();
      cw.clear();
      cn.clear();
      hub.clear();
      cents.length = 0;
      for (const n of ns) {
        if (n.community < 0) continue;
        const w = n.isHub ? 8 : 1;
        cx.set(n.community, (cx.get(n.community) ?? 0) + n.x * w);
        cy.set(n.community, (cy.get(n.community) ?? 0) + n.y * w);
        cw.set(n.community, (cw.get(n.community) ?? 0) + w);
        cn.set(n.community, (cn.get(n.community) ?? 0) + 1);
        if (n.isHub) hub.set(n.community, n);
      }
      for (const [cm, w] of cw) {
        cents.push({ x: cx.get(cm)! / w, y: cy.get(cm)! / w });
      }
      const k = clusterStrength * alpha;
      for (const n of ns) {
        if (n.fx != null) continue;
        if (n.community < 0) {
          // Community-less dust drifts toward the nearest cluster.
          if (cents.length === 0) continue;
          let bx = 0;
          let by = 0;
          let bd = Infinity;
          for (const c of cents) {
            const ddx = c.x - n.x;
            const ddy = c.y - n.y;
            const d2 = ddx * ddx + ddy * ddy;
            if (d2 < bd) {
              bd = d2;
              bx = ddx;
              by = ddy;
            }
          }
          const dk = k * DUST_PULL;
          n.vx = (n.vx ?? 0) + bx * dk;
          n.vy = (n.vy ?? 0) + by * dk;
          continue;
        }
        const w = cw.get(n.community);
        if (!w) continue;
        const mx = cx.get(n.community)! / w;
        const my = cy.get(n.community)! / w;
        if (n.isHub) {
          n.vx = (n.vx ?? 0) + (mx - n.x) * k * HUB_PIN;
          n.vy = (n.vy ?? 0) + (my - n.y) * k * HUB_PIN;
          continue;
        }
        const h = hub.get(n.community);
        const ox = h ? h.x : mx;
        const oy = h ? h.y : my;
        let dx = n.x - ox;
        let dy = n.y - oy;
        let dist = Math.hypot(dx, dy);
        if (dist < 1e-3) {
          dx = 1;
          dy = 0;
          dist = 1;
        }
        const count = cn.get(n.community) ?? 1;
        // Densely interlinked groups swell (galaxySizeBoost). Shared formula
        // (galaxyLayout) so the packing footprint stays honest.
        const ringR = clusterOrbitRadius(count, F.linkDistance, sizeBoost.get(n.community) ?? 1);
        const rTarget = ringR * n.rJitter;
        const corr = (rTarget - dist) * k;
        n.vx = (n.vx ?? 0) + (dx / dist) * corr;
        n.vy = (n.vy ?? 0) + (dy / dist) * corr;
      }
    };
    force.initialize = (init: SimNode[]): void => {
      ns = init;
    };
    return force;
  };

  const sim = forceSimulation<SimNode, SimLink>(nodes, 3)
    .force("link", linkF)
    .force("charge", chargeF)
    .force("x", xF)
    .force("y", yF)
    .force(
      "collide",
      // Collide against the radius the node is actually DRAWN at, PLUS half the
      // shared clear-gap margin each — two touching bodies then sit exactly
      // r_i + r_j + NODE_MARGIN apart, the app-wide no-overlap invariant (see
      // layoutSeparation.ts).
      forceCollide<SimNode>((n) => renderedRadius(n.size, n.kind, n.intensity) + NODE_MARGIN / 2)
        .strength(1)
        .iterations(3),
    )
    .force("cluster", clusterForce())
    .force("anchor", anchorForce())
    .alpha(1)
    // Scale-adaptive cooling: a big graph can't relax perfectly anyway, so it
    // converges in far fewer ticks; small graphs keep the slow, pretty settle.
    .alphaDecay(bigGraphDecay(nodes.length))
    .alphaMin(SIM_ALPHA_MIN)
    // Heavier velocity damping at scale kills the slow oscillation of a giant
    // single community fought over by the cluster/anchor forces.
    .velocityDecay(nodes.length > 4000 ? 0.72 : 0.55);

  // 2D: the layout lives on the xy plane. Anything the 3D forces leak into z
  // (a coincident pair the collide force separates along a random axis) is
  // cancelled here so every consumer can ignore z.
  const flatten = (): void => {
    for (const n of nodes) {
      n.z = 0;
      n.vz = 0;
    }
  };

  // --- tick driver: post positions each tick, settle msg at rest -------------
  sim.stop();
  let driverTimer: ReturnType<typeof setTimeout> | null = null;

  const postPositions = (): void => {
    const pos = new Float32Array(nodes.length * 3);
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const o = i * 3;
      pos[o] = n.x;
      pos[o + 1] = n.y;
      pos[o + 2] = 0;
    }
    (self as unknown as Worker).postMessage({ type: "tick", positions: pos }, [pos.buffer]);
  };

  // Throttle position posts to ~30Hz: posting a Float32Array on EVERY tick
  // floods the main-thread event loop and starves requestAnimationFrame.
  const POST_INTERVAL_MS = 33;
  let lastPost = 0;
  const drive = (): void => {
    driverTimer = null;
    sim.tick();
    flatten();
    const settled = sim.alpha() < SIM_ALPHA_MIN;
    if (settled) {
      // The collide force only APPROACHES the no-overlap invariant. At rest we
      // enforce it exactly with the shared deterministic post-process, so the
      // state the user actually looks at has zero violating pairs.
      separateLayout(nodes);
      flatten();
    }
    const nowMs = performance.now();
    if (settled || nowMs - lastPost >= POST_INTERVAL_MS) {
      postPositions();
      lastPost = nowMs;
    }
    if (settled) {
      // Ship the settled layout's ACTUAL extent + per-cluster centroids with the
      // settle notice — the main thread frames the canvas from measurements.
      (self as unknown as Worker).postMessage({
        type: "settle",
        metrics: computeLayoutMetrics(nodes),
      });
      return;
    }
    driverTimer = setTimeout(drive, WORKER_YIELD_MS);
  };
  const kick = (): void => {
    if (driverTimer == null) driverTimer = setTimeout(drive, 0);
  };
  const stopDriver = (): void => {
    if (driverTimer != null) {
      clearTimeout(driverTimer);
      driverTimer = null;
    }
  };
  kick();

  computeAnchors();
  // Seed each anchored node NEAR its cluster anchor (once, at build) so the
  // graph appears already laid out instead of migrating from the origin.
  if (anchors.size > 0) {
    for (const n of nodes) {
      const a = anchors.get(n.community);
      if (!a) continue;
      const j = F.linkDistance;
      n.x = a.x + (seededUnit(n.id, 71) - 0.5) * j;
      n.y = a.y + (seededUnit(n.id, 72) - 0.5) * j;
    }
  }

  return {
    nodes,
    sim,
    reheat(alpha) {
      sim.alpha(alpha).alphaTarget(0);
      kick();
    },
    dragWarm(on) {
      if (on) {
        // Hold a positive target so the driver never settles mid-drag, and make
        // sure alpha is high enough that neighbours actually move.
        sim.alphaTarget(DRAG_ALPHA_TARGET);
        if (sim.alpha() < DRAG_ALPHA_TARGET) sim.alpha(DRAG_ALPHA_TARGET);
        kick();
      } else {
        // Release: cool toward rest. The driver keeps ticking until alpha dips
        // below SIM_ALPHA_MIN, then posts the settle notice and stops.
        sim.alphaTarget(0);
        kick();
      }
    },
    setFixed(id, x, y) {
      const n = byId.get(id);
      if (!n) return;
      if (x == null) {
        n.fx = null;
        n.fy = null;
        n.fz = null;
      } else {
        n.fx = x;
        n.fy = y ?? n.y;
        n.fz = 0;
      }
    },
    stop() {
      stopDriver();
      sim.stop();
    },
  };
}

type InMsg =
  | { type: "init"; nodes: NodeInit[]; links: [number, number][] }
  | { type: "reheat"; alpha: number }
  | { type: "dragWarm"; on: boolean }
  | { type: "setFixed"; id: string; x: number | null; y?: number }
  | { type: "stop" };

self.onmessage = (e: MessageEvent<InMsg>): void => {
  const msg = e.data;
  switch (msg.type) {
    case "init":
      state?.stop();
      state = build(msg.nodes, msg.links);
      break;
    case "reheat":
      state?.reheat(msg.alpha);
      break;
    case "dragWarm":
      state?.dragWarm(msg.on);
      break;
    case "setFixed":
      state?.setFixed(msg.id, msg.x, msg.y);
      break;
    case "stop":
      state?.stop();
      state = null;
      break;
  }
};
