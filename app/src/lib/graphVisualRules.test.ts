// The code-checkable half of app/docs/design/graph-visual-rules.md. The other
// half is the screenshot checklist in that doc; together they are the bar a
// look clears before it ships. Rule ids (R1…) match the doc.
//
// Looks drawn by GraphScene need a WebGL context, so their palette, glow and
// line rules are held by the one shared code path they all run through (and
// by the screenshot set). A look that adds its own layer must prove here, on
// the same mock vault the screenshots use, that the layer keeps those rules:
// it leaves the notes to the shared sprites and draws its lines as the
// shared link light.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss from "postcss";
import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installTauriMock } from "./devMock";
import { buildGraph, type VaultGraph } from "./graphData";
import { DEFAULT_GRAPH_SETTINGS, VIBE_PRESETS, type GraphSettings } from "./graphSettings";
import { skinTheme } from "./graphSkins";
import type { Adjacency } from "./ipc";
import { ATLAS_RADIUS_MUL } from "./layoutConfig";
import { WovenGraphLayer } from "./wovenGraphLayer";
import { buildWovenLayout, wovenInput, type WovenLayout } from "./wovenLayout";

afterEach(() => vi.unstubAllGlobals());

/** R1: every shipped look's preset sits inside the envelope the shipped looks
 *  measure today (graphSettings VIBE_PRESETS, 2026-10-01). */
const ENVELOPE = {
  nodeSize: [0.55, 1],
  linkThickness: [0.35, 1.15],
  textFadeThreshold: [1.1, 2.4],
  brightness: [0.9, 1.05],
} as const;

function hsl(c: THREE.Color): { h: number; s: number } {
  const out = { h: 0, s: 0, l: 0 };
  c.getHSL(out);
  return { h: out.h * 360, s: out.s };
}
const hueGap = (a: number, b: number): number => {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
};

async function mockVaultGraph(settings: GraphSettings): Promise<VaultGraph> {
  vi.stubGlobal("window", {});
  vi.stubGlobal("location", { search: "?mock=1" });
  installTauriMock();
  const host = window as unknown as {
    __TAURI_INTERNALS__: { invoke: (command: string) => Promise<Adjacency> };
  };
  const adjacency = await host.__TAURI_INTERNALS__.invoke("build_link_graph");
  const theme = skinTheme(settings.skin === "auto" ? "black" : settings.skin);
  return buildGraph(adjacency, new Set(Object.keys(adjacency.tags)), {
    nodeSize: settings.nodeSize,
    starDim: theme.starDim,
    edgeColor: theme.edge,
    showGhosts: true,
  });
}

/** What GraphScene.writeNodes hands a layer when nothing is encoded. */
function nodeAttributes(graph: VaultGraph): THREE.BufferGeometry {
  const ids = graph.nodes();
  const geometry = new THREE.BufferGeometry();
  const color = new THREE.Color();
  const rgb = ids.flatMap((id) => color.set(graph.getNodeAttribute(id, "color")).toArray());
  geometry.setAttribute("a_color", new THREE.Float32BufferAttribute(rgb, 3));
  geometry.setAttribute("a_alpha", new THREE.Float32BufferAttribute(ids.map(() => 1), 1));
  geometry.setAttribute("a_size", new THREE.Float32BufferAttribute(ids.map((id) => graph.getNodeAttribute(id, "size")), 1));
  geometry.setAttribute("a_hit", new THREE.Float32BufferAttribute(ids.map(() => 0), 1));
  geometry.setAttribute("a_ring", new THREE.Float32BufferAttribute(ids.map(() => 0), 1));
  return geometry;
}

type MakeLayer = (graph: VaultGraph, layout: WovenLayout, dark: boolean) => WovenGraphLayer;

/** Run every layer rule against the woven look and name the ones it breaks,
 *  on a dark ground or a light one (its preset skin follows the app theme).
 *  `make` swaps in a deliberately broken layer to prove the probe catches it. */
async function wovenViolations(
  make: MakeLayer = (graph, layout, dark) => new WovenGraphLayer(graph, layout, dark),
  dark = true,
): Promise<string[]> {
  const settings: GraphSettings = { ...DEFAULT_GRAPH_SETTINGS, ...VIBE_PRESETS.ribbon };
  const graph = await mockVaultGraph(settings);
  const layout = buildWovenLayout(wovenInput(graph, settings.linkDistance * ATLAS_RADIUS_MUL));
  layout.positions.forEach((point, id) => graph.mergeNodeAttributes(id, point));
  const layer = make(graph, layout, dark);
  const attributes = nodeAttributes(graph);
  const ids = graph.nodes();
  const source = new THREE.Color();
  const drawn = new THREE.Color();
  const chromatic = (id: string): boolean => hsl(source.set(graph.getNodeAttribute(id, "color"))).s >= 0.25;
  const broken: string[] = [];
  try {
    layer.sync(attributes, settings);

    // R2, R6: the notes are GraphScene's shared sprites, the path every other
    // look's notes take. A layer that paints note marks of its own (mesh,
    // points, sprites, or lines other than its strands, such as frames around
    // the notes) re-decides their colour and size, so it breaks both.
    // R5: a layer that is (or holds) a Scene can paint a private ground.
    const lines = layer.group.getObjectByName("woven-relationships") as THREE.LineSegments;
    let marks = 0;
    let ownGround = false;
    layer.group.traverse((object) => {
      const drawable =
        object instanceof THREE.Mesh || object instanceof THREE.Points ||
        object instanceof THREE.Sprite || object instanceof THREE.Line;
      if (drawable && object !== lines) marks++;
      if (object instanceof THREE.Scene) ownGround = true;
    });
    if (marks > 0) broken.push("R2 note colour keeps its palette hue");

    const ink = lines.geometry.getAttribute("color");
    const light = (at: number): number =>
      (ink.itemSize === 4 ? ink.getW(at) : 1) * Math.max(ink.getX(at), ink.getY(at), ink.getZ(at));
    const inkAt = (at: number, into: THREE.Color): THREE.Color => into.setRGB(ink.getX(at), ink.getY(at), ink.getZ(at));
    const end0 = new THREE.Color();
    const end1 = new THREE.Color();
    // Each strand's ends sit in their notes' hue, and its body (the brightest
    // part, mid-strand) in the blend of its own two ends, not one flat ink.
    const strandEnds = (): { strands: number; off: number } => {
      let vertex = 0;
      let off = 0;
      let strands = 0;
      for (const route of layout.routes) {
        const steps = route.points.length / 3 - 1;
        const vertices = steps * 2;
        for (const [id, at] of [[route.source, vertex], [route.target, vertex + vertices - 1]] as const) {
          if (!chromatic(id)) continue;
          inkAt(at, drawn);
          const from = hsl(source.set(graph.getNodeAttribute(id, "color")));
          strands++;
          if (hueGap(from.h, hsl(drawn).h) > 30) off++;
        }
        // Vertex `steps` is the middle one; its share of the way along.
        const along = (Math.floor(steps / 2) + (steps % 2)) / steps;
        const want = inkAt(vertex, end0).lerp(inkAt(vertex + vertices - 1, end1), along);
        if (hsl(want).s >= 0.1 && hueGap(hsl(want).h, hsl(inkAt(vertex + steps, drawn)).h) > 30) off++;
        vertex += vertices;
      }
      return { strands, off };
    };
    const rest = strandEnds();
    if (rest.strands === 0 || rest.off > 0) broken.push("R3 strands take their endpoints' hue");

    if ((lines.material as THREE.Material).blending !== (dark ? THREE.AdditiveBlending : THREE.NormalBlending))
      broken.push("R4 strands are additive light on a dark ground, ink on a light one");

    if (ownGround) broken.push("R5 background comes from the skin");
    if (marks > 0) broken.push("R6 note size follows the shared size chain");

    // R7: hover a cool-hued note (so a warm state ink cannot pass by
    // coincidence), hold a focus on its neighbourhood, trace a path to a
    // neighbour. Each state is checked on its own, against the strand's own
    // light at rest (comparing different strands mixes in their colours'
    // max(rgb)); then all three together must keep every strand's hue.
    const cool = (id: string): boolean =>
      chromatic(id) && hueGap(hsl(source.set(graph.getNodeAttribute(id, "color"))).h, 45) > 60;
    const subject = ids.find((id) => cool(id) && graph.someNeighbor(id, cool))!;
    const neighbors = new Set([subject, ...graph.neighbors(subject)]);
    const hit = graph.findNeighbor(subject, cool)!;
    const middles = (): number[] => {
      let vertex = 0;
      return layout.routes.map((route) => {
        const vertices = (route.points.length / 3 - 1) * 2;
        vertex += vertices;
        return light(vertex - vertices / 2);
      });
    };
    const touches = (route: WovenLayout["routes"][number]) => route.source === subject || route.target === subject;
    const leaves = (route: WovenLayout["routes"][number]) => !neighbors.has(route.source) || !neighbors.has(route.target);
    const atRest = middles();
    const none = { hoveredNode: null, neighbors: null, focus: null, pathNodes: null };

    layer.sync(attributes, settings, { ...none, hoveredNode: subject, neighbors });
    const hovered = middles();
    const lit = Math.min(...layout.routes.map((route, i) => (touches(route) ? hovered[i] : Infinity)));
    const rested = Math.max(0, ...layout.routes.map((route, i) => (leaves(route) ? hovered[i] : 0)));
    const hoverLifts = lit > rested * 2;

    layer.sync(attributes, settings, { ...none, focus: neighbors });
    const framed = middles();
    const focusSinks = layout.routes.every((route, i) => !leaves(route) || framed[i] < atRest[i]);

    layer.sync(attributes, settings, { ...none, pathNodes: [subject, hit] });
    const traced = middles();
    const onPath = layout.routes.findIndex(
      (route) => (route.source === subject && route.target === hit) || (route.source === hit && route.target === subject),
    );
    const pathLifts = traced[onPath] > atRest[onPath];

    layer.sync(attributes, settings, {
      hoveredNode: subject,
      neighbors,
      focus: neighbors,
      pathNodes: [subject, hit],
    });
    const held = strandEnds();
    if (held.off > 0 || !hoverLifts || !focusSinks || !pathLifts)
      broken.push("R7 hover, focus and path keep the strand's hue and lift it");
  } finally {
    layer.dispose();
    attributes.dispose();
  }
  return broken;
}

describe("graph visual rules", () => {
  it("R1 every look's preset stays inside the shared envelope", () => {
    const outside = Object.entries(VIBE_PRESETS).flatMap(([key, preset]) =>
      (Object.keys(ENVELOPE) as (keyof typeof ENVELOPE)[])
        .filter((field) => preset[field] < ENVELOPE[field][0] || preset[field] > ENVELOPE[field][1])
        .map((field) => `${key}.${field}=${preset[field]}`),
    );
    expect(outside).toEqual([]);
  });

  it("R8 every note label shares one typography", () => {
    const root = postcss.parse(readFileSync(resolve(__dirname, "../styles.css"), "utf8"));
    const decls = (selector: string): Record<string, string> => {
      const out: Record<string, string> = {};
      root.walkRules((rule) => {
        if (rule.selector !== selector) return;
        rule.walkDecls((decl) => {
          out[decl.prop] = decl.value;
        });
      });
      return out;
    };
    const pick = (d: Record<string, string>) => ({
      family: d["font-family"],
      size: d["font-size"],
      weight: d["font-weight"],
      lineHeight: d["line-height"],
    });
    const note = { family: "var(--font-sans)", size: "11px", weight: "500", lineHeight: "1" };
    expect(pick(decls(".graph-label-3d"))).toEqual(note);
    expect(pick(decls(".myc-hub-label"))).toEqual(note);
    expect(pick(decls(".graph-cluster-label"))).toMatchObject({
      family: "var(--font-sans)",
      size: "var(--fs-12-5)",
      weight: "600",
    });
  });

  it.each([true, false])("R2-R7 a look with its own layer keeps the shared palette, lines, ground and sizes (dark ground: %s)", async (dark) => {
    expect(await wovenViolations(undefined, dark)).toEqual([]);
  });

  // Each break is a way Woven has actually drifted, or could: the probe must
  // name the rule it breaks.
  const strandsOf = (layer: WovenGraphLayer) =>
    layer.group.getObjectByName("woven-relationships") as THREE.LineSegments;
  it.each([
    {
      name: "note frames drawn as lines (pre-2026-10 Woven's amber cubes)",
      rules: ["R2", "R6"],
      make: ((graph, layout, dark) =>
        new (class extends WovenGraphLayer {
          constructor() {
            super(graph, layout, dark);
            const box = new THREE.EdgesGeometry(new THREE.BoxGeometry(8, 8, 8));
            const frames = new THREE.BufferGeometry();
            const corners = box.getAttribute("position").array as Float32Array;
            frames.setAttribute(
              "position",
              new THREE.Float32BufferAttribute(
                graph.nodes().flatMap((id) => {
                  const { x, y, z } = graph.getNodeAttributes(id);
                  return [...corners].map((v, i) => v + [x, y, z][i % 3]);
                }),
                3,
              ),
            );
            const marks = new THREE.LineSegments(frames, new THREE.LineBasicMaterial({ color: "#f5d69e" }));
            marks.name = "note-frames";
            this.group.add(marks);
          }
        })()) as MakeLayer,
    },
    {
      name: "hover and path ignored",
      rules: ["R7"],
      make: ((graph, layout, dark) =>
        new (class extends WovenGraphLayer {
          override sync(...[attributes, settings, state]: Parameters<WovenGraphLayer["sync"]>): void {
            super.sync(attributes, settings, state && { ...state, hoveredNode: null, neighbors: null, pathNodes: null });
          }
        })(graph, layout, dark)) as MakeLayer,
    },
    {
      name: "strand bodies in one flat ink",
      rules: ["R3"],
      make: ((graph, layout, dark) =>
        new (class extends WovenGraphLayer {
          override sync(...args: Parameters<WovenGraphLayer["sync"]>): void {
            super.sync(...args);
            const ink = strandsOf(this).geometry.getAttribute("color");
            let vertex = 0;
            for (const route of layout.routes) {
              const vertices = (route.points.length / 3 - 1) * 2;
              for (let at = vertex + 1; at < vertex + vertices - 1; at++) ink.setXYZ(at, 0.9, 0.85, 0.6);
              vertex += vertices;
            }
          }
        })(graph, layout, dark)) as MakeLayer,
    },
  ])("R2-R7 the layer probe fails a look with $name", async ({ make, rules }) => {
    const broken = (await wovenViolations(make)).map((rule) => rule.split(" ")[0]);
    expect(broken).toEqual(expect.arrayContaining(rules));
  });
});
