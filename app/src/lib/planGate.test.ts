// Plan gate (Q4 item 7, Task 6) — pure selection helpers behind the pre-write
// checkbox review. NOOP items are pre-unchecked (they change nothing, the M4-b
// mockup dims them); everything else is pre-checked. selectedPlan is what the
// gated run actually feeds the writing agent, so its filtering is pinned here.

import { describe, expect, it } from "vitest";
import { defaultSelection, selectedPlan } from "./planGate";
import type { PlanItem } from "./ingestPlan";

function item(decision: PlanItem["decision"], subject = "s"): PlanItem {
  return {
    subject,
    decision,
    target: decision === "ADD" ? null : "existing-page",
    reason: "r",
  };
}

describe("defaultSelection", () => {
  it("unchecks NOOP items and checks everything else", () => {
    const plan = [item("ADD"), item("NOOP"), item("UPDATE"), item("MERGE")];
    expect(defaultSelection(plan)).toEqual([true, false, true, true]);
  });

  it("returns [] for an empty plan", () => {
    expect(defaultSelection([])).toEqual([]);
  });
});

describe("selectedPlan", () => {
  it("keeps exactly the checked items, in order", () => {
    const plan = [item("ADD", "a"), item("UPDATE", "b"), item("MERGE", "c")];
    const out = selectedPlan(plan, [true, false, true]);
    expect(out.map((p) => p.subject)).toEqual(["a", "c"]);
  });

  it("treats a missing selection entry as unchecked", () => {
    const plan = [item("ADD", "a"), item("UPDATE", "b")];
    expect(selectedPlan(plan, [true])).toEqual([plan[0]]);
  });

  it("returns [] for an empty plan and [] when nothing is checked", () => {
    expect(selectedPlan([], [])).toEqual([]);
    expect(selectedPlan([item("ADD")], [false])).toEqual([]);
  });
});
