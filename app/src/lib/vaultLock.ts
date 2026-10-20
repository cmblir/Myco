// One lock per vault, shared by the distill chain (distill.ts
// runDistillGuarded) and the in-app auto-ingest pass (autoIngest.ts
// runInboxPass). Both move _inbox/ files, so they never run at the same time
// (spec 2026-10-02 decision 8): whoever finds the lock held skips. The
// headless daemon (automation/autoingest.py) runs out of process and does not
// see this lock.

const held = new Set<string>();

/** Take the lock for `vault`; false while someone else holds it. */
export function tryLock(vault: string): boolean {
  if (held.has(vault)) return false;
  held.add(vault);
  return true;
}

/** Let the lock go. Only the caller whose `tryLock` returned true calls this. */
export function unlock(vault: string): void {
  held.delete(vault);
}
