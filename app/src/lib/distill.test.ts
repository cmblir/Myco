import { describe, expect, it } from "vitest";
import { backlogTrend } from "./distill";

describe("backlogTrend", () => {
  it("flat with fewer than two samples", () => {
    expect(backlogTrend([])).toBe("flat");
    expect(backlogTrend([5])).toBe("flat");
  });

  it("shrinking when the newest sample is below the oldest", () => {
    expect(backlogTrend([9, 7, 4])).toBe("shrinking");
  });

  it("growing when the newest sample is above the oldest", () => {
    expect(backlogTrend([2, 5, 9])).toBe("growing");
  });

  it("flat when the oldest and newest samples are equal", () => {
    expect(backlogTrend([5, 9, 5])).toBe("flat");
  });
});
