// "그래프에서 보기" (UX S44): the arrival flight frames the note AND its
// first-hop neighbours, not the note alone.
import { describe, expect, it } from "vitest";
import { coverShift, neighbourhoodDist } from "./graphScene";

const at = (x: number, y = 0, z = 0) => ({ x, y, z });

describe("neighbourhoodDist", () => {
  it("keeps the close distance for a note with no neighbours", () => {
    expect(neighbourhoodDist(at(0), [], 50, 1.6, 300)).toBe(300);
  });

  it("keeps the close distance when every neighbour already fits", () => {
    expect(neighbourhoodDist(at(0), [at(5)], 50, 1.6, 300)).toBe(300);
  });

  it("pulls back until the farthest neighbour sits inside the narrower half-FOV", () => {
    const fov = 50;
    const aspect = 0.8; // portrait: the horizontal half-FOV is the narrow one
    const dist = neighbourhoodDist(
      at(10, 10, 10),
      [at(10, 10, 410), at(60, 10, 10)],
      fov,
      aspect,
      100,
    );
    const half = Math.atan(Math.tan((fov * Math.PI) / 360) * aspect);
    // The sphere of radius 400 around the note subtends less than the half-FOV.
    expect(Math.asin(400 / dist)).toBeLessThan(half);
    expect(dist).toBeGreaterThan(100);
  });

  it("uses the vertical half-FOV on a wide canvas", () => {
    const wide = neighbourhoodDist(at(0), [at(400)], 50, 2, 1);
    const square = neighbourhoodDist(at(0), [at(400)], 50, 1, 1);
    expect(wide).toBeCloseTo(square);
  });
});

// The inspector covers the canvas's right edge; the arrival centres the note
// in the part left uncovered.
describe("coverShift", () => {
  it("is zero with nothing covering the canvas", () => {
    expect(coverShift(0, 1000, 50, 600)).toBe(0);
  });

  it("moves the look-at point half the covered width, in world units at that distance", () => {
    const worldPerPx = (2 * 1000 * Math.tan((50 * Math.PI) / 360)) / 600;
    expect(coverShift(300, 1000, 50, 600)).toBeCloseTo(150 * worldPerPx);
  });
});
