import { beforeEach, describe, expect, it, vi } from "vitest";

const runReflect = vi.fn();
let stage = "idle";
let vaultPath = "/synthetic-reflect";
const vaultRevision = vi.fn();
vi.mock("./ipc", () => ({ ipc: { vaultRevision: (...args: unknown[]) => vaultRevision(...args) } }));
vi.mock("../stores/vaultStore", () => ({ useVaultStore: { getState: () => ({ currentVault: { path: vaultPath }, vaultToken: "synthetic-token" }) } }));
vi.mock("../stores/reflectStore", () => ({
  useReflectStore: { getState: () => ({ stage, runReflect }) },
}));

import { runReflectPass, runReflectTick } from "./autoReflect";

describe("runReflectPass", () => {
  beforeEach(() => {
    runReflect.mockReset();
    stage = "idle";
  });

  it("runs the pass regardless of provider — builtin-local reflects extractively now", async () => {
    await runReflectPass();

    expect(runReflect).toHaveBeenCalledTimes(1);
  });

  it("skips while a run is already in flight", async () => {
    stage = "running";

    await runReflectPass();

    expect(runReflect).not.toHaveBeenCalled();
  });

  it("retries the same revision after a failed scheduled pass", async () => {
    vaultPath = "/synthetic-reflect-failure";
    vaultRevision.mockResolvedValue(42);
    runReflect.mockImplementation(async () => { stage = "error"; });
    await runReflectTick();
    await runReflectTick();
    expect(runReflect).toHaveBeenCalledTimes(2);
  });

  it("does not consume a revision while another pass is running", async () => {
    vaultPath = "/synthetic-reflect-busy";
    vaultRevision.mockResolvedValue(42);
    stage = "running";
    await runReflectTick();
    stage = "idle";
    runReflect.mockImplementation(async () => { stage = "done"; });
    await runReflectTick();
    expect(runReflect).toHaveBeenCalledTimes(1);
  });

  it("deduplicates a successful scheduled revision but retries a later revision", async () => {
    vaultPath = "/synthetic-reflect-success";
    vaultRevision.mockResolvedValue(42);
    runReflect.mockImplementation(async () => { stage = "done"; });
    await runReflectTick();
    await runReflectTick();
    expect(runReflect).toHaveBeenCalledTimes(1);
    vaultRevision.mockResolvedValue(43);
    await runReflectTick();
    expect(runReflect).toHaveBeenCalledTimes(2);
  });
});
