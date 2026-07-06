// In-app auto-reflect scheduler (FEAT-06). While the app is open and the
// toggle is on, it periodically runs a read-only "reflect" pass over the vault
// (see reflectStore) to surface wiki-improvement suggestions. Modeled on
// autoIngest.ts: a short kick after enabling, then on the configured interval.
//
// Unlike auto-ingest, reflect writes nothing — it only proposes changes — so
// there is no source file to consume or clean up afterwards.

import { useEffect } from "react";
import { useReflectStore } from "../stores/reflectStore";

/** Run one reflect pass unless one is already in flight. */
export async function runReflectPass(): Promise<void> {
  if (useReflectStore.getState().stage === "running") return;
  await useReflectStore.getState().runReflect();
}

/** React hook: drive runReflectPass on an interval while enabled. */
export function useAutoReflectScheduler(
  enabled: boolean,
  intervalMin: number,
  vaultPath: string | undefined,
): void {
  useEffect(() => {
    if (!enabled || !vaultPath || intervalMin <= 0) return;
    let cancelled = false;
    const tick = (): void => {
      if (!cancelled) void runReflectPass();
    };
    // A short kick after enabling, then on the interval.
    const kick = window.setTimeout(tick, 4000);
    const id = window.setInterval(tick, intervalMin * 60_000);
    return () => {
      cancelled = true;
      window.clearTimeout(kick);
      window.clearInterval(id);
    };
  }, [enabled, intervalMin, vaultPath]);
}
