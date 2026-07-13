// Scale-adaptive sim cooling — a big vault must converge in far fewer ticks so
// it settles in ~1s instead of shimmering/lagging for ~14s (see the worker).
import { describe, expect, it } from "vitest";
import { bigGraphDecay } from "./simCooling";

describe("bigGraphDecay", () => {
  it("keeps the slow, pretty settle for small vaults", () => {
    expect(bigGraphDecay(50)).toBeCloseTo(0.028, 5);
    expect(bigGraphDecay(2000)).toBeCloseTo(0.028, 5);
  });

  it("cools much faster at scale (fewer ticks → seconds not tens of seconds)", () => {
    expect(bigGraphDecay(11000)).toBeCloseTo(0.09, 5);
    expect(bigGraphDecay(50000)).toBeCloseTo(0.09, 5); // clamped
    // Monotonic ramp between.
    expect(bigGraphDecay(6500)).toBeGreaterThan(bigGraphDecay(2000));
    expect(bigGraphDecay(6500)).toBeLessThan(bigGraphDecay(11000));
  });

  it("a bigger decay means a shorter settle (ticks to reach alphaMin)", () => {
    const ticks = (d: number) => Math.log(0.005) / Math.log(1 - d);
    expect(ticks(bigGraphDecay(11000))).toBeLessThan(ticks(bigGraphDecay(50)) / 2);
  });
});
