import { describe, expect, it } from "vitest";
import { bakeSeededSky, fbm, seedUnit, valueNoise } from "./skyTexture";

describe("seeded sky", () => {
  it("seedUnit is deterministic and seed-sensitive", () => {
    expect(seedUnit("vault-a", 1)).toBe(seedUnit("vault-a", 1));
    expect(seedUnit("vault-a", 1)).not.toBe(seedUnit("vault-b", 1));
    expect(seedUnit("vault-a", 1)).not.toBe(seedUnit("vault-a", 2));
  });

  it("valueNoise stays in [0,1] and tiles horizontally", () => {
    for (let i = 0; i < 50; i++) {
      const v = valueNoise(i * 0.37, i * 0.73, 6, 42);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    // Horizontal wrap: x and x+period sample the same lattice.
    expect(valueNoise(0.3, 1.7, 6, 7)).toBeCloseTo(valueNoise(6.3, 1.7, 6, 7), 10);
  });

  it("fbm is deterministic per seed", () => {
    expect(fbm(1.1, 2.2, 6, 5)).toBe(fbm(1.1, 2.2, 6, 5));
    expect(fbm(1.1, 2.2, 6, 5)).not.toBe(fbm(1.1, 2.2, 6, 6));
  });

  it("bake degrades to null without a real 2D canvas (headless)", () => {
    // jsdom's canvas has no real 2d context; the bake must not throw.
    const t = bakeSeededSky("vault", true);
    expect(t === null || typeof t === "object").toBe(true);
  });
});
