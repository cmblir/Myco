import { describe, expect, it } from "vitest";
import { buildPreviewGraph, neighborhood } from "./model";
import type { Adjacency } from "../lib/ipc";

const adjacency: Adjacency = {
  forward: {
    "/sample/alpha.md": ["/sample/beta.md"],
    "/sample/beta.md": ["/sample/gamma.md"],
    "/sample/gamma.md": [],
  },
  backward: {},
  unresolved: {},
  tags: {},
};
const allowed = [...Object.keys(adjacency.forward), "/sample/orphan.md"];

describe("interactive graph preview", () => {
  it("preserves notes, the orphan, and only the explicit relationships in every look", () => {
    const graph = buildPreviewGraph({ adjacency, allowed });
    expect(graph.nodes.map((node) => node.id).sort()).toEqual(
      [...allowed].sort(),
    );
    expect(graph.edges.map((edge) => [edge.source, edge.target])).toEqual([
      ["/sample/alpha.md", "/sample/beta.md"],
      ["/sample/beta.md", "/sample/gamma.md"],
    ]);
    for (const node of graph.nodes)
      for (const p of Object.values(node.positions)) {
        expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
        expect(p.x).toBeGreaterThanOrEqual(99.99);
        expect(p.x).toBeLessThanOrEqual(900.01);
        expect(p.y).toBeGreaterThanOrEqual(79.99);
        expect(p.y).toBeLessThanOrEqual(620.01);
      }
    expect(neighborhood(graph, "/sample/alpha.md")).toEqual(
      new Set(["/sample/alpha.md", "/sample/beta.md"]),
    );
    expect(neighborhood(graph, "/sample/orphan.md")).toEqual(
      new Set(["/sample/orphan.md"]),
    );
    expect(neighborhood(graph, null).size).toBe(0);
  });
  it("handles an empty graph and a single isolated note without invalid bounds", () => {
    expect(buildPreviewGraph({ adjacency, allowed: [] })).toEqual({
      nodes: [],
      edges: [],
    });
    const graph = buildPreviewGraph({
      adjacency,
      allowed: ["/sample/orphan.md"],
    });
    for (const p of Object.values(graph.nodes[0].positions))
      expect(p).toEqual({ x: 500, y: 350 });
  });
});
