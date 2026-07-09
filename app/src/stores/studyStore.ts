// Study store. Holds the deck summaries (total/due counts) shown in PageStudy
// and the sidebar due badge. Kept out of the vault store because it needs to
// read every deck's contents (not just the tree), which is more IO than the
// vault store's structural refreshes.

import { create } from "zustand";
import { summarizeDecks, type DeckSummary } from "../lib/cardStore";
import type { FileNode } from "../lib/ipc";
import { useVaultStore } from "./vaultStore";

/** Today as an ISO date (yyyy-mm-dd), matching the FSRS date convention. */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface StudyState {
  decks: DeckSummary[];
  dueTotal: number;
  loading: boolean;
  refresh: () => Promise<void>;
}

export const useStudyStore = create<StudyState>((set) => ({
  decks: [],
  dueTotal: 0,
  loading: false,

  async refresh() {
    const tree: FileNode[] = useVaultStore.getState().fileTree;
    set({ loading: true });
    try {
      const decks = await summarizeDecks(tree, today());
      set({
        decks,
        dueTotal: decks.reduce((n, d) => n + d.due, 0),
        loading: false,
      });
    } catch {
      set({ loading: false });
    }
  },
}));
