// In-app schedule timer (Feature 7). While the app is open, periodically checks
// the vault's schedules and runs any that are due (cadence vs last_run), one at
// a time. Mirrors autoReflect/autoIngest. App-CLOSED runs (launchd/cron + the
// Python runner) are a deferred, opt-in follow-up — see the feature spec.
//
// Task 8 (Phase A) adds a second, schedule-independent trigger: distillation
// also runs on its own once the backlog crosses `count_trigger`, gated on the
// user being idle. It is not tied to any "distill"-kind schedule the user may
// or may not have created.

import { useEffect } from "react";
import { useScheduleStore, isDue } from "../stores/scheduleStore";
import { ipc } from "./ipc";
import { isIdle } from "./idle";

const CHECK_INTERVAL_MS = 5 * 60_000; // re-check due schedules every 5 min
const COUNT_TRIGGER_COOLDOWN_MS = 60 * 60_000; // at most once per hour

// Module-level, so it resets on app restart — deliberate: a fresh session
// re-evaluates the backlog trigger immediately rather than remembering a
// cooldown across restarts.
let lastCountTriggerRun = 0;

/** Run all currently-due schedules for the vault, sequentially. */
export async function runDueSchedules(vaultPath: string): Promise<void> {
  const store = useScheduleStore.getState();
  if (store.runningId) return;
  await store.load(vaultPath);
  const now = Math.floor(Date.now() / 1000);
  for (const s of useScheduleStore.getState().schedules) {
    if (isDue(s, now)) {
      await useScheduleStore.getState().runNow(vaultPath, s);
    }
  }
  await maybeRunCountTrigger(vaultPath);
}

/** Idle-gated backlog trigger: if distillation is enabled, the backlog has
 * reached count_trigger, and the user is idle, run distill_run directly
 * (independent of any "distill"-kind schedule). At most once per hour. */
async function maybeRunCountTrigger(vaultPath: string): Promise<void> {
  if (useScheduleStore.getState().runningId) return;
  if (Date.now() - lastCountTriggerRun < COUNT_TRIGGER_COOLDOWN_MS) return;
  const cfg = await ipc.getDistillConfig(vaultPath).catch(() => null);
  if (!cfg || !cfg.enabled) return;
  // Task 2 ledger note (binding): count_trigger: 0 means disabled-by-count —
  // this run mode is off, but a "distill"-kind schedule (if any) still fires.
  if (cfg.count_trigger <= 0) return;
  if (!isIdle(cfg.idle_minutes)) return;
  const status = await ipc.distillStatus(vaultPath).catch(() => null);
  if (!status || status.backlog < cfg.count_trigger) return;
  lastCountTriggerRun = Date.now();
  await ipc.distillRun(vaultPath).catch(() => undefined);
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
