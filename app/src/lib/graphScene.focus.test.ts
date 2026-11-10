import Graph from "graphology";
import * as THREE from "three";
import { expect, it, vi } from "vitest";
import { GraphScene, neighbourhoodDist } from "./graphScene";

function focusScene() {
  const graph = new Graph();
  graph.addNode("selected", { x: 0, y: 0, z: 0, size: 1 });
  graph.addNode("neighbor", { x: 400, y: 0, z: 0, size: 1 });
  graph.addEdge("selected", "neighbor");
  const camera = new THREE.PerspectiveCamera(50, 0.8, 0.1, 10000);
  camera.position.z = 100;
  const startCamTween = vi.fn();
  const scene = Object.create(GraphScene.prototype) as GraphScene;
  const controls = { minDistance: 1, maxDistance: 50 };
  Object.assign(scene, {
    graph,
    camera,
    controls,
    container: { clientWidth: 480, clientHeight: 600 },
    tmpVec: new THREE.Vector3(),
    sculpted: null,
    startCamTween,
  });
  return { scene, controls, startCamTween };
}

it("does not clamp inspector focus to a tiny graph's previous maximum distance", () => {
  const { scene, controls, startCamTween } = focusScene();
  scene.focusNode("selected", { coverRightPx: 280 });
  const [position, target] = startCamTween.mock.calls[0] as [
    THREE.Vector3,
    THREE.Vector3,
  ];
  const distance = position.distanceTo(target);
  expect(distance).toBeGreaterThan(50);
  expect(controls.maxDistance).toBeGreaterThanOrEqual(distance);
  expect(target.x).toBeGreaterThan(0);
});

it("retains the neighborhood fit when a sculpted node also supplies solid bounds", () => {
  const { scene, startCamTween } = focusScene();
  Object.assign(scene, {
    sculpted: {
      nodeBounds: () =>
        new THREE.Box3(
          new THREE.Vector3(-1, -1, -1),
          new THREE.Vector3(1, 1, 1),
        ),
    },
  });
  scene.focusNode("selected", { neighbours: true, coverRightPx: 280 });
  const [position, target] = startCamTween.mock.calls[0] as [
    THREE.Vector3,
    THREE.Vector3,
  ];
  const required = neighbourhoodDist(
    { x: 0, y: 0, z: 0 },
    [{ x: 400, y: 0, z: 0 }],
    50,
    200 / 600,
    1,
  );
  expect(position.distanceTo(target)).toBeGreaterThanOrEqual(required);
});
