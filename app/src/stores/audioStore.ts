// Audio Overview run store (Feature 5). Owns generation of the two-host script,
// transcript persistence to the vault, and playback state driven by the browser
// TTS (tts.ts). One overview at a time; playback highlights the current turn.

import { create } from "zustand";
import {
  generateScript,
  saveTranscript,
  cancelAudioOverview,
  AudioOverviewError,
  type AudioScript,
} from "../lib/audioOverview";
import { speakTurns, ttsAvailable, LOCAL_SPEECH_UNAVAILABLE, type SpeechController } from "../lib/tts";
import { canGenerate, roleFor } from "../lib/chat";
import { ipc } from "../lib/ipc";
import type { AudioOverviewJobContext } from "../lib/ipc";
import { log } from "../lib/log";
import { STRINGS } from "../lib/i18n";
import { useUIStore } from "./uiStore";
import { useVaultStore } from "./vaultStore";

/** This store surfaces plain user-facing text, so it reads the language off
 *  uiStore rather than taking a `Strings` prop (ingestStore's convention). */
function t(): (typeof STRINGS)["en"] {
  return STRINGS[useUIStore.getState().lang] ?? STRINGS.en;
}

/** The selected Audio model cannot write prose. Reported instead of the backend's
 *  English CHAT_MODEL_MISSING, which is what the owner actually saw. */
function needsProviderText(): string {
  return t().au_needs_provider;
}

function failureText(error: unknown, publishing = false): string {
  if (error instanceof AudioOverviewError) {
    const strings = t();
    let message: string;
    switch (error.code) {
      case "stale":
      case "source": message = strings.au_source_failed; break;
      case "generation": message = strings.au_generation_failed; break;
      case "partial": message = strings.au_publication_partial.replace("{path}", error.retainedPath ?? ""); break;
      case "publication": message = strings.au_publication_failed; break;
      case "cancellation": message = strings.au_cancel_failed; break;
    }
    return error.cancellationUnconfirmed ? `${message} ${strings.au_cancel_failed}` : message;
  }
  return (String(error).includes("no local chat model is bundled") ||
    String(error).includes("native feature selections are unavailable"))
    ? needsProviderText()
    : publishing ? t().au_publication_failed : t().au_generation_failed;
}

export interface AudioState {
  generating: boolean;
  playing: boolean;
  script: AudioScript | null;
  transcriptPath: string | null;
  currentTurn: number;
  error: string | null;
  ttsAvailable: boolean;
  generate: (title: string, pages: string[]) => Promise<void>;
  cancelGeneration: () => Promise<void>;
  play: (fromTurn?: number) => void;
  pause: () => void;
  stop: () => void;
  seek: (turn: number) => void;
  reset: () => void;
}

let controller: SpeechController | null = null;
interface GenerationRun {
  vaultPath: string;
  vaultToken: string;
  job?: AudioOverviewJobContext;
}
let generationRun: GenerationRun | null = null;
let visibleCancellationRun: GenerationRun | null = null;

export const useAudioStore = create<AudioState>((set, get) => ({
  generating: false,
  playing: false,
  script: null,
  transcriptPath: null,
  currentTurn: -1,
  error: null,
  ttsAvailable: ttsAvailable(),

  async generate(title, pages) {
    const {
      currentVault: vault,
      vaultToken,
      isOpeningVault,
    } = useVaultStore.getState();
    if (!vault || isOpeningVault || pages.length === 0) return;
    if (
      get().generating &&
      generationRun?.vaultPath === vault.path &&
      generationRun.vaultToken === vaultToken
    )
      return;
    const previous = generationRun;
    const run: GenerationRun = { vaultPath: vault.path, vaultToken };
    generationRun = run;
    visibleCancellationRun = null;
    if (previous?.job) void cancelAudioOverview(previous.job).catch(() => log.warn("audio.stale_cancel_unconfirmed"));
    const isCurrent = (): boolean => {
      const state = useVaultStore.getState();
      return (
        generationRun === run &&
        !state.isOpeningVault &&
        state.currentVault?.path === run.vaultPath &&
        state.vaultToken === run.vaultToken
      );
    };
    get().stop();
    set({
      generating: true,
      error: null,
      script: null,
      transcriptPath: null,
      currentTurn: -1,
    });
    let persisted = false;
    let retainedPartial = false;
    let publishing = false;
    try {
      // Fail fast and legibly when nothing can generate: the backend's
      // refusal is an English sentence about bundled chat models, which is
      // neither actionable nor translated.
      const s = await ipc.getSettings().catch(() => {
        log.warn("audio.settings_unavailable");
        return null;
      });
      if (!isCurrent()) return;
      if (s) {
        const selected = roleFor("audio", s);
        if (!canGenerate(selected.provider, selected.model)) {
          set({ error: needsProviderText(), generating: false });
          return;
        }
      }
      const script = await generateScript(vault.path, pages, title, {
        isCurrent,
        onJob: (context) => { run.job = context; },
      });
      if (!isCurrent()) return;
      // Persist the transcript immediately so a later playback issue never
      // loses the generated artifact. A failed save is not a successful overview.
      // Native publication revalidates the source and opening, and enforces
      // absence CAS. The caller's date cannot change the begin-bound target.
      publishing = true;
      const path = await saveTranscript(vault.path, script, new Date().toISOString());
      persisted = true;
      if (!isCurrent()) return;
      set({ script, transcriptPath: path, generating: false });
      void useVaultStore.getState().refreshTree();
    } catch (err) {
      retainedPartial = err instanceof AudioOverviewError && err.code === "partial";
      if (!isCurrent()) {
        if (visibleCancellationRun === run && err instanceof AudioOverviewError &&
          (err.cancellationUnconfirmed || err.code === "cancellation")) {
          set({ error: t().au_cancel_failed });
        }
        return;
      }
      set({
        error: failureText(err, publishing),
        generating: false,
      });
    } finally {
      if (!persisted && !retainedPartial && run.job) {
        try {
          await cancelAudioOverview(run.job);
        } catch {
          if (isCurrent() && !get().error?.includes(t().au_cancel_failed)) {
            set({ error: [get().error, t().au_cancel_failed].filter(Boolean).join(" ") });
          }
        }
      }
      // A stale run may settle after reset or a newer opening's generation.
      if (generationRun === run) {
        generationRun = null;
        set({ generating: false });
      }
    }
  },

  async cancelGeneration() {
    const run = generationRun;
    if (!run) return;
    generationRun = null;
    visibleCancellationRun = run;
    set({ generating: false, error: t().au_stopped });
    if (run.job) {
      try {
        await cancelAudioOverview(run.job);
      } catch {
        if (visibleCancellationRun === run) {
          set({ error: t().au_cancel_failed });
        }
      }
    }
  },

  play(fromTurn) {
    const { script } = get();
    if (!script) return;
    const start = fromTurn ?? Math.max(0, get().currentTurn);
    controller?.cancel();
    set({ playing: true, error: null });
    controller = speakTurns(script.turns, start, {
      lang: useUIStore.getState().lang,
      onTurn: (i) => set({ currentTurn: i }),
      onDone: () => set({ playing: false, currentTurn: -1 }),
      onError: (msg) => set({
        error: msg === LOCAL_SPEECH_UNAVAILABLE ? t().au_no_tts : msg,
        playing: false,
        currentTurn: -1,
      }),
    });
  },

  pause() {
    controller?.pause();
    set({ playing: false });
  },

  stop() {
    controller?.cancel();
    controller = null;
    set({ playing: false, currentTurn: -1 });
  },

  seek(turn) {
    get().play(turn);
  },

  reset() {
    const run = generationRun;
    generationRun = null;
    visibleCancellationRun = null;
    if (run?.job) void cancelAudioOverview(run.job).catch(() => log.warn("audio.reset_cancel_unconfirmed"));
    get().stop();
    set({
      generating: false,
      playing: false,
      script: null,
      transcriptPath: null,
      currentTurn: -1,
      error: null,
    });
  },
}));
