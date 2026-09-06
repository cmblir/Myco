import { describe, expect, it } from "vitest";
import type { Adjacency } from "./ipc";
import { NODE_MARGIN, renderedRadius } from "./layoutSeparation";
import {
  assembleMultiverse,
  multiverseSceneKey,
  universeOfNode,
  type SceneUniverse,
} from "./multiverseScene";

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

// A universe with enough notes that buildGraph's seeded shell scatter
// (seededXYZ — never run through a force sim or FA2 for this view) reliably
// produces raw overlaps before separation: a hub fanning out to N-1 leaves, so
// every note is guaranteed at least one real edge.
function bigUniverse(root: string, n: number): SceneUniverse {
  const hub = `${root}/wiki/hub.md`;
  const forward: Record<string, string[]> = { [hub]: [] };
  for (let i = 0; i < n - 1; i++) {
    const leaf = `${root}/wiki/n${i}.md`;
    forward[hub].push(leaf);
  }
  return { slug: root.split("/").pop()!, root, adjacency: adj({ forward }) };
}

const OPTS = {
  nodeSize: 1,
  starDim: "#333333",
  edgeColor: "rgba(255,255,255,0.2)",
  showGhosts: true,
};


describe("assembleMultiverse", () => {
  const universes = [
    universe("/reg/projects/alpha"),
    universe("/reg/projects/beta"),
  ];
  const { graph, placed } = assembleMultiverse(universes, OPTS);

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

  // Finding A: assembleMultiverse used to translate each universe's raw
  // buildGraph seed scatter as a rigid group WITHOUT separating it first —
  // the same "unpacked raw layout" defect every other view was fixed for, so
  // note bodies within one bubble could sit on top of each other (measured:
  // 13 overlapping pairs on a 3-universe/1244-body field, worst 23.0 units).
  it("separates note bodies WITHIN a universe's own cloud, not just across universes", () => {
    const g = assembleMultiverse([bigUniverse("/reg/projects/gamma", 700)], OPTS).graph;
    const bodies = g.nodes().map((id) => ({
      x: g.getNodeAttribute(id, "x") as number,
      y: g.getNodeAttribute(id, "y") as number,
      z: g.getNodeAttribute(id, "z") as number,
      r: renderedRadius(
        g.getNodeAttribute(id, "size") as number,
        g.getNodeAttribute(id, "starKind") as number | undefined,
        g.getNodeAttribute(id, "intensity") as number | undefined,
      ),
    }));
    let bad = 0;
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const d = Math.hypot(
          bodies[j].x - bodies[i].x,
          bodies[j].y - bodies[i].y,
          bodies[j].z - bodies[i].z,
        );
        if (d < bodies[i].r + bodies[j].r + NODE_MARGIN - 1e-6) bad++;
      }
    }
    expect(bad).toBe(0);
  });

  it("drops a universe whose filter leaves no nodes", () => {
    const withEmpty = [
      universe("/reg/projects/alpha"),
      { slug: "empty", root: "/reg/projects/empty", adjacency: adj({}) },
    ];
    const res = assembleMultiverse(withEmpty, OPTS);
    expect(res.placed.has("alpha")).toBe(true);
    expect(res.placed.has("empty")).toBe(false);
  });

  it("handles a single universe (anchored at origin)", () => {
    const res = assembleMultiverse([universe("/reg/projects/solo")], OPTS);
    expect(res.placed).toEqual(new Set(["solo"]));
    expect(res.graph.order).toBeGreaterThan(0);
  });

  it("returns an empty graph for no universes", () => {
    const res = assembleMultiverse([], OPTS);
    expect(res.graph.order).toBe(0);
    expect(res.placed.size).toBe(0);
  });

  it("is deterministic across runs", () => {
    const again = assembleMultiverse(universes, OPTS);
    expect(again.graph.order).toBe(graph.order);
    // Same positions too (deterministic layout).
    const first = graph.getNodeAttribute("/reg/projects/alpha/wiki/a.md", "x");
    const second = again.graph.getNodeAttribute("/reg/projects/alpha/wiki/a.md", "x");
    expect(second).toBe(first);
  });
});


// The scene is expensive to build, so it rebuilds only when this key changes.
// The key therefore has to move whenever the multiverse's CONTENT moves — the
// bug it exists to prevent is re-entering the multiverse and seeing the star
// field from the first visit, which is exactly the "open multiverse, fly into a
// vault, work, come back" loop the feature is for.
describe("multiverseSceneKey", () => {
  it("is stable across renders when nothing changed", () => {
    const us = [universe("/v/one"), universe("/v/two")];
    expect(multiverseSceneKey(us)).toBe(multiverseSceneKey(us));
  });

  it("changes when a universe's adjacency is replaced", () => {
    const before = [universe("/v/one")];
    const after = [{ ...before[0], adjacency: adj({ forward: { "/v/one/wiki/new.md": [] } }) }];
    expect(multiverseSceneKey(after)).not.toBe(multiverseSceneKey(before));
  });

  it("does not change when an identical-content adjacency object is reused", () => {
    // The store guards on content, so a no-op reload keeps the same object and
    // must not cost a rebuild.
    const u = universe("/v/one");
    expect(multiverseSceneKey([u])).toBe(multiverseSceneKey([{ ...u }]));
  });

  it("changes when a universe is added or removed", () => {
    const one = universe("/v/one");
    const two = universe("/v/two");
    expect(multiverseSceneKey([one, two])).not.toBe(multiverseSceneKey([one]));
  });

  it("changes when the same slugs arrive in a different order", () => {
    const one = universe("/v/one");
    const two = universe("/v/two");
    expect(multiverseSceneKey([one, two])).not.toBe(multiverseSceneKey([two, one]));
  });
});
