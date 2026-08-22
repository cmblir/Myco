// In-app auto-ingest scheduler. While the app is open and the toggle is on, it
// periodically ingests pending sources from the vault's `_inbox/` folder using
// the normal ingest pipeline (the selected provider), then removes the source
// (its content is preserved in raw/<slug>.md, written during ingest).
//
// This complements the headless cron daemon (automation/autoingest.py): the
// daemon runs without the app open via your CLI; this runs while the app is open
// via whatever provider you've selected (CLI, myco Pro, …). Both watch the same
// `_inbox/` folder. Only .md inbox files are picked up here (list_files is
// markdown-only); the daemon handles other types.

import { useEffect } from "react";
import { ipc } from "./ipc";
import type { FileNode } from "./ipc";
import { useIngestStore } from "../stores/ingestStore";

const INBOX = "_inbox";

function isBusy(): boolean {
  const s = useIngestStore.getState().stage;
  return s === "writing-raw" || s === "claude" || s === "indexing";
}

/** Pending .md source files directly under <vault>/_inbox/ (skips dotfiles). */
export async function listInboxFiles(
  vaultPath: string,
): Promise<{ name: string; path: string }[]> {
  let tree: FileNode[];
  try {
    tree = await ipc.listFiles(vaultPath);
  } catch {
    return [];
  }
  const inbox = tree.find(
    (n): n is Extract<FileNode, { kind: "directory" }> =>
      n.kind === "directory" && n.name === INBOX,
  );
  if (!inbox) return [];
  return inbox.children
    .filter(
      (c): c is Extract<FileNode, { kind: "file" }> =>
        c.kind === "file" && !c.name.startsWith("."),
    )
    .map((c) => ({ name: c.name, path: c.path }));
}

/** One row in the "waiting in _inbox" list, newest first. */
export interface PendingInboxRow {
  name: string;
  path: string;
  /** Epoch seconds; null when the vault walk had no time for this file. */
  mtime: number | null;
  /** Arrived today (caller-local date) — the row the inflow "+N" points at. */
  today: boolean;
}

/** Pure derivation: sort pending files newest first and flag today's
 *  arrivals. Files without a known mtime sort last. */
export function pendingInboxRows(
  files: { name: string; path: string }[],
  mtimes: Map<string, number>,
  now: Date = new Date(),
): PendingInboxRow[] {
  const todayKey = now.toDateString();
  return files
    .map((f) => {
      const m = mtimes.get(f.path);
      return {
        ...f,
        mtime: m ?? null,
        today: m != null && new Date(m * 1000).toDateString() === todayKey,
      };
    })
    .sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
}

/** Ingest the next pending inbox source, then remove it. Returns true if it ran
 *  a successful ingest. Skips when a run is already in flight. */
export async function runInboxPass(vaultPath: string): Promise<boolean> {
  if (isBusy()) return false;
  const files = await listInboxFiles(vaultPath);
  if (files.length === 0) return false;

  const f = files[0];
  const fc = await ipc.readFile(f.path).catch(() => null);
  if (!fc) return false;
  const title = f.name.replace(/\.[^.]+$/, "");

  // startIngest writes raw/<slug>.md from this content and runs the model.
  // headless: this pass runs unattended — the plan gate (a checkbox review
  // awaiting a user) would park the run forever, so it must never engage here.
  await useIngestStore.getState().startIngest(title, fc.raw, { headless: true });

  if (useIngestStore.getState().stage === "done") {
    // Archive the consumed source (never delete) — its content is also in
    // raw/<slug>.md now, but a preserved original matches the headless daemon
    // and means a later half-failure cannot lose it.
    await ipc.archiveInboxSource(f.path).catch(() => undefined);
    // Only now is the file really gone from _inbox/ — signal the pending
    // list (a stage-keyed refetch fires before this move lands).
    useIngestStore.getState().bumpInboxRev();
    return true;
  }
  return false; // error / no-op: leave the source in _inbox to retry next pass
}

/** React hook: drive runInboxPass on an interval while enabled. */
export function useAutoIngestScheduler(
  enabled: boolean,
  intervalMin: number,
  vaultPath: string | undefined,
): void {
  useEffect(() => {
    if (!enabled || !vaultPath || intervalMin <= 0) return;
    let cancelled = false;
    const tick = (): void => {
      if (!cancelled) void runInboxPass(vaultPath);
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
