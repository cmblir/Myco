import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isIdle, markActivity } from "./idle";

// Exercises the pure activity-tracking core (markActivity/isIdle) that both
// scheduleTimer's poll and the useIdle hook build on. There is no
// @testing-library/react in this repo, so the hook's window listener wiring
// itself is verified by the headless screenshot / manual check, not here.
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
