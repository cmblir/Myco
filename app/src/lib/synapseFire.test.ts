// Idle synapse-firing scheduling (pure helpers driven by GraphScene).
import { describe, expect, it } from "vitest";
import {
  pickByDegree,
  synapseDelay,
  SYNAPSE_DELAY_MIN,
  SYNAPSE_DELAY_VAR,
} from "./synapseFire";

describe("synapseDelay", () => {
  it("spans [min, min+var) over the rand range", () => {
    expect(synapseDelay(0)).toBeCloseTo(SYNAPSE_DELAY_MIN);
    expect(synapseDelay(1)).toBeCloseTo(SYNAPSE_DELAY_MIN + SYNAPSE_DELAY_VAR);
  });
});

describe("pickByDegree", () => {
  const deg: Record<string, number> = { hub: 100, mid: 9, leaf: 0 };
  const degOf = (id: string): number => deg[id] ?? 0;
  const ids = ["hub", "mid", "leaf"];

  it("returns null on an empty graph", () => {
    expect(pickByDegree([], degOf, 0.5)).toBeNull();
  });

  it("walks the cumulative weights deterministically", () => {
    // weights: hub 11, mid 4, leaf 1 (1 + √deg) — total 16.
    expect(pickByDegree(ids, degOf, 0)).toBe("hub");
    expect(pickByDegree(ids, degOf, 11.5 / 16)).toBe("mid");
    expect(pickByDegree(ids, degOf, 15.5 / 16)).toBe("leaf");
  });

  it("clamps a rand of ~1 to the last node instead of overrunning", () => {
    expect(pickByDegree(ids, degOf, 0.999999999)).toBe("leaf");
  });

  it("gives every node a floor chance (weight ≥ 1) even at degree 0", () => {
    const flat = ["a", "b"];
    expect(pickByDegree(flat, () => 0, 0.51)).toBe("b");
    expect(pickByDegree(flat, () => 0, 0.49)).toBe("a");
  });
});
