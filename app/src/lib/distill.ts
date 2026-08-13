// TS mirror types for distillation config. Fields match the Rust serde output
// (snake_case from the #[serde(rename_all)] directives).

import { ipc } from "./ipc";
import { runSessionDigest } from "./sessionDigest";
import type { DigestOutcome } from "./sessionDigest";
import { runFullTierIngest } from "./fullTierIngest";
import type { FullTierOutcome } from "./fullTierIngest";

export type Intensity = "conservative" | "standard" | "aggressive";
export type GatePreset = "strict" | "normal" | "loose";

export interface DistillConfig {
  enabled: boolean;
  count_trigger: number;
  intensity: Intensity;
  gate_preset: GatePreset;
  quarantine_ttl_days: number;
  run_budget_items: number;
  idle_minutes: number;
  maturation_hours: number;
  dormancy_decay: boolean;
  // Phase B (LLM layer) groundwork.
  llm_digest_days: number;
  llm_ingest_budget: number;
  profile_injection: boolean;
}

// scan()'s return summary — folded into RunReport below (Task 4/6, Phase A;
// the standalone build_ontology/distill_scan commands were dead code, never
// called outside run(), and were removed).
export interface ScanOutcome {
  scored: number;
  quarantined: number;
  rejected: number;
  summaries: number;
  full: number;
  skipped_immature: number;
}

// Task 6 — distill_run's return summary.
export interface RunReport {
  id: string;
  scan: ScanOutcome;
  archived: number;
  trashed: number;
  proposals: number;
  backlog_after: number;
}

// Task 6 — distill_status's return summary.
export interface DistillStatus {
  backlog: number;
  pending_proposals: number;
  last_run: number | null;
  last_backlogs: number[];
  // Critical 1 fix — false below the cold-start threshold (50 wiki pages):
  // scan() is a no-op on every candidate while this is false.
  gate_active: boolean;
  // Important 3 fix — the most recently started run's id (undoDistillRun's
  // `id` argument), or null if no run has happened yet.
  last_run_id: string | null;
}

// Phase B, Task 1 — digestableSessionDays's return: one day's worth of
// sessions/ files ready for the LLM digest step.
export interface DigestDay {
  day: string; // YYYY-MM-DD
  files: string[]; // vault-relative rel paths
  bytes: number;
}

// Task 8 — direction of `last_backlogs` (oldest → newest, per Rust's
// push+drain in distill.rs) for the Settings distill tab's status line.
// Compares the oldest and newest samples rather than fitting a slope: the
// window is short (last 10 runs) and callers only need a coarse signal.
export function backlogTrend(last: number[]): "shrinking" | "growing" | "flat" {
  if (last.length < 2) return "flat";
  const oldest = last[0];
  const newest = last[last.length - 1];
  if (newest < oldest) return "shrinking";
  if (newest > oldest) return "growing";
  return "flat";
}

// Task 9 — Overview card's "last run" label. Auto-unit (seconds/minutes/
// hours/days), unlike RecentNotes.tsx's day-only `relativeDay`: a distill run
// can fire several times an hour (idle trigger, manual button), so day
// granularity would flatten them all to "today".
export function lastRunLabel(
  lastRun: number | null,
  nowMs: number = Date.now(),
): string | null {
  if (lastRun === null) return null;
  const diffSec = Math.round(nowMs / 1000 - lastRun);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const abs = Math.abs(diffSec);
  if (abs < 60) return rtf.format(-diffSec, "second");
  if (abs < 3600) return rtf.format(-Math.round(diffSec / 60), "minute");
  if (abs < 86_400) return rtf.format(-Math.round(diffSec / 3600), "hour");
  return rtf.format(-Math.round(diffSec / 86_400), "day");
}

// Task 8 fix (code review): three independent callers can decide to run
// distill_run around the same moment — a due "distill" schedule, the
// idle-gated backlog count trigger (scheduleTimer.ts), and the manual
// "Distill now" button (PageSettings.tsx). A run can outlive the timer's
// 5-min poll, so without a shared guard two runs could interleave file
// moves. One per-vault in-flight set, consulted and set by all three.
const inFlight = new Set<string>();

// Phase B, Task 2 — the session daily-digest's outcome, keyed by vault path.
// runDistillGuarded fires it after every successful distill_run, but RunReport
// itself gains no new field for it (callers destructure a stable shape); the
// Overview note (Task 6) instead reads this module-level map for the latest
// run. Smallest option that works — no store, no event bus.
export const lastDigestOutcome = new Map<string, DigestOutcome>();

// Phase B, Task 3 — full-tier ingest's outcome, keyed by vault path. Same
// "module-level map, no store, no event bus" idiom as lastDigestOutcome
// right above (RunReport itself gains no new field for it either).
export const lastFullTierOutcome = new Map<string, FullTierOutcome>();

/** Runs distill_run for `vault`, unless one is already in flight for that
 * vault — in which case this resolves to null immediately and makes no ipc
 * call. All callers (schedule-due, count-trigger, manual button) must go
 * through this instead of calling ipc.distillRun directly.
 *
 * On success, also runs the session daily-digest (Phase B, Task 2) and then
 * full-tier ingest (Phase B, Task 3) for the same vault, inside this same
 * guard window — so all three trigger paths get both for free and
 * concurrency stays single-guarded. Both failures are logged, not thrown:
 * neither must ever take down the distill_run result the caller is waiting
 * on. */
export async function runDistillGuarded(vault: string): Promise<RunReport | null> {
  if (inFlight.has(vault)) return null;
  inFlight.add(vault);
  try {
    const report = await ipc.distillRun(vault);
    const outcome = await runSessionDigest(vault).catch((e) => {
      console.error("[distill] session digest failed", vault, e);
      return null;
    });
    if (outcome) lastDigestOutcome.set(vault, outcome);
    const fullTierOutcome = await runFullTierIngest(vault).catch((e) => {
      console.error("[distill] full-tier ingest failed", vault, e);
      return null;
    });
    if (fullTierOutcome) lastFullTierOutcome.set(vault, fullTierOutcome);
    return report;
  } finally {
    inFlight.delete(vault);
  }
}
