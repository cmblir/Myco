// In-app auto-reflect scheduler (FEAT-06). While the app is open and the
// toggle is on, it periodically runs a read-only "reflect" pass over the vault
// (see reflectStore) to surface wiki-improvement suggestions. Modeled on
// autoIngest.ts: a short kick after enabling, then on the configured interval.
//
// Unlike auto-ingest, reflect writes nothing — it only proposes changes — so
// there is no source file to consume or clean up afterwards.

import { useEffect } from "react";
import { ipc } from "./ipc";
import { useReflectStore } from "../stores/reflectStore";
import { useVaultStore } from "../stores/vaultStore";

/** Vault revision at the last SCHEDULED pass, per vault path. A reflect run
 * (LLM or extractive) reads the whole link graph — repeating that every
 * interval against an unchanged vault is pure waste, so scheduled ticks skip
 * when nothing changed. Manual runs (the Overview button) bypass this. */
const lastTickRevision = new Map<string, number>();

/** Run one reflect pass unless one is already in flight. The old
 * builtin-local pre-check is gone: that provider now runs the extractive
 * reflect variant (see reflectStore) instead of blocking. */
export async function runReflectPass(): Promise<void> {
  const st = useReflectStore.getState();
  // `applying`: runReflect refuses anyway, but skipping here keeps the tick
  // from burning a vault_revision read during a bulk apply.
  if (st.stage === "running" || st.applying) return;
  await useReflectStore.getState().runReflect();
}

/** Scheduled-tick variant: skip when the vault hasn't changed since the last
 * scheduled pass (vault_revision is a stat-only hash — ~free). */
export async function runReflectTick(): Promise<void> {
  const path = useVaultStore.getState().currentVault?.path;
  if (!path) return;
  const rev = await ipc.vaultRevision(path).catch(() => null);
  if (rev !== null && lastTickRevision.get(path) === rev) return;
  if (rev !== null) lastTickRevision.set(path, rev);
  await runReflectPass();
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
      if (!cancelled) void runReflectTick();
    };
    // First kick rides AFTER the index updater's 180s launch catch-up
    // window, not 4s into boot: reflect's retrieval loads the ~400 MB embed
    // model, and on a memory-pressed machine that landed exactly on the
    // launch spike (measured: the one remaining model load at t≈30s after
    // every start). 4 minutes keeps launch clean; the interval unchanged.
    const kick = window.setTimeout(tick, 240_000);
    const id = window.setInterval(tick, intervalMin * 60_000);
    return () => {
      cancelled = true;
      window.clearTimeout(kick);
      window.clearInterval(id);
    };
  }, [enabled, intervalMin, vaultPath]);
}
