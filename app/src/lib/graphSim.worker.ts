// Web Worker: runs the d3-force-3d galaxy simulation OFF the main thread.
//
// At 10k+ nodes a single force tick (Barnes-Hut charge + collide octrees) costs
// ~120ms. Run on the main thread it froze the UI for the whole settle (and every
// drag/slider reheat), and the freeze grew with node count. Here the identical
// force model runs in a worker; each tick posts a transferable Float32Array of
// node positions (in init order) back to the main thread, which writes them
// straight into the three.js buffers. The main thread never blocks on physics.
//
// The force model, constants and timelapse/liveAdd logic are a verbatim port of
// the former main-thread createSim — only the I/O (postMessage instead of a
// direct onTick callback, and id-keyed messages instead of SimNode references)
// differs, so the galaxy/brain layout is byte-for-byte the same.

import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceX,
  forceY,
  forceZ,
  forceCollide,
  type Simulation,
  type Force,
} from "d3-force-3d";
import type { GraphSettings } from "./graphSettings";
import { bigGraphDecay } from "./simCooling";
import {
  clusterOrbitRadius,
  galaxyAnchorsBySize,
  galaxyNormal,
  galaxySizeBoost,
  type GalaxyAnchor,
} from "./galaxyLayout";
import {
  REPEL_SCALE,
  CENTER_SCALE,
  CLUSTER_SCALE,
  HUB_PIN,
  DUST_PULL,
  BIGBANG_BURST,
  SIM_ALPHA_MIN,
  INTER_LINK_DIST_MUL,
  INTER_LINK_STR_MUL,
  INTER_GALAXY_STR_MUL,
  CLUSTERED_GRAVITY_MUL,
  ORPHAN_GRAVITY_MUL,
  CHARGE_RANGE_MUL,
  ANCHOR_SCALE,
  ANCHOR_HUB_MUL,
  FLATTEN_SCALE,
} from "./layoutConfig";
import { computeLayoutMetrics } from "./layoutMetrics";

// Deterministic RNG — copied from graphData so the worker bundle doesn't pull in
// graphology. Must stay identical to graphData's so timelapse spawn jitter matches.
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
}

// Physics constants live in layoutConfig.ts (single source of truth, backlog
// A1) — imported above so the worker, the layout-geometry module and the tests
// can never drift apart again.
//
// In the worker the tick loop yields 0ms — it isn't the UI thread, so the only
// reason to yield is to let queued messages (drag/setFixed) run between ticks.
const WORKER_YIELD_MS = 0;

interface SimState {
  nodes: SimNode[];
  byId: Map<string, SimNode>;
  links: SimLink[];
  linksByNode: Map<string, SimLink[]>;
  sim: Simulation<SimNode, SimLink>;
  reheat: (a: number) => void;
  update: (s: GraphSettings) => void;
  setFixed: (id: string, x: number | null, y?: number, z?: number) => void;
  timelapseReset: () => void;
  timelapseReveal: (ids: string[]) => void;
  timelapseSettle: () => void;
  liveAdd: (newNodes: NodeInit[], newEdges: [string, string][]) => void;
  stop: () => void;
}

let state: SimState | null = null;

function build(
  initNodes: NodeInit[],
  initLinks: [number, number][],
  s: GraphSettings,
): SimState {
  let cur = s;
  const nodes: SimNode[] = initNodes.map((n) => ({ ...n }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const links: SimLink[] = initLinks.map(([si, ti]) => ({
    source: nodes[si],
    target: nodes[ti],
  }));
  const linksByNode = new Map<string, SimLink[]>();
  for (const l of links) {
    const a = (l.source as SimNode).id;
    const b = (l.target as SimNode).id;
    (linksByNode.get(a) ?? linksByNode.set(a, []).get(a)!).push(l);
    (linksByNode.get(b) ?? linksByNode.set(b, []).get(b)!).push(l);
  }

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
    const base = cur.linkForce / (1 + Math.min(sN, tN));
    // Different folder → near-zero pull (galaxies must not merge).
    if (cur.folderGalaxies && !sameGalaxy(l)) return base * INTER_GALAXY_STR_MUL;
    return cur.clusterForce > 0 && !sameComm(l) ? base * INTER_LINK_STR_MUL : base;
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
  // Degree-based distance (calm-cosmic-web spec A3): hub–hub bridges stretch
  // long, leaf links stay short — spokes stop terminating on one shell and the
  // busy trunks get room, dissolving the starburst silhouette.
  const degMul = (l: SimLink): number => {
    const sD = typeof l.source === "object" ? l.source.deg : 1;
    const tD = typeof l.target === "object" ? l.target.deg : 1;
    return 1 + 0.18 * Math.log2(1 + Math.min(sD, tD));
  };
  const linkDist = (l: SimLink): number =>
    (cur.clusterForce > 0 && !sameComm(l)
      ? cur.linkDistance * INTER_LINK_DIST_MUL
      : cur.linkDistance * edgeJitter(l)) * degMul(l);
  const centerOf = (g: GraphSettings): number =>
    Math.max(0.005, g.centerForce * CENTER_SCALE);
  const gravityOf =
    (g: GraphSettings) =>
    (n: SimNode): number => {
      if (g.folderGalaxies) {
        // Anchored nodes: ZERO origin pull (any pull tails the galaxy — the
        // "쏠림"). Orphans (no anchor): a small pull so they cluster near the
        // origin instead of drifting off and inflating the fit bounding box.
        return n.community >= 0 ? 0 : centerOf(g) * ORPHAN_GRAVITY_MUL;
      }
      return g.clusterForce > 0
        ? centerOf(g) * (n.community >= 0 ? CLUSTERED_GRAVITY_MUL : ORPHAN_GRAVITY_MUL)
        : centerOf(g);
    };

  // --- folder-galaxies anchor + disc force -----------------------------------
  // One anchor per group on a wide shell (galaxyLayout); every member is
  // pulled toward its anchor (hubs hardest) AND flattened onto the group's
  // seeded tilted disc plane, so groups settle as separate disc galaxies.
  // sizeBoost (intra-link density) feeds the cluster force's orbit ring —
  // densely interlinked folders swell into bigger galaxies.
  const anchors = new Map<number, GalaxyAnchor>();
  const normals = new Map<number, GalaxyAnchor>();
  const sizeBoost = new Map<number, number>();
  const computeAnchors = (): void => {
    anchors.clear();
    normals.clear();
    sizeBoost.clear();
    // Cluster separation (anchor packing) runs REGARDLESS of folderGalaxies —
    // communities always spread into distinct clumps so the graph never
    // collapses into one diffuse mixed-colour ball. folderGalaxies only toggles
    // the disc FLATTENING below (on = flat tilted galaxy discs; off = 3D
    // spherical star clusters). Both read as clustered.
    // Count nodes per cluster and per galaxy; remember each cluster's galaxy.
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
    // Pack EVERY sized topic cluster as its OWN separated clump, spaced by its
    // node count with real void between (irregular greedy packing, biggest
    // first). The old two-level scheme fanned a folder's clusters inside ONE
    // galaxy footprint — fine when folders were balanced, but a vault where one
    // folder holds ~90% of the notes crammed 60+ clusters into a single small
    // sphere → the whole thing read as one dense ball with the community
    // colours all mixed together. Per-cluster packing makes every topic a
    // distinct coloured puff with gaps. (Folders still group the LEGEND; only
    // the spatial layout changed.) Each clump gets its own tilted disc plane.
    const clusterIds = [...clusterCount.keys()].sort(
      (a, b) => (clusterCount.get(b) ?? 0) - (clusterCount.get(a) ?? 0) || a - b,
    );
    const counts = clusterIds.map((c) => clusterCount.get(c)!);
    const centers = galaxyAnchorsBySize(counts, cur.linkDistance);
    clusterIds.forEach((c, i) => {
      anchors.set(c, centers[i]);
      normals.set(c, galaxyNormal(c));
      sizeBoost.set(c, galaxySizeBoost(clusterCount.get(c) ?? 1, intra.get(c) ?? 0));
    });
  };
  const galaxyForce = (): Force<SimNode, SimLink> => {
    let ns: SimNode[] = [];
    const force: Force<SimNode, SimLink> = (alpha) => {
      if (anchors.size === 0) return;
      const k = ANCHOR_SCALE * alpha;
      const kf = FLATTEN_SCALE * alpha;
      for (const n of ns) {
        if (n.fx != null) continue;
        const a = anchors.get(n.community);
        if (!a) continue;
        const m = n.isHub ? ANCHOR_HUB_MUL : 1;
        n.vx = (n.vx ?? 0) + (a.x - n.x) * k * m;
        n.vy = (n.vy ?? 0) + (a.y - n.y) * k * m;
        n.vz = (n.vz ?? 0) + (a.z - n.z) * k * m;
        // Disc flattening: cancel the offset along the galaxy's spin axis.
        // Only in folder-galaxy mode — off keeps clusters as 3D spheres.
        const nm = cur.folderGalaxies ? normals.get(n.community) : undefined;
        if (nm) {
          const dot =
            (n.x - a.x) * nm.x + (n.y - a.y) * nm.y + (n.z - a.z) * nm.z;
          n.vx -= nm.x * dot * kf;
          n.vy -= nm.y * dot * kf;
          n.vz -= nm.z * dot * kf;
        }
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
  const chargeRange = (): number => cur.linkDistance * CHARGE_RANGE_MUL;
  const chargeF = forceManyBody<SimNode>()
    .strength(() => -cur.repelForce * REPEL_SCALE)
    .theta(0.9)
    .distanceMin(2)
    .distanceMax(chargeRange());
  const xF = forceX<SimNode>(0).strength(gravityOf(s));
  const yF = forceY<SimNode>(0).strength(gravityOf(s));
  const zF = forceZ<SimNode>(0).strength(gravityOf(s));

  let clusterStrength = cur.clusterForce * CLUSTER_SCALE;
  const clusterForce = (): Force<SimNode, SimLink> => {
    let ns: SimNode[] = [];
    const cx = new Map<number, number>();
    const cy = new Map<number, number>();
    const cz = new Map<number, number>();
    const cw = new Map<number, number>();
    const cn = new Map<number, number>();
    const hub = new Map<number, SimNode>();
    const cents: { x: number; y: number; z: number }[] = [];
    const force: Force<SimNode, SimLink> = (alpha) => {
      cx.clear();
      cy.clear();
      cz.clear();
      cw.clear();
      cn.clear();
      hub.clear();
      cents.length = 0;
      for (const n of ns) {
        if (n.community < 0) continue;
        const w = n.isHub ? 8 : 1;
        cx.set(n.community, (cx.get(n.community) ?? 0) + n.x * w);
        cy.set(n.community, (cy.get(n.community) ?? 0) + n.y * w);
        cz.set(n.community, (cz.get(n.community) ?? 0) + n.z * w);
        cw.set(n.community, (cw.get(n.community) ?? 0) + w);
        cn.set(n.community, (cn.get(n.community) ?? 0) + 1);
        if (n.isHub) hub.set(n.community, n);
      }
      for (const [cm, w] of cw) {
        cents.push({ x: cx.get(cm)! / w, y: cy.get(cm)! / w, z: cz.get(cm)! / w });
      }
      const k = clusterStrength * alpha;
      for (const n of ns) {
        if (n.fx != null) continue;
        if (n.community < 0) {
          if (cents.length === 0) continue;
          let bx = 0;
          let by = 0;
          let bz = 0;
          let bd = Infinity;
          for (const c of cents) {
            const ddx = c.x - n.x;
            const ddy = c.y - n.y;
            const ddz = c.z - n.z;
            const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
            if (d2 < bd) {
              bd = d2;
              bx = ddx;
              by = ddy;
              bz = ddz;
            }
          }
          const dk = k * DUST_PULL;
          n.vx = (n.vx ?? 0) + bx * dk;
          n.vy = (n.vy ?? 0) + by * dk;
          n.vz = (n.vz ?? 0) + bz * dk;
          continue;
        }
        const w = cw.get(n.community);
        if (!w) continue;
        const mx = cx.get(n.community)! / w;
        const my = cy.get(n.community)! / w;
        const mz = cz.get(n.community)! / w;
        if (n.isHub) {
          n.vx = (n.vx ?? 0) + (mx - n.x) * k * HUB_PIN;
          n.vy = (n.vy ?? 0) + (my - n.y) * k * HUB_PIN;
          n.vz = (n.vz ?? 0) + (mz - n.z) * k * HUB_PIN;
          continue;
        }
        const h = hub.get(n.community);
        const ox = h ? h.x : mx;
        const oy = h ? h.y : my;
        const oz = h ? h.z : mz;
        let dx = n.x - ox;
        let dy = n.y - oy;
        let dz = n.z - oz;
        let dist = Math.hypot(dx, dy, dz);
        if (dist < 1e-3) {
          dx = 1;
          dy = 0;
          dz = 0;
          dist = 1;
        }
        const count = cn.get(n.community) ?? 1;
        // Galaxy mode: densely interlinked groups swell (galaxySizeBoost).
        // Shared formula (galaxyLayout) so the packing footprint stays honest.
        const ringR = clusterOrbitRadius(
          count,
          cur.linkDistance,
          sizeBoost.get(n.community) ?? 1,
        );
        const rTarget = ringR * n.rJitter;
        const corr = (rTarget - dist) * k;
        n.vx = (n.vx ?? 0) + (dx / dist) * corr;
        n.vy = (n.vy ?? 0) + (dy / dist) * corr;
        n.vz = (n.vz ?? 0) + (dz / dist) * corr;
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
    .force("z", zF)
    .force(
      "collide",
      forceCollide<SimNode>((n) => n.size / 2 + 1.5)
        .strength(0.9)
        .iterations(1),
    )
    .force("cluster", clusterForce())
    .force("galaxy", galaxyForce())
    .alpha(1)
    // Scale-adaptive cooling. A big vault's tick is expensive (Barnes-Hut +
    // collide + galaxy forces over N nodes), so the default ~185-tick settle
    // took ~14s of wall-clock at 11k — and until it settled the graph shimmered,
    // the fit-timer kept re-framing, and every tick flooded an applyPositions.
    // Cooling faster at scale converges in far fewer ticks (a big graph can't
    // relax perfectly anyway); small graphs keep the slow, pretty settle.
    .alphaDecay(bigGraphDecay(nodes.length))
    .alphaMin(SIM_ALPHA_MIN)
    // Heavier velocity damping at scale kills the slow oscillation of a giant
    // single community fought over by the cluster/anchor forces.
    .velocityDecay(nodes.length > 4000 ? 0.72 : 0.55);

  let tlActive: SimNode[] | null = null;
  const activeIds = new Set<string>();
  const activeLinks: SimLink[] = [];

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
      pos[o + 2] = n.z;
    }
    (self as unknown as Worker).postMessage({ type: "tick", positions: pos }, [
      pos.buffer,
    ]);
  };

  // Throttle position posts to ~30Hz. The worker ticks as fast as it can so
  // the physics converges quickly, but posting a 120KB Float32Array on EVERY
  // tick floods the main-thread event loop with hundreds of messages/sec,
  // starving requestAnimationFrame — a 10k-node vault dropped to ~2fps during
  // the settle even though each frame's actual work was cheap. Posting at most
  // every POST_INTERVAL_MS keeps the display fed without drowning it.
  const POST_INTERVAL_MS = 33;
  let lastPost = 0;
  const drive = (): void => {
    driverTimer = null;
    sim.tick();
    const settled = sim.alpha() < SIM_ALPHA_MIN;
    const nowMs = performance.now();
    if (settled || nowMs - lastPost >= POST_INTERVAL_MS) {
      postPositions();
      lastPost = nowMs;
    }
    if (settled) {
      // Ship the settled layout's ACTUAL extent + per-cluster centroids with
      // the settle notice (backlog A1) — the main thread frames the camera and
      // rebuilds bundle strands from measurements, not linkDistance guesses.
      (self as unknown as Worker).postMessage({
        type: "settle",
        metrics: computeLayoutMetrics(tlActive ?? nodes),
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
  // Seed each anchored node NEAR its cluster mini-anchor (once, at build) so the
  // graph appears already laid out instead of migrating from the origin — that
  // long migration is what stretches star clusters into comet tails mid-settle.
  if (anchors.size > 0) {
    for (const n of nodes) {
      const a = anchors.get(n.community);
      if (!a) continue;
      const j = cur.linkDistance;
      n.x = a.x + (seededUnit(n.id, 71) - 0.5) * j;
      n.y = a.y + (seededUnit(n.id, 72) - 0.5) * j;
      n.z = a.z + (seededUnit(n.id, 73) - 0.5) * j;
    }
  }

  return {
    nodes,
    byId,
    links,
    linksByNode,
    sim,
    reheat(alpha) {
      sim.alpha(alpha).alphaTarget(0);
      kick();
    },
    update(next) {
      cur = next;
      clusterStrength = next.clusterForce * CLUSTER_SCALE;
      linkF.distance(linkDist).strength(linkStrength);
      chargeF.strength(() => -next.repelForce * REPEL_SCALE).distanceMax(chargeRange());
      xF.strength(gravityOf(next));
      yF.strength(gravityOf(next));
      zF.strength(gravityOf(next));
      computeAnchors(); // toggle / linkDistance moved the ring
      if (tlActive) {
        sim.alpha(Math.max(sim.alpha(), 0.3));
      } else {
        sim.alpha(0.3).alphaTarget(0);
      }
      kick();
    },
    setFixed(id, x, y, z) {
      const n = byId.get(id);
      if (!n) return;
      if (x == null) {
        n.fx = null;
        n.fy = null;
        n.fz = null;
      } else {
        n.fx = x;
        n.fy = y ?? n.y;
        n.fz = z ?? n.z;
      }
    },
    timelapseReset() {
      activeIds.clear();
      activeLinks.length = 0;
      tlActive = [];
      linkF.links(activeLinks);
      sim.nodes(tlActive).alpha(0).alphaTarget(0);
      stopDriver();
      // Push an (empty active set) snapshot so the scene blanks immediately.
      postPositions();
    },
    timelapseReveal(ids) {
      if (!tlActive) tlActive = [];
      for (const id of ids) {
        const n = byId.get(id);
        if (!n || activeIds.has(id)) continue;
        const theta = seededUnit(id, 11) * Math.PI * 2;
        const phi = Math.acos(2 * seededUnit(id, 12) - 1);
        const sinPhi = Math.sin(phi);
        const ux = Math.cos(theta) * sinPhi;
        const uy = Math.sin(theta) * sinPhi;
        const uz = Math.cos(phi);
        const r = 1 + seededUnit(id, 13) * 3;
        n.x = ux * r;
        n.y = uy * r;
        n.z = uz * r;
        n.vx = ux * BIGBANG_BURST;
        n.vy = uy * BIGBANG_BURST;
        n.vz = uz * BIGBANG_BURST;
        n.fx = null;
        n.fy = null;
        n.fz = null;
        activeIds.add(id);
        tlActive.push(n);
        for (const l of linksByNode.get(id) ?? []) {
          const other = (l.source as SimNode).id === id ? l.target : l.source;
          if (typeof other === "object" && activeIds.has(other.id))
            activeLinks.push(l);
        }
      }
      linkF.links(activeLinks);
      sim.nodes(tlActive).alpha(0.8).alphaTarget(0.1);
      kick();
    },
    timelapseSettle() {
      sim.alphaTarget(0);
      kick();
    },
    liveAdd(newNodes, newEdges) {
      for (const nn of newNodes) {
        if (byId.has(nn.id)) continue;
        const n: SimNode = { ...nn, vx: 0, vy: 0, vz: 0 };
        nodes.push(n);
        byId.set(nn.id, n);
        if (tlActive) {
          activeIds.add(nn.id);
          tlActive.push(n);
        }
      }
      for (const [si, ti] of newEdges) {
        const sn = byId.get(si);
        const tn = byId.get(ti);
        if (!sn || !tn) continue;
        const l: SimLink = { source: sn, target: tn };
        links.push(l);
        (linksByNode.get(si) ?? linksByNode.set(si, []).get(si)!).push(l);
        (linksByNode.get(ti) ?? linksByNode.set(ti, []).get(ti)!).push(l);
        sn.deg += 1;
        tn.deg += 1;
        if (tlActive && activeIds.has(si) && activeIds.has(ti)) {
          activeLinks.push(l);
        }
      }
      linkF.links(tlActive ? activeLinks : links);
      computeAnchors(); // group counts changed
      sim
        .nodes(tlActive ?? nodes)
        .alpha(Math.max(sim.alpha(), 0.5))
        .alphaTarget(0);
      kick();
    },
    stop() {
      tlActive = null;
      stopDriver();
      sim.stop();
    },
  };
}

type InMsg =
  | { type: "init"; nodes: NodeInit[]; links: [number, number][]; settings: GraphSettings }
  | { type: "reheat"; alpha: number }
  | { type: "update"; settings: GraphSettings }
  | { type: "setFixed"; id: string; x: number | null; y?: number; z?: number }
  | { type: "timelapseReset" }
  | { type: "timelapseReveal"; ids: string[] }
  | { type: "timelapseSettle" }
  | { type: "liveAdd"; nodes: NodeInit[]; edges: [string, string][] }
  // Adopt main-thread positions (node order) — the scene's idle galaxy swirl
  // rotates the rendered layout, so before any reheat the worker's copy must
  // catch up or every node would snap back to its pre-swirl position.
  | { type: "syncBack"; positions: Float32Array }
  | { type: "stop" };

self.onmessage = (e: MessageEvent<InMsg>): void => {
  const msg = e.data;
  switch (msg.type) {
    case "init":
      state?.stop();
      state = build(msg.nodes, msg.links, msg.settings);
      break;
    case "reheat":
      state?.reheat(msg.alpha);
      break;
    case "update":
      state?.update(msg.settings);
      break;
    case "setFixed":
      state?.setFixed(msg.id, msg.x, msg.y, msg.z);
      break;
    case "timelapseReset":
      state?.timelapseReset();
      break;
    case "timelapseReveal":
      state?.timelapseReveal(msg.ids);
      break;
    case "timelapseSettle":
      state?.timelapseSettle();
      break;
    case "liveAdd":
      state?.liveAdd(msg.nodes, msg.edges);
      break;
    case "syncBack": {
      const ns = state?.nodes ?? [];
      const p = msg.positions;
      for (let i = 0; i < ns.length && i * 3 + 2 < p.length; i++) {
        const n = ns[i];
        if (n.fx != null) continue; // pinned (dragged) nodes keep their pin
        n.x = p[i * 3];
        n.y = p[i * 3 + 1];
        n.z = p[i * 3 + 2];
      }
      break;
    }
    case "stop":
      state?.stop();
      state = null;
      break;
  }
};
