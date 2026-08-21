//
// Regression for the archive-compress mock: `compress_archives` used to
// compare every bucket's id (both `daily`'s YYYY-Www and `sessions`'s
// YYYY-MM) against a single YYYY-MM cutoff. 'W' sorts above every digit, so
// a daily bucket's id was never < the cutoff and never compressed — this
// mock is the only pre-install verification the Archive storage panel gets.
import { beforeAll, describe, expect, it } from "vitest";
import { installTauriMock } from "./devMock";
import type { BucketUsage, PackReport } from "./distill";

function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const w = window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a: unknown) => Promise<T> } };
  return w.__TAURI_INTERNALS__.invoke(cmd, args);
}

// `installTauriMock` writes its globals onto `window`, which the node
// environment has no equivalent of. A one-line alias beats pulling in jsdom:
// this file used to ask for the jsdom environment in a docblock, and since
// jsdom is not a dependency of this project, vitest failed to load the
// environment and the whole file silently collected ZERO tests.
beforeAll(() => {
  (globalThis as unknown as { window?: unknown }).window ??= globalThis;
});

describe("devMock archive compression", () => {
  it("compresses at least one bucket in each tree, not just sessions", async () => {
    installTauriMock();

    const report = await invoke<PackReport>("compress_archives", {
      vault: "irrelevant",
      olderThanMonths: 3,
    });
    expect(report.buckets).toBeGreaterThan(0);

    const usage = await invoke<BucketUsage[]>("archive_usage", { vault: "irrelevant" });
    const packedTrees = new Set(usage.filter((b) => b.packed).map((b) => b.tree));
    expect(packedTrees.has("sessions")).toBe(true);
    expect(packedTrees.has("daily")).toBe(true);
    // Third tree, added with the monthly rollup layer: its buckets are months
    // like sessions', so a "weekly means week-shaped ids" assumption in the
    // cutoff would leave it uncompressed forever.
    expect(packedTrees.has("weekly")).toBe(true);
  });
});
