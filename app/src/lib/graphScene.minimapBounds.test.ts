// Galaxy-chart minimap bounds: must frame the full 3D extent (not just XY),
// while staying pixel-identical for flat/2D layouts (zero Z spread).
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { computeMinimapBounds } from "./graphScene";

function attrOf(points: [number, number, number][]): THREE.BufferAttribute {
  const arr = new Float32Array(points.length * 3);
  points.forEach(([x, y, z], i) => arr.set([x, y, z], i * 3));
  return new THREE.BufferAttribute(arr, 3);
}

describe("computeMinimapBounds", () => {
  it("captures full Z spread for a 3D layout (near/far must contain every node)", () => {
    const pos = attrOf([
      [0, 0, -500],
      [0, 0, 500],
      [10, -10, 0],
    ]);
    const b = computeMinimapBounds(pos, 3);
    expect(b.rz).toBeCloseTo(500);
    // The far-plane distance the caller derives from rz must clear the
    // farthest node: dist ± rz must both stay within [near, far].
    const dist = b.r * 3 + b.rz + 100;
    const far = b.r * 8 + b.rz * 2 + 1000;
    expect(dist - b.rz).toBeGreaterThan(0.1); // nearest node clears near=0.1
    expect(far).toBeGreaterThan(dist + b.rz); // farthest node stays inside far
  });

  it("leaves flat/2D layouts (Z=0 for every node) with zero Z spread", () => {
    const pos = attrOf([
      [0, 0, 0],
      [50, 30, 0],
      [-20, 40, 0],
    ]);
    const b = computeMinimapBounds(pos, 3);
    expect(b.rz).toBe(0);
    // With rz=0 the camera distance/far formulas reduce to the original
    // XY-only values, so the 2D framing is unchanged.
    expect(b.r * 3 + b.rz + 100).toBeCloseTo(b.r * 3 + 100);
    expect(b.r * 8 + b.rz * 2 + 1000).toBeCloseTo(b.r * 8 + 1000);
  });
});
