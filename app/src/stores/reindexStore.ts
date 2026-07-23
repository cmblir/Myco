// Reindex run state, lifted out of PageSettings so a running reindex survives
// navigating away (same pattern as ingestStore / lintStore).
//
// Reindex is the slowest thing the app does — roughly half a second per chunk,
// so minutes on a real vault — which makes it the run most likely to outlive the
// panel that started it. While the state lived in the component, leaving
// Settings dropped it: coming back showed an idle, enabled button while the
// backend was still working, so a second click started a SECOND reindex against
// the same index. Both then crawled (embed calls serialise on the model's
// mutex), their progress events interleaved in the UI, and both wrote the same
// index file.
//
// The store gives the run one identity: a re-entry guard so it cannot be
// started twice, and listeners that live for the run rather than for the panel.

import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { ipc } from "../lib/ipc";
import { BUILTIN_EMBED_MODEL } from "../lib/providers";
import { useVaultStore } from "./vaultStore";

/** Five states, in the order a run passes through them. */
export type ReindexStage =
  | "idle"
  | "loading-model"
  | "indexing"
  | "done"
  | "error";

interface ReindexState {
  stage: ReindexStage;
  /** Pages considered so far / total. Only meaningful while indexing. */
  done: number;
  total: number;
  /** The page currently being considered. */
  page: string;
  /** Pages in the index after a successful run. */
  indexed: number;
  /**
   * Pages the index holds right now; `null` until asked.
   *
   * Lives here so the features that DEPEND on the index can tell "no index" from
   * "no results" — they could not, and both rendered as nothing: the command
   * palette's semantic group simply never appeared, the Related panel returned
   * null, and a new user got a quietly worse product with no hint that the
   * feature existed or how to turn it on.
   */
  indexedPages: number | null;
  error: string | null;
  reindex: () => Promise<void>;
  /** Read the index's size. Cheap (it hits the in-memory VectorCache). */
  refreshStatus: () => Promise<void>;
  reset: () => void;
}

interface ModelLoadEvent {
  loading: boolean;
  ok: boolean;
}
interface ProgressEvent {
  done: number;
  total: number;
  page: string;
}

export const useReindexStore = create<ReindexState>((set, get) => ({
  stage: "idle",
  done: 0,
  total: 0,
  page: "",
  indexed: 0,
  indexedPages: null,
  error: null,

  async refreshStatus() {
    if (!useVaultStore.getState().currentVault) return;
    const status = await ipc.embeddingsStatus().catch(() => null);
    set({ indexedPages: status?.indexed_pages ?? null });
  },

  async reindex() {
    const vault = useVaultStore.getState().currentVault;
    // The guard that stops two runs racing the same index. `running` is any
    // stage that has work in flight.
    const stage = get().stage;
    if (!vault || stage === "loading-model" || stage === "indexing") return;

    // The first local call of the session pays for the model (measured: 873 ms
    // against a warm page cache, 11.7 s cold), and the backend announces that
    // before any page progress — so start there and let the first progress
    // event move us on.
    set({ stage: "loading-model", done: 0, total: 0, page: "", error: null });
    const offs: (() => void)[] = [];
    try {
      offs.push(
        await listen<ModelLoadEvent>("local-model-load", (e) => {
          if (e.payload.loading) set({ stage: "loading-model" });
        }),
      );
      offs.push(
        await listen<ProgressEvent>("reindex-progress", (e) => {
          const { done, total, page } = e.payload;
          set({ stage: "indexing", done, total, page });
        }),
      );
      const indexed = await ipc.reindexEmbeddings("builtin-local", BUILTIN_EMBED_MODEL);
      set({ stage: "done", indexed, indexedPages: indexed, error: null });
    } catch (err) {
      set({ stage: "error", error: String(err) });
    } finally {
      // Never outlive the run — the same lifecycle rule the other stores follow.
      for (const off of offs) off();
    }
  },

  reset: () => set({ stage: "idle", done: 0, total: 0, page: "", error: null }),
}));
