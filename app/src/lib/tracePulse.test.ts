import { describe, expect, it } from "vitest";
import Graph from "graphology";
import { TracePulse } from "./tracePulse";

// Minimal graph with known positions so we can assert the comet head lands on
// the path polyline. TracePulse only reads node attributes (x/y/z/color) +
// hasNode/getNodeAttributes, so a bare graphology graph is enough — no WebGL.
function makeGraph(): Graph {
  const g = new Graph();
  g.addNode("a", { x: 0, y: 0, z: 0, color: "#ff0000" });
  g.addNode("b", { x: 10, y: 0, z: 0, color: "#00ff00" });
  g.addNode("c", { x: 10, y: 10, z: 0, color: "#0000ff" });
  g.addEdge("a", "b");
  g.addEdge("b", "c");
  return g;
}

function headXYZ(tp: TracePulse): [number, number, number] {
  const geom = tp.points.geometry;
  const pos = geom.getAttribute("position");
  return [pos.getX(0), pos.getY(0), pos.getZ(0)];
}

describe("TracePulse", () => {
  it("shows the comet and seeds the head at the path start", () => {
    const tp = new TracePulse(makeGraph() as never, 1, true);
    tp.setPath(["a", "b", "c"]);
    expect(tp.points.visible).toBe(true);
    tp.update(0); // head phase 0 → sits on node a (0,0,0)
    const [x, y] = headXYZ(tp);
    expect(x).toBeCloseTo(0, 5);
    expect(y).toBeCloseTo(0, 5);
  });

  it("advances the head along the path at constant speed", () => {
    const tp = new TracePulse(makeGraph() as never, 1, true);
    tp.setPath(["a", "b", "c"]);
    // total length = 20; SPEED 0.32 → after 1s head fraction 0.32 → dist 6.4,
    // still on segment a→b (length 10) at x = 6.4.
    tp.update(1);
    const [x, y] = headXYZ(tp);
    expect(x).toBeCloseTo(6.4, 3);
    expect(y).toBeCloseTo(0, 3);
    // head colour is the START node's colour (red).
    const col = tp.points.geometry.getAttribute("a_pcolor");
    expect(col.getX(0)).toBeGreaterThan(0.9); // r
    expect(col.getZ(0)).toBeLessThan(0.1); // b
  });

  it("hides when cleared or given a degenerate path", () => {
    const tp = new TracePulse(makeGraph() as never, 1, true);
    tp.setPath(["a", "b"]);
    expect(tp.points.visible).toBe(true);
    tp.setPath(null);
    expect(tp.points.visible).toBe(false);
    tp.setPath(["a"]); // < 2 nodes
    expect(tp.points.visible).toBe(false);
    tp.setPath(["a", "missing"]); // unknown node filtered → < 2
    expect(tp.points.visible).toBe(false);
    tp.update(0.1); // no-op, must not throw
  });
});
