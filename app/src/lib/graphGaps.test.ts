import { describe, expect, it } from "vitest";
import type { Adjacency } from "./ipc";
import { buildGraph } from "./graphData";
import { analyzeGaps, connectedComponents, gapCount } from "./graphGaps";

function adj(partial: Partial<Adjacency>): Adjacency {
  return { forward: {}, backward: {}, unresolved: {}, tags: {}, ...partial };
}

const opts = {
  nodeSize: 1,
  starDim: "#000000",
  edgeColor: "#000000",
  showGhosts: false,
};

const A = "/v/a.md";
const B = "/v/b.md";
const C = "/v/c.md";
const D = "/v/d.md";
const E = "/v/e.md";
const F = "/v/f.md";

describe("connectedComponents", () => {
  it("splits the graph into reachable groups", () => {
    // {a,b,c} chain, {d,e} pair, {f} orphan
    const g = buildGraph(
      adj({ forward: { [A]: [B], [B]: [C], [D]: [E] } }),
      new Set([A, B, C, D, E, F]),
      opts,
    );
    const comps = connectedComponents(g).map((c) => c.length).sort();
    expect(comps).toEqual([1, 2, 3]);
  });
});

describe("analyzeGaps", () => {
  it("flags orphans and disconnected islands", () => {
    const g = buildGraph(
      adj({ forward: { [A]: [B], [B]: [C], [D]: [E] } }),
      new Set([A, B, C, D, E, F]),
      opts,
    );
    const r = analyzeGaps(g);
    expect(r.orphans).toEqual([F]);
    expect(r.componentCount).toBe(3);
    // giant component is {a,b,c} (3); {d,e} and {f} are smaller → islands.
    const islandSizes = r.islands.map((c) => c.length).sort();
    expect(islandSizes).toEqual([1, 2]);
  });

  it("flags low-confidence, disputed and under-cited from frontmatter meta", () => {
    const g = buildGraph(
      adj({
        forward: { [A]: [B] },
        meta: {
          [A]: {
            type: "concept",
            confidence: "low",
            status: "disputed",
            sourceCount: 0,
          },
          [B]: { type: "source-summary", sourceCount: 0 },
        },
      }),
      new Set([A, B, C]),
      opts,
    );
    const r = analyzeGaps(g);
    expect(r.lowConfidence).toEqual([A]);
    expect(r.disputed).toEqual([A]);
    // A (concept, 0 sources) is under-cited; B is a source page (excluded);
    // C has no frontmatter type (excluded).
    expect(r.underCited).toEqual([A]);
  });

  it("flags ghost targets as missing pages", () => {
    const g = buildGraph(
      adj({ forward: { [A]: [B] }, unresolved: { [A]: ["nowhere"] } }),
      new Set([A, B]),
      { ...opts, showGhosts: true },
    );
    const r = analyzeGaps(g);
    expect(r.missing).toEqual(["ghost:nowhere"]);
  });

  it("gapCount sums every bucket including island members", () => {
    const g = buildGraph(
      adj({ forward: { [A]: [B], [D]: [E] } }),
      new Set([A, B, D, E, F]),
      opts,
    );
    const r = analyzeGaps(g);
    expect(gapCount(r)).toBeGreaterThan(0);
  });
});
