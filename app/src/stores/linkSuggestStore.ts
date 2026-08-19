// Shared state behind "suggested links": Overview's LinkSuggestions card and
// the Topbar activity popover must agree on the pending count, so the
// semantic edges + dismissed set live here instead of the card's own useState
// (where the Topbar could not see them, and a dismissal would not move the
// count until a remount). Both readers derive their lists/counts with the
// pure helpers in lib/linkSuggestions.ts.

import { create } from "zustand";
import { ipc, type SemEdge } from "../lib/ipc";
import { loadDismissed, saveDismissed } from "../lib/linkSuggestions";

interface LinkSuggestState {
  /** Semantic-similarity pairs; null until the first fetch answers. */
  sem: SemEdge[] | null;
  dismissed: Set<string>;
  /** Fetch semantic edges once per adjacency snapshot. Both readers key
   * their refresh on the link graph's adjacency object (it is rebuilt on
   * vault settle and after every accept — the retry signal), so dedupe by
   * reference to avoid a double fetch when both are mounted. */
  refresh: (adjacency: unknown) => Promise<void>;
  dismiss: (keys: Iterable<string>) => void;
}

let lastAdjacency: unknown = Symbol("never fetched");

export const useLinkSuggestStore = create<LinkSuggestState>((set, get) => ({
  sem: null,
  dismissed: loadDismissed(),

  async refresh(adjacency) {
    if (adjacency === lastAdjacency) return;
    lastAdjacency = adjacency;
    const edges = await ipc.semanticEdges(4).catch(() => [] as SemEdge[]);
    set({ sem: edges });
  },

  dismiss(keys) {
    const next = new Set(get().dismissed);
    for (const k of keys) next.add(k);
    saveDismissed(next);
    set({ dismissed: next });
  },
}));
