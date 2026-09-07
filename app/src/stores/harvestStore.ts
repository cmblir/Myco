// Harvest candidates, lifted out of HarvestQueue so the sidebar badge and any
// other surface read the same result instead of paying for a second
// sessions/ scan (harvest_candidates reads every session body to hash it).
// Same shape as provenanceStore: cached per vault, `force` refetches.
//
// It also carries the RUN state (progress + outcome), for the same reason the
// candidate list moved here: a harvest run is minutes of work owned by one
// component, and the Topbar had no way to see it.

import { create } from "zustand";
import { ipc, type HarvestCandidates } from "../lib/ipc";

export const QUEUE_LIMIT = 20;

/** How a finished run ended, for the Topbar pill. Shared by every source the
 * bar reports (ingest, lint, ask, distill, harvest). */
export type RunOutcome = "done" | "error" | null;

/** Live progress of a harvest run. A run first copies the selected sessions
 * into _inbox/ ("copying"), then walks them through one ingest pass each
 * ("ingesting") — twenty passes is normal, and the bar used to show nothing
 * whatsoever for the whole stretch. */
export interface HarvestRun {
  /** Sources this run is walking through. */
  total: number;
  /** Sources ingested so far. */
  done: number;
  /** null = no run in flight. */
  phase: "copying" | "ingesting" | null;
}

/** No run has ever started — and never will, in a session where nobody
 * harvests. Every Topbar reader is a no-op against this. */
const IDLE_RUN: HarvestRun = { total: 0, done: 0, phase: null };

interface HarvestState {
  data: HarvestCandidates | null;
  error: string | null;
  loading: boolean;
  /** Vault the cached result belongs to — a vault switch invalidates it. */
  scannedPath: string | null;
  /** Fetch the queue for `path` unless the cache already holds it.
   * `force` refetches (after a harvest run, or the retry button). */
  load: (path: string, force?: boolean) => Promise<void>;

  run: HarvestRun;
  /** How the last run ended; null when there has never been one. */
  outcome: RunOutcome;
  /** false after a run finishes until the user visits Overview — drives the
   * Topbar done/failed pill, same contract as ingestStore.seen. */
  seen: boolean;
  /** Copy phase begins: `total` sources selected. */
  startRun: (total: number) => void;
  /** Ingest-phase progress. Callers pass the COPIED total, which can be lower
   * than the selected one when a source fails to copy. */
  setRun: (done: number, total: number) => void;
  endRun: (ok: boolean) => void;
  markSeen: () => void;
}

export const useHarvestStore = create<HarvestState>((set, get) => ({
  data: null,
  error: null,
  loading: false,
  scannedPath: null,
  run: IDLE_RUN,
  outcome: null,
  // Nothing to report until a run actually ends, so the pill starts silent.
  seen: true,

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

  startRun(total) {
    // Clears the previous outcome: a new run must not leave the old pill up.
    set({ run: { total, done: 0, phase: "copying" }, outcome: null, seen: true });
  },

  setRun(done, total) {
    set({ run: { total, done, phase: "ingesting" } });
  },

  endRun(ok) {
    set({ run: IDLE_RUN, outcome: ok ? "done" : "error", seen: false });
  },

  markSeen() {
    set({ seen: true });
  },
}));
