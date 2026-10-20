// Study store. Holds the deck summaries (total/due counts) shown in PageStudy
// and the sidebar due badge. Kept out of the vault store because it needs to
// read every deck's contents (not just the tree), which is more IO than the
// vault store's structural refreshes.

import { create } from "zustand";
import { cardsDir, countedDue, summarizeDecks, type DeckSummary } from "../lib/cardStore";
import { ipc } from "../lib/ipc";
import { today } from "../lib/taskLine";
import { useVaultStore } from "./vaultStore";
import { log } from "../lib/log";

let refreshSequence = 0;

/** Today as the user's local calendar date (yyyy-mm-dd), the FSRS date
 *  convention. UTC's date made a card forgotten at 02:00 in Seoul due again
 *  at 09:00 the same day, under a label that said "tomorrow". */
export { today };

/** uiStore.studyDeck's value for today's review across every deck (UX S34),
 *  in place of one deck's path. */
export const TODAY_REVIEW = "today";

export interface StudyState {
  decks: DeckSummary[];
  dueTotal: number;
  loading: boolean;
  error: string | null;
  loadedPath: string | null;
  refresh: () => Promise<void>;
}

export const useStudyStore = create<StudyState>((set) => ({
  decks: [],
  dueTotal: 0,
  loading: false,
  error: null,
  loadedPath: null,

  async refresh() {
    const sequence = ++refreshSequence;
    const { fileTree: tree, resolveWikilink, currentVault, vaultToken, isOpeningVault } = useVaultStore.getState();
    if (!currentVault || isOpeningVault) {
      set({ decks: [], dueTotal: 0, loading: false, error: null, loadedPath: null });
      return;
    }
    const vault = currentVault.path;
    const isCurrent = (): boolean => {
      const state = useVaultStore.getState();
      return sequence === refreshSequence && !state.isOpeningVault &&
        state.currentVault?.path === vault && state.vaultToken === vaultToken;
    };
    const requireCurrent = (): void => {
      if (!isCurrent()) throw new Error("Study refresh replaced");
    };
    // A card's source note, to tell grounded cards from model prose.
    const readNote = async (stem: string): Promise<string | null> => {
      requireCurrent();
      const path = resolveWikilink(stem);
      if (!path) return null;
      const file = await ipc.readFile(path);
      requireCurrent();
      return file.raw;
    };
    // A card cited to a raw source: the notes citing it. Decks (archived
    // ones too) repeat their own backs and citations, so they never count.
    const readCiting = async (sourceRef: string): Promise<string[]> => {
      requireCurrent();
      const deckDir = `${cardsDir(vault)}/`;
      const hits = await ipc.searchVault(sourceRef);
      requireCurrent();
      const texts = await Promise.all(
        hits.filter((h) => !h.path.startsWith(deckDir)).map(async (h) => {
          requireCurrent();
          const file = await ipc.readFile(h.path);
          requireCurrent();
          return file.raw;
        }),
      );
      return texts.filter(Boolean);
    };
    const changedVault = useStudyStore.getState().loadedPath !== vault;
    set({ loading: true, error: null, ...(changedVault ? { decks: [], dueTotal: 0, loadedPath: null } : {}) });
    try {
      // A deck made entirely of ungrounded cards shows no due count and adds
      // none to the badge or Home's "due today" (spec 2026-09-29 Part 2).
      const decks = (await summarizeDecks(tree, today(), readNote, readCiting, true)).map((d) => ({
        ...d,
        due: countedDue(d),
      }));
      if (!isCurrent()) return;
      set({
        decks,
        dueTotal: decks.reduce((n, d) => n + d.due, 0),
        loading: false,
        loadedPath: vault,
        error: null,
      });
    } catch (error) {
      if (!isCurrent()) return;
      log.warn("study_refresh_failed");
      set({ decks: [], dueTotal: 0, loading: false, error: String(error), loadedPath: null });
    } finally {
      // Only this scan may settle its spinner; a replaced scan cannot clear a newer one.
      if (sequence === refreshSequence) set({ loading: false });
    }
  },
}));
