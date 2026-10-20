import { describe, expect, it } from "vitest";
import { buildWovenLayout, type WovenInput } from "./wovenLayout";

const input: WovenInput = {
  radius: 100,
  nodes: ["a", "b", "c", "d", "orphan"].map((id, index) => ({
    id,
    community: index < 2 ? 0 : 1,
    degree: index === 4 ? 0 : 2,
  })),
  edges: [
    { id: "ab", source: "a", target: "b" },
    { id: "ac", source: "a", target: "c" },
    { id: "bd", source: "b", target: "d" },
  ],
};

describe("woven topology", () => {
  it("keeps every note and exactly one strand per real edge, with exact endpoints", () => {
    const result = buildWovenLayout(input);
    expect([...result.nodes.keys()].sort()).toEqual(
      input.nodes.map((node) => node.id).sort(),
    );
    expect(result.routes.map((route) => route.id).sort()).toEqual([
      "ab",
      "ac",
      "bd",
    ]);
    for (const route of result.routes) {
      expect([...route.points].every(Number.isFinite)).toBe(true);
      for (const [id, offset] of [
        [route.source, 0],
        [route.target, route.points.length - 3],
      ] as const) {
        const point = result.positions.get(id)!;
        [point.x, point.y, point.z].forEach((value, axis) =>
          expect(route.points[offset + axis]).toBeCloseTo(value, 4),
        );
      }
      expect(route.source).not.toBe("orphan");
      expect(route.target).not.toBe("orphan");
    }
    expect(result.routes[1].points).not.toEqual(result.routes[2].points);
  });

  it("is stable under insertion-order changes and does not mutate its input", () => {
    const original = structuredClone(input);
    const first = buildWovenLayout(input);
    const second = buildWovenLayout({
      ...input,
      nodes: [...input.nodes].reverse(),
      edges: [...input.edges].reverse(),
    });
    expect(first).toEqual(second);
    expect(input).toEqual(original);
  });

  it("handles empty and disconnected graphs with finite framing", () => {
    for (const nodes of [[], input.nodes]) {
      const result = buildWovenLayout({ radius: 100, nodes, edges: [] });
      expect(result.routes).toHaveLength(0);
      expect(Object.values(result.bounds.min).every(Number.isFinite)).toBe(
        true,
      );
      expect(Object.values(result.bounds.max).every(Number.isFinite)).toBe(
        true,
      );
    }
  });

  // Two clumps of links, each coloured as three clusters, joined by a few
  // links, plus a pair of loose cliques the clumps never link to and notes
  // with no link at all.
  const clumps = (copies = 1): WovenInput => {
    const nodes: WovenInput["nodes"] = [];
    const edges: WovenInput["edges"] = [];
    for (let copy = 0; copy < copies; copy++) {
      const tag = copy ? `-${copy}` : "";
      const clump = (name: string, first: number) => {
        const ids = Array.from({ length: 12 }, (_, i) => `${name}${String(i).padStart(2, "0")}${tag}`);
        ids.forEach((id, i) => nodes.push({ id, community: copy * 8 + first + Math.floor(i / 4), degree: 11 }));
        ids.forEach((s, i) => ids.slice(i + 1).forEach((t) => edges.push({ id: `${s}-${t}`, source: s, target: t })));
        return ids;
      };
      const a = clump("a", 0);
      const b = clump("b", 3);
      for (let i = 0; i < 4; i++) edges.push({ id: `bridge${i}${tag}`, source: a[i * 3], target: b[i * 3 + 1] });
      for (const name of ["x", "y"]) {
        const ids = [0, 1, 2].map((i) => `${name}${i}${tag}`);
        ids.forEach((id) => nodes.push({ id, community: copy * 8 + (name === "x" ? 6 : 7), degree: 2 }));
        ids.forEach((s, i) => ids.slice(i + 1).forEach((t) => edges.push({ id: `${s}-${t}`, source: s, target: t })));
      }
      for (let i = 0; i < 3; i++) nodes.push({ id: `orphan${i}${tag}`, community: -1, degree: 0 });
    }
    return { radius: 1000, nodes, edges };
  };
  const at = (result: ReturnType<typeof buildWovenLayout>, id: string) => result.positions.get(id)!;
  const gap = (p: { x: number; y: number; z: number }, q: { x: number; y: number; z: number }) =>
    Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);

  // The notes draw at one world size whatever the vault (the shared size
  // chain, graph-visual-rules R6). Stretched to one radius at every size, a
  // 68-note vault drew them at a third of the other looks' size.
  it("keeps a small vault's notes as close together as a bigger vault's", () => {
    const spacing = (input: WovenInput): number => {
      const result = buildWovenLayout(input);
      const points = [...result.positions.values()];
      const nearest = points
        .map((p) => Math.min(...points.filter((q) => q !== p).map((q) => gap(p, q))))
        .sort((a, b) => a - b);
      return nearest[nearest.length >> 1];
    };
    expect(spacing(clumps())).toBeLessThan(spacing(clumps(4)) * 1.3);
  });

  // The camera frames the whole web, so a note's screen size goes as 1 / the
  // frame's size. At one scale a flat web's frame grows as √notes (four times
  // the notes: twice the frame), where the default look's frame hardly grows
  // below a few hundred notes, so a 250-note vault drew its notes at 0.6 of
  // the default look's.
  it("grows a small vault's frame slower than the vault, as a galaxy's frame grows", () => {
    // Half the height of a ≈ 1.6 : 1 frame around every note and strand.
    const frame = (copies: number) => {
      const { min, max } = buildWovenLayout(clumps(copies)).bounds;
      return Math.max((max.x - min.x) / 1.6, max.y - min.y) / 2;
    };
    expect(frame(4) / frame(1)).toBeLessThan(1.4);
  });

  // The landing frame is wider than tall (≈ 1.6 : 1); a web that settled
  // round or upright was framed by its height, with empty bands either side.
  it("lays the web wider than tall, as the frame is", () => {
    for (const copies of [1, 2, 4, 8]) {
      const points = [...buildWovenLayout(clumps(copies)).positions.values()];
      const span = (axis: "x" | "y") =>
        Math.max(...points.map((p) => p[axis])) - Math.min(...points.map((p) => p[axis]));
      expect(span("x")).toBeGreaterThan(span("y") * 1.1);
    }
  });

  // Past the size the 2,000-note bundles were tuned at, the frame holds: a
  // bigger vault packs its fans closer instead of pulling the camera back.
  it("holds a big vault at one frame", () => {
    const frame = (copies: number) => {
      const points = [...buildWovenLayout(clumps(copies)).positions.values()];
      const span = (axis: "x" | "y") =>
        Math.max(...points.map((p) => p[axis])) - Math.min(...points.map((p) => p[axis]));
      return Math.max(span("x") / 1.6, span("y")) / 2;
    };
    expect(frame(60)).toBeCloseTo(frame(30), 0);
  });

  it("sets linked fans side by side instead of a fixed corridor apart", () => {
    // A fixed corridor length and fixed gaps left a small vault's fans as
    // specks at the ends of long empty strands.
    const result = buildWovenLayout(clumps());
    const ids = [...result.positions.keys()];
    const a = ids.filter((id) => id.startsWith("a"));
    const b = ids.filter((id) => id.startsWith("b"));
    const middle = a.reduce(
      (sum, id) => ({ x: sum.x + at(result, id).x / a.length, y: sum.y + at(result, id).y / a.length, z: 0 }),
      { x: 0, y: 0, z: 0 },
    );
    const reach = Math.max(...a.map((id) => gap(at(result, id), middle)));
    const between = Math.min(...a.flatMap((u) => b.map((v) => gap(at(result, u), at(result, v)))));
    expect(between).toBeLessThan(reach * 1.5);
  });

  it("gathers every link between two clumps into one corridor across their colours", () => {
    const result = buildWovenLayout(clumps());
    // The four bridges start and end in four different colour pairs; they
    // must still run as one bundle, so their middles sit together.
    const middles = result.routes
      .filter((route) => route.id.startsWith("bridge"))
      .map((route) => {
        const at = (route.points.length / 3 - 1) / 2;
        return [route.points[at * 3], route.points[at * 3 + 1], route.points[at * 3 + 2]];
      });
    expect(middles).toHaveLength(4);
    const spread = Math.max(...middles.flatMap((p) => middles.map((q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]))));
    expect(spread).toBeLessThan(result.radius * 0.03);
  });

  it("keeps the parts no corridor reaches from setting the frame", () => {
    const result = buildWovenLayout(clumps());
    // The loose cliques and the unlinked notes sit at the web's rim, not
    // flung out to a corner where the frame would have to reach for them.
    const web = [...result.positions].filter(([id]) => /^[ab]\d/.test(id)).map(([, p]) => p);
    const middle = web.reduce((sum, p) => ({ x: sum.x + p.x / web.length, y: sum.y + p.y / web.length }), { x: 0, y: 0 });
    const reach = (points: { x: number; y: number }[]) =>
      Math.max(...points.map((p) => Math.hypot(p.x - middle.x, p.y - middle.y)));
    expect(reach([...result.positions.values()])).toBeLessThan(reach(web) * 1.4);
  });

  it("fans each note out with the community that colours it", () => {
    // One clique: a link-only grouping would make it a single fan. The graph
    // colours it as two clusters, and the legend, cluster names and focus
    // frames all work in those, so the strands must gather by them too.
    const ids = ["a", "b", "c", "d", "e", "f"];
    const result = buildWovenLayout({
      radius: 100,
      nodes: ids.map((id, index) => ({ id, community: index < 3 ? 0 : 1, degree: 5 })),
      edges: ids.flatMap((s, i) => ids.slice(i + 1).map((t) => ({ id: s + t, source: s, target: t }))),
    });
    const at = (id: string) => result.positions.get(id)!;
    const gap = (u: string, v: string) => Math.hypot(at(u).x - at(v).x, at(u).y - at(v).y, at(u).z - at(v).z);
    const pairs = ids.flatMap((u, i) => ids.slice(i + 1).map((v) => [u, v] as const));
    const same = pairs.filter(([u, v]) => (u < "d") === (v < "d")).map(([u, v]) => gap(u, v));
    const across = pairs.filter(([u, v]) => (u < "d") !== (v < "d")).map(([u, v]) => gap(u, v));
    expect(Math.max(...same)).toBeLessThan(Math.min(...across));
  });
});
