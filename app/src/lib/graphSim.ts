// Main-thread PROXY for the off-thread force simulation. The physics runs in
// graphSim.worker.ts so a 10k-node settle (or any drag reheat) never blocks the
// UI; this file (a) serialises the graph into an init payload, (b) relays the
// API (reheat / drag pin / warm) to the worker as messages, and (c) on each
// worker "tick" hands the returned Float32Array of positions (node order,
// x/y/z triples with z always 0) straight to the canvas via onTick.
import { seededUnit, type VaultGraph } from "./graphData";
import type { LayoutMetrics } from "./layoutMetrics";

// A read-only view of a node's latest position — enough for drag hit-testing.
export interface SimNode {
  readonly id: string;
  readonly x: number;
  readonly y: number;
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
  /** Stellar class + HDR intensity — layoutSeparation.renderedRadius needs
   *  both to size the settle-time collide/separation the same as the renderer. */
  kind: number;
  intensity: number;
}

export interface GraphSim {
  // Live position views (id + getters into the latest tick), for drag picking.
  nodes: SimNode[];
  /** Fires when the worker sim reaches alphaMin. `metrics` carries the settled
   * layout's measured extent + per-cluster centroids so the canvas frames from
   * measurements instead of guesses. */
  onSettle(cb: (metrics: LayoutMetrics) => void): void;
  reheat(alpha: number): void;
  // Drag: pin a node to a position, or release it.
  setFixed(id: string, x: number, y: number): void;
  releaseFixed(id: string): void;
  /** Hold the sim warm+ticking for a drag (true), then let it settle (false).
   *  Without this a held drag freezes the neighbourhood as the reheat cools. */
  dragWarm(on: boolean): void;
  stop(): void;
}

function nodeInit(graph: VaultGraph, id: string): NodeInit {
  const a = graph.getNodeAttributes(id);
  return {
    id,
    x: a.x,
    y: a.y,
    z: 0,
    size: a.size,
    deg: a.deg,
    community: a.community,
    galaxy: a.galaxy,
    isHub: a.isHub,
    // Orbit-radius jitter (the worker needs it but must not import graphology).
    rJitter: 0.4 + 0.6 * seededUnit(id, 14),
    kind: a.starKind ?? 0,
    intensity: a.intensity ?? 0,
  };
}

export function createSim(graph: VaultGraph, onTick: (positions: Float32Array) => void): GraphSim {
  const ids: string[] = graph.nodes();
  const idIndex = new Map<string, number>(ids.map((id, i) => [id, i]));
  const initNodes: NodeInit[] = ids.map((id) => nodeInit(graph, id));
  const links: [number, number][] = [];
  graph.forEachEdge((_e, _a, src, tgt) => {
    const si = idIndex.get(src);
    const ti = idIndex.get(tgt);
    if (si != null && ti != null) links.push([si, ti]);
  });

  const worker = new Worker(new URL("./graphSim.worker.ts", import.meta.url), {
    type: "module",
  });

  // Latest positions (node order). Seeded from init so drag reads are valid
  // before the first worker tick arrives. Reassigned (transferred buffer) each tick.
  let latest: Float32Array = new Float32Array(ids.length * 3);
  for (let i = 0; i < initNodes.length; i++) {
    latest[i * 3] = initNodes[i].x;
    latest[i * 3 + 1] = initNodes[i].y;
  }
  let settleCb: ((metrics: LayoutMetrics) => void) | null = null;

  const nodes: SimNode[] = ids.map((id, index) => ({
    id,
    get x() {
      return latest[index * 3];
    },
    get y() {
      return latest[index * 3 + 1];
    },
  }));

  // Coalesce worker ticks to at most ONE onTick per animation frame: the worker
  // ticks as fast as it can, and applying every message on the main thread
  // saturated it during a long settle.
  let flushPending = false;
  const flush = (): void => {
    flushPending = false;
    onTick(latest);
  };
  worker.onmessage = (
    e: MessageEvent<
      { type: "tick"; positions: Float32Array } | { type: "settle"; metrics: LayoutMetrics }
    >,
  ): void => {
    const m = e.data;
    if (m.type === "tick") {
      latest = m.positions;
      if (!flushPending) {
        flushPending = true;
        requestAnimationFrame(flush);
      }
    } else if (m.type === "settle") {
      // Apply the final resting positions immediately so the last frame is exact.
      onTick(latest);
      settleCb?.(m.metrics);
    }
  };

  worker.postMessage({ type: "init", nodes: initNodes, links });

  return {
    nodes,
    onSettle(cb) {
      settleCb = cb;
    },
    reheat(alpha) {
      worker.postMessage({ type: "reheat", alpha });
    },
    setFixed(id, x, y) {
      worker.postMessage({ type: "setFixed", id, x, y });
    },
    releaseFixed(id) {
      worker.postMessage({ type: "setFixed", id, x: null });
    },
    dragWarm(on) {
      worker.postMessage({ type: "dragWarm", on });
    },
    stop() {
      worker.postMessage({ type: "stop" });
      worker.terminate();
    },
  };
}
