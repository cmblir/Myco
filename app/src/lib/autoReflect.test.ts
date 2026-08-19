import { beforeEach, describe, expect, it, vi } from "vitest";

const runReflect = vi.fn();
let stage = "idle";
vi.mock("../stores/reflectStore", () => ({
  useReflectStore: { getState: () => ({ stage, runReflect }) },
}));

import { runReflectPass } from "./autoReflect";

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
});
