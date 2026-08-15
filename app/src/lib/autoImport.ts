// In-app auto-import scheduler. While the app is open and the toggle is on, it
// periodically sweeps local CLI session logs (Claude Code / Codex) into the
// vault's `sessions/` — myco pulls conversations in by itself, no hooks or
// manual harness. The Rust import ledger dedups per file (mtime/len fast-skip)
// and per conversation (fingerprint), so a sweep with nothing new is a no-op.
//
// `sessions/` deliberately is NOT `_inbox/`: that folder is a queue whose
// consumer (auto-ingest) spends provider tokens per file, and a work log does
// not earn a wiki page. Sessions are indexed for Ask instead — searchable and
// quotable at no model cost — and skipped by the knowledge graph.

import { useEffect } from "react";
import { ipc } from "./ipc";
import { log } from "./log";
import { useImportStore } from "../stores/importStore";
import { useIngestStore } from "../stores/ingestStore";
import { useDistillRunStore } from "../stores/distillRunStore";

const KINDS = ["claude-code", "codex"] as const;

function busy(): boolean {
  const imp = useImportStore.getState().stage;
  const ing = useIngestStore.getState().stage;
  return (
    imp === "importing-file" ||
    imp === "sweeping" ||
    ing === "writing-raw" ||
    ing === "claude" ||
    ing === "indexing" ||
    // Defence in depth for the session digest: a sweep that rewrites a
    // resumed conversation's file mid-digest would have its new turns left
    // behind in sessions/ (archive_digested_sessions re-checks fingerprints),
    // costing a duplicate digest. Skipping the tick avoids the whole race —
    // the next tick is minutes away and imports nothing that expires.
    useDistillRunStore.getState().running
  );
}

/** One background sweep across both CLI session kinds. Quiet on a kind whose
 * session directory doesn't exist (tool not installed) — that is the normal
 * state on most machines, not an error worth surfacing. */
export async function runSessionSweep(): Promise<void> {
  if (busy()) return;
  for (const kind of KINDS) {
    try {
      const out = await ipc.importSessionSweep(kind);
      if (out.imported > 0) {
        log.info("auto_import.swept", {
          kind,
          imported: out.imported,
          skipped: out.skipped,
        });
      }
    } catch {
      /* no session dir / vault closed — retry next tick */
    }
  }
}

/** React hook: drive runSessionSweep on an interval while enabled. */
export function useAutoImportScheduler(
  enabled: boolean,
  intervalMin: number,
  vaultPath: string | undefined,
): void {
  useEffect(() => {
    if (!enabled || !vaultPath || intervalMin <= 0) return;
    let cancelled = false;
    const tick = (): void => {
      if (!cancelled) void runSessionSweep();
    };
    // A short kick after enabling, then on the interval.
    const kick = window.setTimeout(tick, 8000);
    const id = window.setInterval(tick, intervalMin * 60_000);
    return () => {
      cancelled = true;
      window.clearTimeout(kick);
      window.clearInterval(id);
    };
  }, [enabled, intervalMin, vaultPath]);
}
