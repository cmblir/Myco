// Main-thread PROXY for the off-thread galaxy simulation. The actual d3-force-3d
// physics runs in graphSim.worker.ts so a 10k-node settle (or any drag/slider
// reheat) never blocks the UI; this file just (a) serialises the graph into an
// init payload, (b) relays the API (reheat/update/timelapse*/liveAdd/drag) to
// the worker as messages, and (c) on each worker "tick" hands the returned
// Float32Array of positions straight to the scene via onTick. The public API is
// unchanged except onTick now receives positions (node order) instead of node
// objects, and drag uses setFixed/releaseFixed instead of mutating fx/fy/fz.
import type { GraphSettings } from "./graphSettings";
import { seededUnit, type VaultGraph } from "./graphData";

// A read-only view of a node's latest position — enough for drag hit-testing.
// (The mutable SimNode now lives in the worker.)
export interface SimNode {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

interface NodeInit {
  id: string;
  x: number;
  y: number;
  z: number;
  size: number;
  deg: number;
  community: number;
  isHub: boolean;
  rJitter: number;
}

export interface GraphSim {
  // Live position views (id + getters into the latest tick), for drag picking.
  nodes: SimNode[];
  onSettle(cb: () => void): void;
  reheat(alpha: number): void;
  update(next: GraphSettings): void;
  // Drag: pin a node to a position, or release it. Replaces fx/fy/fz mutation,
  // which is impossible now that the node objects live in the worker.
  setFixed(id: string, x: number, y: number, z: number): void;
  releaseFixed(id: string): void;
  timelapseReset(): void;
  timelapseReveal(ids: string[]): void;
  timelapseSettle(): void;
  liveAdd(newIds: string[], newEdges: [string, string][]): void;
  /** Adopt main-thread positions (node order) — call before a reheat when the
   * scene's idle galaxy swirl has rotated the rendered layout, so the worker's
   * copy doesn't snap everything back. Transfers the buffer. */
  syncBack(positions: Float32Array): void;
  stop(): void;
}

function nodeInit(graph: VaultGraph, id: string): NodeInit {
  const a = graph.getNodeAttributes(id);
  return {
    id,
    x: a.x,
    y: a.y,
    z: a.z,
    size: a.size,
    deg: a.deg,
    community: a.community,
    isHub: a.isHub,
    // Precompute the orbit-radius jitter here (the worker needs it but must not
    // import graphology); identical formula to the former in-sim value.
    rJitter: 0.4 + 0.6 * seededUnit(id, 14),
  };
}

export function createSim(
  graph: VaultGraph,
  s: GraphSettings,
  onTick: (positions: Float32Array) => void,
): GraphSim {
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
  // Annotate the buffer-generic away (TS 5.7+ Float32Array<TArrayBuffer>) so a
  // transferred array (ArrayBufferLike) can be reassigned to it.
  let latest: Float32Array = new Float32Array(ids.length * 3);
  for (let i = 0; i < initNodes.length; i++) {
    const o = i * 3;
    latest[o] = initNodes[i].x;
    latest[o + 1] = initNodes[i].y;
    latest[o + 2] = initNodes[i].z;
  }
  let settleCb: (() => void) | null = null;

  // Position views with getters reading the current `latest`. `liveAdd` appends.
  const makeView = (index: number, id: string): SimNode => ({
    id,
    get x() {
      return latest[index * 3];
    },
    get y() {
      return latest[index * 3 + 1];
    },
    get z() {
      return latest[index * 3 + 2];
    },
  });
  const nodes: SimNode[] = ids.map((id, i) => makeView(i, id));
  let count = ids.length;

  // Coalesce worker ticks to at most ONE onTick per animation frame. The
  // worker ticks as fast as it can (setTimeout 0) and floods position
  // messages; applying every one on the main thread — each an O(n)+O(edges)
  // buffer rewrite — saturated the main thread and dropped a 10k-node vault to
  // ~2fps during the (long) settle. Storing the latest buffer and flushing it
  // once per rAF decouples worker tick rate from main-thread cost.
  let flushPending = false;
  const flush = (): void => {
    flushPending = false;
    onTick(latest);
  };
  worker.onmessage = (
    e: MessageEvent<
      { type: "tick"; positions: Float32Array } | { type: "settle" }
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
      settleCb?.();
    }
  };

  worker.postMessage({ type: "init", nodes: initNodes, links, settings: s });

  return {
    nodes,
    onSettle(cb) {
      settleCb = cb;
    },
    reheat(alpha) {
      worker.postMessage({ type: "reheat", alpha });
    },
    update(next) {
      worker.postMessage({ type: "update", settings: next });
    },
    setFixed(id, x, y, z) {
      worker.postMessage({ type: "setFixed", id, x, y, z });
    },
    releaseFixed(id) {
      worker.postMessage({ type: "setFixed", id, x: null });
    },
    timelapseReset() {
      worker.postMessage({ type: "timelapseReset" });
    },
    timelapseReveal(ids2) {
      worker.postMessage({ type: "timelapseReveal", ids: ids2 });
    },
    timelapseSettle() {
      worker.postMessage({ type: "timelapseSettle" });
    },
    liveAdd(newIds, newEdges) {
      const fresh = newIds.filter((id) => !idIndex.has(id) && graph.hasNode(id));
      const payload: NodeInit[] = fresh.map((id) => nodeInit(graph, id));
      for (const id of fresh) {
        const idx = count++;
        idIndex.set(id, idx);
        nodes.push(makeView(idx, id));
      }
      worker.postMessage({ type: "liveAdd", nodes: payload, edges: newEdges });
    },
    syncBack(positions) {
      worker.postMessage({ type: "syncBack", positions }, [positions.buffer]);
    },
    stop() {
      worker.postMessage({ type: "stop" });
      worker.terminate();
    },
  };
}
