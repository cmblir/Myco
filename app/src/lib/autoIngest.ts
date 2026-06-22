// In-app auto-ingest scheduler. While the app is open and the toggle is on, it
// periodically ingests pending sources from the vault's `_inbox/` folder using
// the normal ingest pipeline (the selected provider), then removes the source
// (its content is preserved in raw/<slug>.md, written during ingest).
//
// This complements the headless cron daemon (automation/autoingest.py): the
// daemon runs without the app open via your CLI; this runs while the app is open
// via whatever provider you've selected (CLI, Memex Pro, …). Both watch the same
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
  await useIngestStore.getState().startIngest(title, fc.raw);

  if (useIngestStore.getState().stage === "done") {
    // Remove the consumed source — its content now lives in raw/<slug>.md.
    await ipc.deletePath(f.path).catch(() => undefined);
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
