// `[[Note#Heading]]`: the anchor survives the route change in module state
// (not a store — it is consumed once, by the reader that opens the note) and
// is matched against the note's outline once its draft has been seeded.

import type { OutlineHeading } from "./outline";

const pending = new Map<string, string>();

/** Remember that `path`, once opened, should scroll to `heading`. */
export function setPendingAnchor(path: string, heading: string): void {
  pending.set(path, heading);
}

/** Take (and forget) the anchor recorded for `path`, if any. */
export function takePendingAnchor(path: string): string | undefined {
  const h = pending.get(path);
  pending.delete(path);
  return h;
}

// Both `[[Note#My Section]]` and `[[Note#my-section]]` must hit "My Section":
// compare slugs (lowercase, punctuation dropped, whitespace → "-").
function slug(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

/** First outline heading matching `anchor` (case/punctuation-insensitive). */
export function matchHeading(
  headings: readonly OutlineHeading[],
  anchor: string,
): OutlineHeading | undefined {
  const want = slug(anchor);
  return want ? headings.find((h) => slug(h.text) === want) : undefined;
}
