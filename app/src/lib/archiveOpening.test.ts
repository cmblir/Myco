import { beforeEach, expect, it, vi } from "vitest";

const { session } = vi.hoisted(() => ({ session: vi.fn() }));
vi.mock("./ipc", () => ({ ipc: { agentVaultSession: session } }));
import { captureArchiveOpening } from "./archiveOpening";

const origin = { vaultPath: "/synthetic", openingToken: "synthetic-opening" };
beforeEach(() => {
  session.mockReset().mockResolvedValue(origin);
});

it("retains the native opening as an immutable action snapshot", async () => {
  const captured = await captureArchiveOpening(origin.vaultPath, () => true);
  expect(captured).toEqual(origin);
  expect(captured).not.toBe(origin);
  expect(Object.isFrozen(captured)).toBe(true);
  expect(session).toHaveBeenCalledTimes(1);
});

it("does not request authority for a stale visible action", async () => {
  await expect(captureArchiveOpening(origin.vaultPath, () => false)).rejects.toThrow("changed");
  expect(session).not.toHaveBeenCalled();
});

it("rejects same-path reopen while the native snapshot is pending", async () => {
  let finish!: (value: typeof origin) => void;
  session.mockImplementation(() => new Promise<typeof origin>((resolve) => { finish = resolve; }));
  let generation = 1;
  const capture = captureArchiveOpening(origin.vaultPath, () => generation === 1);
  generation = 2;
  finish({ ...origin, openingToken: "synthetic-new-opening" });
  await expect(capture).rejects.toThrow("changed");
  expect(session).toHaveBeenCalledTimes(1);
});

it("rejects native path mismatch and missing token without reacquiring authority", async () => {
  session.mockResolvedValueOnce({ ...origin, vaultPath: "/other" });
  await expect(captureArchiveOpening(origin.vaultPath, () => true)).rejects.toThrow("changed");
  session.mockResolvedValueOnce({ ...origin, openingToken: "" });
  await expect(captureArchiveOpening(origin.vaultPath, () => true)).rejects.toThrow("changed");
  expect(session).toHaveBeenCalledTimes(2);
});

it("propagates native session failure without retrying", async () => {
  session.mockRejectedValueOnce(new Error("synthetic native session unavailable"));
  await expect(captureArchiveOpening(origin.vaultPath, () => true)).rejects.toThrow("unavailable");
  expect(session).toHaveBeenCalledTimes(1);
});
