// Pure builder for the agent write-confirm diff preview (W3–6 item 7).
// Feeds DiffView inside the confirm dialog so the user sees exactly what the
// agent is about to write before allowing it.

import { diffLines, type DiffLine } from "./wordDiff";

/** Per-side size cap, mirroring distill_run_diff's "too large to diff"
 * contract (measured in UTF-16 code units — a diff-cost cap, not storage). */
const SIZE_CAP = 64 * 1024;

export interface WritePreview {
  path: string;
  kind: "create" | "update";
  lines: DiffLine[];
  /** True when a side exceeds 64 KiB — `lines` is empty and the UI shows the
   * "too large to diff" copy instead of a partial diff. */
  truncated: boolean;
}

/** current = null ⇒ create (before = ""). */
export function buildWritePreview(
  path: string,
  current: string | null,
  next: string,
): WritePreview {
  const kind = current === null ? "create" : "update";
  const before = current ?? "";
  if (before.length > SIZE_CAP || next.length > SIZE_CAP) {
    return { path, kind, lines: [], truncated: true };
  }
  return { path, kind, lines: diffLines(before, next), truncated: false };
}
