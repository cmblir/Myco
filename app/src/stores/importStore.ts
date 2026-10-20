// Bulk-import run state, lifted out of ConversationImport so a running sweep —
// which can take minutes over thousands of sessions — survives navigating away,
// the same pattern as reindexStore / ingestStore.
//
// The import commands emit `import-progress` (file counts + running tallies).
// This store consumes it for the life of the run, holds the final failures so a
// "retry failed" survives navigation, and a stage guard stops two imports racing
// the same _inbox/ and dedup ledger.

import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { ipc } from "../lib/ipc";
import type { AgentVaultSession, ImportOutcome, ImportProgress } from "../lib/ipc";
import { useVaultStore } from "./vaultStore";

export type ImportStage =
  | "idle"
  | "importing-file"
  | "sweeping"
  | "done"
  | "partial"
  | "error";

interface FailedItem {
  path: string;
  error: string;
}

interface ImportState {
  stage: ImportStage;
  /** File progress while sweeping (from import-progress). */
  done: number;
  total: number;
  file: string;
  /** Running tallies during the run, final counts after. */
  imported: number;
  skipped: number;
  failed: number;
  /** Conversations held back for a possible secret (final). */
  quarantined: { title: string; secrets: string[] }[];
  /** Files that failed — retryable, survives navigation (final). */
  failedItems: FailedItem[];
  /** Where the run that produced `failedItems` was writing, so a retry lands
   *  in the same place instead of re-queueing swept sessions for paid ingest. */
  lastDest: "_inbox" | "sessions";
  /** The retry queue belongs to this vault, never the next opened project. */
  lastVault: string | null;
  source: string;
  error: string | null;
  /** Import one picked export (instant → no progress bar). */
  importFile: (sourcePath: string) => Promise<void>;
  /** Import every on-disk session for a CLI tool (long → progress bar). */
  sweep: (kind: "claude-code" | "codex") => Promise<void>;
  /** Re-import just the files that failed last run. */
  retryFailed: () => Promise<void>;
  reset: () => void;
}

const CLEARED = {
  done: 0,
  total: 0,
  file: "",
  imported: 0,
  skipped: 0,
  failed: 0,
  quarantined: [],
  failedItems: [],
  error: null,
};

function running(stage: ImportStage): boolean {
  return stage === "importing-file" || stage === "sweeping";
}

let runSequence = 0;

/** Run one import command with its progress listener, updating the store. */
async function drive(
  set: (partial: Partial<ImportState>) => void,
  stage: "importing-file" | "sweeping",
  invoke: (origin: AgentVaultSession, requestId: string) => Promise<ImportOutcome>,
): Promise<boolean> {
  const { currentVault: vault, vaultToken, isOpeningVault } = useVaultStore.getState();
  if (!vault || isOpeningVault) return false;
  const sequence = ++runSequence;
  const requestId = crypto.randomUUID();
  let origin: AgentVaultSession | null = null;
  const isCurrent = (): boolean => {
    const current = useVaultStore.getState();
    return sequence === runSequence && !current.isOpeningVault &&
      current.currentVault?.path === vault.path && current.vaultToken === vaultToken;
  };
  set({ stage, source: "", lastVault: vault.path, ...CLEARED });
  let off: (() => void) | null = null;
  try {
    // Only the sweep streams progress; a single file finishes before this fires.
    off = await listen<ImportProgress>("import-progress", (e) => {
      if (!isCurrent() || !origin || e.payload.origin?.vaultPath !== origin.vaultPath ||
          e.payload.origin.openingToken !== origin.openingToken || e.payload.requestId !== requestId) return;
      const { done, total, file, imported, skipped, failed } = e.payload;
      set({ done, total, file, imported, skipped, failed });
    });
    if (!isCurrent()) return false;
    origin = Object.freeze(await ipc.agentVaultSession());
    if (!isCurrent()) return false;
    if (origin.vaultPath !== vault.path) {
      throw new Error("Native import opening differs from the requested vault");
    }
    const outcome = await invoke(origin, requestId);
    if (!isCurrent()) return false;
    const hasFailed = outcome.failed.length > 0;
    const hasCompleted = outcome.imported + outcome.skipped > 0;
    set({
      stage: hasFailed ? hasCompleted ? "partial" : "error" :
        outcome.quarantined.length > 0 ? "partial" : "done",
      source: outcome.source,
      imported: outcome.imported,
      skipped: outcome.skipped,
      failed: outcome.failed.length,
      quarantined: outcome.quarantined,
      failedItems: outcome.failed,
      error: hasFailed && !hasCompleted ? outcome.failed[0].error : null,
    });
  } catch (err) {
    if (!isCurrent()) return false;
    set({ stage: "error", error: String(err) });
  } finally {
    off?.();
    if (sequence === runSequence && !isCurrent()) {
      set({ stage: "idle", source: "", lastVault: null, ...CLEARED });
    }
  }
  return isCurrent();
}

export const useImportStore = create<ImportState>((set, get) => ({
  stage: "idle",
  ...CLEARED,
  source: "",
  lastDest: "sessions",
  lastVault: null,

  async importFile(sourcePath: string) {
    if (running(get().stage) || !useVaultStore.getState().currentVault) return;
    set({ lastDest: "_inbox" });
    const current = await drive(set, "importing-file", (origin, requestId) => ipc.importConversations(sourcePath, origin, requestId));
    if (current && get().imported > 0) await useVaultStore.getState().refreshTree();
  },

  async sweep(kind) {
    if (running(get().stage) || !useVaultStore.getState().currentVault) return;
    set({ lastDest: "sessions" });
    const current = await drive(set, "sweeping", (origin, requestId) => ipc.importSessionSweep(kind, origin, requestId));
    if (current && get().imported > 0) await useVaultStore.getState().refreshTree();
  },

  async retryFailed() {
    const { failedItems, lastDest, lastVault } = get();
    const paths = failedItems.map((f) => f.path);
    if (running(get().stage) || paths.length === 0 ||
      useVaultStore.getState().currentVault?.path !== lastVault) return;
    const current = await drive(set, "sweeping", (origin, requestId) => ipc.importPaths(paths, lastDest, origin, requestId));
    // A command failure has no per-file result. Keep the original queue so the
    // user can retry the same sources in the same destination.
    if (current && get().stage === "error" && get().failedItems.length === 0) {
      set({ failedItems, failed: failedItems.length });
    }
    if (current && get().imported > 0) await useVaultStore.getState().refreshTree();
  },

  reset: () => {
    runSequence++;
    set({ stage: "idle", source: "", lastVault: null, ...CLEARED });
  },
}));
