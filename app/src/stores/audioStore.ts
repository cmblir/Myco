// Audio Overview run store (Feature 5). Owns generation of the two-host script,
// transcript persistence to the vault, and playback state driven by the browser
// TTS (tts.ts). One overview at a time; playback highlights the current turn.

import { create } from "zustand";
import {
  generateScript,
  saveTranscript,
  type AudioScript,
} from "../lib/audioOverview";
import { speakTurns, ttsAvailable, type SpeechController } from "../lib/tts";
import { canGenerate } from "../lib/chat";
import { ipc } from "../lib/ipc";
import { STRINGS } from "../lib/i18n";
import { useUIStore } from "./uiStore";
import { useVaultStore } from "./vaultStore";

/** This store surfaces plain user-facing text, so it reads the language off
 *  uiStore rather than taking a `Strings` prop (ingestStore's convention). */
function t(): (typeof STRINGS)["en"] {
  return STRINGS[useUIStore.getState().lang] ?? STRINGS.en;
}

/** No provider anywhere can write prose. Reported instead of the backend's
 *  English CHAT_MODEL_MISSING, which is what the owner actually saw. */
function needsProviderText(): string {
  return (
    t().au_needs_provider ??
    "Audio overview writes new prose, so it needs an AI provider. Pick one under Settings → Model."
  );
}

/** Local ISO timestamp (yyyy-mm-ddThh:mm). App-side date is fine here. */
function nowIso(): string {
  return new Date().toISOString().slice(0, 16).replace("T", " ");
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
  play: (fromTurn?: number) => void;
  pause: () => void;
  stop: () => void;
  seek: (turn: number) => void;
  reset: () => void;
}

let controller: SpeechController | null = null;

export const useAudioStore = create<AudioState>((set, get) => ({
  generating: false,
  playing: false,
  script: null,
  transcriptPath: null,
  currentTurn: -1,
  error: null,
  ttsAvailable: ttsAvailable(),

  async generate(title, pages) {
    const vault = useVaultStore.getState().currentVault;
    if (!vault || get().generating || pages.length === 0) return;
    get().stop();
    set({
      generating: true,
      error: null,
      script: null,
      transcriptPath: null,
      currentTurn: -1,
    });
    try {
      // Fail fast and legibly when nothing can generate: the backend's
      // refusal is an English sentence about bundled chat models, which is
      // neither actionable nor translated.
      const s = await ipc.getSettings().catch(() => null);
      if (s && !canGenerate(s.query_provider) && !canGenerate(s.ingest_provider)) {
        set({ error: needsProviderText(), generating: false });
        return;
      }
      const script = await generateScript(vault.path, pages, title);
      // Persist the transcript immediately so a later playback issue never
      // loses the generated artifact.
      const path = await saveTranscript(vault.path, script, nowIso()).catch(
        () => null,
      );
      set({ script, transcriptPath: path, generating: false });
      void useVaultStore.getState().refreshTree();
    } catch (err) {
      const msg = String(err);
      set({
        error: msg.includes("no local chat model is bundled")
          ? needsProviderText()
          : msg,
        generating: false,
      });
    }
  },

  play(fromTurn) {
    const { script } = get();
    if (!script) return;
    const start = fromTurn ?? Math.max(0, get().currentTurn);
    controller?.cancel();
    controller = speakTurns(script.turns, start, {
      onTurn: (i) => set({ currentTurn: i }),
      onDone: () => set({ playing: false, currentTurn: -1 }),
      onError: (msg) => set({ error: msg, playing: false }),
    });
    set({ playing: true });
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
