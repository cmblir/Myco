import Graph from "graphology";
import { describe, expect, it, vi } from "vitest";
import { GraphScene } from "./graphScene";

function arrowScene(reducedMotion: boolean) {
  const graph = new Graph();
  graph.addNode("source", { x: 0, y: 0, z: 0, size: 1 });
  graph.addNode("target", { x: 100, y: 0, z: 0, size: 1 });
  const scene = Object.create(GraphScene.prototype) as GraphScene;
  const phase = [0.25];
  const setMatrixAt = vi.fn();
  Object.assign(scene, { graph, reducedMotion, settings: { linkThickness: 1, arrowSize: 1 },
    edgePairs: [["source", "target"]], arrowPhase: phase, arrowSpeed: [0.5],
    arrows: { setMatrixAt, instanceMatrix: { needsUpdate: false } } });
  const tick = () => Reflect.get(scene, "animateArrows").call(scene, 0.5);
  return { scene, phase, setMatrixAt, tick };
}

describe("graph direction arrows and reduced motion", () => {
  it("keeps direction arrows static while retaining their visible geometry", () => {
    const { phase, setMatrixAt, tick } = arrowScene(true);
    tick();
    tick();
    expect(phase[0]).toBe(0.25);
    expect(setMatrixAt).toHaveBeenCalledTimes(2);
  });

  it("retains arrow travel when reduced motion is disabled", () => {
    const { phase, tick } = arrowScene(false);
    tick();
    expect(phase[0]).toBe(0.5);
  });
});
