import { describe, expect, it } from "vitest";
import type { Adjacency } from "./ipc";
import { assembleMultiverse, universeOfNode, type SceneUniverse } from "./multiverseScene";

function adj(partial: Partial<Adjacency>): Adjacency {
  return { forward: {}, backward: {}, unresolved: {}, tags: {}, ...partial };
}

// A small linked cluster under `root` (a→b, a→c, b→c) so computeAllowed keeps
// all three and the merge has real edges.
function universe(root: string): SceneUniverse {
  const a = `${root}/wiki/a.md`;
  const b = `${root}/wiki/b.md`;
  const c = `${root}/wiki/c.md`;
  return {
    slug: root.split("/").pop()!,
    root,
    adjacency: adj({ forward: { [a]: [b, c], [b]: [c] } }),
  };
}

const OPTS = {
  nodeSize: 1,
  starDim: "#333333",
  edgeColor: "rgba(255,255,255,0.2)",
  showGhosts: true,
};

const LD = 40;

describe("assembleMultiverse", () => {
  const universes = [
    universe("/reg/projects/alpha"),
    universe("/reg/projects/beta"),
  ];
  const { graph, placed } = assembleMultiverse(universes, OPTS, LD);

  it("places every non-empty universe and tags its nodes", () => {
    expect(placed).toEqual(new Set(["alpha", "beta"]));
    expect(universeOfNode(graph, "/reg/projects/alpha/wiki/a.md")).toBe("alpha");
    expect(universeOfNode(graph, "/reg/projects/beta/wiki/a.md")).toBe("beta");
  });

  it("separates the two universes' node clouds so they don't overlap", () => {
    // Group node positions per universe.
    const pts = new Map<string, [number, number, number][]>();
    graph.forEachNode((_id, a) => {
      const u = a.universe ?? "";
      if (!pts.has(u)) pts.set(u, []);
      pts.get(u)!.push([a.x, a.y, a.z]);
    });
    const alpha = pts.get("alpha")!;
    const beta = pts.get("beta")!;
    // The closest pair of nodes ACROSS the two universes must be positive and
    // clearly separated — the subclouds must not interpenetrate.
    let minCross = Infinity;
    for (const p of alpha) {
      for (const q of beta) {
        minCross = Math.min(minCross, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
      }
    }
    expect(minCross).toBeGreaterThan(300);
  });

  it("drops a universe whose filter leaves no nodes", () => {
    const withEmpty = [
      universe("/reg/projects/alpha"),
      { slug: "empty", root: "/reg/projects/empty", adjacency: adj({}) },
    ];
    const res = assembleMultiverse(withEmpty, OPTS, LD);
    expect(res.placed.has("alpha")).toBe(true);
    expect(res.placed.has("empty")).toBe(false);
  });

  it("handles a single universe (anchored at origin)", () => {
    const res = assembleMultiverse([universe("/reg/projects/solo")], OPTS, LD);
    expect(res.placed).toEqual(new Set(["solo"]));
    expect(res.graph.order).toBeGreaterThan(0);
  });

  it("returns an empty graph for no universes", () => {
    const res = assembleMultiverse([], OPTS, LD);
    expect(res.graph.order).toBe(0);
    expect(res.placed.size).toBe(0);
  });

  it("is deterministic across runs", () => {
    const again = assembleMultiverse(universes, OPTS, LD);
    expect(again.graph.order).toBe(graph.order);
    // Same positions too (deterministic layout).
    const first = graph.getNodeAttribute("/reg/projects/alpha/wiki/a.md", "x");
    const second = again.graph.getNodeAttribute("/reg/projects/alpha/wiki/a.md", "x");
    expect(second).toBe(first);
  });
});
