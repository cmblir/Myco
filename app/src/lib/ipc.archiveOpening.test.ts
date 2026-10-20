import { beforeEach, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { ipc } from "./ipc";

const origin = { vaultPath: "/synthetic", openingToken: "synthetic-first-opening" };
beforeEach(() => {
  invoke.mockReset().mockResolvedValue(null);
});

it("passes the captured opening to archive measurement", async () => {
  await ipc.archiveUsage(origin.vaultPath, origin);
  expect(invoke).toHaveBeenCalledWith("archive_usage", { vault: origin.vaultPath, origin });
});

it("passes the captured opening to pack without refreshing its authority", async () => {
  await ipc.compressArchives(origin.vaultPath, 3, origin);
  expect(invoke.mock.calls).toEqual([["compress_archives", { vault: origin.vaultPath, olderThanMonths: 3, origin }]]);
});

it("passes the captured opening to restore without refreshing its authority", async () => {
  await ipc.restoreArchiveBucket(origin.vaultPath, "sessions", "2026-01", origin);
  expect(invoke.mock.calls).toEqual([["restore_archive_bucket", { vault: origin.vaultPath, tree: "sessions", bucket: "2026-01", origin }]]);
});

it("rejects legacy calls with no captured opening before native dispatch", async () => {
  await expect(ipc.archiveUsage(origin.vaultPath)).rejects.toThrow("opening");
  await expect(ipc.compressArchives(origin.vaultPath, 3)).rejects.toThrow("opening");
  await expect(ipc.restoreArchiveBucket(origin.vaultPath, "sessions", "2026-01")).rejects.toThrow("opening");
  expect(invoke).not.toHaveBeenCalled();
});

it("rejects empty and mismatched captured openings before native dispatch", async () => {
  await expect(ipc.compressArchives(origin.vaultPath, 3, { ...origin, openingToken: "" })).rejects.toThrow("opening");
  await expect(ipc.restoreArchiveBucket("/other", "sessions", "2026-01", origin)).rejects.toThrow("opening");
  await expect(ipc.archiveUsage("/other", origin)).rejects.toThrow("opening");
  expect(invoke).not.toHaveBeenCalled();
});
