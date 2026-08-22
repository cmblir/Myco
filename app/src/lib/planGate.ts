// Plan gate (Q4 item 7, Task 6) — pure helpers for the pre-write checkbox
// review of an ingest plan. The store pauses a manual run at stage "plan-gate"
// and the M4-b card collects a boolean per plan item; these two functions are
// the whole policy: what starts checked, and what the checked subset is.

import type { PlanItem } from "./ingestPlan";

/** Default checkbox state per plan item: NOOP ⇒ unchecked (already covered,
 * changes nothing — the mockup dims it), everything else checked. */
export function defaultSelection(plan: PlanItem[]): boolean[] {
  return plan.map((p) => p.decision !== "NOOP");
}

/** The plan items whose checkbox is on. A missing `sel` entry is unchecked. */
export function selectedPlan(plan: PlanItem[], sel: boolean[]): PlanItem[] {
  return plan.filter((_, i) => sel[i] === true);
}
