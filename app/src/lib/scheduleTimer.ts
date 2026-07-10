// In-app schedule timer (Feature 7). While the app is open, periodically checks
// the vault's schedules and runs any that are due (cadence vs last_run), one at
// a time. Mirrors autoReflect/autoIngest. App-CLOSED runs (launchd/cron + the
// Python runner) are a deferred, opt-in follow-up — see the feature spec.

import { useEffect } from "react";
import { useScheduleStore, isDue } from "../stores/scheduleStore";

const CHECK_INTERVAL_MS = 5 * 60_000; // re-check due schedules every 5 min

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
