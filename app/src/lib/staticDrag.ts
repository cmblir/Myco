// Elastic drag for the DETERMINISTIC (static) layouts — walrus, spiral, radial,
// celestial, semantic, atlas, synapse, strata. Those bake fixed positions and
// run no force sim, so dragging a node used to move only that one node while the
// neighbourhood stayed frozen. This adds a light, main-thread proportional-edit
// relaxation: the pulled node's displacement propagates to its neighbourhood,
// decaying by hop distance, so the branch/cluster follows the cursor. On release
// everything eases back to the baked layout — a static layout is deterministic,
// so it snaps back rather than permanently deforming.
//
// It is neighbourhood-limited (BFS to MAX_HOPS, capped at MAX_AFFECTED), so even
// a hub drag on a huge vault stays cheap; nodes past the frontier act as fixed
// anchors, which is exactly the natural falloff we want.

import type { VaultGraph } from "./graphData";

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

const MAX_HOPS = 6;
const MAX_AFFECTED = 600;
const FALLOFF = 0.55; // per-hop displacement decay (hop1 ≈ 0.55, hop2 ≈ 0.30, …)
const SMOOTH = 0.4; // per-frame ease toward target → a slight organic lag
const RELEASE_MS = 420;

interface Affected {
  id: string;
  anchor: Vec3;
  w: number; // FALLOFF^hop — how much of the drag displacement this node takes
}

export interface StaticDrag {
  begin(id: string): void;
  release(): void;
  dispose(): void;
}

/**
 * @param graph   the live graphology graph (positions are read/written on it)
 * @param onFrame called after each relaxation frame — push positions to the GPU
 */
export function createStaticDrag(graph: VaultGraph, onFrame: () => void): StaticDrag {
  let raf: number | null = null;
  let draggedId: string | null = null;
  let draggedAnchor: Vec3 = { x: 0, y: 0, z: 0 };
  let affected: Affected[] = [];
  // release ease-back state
  let releaseStart = 0;
  let releaseDelta0: Vec3 = { x: 0, y: 0, z: 0 };

  const pos = (id: string): Vec3 => {
    const a = graph.getNodeAttributes(id);
    return { x: a.x, y: a.y, z: a.z };
  };
  const setPos = (id: string, x: number, y: number, z: number): void => {
    graph.mergeNodeAttributes(id, { x, y, z });
  };
  const cancel = (): void => {
    if (raf != null) cancelAnimationFrame(raf);
    raf = null;
  };

  // BFS the neighbourhood, recording each node's baked anchor + hop-decayed weight.
  const collect = (start: string): void => {
    affected = [];
    const seen = new Set<string>([start]);
    let frontier = [start];
    for (let hop = 1; hop <= MAX_HOPS && seen.size < MAX_AFFECTED; hop++) {
      const w = Math.pow(FALLOFF, hop);
      const next: string[] = [];
      for (const id of frontier) {
        for (const nb of graph.neighbors(id)) {
          if (seen.has(nb)) continue;
          seen.add(nb);
          affected.push({ id: nb, anchor: pos(nb), w });
          next.push(nb);
          if (seen.size >= MAX_AFFECTED) break;
        }
        if (seen.size >= MAX_AFFECTED) break;
      }
      frontier = next;
    }
  };

  // Active-drag frame: propagate the dragged node's current displacement to the
  // neighbourhood, eased for an organic lag. The dragged node itself is left
  // wherever onDrag placed it (the cursor).
  const drive = (): void => {
    if (draggedId == null) return;
    const cur = pos(draggedId);
    const dx = cur.x - draggedAnchor.x;
    const dy = cur.y - draggedAnchor.y;
    const dz = cur.z - draggedAnchor.z;
    for (const n of affected) {
      const p = pos(n.id);
      const tx = n.anchor.x + dx * n.w;
      const ty = n.anchor.y + dy * n.w;
      const tz = n.anchor.z + dz * n.w;
      setPos(n.id, p.x + (tx - p.x) * SMOOTH, p.y + (ty - p.y) * SMOOTH, p.z + (tz - p.z) * SMOOTH);
    }
    onFrame();
    raf = requestAnimationFrame(drive);
  };

  // Release: shrink the displacement to zero (ease-out cubic) so the dragged
  // node and its neighbourhood glide back to the baked layout.
  const easeBack = (): void => {
    if (draggedId == null) return;
    const t = Math.min(1, (performance.now() - releaseStart) / RELEASE_MS);
    const f = 1 - Math.pow(1 - t, 3); // 1 → 0 displacement as f: 0 → 1
    const s = 1 - f;
    setPos(
      draggedId,
      draggedAnchor.x + releaseDelta0.x * s,
      draggedAnchor.y + releaseDelta0.y * s,
      draggedAnchor.z + releaseDelta0.z * s,
    );
    for (const n of affected) {
      setPos(
        n.id,
        n.anchor.x + releaseDelta0.x * n.w * s,
        n.anchor.y + releaseDelta0.y * n.w * s,
        n.anchor.z + releaseDelta0.z * n.w * s,
      );
    }
    onFrame();
    if (t < 1) {
      raf = requestAnimationFrame(easeBack);
    } else {
      cancel();
      draggedId = null;
    }
  };

  return {
    begin(id) {
      cancel();
      if (!graph.hasNode(id)) return;
      draggedId = id;
      draggedAnchor = pos(id);
      collect(id);
      raf = requestAnimationFrame(drive);
    },
    release() {
      if (draggedId == null) return;
      const cur = pos(draggedId);
      releaseDelta0 = {
        x: cur.x - draggedAnchor.x,
        y: cur.y - draggedAnchor.y,
        z: cur.z - draggedAnchor.z,
      };
      releaseStart = performance.now();
      cancel();
      raf = requestAnimationFrame(easeBack);
    },
    dispose() {
      cancel();
      draggedId = null;
      affected = [];
    },
  };
}
