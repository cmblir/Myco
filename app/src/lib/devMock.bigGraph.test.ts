import { afterEach, describe, expect, it, vi } from "vitest";
import { installTauriMock } from "./devMock";
import { buildGraph } from "./graphData";
import type { Adjacency } from "./ipc";

afterEach(() => vi.unstubAllGlobals());

describe("large synthetic graph adjacency", () => {
  it.each([
    [250, 743],
    [2500, 7381],
  ])(
    "preserves %i notes and %i links while listing each neighbor once",
    async (count, edges) => {
      vi.stubGlobal("window", {});
      vi.stubGlobal("location", { search: `?mock=1&big=${count}` });
      installTauriMock();
      const host = window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (command: string) => Promise<Adjacency>;
        };
      };
      const adjacency =
        await host.__TAURI_INTERNALS__.invoke("build_link_graph");
      const graph = buildGraph(
        adjacency,
        new Set(Object.keys(adjacency.tags)),
        {
          nodeSize: 1,
          starDim: "#667788",
          edgeColor: "#8899aa",
          showGhosts: false,
        },
      );
      // Counts recorded before deduplication ensure the fixture's topology stays intact.
      expect(graph.order).toBe(count);
      expect(graph.size).toBe(edges);
      for (const direction of [adjacency.forward, adjacency.backward]) {
        for (const neighbors of Object.values(direction)) {
          expect(neighbors.length).toBe(new Set(neighbors).size);
        }
      }
      for (const [source, targets] of Object.entries(adjacency.forward)) {
        for (const target of targets)
          expect(adjacency.backward[target]).toContain(source);
      }
    },
  );
});
