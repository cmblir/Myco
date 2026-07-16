// Gap analysis — turns the graph from a picture into an instrument that answers
// "what's missing / weak?". It reads only the graphology graph (structure +
// the Phase 2 frontmatter attributes baked onto each node) and buckets nodes
// into actionable gaps the user can jump to and fix:
//
//   missing       — [[wikilinks]] with no file yet (ghost nodes) → create it
//   orphans       — real pages with zero links → connect them
//   underCited    — pages WITH frontmatter but source_count 0 → add citations
//   lowConfidence — confidence: low
//   disputed      — status: disputed / superseded
//   islands       — small disconnected components (off the main graph)
//
// Pure + synchronous so it is unit-testable and cheap to recompute on demand.

import type { VaultGraph } from "./graphData";

const GHOST = "ghost:";
// Components this size or smaller (and smaller than the giant one) read as
// "islands" — clusters that drifted off the main body of knowledge.
const ISLAND_MAX = 6;

export interface GapReport {
  missing: string[];
  orphans: string[];
  underCited: string[];
  lowConfidence: string[];
  disputed: string[];
  islands: string[][];
  componentCount: number;
}

// Connected components of the undirected graph (BFS). Each component is the list
// of node ids reachable from one another.
export function connectedComponents(g: VaultGraph): string[][] {
  const seen = new Set<string>();
  const comps: string[][] = [];
  g.forEachNode((start) => {
    if (seen.has(start)) return;
    const comp: string[] = [];
    const queue = [start];
    seen.add(start);
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      comp.push(cur);
      for (const n of g.neighbors(cur)) {
        if (!seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
      }
    }
    comps.push(comp);
  });
  return comps;
}

export function analyzeGaps(g: VaultGraph): GapReport {
  const missing: string[] = [];
  const orphans: string[] = [];
  const underCited: string[] = [];
  const lowConfidence: string[] = [];
  const disputed: string[] = [];

  g.forEachNode((id, a) => {
    if (id.startsWith(GHOST)) {
      missing.push(id);
      return;
    }
    if (g.degree(id) === 0) orphans.push(id);
    // Under-cited: only pages that declare frontmatter (so source_count is
    // meaningful) and aren't inherently source-less (a source/entity page).
    const type = a.nodeType;
    const citable = !!type && type !== "source-summary" && type !== "entity";
    if (citable && !a.sourceCount) underCited.push(id);
    if (a.confidence === "low") lowConfidence.push(id);
    if (a.status === "disputed" || a.status === "superseded") disputed.push(id);
  });

  const comps = connectedComponents(g);
  const giant = comps.reduce((m, c) => Math.max(m, c.length), 0);
  const islands = comps.filter((c) => c.length <= ISLAND_MAX && c.length < giant);

  return {
    missing,
    orphans,
    underCited,
    lowConfidence,
    disputed,
    islands,
    componentCount: comps.length,
  };
}

// Total flagged items — drives the toolbar badge / empty-state.
export function gapCount(r: GapReport): number {
  return (
    r.missing.length +
    r.orphans.length +
    r.underCited.length +
    r.lowConfidence.length +
    r.disputed.length +
    r.islands.reduce((n, c) => n + c.length, 0)
  );
}

// ---------------------------------------------------------------------------
// Cluster bridges — the structural-gap half of gap analysis. Node gaps say
// "this page is weak"; bridges say "these two TOPICS should be talking".
// A bridge is a pair of communities whose notes are semantically close (per
// the embedding similarity edges) but which share zero [[wikilinks]] — the
// classic "clusters of thinking that aren't talking to each other yet", i.e.
// your next research question. Pure + synchronous like the node gaps.

export interface BridgePair {
  source: string;
  target: string;
  score: number;
}

export interface ClusterBridge {
  /** Community ids (a < b). */
  a: number;
  b: number;
  /** Highest-degree member of each community — the cluster's display anchor. */
  aHub: string;
  bHub: string;
  /** Sum of semantic-pair scores crossing the gap (rank key). */
  affinity: number;
  /** Strongest example note pairs bridging the two clusters. */
  pairs: BridgePair[];
}

const MAX_BRIDGES = 8;
const MAX_EXAMPLE_PAIRS = 3;

function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export function clusterBridges(g: VaultGraph, sem: BridgePair[]): ClusterBridge[] {
  if (sem.length === 0) return [];

  // Community of each real node + each community's highest-degree member.
  const commOf = new Map<string, number>();
  const hub = new Map<number, { id: string; deg: number }>();
  g.forEachNode((id, attrs) => {
    const c = (attrs as { community: number }).community;
    if (c < 0) return; // field stars / orphans can't anchor a topic bridge
    commOf.set(id, c);
    const deg = g.degree(id);
    const h = hub.get(c);
    if (!h || deg > h.deg) hub.set(c, { id, deg });
  });

  // Community pairs that already share structural links are NOT gaps.
  const linked = new Set<string>();
  g.forEachEdge((_e, _attrs, s, t) => {
    const ca = commOf.get(s);
    const cb = commOf.get(t);
    if (ca == null || cb == null || ca === cb) return;
    linked.add(pairKey(ca, cb));
  });

  // Aggregate semantic affinity across the UNLINKED community pairs.
  const acc = new Map<string, ClusterBridge>();
  for (const e of sem) {
    const ca = commOf.get(e.source);
    const cb = commOf.get(e.target);
    if (ca == null || cb == null || ca === cb) continue;
    const key = pairKey(ca, cb);
    if (linked.has(key)) continue;
    let b = acc.get(key);
    if (!b) {
      const [lo, hi] = ca < cb ? [ca, cb] : [cb, ca];
      b = {
        a: lo,
        b: hi,
        aHub: hub.get(lo)?.id ?? "",
        bHub: hub.get(hi)?.id ?? "",
        affinity: 0,
        pairs: [],
      };
      acc.set(key, b);
    }
    b.affinity += e.score;
    b.pairs.push(e);
  }

  const out = [...acc.values()];
  for (const b of out) {
    b.pairs.sort((x, y) => y.score - x.score);
    b.pairs = b.pairs.slice(0, MAX_EXAMPLE_PAIRS);
  }
  return out.sort((x, y) => y.affinity - x.affinity).slice(0, MAX_BRIDGES);
}
