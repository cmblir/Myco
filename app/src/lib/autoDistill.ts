// Auto-distill trigger (spec 2026-10-02 decisions 6-7). While the app runs
// and "자동 정리" (DistillConfig.enabled) is on, a poll distills the vault on
// its own once nothing has touched the window for `idle_minutes` and the
// backlog has reached `count_trigger`, at most once an hour per vault. Like
// every run, it changes nothing under raw/. Restored
// from the count trigger and idle clock e11fb45e deleted with
// lib/scheduleTimer.ts and lib/idle.ts; the schedules.json path stays gone
// (it was dead).

import { useEffect } from "react";
import { ipc } from "./ipc";
import { runDistillGuarded } from "./distill";

const CHECK_INTERVAL_MS = 5 * 60_000;
const COOLDOWN_MS = 60 * 60_000;
const ACTIVITY_EVENTS = ["pointermove", "keydown", "wheel"] as const;

let lastActivity = Date.now();
// Per vault, so a run for one vault never holds back another's. Module
// state: a restart re-checks right away instead of remembering the hour.
const lastRun = new Map<string, number>();

/** Record user activity (pointer, key, wheel). */
export function markActivity(): void {
  lastActivity = Date.now();
}

// set_distill_config saves unvalidated values, so `idle_minutes: 0` counts as
// 1 rather than "always idle".
function isIdle(minutes: number): boolean {
  const m = minutes > 0 ? minutes : 1;
  return Date.now() - lastActivity >= m * 60_000;
}

/** One trigger check for `vault`; runs the distill chain when every gate
 * holds. Never throws: incomplete and skipped runs remain eligible for retry. */
export async function maybeAutoDistill(vault: string): Promise<void> {
  const cfg = await ipc.getDistillConfig(vault).catch(() => null);
  // count_trigger 0 means "off by count".
  if (!cfg?.enabled || cfg.count_trigger <= 0) return;
  if (!isIdle(cfg.idle_minutes)) return;
  const last = lastRun.get(vault);
  if (last !== undefined && Date.now() - last < COOLDOWN_MS) return;
  const status = await ipc.distillStatus(vault).catch(() => null);
  if (!status || status.backlog < cfg.count_trigger) return;
  try {
    const report = await runDistillGuarded(vault, "automatic");
    if (report) lastRun.set(vault, Date.now());
  } catch (e) {
    console.error(`[distill] automatic run failed for ${vault}:`, e);
  }
}

/** App-level hook: tracks activity on the window and polls the trigger for
 * the open vault. */
export function useAutoDistill(vaultPath: string | undefined): void {
  useEffect(() => {
    for (const ev of ACTIVITY_EVENTS) {
      window.addEventListener(ev, markActivity, { passive: true });
    }
    return () => {
      for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, markActivity);
    };
  }, []);

  useEffect(() => {
    if (!vaultPath) return;
    const id = window.setInterval(() => void maybeAutoDistill(vaultPath), CHECK_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [vaultPath]);
}
