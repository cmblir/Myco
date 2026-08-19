// focusNode's camera-pose math: keep the current viewing direction (or stay
// locked front-on in planar mode), pulled back `dist` from the note.
import { describe, expect, it } from "vitest";
import { focusPose } from "./myceliumScene";

const len = (p: { x: number; y: number; z: number }, n: { x: number; y: number; z: number }): number =>
  Math.hypot(p.x - n.x, p.y - n.y, p.z - n.z);

describe("focusPose", () => {
  it("planar: straight-on, +z from the note, regardless of camera direction", () => {
    const p = focusPose({ x: 10, y: -4, z: 0 }, { x: 999, y: 999, z: 999 }, true, 350);
    expect(p).toEqual({ x: 10, y: -4, z: 350 });
  });

  it("3D: preserves the note→camera direction at exactly dist", () => {
    const node = { x: 100, y: 0, z: 0 };
    const p = focusPose(node, { x: 500, y: 0, z: 0 }, false, 50);
    expect(p.x).toBeCloseTo(150);
    expect(p.y).toBeCloseTo(0);
    expect(p.z).toBeCloseTo(0);
    expect(len(p, node)).toBeCloseTo(50);
  });

  it("3D: non-axis direction is normalised, not scaled by camera distance", () => {
    const node = { x: 0, y: 0, z: 0 };
    const near = focusPose(node, { x: 3, y: 4, z: 0 }, false, 10);
    const far = focusPose(node, { x: 300, y: 400, z: 0 }, false, 10);
    expect(len(near, node)).toBeCloseTo(10);
    expect(near.x).toBeCloseTo(far.x);
    expect(near.y).toBeCloseTo(far.y);
    expect(near.z).toBeCloseTo(far.z);
  });

  it("3D degenerate (camera on the note): falls back to a mild default, still at dist", () => {
    const node = { x: 5, y: 5, z: 5 };
    const p = focusPose(node, { x: 5, y: 5, z: 5 }, false, 20);
    expect(len(p, node)).toBeCloseTo(20);
    expect(p.z).toBeGreaterThan(node.z); // default leans toward the viewer
  });
});
