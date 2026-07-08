import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { ShipController } from "./shipController";

// Node env (no DOM): we can't exercise enable()'s window/pointer listeners here,
// so movement is covered by the Playwright run (W moves the view). This smoke
// test verifies the procedural ship builds into the scene and disposes cleanly.
describe("ShipController", () => {
  it("builds a ship mesh into the scene, hidden until enabled", () => {
    const camera = new THREE.PerspectiveCamera(58, 1.5, 0.5, 40000);
    const scene = new THREE.Scene();
    const dom = {} as unknown as HTMLElement; // not touched until enable()
    const sc = new ShipController(camera, dom, scene, 600);
    expect(sc.isEnabled()).toBe(false);
    expect(sc.ship.visible).toBe(false);
    expect(sc.ship.children.length).toBeGreaterThan(0); // body + engine
    expect(scene.children.includes(sc.ship)).toBe(true);
    // update() is a no-op while disabled and must not throw.
    sc.update(0.016);
    // dispose() on a never-enabled ship early-returns from disable() (no window
    // access) and removes the ship from the scene.
    sc.dispose();
    expect(scene.children.includes(sc.ship)).toBe(false);
  });
});
