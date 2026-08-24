import { describe, expect, it } from "vitest";
import { formatDuration, parseDuration } from "./taskDuration";

describe("parseDuration", () => {
  it("reads the four units into minutes", () => {
    expect(parseDuration("90m")).toBe(90);
    expect(parseDuration("2h")).toBe(120);
    expect(parseDuration("2d")).toBe(2 * 8 * 60);
    expect(parseDuration("1w")).toBe(5 * 8 * 60);
  });
  it("accepts a decimal and surrounding space", () => {
    expect(parseDuration("1.5h")).toBe(90);
    expect(parseDuration("  3d ")).toBe(3 * 8 * 60);
  });
  it("rejects anything else", () => {
    for (const bad of ["", "2", "h", "2x", "-1h", "two hours"]) {
      expect(parseDuration(bad)).toBeNull();
    }
  });
});

describe("formatDuration", () => {
  it("picks the largest unit that stays whole", () => {
    expect(formatDuration(90)).toBe("1.5h");
    expect(formatDuration(45)).toBe("45m");
    expect(formatDuration(480)).toBe("1d");
    expect(formatDuration(2400)).toBe("1w");
  });
  it("round-trips every parseable token", () => {
    for (const s of ["30m", "2h", "1.5h", "2d", "1w"]) {
      expect(formatDuration(parseDuration(s) as number)).toBe(s);
    }
  });
});
