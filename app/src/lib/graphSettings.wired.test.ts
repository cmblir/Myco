// Every GraphSettings key must be consumed by the graph, or it is a control
// that does nothing.
//
// The graph's effect dependency lists are hand-maintained (eslint-disabled),
// so a new settings key that the author forgets to wire renders a slider or
// toggle that changes nothing, silently. The audit's proposed fix — partition
// the keys into PHYSICS/DISPLAY/REBUILD arrays and derive the effect deps from
// them — does not fit this code: a key legitimately drives MORE THAN ONE effect
// (e.g. `multiverse` triggers both the load effect and the scene rebuild), so
// there is no partition to derive from.
//
// What IS checkable, and catches the common trap, is this: every key of
// GraphSettings is read somewhere in the graph source (`.<key>`). A key added
// to the interface but wired nowhere fails here, at build time, naming itself —
// instead of shipping as a dead control. (It does not prove the key is in the
// RIGHT effect's dep list; the many-to-many wiring makes that untestable
// without a behavior-changing refactor.)

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../..", import.meta.url).pathname; // app/
const rd = (rel: string): string => readFileSync(ROOT + rel, "utf8");

const GRAPH_SOURCES = [
  "src/pages/PageGraph.tsx",
  "src/lib/graphScene.ts",
  "src/lib/graphSim.worker.ts",
  "src/components/GraphControls.tsx",
  "src/lib/graphData.ts",
  "src/lib/atlasLayout.ts",
].map(rd).join("\n");

function graphSettingsKeys(): string[] {
  const src = rd("src/lib/graphSettings.ts");
  const start = src.indexOf("export interface GraphSettings");
  const end = src.indexOf("}", start);
  return [...src.slice(start, end).matchAll(/^\s+([a-zA-Z0-9_]+)[?:]/gm)].map((m) => m[1]);
}

describe("GraphSettings wiring", () => {
  it("every key is consumed somewhere in the graph", () => {
    const keys = graphSettingsKeys();
    expect(keys.length).toBeGreaterThan(20); // sanity: we actually parsed them
    const unwired = keys.filter((k) => !new RegExp(`\\.${k}\\b`).test(GRAPH_SOURCES));
    expect(unwired).toEqual([]);
  });
});
