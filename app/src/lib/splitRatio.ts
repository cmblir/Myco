// Split-view divider math. Pure so the clamp rules are unit-testable.

/** Neither pane may shrink below this many pixels while dragging. */
export const SPLIT_MIN_PANE = 240;

/** Default primary-pane share of the split container. */
export const SPLIT_DEFAULT_RATIO = 0.5;

/**
 * Clamp a primary-pane ratio so both panes keep at least `minPx` of the
 * container's `totalPx`. A container too small to fit two minimums (or an
 * unmeasurable one) pins the divider to the middle; a non-finite ratio
 * falls back to the default.
 */
export function clampSplitRatio(
  ratio: number,
  totalPx: number,
  minPx: number = SPLIT_MIN_PANE,
): number {
  if (!Number.isFinite(ratio)) return SPLIT_DEFAULT_RATIO;
  if (!Number.isFinite(totalPx) || totalPx < minPx * 2) return SPLIT_DEFAULT_RATIO;
  const min = minPx / totalPx;
  return Math.min(Math.max(ratio, min), 1 - min);
}
