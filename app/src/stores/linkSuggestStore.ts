// Shared state behind "suggested links": Overview's LinkSuggestions card and
// the Topbar activity popover must agree on the pending count, so the
// semantic edges + dismissed set live here instead of the card's own useState
// (where the Topbar could not see them, and a dismissal would not move the
// count until a remount). Both readers derive their lists/counts with the
// pure helpers in lib/linkSuggestions.ts.

import { create } from "zustand";
import { ipc, type SemEdge } from "../lib/ipc";
import { loadDismissed, saveDismissed } from "../lib/linkSuggestions";
import { useVaultStore } from "./vaultStore";
import { notice } from "../lib/notice";
import { STRINGS } from "../lib/i18n";
import { useUIStore } from "./uiStore";

interface LinkSuggestState {
  /** Semantic-similarity pairs; null until the first fetch answers. */
  sem: SemEdge[] | null;
  dismissed: Set<string>;
  busy: boolean;
  error: string | null;
  beginAction: () => boolean;
  endAction: () => void;
  /** Fetch semantic edges once per adjacency snapshot. Both readers key
   * their refresh on the link graph's adjacency object (it is rebuilt on
   * vault settle and after every accept — the retry signal), so dedupe by
   * reference to avoid a double fetch when both are mounted. */
  refresh: (adjacency: unknown) => Promise<void>;
  dismiss: (keys: Iterable<string>) => boolean;
}

let lastAdjacency: unknown = Symbol("never fetched");
let lastVault: string | null = null;
let requestSeq = 0;

export const useLinkSuggestStore = create<LinkSuggestState>((set, get) => ({
  sem: null,
  dismissed: loadDismissed(),
  busy: false,
  error: null,
  beginAction() {
    if (get().busy) return false;
    set({ busy: true });
    return true;
  },
  endAction() { set({ busy: false }); },

  async refresh(adjacency) {
    const root = useVaultStore.getState().currentVault?.path ?? null;
    const token = useVaultStore.getState().vaultToken;
    if (root !== lastVault) {
      lastVault = root;
      lastAdjacency = Symbol("changed vault");
      requestSeq++;
      set({ sem: null, error: null });
    }
    if (!root || !adjacency) return;
    if (adjacency === lastAdjacency) return;
    lastAdjacency = adjacency;
    // A cold index or a busy embedder makes this throw. Keep what we already
    // showed rather than emptying the panel: the suggestions were true a
    // moment ago, and an empty list reads as "nothing to link".
    const seq = ++requestSeq;
    try {
      const edges = await ipc.semanticEdges(4);
      if (seq !== requestSeq || useVaultStore.getState().currentVault?.path !== root || useVaultStore.getState().vaultToken !== token) return;
      const prefix = `${root.replace(/\\/g, "/").replace(/\/+$/, "")}/`;
      set({ sem: edges.filter((e) => e.source.replace(/\\/g, "/").startsWith(prefix) && e.target.replace(/\\/g, "/").startsWith(prefix)), error: null });
    } catch (error) {
      if (seq !== requestSeq || useVaultStore.getState().currentVault?.path !== root || useVaultStore.getState().vaultToken !== token) return;
      lastAdjacency = Symbol("retry after failure");
      set({ error: String(error) });
    }
  },

  dismiss(keys) {
    const added = [...keys];
    const next = new Set(get().dismissed);
    for (const k of added) next.add(k);
    try {
      saveDismissed(next);
      set({ dismissed: next });
      return true;
    }
    catch (error) {
      const t = STRINGS[useUIStore.getState().lang];
      notice.warn(t.ls_toast_failed, {
        sub: String(error),
        action: { label: t.ls_toast_retry, run: () => { get().dismiss(added); } },
      });
      return false;
    }
  },
}));

// Clear names synchronously on a vault switch, before any view can render a
// previous vault's queue while its own adjacency/index request is loading.
useVaultStore.subscribe((state, previous) => {
  const root = state.currentVault?.path ?? null;
  if (root === (previous.currentVault?.path ?? null) && state.vaultToken === previous.vaultToken) return;
  lastVault = root;
  lastAdjacency = Symbol("changed vault");
  requestSeq++;
  useLinkSuggestStore.setState({ sem: null, error: null, busy: false });
});
