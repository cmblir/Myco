// In-app schedule timer (Feature 7). While the app is open, periodically checks
// the vault's schedules and runs any that are due (cadence vs last_run), one at
// a time. Mirrors autoReflect/autoIngest. App-CLOSED runs (launchd/cron + the
// Python runner) are a deferred, opt-in follow-up — see the feature spec.
//
// Task 8 (Phase A) adds a second, schedule-independent trigger: distillation
// also runs on its own once the backlog crosses `count_trigger`, gated on the
// user being idle. It is not tied to any "distill"-kind schedule the user may
// or may not have created. A due "distill"-kind schedule is ALSO idle-gated
// below (the brief requires it) — unlike every other schedule kind, which
// just runs on cadence. The manual "Run now"/"지금 증류" buttons are NOT
// idle-gated anywhere: an explicit click is the user's own idle-override.

import { useEffect } from "react";
import { useScheduleStore, isDue } from "../stores/scheduleStore";
import { ipc } from "./ipc";
import { isIdle } from "./idle";
import { runDistillGuarded } from "./distill";
import type { DistillConfig } from "./distill";

const CHECK_INTERVAL_MS = 5 * 60_000; // re-check due schedules every 5 min
const COUNT_TRIGGER_COOLDOWN_MS = 60 * 60_000; // at most once per hour, per vault

// Keyed per vault — a single shared timestamp would let switching vaults
// mid-hour suppress the OTHER vault's legitimate trigger. Module-level, so
// it resets on app restart (deliberate: a fresh session re-evaluates the
// backlog trigger immediately rather than remembering a cooldown across
// restarts).
const lastCountTriggerRun = new Map<string, number>();

/** Run all currently-due schedules for the vault, sequentially. A due
 * "distill" schedule that isn't idle yet is skipped without stamping
 * last_run, so the next poll retries it once the user goes idle. */
export async function runDueSchedules(vaultPath: string): Promise<void> {
  const store = useScheduleStore.getState();
  if (store.runningId) return;
  await store.load(vaultPath);
  const now = Math.floor(Date.now() / 1000);
  // Fetched once per poll and shared with the count trigger below.
  const cfg = await ipc.getDistillConfig(vaultPath).catch(() => null);
  for (const s of useScheduleStore.getState().schedules) {
    if (!isDue(s, now)) continue;
    if (s.kind === "distill" && !isIdle(cfg?.idle_minutes ?? 1)) continue; // defer
    await useScheduleStore.getState().runNow(vaultPath, s);
  }
  await maybeRunCountTrigger(vaultPath, cfg);
}

/** Idle-gated backlog trigger: if distillation is enabled, the backlog has
 * reached count_trigger, and the user is idle, run distill_run directly
 * (independent of any "distill"-kind schedule). At most once per hour per
 * vault. Goes through the same runDistillGuarded as the schedule-due path
 * and the manual buttons, so at most one distill_run is ever in flight. */
async function maybeRunCountTrigger(
  vaultPath: string,
  cfg: DistillConfig | null,
): Promise<void> {
  if (!cfg || !cfg.enabled) return;
  // Task 2 ledger note (binding): count_trigger: 0 means disabled-by-count —
  // this run mode is off, but a "distill"-kind schedule (if any) still fires.
  if (cfg.count_trigger <= 0) return;
  if (!isIdle(cfg.idle_minutes)) return;
  const lastRun = lastCountTriggerRun.get(vaultPath) ?? 0;
  if (Date.now() - lastRun < COUNT_TRIGGER_COOLDOWN_MS) return;
  const status = await ipc.distillStatus(vaultPath).catch(() => null);
  if (!status || status.backlog < cfg.count_trigger) return;
  lastCountTriggerRun.set(vaultPath, Date.now());
  try {
    await runDistillGuarded(vaultPath);
  } catch (e) {
    // Not silent: log with vault context, and re-read status so the
    // failure's effect (or lack of one) is at least visible to whoever
    // reads the console — nothing else surfaces this background run.
    const after = await ipc.distillStatus(vaultPath).catch(() => null);
    console.error(
      `[distill] count-trigger run failed for vault ${vaultPath} (backlog now ${after?.backlog ?? "unknown"}):`,
      e,
    );
  }
}

/** React hook: check for due schedules on an interval while a vault is open. */
export function useScheduleTimer(vaultPath: string | undefined): void {
  useEffect(() => {
    if (!vaultPath) return;
    let cancelled = false;
    const tick = (): void => {
      if (!cancelled) void runDueSchedules(vaultPath);
    };
    // Delay the first check so it doesn't fire during initial app boot/render.
    const kick = window.setTimeout(tick, 15_000);
    const id = window.setInterval(tick, CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(kick);
      window.clearInterval(id);
    };
  }, [vaultPath]);
}
