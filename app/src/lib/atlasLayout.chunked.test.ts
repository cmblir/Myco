// Chunked FA2 atlas apply — the freeze-fix contract (2026-07-14 postmortem):
// slices must stay small at scale, the loop must yield between slices, and
// shouldAbort must stop the run promptly.
import { describe, expect, it } from "vitest";
import Graph from "graphology";
import {
  applyAtlasLayout,
  atlasIterationBudget,
  atlasSliceSize,
} from "./atlasLayout";
import type { VaultGraph } from "./graphData";

function ringGraph(n: number): VaultGraph {
  const g = new Graph({ type: "undirected", multi: false });
  for (let i = 0; i < n; i++) {
    g.addNode(`n${i}`, {
      x: Math.cos((i / n) * Math.PI * 2) * 10 + (i % 7) * 0.13,
      y: Math.sin((i / n) * Math.PI * 2) * 10,
      z: 0,
      size: 4,
    });
  }
  for (let i = 0; i < n; i++) g.addEdge(`n${i}`, `n${(i + 1) % n}`);
  return g as unknown as VaultGraph;
}

describe("atlasIterationBudget / atlasSliceSize", () => {
  it("budget shrinks as the graph grows (big graphs pay more per iteration)", () => {
    expect(atlasIterationBudget(1000)).toBeGreaterThan(atlasIterationBudget(10000));
    // FULL expansion budget even at scale — 40 iterations froze LinLog
    // mid-collapse into one white ball (2026-07-14 regression).
    expect(atlasIterationBudget(10000)).toBeGreaterThanOrEqual(120);
    expect(atlasIterationBudget(100)).toBe(400); // capped
    expect(atlasIterationBudget(0)).toBe(0);
  });

  it("worker wall-time budget scales with node count", async () => {
    const { atlasWorkerBudgetMs } = await import("./atlasLayout");
    expect(atlasWorkerBudgetMs(10571)).toBeGreaterThanOrEqual(15000);
    expect(atlasWorkerBudgetMs(100)).toBe(5000);
    expect(atlasWorkerBudgetMs(1e6)).toBe(25000);
  });

  it("slice size collapses to 1 iteration past 5k nodes (no long tasks)", () => {
    expect(atlasSliceSize(10571)).toBe(1); // the vault size that froze the app
    expect(atlasSliceSize(3000)).toBe(3);
    expect(atlasSliceSize(200)).toBe(30);
  });
});

describe("applyAtlasLayout (chunked)", () => {
  it("completes, reports monotonic progress, and fits to the target radius", async () => {
    const g = ringGraph(60);
    const seen: number[] = [];
    const completed = await applyAtlasLayout(g, {
      targetRadius: 500,
      iterations: 40,
      noWorker: true,
      onProgress: (done) => seen.push(done),
    });
    expect(completed).toBe(true);
    expect(seen.length).toBeGreaterThan(1); // really ran in multiple slices
    expect([...seen]).toEqual([...seen].sort((a, b) => a - b));
    expect(seen[seen.length - 1]).toBe(40);
    // Bounding radius lands on the requested world size.
    let r = 0;
    g.forEachNode((_id, a) => {
      r = Math.max(r, Math.hypot(a.x, a.y));
    });
    expect(r).toBeGreaterThan(400);
    expect(r).toBeLessThan(600);
  });

  it("aborts between slices when shouldAbort flips", async () => {
    const g = ringGraph(60);
    let calls = 0;
    const completed = await applyAtlasLayout(g, {
      targetRadius: 500,
      noWorker: true,
      iterations: 10_000, // would take ages if not aborted
      onProgress: () => {
        calls++;
      },
      shouldAbort: () => calls >= 2,
    });
    expect(completed).toBe(false);
    expect(calls).toBeLessThan(5); // stopped promptly, not after the full run
  });

  it("empty graph resolves immediately", async () => {
    const g = new Graph({ type: "undirected", multi: false }) as unknown as VaultGraph;
    await expect(applyAtlasLayout(g, { targetRadius: 100, noWorker: true })).resolves.toBe(true);
  });
});
