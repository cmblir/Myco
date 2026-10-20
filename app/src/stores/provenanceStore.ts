// Provenance scan state, lifted out of PageProvenance so a running scan
// survives navigating away (same pattern as lintStore/queryStore) and a
// revisit shows the cached rows instantly instead of rescanning from zero.

import { create } from "zustand";
import { ipc, type ProvenanceRow } from "../lib/ipc";
import { useVaultStore } from "./vaultStore";

interface ProvenanceState {
  rows: ProvenanceRow[] | null;
  error: string | null;
  loading: boolean;
  /** Vault the cached rows belong to — a vault switch invalidates them. */
  scannedPath: string | null;
  scannedToken: string | null;
  /** Scan `path`, unless the cache already holds fresh rows for it.
   * `force` rescans (the page's refresh action). */
  scan: (path: string, force?: boolean) => Promise<void>;
}

let scanRevision = 0;
let pendingPath: string | null = null;
let pendingToken: string | null = null;

export const useProvenanceStore = create<ProvenanceState>((set, get) => ({
  rows: null,
  error: null,
  loading: false,
  scannedPath: null,
  scannedToken: null,

  async scan(path, force = false) {
    const opening = useVaultStore.getState();
    if (
      opening.currentVault?.path !== path ||
      opening.isOpeningVault ||
      !opening.vaultToken
    )
      return;
    const token = opening.vaultToken;
    const isCurrent = (): boolean => {
      const current = useVaultStore.getState();
      return (
        current.currentVault?.path === path &&
        current.vaultToken === token &&
        !current.isOpeningVault
      );
    };
    const s = get();
    if (s.loading && pendingPath === path && pendingToken === token && !force)
      return;
    if (
      !force &&
      s.scannedPath === path &&
      s.scannedToken === token &&
      s.rows !== null
    )
      return;
    const revision = ++scanRevision;
    pendingPath = path;
    pendingToken = token;
    set({
      loading: true,
      error: null,
      ...(s.scannedPath !== path || s.scannedToken !== token
        ? { rows: null }
        : {}),
    });
    try {
      const rows = await ipc.scanProvenance(path);
      if (revision !== scanRevision || !isCurrent()) return;
      set({ rows, scannedPath: path, scannedToken: token, loading: false });
    } catch (e) {
      if (revision !== scanRevision || !isCurrent()) return;
      set({ error: String(e), loading: false });
    }
  },
}));

// An opening change invalidates even at the same path. Metadata changes within
// the same opening retain in-flight scans and cached rows.
useVaultStore.subscribe((state, previous) => {
  if (
    (state.currentVault?.path ?? null) ===
      (previous.currentVault?.path ?? null) &&
    state.vaultToken === previous.vaultToken &&
    state.isOpeningVault === previous.isOpeningVault
  )
    return;
  scanRevision++;
  pendingPath = null;
  pendingToken = null;
  useProvenanceStore.setState({
    rows: null,
    error: null,
    loading: false,
    scannedPath: null,
    scannedToken: null,
  });
});
