// First-run wizard gating (M10, import-first reshape). Kept out of the
// component so the rule that decides when a step may be left is testable in
// the node-only vitest env.

import type { ReindexStage } from "../stores/reindexStore";
import type { ImportStage } from "../stores/importStore";

/** Wizard step order. Import sits between vault pick and the first index so
 *  the index build covers whatever the sweep just brought in — the point of
 *  import-first onboarding is that the first Ask answers from the user's own
 *  history, not an empty vault. */
export const WIZARD_STEPS = 5;

/**
 * Whether the wizard's Next button may advance from `step`.
 *
 * Step 1 (import) and step 2 (index) wait while their work runs, but both
 * unlock on error as well as done: a failed sweep or index build shows its
 * message and still lets the user through — the wizard must never become a
 * trap between a broken step and the app.
 */
export function wizardStepReady(
  step: number,
  reindexStage: ReindexStage,
  hasVault: boolean,
  importStage: ImportStage = "idle",
): boolean {
  if (step === 0) return hasVault;
  if (step === 1) return importStage !== "sweeping" && importStage !== "importing-file";
  if (step === 2) return reindexStage !== "loading-model" && reindexStage !== "indexing";
  return true;
}
