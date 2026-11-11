import { beforeEach, expect, it, vi } from "vitest";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { ipc } from "./ipc";
import { roleFixture } from "./modelRoles.testSupport";

const origin = { vaultPath: "/synthetic", openingToken: "synthetic-opening" };
const roleSnapshot = roleFixture("organization", "builtin-local", undefined, origin);
const snapshotId = "c".repeat(64);
beforeEach(() => invoke.mockReset().mockResolvedValue(null));

it("uses native capture and opaque check/release contracts without accepting source JSON as authority", async () => {
  await ipc.captureMapSources(origin, roleSnapshot, ["wiki/a.md"]);
  await ipc.checkMapSources(origin, roleSnapshot, snapshotId);
  await ipc.releaseMapSources(origin, snapshotId);
  expect(invoke.mock.calls).toEqual([
    ["capture_map_sources", { origin, roleSnapshot, members: ["wiki/a.md"] }],
    ["check_map_sources", { origin, roleSnapshot, snapshotId }],
    ["release_map_sources", { origin, snapshotId }],
  ]);
});

it("carries the retained native source id into map publication", async () => {
  await ipc.publishDistillNote(origin, "llm-map", { kind: "map", key: "synthetic" }, "Synthetic body.", null, roleSnapshot, snapshotId);
  expect(invoke).toHaveBeenCalledWith("publish_distill_note", {
    origin, operationId: "llm-map", artifact: { kind: "map", key: "synthetic" }, content: "Synthetic body.",
    expectedSha256: null, roleSnapshot, mapSourceSnapshotId: snapshotId,
  });
});
