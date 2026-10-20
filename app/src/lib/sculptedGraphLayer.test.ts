import Graph from "graphology";
import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VaultGraph } from "./graphData";
import { GraphScene, type SceneStyleState } from "./graphScene";
import { DEFAULT_GRAPH_SETTINGS, VIBE_PRESETS } from "./graphSettings";
import { SculptedGraphLayer } from "./sculptedGraphLayer";
import { applySculptedLayout, type SculptedLayoutKind } from "./sculptedLayouts";

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach((dispose) => dispose()); });

function fixture(kind: SculptedLayoutKind, count = 4) {
  const graph = new Graph({ type: "undirected" }) as VaultGraph;
  for (let index = 0; index < count; index++) graph.addNode(`synthetic-${index}`, {
    label: `Synthetic note ${index}`, x: 0, y: 0, z: 0, deg: index + 1, size: 2,
    color: "#5385bb", community: index % 2, galaxy: -1, isHub: false,
    intensity: 0.3, sourceCount: index + 2, confidence: "high",
  });
  for (let index = 0; index < count - 1; index++) graph.addEdge(`synthetic-${index}`, `synthetic-${index + 1}`, {
    color: "#aaaabb", size: 0.7, ...(index === 2 ? { kind: "semantic" as const } : {}),
  });
  const layout = applySculptedLayout(graph, kind, { targetRadius: 100 });
  const attributes = new THREE.BufferGeometry();
  for (const name of ["position", "a_color"]) attributes.setAttribute(name, new THREE.Float32BufferAttribute(new Float32Array(graph.order * 3), 3));
  for (const name of ["a_size", "a_alpha", "a_hit", "a_intensity", "a_kind", "a_age", "a_ring", "a_sel"]) {
    attributes.setAttribute(name, new THREE.Float32BufferAttribute(new Float32Array(graph.order), 1));
  }
  const settings = { ...DEFAULT_GRAPH_SETTINGS, ...VIBE_PRESETS[kind], nodeSize: 1 };
  const layer = new SculptedGraphLayer(graph, layout);
  const style: SceneStyleState = {
    hoveredNode: null, neighbors: null, focus: null, pathNodes: null,
    tints: new Map(), pulseId: null, pulseScale: 1,
  };
  // Exercise the real attribute-writing and selection hooks without a WebGL context.
  // The legacy star-edge writer is unrelated to the solid layer under test.
  const scene = Object.create(GraphScene.prototype) as GraphScene;
  Object.assign(scene, {
    graph, nodeIds: graph.nodes(), idIndex: new Map(graph.nodes().map((id, index) => [id, index])),
    nodeGeom: attributes, settings, style, encoding: null, hoverPops: [],
    searchHits: null, selectedNode: null, sculpted: layer,
    writeEdges: vi.fn(), clusterLabels: { update: vi.fn() },
    nodeMat: { uniforms: { u_searchOn: { value: 0 } } },
  });
  scene.refreshStyle();
  const matrix = (index: number): THREE.Matrix4 => {
    const value = new THREE.Matrix4();
    layer.nodes.getMatrixAt(index, value);
    return value;
  };
  const color = (index: number): THREE.Color => {
    const value = new THREE.Color();
    layer.nodes.getColorAt(index, value);
    return value;
  };
  const outline = Reflect.get(layer, "outline") as THREE.LineSegments;
  const links = Reflect.get(layer, "links") as THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  cleanup.push(() => { layer.dispose(); attributes.dispose(); });
  return { graph, layout, attributes, settings, layer, scene, style, matrix, color, outline, links };
}

function cameraAt(point: THREE.Vector3, normal: THREE.Vector3): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 1000);
  camera.position.copy(point).addScaledVector(normal, 20);
  camera.lookAt(point);
  camera.updateMatrixWorld(true);
  return camera;
}

describe.each(["terrain", "ribbon", "city"] as SculptedLayoutKind[])("%s solid note layer", (kind) => {
  it("draws exactly the existing notes and links without changing note metadata or edge semantics", () => {
    const { graph, layer, scene, links } = fixture(kind);
    const original = graph.export();
    scene.setSelectedNode("synthetic-1");
    scene.setSearchHits(new Set(["synthetic-2"]));
    expect(layer.nodes.count).toBe(graph.order);
    expect(links.geometry.getAttribute("position").count).toBe(graph.size * 20);
    expect(graph.export()).toEqual(original);
  });

  it("hides and restores timelapse notes, their incident links and selection without leaving clickable ghosts", () => {
    const { graph, layout, layer, scene, matrix, outline, links } = fixture(kind);
    const id = "synthetic-1";
    const original = matrix(1);
    const position = new THREE.Vector3().setFromMatrixPosition(original);
    const normal = new THREE.Vector3().copy(layout.nodes.get(id)!.normal);
    const camera = cameraAt(position, normal);
    expect(layer.pick(new THREE.Vector2(), camera)).toBe(id);
    scene.setSelectedNode(id);
    expect(outline.visible).toBe(true);
    graph.setNodeAttribute(id, "hidden", true);
    scene.refreshStyle();
    expect(new THREE.Vector3().setFromMatrixScale(matrix(1)).length()).toBe(0);
    expect(outline.visible).toBe(false);
    expect(layer.pick(new THREE.Vector2(), camera)).not.toBe(id);
    const positions = links.geometry.getAttribute("position");
    expect([...positions.array].slice(0, 2 * 20 * 3).every((value) => value === 0)).toBe(true);
    expect([...positions.array].slice(2 * 20 * 3).some((value) => value !== 0)).toBe(true);
    graph.setNodeAttribute(id, "hidden", false);
    scene.refreshStyle();
    expect(matrix(1).elements).toEqual(original.elements);
    expect(outline.visible).toBe(true);
    expect(layer.pick(new THREE.Vector2(), camera)).toBe(id);
    scene.setSelectedNode(null);
    expect(outline.visible).toBe(false);
  });

  it("keeps focus dimming and search highlighting wired through the existing GraphScene hooks", () => {
    const { layer, scene, style, color } = fixture(kind);
    const background = layer.scene.background as THREE.Color;
    const original = color(1);
    const distance = (value: THREE.Color): number => Math.hypot(value.r - background.r, value.g - background.g, value.b - background.b);
    scene.setStyleState({ ...style, focus: new Set(["synthetic-0"]) });
    expect(distance(color(1))).toBeLessThan(distance(original) * 0.5);
    scene.setStyleState(style);
    expect(color(1)).toEqual(original);
    scene.setSearchHits(new Set(["synthetic-1"]));
    expect(color(1)).not.toEqual(original);
    scene.setSearchHits(null);
    expect(color(1)).toEqual(original);
  });

  it("keeps dense links translucent and reveals only the selected note's actual connections", () => {
    const { graph, layer, attributes, settings, scene, links } = fixture(kind, 512);
    const sparse = fixture(kind);
    const colors = links.geometry.getAttribute("color");
    expect(colors.itemSize).toBe(4);
    const quietAlpha = colors.getW(0);
    expect(quietAlpha).toBeGreaterThan(0);
    expect(quietAlpha).toBeLessThan(sparse.links.geometry.getAttribute("color").getW(0) * 0.4);
    scene.setSelectedNode("synthetic-0");
    expect(colors.getW(0)).toBeGreaterThan(quietAlpha * 5);
    expect(colors.getW(40)).toBeLessThan(quietAlpha);
    expect(links.geometry.getAttribute("position").count).toBe(graph.size * 20);
    layer.sync(attributes, { ...settings, linkThickness: 0 }, "synthetic-0");
    expect(links.material.opacity).toBe(0);
    layer.sync(attributes, { ...settings, linkThickness: 1 }, "synthetic-0");
    const mediumVisibility = links.material.opacity;
    layer.sync(attributes, { ...settings, linkThickness: 3 }, "synthetic-0");
    expect(links.material.opacity).toBeGreaterThan(mediumVisibility);
    scene.setSelectedNode(null);
    expect(colors.getW(0)).toBeCloseTo(quietAlpha);
    expect(colors.getW(40)).toBeCloseTo(quietAlpha);
  });

  it("keeps selected relationships readable across surfaces without exposing hidden endpoints", () => {
    const { graph, layer, scene, settings, attributes } = fixture(kind);
    scene.setSelectedNode("synthetic-1");
    const focus = layer.scene.getObjectByName("selected-relationships") as THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
    expect(focus).toBeDefined();
    expect(focus.material.depthTest).toBe(false);
    expect(focus.geometry.drawRange.count).toBe(40);
    graph.setNodeAttribute("synthetic-0", "hidden", true);
    scene.refreshStyle();
    expect(focus.geometry.drawRange.count).toBe(20);
    layer.sync(attributes, { ...settings, linkThickness: 0 }, "synthetic-1");
    expect(focus.material.opacity).toBe(0);
    scene.setSelectedNode(null);
    expect(focus.geometry.drawRange.count).toBe(0);
  });

  it("keeps ordinary relationships visible at dense vault sizes", () => {
    const { links } = fixture(kind, 2500);
    expect(links.geometry.getAttribute("color").getW(0)).toBeGreaterThan(0.04);
  });

  it("makes incident links transparent when either endpoint is hidden", () => {
    const { graph, scene, links } = fixture(kind);
    graph.setNodeAttribute("synthetic-1", "hidden", true);
    scene.setSelectedNode("synthetic-1");
    scene.refreshStyle();
    const colors = links.geometry.getAttribute("color");
    expect(colors.itemSize).toBe(4);
    expect(colors.getW(0)).toBe(0);
    expect(colors.getW(20)).toBe(0);
    expect(colors.getW(40)).toBeGreaterThan(0);
  });

  it("reuses link positions for style changes and rebuilds them when an endpoint moves or grows", () => {
    const { graph, layer, attributes, settings, scene, links } = fixture(kind);
    const positions = links.geometry.getAttribute("position") as THREE.BufferAttribute;
    const original = [...positions.array];
    const version = positions.version;
    scene.setSelectedNode("synthetic-1");
    scene.setSearchHits(new Set(["synthetic-2"]));
    scene.refreshStyle();
    expect(positions.version).toBe(version);
    expect([...positions.array]).toEqual(original);

    graph.setNodeAttribute("synthetic-0", "x", graph.getNodeAttribute("synthetic-0", "x") + 5);
    scene.refreshStyle();
    expect(positions.version).toBeGreaterThan(version);
    const moved = [...positions.array];
    expect(moved.slice(0, 60)).not.toEqual(original.slice(0, 60));
    expect(moved.slice(60)).toEqual(original.slice(60));
    layer.sync(attributes, { ...settings, nodeSize: 2 }, null);
    expect([...positions.array]).not.toEqual(moved);
  });

  it("updates the solid size and hit area while keeping city buildings grounded", () => {
    const { graph, layout, layer, attributes, settings, matrix } = fixture(kind);
    const id = "synthetic-1";
    const shape = layout.nodes.get(id)!;
    const before = matrix(1);
    const scale = new THREE.Vector3().setFromMatrixScale(before);
    const position = new THREE.Vector3().setFromMatrixPosition(before);
    const rotation = new THREE.Quaternion().setFromRotationMatrix(before.clone().scale(new THREE.Vector3(1 / scale.x, 1 / scale.y, 1 / scale.z)));
    const normal = new THREE.Vector3().copy(shape.normal);
    const camera = cameraAt(position, normal);
    // A distant camera tests the footprint rather than the perspective expansion
    // of a tall building's front face near the lens.
    camera.position.copy(position).addScaledVector(normal, 200);
    camera.updateMatrixWorld(true);
    // Outside the original half-width (0.5), inside the capped city half-width (0.7).
    const edge = new THREE.Vector3(shape.width * 0.62, 0, 0).applyQuaternion(rotation).add(position).project(camera);
    const ndc = new THREE.Vector2(edge.x, edge.y);
    expect(layer.pick(ndc, camera)).not.toBe(id);
    const original = graph.export();
    layer.sync(attributes, { ...settings, nodeSize: 2 }, null);
    const after = matrix(1);
    const grown = new THREE.Vector3().setFromMatrixScale(after);
    const footprintRatio = kind === "city" ? 1.4 : 2;
    expect(grown.x).toBeCloseTo(scale.x * footprintRatio);
    expect(grown.y).toBeCloseTo(scale.y * footprintRatio);
    expect(grown.z).toBeCloseTo(scale.z * 2);
    if (kind === "city") expect(new THREE.Vector3().setFromMatrixPosition(after).z - grown.z / 2).toBeCloseTo(0);
    expect(layer.pick(ndc, camera)).toBe(id);
    expect(graph.export()).toEqual(original);
  });

  it("does not pick a note through its opaque terrain, ribbon or district floor", () => {
    const { layout, layer, matrix } = fixture(kind);
    const position = new THREE.Vector3().setFromMatrixPosition(matrix(1));
    const normal = new THREE.Vector3().copy(layout.nodes.get("synthetic-1")!.normal).negate();
    expect(layer.pick(new THREE.Vector2(), cameraAt(position, normal))).not.toBe("synthetic-1");
  });

  it("preserves shortest-path emphasis through selection and removes hidden or nonexistent path edges", () => {
    const { graph, layer, scene, style } = fixture(kind);
    const pathGeometry = Reflect.get(layer, "pathGeometry") as THREE.BufferGeometry;
    scene.setStyleState({ ...style, pathNodes: ["synthetic-0", "synthetic-1", "synthetic-2"] });
    expect(pathGeometry.drawRange.count).toBe(40);
    const highlighted = [...pathGeometry.getAttribute("position").array].slice(0, 120);
    scene.setSelectedNode("synthetic-2");
    expect(pathGeometry.drawRange.count).toBe(40);
    expect([...pathGeometry.getAttribute("position").array].slice(0, 120)).toEqual(highlighted);
    graph.setNodeAttribute("synthetic-1", "hidden", true);
    scene.refreshStyle();
    expect(pathGeometry.drawRange.count).toBe(0);
    graph.setNodeAttribute("synthetic-1", "hidden", false);
    scene.refreshStyle();
    expect(pathGeometry.drawRange.count).toBe(40);
    scene.setStyleState({ ...style, pathNodes: ["synthetic-0", "synthetic-3"] });
    expect(pathGeometry.drawRange.count).toBe(0);
    scene.setStyleState(style);
    expect(pathGeometry.drawRange.count).toBe(0);
  });
});

it("keeps city lots separate at maximum note size while preserving building heights and graph data", () => {
  const { graph, layout, layer, attributes, settings, matrix } = fixture("city", 108);
  const original = graph.export();
  const sizes = attributes.getAttribute("a_size");
  // Exercise both the largest size slider value and the maximum encoded size boost.
  graph.forEachNode((id, node) => sizes.setX(Number(id.slice("synthetic-".length)), node.size * 2.2));
  layer.sync(attributes, { ...settings, nodeSize: 3 }, null);

  const unitBox = new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5));
  const boxes = graph.nodes().map((id, index) => {
    const box = unitBox.clone().applyMatrix4(matrix(index));
    const shape = layout.nodes.get(id)!;
    const size = box.getSize(new THREE.Vector3());
    expect(size.x).toBeCloseTo(shape.width * 1.4);
    expect(size.y).toBeCloseTo(shape.depth * 1.4);
    expect(size.z).toBeCloseTo(shape.height * 6.6);
    expect(box.min.z).toBeCloseTo(0);
    return box;
  });
  for (let index = 0; index < boxes.length; index++) {
    for (let other = index + 1; other < boxes.length; other++) {
      const first = boxes[index];
      const second = boxes[other];
      const overlapX = Math.min(first.max.x, second.max.x) - Math.max(first.min.x, second.min.x);
      const overlapY = Math.min(first.max.y, second.max.y) - Math.max(first.min.y, second.min.y);
      expect(overlapX > 1e-6 && overlapY > 1e-6, `Lots ${index} and ${other} overlap`).toBe(false);
    }
  }
  expect(graph.export()).toEqual(original);
});
