import { beforeEach, expect, it, vi } from "vitest";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { ipc } from "./ipc";

beforeEach(() => { invoke.mockReset().mockResolvedValue(null); });

it("sends the confirmed policy across all destructive IPC boundaries", async () => {
  await ipc.deletePath("/synthetic/wiki/a.md", false);
  await ipc.trashPaths(["/synthetic/_inbox/quarantine/a.md"], true);
  await ipc.applyDistillProposal("/synthetic", "work/feedback/delete.md", false);
  expect(invoke.mock.calls).toEqual([
    ["delete_path", { path: "/synthetic/wiki/a.md", expectedPermanent: false }],
    ["trash_paths", { paths: ["/synthetic/_inbox/quarantine/a.md"], expectedPermanent: true }],
    ["apply_distill_proposal", { vault: "/synthetic", path: "work/feedback/delete.md", expectedPermanent: false }],
  ]);
});

it("propagates a changed-policy rejection instead of retrying irreversible deletion", async () => {
  invoke.mockRejectedValue("deletion policy changed");
  await expect(ipc.deletePath("/synthetic/wiki/a.md", false)).rejects.toBe("deletion policy changed");
  expect(invoke).toHaveBeenCalledTimes(1);
});
