// One-shot handoff of a draft question into the Ask page. Surfaces like the
// graph's gap panel compose a question ("what connects A and B?") and route to
// the query page; PageQuery consumes it on mount. A module-level slot instead
// of a store field so nothing persists and there is no re-render coupling.

let pending: string | null = null;

export function setQueryPrefill(q: string): void {
  pending = q;
}

/** Returns the pending draft once and clears it. */
export function takeQueryPrefill(): string | null {
  const p = pending;
  pending = null;
  return p;
}

/** Hand the pending draft to the composer: `fill` it, then `focus` it on the
 *  next frame (the input has mounted by then), so a keyboard flow begun
 *  elsewhere (⌘K "Ask the wiki: q") goes on there — the next Enter asks.
 *  False when there was no draft. */
export function consumeQueryPrefill(fill: (q: string) => void, focus: () => void): boolean {
  const draft = takeQueryPrefill();
  if (!draft) return false;
  fill(draft);
  requestAnimationFrame(() => focus());
  return true;
}
