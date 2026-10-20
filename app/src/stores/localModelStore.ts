import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import {
  ipc,
  type LocalChatModelProgress,
  type LocalChatStatus,
} from "../lib/ipc";
import {
  BUILTIN_CHAT_MODEL,
  BUILTIN_FAST_CHAT_MODEL,
  BUILTIN_MODEL,
} from "../lib/providers";
import { useSettingsStore } from "./settingsStore";

export const LOCAL_CHAT_MODEL_BYTES = 2_707_513_696;
export const FAST_LOCAL_CHAT_MODEL_BYTES = 1_270_808_032;
type PinnedChatModel =
  | typeof BUILTIN_CHAT_MODEL
  | typeof BUILTIN_FAST_CHAT_MODEL;
interface DownloadRun {
  revision: number;
  cancelled: boolean;
}
// Native installation has one global run. Claim ownership before listener setup.
let downloadLease: DownloadRun | null = null;
export type LocalModelStage =
  | "checking"
  | "missing"
  | "downloading"
  | "ready"
  | "error";

interface LocalModelState {
  stage: LocalModelStage;
  downloaded: number;
  total: number;
  pct: number;
  cancelling: boolean;
  error: string | null;
  checkStatus: () => Promise<void>;
  download: () => Promise<void>;
  cancelDownload: () => Promise<void>;
  selectForAsk: (mode: "generation" | "quotes") => Promise<void>;
  selectForIngest: () => Promise<void>;
}

// The run belongs to the application session, not to the settings panel.
// Availability checks never install weights or select an answer model.
export function createLocalModelStore(modelId: PinnedChatModel) {
  if (modelId !== BUILTIN_CHAT_MODEL && modelId !== BUILTIN_FAST_CHAT_MODEL)
    throw new Error("unsupported pinned local model");
  const modelBytes =
    modelId === BUILTIN_FAST_CHAT_MODEL
      ? FAST_LOCAL_CHAT_MODEL_BYTES
      : LOCAL_CHAT_MODEL_BYTES;
  return create<LocalModelState>((set, get) => {
    let revision = 0;
    let isChecking = false;
    let active: DownloadRun | null = null;

    function applyStatus(status: LocalChatStatus, expectedRevision: number) {
      if (revision !== expectedRevision) return;
      if (
        status.model_id !== modelId ||
        !Number.isSafeInteger(status.bytes) ||
        status.bytes < 0 ||
        (status.state === "ready" && status.bytes !== modelBytes)
      ) {
        throw new Error("installed model does not match the expected artifact");
      }
      if (status.state === "error") {
        set({
          stage: "error",
          error: status.reason || "model verification failed",
        });
      } else if (status.state === "ready" || status.state === "missing") {
        set({
          stage: status.state,
          downloaded: status.state === "ready" ? status.bytes : 0,
          pct: status.state === "ready" ? 100 : 0,
          error: null,
        });
      } else {
        throw new Error("invalid local model status");
      }
    }

    return {
      stage: "checking",
      downloaded: 0,
      total: modelBytes,
      pct: 0,
      cancelling: false,
      error: null,

      async checkStatus() {
        if (active || isChecking) return;
        isChecking = true;
        const currentRevision = ++revision;
        set({ stage: "checking", error: null });
        try {
          applyStatus(await ipc.localChatStatus(modelId), currentRevision);
        } catch (error) {
          if (revision === currentRevision)
            set({ stage: "error", error: String(error) });
        } finally {
          isChecking = false;
        }
      },

      async download() {
        if (active || downloadLease || get().stage === "ready") return;
        const run = { revision: ++revision, cancelled: false };
        active = run;
        downloadLease = run;
        set({
          stage: "downloading",
          downloaded: 0,
          total: modelBytes,
          pct: 0,
          cancelling: false,
          error: null,
        });
        let unlisten: (() => void) | undefined;
        try {
          unlisten = await listen<LocalChatModelProgress>(
            "local-chat-model-progress",
            ({ payload }) => {
              if (
                revision !== run.revision ||
                get().stage !== "downloading" ||
                run.cancelled
              )
                return;
              const { downloaded, total, pct } = payload;
              if (
                total !== modelBytes ||
                !Number.isSafeInteger(downloaded) ||
                downloaded < get().downloaded ||
                downloaded > total ||
                !Number.isInteger(pct) ||
                pct < 0 ||
                pct > 100 ||
                pct > Math.floor((downloaded * 100) / total)
              )
                return;
              set({ downloaded, pct: Math.max(get().pct, pct) });
            },
          );
          // Cancellation may arrive while the asynchronous listener is created.
          // In that case do not start a backend run after the cancellation.
          if (run.cancelled) {
            applyStatus(await ipc.localChatStatus(modelId), run.revision);
          } else {
            const status = await ipc.downloadLocalChatModel(modelId);
            applyStatus(
              run.cancelled ? await ipc.localChatStatus(modelId) : status,
              run.revision,
            );
          }
        } catch (error) {
          if (run.cancelled && String(error).includes("cancelled")) {
            try {
              applyStatus(await ipc.localChatStatus(modelId), run.revision);
            } catch (statusError) {
              set({ stage: "error", error: String(statusError) });
            }
          } else if (revision === run.revision) {
            set({ stage: "error", error: String(error) });
          }
        } finally {
          unlisten?.();
          if (active === run) active = null;
          if (downloadLease === run) downloadLease = null;
          if (revision === run.revision) set({ cancelling: false });
        }
      },

      async cancelDownload() {
        const run = active;
        if (!run || get().cancelling) return;
        run.cancelled = true;
        set({ cancelling: true, error: null });
        try {
          await ipc.cancelLocalChatModelDownload();
        } catch (error) {
          if (active === run) set({ cancelling: false, error: String(error) });
        }
        // Acknowledgement alone does not release the run: wait for download()
        // to settle, dispose its listener and finish native temporary cleanup.
      },

      async selectForAsk(mode) {
        const settings = useSettingsStore.getState();
        if (
          !settings.settings ||
          settings.saving ||
          (mode === "generation" && get().stage !== "ready")
        )
          return;
        await settings.selectRole({ role: "ask", providerId: "builtin-local", modelId: mode === "generation" ? modelId : BUILTIN_MODEL, effort: "(default)" });
      },

      async selectForIngest() {
        const settings = useSettingsStore.getState();
        if (!settings.settings || settings.saving || get().stage !== "ready")
          return;
        await settings.selectRole({ role: "compilation", providerId: "builtin-local", modelId, effort: "(default)" });
      },
    };
  });
}

export const useLocalModelStore = createLocalModelStore(BUILTIN_CHAT_MODEL);
export const useFastLocalModelStore = createLocalModelStore(
  BUILTIN_FAST_CHAT_MODEL,
);
