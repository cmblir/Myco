// @vitest-environment jsdom
//
// Regression for the archive-compress mock: `compress_archives` used to
// compare every bucket's id (both `daily`'s YYYY-Www and `sessions`'s
// YYYY-MM) against a single YYYY-MM cutoff. 'W' sorts above every digit, so
// a daily bucket's id was never < the cutoff and never compressed — this
// mock is the only pre-install verification the Archive storage panel gets.
import { describe, expect, it } from "vitest";
import { installTauriMock } from "./devMock";
import type { BucketUsage, PackReport } from "./distill";

function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const w = window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a: unknown) => Promise<T> } };
  return w.__TAURI_INTERNALS__.invoke(cmd, args);
}

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
  });
});
