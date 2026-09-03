// Back/forward history of the primary route (uiStore.navHistory). Pure.

import type { RouteId } from "../stores/uiStore";

export const HISTORY_CAP = 50;

export interface NavHistory {
  entries: RouteId[];
  idx: number;
}

/** Append `route` after the current entry, dropping any forward entries. No-op
 *  when it is already current; the oldest entry falls off past HISTORY_CAP. */
export function pushRoute(h: NavHistory, route: RouteId): NavHistory {
  if (h.entries[h.idx] === route) return h;
  const entries = [...h.entries.slice(0, h.idx + 1), route].slice(-HISTORY_CAP);
  return { entries, idx: entries.length - 1 };
}

/** Rename/move route sync: swap the current entry, no growth. */
export function replaceCurrent(h: NavHistory, route: RouteId): NavHistory {
  const entries = h.entries.slice();
  entries[h.idx] = route;
  return { entries, idx: h.idx };
}

/** One step back (-1) or forward (1); null when out of range. */
export function step(h: NavHistory, delta: -1 | 1): NavHistory | null {
  const idx = h.idx + delta;
  return idx >= 0 && idx < h.entries.length ? { entries: h.entries, idx } : null;
}

/** A persisted stack is trusted only if `route` sits at its idx; else `[route]`. */
export function sanitizeHistory(
  p: Partial<NavHistory> | undefined,
  route: RouteId,
): NavHistory {
  return p && Array.isArray(p.entries) && typeof p.idx === "number" && p.entries[p.idx] === route
    ? { entries: p.entries, idx: p.idx }
    : { entries: [route], idx: 0 };
}
