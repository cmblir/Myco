import Graph from "graphology";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { VaultGraph } from "./graphData";
import { GraphScene } from "./graphScene";
import { DEFAULT_GRAPH_SETTINGS, VIBE_PRESETS } from "./graphSettings";
import { SculptedGraphLayer } from "./sculptedGraphLayer";
import { applySculptedLayout } from "./sculptedLayouts";

describe.each(["terrain", "ribbon", "city"] as const)("%s full-geometry framing", (kind) => {
  it.each([0.5, 1, 1.7])("keeps the rendered surface and enlarged notes visible at aspect %s", (aspect) => {
    const graph = new Graph({ type: "undirected" }) as VaultGraph;
    for (let index = 0; index < 48; index++) graph.addNode(`note-${index}`, {
      label: `Note ${index}`, x: 0, y: 0, z: 0, deg: index % 9, size: 1,
      color: "#7c89a9", community: index % 4, galaxy: 0, isHub: false, intensity: 0.3,
    });
    const layout = applySculptedLayout(graph, kind, { targetRadius: 100 });
    const layer = new SculptedGraphLayer(graph, layout);
    const attributes = new THREE.BufferGeometry();
    attributes.setAttribute("a_color", new THREE.Float32BufferAttribute(new Float32Array(graph.order * 3).fill(0.5), 3));
    for (const name of ["a_alpha", "a_size", "a_hit"]) {
      attributes.setAttribute(name, new THREE.Float32BufferAttribute(new Float32Array(graph.order).fill(name === "a_hit" ? 0 : 1), 1));
    }
    layer.sync(attributes, { ...DEFAULT_GRAPH_SETTINGS, ...VIBE_PRESETS[kind], nodeSize: 3 }, null);
    const camera = new THREE.PerspectiveCamera(58, aspect, 0.5, 40000);
    camera.up.set(0, 0, 1);
    camera.position.set(80, -100, 140);
    const controls = {
      target: new THREE.Vector3(), minDistance: 8, maxDistance: 30000,
      update: () => { camera.lookAt(controls.target); camera.updateMatrixWorld(); },
    };
    const scene = Object.create(GraphScene.prototype) as GraphScene;
    Object.assign(scene, {
      sculpted: layer, camera, controls, graph, tmpVec: new THREE.Vector3(), reducedMotion: true,
      container: { clientWidth: 900, parentElement: null },
    });
    scene.fit();
    let extent = 0;
    layer.forEachFramePoint((point) => {
      const projected = point.clone().project(camera);
      expect(Math.abs(projected.x)).toBeLessThan(0.94);
      expect(Math.abs(projected.y)).toBeLessThan(0.94);
      expect(projected.z).toBeLessThan(1);
      extent = Math.max(extent, Math.abs(projected.x), Math.abs(projected.y));
    });
    expect(extent).toBeGreaterThan(0.7);
    // Search/inspector focus must frame the transformed solid, not its old star radius.
    for (const id of graph.nodes()) {
      scene.focusNode(id);
      const bounds = layer.nodeBounds(id)!;
      expect(bounds.containsPoint(camera.position)).toBe(false);
      expect(controls.target.distanceTo(bounds.getCenter(new THREE.Vector3()))).toBeLessThan(0.001);
      for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
        const projected = new THREE.Vector3(x, y, z).project(camera);
        expect(Math.abs(projected.x)).toBeLessThan(0.94);
        expect(Math.abs(projected.y)).toBeLessThan(0.94);
      }
    }
    layer.dispose();
    attributes.dispose();
  });
});
