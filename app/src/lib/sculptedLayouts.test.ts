import Graph from "graphology";
import { describe, expect, it } from "vitest";
import type { VaultGraph } from "./graphData";
import {
  applySculptedLayout,
  isSculptedLayout,
  sampleRibbon,
  sampleTerrain,
  type SculptedLayoutKind,
} from "./sculptedLayouts";

const KINDS: SculptedLayoutKind[] = ["terrain", "ribbon", "city"];
function fixture(count: number, reverse = false): VaultGraph {
  const graph = new Graph({ type: "undirected" }) as VaultGraph;
  const ids = Array.from({ length: count }, (_, i) => i);
  if (reverse) ids.reverse();
  for (const i of ids)
    graph.addNode(`synthetic-${i}`, {
      label: `Synthetic note ${i}`,
      x: 0,
      y: 0,
      z: 0,
      deg: i % 19,
      size: 1,
      color: "#aabbcc",
      community: (i % 9) - 1,
      galaxy: -1,
      isHub: i % 19 === 18,
      intensity: 0.3,
    });
  for (let i = 1; i < count; i += 3)
    graph.addEdge(`synthetic-${i - 1}`, `synthetic-${i}`);
  return graph;
}

describe.each(KINDS)("%s sculpted layout", (kind) => {
  it("keeps an empty graph empty and a single isolated note finite", () => {
    const empty = fixture(0);
    const blank = applySculptedLayout(empty, kind, { targetRadius: 100 });
    expect(empty.order).toBe(0);
    expect(blank.nodes.size).toBe(0);
    const graph = fixture(1);
    const layout = applySculptedLayout(graph, kind, { targetRadius: 100 });
    expect([...layout.nodes.keys()]).toEqual(["synthetic-0"]);
    const node = graph.getNodeAttributes("synthetic-0");
    expect([node.x, node.y, node.z].every(Number.isFinite)).toBe(true);
  });

  it("is stable across insertion order and repeated layout, without changing graph semantics", () => {
    const graph = fixture(73);
    const reversed = fixture(73, true);
    const original = graph.export();
    const layout = applySculptedLayout(graph, kind, { targetRadius: 120 });
    const other = applySculptedLayout(reversed, kind, { targetRadius: 120 });
    expect(layout).toEqual(other);
    for (const id of graph.nodes())
      expect(graph.getNodeAttributes(id)).toEqual(
        reversed.getNodeAttributes(id),
      );
    const placed = graph.export();
    expect(applySculptedLayout(graph, kind, { targetRadius: 120 })).toEqual(
      layout,
    );
    expect(graph.export()).toEqual(placed);
    expect(placed.edges).toEqual(original.edges);
    for (const node of original.nodes) {
      const {
        x: _x,
        y: _y,
        z: _z,
        ...attributes
      } = graph.getNodeAttributes(node.key);
      const { x: _oldX, y: _oldY, z: _oldZ, ...before } = node.attributes!;
      expect(attributes).toEqual(before);
    }
  });

  it("covers every note at large scale with finite, unique centers and valid geometry bounds", () => {
    const graph = fixture(4096);
    const layout = applySculptedLayout(graph, kind, { targetRadius: 150 });
    expect(layout.nodes.size).toBe(graph.order);
    const unique = new Set<string>();
    graph.forEachNode((id, attrs) => {
      unique.add(`${attrs.x},${attrs.y},${attrs.z}`);
      const node = layout.nodes.get(id)!;
      expect(
        [node.width, node.depth, node.height].every(
          (value) => Number.isFinite(value) && value > 0,
        ),
      ).toBe(true);
      expect(
        Math.hypot(node.normal.x, node.normal.y, node.normal.z),
      ).toBeCloseTo(1, 8);
      for (const axis of ["x", "y", "z"] as const) {
        expect(attrs[axis]).toBeGreaterThanOrEqual(layout.bounds.min[axis]);
        expect(attrs[axis]).toBeLessThanOrEqual(layout.bounds.max[axis]);
        expect(Math.abs(attrs[axis])).toBeLessThan(300);
      }
    });
    expect(unique.size).toBe(graph.order);
  });

  it("scales every position and dimension with targetRadius", () => {
    const small = fixture(31);
    const large = fixture(31);
    const first = applySculptedLayout(small, kind, { targetRadius: 80 });
    const second = applySculptedLayout(large, kind, { targetRadius: 160 });
    small.forEachNode((id, attrs) => {
      for (const axis of ["x", "y", "z"] as const)
        expect(large.getNodeAttribute(id, axis)).toBeCloseTo(
          attrs[axis] * 2,
          8,
        );
      for (const dimension of ["width", "depth", "height"] as const)
        expect(second.nodes.get(id)![dimension]).toBeCloseTo(
          first.nodes.get(id)![dimension] * 2,
          8,
        );
    });
  });

  it("handles many single-note communities and a completely ungrouped graph", () => {
    for (const grouped of [true, false]) {
      const graph = fixture(1200);
      graph.forEachNode((id, _attrs) =>
        graph.setNodeAttribute(
          id,
          "community",
          grouped ? Number(id.split("-")[1]) : -1,
        ),
      );
      const layout = applySculptedLayout(graph, kind, { targetRadius: 100 });
      expect(layout.nodes.size).toBe(1200);
      graph.forEachNode((_id, attrs) => {
        expect([attrs.x, attrs.y, attrs.z].every(Number.isFinite)).toBe(true);
        expect(Math.abs(attrs.z)).toBeLessThan(100);
      });
    }
  });
});

describe("sculpted surfaces", () => {
  it("keeps terrain cards above a non-flat shared heightfield", () => {
    const graph = fixture(180);
    const layout = applySculptedLayout(graph, "terrain", { targetRadius: 100 });
    if (layout.kind !== "terrain") throw new Error("Expected terrain");
    const heights = graph.nodes().map((id) => {
      const attrs = graph.getNodeAttributes(id);
      expect(attrs.z).toBeGreaterThan(sampleTerrain(layout, attrs.x, attrs.y));
      return attrs.z;
    });
    expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(15);
    expect(layout.peaks.length).toBeGreaterThan(1);
  });

  it("creates a wide, folded ribbon with normalized surface normals", () => {
    const layout = applySculptedLayout(fixture(180), "ribbon", {
      targetRadius: 100,
    });
    if (layout.kind !== "ribbon") throw new Error("Expected ribbon");
    let low = Infinity;
    let high = -Infinity;
    for (let i = 0; i <= 50; i++) {
      const left = sampleRibbon(layout, i / 50, -1);
      const right = sampleRibbon(layout, i / 50, 1);
      expect(
        Math.hypot(
          left.position.x - right.position.x,
          left.position.y - right.position.y,
          left.position.z - right.position.z,
        ),
      ).toBeCloseTo(layout.halfWidth * 2, 6);
      expect(
        Math.hypot(left.normal.x, left.normal.y, left.normal.z),
      ).toBeCloseTo(1, 8);
      low = Math.min(low, left.position.z);
      high = Math.max(high, left.position.z);
    }
    expect(high - low).toBeGreaterThan(50);
    expect(sampleRibbon(layout, 0.3, 1).position.z).not.toBeCloseTo(
      sampleRibbon(layout, 0.3, -1).position.z,
    );
  });

  it("gives terrain separated relief and low edges instead of a broad raised slab", () => {
    const layout = applySculptedLayout(fixture(2500), "terrain", {
      targetRadius: 100,
    });
    if (layout.kind !== "terrain") throw new Error("Expected terrain");
    const heights: number[] = [];
    for (let row = 0; row <= 40; row++)
      for (let column = 0; column <= 40; column++) {
        heights.push(
          sampleTerrain(
            layout,
            (column / 40 - 0.5) * layout.extent.width,
            (row / 40 - 0.5) * layout.extent.depth,
          ),
        );
      }
    expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(40);
    for (let step = 0; step <= 20; step++) {
      const x = (step / 20 - 0.5) * layout.extent.width;
      expect(sampleTerrain(layout, x, -layout.extent.depth / 2)).toBeLessThan(
        3,
      );
      expect(sampleTerrain(layout, x, layout.extent.depth / 2)).toBeLessThan(3);
    }
  });

  it("keeps distant ribbon sections apart along an open S-shaped spine", () => {
    const layout = applySculptedLayout(fixture(2500), "ribbon", {
      targetRadius: 100,
    });
    if (layout.kind !== "ribbon") throw new Error("Expected ribbon");
    const spine = Array.from(
      { length: 101 },
      (_, i) => sampleRibbon(layout, i / 100, 0).position,
    );
    for (let i = 1; i < spine.length; i++)
      expect(spine[i].x).toBeGreaterThan(spine[i - 1].x);
    expect(spine[25].y).toBeGreaterThan(30);
    expect(spine[75].y).toBeLessThan(-30);
    for (let a = 0; a < spine.length; a++)
      for (let b = a + 18; b < spine.length; b++) {
        expect(
          Math.hypot(
            spine[a].x - spine[b].x,
            spine[a].y - spine[b].y,
            spine[a].z - spine[b].z,
          ),
        ).toBeGreaterThan(layout.halfWidth * 2.3);
      }
    // Both edges advance along the spine, even at the tightest raised fold.
    for (let i = 1; i < 100; i++)
      for (const v of [-1, 1]) {
        const before = sampleRibbon(layout, (i - 1) / 100, v).position;
        const after = sampleRibbon(layout, (i + 1) / 100, v).position;
        const tangent = {
          x: spine[i + 1].x - spine[i - 1].x,
          y: spine[i + 1].y - spine[i - 1].y,
          z: spine[i + 1].z - spine[i - 1].z,
        };
        expect(
          (after.x - before.x) * tangent.x +
            (after.y - before.y) * tangent.y +
            (after.z - before.z) * tangent.z,
        ).toBeGreaterThan(0);
      }
  });

  it("leaves explicit city streets clear even at the largest displayed footprint", () => {
    const graph = fixture(2500);
    const layout = applySculptedLayout(graph, "city", { targetRadius: 100 });
    if (layout.kind !== "city") throw new Error("Expected city");
    expect(
      layout.districts.some((district) => (district.streetX?.length ?? 0) > 0),
    ).toBe(true);
    for (const district of layout.districts) {
      expect(district.streetX?.length ?? 0).toBeLessThanOrEqual(32);
      expect(district.streetY?.length ?? 0).toBeLessThanOrEqual(32);
      for (const id of graph
        .nodes()
        .filter(
          (id) =>
            graph.getNodeAttribute(id, "community") === district.community,
        )) {
        const point = graph.getNodeAttributes(id);
        const shape = layout.nodes.get(id)!;
        for (const x of district.streetX ?? [])
          expect(
            Math.abs(point.x - x) - shape.width * 0.7,
          ).toBeGreaterThanOrEqual(district.streetWidthX! / 2);
        for (const y of district.streetY ?? [])
          expect(
            Math.abs(point.y - y) - shape.depth * 0.7,
          ).toBeGreaterThanOrEqual(district.streetWidthY! / 2);
      }
    }
  });

  it("gives city notes individual non-overlapping footprints with degree-based heights", () => {
    const graph = fixture(100);
    const layout = applySculptedLayout(graph, "city", { targetRadius: 100 });
    if (layout.kind !== "city") throw new Error("Expected city");
    const ids = graph.nodes();
    for (let a = 0; a < ids.length; a++) {
      const p = graph.getNodeAttributes(ids[a]);
      const size = layout.nodes.get(ids[a])!;
      expect(p.z - size.height / 2).toBeCloseTo(0, 8);
      const district = layout.districts.find(
        (candidate) => candidate.community === p.community,
      )!;
      expect(Math.abs(p.x - district.x) + size.width / 2).toBeLessThanOrEqual(
        district.width / 2,
      );
      expect(Math.abs(p.y - district.y) + size.depth / 2).toBeLessThanOrEqual(
        district.depth / 2,
      );
      for (let b = a + 1; b < ids.length; b++) {
        const q = graph.getNodeAttributes(ids[b]);
        const other = layout.nodes.get(ids[b])!;
        expect(
          Math.abs(p.x - q.x) >= (size.width + other.width) / 2 ||
            Math.abs(p.y - q.y) >= (size.depth + other.depth) / 2,
        ).toBe(true);
      }
    }
    expect(layout.nodes.get("synthetic-18")!.height).toBeGreaterThan(
      layout.nodes.get("synthetic-0")!.height * 2,
    );
  });

  it("builds its central city skyline from real degree while preserving the global height ordering", () => {
    const graph = fixture(240);
    graph.forEachNode((id) => graph.setNodeAttribute(id, "community", 0));
    const layout = applySculptedLayout(graph, "city", { targetRadius: 100 });
    if (layout.kind !== "city") throw new Error("Expected city");
    const district = layout.districts[0];
    const sorted = graph
      .nodes()
      .sort(
        (a, b) =>
          graph.getNodeAttribute(a, "deg") - graph.getNodeAttribute(b, "deg"),
      );
    for (let i = 1; i < sorted.length; i++)
      expect(layout.nodes.get(sorted[i])!.height).toBeGreaterThanOrEqual(
        layout.nodes.get(sorted[i - 1])!.height,
      );
    const meanRadius = (ids: string[]): number =>
      ids.reduce((sum, id) => {
        const node = graph.getNodeAttributes(id);
        return (
          sum +
          Math.hypot(
            (node.x - district.x) / district.width,
            (node.y - district.y) / district.depth,
          )
        );
      }, 0) / ids.length;
    expect(meanRadius(sorted.slice(-24))).toBeLessThan(
      meanRadius(sorted.slice(0, 24)) / 2,
    );
  });

  it("rejects invalid dimensions and recognizes only supported layout kinds", () => {
    for (const targetRadius of [0, -1, NaN, Infinity])
      expect(() =>
        applySculptedLayout(fixture(1), "city", { targetRadius }),
      ).toThrow(RangeError);
    expect(KINDS.every(isSculptedLayout)).toBe(true);
    expect(isSculptedLayout("spiral")).toBe(false);
  });
});
