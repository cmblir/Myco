import Graph from "graphology";
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import type { VaultGraph } from "./graphData";
import { DEFAULT_GRAPH_SETTINGS, VIBE_PRESETS } from "./graphSettings";
import { buildWovenLayout, wovenInput } from "./wovenLayout";
import { GraphScene } from "./graphScene";
import { WovenGraphLayer } from "./wovenGraphLayer";

describe("woven interaction geometry", () => {
  it("highlights only incident edges, hides filtered edges and follows dragged endpoints", () => {
    const graph = new Graph({ type: "undirected" }) as VaultGraph;
    for (let i = 0; i < 4; i++)
      graph.addNode(String(i), {
        label: `Synthetic ${i}`,
        x: 0,
        y: 0,
        z: 0,
        deg: 1,
        size: 1,
        color: "#bbbbdd",
        community: i % 2,
        galaxy: -1,
        isHub: false,
        intensity: 0.3,
      });
    graph.addEdgeWithKey("a", "0", "1", { color: "#bbbbdd", size: 1 });
    graph.addEdgeWithKey("b", "2", "3", { color: "#bbbbdd", size: 1 });
    const layout = buildWovenLayout(wovenInput(graph, 100));
    layout.positions.forEach((point, id) =>
      graph.mergeNodeAttributes(id, point),
    );
    const layer = new WovenGraphLayer(graph, layout);
    const attributes = new THREE.BufferGeometry();
    attributes.setAttribute(
      "a_color",
      new THREE.Float32BufferAttribute(new Array(12).fill(1), 3),
    );
    for (const name of ["a_alpha", "a_size", "a_hit"])
      attributes.setAttribute(
        name,
        new THREE.Float32BufferAttribute([1, 1, 1, 1], 1),
      );
    const settings = { ...DEFAULT_GRAPH_SETTINGS, ...VIBE_PRESETS.ribbon };
    // The scene's hover state on note 0 (neighbours include the note itself).
    const hover = {
      hoveredNode: "0",
      neighbors: new Set(["0", "1"]),
      focus: null,
      pathNodes: null,
    };
    layer.sync(attributes, settings, hover);
    const lines = layer.group.getObjectByName(
      "woven-relationships",
    ) as THREE.LineSegments;
    const ink = lines.geometry.getAttribute("color");
    const position = lines.geometry.getAttribute("position");
    const selectedRoute = layout.routes.findIndex((route) => route.id === "a");
    const otherRoute = layout.routes.findIndex((route) => route.id === "b");
    expect(ink.getW(selectedRoute * 64)).toBeGreaterThan(
      ink.getW(otherRoute * 64) * 10,
    );
    // A held focus frame on 0's neighbourhood sinks the strands leaving it.
    layer.sync(attributes, settings, { ...hover, hoveredNode: null, focus: hover.neighbors });
    expect(ink.getW(selectedRoute * 64)).toBeGreaterThan(
      ink.getW(otherRoute * 64) * 5,
    );
    graph.setNodeAttribute("0", "x", 70);
    layer.sync(attributes, settings, hover);
    expect(position.getX(selectedRoute * 64)).toBeCloseTo(70);
    attributes.getAttribute("a_alpha").setX(1, 0);
    layer.sync(attributes, settings);
    expect(ink.getW(selectedRoute * 64)).toBe(0);
    expect(ink.getW(otherRoute * 64)).toBeGreaterThan(0);
    const camera = new THREE.PerspectiveCamera(58, 1.5, 0.5, 40000);
    camera.up.set(0, 0, 1);
    camera.position.set(0, -35, 200);
    const controls = {
      target: new THREE.Vector3(),
      maxDistance: 30000,
      update: () => {
        camera.lookAt(controls.target);
        camera.updateMatrixWorld();
      },
    };
    const scene = Object.create(GraphScene.prototype) as GraphScene;
    Object.assign(scene, {
      woven: layer,
      camera,
      controls,
      graph,
      selectedNode: "0",
      reducedMotion: true,
      nodeMat: { uniforms: { u_fogNear: { value: 0 }, u_fogFar: { value: 0 } } },
      scene: Object.assign(new THREE.Scene(), { fog: new THREE.FogExp2(0x000000) }),
      container: {
        clientWidth: 900,
        parentElement: {
          querySelector: () => ({
            getBoundingClientRect: () => ({ width: 300 }),
          }),
          querySelectorAll: () => [],
        },
      },
    });
    scene.fit();
    layer.forEachFramePoint((point) => {
      const projected = point.clone().project(camera);
      expect(projected.x).toBeGreaterThan(-1);
      expect(projected.x).toBeLessThan(1 - (2 * 324) / 900);
      expect(Math.abs(projected.y)).toBeLessThan(1);
    });
    layer.dispose();
    attributes.dispose();
  });

  it("frames the web between the folded rails' tabs", () => {
    // Laid wide, the web reaches the canvas sides, where the rail tabs sit
    // over it: a rim cluster's name slid under one.
    const graph = new Graph({ type: "undirected" }) as VaultGraph;
    for (let i = 0; i < 12; i++)
      graph.addNode(String(i), {
        label: `Synthetic ${i}`, x: 0, y: 0, z: 0, deg: 2, size: 1,
        color: "#7baae0", community: i % 3, galaxy: -1, isHub: false, intensity: 0.3,
      });
    for (let i = 0; i < 12; i++) graph.addEdgeWithKey(`e${i}`, String(i), String((i + 1) % 12), { color: "#7baae0", size: 1 });
    const layout = buildWovenLayout(wovenInput(graph, 1600));
    layout.positions.forEach((point, id) => graph.mergeNodeAttributes(id, point));
    const layer = new WovenGraphLayer(graph, layout);
    const attributes = new THREE.BufferGeometry();
    attributes.setAttribute("a_alpha", new THREE.Float32BufferAttribute(new Array(12).fill(1), 1));
    layer.sync(attributes, { ...DEFAULT_GRAPH_SETTINGS, ...VIBE_PRESETS.ribbon });
    const camera = new THREE.PerspectiveCamera(58, 1, 0.5, 40000);
    camera.up.set(0, 0, 1);
    camera.position.set(0, -560, 1600);
    const controls = {
      target: new THREE.Vector3(),
      maxDistance: 30000,
      update: () => {
        camera.lookAt(controls.target);
        camera.updateMatrixWorld();
      },
    };
    // A 900 px canvas with two 60 px tabs on its left side and one 30 px on its right.
    const tab = (left: number, right: number) => ({ getBoundingClientRect: () => ({ left, right }) });
    const scene = Object.create(GraphScene.prototype) as GraphScene;
    Object.assign(scene, {
      woven: layer, camera, controls, graph, reducedMotion: true,
      nodeMat: { uniforms: { u_fogNear: { value: 0 }, u_fogFar: { value: 0 } } },
      scene: Object.assign(new THREE.Scene(), { fog: new THREE.FogExp2(0x000000) }),
      container: {
        clientWidth: 900,
        getBoundingClientRect: () => ({ left: 100, right: 1000 }),
        parentElement: { querySelectorAll: () => [tab(100, 160), tab(100, 160), tab(970, 1000)] },
      },
    });
    scene.fit();
    let [low, high] = [Infinity, -Infinity];
    layer.forEachFramePoint((point) => {
      const x = point.clone().project(camera).x;
      [low, high] = [Math.min(low, x), Math.max(high, x)];
    });
    const [from, to] = [-1 + (2 * 60) / 900, 1 - (2 * 30) / 900];
    expect(low).toBeGreaterThan(from);
    expect(high).toBeLessThan(to);
    // Centred in the band between them and framed to it, not shrunk inside it.
    expect((low + high) / 2).toBeCloseTo((from + to) / 2, 1);
    expect(high - low).toBeGreaterThan((to - from) * 0.7);
    layer.dispose();
    attributes.dispose();
  });

  it("re-derives the fog from the distance it frames, like every other look's fit", () => {
    const graph = new Graph({ type: "undirected" }) as VaultGraph;
    for (let i = 0; i < 12; i++)
      graph.addNode(String(i), {
        label: `Synthetic ${i}`, x: 0, y: 0, z: 0, deg: 2, size: 1,
        color: "#7baae0", community: i % 3, galaxy: -1, isHub: false, intensity: 0.3,
      });
    for (let i = 0; i < 12; i++) graph.addEdgeWithKey(`e${i}`, String(i), String((i + 1) % 12), { color: "#7baae0", size: 1 });
    const layout = buildWovenLayout(wovenInput(graph, 1600));
    layout.positions.forEach((point, id) => graph.mergeNodeAttributes(id, point));
    const layer = new WovenGraphLayer(graph, layout);
    const attributes = new THREE.BufferGeometry();
    attributes.setAttribute("a_alpha", new THREE.Float32BufferAttribute(new Array(12).fill(1), 1));
    layer.sync(attributes, { ...DEFAULT_GRAPH_SETTINGS, ...VIBE_PRESETS.ribbon });
    const camera = new THREE.PerspectiveCamera(58, 1.5, 0.5, 40000);
    camera.up.set(0, 0, 1);
    camera.position.set(0, -560, 1600);
    const controls = {
      target: new THREE.Vector3(),
      maxDistance: 30000,
      update: () => {
        camera.lookAt(controls.target);
        camera.updateMatrixWorld();
      },
    };
    // The cues a galaxy fit left behind before the Woven layout arrived.
    const uniforms = { u_fogNear: { value: 20 }, u_fogFar: { value: 90 } };
    const fog = new THREE.FogExp2(0x000000, 0.55 / 50);
    const scene = Object.create(GraphScene.prototype) as GraphScene;
    Object.assign(scene, {
      woven: layer, camera, controls, graph, reducedMotion: true,
      nodeMat: { uniforms }, scene: Object.assign(new THREE.Scene(), { fog }),
      container: { clientWidth: 900, parentElement: null },
    });
    scene.fit();
    const framed = Reflect.get(scene, "framedDist") as number;
    expect(framed).toBeCloseTo(camera.position.distanceTo(controls.target), 3);
    expect(fog.density * framed).toBeCloseTo(0.55, 5);
    expect(uniforms.u_fogFar.value).toBeGreaterThan(framed);
    // NODE_VERT's depth fade: every note sits clear of the 0.18 floor.
    for (const id of graph.nodes()) {
      const a = graph.getNodeAttributes(id);
      const dist = camera.position.distanceTo(new THREE.Vector3(a.x, a.y, a.z));
      const near = uniforms.u_fogNear.value, far = uniforms.u_fogFar.value;
      expect(Math.min(1, (far - dist) / Math.max(1, far - near))).toBeGreaterThan(0.25);
    }
    layer.dispose();
    attributes.dispose();
  });

  it("lights a vault's resting strands by how many it has, so few still read and many stay under the notes", () => {
    const graph = new Graph({ type: "undirected" }) as VaultGraph;
    for (const [id, x] of [["0", -50], ["1", 50]] as const)
      graph.addNode(id, {
        label: id, x, y: 0, z: 0, deg: 1, size: 1,
        color: "#7baae0", community: 0, galaxy: -1, isHub: false, intensity: 0.3,
      });
    const attributes = new THREE.BufferGeometry();
    attributes.setAttribute("a_alpha", new THREE.Float32BufferAttribute([1, 1], 1));
    const settings = { ...DEFAULT_GRAPH_SETTINGS, ...VIBE_PRESETS.ribbon };
    const hover = { hoveredNode: "0", neighbors: new Set(["0", "1"]), focus: null, pathNodes: null };
    // A corridor of `strands` parallel strands; the light at one's middle
    // as drawn (additive): its vertex light times the material's colour and
    // opacity.
    const middle = (strands: number, state?: typeof hover, linkThickness = settings.linkThickness) => {
      const layer = new WovenGraphLayer(graph, {
        kind: "woven", radius: 100, nodes: new Map(),
        positions: new Map([["0", { x: -50, y: 0, z: 0 }], ["1", { x: 50, y: 0, z: 0 }]]),
        bounds: { min: { x: -50, y: -1, z: -1 }, max: { x: 50, y: 1, z: 1 } },
        routes: Array.from({ length: strands }, (_, i) => ({
          id: `e${i}`, source: "0", target: "1", points: new Float32Array([-50, 0, 0, 0, 10, 0, 50, 0, 0]),
        })),
      });
      layer.sync(attributes, { ...settings, linkThickness }, state);
      const lines = layer.group.getObjectByName("woven-relationships") as THREE.LineSegments;
      const material = lines.material as THREE.LineBasicMaterial;
      const light = lines.geometry.getAttribute("color").getW(1) * material.color.r * material.opacity;
      layer.dispose();
      return light;
    };
    // At 900 strands every link keeps the shared link light; past it a
    // corridor that stacks them all would sum to white over its notes. A
    // small vault's few 1 px strands, at that light, all but vanished, so
    // below 900 each lights brighter by the same law, up to three times.
    expect(middle(3600)).toBeCloseTo(middle(900) / 2, 6);
    expect(middle(100)).toBeCloseTo(middle(900) * 3, 6);
    expect(middle(10)).toBeCloseTo(middle(100), 6);
    // A hovered note's strands light fully however crowded the vault, and
    // lift as far above their own rest in a sparse vault as in any look.
    expect(middle(3600, hover)).toBeCloseTo(middle(900, hover), 6);
    for (const strands of [10, 900, 3600]) expect(middle(strands, hover)).toBeGreaterThan(middle(strands) * 4);
    // The lift must leave the Link thickness slider its range: as the
    // material's opacity it filled it at the old preset (0.55), so on the mock
    // vault's 99 strands the slider did nothing above it. Now it runs to the
    // slider's end (3), as the links' own opacity does.
    expect(middle(99, undefined, 1.5)).toBeCloseTo(middle(99, undefined, 1) * 1.5, 6);
    expect(middle(99, undefined, 3)).toBeCloseTo(middle(99, undefined, 1) * 3, 6);
    attributes.dispose();
  });

  it("lights its strands as the scene lights its links, on every ground", () => {
    const graph = new Graph({ type: "undirected" }) as VaultGraph;
    for (const [id, x, color] of [["0", -50, "#7baae0"], ["1", 50, "#e07ba0"]] as const)
      graph.addNode(id, {
        label: id, x, y: 0, z: 0, deg: 1, size: 1,
        color, community: 0, galaxy: -1, isHub: false, intensity: 0.3,
      });
    const attributes = new THREE.BufferGeometry();
    attributes.setAttribute("a_alpha", new THREE.Float32BufferAttribute([1, 1], 1));
    const layer = new WovenGraphLayer(graph, {
      kind: "woven", radius: 100, nodes: new Map(),
      positions: new Map([["0", { x: -50, y: 0, z: 0 }], ["1", { x: 50, y: 0, z: 0 }]]),
      bounds: { min: { x: -50, y: -1, z: -1 }, max: { x: 50, y: 1, z: 1 } },
      routes: [{ id: "e", source: "0", target: "1", points: new Float32Array([-50, 0, 0, 0, 40, 0, 50, 0, 0]) }],
    });
    const lines = layer.group.getObjectByName("woven-relationships") as THREE.LineSegments;
    const material = lines.material as THREE.LineBasicMaterial;
    const ink = lines.geometry.getAttribute("color");
    const settings = { ...DEFAULT_GRAPH_SETTINGS, ...VIBE_PRESETS.ribbon };
    const end = () => new THREE.Color(ink.getX(0), ink.getY(0), ink.getZ(0));
    const note = new THREE.Color("#7baae0");
    const neutral = new THREE.Color("#8b93a8");
    const scene = { neutral, greyMix: 0.5, base: 0.22, opacity: 0.2, additive: true, saturate: 1 };
    layer.setInk(scene);
    layer.sync(attributes, settings);
    expect(end().getHex()).toBe(note.clone().lerp(neutral, 0.5).getHex());
    // Link colour: community webs keeps the hue (the scene's 0.12 pull).
    layer.setInk({ ...scene, greyMix: 0.12 });
    layer.sync(attributes, settings);
    expect(end().getHex()).toBe(note.clone().lerp(neutral, 0.12).getHex());
    // Sigma: ink, not light, and the hue pushed away from grey.
    layer.setInk({ ...scene, greyMix: 0.05, additive: false, saturate: 1.5 });
    layer.sync(attributes, settings);
    expect(material.blending).toBe(THREE.NormalBlending);
    expect(end().getHSL({ h: 0, s: 0, l: 0 }).s).toBeGreaterThan(note.clone().lerp(neutral, 0.05).getHSL({ h: 0, s: 0, l: 0 }).s);
    // On paper the sparse lift stacks the ink, so the slider keeps the links'
    // range: it rises all the way to where theirs fills (0.42 x 2.38 = 1).
    const paper = (linkThickness: number) => {
      layer.setInk({ ...scene, opacity: 0.42, additive: false });
      layer.sync(attributes, { ...settings, linkThickness });
      return material.opacity;
    };
    expect(paper(1)).toBeLessThan(paper(2));
    expect(paper(2)).toBeLessThan(1);
    expect(paper(1 / 0.42)).toBeCloseTo(1, 6);
    layer.dispose();
  });

  it("places a point along the strand as drawn, from either end", () => {
    const graph = new Graph({ type: "undirected" }) as VaultGraph;
    for (const [id, x] of [["0", -50], ["1", 50]] as const)
      graph.addNode(id, {
        label: id, x, y: 0, z: 0, deg: 1, size: 1,
        color: "#7baae0", community: 0, galaxy: -1, isHub: false, intensity: 0.3,
      });
    const attributes = new THREE.BufferGeometry();
    attributes.setAttribute("a_alpha", new THREE.Float32BufferAttribute([1, 1], 1));
    const layer = new WovenGraphLayer(graph, {
      kind: "woven", radius: 100, nodes: new Map(),
      positions: new Map([["0", { x: -50, y: 0, z: 0 }], ["1", { x: 50, y: 0, z: 0 }]]),
      bounds: { min: { x: -50, y: -1, z: -1 }, max: { x: 50, y: 41, z: 1 } },
      routes: [{ id: "e", source: "0", target: "1", points: new Float32Array([-50, 0, 0, 0, 40, 0, 50, 0, 0]) }],
    });
    layer.sync(attributes, { ...DEFAULT_GRAPH_SETTINGS, ...VIBE_PRESETS.ribbon });
    const at = new THREE.Vector3();
    expect(layer.pointAlong("0", "1", 0.5, at)).toBe(true);
    expect(at.toArray()).toEqual([0, 40, 0]);
    layer.pointAlong("1", "0", 0.25, at);
    expect(at.toArray()).toEqual([25, 20, 0]);
    expect(layer.pointAlong("0", "2", 0.5, at)).toBe(false);
    layer.dispose();
  });

  it("draws its strands inside the shared scene in place of the straight links", () => {
    const graph = new Graph({ type: "undirected" }) as VaultGraph;
    for (let i = 0; i < 3; i++)
      graph.addNode(String(i), {
        label: `Synthetic ${i}`, x: 0, y: 0, z: 0, deg: 1, size: 1,
        color: "#7baae0", community: 0, galaxy: -1, isHub: false, intensity: 0.3,
      });
    graph.addEdgeWithKey("a", "0", "1", { color: "#7baae0", size: 1 });
    graph.addEdgeWithKey("b", "1", "2", { color: "#7baae0", size: 1 });
    const layout = buildWovenLayout(wovenInput(graph, 100));
    layout.positions.forEach((point, id) => graph.mergeNodeAttributes(id, point));
    const attributes = new THREE.BufferGeometry();
    attributes.setAttribute("a_alpha", new THREE.Float32BufferAttribute([1, 1, 1], 1));
    const settings = { ...DEFAULT_GRAPH_SETTINGS, ...VIBE_PRESETS.ribbon };
    const clusterLabels = { setEnabled: vi.fn(), update: vi.fn() };
    const scene = Object.create(GraphScene.prototype) as GraphScene;
    const state = {
      graph, settings, darkTheme: true, nodeGeom: attributes,
      style: { hoveredNode: null, neighbors: null, focus: null, pathNodes: null },
      scene: new THREE.Scene(), edges: { visible: true },
      pulse: { points: { visible: true }, along: null }, wave: { along: null }, synapse: { along: null }, tracePulse: { along: null },
      setMinimap: vi.fn(), clusterLabels, controls: { autoRotateSpeed: 0.12 },
      edgeNeutral: new THREE.Color("#8b93a8"), edgeOpacity: 0.2, edgeBaseBrightness: 0.22,
      edgeFlowUniforms: { u_flowTime: { value: 0 }, u_flowAmp: { value: 0.55 }, u_flowDark: { value: 1 } },
      camera: new THREE.PerspectiveCamera(58, 1.5, 0.5, 40000), woven: null as WovenGraphLayer | null,
    };
    Object.assign(scene, state);
    scene.setWovenLayout(layout);
    const woven = Reflect.get(scene, "woven") as WovenGraphLayer;
    expect(state.scene.children).toContain(woven.group);
    expect(woven.group.getObjectByName("woven-relationships")).toBeDefined();
    // The straight links go; their pulses stay and ride the strands, as do
    // the click wave, the idle firing and the trace comet.
    expect([state.edges.visible, state.pulse.points.visible]).toEqual([false, true]);
    for (const layer of [state.pulse, state.wave, state.synapse, state.tracePulse]) expect(layer.along).toBeTypeOf("function");
    expect(state.setMinimap).not.toHaveBeenCalled();
    // Cluster names, tone and exposure are the shared look's, not Woven's own.
    expect(clusterLabels.setEnabled).not.toHaveBeenCalled();
    expect(clusterLabels.update).toHaveBeenCalled();
    expect(Reflect.get(scene, "lookToneMapping").call(scene)).toBe(THREE.AgXToneMapping);
    expect(Reflect.get(scene, "lookExposure").call(scene)).toBe(settings.brightness);
    scene.setClusterLabelsVisible(true);
    expect(clusterLabels.setEnabled).toHaveBeenLastCalledWith(true);
    woven.dispose();
    expect(state.scene.children).not.toContain(woven.group);
  });

  it("lights hover and path filaments along the routed strand, not the chord", () => {
    const graph = new Graph({ type: "undirected" }) as VaultGraph;
    for (const [id, community] of [["0", 0], ["1", 1], ["2", 1]] as const)
      graph.addNode(id, {
        label: id, x: 0, y: 0, z: 0, deg: 1, size: 1,
        color: community ? "#e07ba0" : "#7baae0", community, galaxy: -1, isHub: false, intensity: 0.3,
      });
    graph.addEdgeWithKey("a", "0", "1", { color: "#7baae0", size: 1 });
    graph.addEdgeWithKey("b", "1", "2", { color: "#e07ba0", size: 1 });
    const layout = buildWovenLayout(wovenInput(graph, 100));
    layout.positions.forEach((point, id) => graph.mergeNodeAttributes(id, point));
    const layer = new WovenGraphLayer(graph, layout);
    const attributes = new THREE.BufferGeometry();
    attributes.setAttribute("a_alpha", new THREE.Float32BufferAttribute([1, 1, 1], 1));
    layer.sync(attributes, { ...DEFAULT_GRAPH_SETTINGS, ...VIBE_PRESETS.ribbon });
    const filamentGeom = { setPositions: vi.fn(), setColors: vi.fn(), instanceCount: 0 };
    const scene = Object.create(GraphScene.prototype) as GraphScene;
    Object.assign(scene, {
      graph, woven: layer, filaments: {}, filamentGeom, filamentCount: 1,
      edgePairs: [["1", "0"]], filamentEdges: new Int32Array([0]), filamentIsPath: new Uint8Array([0]),
    });
    Reflect.get(scene, "updateFilaments").call(scene);
    const positions = filamentGeom.setPositions.mock.calls[0][0] as Float32Array;
    const colors = filamentGeom.setColors.mock.calls[0][0] as Float32Array;
    const route = layout.routes.find((r) => r.id === "a")!;
    const segments = route.points.length / 3 - 1;
    expect(filamentGeom.instanceCount).toBe(segments);
    expect(positions).toHaveLength(segments * 6);
    // The pair is (1, 0); the route runs 0 → 1, so the first vertex sits on
    // note 0 and must carry 0's colour, the last sits on 1 and carries 1's.
    const first = graph.getNodeAttributes(route.source);
    const last = graph.getNodeAttributes(route.target);
    expect([positions[0], positions[1]]).toEqual([expect.closeTo(first.x, 3), expect.closeTo(first.y, 3)]);
    expect([positions.at(-3), positions.at(-2)]).toEqual([expect.closeTo(last.x, 3), expect.closeTo(last.y, 3)]);
    const ratio = (c: THREE.Color) => c.r / c.b;
    expect(colors[0] / colors[2]).toBeCloseTo(ratio(new THREE.Color(first.color)), 2);
    expect(colors.at(-3)! / colors.at(-1)!).toBeCloseTo(ratio(new THREE.Color(last.color)), 2);
    // And it bends away from the straight chord between them.
    const mid = (segments / 2) * 6;
    const point = new THREE.Vector3(positions[mid], positions[mid + 1], positions[mid + 2]);
    const chord = new THREE.Line3(new THREE.Vector3(first.x, first.y, first.z), new THREE.Vector3(last.x, last.y, last.z));
    expect(chord.closestPointToPoint(point, true, new THREE.Vector3()).distanceTo(point)).toBeGreaterThan(1);
    layer.dispose();
  });
});
