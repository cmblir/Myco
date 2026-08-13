import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isIdle, markActivity } from "./idle";

// Exercises the activity-tracking core (markActivity/isIdle) that
// scheduleTimer's poll relies on directly (it's a plain async function, not
// a component, so it can't use a hook — see idle.ts).
describe("idle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    markActivity(); // baseline: activity right now
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is not idle immediately after activity", () => {
    expect(isIdle(5)).toBe(false);
  });

  it("fires true once the given minutes elapse", () => {
    vi.advanceTimersByTime(5 * 60_000);
    expect(isIdle(5)).toBe(true);
  });

  it("resets when activity is marked again (pointermove/keydown)", () => {
    vi.advanceTimersByTime(5 * 60_000);
    expect(isIdle(5)).toBe(true);
    markActivity();
    expect(isIdle(5)).toBe(false);
  });

  it("clamps idle_minutes: 0 to 1 (Task 2 ledger note)", () => {
    vi.advanceTimersByTime(59_000);
    expect(isIdle(0)).toBe(false);
    vi.advanceTimersByTime(2_000);
    expect(isIdle(0)).toBe(true);
  });
});
