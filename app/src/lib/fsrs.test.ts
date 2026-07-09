import { describe, expect, it } from "vitest";
import {
  daysBetween,
  initState,
  intervalDays,
  isDue,
  nextState,
  type CardState,
} from "./fsrs";

const T0 = "2026-01-01";

describe("fsrs", () => {
  it("daysBetween + isDue", () => {
    expect(daysBetween("2026-01-01", "2026-01-08")).toBe(7);
    expect(daysBetween("2026-01-10", "2026-01-01")).toBe(-9);
    const s: CardState = {
      stability: 1,
      difficulty: 5,
      reps: 1,
      lapses: 0,
      due: "2026-01-05",
      lastReview: "2026-01-01",
    };
    expect(isDue(s, "2026-01-05")).toBe(true);
    expect(isDue(s, "2026-01-04")).toBe(false);
  });

  it("initState: Again resets short, keeps difficulty in range", () => {
    const again = initState(1, T0);
    expect(again.lapses).toBe(1);
    expect(again.reps).toBe(0);
    expect(daysBetween(T0, again.due)).toBe(1);
    for (const g of [1, 2, 3, 4] as const) {
      const s = initState(g, T0);
      expect(s.difficulty).toBeGreaterThanOrEqual(1);
      expect(s.difficulty).toBeLessThanOrEqual(10);
    }
  });

  it("initState: higher grade → longer interval", () => {
    const hard = daysBetween(T0, initState(2, T0).due);
    const good = daysBetween(T0, initState(3, T0).due);
    const easy = daysBetween(T0, initState(4, T0).due);
    expect(easy).toBeGreaterThanOrEqual(good);
    expect(good).toBeGreaterThanOrEqual(hard);
  });

  it("nextState: repeated Good grows the interval; Again collapses it", () => {
    let s = initState(3, T0);
    const firstInterval = daysBetween(s.lastReview, s.due);
    // Review Good again on the due date → interval should grow.
    s = nextState(s, 3, s.due);
    const secondInterval = daysBetween(s.lastReview, s.due);
    expect(secondInterval).toBeGreaterThan(firstInterval);
    expect(s.reps).toBe(2);

    // Now fail it → due tomorrow, lapse recorded, stability drops.
    const beforeStability = s.stability;
    const failed = nextState(s, 1, s.due);
    expect(daysBetween(failed.lastReview, failed.due)).toBe(1);
    expect(failed.lapses).toBe(1);
    expect(failed.stability).toBeLessThan(beforeStability);
    expect(failed.difficulty).toBeGreaterThanOrEqual(1);
    expect(failed.difficulty).toBeLessThanOrEqual(10);
  });

  it("nextState: Easy interval ≥ Good interval from the same state", () => {
    const base = initState(3, T0);
    const good = daysBetween(base.due, nextState(base, 3, base.due).due);
    const easy = daysBetween(base.due, nextState(base, 4, base.due).due);
    expect(easy).toBeGreaterThanOrEqual(good);
  });

  it("intervalDays grows with stability and is ≥ 1", () => {
    expect(intervalDays(0.01)).toBeGreaterThanOrEqual(1);
    expect(intervalDays(50)).toBeGreaterThan(intervalDays(5));
  });
});
