import { beforeEach, describe, expect, it, vi } from "vitest";

const getActiveModel = vi.fn();
vi.mock("./chat", () => ({ getActiveModel: (...a: unknown[]) => getActiveModel(...a) }));

const runReflect = vi.fn();
let stage = "idle";
vi.mock("../stores/reflectStore", () => ({
  useReflectStore: { getState: () => ({ stage, runReflect }) },
}));

import { runReflectPass } from "./autoReflect";

describe("runReflectPass", () => {
  beforeEach(() => {
    getActiveModel.mockReset();
    runReflect.mockReset();
    stage = "idle";
  });

  it("skips the pass without touching the store when the query provider is builtin-local", async () => {
    getActiveModel.mockResolvedValue({ provider: "builtin-local", model: "" });

    await runReflectPass();

    expect(runReflect).not.toHaveBeenCalled();
  });

  it("runs the pass when a connected provider is active", async () => {
    getActiveModel.mockResolvedValue({ provider: "anthropic-cli", model: "sonnet" });

    await runReflectPass();

    expect(runReflect).toHaveBeenCalledTimes(1);
  });

  it("skips without even checking the provider while a run is already in flight", async () => {
    stage = "running";

    await runReflectPass();

    expect(getActiveModel).not.toHaveBeenCalled();
    expect(runReflect).not.toHaveBeenCalled();
  });
});
