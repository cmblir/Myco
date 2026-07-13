// Cosmic-scale LOD math (pure — drives the node ↔ imposter cross-fade).
import { describe, expect, it } from "vitest";
import {
  cosmicScale,
  imposterAlpha,
  nodeLodAlpha,
  zoomLevel,
} from "./cosmicLod";

describe("zoomLevel", () => {
  it("is 0 dived in, 1 framed out, ramping between", () => {
    const F = 1000;
    expect(zoomLevel(F * 0.2, F)).toBe(0); // well inside → full nodes
    expect(zoomLevel(F * 0.85, F)).toBe(1); // framed → full imposters
    expect(zoomLevel(F * 2, F)).toBe(1); // further out clamps
    const mid = zoomLevel(F * 0.585, F); // midpoint of the 0.32..0.85 band
    expect(mid).toBeGreaterThan(0.4);
    expect(mid).toBeLessThan(0.6);
  });

  it("is inert without a framed distance", () => {
    expect(zoomLevel(500, 0)).toBe(0);
  });
});

describe("nodeLodAlpha", () => {
  it("is the inverse of zoom (full near, gone far)", () => {
    expect(nodeLodAlpha(0)).toBe(1);
    expect(nodeLodAlpha(1)).toBe(0);
    expect(nodeLodAlpha(0.3)).toBeCloseTo(0.7);
  });
});

describe("imposterAlpha", () => {
  it("follows global zoom when the galaxy is small on screen", () => {
    expect(imposterAlpha(0, 0.1)).toBe(0);
    expect(imposterAlpha(1, 0.1)).toBeCloseTo(1);
    expect(imposterAlpha(0.5, 0.1)).toBeCloseTo(0.5);
  });

  it("kills a galaxy's imposter once it fills the view (you're inside it)", () => {
    // Even fully zoomed out, a galaxy covering 80% of the screen resolves.
    expect(imposterAlpha(1, 0.8)).toBe(0);
    // Half-filling → partially resolved.
    expect(imposterAlpha(1, 0.575)).toBeCloseTo(0.5, 1);
  });
});

describe("cosmicScale", () => {
  it("names the altitude band, promoting to cluster only with many galaxies", () => {
    expect(cosmicScale(0.0, true)).toBe("star");
    expect(cosmicScale(0.35, true)).toBe("system");
    expect(cosmicScale(0.6, true)).toBe("galaxy");
    expect(cosmicScale(0.9, true)).toBe("cluster");
    // A single galaxy never becomes a "cluster".
    expect(cosmicScale(0.9, false)).toBe("galaxy");
  });
});
