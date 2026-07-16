import { describe, expect, it } from "vitest";
import type { Adjacency } from "./ipc";
import { facetValues, runView } from "./queryViews";

const A = "/v/alpha.md";
const B = "/v/beta.md";
const C = "/v/gamma.md";
const D = "/v/delta.md";

function adj(): Adjacency {
  return {
    forward: { [A]: [B] },
    backward: { [B]: [A] },
    unresolved: {},
    tags: { [A]: ["ml"], [B]: ["ml", "史"], [C]: [] },
    meta: {
      [A]: { type: "concept", confidence: "high", sourceCount: 3 },
      [B]: { type: "technique", confidence: "low", sourceCount: 0 },
      [C]: { type: "concept", status: "disputed", sourceCount: 1 },
      // D has no meta at all (older backend / plain note)
    },
  };
}

const FILES = [A, B, C, D];

describe("runView", () => {
  it("returns everything unfiltered, sorted by name", () => {
    const rows = runView(adj(), FILES, {});
    expect(rows.map((r) => r.name)).toEqual(["alpha", "beta", "delta", "gamma"]);
  });

  it("filters by type, confidence, tag, and text", () => {
    expect(runView(adj(), FILES, { types: ["concept"] }).map((r) => r.name)).toEqual([
      "alpha",
      "gamma",
    ]);
    expect(runView(adj(), FILES, { confidence: ["low"] }).map((r) => r.name)).toEqual(["beta"]);
    expect(runView(adj(), FILES, { tags: ["ml"] }).map((r) => r.name)).toEqual(["alpha", "beta"]);
    expect(runView(adj(), FILES, { text: "GAMM" }).map((r) => r.name)).toEqual(["gamma"]);
  });

  it("filters by minSources and orphansOnly", () => {
    expect(runView(adj(), FILES, { minSources: 2 }).map((r) => r.name)).toEqual(["alpha"]);
    // orphans: C and D have no links in either direction
    expect(runView(adj(), FILES, { orphansOnly: true }).map((r) => r.name)).toEqual([
      "delta",
      "gamma",
    ]);
  });

  it("sorts by sources descending with name tiebreak", () => {
    const rows = runView(adj(), FILES, {}, "sources", true);
    expect(rows[0].name).toBe("alpha"); // 3 sources
    expect(rows[rows.length - 1].sourceCount).toBe(0);
  });

  it("counts links in both directions", () => {
    const byName = new Map(runView(adj(), FILES, {}).map((r) => [r.name, r]));
    expect(byName.get("alpha")?.links).toBe(1);
    expect(byName.get("beta")?.links).toBe(1);
    expect(byName.get("gamma")?.links).toBe(0);
  });
});

describe("facetValues", () => {
  it("collects only values that exist, sorted", () => {
    const f = facetValues(adj(), FILES);
    expect(f.types).toEqual(["concept", "technique"]);
    expect(f.confidence).toEqual(["high", "low"]);
    expect(f.status).toEqual(["disputed"]);
    expect(f.tags).toContain("ml");
  });
});
