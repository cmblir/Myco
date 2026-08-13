// Idle tracking (Task 8, Phase A). scheduleTimer's poll is a plain async
// function, not a component, so it cannot call a hook — the module-level
// `lastActivity` timestamp is the single source of truth, updated by a
// window-level pointermove/keydown listener wired once in App.tsx (see
// `markActivity`). `useIdle` is a thin re-render wrapper around the same
// pure check, for components (the Settings distill tab) that want a live
// boolean.

import { useEffect, useState } from "react";

let lastActivity = Date.now();

/** Record user activity. Idempotent — safe to call from multiple listeners. */
export function markActivity(): void {
  lastActivity = Date.now();
}

// Task 2 ledger note (binding): set_distill_config saves unvalidated values,
// so `idle_minutes: 0` must be treated as 1 here rather than trusted as "0
// minutes idle" (which would make everything instantly idle).
export function isIdle(minutes: number): boolean {
  const m = minutes > 0 ? minutes : 1;
  return Date.now() - lastActivity >= m * 60_000;
}

const POLL_MS = 30_000;

/** React hook: the current idle state for `minutes`, refreshed every 30s.
 * SSR-safe (no-ops when `window` is undefined). */
export function useIdle(minutes: number): boolean {
  const [idle, setIdle] = useState(() => isIdle(minutes));

  useEffect(() => {
    if (typeof window === "undefined") return;
    const check = (): void => setIdle(isIdle(minutes));
    check();
    const id = window.setInterval(check, POLL_MS);
    window.addEventListener("pointermove", markActivity);
    window.addEventListener("keydown", markActivity);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("pointermove", markActivity);
      window.removeEventListener("keydown", markActivity);
    };
  }, [minutes]);

  return idle;
}
