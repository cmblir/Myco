import { describe, expect, it } from "vitest";
import type { Adjacency } from "./ipc";
import {
  buildMultiverseGraph,
  computeAllowed,
  type MultiverseUniverse,
} from "./graphData";

function adj(partial: Partial<Adjacency>): Adjacency {
  return { forward: {}, backward: {}, unresolved: {}, tags: {}, ...partial };
}

const OPTS = {
  nodeSize: 1,
  starDim: "#333333",
  edgeColor: "rgba(255,255,255,0.2)",
  showGhosts: true,
};

// Two universes under one registry, each a small linked cluster plus an
// unresolved link to the SAME missing name ("todo") — the cross-universe ghost
// collision the namespacing must prevent.
function universe(root: string): MultiverseUniverse {
  const a = `${root}/wiki/a.md`;
  const b = `${root}/wiki/b.md`;
  const c = `${root}/wiki/c.md`;
  const adjacency = adj({
    forward: { [a]: [b, c], [b]: [c] },
    unresolved: { [a]: ["todo"] },
  });
  const allowed = computeAllowed(adjacency, [a, b, c], {
    tagFilter: null,
    folderFilter: null,
    vaultRoot: root,
    search: "",
    existingOnly: false,
    showOrphans: true,
  });
  const slug = root.split("/").pop()!;
  return { slug, adjacency, allowed, vaultRoot: root };
}

describe("buildMultiverseGraph", () => {
  const universes = [
    universe("/reg/projects/alpha"),
    universe("/reg/projects/beta"),
  ];
  const g = buildMultiverseGraph(universes, OPTS);

  it("tags every node with its owning universe slug", () => {
    const bySlug = new Map<string, number>();
    g.forEachNode((_id, a) => {
      const u = a.universe ?? "";
      bySlug.set(u, (bySlug.get(u) ?? 0) + 1);
    });
    expect(bySlug.get("alpha")).toBeGreaterThan(0);
    expect(bySlug.get("beta")).toBeGreaterThan(0);
    expect(bySlug.get("")).toBeUndefined(); // no untagged nodes
  });

  it("namespaces ghost ids per universe so a shared missing name stays two nodes", () => {
    expect(g.hasNode("ghost:alpha:todo")).toBe(true);
    expect(g.hasNode("ghost:beta:todo")).toBe(true);
    expect(g.hasNode("ghost:todo")).toBe(false); // the un-namespaced id must not exist
    // Each ghost is tagged to its own universe.
    expect(g.getNodeAttribute("ghost:alpha:todo", "universe")).toBe("alpha");
    expect(g.getNodeAttribute("ghost:beta:todo", "universe")).toBe("beta");
  });

  it("keeps each universe's real-file nodes and edges intact", () => {
    // 3 real + 1 ghost per universe = 8 nodes.
    expect(g.order).toBe(8);
    expect(g.hasNode("/reg/projects/alpha/wiki/a.md")).toBe(true);
    expect(g.hasNode("/reg/projects/beta/wiki/a.md")).toBe(true);
    // a→b, a→c, b→c, a→ghost = 4 edges per universe = 8 total.
    expect(g.size).toBe(8);
    expect(g.hasEdge("/reg/projects/alpha/wiki/a.md", "/reg/projects/alpha/wiki/b.md")).toBe(true);
  });

  it("never draws an edge between two universes", () => {
    g.forEachEdge((_e, _a, s, t) => {
      const us = g.getNodeAttribute(s, "universe");
      const ut = g.getNodeAttribute(t, "universe");
      expect(us).toBe(ut);
    });
  });

  it("offsets community ids so two universes' clusters never collide", () => {
    const comms = new Map<string, Set<number>>();
    g.forEachNode((_id, a) => {
      if (a.community < 0) return;
      const u = a.universe ?? "";
      if (!comms.has(u)) comms.set(u, new Set());
      comms.get(u)!.add(a.community);
    });
    const alpha = comms.get("alpha") ?? new Set<number>();
    const beta = comms.get("beta") ?? new Set<number>();
    for (const c of alpha) expect(beta.has(c)).toBe(false);
  });

  it("is deterministic — same universes yield the same node/edge counts", () => {
    const again = buildMultiverseGraph(universes, OPTS);
    expect(again.order).toBe(g.order);
    expect(again.size).toBe(g.size);
  });

  it("handles an empty universe list", () => {
    const empty = buildMultiverseGraph([], OPTS);
    expect(empty.order).toBe(0);
  });
});
