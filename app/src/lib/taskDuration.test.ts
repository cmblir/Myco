import { describe, expect, it } from "vitest";
import { formatDuration, normalizeDuration, parseDuration } from "./taskDuration";

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

describe("normalizeDuration", () => {
  it("turns a Korean duration into the stored token", () => {
    expect(normalizeDuration("2일")).toBe("2d");
    expect(normalizeDuration("1주")).toBe("1w");
    expect(normalizeDuration("3시간")).toBe("3h");
    expect(normalizeDuration("1.5 시간")).toBe("1.5h");
    expect(normalizeDuration(" 30분 ")).toBe("30m");
  });
  it("leaves a token, and anything it cannot read, as typed", () => {
    expect(normalizeDuration(" 2d ")).toBe("2d");
    expect(normalizeDuration("두 시간")).toBe("두 시간");
    expect(normalizeDuration("")).toBe("");
  });
});
