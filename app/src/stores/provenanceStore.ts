// Provenance scan state, lifted out of PageProvenance so a running scan
// survives navigating away (same pattern as lintStore/queryStore) and a
// revisit shows the cached rows instantly instead of rescanning from zero.

import { create } from "zustand";
import { ipc, type ProvenanceRow } from "../lib/ipc";

interface ProvenanceState {
  rows: ProvenanceRow[] | null;
  error: string | null;
  loading: boolean;
  /** Vault the cached rows belong to — a vault switch invalidates them. */
  scannedPath: string | null;
  /** Scan `path`, unless the cache already holds fresh rows for it.
   * `force` rescans (the page's refresh action). */
  scan: (path: string, force?: boolean) => Promise<void>;
}

export const useProvenanceStore = create<ProvenanceState>((set, get) => ({
  rows: null,
  error: null,
  loading: false,
  scannedPath: null,

  async scan(path, force = false) {
    const s = get();
    if (s.loading) return;
    if (!force && s.scannedPath === path && s.rows !== null) return;
    set({ loading: true, error: null });
    try {
      const rows = await ipc.scanProvenance(path);
      set({ rows, scannedPath: path, loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },
}));
