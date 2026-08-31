import { describe, expect, it } from "vitest";
import { wizardStepReady } from "./onboarding";

describe("wizardStepReady", () => {
  it("step 0 gates on a linked vault", () => {
    expect(wizardStepReady(0, "idle", false)).toBe(false);
    expect(wizardStepReady(0, "idle", true)).toBe(true);
  });

  it("step 1 (import) waits while a sweep is in flight", () => {
    expect(wizardStepReady(1, "idle", true, "sweeping")).toBe(false);
    expect(wizardStepReady(1, "idle", true, "importing-file")).toBe(false);
  });

  it("step 1 unlocks on done, error, and idle — skipping is always allowed", () => {
    expect(wizardStepReady(1, "idle", true, "done")).toBe(true);
    expect(wizardStepReady(1, "idle", true, "error")).toBe(true);
    expect(wizardStepReady(1, "idle", true, "idle")).toBe(true);
    // Callers without an import stage (older tests, storybook) default to idle.
    expect(wizardStepReady(1, "idle", true)).toBe(true);
  });

  it("step 2 waits while a build is in flight", () => {
    expect(wizardStepReady(2, "loading-model", true)).toBe(false);
    expect(wizardStepReady(2, "indexing", true)).toBe(false);
  });

  it("step 2 unlocks on done AND on error — a failed build never traps", () => {
    expect(wizardStepReady(2, "done", true)).toBe(true);
    expect(wizardStepReady(2, "error", true)).toBe(true);
  });

  it("step 2 with no build needed (idle: index already exists) is ready", () => {
    expect(wizardStepReady(2, "idle", true)).toBe(true);
  });

  it("history and ask steps are always ready", () => {
    expect(wizardStepReady(3, "idle", true)).toBe(true);
    expect(wizardStepReady(3, "indexing", false)).toBe(true);
    expect(wizardStepReady(4, "idle", true)).toBe(true);
  });
});
