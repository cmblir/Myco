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
import { useVaultStore } from "../stores/vaultStore";
import type { ImportOutcome } from "./ipc";
import type { WorkflowStatus } from "./workflowOutcome";

const KINDS = ["claude-code", "codex"] as const;

/** When the last clean sweep finished, ms epoch. Module-level
 * because the scheduler keeps no other state; the inflow section's "last
 * sweep" sub-line is its only reader. Null until a sweep completes. */
let lastCleanSweep: { vaultPath: string; vaultToken: string; at: number } | null = null;

export interface SweepReceipt {
  requestId: string;
  vaultPath: string;
  vaultToken: string;
  startedAt: number;
  finishedAt: number | null;
  status: WorkflowStatus;
  error?: string;
  items: { kind: typeof KINDS[number]; outcome?: ImportOutcome; error?: string }[];
}

let lastReceipt: SweepReceipt | null = null;
let activeSweep: object | null = null;

function isCurrentScope(scope: { vaultPath: string; vaultToken: string }): boolean {
  const current = useVaultStore.getState();
  return !current.isOpeningVault && current.currentVault?.path === scope.vaultPath &&
    current.vaultToken === scope.vaultToken;
}

export function getLastSweepAt(): number | null {
  return lastCleanSweep && isCurrentScope(lastCleanSweep) ? lastCleanSweep.at : null;
}

export function getLastSweepReceipt(): SweepReceipt | null {
  return lastReceipt && isCurrentScope(lastReceipt) ? lastReceipt : null;
}

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
  const { currentVault: vault, vaultToken, isOpeningVault } = useVaultStore.getState();
  if (!vault || isOpeningVault || busy() || activeSweep) return;
  const owner = {};
  activeSweep = owner;
  const receipt: SweepReceipt = {
    requestId: crypto.randomUUID(), vaultPath: vault.path, vaultToken, startedAt: Date.now(), finishedAt: null,
    status: "pending", items: [],
  };
  lastReceipt = receipt;
  try {
    const origin = Object.freeze(await ipc.agentVaultSession());
    if (!isCurrentScope(receipt)) return;
    if (origin.vaultPath !== vault.path) {
      throw new Error("Native sweep opening differs from the requested vault");
    }
    for (const kind of KINDS) {
      if (!isCurrentScope(receipt)) return;
      if (busy()) break;
      try {
        const out = await ipc.importSessionSweep(kind, origin, receipt.requestId);
        if (!isCurrentScope(receipt)) return;
        receipt.items.push({ kind, outcome: out });
        if (out.failed.length || out.quarantined.length) {
          log.warn("auto_import.incomplete", {
            kind, failed: out.failed.length, quarantined: out.quarantined.length,
          });
        } else if (out.imported > 0) {
          log.info("auto_import.swept", { kind, imported: out.imported, skipped: out.skipped });
        }
      } catch (error) {
        if (!isCurrentScope(receipt)) return;
        receipt.items.push({ kind, error: String(error) });
        log.warn("auto_import.failed", { kind, code: "import_failed" });
      }
    }
    const incomplete = receipt.items.length !== KINDS.length ||
      receipt.items.some(item => item.error || item.outcome?.failed.length || item.outcome?.quarantined.length);
    const progressed = receipt.items.some(item => item.outcome &&
      (item.outcome.imported + item.outcome.skipped > 0 ||
        item.outcome.failed.length === 0 && item.outcome.quarantined.length === 0));
    receipt.status = !incomplete ? "success" : progressed ? "partial" :
      receipt.items.some(item => item.error || item.outcome?.failed.length) ? "failed" : "pending";
    receipt.finishedAt = Date.now();
    if (receipt.status === "success") {
      lastCleanSweep = { vaultPath: vault.path, vaultToken, at: receipt.finishedAt };
    }
  } catch (error) {
    if (!isCurrentScope(receipt)) return;
    receipt.status = "failed";
    receipt.finishedAt = Date.now();
    receipt.error = String(error);
    log.warn("auto_import.failed", { code: "opening_failed" });
  } finally {
    if (activeSweep === owner) activeSweep = null;
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
