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
