// Harvest candidates, lifted out of HarvestQueue so the sidebar badge and any
// other surface read the same result instead of paying for a second
// sessions/ scan (harvest_candidates reads every session body to hash it).
// Same shape as provenanceStore: cached per vault, `force` refetches.

import { create } from "zustand";
import { ipc, type HarvestCandidates } from "../lib/ipc";

export const QUEUE_LIMIT = 20;

interface HarvestState {
  data: HarvestCandidates | null;
  error: string | null;
  loading: boolean;
  /** Vault the cached result belongs to — a vault switch invalidates it. */
  scannedPath: string | null;
  /** Fetch the queue for `path` unless the cache already holds it.
   * `force` refetches (after a harvest run, or the retry button). */
  load: (path: string, force?: boolean) => Promise<void>;
}

export const useHarvestStore = create<HarvestState>((set, get) => ({
  data: null,
  error: null,
  loading: false,
  scannedPath: null,

  async load(path, force = false) {
    const s = get();
    if (s.loading) return;
    if (!force && s.scannedPath === path && s.data !== null) return;
    set({ loading: true, error: null });
    try {
      const data = await ipc.harvestCandidates(QUEUE_LIMIT);
      set({ data, scannedPath: path, loading: false });
    } catch (e) {
      set({ data: null, error: String(e), loading: false });
    }
  },
}));
