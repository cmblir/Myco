import Graph from "graphology";
import { Vector3 } from "three";
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

it("updates the scene when the OS preference changes and removes its observer", () => {
  const { scene, phase, tick } = arrowScene(false);
  const listeners = new Set<(event: { matches: boolean }) => void>();
  const query = { matches: false,
    addEventListener: (_: string, listener: (event: { matches: boolean }) => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: (event: { matches: boolean }) => void) => listeners.delete(listener) };
  vi.stubGlobal("window", { matchMedia: () => query });
  try {
    Object.assign(scene, { controls: { autoRotate: true }, pulse: { points: { visible: true } },
      settings: { linkThickness: 1, arrowSize: 1, ambientMotion: true }, camTween: null,
      rotateResumeTimer: null, interacting: false });
    Reflect.get(scene, "watchMotionPreference").call(scene);
    expect(listeners.size).toBe(1);
    for (const listener of listeners) listener({ matches: true });
    tick();
    expect(phase[0]).toBe(0.25);
    expect(Reflect.get(scene, "controls").autoRotate).toBe(false);
    expect(Reflect.get(scene, "pulse").points.visible).toBe(false);
    for (const listener of listeners) listener({ matches: false });
    tick();
    expect(phase[0]).toBe(0.5);
    expect(Reflect.get(scene, "controls").autoRotate).toBe(true);
    Reflect.get(scene, "stopMotionObserver").call(scene);
    expect(listeners.size).toBe(0);
  } finally { vi.unstubAllGlobals(); }
});


it("finishes an active camera flight exactly once when reduced motion is enabled", () => {
  const { scene } = arrowScene(false);
  const onDone = vi.fn();
  const position = new Vector3();
  const target = new Vector3();
  Object.assign(scene, {
    controls: { target, update: vi.fn(), autoRotate: true }, camera: { position },
    pulse: { points: { visible: true } }, rotateResumeTimer: null,
    camTween: { p1: new Vector3(1, 2, 3), a1: new Vector3(4, 5, 6), onDone },
  });
  Reflect.get(scene, "applyMotionPreference").call(scene, true);
  Reflect.get(scene, "camTweenTick").call(scene, 1);
  Reflect.get(scene, "applyMotionPreference").call(scene, true);
  expect(position.toArray()).toEqual([1, 2, 3]);
  expect(target.toArray()).toEqual([4, 5, 6]);
  expect(Reflect.get(scene, "camTween")).toBeNull();
  expect(onDone).toHaveBeenCalledTimes(1);
});

it("finishes an active orbit retarget when reduced motion is enabled", () => {
  const { scene } = arrowScene(false);
  const target = new Vector3();
  const destination = new Vector3(10, 20, 30);
  Object.assign(scene, {
    controls: { target, update: vi.fn(), autoRotate: true },
    pulse: { points: { visible: true } }, rotateResumeTimer: null,
    camTween: null, targetTween: null,
  });
  scene.setOrbitTarget(destination);
  Reflect.get(scene, "targetTweenTick").call(scene, 0.05);
  expect(target.equals(destination)).toBe(false);
  Reflect.get(scene, "applyMotionPreference").call(scene, true);
  expect(target.toArray()).toEqual(destination.toArray());
  expect(Reflect.get(scene, "targetTween")).toBeNull();
  Reflect.get(scene, "targetTweenTick").call(scene, 0.05);
  expect(target.toArray()).toEqual(destination.toArray());
});

it.each([
  { ambientMotion: false, interacting: false, atlasMode: false },
  { ambientMotion: true, interacting: true, atlasMode: false },
  { ambientMotion: true, interacting: false, atlasMode: true },
])("does not resume rotation against existing scene policy: %j", (policy) => {
  const { scene } = arrowScene(true);
  Object.assign(scene, {
    controls: { autoRotate: false }, pulse: { points: { visible: false } },
    settings: { ambientMotion: policy.ambientMotion }, interacting: policy.interacting,
    atlasMode: policy.atlasMode, rotateResumeTimer: null, camTween: null,
  });
  Reflect.get(scene, "applyMotionPreference").call(scene, false);
  expect(Reflect.get(scene, "controls").autoRotate).toBe(false);
});
