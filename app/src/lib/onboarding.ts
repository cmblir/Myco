// First-run wizard gating (M10). Kept out of the component so the rule that
// decides when a step may be left is testable in the node-only vitest env.

import type { ReindexStage } from "../stores/reindexStore";

/**
 * Whether the wizard's Next button may advance from `step`.
 *
 * Step 2 waits for the first index build, but unlocks on `error` as well as
 * `done`: a failed build shows its message and still lets the user through —
 * the wizard must never become a trap between a broken index and the app.
 */
export function wizardStepReady(
  step: number,
  reindexStage: ReindexStage,
  hasVault: boolean,
): boolean {
  if (step === 0) return hasVault;
  if (step === 1) return reindexStage !== "loading-model" && reindexStage !== "indexing";
  return true;
}
