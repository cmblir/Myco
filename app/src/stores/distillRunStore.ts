// Tiny reactive bridge for runDistillGuarded's in-flight state. lib/distill.ts
// keeps its own `inFlight` Set for the re-entrancy guard, which is plain
// module state and notifies no one. The app has exactly one open vault at a
// time (see useVaultStore), so a single boolean is enough for the Topbar to
// know "is the distill chain running right now" — no per-vault tracking
// needed. Updated by runDistillGuarded itself; nothing else writes to it.
//
// `step` names the chain phase currently executing (the Topbar activity
// popover shows it live) — same order runDistillGuarded runs them.

import { create } from "zustand";
import type { RunOutcome } from "./harvestStore";

export type DistillRunStep =
  | "run"
  | "digest"
  | "weekly"
  | "monthly"
  | "ingest"
  | "maps"
  | "resurface";

interface DistillRunState {
  running: boolean;
  /** Current chain phase while running; null when idle. */
  step: DistillRunStep | null;
  /** How the last chain ended; null when there has never been one. */
  outcome: RunOutcome;
  /** false after a chain finishes until the user visits Feedback — drives the
   * Topbar done/failed pill, same contract as ingestStore.seen. */
  seen: boolean;
  markSeen: () => void;
}

export const useDistillRunStore = create<DistillRunState>((set) => ({
  running: false,
  step: null,
  outcome: null,
  // Nothing to report until a chain actually ends, so the pill starts silent.
  seen: true,
  markSeen: () => set({ seen: true }),
}));
