import { describe, expect, it } from "vitest";
import Graph from "graphology";
import { clusterLabels } from "./clusterLabels";
import type { GraphEdgeAttrs, GraphNodeAttrs } from "./graphData";

function node(community: number, deg: number, color = "#5ba2ff"): GraphNodeAttrs {
  return {
    label: "",
    x: 0,
    y: 0,
    z: 0,
    deg,
    size: 1,
    color,
    community,
    galaxy: -1,
    isHub: false,
    intensity: 0,
  };
}

describe("clusterLabels", () => {
  it("names every sized cluster after its top-degree member, biggest cluster first", () => {
    const g = new Graph<GraphNodeAttrs, GraphEdgeAttrs>();
    // community 0: three notes, hub = b
    g.addNode("/v/wiki/a.md", node(0, 1));
    g.addNode("/v/wiki/b.md", node(0, 5, "#ff0000"));
    g.addNode("/v/wiki/c.md", node(0, 2));
    // community 1: four notes, hub = e
    for (const [id, deg] of [["d", 1], ["e", 3], ["f", 2], ["g", 1]] as const) {
      g.addNode(`/v/wiki/${id}.md`, node(1, deg, "#00ff00"));
    }
    // community 2: too small to name; -1: field star
    g.addNode("/v/wiki/h.md", node(2, 1));
    g.addNode("/v/wiki/i.md", node(2, 1));
    g.addNode("/v/wiki/j.md", node(-1, 0));

    const labels = clusterLabels(g);
    expect(labels.map((l) => l.community)).toEqual([1, 0]);
    expect(labels[0]).toMatchObject({ text: "e", color: "#00ff00" });
    expect(labels[1]).toMatchObject({ text: "b", color: "#ff0000" });
    expect(labels[1].memberIds).toHaveLength(3);
  });
});
