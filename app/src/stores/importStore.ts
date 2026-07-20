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
import type { ImportOutcome, ImportProgress } from "../lib/ipc";
import { useVaultStore } from "./vaultStore";

export type ImportStage =
  | "idle"
  | "importing-file"
  | "sweeping"
  | "done"
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

/** Run one import command with its progress listener, updating the store. */
async function drive(
  set: (partial: Partial<ImportState>) => void,
  stage: Exclude<ImportStage, "idle" | "done" | "error">,
  invoke: () => Promise<ImportOutcome>,
): Promise<void> {
  set({ stage, source: "", ...CLEARED });
  let off: (() => void) | null = null;
  try {
    // Only the sweep streams progress; a single file finishes before this fires.
    off = await listen<ImportProgress>("import-progress", (e) => {
      const { done, total, file, imported, skipped, failed } = e.payload;
      set({ done, total, file, imported, skipped, failed });
    });
    const outcome = await invoke();
    set({
      stage: "done",
      source: outcome.source,
      imported: outcome.imported,
      skipped: outcome.skipped,
      failed: outcome.failed.length,
      quarantined: outcome.quarantined,
      failedItems: outcome.failed,
      error: null,
    });
  } catch (err) {
    set({ stage: "error", error: String(err) });
  } finally {
    off?.();
  }
}

export const useImportStore = create<ImportState>((set, get) => ({
  stage: "idle",
  ...CLEARED,
  source: "",

  async importFile(sourcePath: string) {
    if (running(get().stage) || !useVaultStore.getState().currentVault) return;
    await drive(set, "importing-file", () => ipc.importConversations(sourcePath));
    if (get().imported > 0) await useVaultStore.getState().refreshTree();
  },

  async sweep(kind) {
    if (running(get().stage) || !useVaultStore.getState().currentVault) return;
    await drive(set, "sweeping", () => ipc.importSessionSweep(kind));
    if (get().imported > 0) await useVaultStore.getState().refreshTree();
  },

  async retryFailed() {
    const paths = get().failedItems.map((f) => f.path);
    if (running(get().stage) || paths.length === 0) return;
    await drive(set, "sweeping", () => ipc.importPaths(paths));
    if (get().imported > 0) await useVaultStore.getState().refreshTree();
  },

  reset: () => set({ stage: "idle", source: "", ...CLEARED }),
}));
