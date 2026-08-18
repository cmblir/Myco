import { describe, expect, it } from "vitest";
import {
  SPLIT_DEFAULT_RATIO,
  SPLIT_MIN_PANE,
  clampSplitRatio,
} from "./splitRatio";

describe("clampSplitRatio", () => {
  it("passes through ratios that leave both panes above the minimum", () => {
    expect(clampSplitRatio(0.5, 1000)).toBe(0.5);
    expect(clampSplitRatio(0.3, 1000)).toBe(0.3);
  });

  it("clamps so neither pane drops below SPLIT_MIN_PANE", () => {
    expect(clampSplitRatio(0.01, 1000)).toBe(SPLIT_MIN_PANE / 1000);
    expect(clampSplitRatio(0.99, 1000)).toBe(1 - SPLIT_MIN_PANE / 1000);
  });

  it("respects a custom minimum", () => {
    expect(clampSplitRatio(0, 1000, 100)).toBe(0.1);
    expect(clampSplitRatio(1, 1000, 100)).toBe(0.9);
  });

  it("pins to the middle when the container cannot fit two minimums", () => {
    expect(clampSplitRatio(0.2, SPLIT_MIN_PANE * 2 - 1)).toBe(SPLIT_DEFAULT_RATIO);
    expect(clampSplitRatio(0.2, 0)).toBe(SPLIT_DEFAULT_RATIO);
    expect(clampSplitRatio(0.2, NaN)).toBe(SPLIT_DEFAULT_RATIO);
  });

  it("falls back to the default on a non-finite ratio", () => {
    expect(clampSplitRatio(NaN, 1000)).toBe(SPLIT_DEFAULT_RATIO);
    expect(clampSplitRatio(Infinity, 1000)).toBe(SPLIT_DEFAULT_RATIO);
  });
});
