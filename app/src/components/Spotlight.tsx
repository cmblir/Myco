// The global-shortcut spotlight window's entire UI: one input, and the answer
// under it. A SECOND webview with its own JS context — it has no vault open and
// no queryStore, so it answers nothing itself. Enter emits the question and the
// main window runs the same `useQueryStore.ask` the Ask page runs (see
// lib/spotlight.ts); this file only renders what comes back.
//
// Voice quick-capture (W3–6 item 9, mockup M7): the mic button or ⌥M flips the
// card into a recording row (waveform, elapsed, ⏎ save / esc cancel); the
// audio goes to `save_voice_capture`, which whisper-transcribes it into the
// open vault's `_inbox/`. The recorder itself is lib/voiceCapture's injected
// state machine, so the walk is unit-tested without a mic.
//
// Palette is hardcoded dark, like the tray popover: a floating OS-level card is
// its own surface, not a themed page, and that keeps the app's theme/accent
// plumbing out of this webview entirely. Only the language is read (from the
// persisted uiStore, which shares localStorage with the main window).

import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import Viewer from "./Viewer";
import { ipc } from "../lib/ipc";
import { STRINGS } from "../lib/i18n";
import { Icon } from "../lib/icons";
import { isComposingKey } from "../lib/ime";
import {
  SPOTLIGHT_ANSWER_EVENT,
  SPOTLIGHT_ASK_EVENT,
  SPOTLIGHT_OPEN_EVENT,
  SPOTLIGHT_OPENED_EVENT,
  type SpotlightAnswer,
} from "../lib/spotlight";
import { formatTicker } from "../lib/time";
import {
  createVoiceMachine,
  type VoiceMachine,
  type VoiceState,
} from "../lib/voiceCapture";
import { useUIStore } from "../stores/uiStore";

/** In a plain browser, `?window=spotlight&mock=1` makes devMock answer the ask
 *  event with a canned extractive turn — that is how this window is looked at
 *  without the native shell (the real global keypress cannot be). */
export default function Spotlight(): JSX.Element {
  const lang = useUIStore((s) => s.lang);
  const t = STRINGS[lang];
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SpotlightAnswer | null>(null);
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  // First-use whisper model download percent; null outside that window.
  const [modelPct, setModelPct] = useState<number | null>(null);
  useEffect(() => {
    if (voiceState !== "saving") {
      setModelPct(null);
      return;
    }
    let gone = false;
    let unlisten: (() => void) | null = null;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<{ pct: number }>("whisper-model-progress", (e) =>
          setModelPct(e.payload.pct),
        ),
      )
      .then((u) => {
        if (gone) u();
        else unlisten = u;
      })
      .catch(() => {
        /* plain-browser dev: no Tauri backend */
      });
    return () => {
      gone = true;
      if (unlisten) unlisten();
    };
  }, [voiceState]);
  /** "whisper-missing" / "mic-denied" / a save failure — shown in ask mode. */
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  const [savedRel, setSavedRel] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const machineRef = useRef<VoiceMachine | null>(null);

  // The recording row replaces the ask row for the whole capture walk.
  const recordMode =
    voiceState === "recording" || voiceState === "saving" || voiceState === "saved";

  const machine = (): VoiceMachine => {
    machineRef.current ??= createVoiceMachine({
      getStream: () => navigator.mediaDevices.getUserMedia({ audio: true }),
      makeRecorder: (s) => new MediaRecorder(s),
      save: async (bytes) => {
        const saved = await ipc.saveVoiceCapture(Array.from(bytes));
        setSavedRel(saved.rel);
        return saved;
      },
      onChange: (state, error) => {
        setVoiceState(state);
        if (state === "recording") setVoiceNotice(null);
        if (state === "error") setVoiceNotice(error);
      },
    });
    return machineRef.current;
  };

  useEffect(() => {
    // The window itself is transparent; only the rounded card paints.
    document.documentElement.classList.add("spotlight-window");
    inputRef.current?.focus();
    let unlisteners: (() => void)[] = [];
    let cancelled = false;
    void import("@tauri-apps/api/event")
      .then(async ({ listen }) => [
        await listen<SpotlightAnswer>(SPOTLIGHT_ANSWER_EVENT, (e) => {
          setBusy(false);
          setResult(e.payload);
        }),
        // Reopened via the shortcut: the window is reused, so the previous
        // question (and any voice state) would still be sitting there.
        await listen(SPOTLIGHT_OPENED_EVENT, () => {
          setQuestion("");
          setResult(null);
          setBusy(false);
          machineRef.current?.cancel();
          setVoiceNotice(null);
          setSavedRel(null);
          inputRef.current?.focus();
        }),
      ])
      .then((us) => {
        if (cancelled) us.forEach((u) => u());
        else unlisteners = us;
      })
      .catch(() => {
        /* plain-browser dev: no Tauri event bus */
      });
    return () => {
      cancelled = true;
      unlisteners.forEach((u) => u());
      // Never leave the mic held by an unmounted component.
      machineRef.current?.cancel();
    };
  }, []);

  // Fit the OS window to the card: it is one input tall when empty and much
  // taller with an answer, and the window is transparent AND always-on-top —
  // leftover height is an invisible surface eating clicks meant for whatever is
  // underneath. Same measure-and-report pattern as the tray popover.
  useEffect(() => {
    const el = cardRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let last = 0;
    const ro = new ResizeObserver(() => {
      const h = Math.ceil(el.offsetHeight);
      if (h > 0 && h !== last) {
        last = h;
        void ipc.resizeSpotlight(h).catch(() => {
          /* plain-browser dev: no Tauri backend */
        });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
    // Mount-once: the card div is the same node in every render branch.
  }, []);

  // Elapsed ticker while the mic is live; the last value stays up during save.
  useEffect(() => {
    if (voiceState !== "recording") return;
    const t0 = Date.now();
    setElapsedMs(0);
    const id = window.setInterval(() => setElapsedMs(Date.now() - t0), 500);
    return () => window.clearInterval(id);
  }, [voiceState]);

  // Saved chip shown, then the window puts itself away (mockup M7-c).
  useEffect(() => {
    if (voiceState !== "saved") return;
    const id = window.setTimeout(() => close(), 1500);
    return () => window.clearTimeout(id);
  }, [voiceState]);

  // Back in ask mode (cancel / error), the input must have focus again.
  useEffect(() => {
    if (!recordMode) inputRef.current?.focus();
  }, [recordMode]);

  const close = (): void => {
    void ipc.closeSpotlight().catch(() => {
      /* plain-browser dev: no Tauri backend */
    });
  };

  const ask = (): void => {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setResult(null);
    void import("@tauri-apps/api/event")
      .then(({ emit }) => emit(SPOTLIGHT_ASK_EVENT, q))
      .catch(() => {
        // No bus means no answer is ever coming — don't spin forever.
        setBusy(false);
      });
  };

  /** Preflight whisper, then start the recorder. Whisper missing ⇒ hint and
   *  stay in ask mode — nothing would be able to save the capture. */
  const startRecording = (): void => {
    if (busy || recordMode) return;
    void ipc
      .whisperCheck()
      .then((s) => {
        if (!s.installed) {
          setVoiceNotice("whisper-missing");
          return;
        }
        setSavedRel(null);
        return machine().start();
      })
      .catch(() => setVoiceNotice("whisper-missing"));
  };

  // ⌥M toggles anywhere in the card: start when idle, stop-and-save while
  // recording (same as ⏎ — a toggle that discarded would lose the take).
  // Record mode has no input, so ⏎/esc are window-level here.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.altKey && e.code === "KeyM") {
        e.preventDefault();
        if (voiceState === "recording") void machine().stop();
        else startRecording();
        return;
      }
      if (voiceState === "recording") {
        if (e.key === "Enter") {
          e.preventDefault();
          void machine().stop();
        } else if (e.key === "Escape") {
          e.preventDefault();
          machine().cancel();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceState, busy, recordMode]);

  // A citation opens the app on that note: close first, then let the main
  // window resolve the link (it owns the file tree and the router).
  const openCitation = (target: string): void => {
    close();
    void import("@tauri-apps/api/event")
      .then(({ emit }) => emit(SPOTLIGHT_OPEN_EVENT, target))
      .catch(() => {
        /* plain-browser dev: no Tauri event bus */
      });
  };

  const noticeText =
    voiceNotice === "whisper-missing"
      ? (t.voice_whisper_missing ??
        "preparing voice recognition — the speech model downloads once (~190 MB) on first use. If this keeps failing, reinstall myco.")
      : voiceNotice === "mic-denied"
        ? (t.voice_mic_denied ??
          "The microphone is not available — allow myco to use it in System Settings.")
        : voiceNotice;

  return (
    <div className="spotlight-card" ref={cardRef}>
      {recordMode ? (
        <div className="spotlight-voice">
          <span aria-hidden className="voice-glyph">
            <Icon name="mic" size={16} />
          </span>
          {voiceState === "saved" ? (
            <span className="voice-saved chip-pop">
              {(t.voice_saved_chip ?? "{rel} — joins the next ingest").replace(
                "{rel}",
                savedRel ?? "",
              )}
            </span>
          ) : (
            <>
              <span aria-hidden className="voice-wave">
                <i />
                <i />
                <i />
                <i />
                <i />
              </span>
              <span className="voice-elapsed" role="timer">
                {formatTicker(elapsedMs)}
              </span>
              <span className="spotlight-hint">
                {voiceState === "saving"
                  ? modelPct !== null
                    ? (
                        t.voice_model_progress ??
                        "downloading the voice model — one time, {pct}%"
                      ).replace("{pct}", String(modelPct))
                    : "…"
                  : (t.voice_hint_recording ?? "⏎ save · esc cancel")}
              </span>
            </>
          )}
        </div>
      ) : (
        <div className="spotlight-input-row">
          <span aria-hidden className="spotlight-glyph">
            ✳
          </span>
          <input
            ref={inputRef}
            className="spotlight-input"
            value={question}
            placeholder={t.spot_placeholder ?? "Ask the wiki…"}
            aria-label={t.spot_placeholder ?? "Ask the wiki…"}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              // Esc closes; Enter asks — but never mid-IME-composition, where
              // Enter is the user committing Korean/Japanese input.
              if (e.key === "Escape") {
                e.preventDefault();
                close();
                return;
              }
              if (e.key === "Enter" && !isComposingKey(e.nativeEvent)) {
                e.preventDefault();
                ask();
              }
            }}
          />
          {busy ? (
            <span className="spotlight-status" role="status">
              {t.spot_thinking ?? "asking…"}
            </span>
          ) : null}
          <button
            type="button"
            className="icon-btn spotlight-mic"
            aria-label={t.voice_btn_label ?? "Voice capture"}
            title={`${t.voice_btn_label ?? "Voice capture"} (⌥M)`}
            onClick={startRecording}
          >
            <Icon name="mic" size={15} />
          </button>
        </div>
      )}

      {noticeText && !recordMode ? (
        <div className="spotlight-body spotlight-error" role="alert">
          {noticeText}
        </div>
      ) : null}

      {result?.error && !recordMode ? (
        <div className="spotlight-body spotlight-error" role="alert">
          {result.error}
        </div>
      ) : null}

      {result && !result.error && !recordMode ? (
        <div className="spotlight-body">
          {result.extractive ? (
            <div className="spotlight-label">
              {t.q_extractive_label ?? "From your notes (top matches, verbatim)"}
            </div>
          ) : null}
          <Viewer content={result.answer} onLinkClick={openCitation} />
          <div className="spotlight-hint">{t.spot_hint_open ?? ""}</div>
        </div>
      ) : null}

      {!result && !busy && !recordMode && !noticeText ? (
        <div className="spotlight-body spotlight-hint">
          {t.spot_hint_enter ?? ""}
        </div>
      ) : null}
    </div>
  );
}
