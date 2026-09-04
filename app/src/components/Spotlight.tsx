// The global-shortcut spotlight window's entire UI: one input, and the answer
// under it. A SECOND webview with its own JS context — it has no vault open and
// no queryStore, so it answers nothing itself. Enter emits the question and the
// main window runs the same `useQueryStore.ask` the Ask page runs (see
// lib/spotlight.ts); this file only renders what comes back.
//
// Voice quick-capture (W3–6 item 9, mockup M7): the mic button or ⌥M flips the
// card into a recording row (waveform, live caption, elapsed, ⏎ save / esc
// cancel); the audio goes to `save_voice_capture`, which whisper-transcribes it
// into the open vault's `_inbox/`. The recorder itself is lib/voiceCapture's
// injected state machine, so the walk is unit-tested without a mic. The
// waveform and the caption line are the notch's components (VoiceWave,
// LiveCaption) — one implementation of the recording surface.
//
// Palette is hardcoded dark, like the tray popover: a floating OS-level card is
// its own surface, not a themed page, and that keeps the app's theme/accent
// plumbing out of this webview entirely. Only the language is read (from the
// persisted uiStore, which shares localStorage with the main window).

import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import LiveCaption from "./LiveCaption";
import Viewer from "./Viewer";
import VoiceWave from "./VoiceWave";
import { ipc } from "../lib/ipc";
import { STRINGS } from "../lib/i18n";
import { Icon } from "../lib/icons";
import { isComposingKey } from "../lib/ime";
import { EMPTY_CAPTION, startPartialLoop } from "../lib/liveCaption";
import type { CaptionState } from "../lib/liveCaption";
import {
  SPOTLIGHT_ANSWER_EVENT,
  SPOTLIGHT_ASK_EVENT,
  SPOTLIGHT_OPEN_EVENT,
  SPOTLIGHT_OPENED_EVENT,
  type SpotlightAnswer,
} from "../lib/spotlight";
import { formatTicker } from "../lib/time";
import {
  VOICE_HOTKEY_EVENT,
  createVoiceMachine,
  voiceHotkeyGate,
  type VoiceMachine,
  type VoiceState,
} from "../lib/voiceCapture";
import {
  createLevelHistory,
  createSilenceWatch,
  type LevelHistory,
  type SilenceWatch,
} from "../lib/voiceLevel";

/** Same figures as the notch (lib/notchDriver): a dead input is zeros, a live
 *  mic is not, and a pause must never read as "no sound". */
const SILENCE_RMS = 0.003;
const SILENCE_HOLD_MS = 2500;
import { createWavRecorder } from "../lib/wavRecorder";
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
  // Transcription percent (whisper -pp via run_streaming); null until the
  // first progress line. Distinct from the one-time model download above.
  const [transcribePct, setTranscribePct] = useState<number | null>(null);
  // Which half of save_voice_capture is running (Rust `voice-capture-stage`).
  // Defaults to transcribing so the row never shows a bare "…" while the
  // model loads before whisper's first progress line.
  const [stage, setStage] = useState<"transcribing" | "saving">("transcribing");
  useEffect(() => {
    if (voiceState !== "saving") {
      setModelPct(null);
      setTranscribePct(null);
      setStage("transcribing");
      return;
    }
    let gone = false;
    const unlisteners: (() => void)[] = [];
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        Promise.all([
          listen<{ pct: number }>("whisper-model-progress", (e) =>
            setModelPct(e.payload.pct),
          ),
          listen<{ pct: number }>("whisper-transcribe-progress", (e) =>
            setTranscribePct(e.payload.pct),
          ),
          listen<{ stage: "transcribing" | "saving" }>("voice-capture-stage", (e) =>
            setStage(e.payload.stage),
          ),
        ]),
      )
      .then((us) => {
        if (gone) us.forEach((u) => u());
        else unlisteners.push(...us);
      })
      .catch(() => {
        /* plain-browser dev: no Tauri backend */
      });
    return () => {
      gone = true;
      unlisteners.forEach((u) => u());
    };
  }, [voiceState]);
  /** "whisper-missing" / "mic-denied" / a save failure — shown in ask mode. */
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  const [savedRel, setSavedRel] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  // The "nothing is coming in" verdict. A muted or wrong mic used to look
  // identical to a working one; the waveform follows the real signal and goes
  // flat when it is silent, and this says so in words.
  const [noInput, setNoInput] = useState(false);
  // Live transcript of the take so far (lib/liveCaption).
  const [caption, setCaption] = useState<CaptionState>(EMPTY_CAPTION);
  // Waveform data. A ref, not state: it is written ~12×/s and VoiceWave reads
  // it on its own rAF, so the audio path never pumps React.
  const levelsRef = useRef<LevelHistory | null>(null);
  levelsRef.current ??= createLevelHistory();
  // When the ScriptProcessor last fired; the ticker feeds the silence watch
  // itself if frames stop, so a dead input still flips `noInput`.
  const lastFrameAtRef = useRef(0);
  const silenceRef = useRef<SilenceWatch | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const machineRef = useRef<VoiceMachine | null>(null);

  // The recording row replaces the ask row for the whole capture walk.
  const recordMode =
    voiceState === "recording" || voiceState === "saving" || voiceState === "saved";

  const machine = (): VoiceMachine => {
    machineRef.current ??= createVoiceMachine({
      getStream: () => navigator.mediaDevices.getUserMedia({ audio: true }),
      makeRecorder: (s) => createWavRecorder(s),
      save: async (bytes) => {
        const saved = await ipc.saveVoiceCapture(Array.from(bytes));
        setSavedRel(saved.rel);
        return saved;
      },
      onChange: (state, error) => {
        // Fresh ring per state: the wave must not keep scrolling the last
        // take's levels next to "Transcribing…".
        levelsRef.current = createLevelHistory();
        setVoiceState(state);
        setNoInput(false);
        if (state === "recording") {
          setVoiceNotice(null);
          setCaption(EMPTY_CAPTION);
          silenceRef.current = createSilenceWatch({ threshold: SILENCE_RMS, holdMs: SILENCE_HOLD_MS });
          lastFrameAtRef.current = Date.now();
        }
        // Whisper is now reading the whole take: nothing more will change, so
        // the caption stops churning (all bright) rather than being cleared —
        // what was said is the one thing worth reading during the save.
        if (state === "saving") {
          setCaption((c) => ({ confirmed: [...c.confirmed, ...c.interim], interim: [] }));
        }
        if (state === "error") setVoiceNotice(error);
      },
      onLevel: (rms) => {
        const now = Date.now();
        lastFrameAtRef.current = now;
        levelsRef.current?.push(rms);
        // Same value re-set ~12×/s is a React bailout; only the flip renders.
        setNoInput(silenceRef.current?.push(rms, now).silent ?? false);
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
    const id = window.setInterval(() => {
      const now = Date.now();
      setElapsedMs(now - t0);
      // No audio frames for a tick: feed the watch ourselves so it can flip.
      if (now - lastFrameAtRef.current > 500 && silenceRef.current) {
        setNoInput(silenceRef.current.push(0, now).silent);
      }
    }, 500);
    return () => window.clearInterval(id);
  }, [voiceState]);

  // Live captions: whisper has no streaming mode, so the take's WAV-so-far is
  // re-transcribed every few seconds (lib/liveCaption). Bound to the machine's
  // recording state, so the loop stops on stop/cancel/unmount; startPartialLoop
  // itself drops a result that lands after its own stop().
  useEffect(() => {
    if (voiceState !== "recording") return;
    return startPartialLoop({
      // Non-null throughout this effect (the machine is recording); the empty
      // fallback covers only the tick racing the stop, and whisper reading
      // nothing simply leaves the caption where it was.
      snapshot: () => machine().snapshot() ?? new Blob(),
      transcribe: ipc.transcribePartial,
      onCaption: setCaption,
    });
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

  // ⌥M: start when idle, stop-and-save while recording (same as ⏎ — a toggle
  // that discarded would lose the take). Re-made every render (it reads
  // voiceState) and mirrored into a ref, so the mount-once hotkey listener
  // below reaches the current one without re-subscribing.
  const toggleVoice = (): void => {
    if (!voiceHotkeyGate()) return;
    if (voiceState === "recording") void machine().stop();
    else startRecording();
  };
  const toggleVoiceRef = useRef(toggleVoice);
  toggleVoiceRef.current = toggleVoice;

  // The GLOBAL ⌥M (registered in spotlight.rs) lands here when the notch
  // surface is off: this window is then the only voice surface there is.
  // Mount-once — a subscription torn down and rebuilt on every state change
  // has a gap in it, and the gap would eat presses mid-take.
  useEffect(() => {
    let gone = false;
    let unlisten: (() => void) | null = null;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen(VOICE_HOTKEY_EVENT, () => toggleVoiceRef.current()),
      )
      .then((u) => {
        if (gone) u();
        else unlisten = u;
      })
      .catch(() => {
        /* plain-browser dev: no Tauri event bus */
      });
    return () => {
      gone = true;
      if (unlisten) unlisten();
    };
  }, []);

  // Record mode has no input, so ⏎/esc are window-level here; ⌥M works
  // anywhere in the card even when the global registration was refused.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.altKey && e.code === "KeyM") {
        e.preventDefault();
        toggleVoice();
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
              {/* Wave over transcript, the notch's stack — the caption needs
                  the row's full width, and the mic glyph and clock frame it. */}
              <span className="voice-live">
                <VoiceWave history={levelsRef.current} color="#ff6b5e" />
                <LiveCaption
                  caption={caption}
                  noInputText={
                    noInput
                      ? (t.voice_no_input ??
                        "No sound is coming in — check the microphone")
                      : null
                  }
                />
              </span>
              <span className="voice-elapsed" role="timer">
                {formatTicker(elapsedMs)}
              </span>
              {/* Permanent live region: one created in the same render as its
                  text change is not announced. The keys stay put now that the
                  caption line carries the no-input warning. */}
              <span className="spotlight-hint" role="status">
                {voiceState === "saving"
                  ? modelPct !== null
                    ? (
                        t.voice_model_progress ??
                        "downloading the voice model — one time, {pct}%"
                      ).replace("{pct}", String(modelPct))
                    : stage === "saving"
                      ? (t.voice_stage_saving ?? "Saving note…")
                      : transcribePct !== null
                        ? (t.voice_transcribe_progress ?? "Transcribing… {pct}%").replace(
                            "{pct}",
                            String(transcribePct),
                          )
                        : (t.voice_stage_transcribing ?? "Transcribing…")
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
