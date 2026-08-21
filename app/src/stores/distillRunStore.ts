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

export type DistillRunStep = "run" | "digest" | "weekly" | "monthly" | "ingest" | "maps";

interface DistillRunState {
  running: boolean;
  /** Current chain phase while running; null when idle. */
  step: DistillRunStep | null;
}

export const useDistillRunStore = create<DistillRunState>(() => ({
  running: false,
  step: null,
}));
