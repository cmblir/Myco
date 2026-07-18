// Text-to-speech via the browser's Web Speech API (Feature 5). Offline: uses
// the OS's installed voices through the Tauri WKWebView's speechSynthesis — no
// bundled engine, no network, no installer bloat. Two distinct voices give the
// two-host dialogue its back-and-forth. Degrades gracefully where the API is
// absent (the caller checks `ttsAvailable()` and falls back to transcript-only).

import type { DialogueTurn } from "./audioOverview";

export function ttsAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    "speechSynthesis" in window &&
    typeof window.SpeechSynthesisUtterance === "function"
  );
}

/** Available OS voices. getVoices() can be empty until `voiceschanged` fires,
 *  so we wait briefly for it on first call. */
export function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  if (!ttsAvailable()) return Promise.resolve([]);
  const synth = window.speechSynthesis;
  const now = synth.getVoices();
  if (now.length) return Promise.resolve(now);
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve(synth.getVoices());
    };
    synth.addEventListener?.("voiceschanged", finish, { once: true });
    // Fallback: resolve after a short wait even if the event never fires.
    setTimeout(finish, 500);
  });
}

/** Pick two distinct voices, preferring ones matching `lang` (e.g. "ko", "ja"). */
export function pickVoices(
  voices: SpeechSynthesisVoice[],
  lang: string,
): { a: SpeechSynthesisVoice | null; b: SpeechSynthesisVoice | null } {
  if (voices.length === 0) return { a: null, b: null };
  const matching = voices.filter((v) => v.lang?.toLowerCase().startsWith(lang.toLowerCase()));
  const pool = matching.length ? matching : voices;
  const a = pool[0] ?? null;
  const b = pool.find((v) => v !== a) ?? pool[0] ?? null;
  return { a, b };
}

export interface SpeechController {
  pause: () => void;
  resume: () => void;
  cancel: () => void;
}

export interface SpeakOpts {
  lang?: string;
  /** Fired as each turn begins, with its index. */
  onTurn?: (index: number) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
}

/** Speak the dialogue turns sequentially, alternating voices per speaker.
 *  Returns a controller for pause/resume/cancel. Starts from `startIndex`. */
export function speakTurns(
  turns: DialogueTurn[],
  startIndex: number,
  opts: SpeakOpts = {},
): SpeechController {
  if (!ttsAvailable() || turns.length === 0) {
    opts.onDone?.();
    const noop = (): void => undefined;
    return { pause: noop, resume: noop, cancel: noop };
  }
  const synth = window.speechSynthesis;
  const lang = opts.lang ?? "en";
  // getVoices() can be empty until `voiceschanged` fires — on WebKit/WKWebView it
  // usually is on the first play. Picking then gives {null, null}, and BOTH hosts
  // fall back to the one default voice, losing the two-voice dialogue. loadVoices
  // exists precisely to wait for that event; wire it in (it was dead code, which
  // is why the race shipped). If voices are already present it resolves at once,
  // so the common case pays nothing.
  let picked = pickVoices(synth.getVoices(), lang);
  let i = Math.max(0, startIndex);
  let cancelled = false;

  synth.cancel(); // clear any prior queue

  const speakNext = (): void => {
    if (cancelled) return;
    if (i >= turns.length) {
      opts.onDone?.();
      return;
    }
    const turn = turns[i];
    opts.onTurn?.(i);
    const u = new SpeechSynthesisUtterance(turn.text);
    const voice = turn.speaker === "B" ? picked.b : picked.a;
    if (voice) u.voice = voice;
    u.rate = 1.02;
    u.onend = () => {
      i += 1;
      // Small gap between turns for a natural cadence.
      setTimeout(speakNext, 120);
    };
    u.onerror = (e) => {
      // "interrupted"/"canceled" are expected on cancel() — don't surface those.
      const err = (e as SpeechSynthesisErrorEvent).error;
      if (!cancelled && err && err !== "interrupted" && err !== "canceled") {
        opts.onError?.(String(err));
      }
    };
    synth.speak(u);
  };

  // If two distinct voices are already in hand, start now (zero delay). If not,
  // wait for the OS voice list before the first utterance so A and B differ.
  if (picked.a && picked.b && picked.a !== picked.b) {
    speakNext();
  } else {
    void loadVoices().then((vs) => {
      if (cancelled) return;
      picked = pickVoices(vs, lang);
      speakNext();
    });
  }

  return {
    pause: () => synth.pause(),
    resume: () => synth.resume(),
    cancel: () => {
      cancelled = true;
      synth.cancel();
    },
  };
}
