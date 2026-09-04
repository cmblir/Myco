// chipMode is the chip-state derivation behind the Topbar activity system:
// 0 running → no chip, exactly 1 → that activity's own chip, 2+ → the
// collapsed count chip. Standing states (suggested links, MCP) never reach it
// by construction — callers pass RUNNING activities only — so the count here
// IS the badge number.

import { describe, expect, it } from "vitest";
import { chipMode, distillFraction } from "./ActivityChip";
import type { RunningActivity } from "./ActivityChip";

const ask: RunningActivity = { icon: "ask", label: "Ask", detail: "0:12" };
const distill: RunningActivity = {
  icon: "distill",
  label: "Distilling…",
  detail: "the core pass",
};
const reflect: RunningActivity = {
  // Reflect borrows the distill icon — the set has no reflect art.
  icon: "distill",
  label: "Reflect running…",
  detail: "",
};
const indexing: RunningActivity = {
  icon: "indexing",
  label: "Indexing…",
  detail: "218/302",
};

describe("chipMode", () => {
  it("renders no chip at all for zero running activities", () => {
    expect(chipMode([])).toEqual({ kind: "none" });
  });

  it("gives a single running activity its own chip", () => {
    expect(chipMode([indexing])).toEqual({ kind: "single", activity: indexing });
  });

  it("collapses two runners into a count chip led by the first (priority) icon", () => {
    expect(chipMode([ask, indexing])).toEqual({
      kind: "multi",
      count: 2,
      icon: "ask",
    });
  });

  it("counts all three when everything runs at once", () => {
    expect(chipMode([ask, distill, indexing])).toEqual({
      kind: "multi",
      count: 3,
      icon: "ask",
    });
  });

  // Reflect is a running activity like any other: alone it gets its own chip,
  // and it counts toward the collapsed badge.
  it("gives a lone running reflect its own chip", () => {
    expect(chipMode([reflect])).toEqual({ kind: "single", activity: reflect });
  });

  it("counts a running reflect in the collapsed badge", () => {
    expect(chipMode([distill, reflect])).toEqual({
      kind: "multi",
      count: 2,
      icon: "distill",
    });
    expect(chipMode([ask, distill, reflect, indexing])).toEqual({
      kind: "multi",
      count: 4,
      icon: "ask",
    });
  });
});

// The chip ring fills one notch per chain phase, in run order; an unknown or
// idle step reads as "just started" rather than throwing the ring off.
describe("distillFraction", () => {
  it("walks 0 → <1 across the chain in run order", () => {
    expect(distillFraction("run")).toBe(0);
    expect(distillFraction("digest")).toBeCloseTo(1 / 7);
    expect(distillFraction("resurface")).toBeCloseTo(6 / 7);
    expect(distillFraction("resurface")).toBeLessThan(1);
  });

  it("treats idle as the start", () => {
    expect(distillFraction(null)).toBe(0);
  });
});
