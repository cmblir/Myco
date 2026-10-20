import { beforeEach, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { ipc } from "./ipc";

const origin = { vaultPath: "/synthetic", openingToken: "synthetic-opening-a" };
beforeEach(() => invoke.mockReset().mockResolvedValue(1));

it("passes the captured Keep opening without refreshing its authority", async () => {
  expect(await ipc.extendQuarantine(origin.vaultPath, ["_inbox/quarantine/note.md"], 7, origin)).toBe(1);
  expect(invoke.mock.calls).toEqual([["extend_quarantine", {
    vault: origin.vaultPath, files: ["_inbox/quarantine/note.md"], days: 7, origin,
  }]]);
});

it("rejects Keep without a captured opening before native dispatch", async () => {
  await expect(ipc.extendQuarantine(origin.vaultPath, [], 7)).rejects.toThrow("opening");
  expect(invoke).not.toHaveBeenCalled();
});

it("rejects empty and mismatched Keep origins without capturing a new one", async () => {
  await expect(ipc.extendQuarantine(origin.vaultPath, [], 7, { ...origin, openingToken: "" })).rejects.toThrow("opening");
  await expect(ipc.extendQuarantine("/other", [], 7, origin)).rejects.toThrow("opening");
  expect(invoke).not.toHaveBeenCalled();
});
