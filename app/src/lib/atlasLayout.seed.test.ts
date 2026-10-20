import Graph from "graphology";
import { describe, expect, it } from "vitest";
import { applyAtlasLayout } from "./atlasLayout";
import type { VaultGraph } from "./graphData";

async function seedPositions(ids: string[]): Promise<Map<string, { x: number; y: number }>> {
  const graph: VaultGraph = new Graph();
  for (const id of ids) {
    graph.addNode(id, {
      label: id, x: 0, y: 0, z: 0, deg: 0, size: 1,
      color: "#ffffff", community: 0, galaxy: -1, isHub: false, intensity: 0,
    });
  }
  // Stop at the first FA2 slice: inspect the production seed before forces,
  // fitting, or collision separation can obscure a biased starting shape.
  expect(await applyAtlasLayout(graph, {
    targetRadius: 600, noWorker: true, shouldAbort: () => true,
  })).toBe(false);
  return new Map(graph.mapNodes((id, a) => [id, { x: a.x, y: a.y }]));
}

describe("atlas disc seed", () => {
  it("fills radial and angular bins independently instead of tracing a single spiral", async () => {
    const ids = Array.from({ length: 1063 }, (_, i) =>
      `/synthetic/wiki/stress-c${Math.floor(i / 40)}-note-${i}.md`,
    );
    const positions = await seedPositions(ids);
    const bins = Array.from({ length: 8 }, () => Array<number>(8).fill(0));
    for (const { x, y } of positions.values()) {
      // Equal-area radial bands: a uniform disc has uniform squared radius.
      const radial = (x * x + y * y) / (600 * 600);
      const angle = ((Math.atan2(y, x) / (Math.PI * 2)) + 1) % 1;
      expect(radial).toBeGreaterThanOrEqual(0);
      expect(radial).toBeLessThanOrEqual(1);
      bins[Math.min(7, Math.floor(radial * 8))][Math.min(7, Math.floor(angle * 8))]++;
    }
    // The old :ax/:ay FNV streams occupied only 21 of these 64 cells.
    expect(bins.flat().filter((count) => count > 0).length).toBeGreaterThanOrEqual(60);
    expect(Math.max(...bins.flat())).toBeLessThan(1063 / 16);
  });

  it("keeps the same note positions across reloads and insertion orders", async () => {
    const ids = ["/synthetic/API.md", "/synthetic/한글 제목.md", "/synthetic/long-note-slug.md"];
    const first = await seedPositions(ids);
    const repeated = await seedPositions(ids);
    const reversed = await seedPositions([...ids].reverse());
    for (const id of ids) {
      expect(repeated.get(id)).toEqual(first.get(id));
      expect(reversed.get(id)).toEqual(first.get(id));
    }
    expect(new Set([...first.values()].map(({ x, y }) => `${x},${y}`)).size).toBe(ids.length);
  });
});
