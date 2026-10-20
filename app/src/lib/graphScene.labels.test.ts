import Graph from "graphology";
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { GraphScene } from "./graphScene";

function labelScene() {
  const graph = new Graph();
  for (const [id, x] of [["selected", -20], ["neighbor", 20], ["hidden", 0], ["hub", 40]] as const) {
    graph.addNode(id, { label: id, x, y: 0, z: 0, size: 0.001, hidden: id === "hidden" });
  }
  graph.addEdge("selected", "neighbor");
  graph.addEdge("selected", "hidden");
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  camera.position.z = 100;
  camera.updateMatrixWorld();
  const labels = new Map<string, { position: THREE.Vector3; userData: Record<string, unknown>; element: { style: Record<string, string> }; visible: boolean }>();
  const ensureLabel = (id: string) => {
    if (!labels.has(id)) labels.set(id, { position: new THREE.Vector3(), userData: {}, element: { style: {} }, visible: false });
    return labels.get(id)!;
  };
  const scene = Object.create(GraphScene.prototype) as GraphScene;
  Object.assign(scene, {
    graph, camera, labels, selectedNode: "selected", style: { hoveredNode: null },
    interacting: false, container: { clientWidth: 800, clientHeight: 800 },
    controls: { target: new THREE.Vector3() }, settings: { textFadeThreshold: 3 },
    framedDist: 100, sizeScale: () => 1, labelRank: ["hub"],
    labelCandidates: new Set(), shownLabels: new Set(), labelBoxes: [], placedBoxes: [],
    tmpVec: new THREE.Vector3(), ensureLabel,
    clusterLabels: { setZoomRatio: vi.fn(), setViewportWidth: () => 100, shown: [] },
  });
  const update = () => Reflect.get(scene, "updateLabels").call(scene);
  return { scene, labels, update };
}

describe("graph neighborhood labels", () => {
  it("names low-degree selected notes and visible neighbors even below the overview size threshold", () => {
    const { labels, update } = labelScene();
    update();
    expect(labels.get("selected")?.visible).toBe(true);
    expect(labels.get("neighbor")?.visible).toBe(true);
    expect(labels.has("hidden")).toBe(false);
    expect(labels.has("hub")).toBe(false);
  });

  it("keeps the name-visibility control effective for sculpted overview labels", () => {
    const { scene, labels, update } = labelScene();
    const settings = { textFadeThreshold: 0.1 };
    Object.assign(scene, {
      selectedNode: null, settings, sizeScale: () => 100,
      sculpted: { layout: { nodes: new Map([["hub", { width: 2 }]]) } },
    });
    update();
    expect(labels.get("hub")?.visible).toBe(true);
    settings.textFadeThreshold = 3;
    update();
    expect(labels.get("hub")?.visible).toBe(false);
  });

  it("removes neighborhood labels when selection clears and while orbiting", () => {
    const { scene, labels, update } = labelScene();
    update();
    Object.assign(scene, { interacting: true });
    update();
    expect([...labels.values()].every((label) => !label.visible)).toBe(true);
    Object.assign(scene, { interacting: false, selectedNode: null });
    update();
    expect([...labels.values()].every((label) => !label.visible)).toBe(true);
  });
});
