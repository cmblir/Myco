// Activation-wave scheduling — BFS ring plan + timing envelopes (pure logic;
// the three.js rendering in waveLayer.ts consumes these).
import { describe, expect, it } from "vitest";
import {
  edgeProgress,
  nodeFlash,
  planWave,
  waveDuration,
  WAVE_FLASH_DUR,
  WAVE_STEP,
} from "./activationWave";

// a — b — c — d chain plus a triangle a–b–e (cross edge b–e vs a–e tree edge).
const ADJ: Record<string, string[]> = {
  a: ["b", "e"],
  b: ["a", "c", "e"],
  c: ["b", "d"],
  d: ["c"],
  e: ["a", "b"],
};
const nb = (id: string): string[] => ADJ[id] ?? [];

describe("planWave", () => {
  it("assigns BFS depths from the origin", () => {
    const plan = planWave(nb, "a");
    const depth = new Map(plan.nodes.map((n) => [n.id, n.depth]));
    expect(depth.get("a")).toBe(0);
    expect(depth.get("b")).toBe(1);
    expect(depth.get("e")).toBe(1);
    expect(depth.get("c")).toBe(2);
    expect(depth.get("d")).toBe(3);
    expect(plan.maxDepth).toBe(3);
  });

  it("records tree edges only (no cross or back edges)", () => {
    const plan = planWave(nb, "a");
    // b–e is a cross edge between two depth-1 nodes — must not fire.
    const keys = plan.edges.map((e) => `${e.s}>${e.t}`);
    expect(keys).toContain("a>b");
    expect(keys).toContain("a>e");
    expect(keys).not.toContain("b>e");
    expect(keys).not.toContain("e>b");
    // One tree edge per non-origin node.
    expect(plan.edges.length).toBe(plan.nodes.length - 1);
  });

  it("caps depth and node count", () => {
    const shallow = planWave(nb, "a", { maxDepth: 1 });
    expect(Math.max(...shallow.nodes.map((n) => n.depth))).toBe(1);
    const tiny = planWave(nb, "a", { maxNodes: 2 });
    expect(tiny.nodes.length).toBeLessThanOrEqual(2);
  });
});

describe("timing envelopes", () => {
  it("edgeProgress opens exactly during the ring's step window", () => {
    expect(edgeProgress(1, WAVE_STEP * 0.5)).toBeNull(); // before window
    expect(edgeProgress(1, WAVE_STEP * 1.5)).toBeCloseTo(0.5);
    expect(edgeProgress(1, WAVE_STEP * 2.5)).toBeNull(); // after window
  });

  it("nodeFlash arches 0 → 1 → 0 over the flash duration", () => {
    expect(nodeFlash(1, WAVE_STEP * 0.9)).toBe(0); // ring not reached yet
    expect(nodeFlash(1, WAVE_STEP + WAVE_FLASH_DUR / 2)).toBeCloseTo(1);
    expect(nodeFlash(1, WAVE_STEP + WAVE_FLASH_DUR * 1.1)).toBe(0);
  });

  it("waveDuration covers the deepest ring's flash", () => {
    const plan = planWave(nb, "a");
    expect(waveDuration(plan)).toBeCloseTo(3 * WAVE_STEP + WAVE_FLASH_DUR);
    // The deepest node still has non-zero flash inside the duration…
    expect(nodeFlash(3, waveDuration(plan) - 0.01)).toBeGreaterThan(0);
    // …and none after it.
    expect(nodeFlash(3, waveDuration(plan) + WAVE_FLASH_DUR)).toBe(0);
  });
});
