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
