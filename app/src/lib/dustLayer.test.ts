import { describe, expect, it } from "vitest";
import Graph from "graphology";
import { DustLayer } from "./dustLayer";

function makeGraph(): Graph {
  const g = new Graph();
  g.addNode("a", { x: 0, y: 0, z: 0, color: "#ff0000", size: 1 });
  g.addNode("b", { x: 100, y: 0, z: 0, color: "#00ff00", size: 2 });
  return g;
}

describe("DustLayer", () => {
  it("hidden by default and update no-ops until shown", () => {
    const d = new DustLayer(makeGraph() as never, ["a", "b"], 1, true);
    expect(d.points.visible).toBe(false);
    d.update(0.1); // must not throw while hidden
    const pos = d.points.geometry.getAttribute("position");
    // Nothing written yet (all zeros) while hidden.
    expect(pos.getX(0)).toBe(0);
  });

  it("places every mote on a circular orbit around its node", () => {
    const g = makeGraph();
    const d = new DustLayer(g as never, ["a", "b"], 1, true);
    d.setVisible(true);
    d.update(0.016);
    const pos = d.points.geometry.getAttribute("position");
    const n = pos.count;
    expect(n).toBeGreaterThan(0);
    const centers = [
      { x: 0, y: 0, z: 0 },
      { x: 100, y: 0, z: 0 },
    ];
    // Each mote must sit within a plausible orbit shell of ONE of the two nodes
    // (orbit radius = size*3.4*(1.6..4.8) → a:~5.4..16.3, b:~10.9..32.6).
    for (let i = 0; i < n; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const near = centers.some((c) => {
        const r = Math.hypot(x - c.x, y - c.y, z - c.z);
        return r > 3 && r < 40;
      });
      expect(near).toBe(true);
    }
  });

  it("re-seeds without throwing when the node set changes", () => {
    const d = new DustLayer(makeGraph() as never, ["a", "b"], 1, true);
    d.seed(["a"]);
    d.setVisible(true);
    d.update(0.016); // must not throw
    expect(d.points.geometry.getAttribute("position").count).toBeGreaterThan(0);
  });
});
