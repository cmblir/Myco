import { afterEach, describe, expect, it, vi } from "vitest";
import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import { applyAtlasLayout } from "./atlasLayout";
import type { VaultGraph } from "./graphData";

const workerSettings = vi.hoisted(() => vi.fn());
vi.mock("graphology-layout-forceatlas2/worker", () => ({
  default: class {
    constructor(_graph: unknown, options: { settings: unknown }) {
      workerSettings(options.settings);
    }
    start = vi.fn();
    kill = vi.fn();
  },
}));

function graphOfSize(count: number): VaultGraph {
  const graph = new Graph({ type: "undirected", multi: false });
  for (let index = 0; index < count; index++) {
    graph.addNode(`note-${index}`, { x: index, y: 0, z: 0, size: 4 });
  }
  return graph as unknown as VaultGraph;
}

afterEach(() => {
  vi.restoreAllMocks();
  workerSettings.mockClear();
});

describe("atlas repulsion settings", () => {
  // FA2 0.10.1's Barnes-Hut branch ignores node radii in repulsion, while
  // adjustSizes still changes attraction. Do not combine those force models.
  it("keeps size-aware repulsion through 800 nodes", async () => {
    const assign = vi.spyOn(forceAtlas2, "assign").mockImplementation(() => undefined);
    const completed = await applyAtlasLayout(graphOfSize(800), {
      targetRadius: 500,
      noWorker: true,
      iterations: 100,
      shouldAbort: () => assign.mock.calls.length > 0,
    });
    expect(completed).toBe(false);
    expect(assign.mock.calls[0][1]).toMatchObject({
      settings: { adjustSizes: true, barnesHutOptimize: false },
    });
  });

  it.each([801, 1063, 2000, 2001])("uses point-based Barnes-Hut repulsion for %i nodes", async (count) => {
    const assign = vi.spyOn(forceAtlas2, "assign").mockImplementation(() => undefined);
    await applyAtlasLayout(graphOfSize(count), {
      targetRadius: 500,
      noWorker: true,
      iterations: 100,
      shouldAbort: () => assign.mock.calls.length > 0,
    });
    expect(assign.mock.calls[0][1]).toMatchObject({
      settings: { adjustSizes: false, barnesHutOptimize: true },
    });
  });

  it.each(["atlas", "synapse"] as const)("uses consistent forces in the %s worker", async (variant) => {
    await applyAtlasLayout(graphOfSize(1063), {
      targetRadius: 500,
      variant,
      shouldAbort: () => true,
    });
    expect(workerSettings).toHaveBeenCalledWith(expect.objectContaining({
      adjustSizes: false,
      barnesHutOptimize: true,
    }));
  });
});
