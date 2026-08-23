import { describe, expect, it } from "vitest";
import { wizardStepReady } from "./onboarding";

describe("wizardStepReady", () => {
  it("step 1 gates on a linked vault", () => {
    expect(wizardStepReady(0, "idle", false)).toBe(false);
    expect(wizardStepReady(0, "idle", true)).toBe(true);
  });

  it("step 2 waits while a build is in flight", () => {
    expect(wizardStepReady(1, "loading-model", true)).toBe(false);
    expect(wizardStepReady(1, "indexing", true)).toBe(false);
  });

  it("step 2 unlocks on done AND on error — a failed build never traps", () => {
    expect(wizardStepReady(1, "done", true)).toBe(true);
    expect(wizardStepReady(1, "error", true)).toBe(true);
  });

  it("step 2 with no build needed (idle: index already exists) is ready", () => {
    expect(wizardStepReady(1, "idle", true)).toBe(true);
  });

  it("step 3 is always ready", () => {
    expect(wizardStepReady(2, "idle", true)).toBe(true);
    expect(wizardStepReady(2, "indexing", false)).toBe(true);
  });
});
