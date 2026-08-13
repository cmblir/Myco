// Idle tracking (Task 8, Phase A). scheduleTimer's poll is a plain async
// function, not a component, so it cannot call a hook — the module-level
// `lastActivity` timestamp is the single source of truth, updated by a
// window-level pointermove/keydown listener wired once in App.tsx (see
// `markActivity`). No component currently needs a live re-rendering boolean,
// so there is no `useIdle` hook here — the brief's interface list mentioned
// one, but an unused export is dead code; add it back if/when a component
// actually needs to react to idle state changing live.

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
