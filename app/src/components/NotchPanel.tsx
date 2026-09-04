// The menu-bar notch surface's entire UI (index.html?window=notch) — a THIRD
// secondary webview alongside the tray popover and the spotlight. None of
// App.tsx mounts here, so no scheduler (auto-ingest/reindex/reflect/import)
// double-runs in this JS context.
//
// Ten states from the 2026-08-25 design sheet: S1 idle, S2 proximity peek,
// S3 drag enter, S4 accepted, S5 run HUD, S6 done, S7 text capture, S8 voice
// capture, S9 unsupported reject, and S10 — the no-notch fallback, which is
// not a state of its own but the same panel with all four corners rounded
// (`safeAreaInsets.top == 0`), hence the `pill` prop rather than a tenth kind.
// The v2 voice pass split S8 into recording → saving (whisper meter) and
// added the 800 ms `cancelled` beat after esc.
//
// This file drives NOTHING and imports no Tauri command: it renders the `state`
// it is handed, and idles when handed none. Whoever owns the native window
// (drop handling, ingest progress, capture) feeds it — keeping the surface
// testable and viewable without a shell. In a plain browser
// `?window=notch&notchMock=1` cycles the ten frames (add `&notchFrame=N` to pin
// one for a deterministic screenshot).
//
// Palette is hardcoded dark in styles.css (.notch-*), like .tray-panel and
// .spotlight-card: app theme tokens resolve to LIGHT values in this webview —
// that is the white-cards-on-a-dark-panel bug the tray popover already hit.
// Every value below (colors, 260ms unfold, 160ms fade, 4s dwell) is the design
// sheet's, verbatim.

import { useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import LiveCaption from "./LiveCaption";
import VoiceWave from "./VoiceWave";
import { STRINGS } from "../lib/i18n";
import type { Strings } from "../lib/i18n";
import { isComposingKey } from "../lib/ime";
import type { CaptionState } from "../lib/liveCaption";
import { formatTicker } from "../lib/time";
import { voiceHotkeyGate } from "../lib/voiceCapture";
import { createLevelHistory } from "../lib/voiceLevel";
import type { LevelHistory } from "../lib/voiceLevel";
import { useUIStore } from "../stores/uiStore";

/** Cap colors, by the sheet's one color rule: purple = alive, amber = needs
 *  attention, green = finished, dim = nothing happening. Purple is never
 *  decoration — if it is lit, something is running. */
export type NotchTone = "dim" | "live" | "ok" | "warn";

/** What the surface is showing. Free-text members (`meta`, `rel`, `detail`,
 *  `summary`) arrive already translated, like TrayStatusPayload's labels —
 *  they are produced by whoever ran the work, not by this webview. */
export type NotchState =
  | { kind: "idle" }
  // `due` rides along when today has tasks: the notch is the surface the owner
  // passes over every day, and it was showing a generic hint into a vault with
  // dormant task counts. Absent = nothing due, and the hint stays.
  | { kind: "peek"; due?: { today: number; overdue: number } }
  | { kind: "dragging"; name: string; meta: string }
  | { kind: "accepted"; rel: string }
  | { kind: "running"; percent: number; detail: string; elapsedMs: number }
  | { kind: "done"; summary: string }
  | { kind: "capture"; text: string }
  // S7's success: the daily line landed at `rel`. Green like S6, and folds
  // itself away on the same 4s clock.
  | { kind: "captured"; rel: string }
  // `note` overrides the lip clock — the one-time whisper model download
  // narrates its percent there instead of freezing on the last second.
  // `caption` is the live transcript (partials every few seconds); `noInput`
  // flips after 2 s of a silent mic. The waveform itself is not state: the
  // driver hands the panel a level ring buffer, redrawn per frame.
  | {
      kind: "recording";
      elapsedMs: number;
      caption: CaptionState;
      noInput: boolean;
      note?: string;
    }
  // esc on a take: the mic is released, and the surface says so for 800 ms.
  | { kind: "cancelled" }
  // ⏎ on a take: whisper is transcribing, then the note is written. `pct` is
  // whisper's own progress (null before its first line).
  | {
      kind: "saving";
      elapsedMs: number;
      caption: CaptionState;
      stage: "transcribing" | "saving";
      pct: number | null;
      note?: string;
    }
  // `reason` (already translated, like every free-text member) overrides the
  // {ext}-templated line — a write failure has a reason but no extension.
  | { kind: "rejected"; ext: string; reason?: string };

export interface NotchView {
  /** Lip label. Empty renders the bare cap (S1) — an idle notch has to look
   *  like it was always empty. */
  lip: string;
  tone: NotchTone;
  /** Unfolded to the 300px body, vs collapsed to the lip alone. */
  open: boolean;
  /** How long the state holds before the surface folds itself away; null =
   *  holds until something replaces it. Only S6 self-collapses. */
  dwellMs: number | null;
}

/** S6 folds away on its own — the sheet's rule is that a finished surface
 *  never asks to be dismissed. */
export const DONE_DWELL_MS = 4000;
/** A cancelled take says so, briefly, then folds. */
export const CANCELLED_DWELL_MS = 800;

/** mm:ss, zero-padded. formatTicker gives "0:42"; the sheet's DATA MONO rule
 *  is tabular, and an unpadded minute shifts the whole lip when it rolls over
 *  to "10:42". */
export function clock(ms: number): string {
  return formatTicker(ms).padStart(5, "0");
}

/** Percent for a meter/bar width. Clamps to 0–100 and rejects NaN, which would
 *  otherwise reach CSS as `width: NaN%` and silently drop the rule. Infinity is
 *  NOT lumped in with NaN: an overflowing meter means "past full", so it clamps
 *  to 100 — reading it as 0 would show a stalled bar for a finished job. */
export function clampPercent(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.round(Math.min(100, Math.max(0, value)));
}

/**
 * State → what the lip says and how it is tinted. Pure, so the ten states are
 * unit-testable without a DOM (this repo's vitest is node-only).
 */
export function describeNotch(
  state: NotchState,
  t: Strings,
  pill = false,
): NotchView {
  switch (state.kind) {
    case "idle":
      // S10: with no notch to hide inside, the pill has to say whose it is.
      return pill
        ? {
            lip: t.app_name.toUpperCase(),
            tone: "live",
            open: false,
            dwellMs: null,
          }
        : { lip: "", tone: "dim", open: false, dwellMs: null };
    case "peek": {
      // S2 invites, it does not accept — nothing is read in this state.
      // With work due, the lip reports it instead of repeating the invitation.
      const due = state.due;
      const lip =
        due && due.today + due.overdue > 0
          ? [
              (t.tray_card_tasks_v ?? "{n} today").replace("{n}", String(due.today)),
              due.overdue > 0
                ? (t.tray_card_tasks_sub ?? "{n} overdue").replace(
                    "{n}",
                    String(due.overdue),
                  )
                : "",
            ]
              .filter(Boolean)
              .join(" · ")
          : (t.notch_peek ?? "Drop it here");
      return {
        lip,
        tone: due && due.overdue > 0 ? "warn" : "live",
        open: true,
        dwellMs: null,
      };
    }
    case "dragging":
      return {
        lip: t.notch_drop ?? "Release to drop",
        tone: "live",
        open: true,
        dwellMs: null,
      };
    case "accepted":
      return {
        lip: t.notch_accepted ?? "Got it",
        tone: "live",
        open: true,
        dwellMs: null,
      };
    case "running":
      return {
        lip: (t.notch_running ?? "Ingesting · {t}").replace(
          "{t}",
          clock(state.elapsedMs),
        ),
        tone: "live",
        open: true,
        dwellMs: null,
      };
    case "done":
      return {
        lip: t.notch_done ?? "Done",
        tone: "ok",
        open: true,
        dwellMs: DONE_DWELL_MS,
      };
    case "capture":
      return {
        lip: t.notch_capture ?? "Quick note",
        tone: "live",
        open: true,
        dwellMs: null,
      };
    case "captured":
      return {
        lip: t.notch_capture_saved ?? "Saved",
        tone: "ok",
        open: true,
        dwellMs: DONE_DWELL_MS,
      };
    case "recording":
      return {
        lip:
          state.note ??
          (state.noInput
            ? (t.notch_no_sound ?? "No sound")
            : (t.notch_recording ?? "Recording · {t}").replace(
                "{t}",
                clock(state.elapsedMs),
              )),
        tone: "live",
        open: true,
        dwellMs: null,
      };
    case "cancelled":
      return {
        lip: t.notch_cancelled ?? "Cancelled",
        tone: "warn",
        open: true,
        dwellMs: CANCELLED_DWELL_MS,
      };
    case "saving":
      // The lip names the STAGE, not the take: reusing notch_recording put a
      // ticking "Recording · 00:07" beside a body saying "Transcribing… 40%",
      // which reads as a mic still running. The frozen clock stays in the
      // body row, where it belongs.
      return {
        lip:
          state.note ??
          (state.stage === "saving"
            ? (t.voice_stage_saving ?? "Saving note…")
            : (t.voice_stage_transcribing ?? "Transcribing…")),
        tone: "live",
        open: true,
        dwellMs: null,
      };
    case "rejected":
      // Amber is for attention only, and a refusal is never silent.
      return {
        lip: t.notch_rejected ?? "Could not take it",
        tone: "warn",
        open: true,
        dwellMs: null,
      };
  }
}

/** One mock step; `pill` is per-frame so S10 can follow S1..S9 in the cycle. */
export interface NotchFrame {
  state: NotchState;
  pill: boolean;
}

/** Dev-only sample walk, S1 → S10, with the sheet's own numbers. */
export const MOCK_FRAMES: readonly NotchFrame[] = [
  { state: { kind: "idle" }, pill: false },
  { state: { kind: "peek" }, pill: false },
  {
    state: { kind: "dragging", name: "attention.pdf", meta: "PDF · 2.4 MB" },
    pill: false,
  },
  { state: { kind: "accepted", rel: "attention.pdf" }, pill: false },
  {
    state: {
      kind: "running",
      percent: 72,
      detail: "attention-mechanism · self-attention",
      elapsedMs: 42_000,
    },
    pill: false,
  },
  {
    state: { kind: "done", summary: "3 pages updated · 1 created" },
    pill: false,
  },
  {
    state: { kind: "capture", text: "why we picked OTP over magic links" },
    pill: false,
  },
  { state: { kind: "captured", rel: "daily/2026-08-25.md" }, pill: false },
  {
    state: {
      kind: "recording",
      elapsedMs: 7000,
      caption: { confirmed: ["오늘", "회의에서", "정리한"], interim: ["내용을"] },
      noInput: false,
    },
    pill: false,
  },
  {
    state: {
      kind: "saving",
      elapsedMs: 7000,
      caption: { confirmed: ["오늘", "회의에서", "정리한", "내용을"], interim: [] },
      stage: "transcribing",
      pct: 40,
    },
    pill: false,
  },
  { state: { kind: "cancelled" }, pill: false },
  { state: { kind: "rejected", ext: ".epub" }, pill: false },
  { state: { kind: "idle" }, pill: true },
];

/** Dwell for frames that do not self-collapse — long enough to read, short
 *  enough that the whole walk plays in under half a minute. */
const MOCK_STEP_MS = 2600;

const IDLE_STATE: NotchState = { kind: "idle" };

interface MockParams {
  on: boolean;
  /** Pinned frame index, or null to cycle. */
  pinned: number | null;
}

/** Read at first render, never at module scope: the node-only unit test
 *  imports this file and there is no `location` there. */
function readMockParams(): MockParams {
  if (!import.meta.env.DEV) return { on: false, pinned: null };
  const params = new URLSearchParams(location.search);
  if (!params.has("notchMock")) return { on: false, pinned: null };
  const raw = params.get("notchFrame");
  const n = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  return {
    on: true,
    pinned: Number.isInteger(n) && n >= 0 ? n % MOCK_FRAMES.length : null,
  };
}

export interface NotchPanelProps {
  /** Omitted → idle, or the mock cycle under `?notchMock=1`. The native notch
   *  will drive this once it exists; nothing in this file reaches for Tauri. */
  state?: NotchState;
  /** S10: no notch on this Mac (`safeAreaInsets.top == 0`). Same panel, all
   *  four corners rounded, floating just under the menu bar. */
  pill?: boolean;
  /** OS-measured notch width (points) for the collapsed cap — overrides the
   *  stylesheet's 172px default (`--notch-collapsed`). */
  collapsedWidth?: number | null;
  /** S7 wiring, driver-owned like everything else here: ⏎ hands the trimmed
   *  text up, esc hands the dismissal up, ⌥M asks for the S8 voice take.
   *  All optional — the mock walk and plain-browser view stay handler-free. */
  onCaptureSubmit?: (text: string) => void;
  onCaptureCancel?: () => void;
  onCaptureVoice?: () => void;
  /** Peek "note" row: open the text capture (the lip click does the same). */
  onCaptureOpen?: () => void;
  /** S8 ⏎ / the save button: stop the take and transcribe it. */
  onRecordStop?: () => void;
  /** S7 paste: true = the driver took it (a URL/large selection became an
   *  _inbox note) and the input must not receive the text. */
  onCapturePaste?: (text: string) => boolean;
  /** Mic RMS history for the recording waveform; the driver owns and fills
   *  it. Omitted (mock walk, plain browser) → a flat line. */
  levels?: LevelHistory;
}

export default function NotchPanel({
  state,
  pill = false,
  collapsedWidth = null,
  onCaptureSubmit,
  onCaptureCancel,
  onCaptureVoice,
  onCaptureOpen,
  onRecordStop,
  onCapturePaste,
  levels,
}: NotchPanelProps): JSX.Element {
  const lang = useUIStore((s) => s.lang);
  const t = STRINGS[lang];
  const [mock] = useState(readMockParams);
  const [step, setStep] = useState(0);
  const [flat] = useState(createLevelHistory);

  const mocking = state === undefined && mock.on;
  const frame: NotchFrame =
    state !== undefined
      ? { state, pill }
      : mocking
        ? MOCK_FRAMES[mock.pinned ?? step % MOCK_FRAMES.length]
        : { state: IDLE_STATE, pill };
  const view = describeNotch(frame.state, t, frame.pill);

  useEffect(() => {
    // The window itself is transparent; only the black panel paints.
    document.documentElement.classList.add("notch-window");
  }, []);

  // Mock walk. Each frame holds for its own dwell, so S6 really does linger
  // the 4 seconds it promises in its hint.
  useEffect(() => {
    if (!mocking || mock.pinned !== null) return;
    const id = window.setTimeout(
      () => setStep((i) => i + 1),
      view.dwellMs ?? MOCK_STEP_MS,
    );
    return () => window.clearTimeout(id);
  }, [mocking, mock.pinned, step, view.dwellMs]);

  return (
    <div
      className={`notch${view.open ? " notch-open" : ""}${frame.pill ? " notch-pill" : ""}`}
      data-state={frame.state.kind}
      style={
        collapsedWidth
          ? ({ "--notch-collapsed": `${collapsedWidth}px` } as CSSProperties)
          : undefined
      }
    >
      {view.open ? (
        <div className="notch-lip">
          <i aria-hidden className={`notch-cap notch-cap-${view.tone}`} />
          {/* No live region here: the lip TICKS ("Ingesting · 00:42"), so
              aria-live would re-announce every second, and the rows that
              matter (done/rejected) carry their own status/alert. */}
          {view.lip ? (
            <span className="notch-lip-label">{view.lip}</span>
          ) : null}
        </div>
      ) : // Collapsed v2: NOTHING is drawn (owner call from the second headed
      // run — any always-visible attachment reads as a foreign widget). The
      // window is a transparent hit area; the hardware notch itself is the
      // surface, and it GROWS on hover.
      null}
      {/* OUTSIDE the keyed body on purpose: `.notch-body` remounts on every
          state change, so a live region declared inside it is created in the
          same commit as its first text and the opening "Transcribing…" is
          never announced. This one survives recording → saving. */}
      <div className="notch-live" role="status">
        {frame.state.kind === "saving" ? stageLabel(frame.state, t) : ""}
      </div>
      {view.open ? (
        // Keyed by state so the 160ms fade replays on every transition.
        <div className="notch-body" key={frame.state.kind}>
          <NotchBody
            state={frame.state}
            t={t}
            onCaptureSubmit={onCaptureSubmit}
            onCaptureCancel={onCaptureCancel}
            onCaptureVoice={onCaptureVoice}
            onCaptureOpen={onCaptureOpen}
            onRecordStop={onRecordStop}
            onCapturePaste={onCapturePaste}
            levels={levels ?? flat}
          />
        </div>
      ) : null}
    </div>
  );
}

/** What the save half is doing right now. Shared by the visible row and the
 *  live region that announces it — one string, two places. */
function stageLabel(
  state: Extract<NotchState, { kind: "saving" }>,
  t: Strings,
): string {
  if (state.stage === "saving") return t.voice_stage_saving ?? "Saving note…";
  return state.pct !== null
    ? (t.voice_transcribe_progress ?? "Transcribing… {pct}%").replace(
        "{pct}",
        String(clampPercent(state.pct)),
      )
    : (t.voice_stage_transcribing ?? "Transcribing…");
}

function NotchBody({
  state,
  t,
  onCaptureSubmit,
  onCaptureCancel,
  onCaptureVoice,
  onCaptureOpen,
  onRecordStop,
  onCapturePaste,
  levels,
}: {
  state: NotchState;
  t: Strings;
  onCaptureSubmit?: (text: string) => void;
  onCaptureCancel?: () => void;
  onCaptureVoice?: () => void;
  onCaptureOpen?: () => void;
  onRecordStop?: () => void;
  onCapturePaste?: (text: string) => boolean;
  levels: LevelHistory;
}): JSX.Element | null {
  switch (state.kind) {
    case "idle":
      return null;
    case "peek":
      // Two one-click actions (record starts the mic directly — no detour
      // through the text capture), then what a drop accepts. stopPropagation:
      // the driver's window-level click is the lip's "open capture", and a
      // button press must not fire it as well.
      return (
        <>
          <button
            type="button"
            className="notch-act"
            onClick={(e) => {
              e.stopPropagation();
              onCaptureVoice?.();
            }}
          >
            <i aria-hidden className="notch-dot" />
            <span className="notch-grow">{t.notch_rec ?? "Record"}</span>
            <span className="notch-mono">⌥M</span>
          </button>
          <button
            type="button"
            className="notch-act"
            onClick={(e) => {
              e.stopPropagation();
              onCaptureOpen?.();
            }}
          >
            <span aria-hidden className="notch-act-glyph">✎</span>
            <span className="notch-grow">{t.notch_note ?? "Note"}</span>
            <span className="notch-mono">⏎</span>
          </button>
          <div className="notch-peek-sub">
            {t.notch_peek_body ?? "Files · links · selected text"}
          </div>
        </>
      );
    case "dragging":
      // Reading back the name is the confirmation that it CAN be taken.
      return (
        <div className="notch-dz notch-dz-hot">
          <b>{state.name}</b>
          <span className="notch-path">{state.meta}</span>
        </div>
      );
    case "accepted":
      // Where it landed comes first — the sheet's P95 < 1.5s target is on
      // reaching exactly this line.
      return (
        <>
          <div className="notch-row">
            <span className="notch-mono">_inbox/</span>
            <span className="notch-grow notch-path">{state.rel}</span>
          </div>
          <div className="notch-row">
            <span className="notch-mono">
              {t.notch_accepted_next ?? "next"}
            </span>
            <span className="notch-grow">
              {t.notch_accepted_next_sub ?? "ingest reads it shortly"}
            </span>
          </div>
        </>
      );
    case "running": {
      const pct = clampPercent(state.percent);
      return (
        <>
          <div className="notch-row">
            <span className="notch-mono">
              {t.notch_running_read ?? "reading"}
            </span>
            <span className="notch-meter">
              <i style={{ width: `${pct}%` }} />
            </span>
            <span className="notch-mono">{pct}%</span>
          </div>
          <div className="notch-row">
            <span className="notch-mono">
              {t.notch_running_pages ?? "pages"}
            </span>
            <span className="notch-grow notch-path">{state.detail}</span>
          </div>
        </>
      );
    }
    case "done":
      return (
        <>
          <div className="notch-row notch-ok" role="status">
            <span className="notch-grow">{state.summary}</span>
          </div>
          <div className="notch-hint">
            <span className="notch-mono">{t.notch_done_open ?? "⏎ open"}</span>
            <span className="notch-mono">
              {t.notch_done_collapse ?? "closes in 4s"}
            </span>
          </div>
        </>
      );
    case "capture":
      // A real input: the native side grants key focus on capture entry
      // (notch_focus_capture). Uncontrolled on purpose — the driver only
      // needs the text at submit time, not a keystroke-by-keystroke state.
      return (
        <>
          <input
            className="notch-field"
            autoFocus
            defaultValue={state.text}
            aria-label={t.notch_capture ?? "Quick note"}
            onPaste={(e) => {
              // A lone URL / oversized selection is reference material, not a
              // daily line — the driver files it into _inbox and says where.
              const text = e.clipboardData.getData("text/plain");
              if (text && onCapturePaste?.(text)) e.preventDefault();
            }}
            onKeyDown={(e) => {
              // The IME guard first: committing Korean/Japanese input fires
              // Enter too, and that one must never submit (lib/ime.ts).
              if (isComposingKey(e)) return;
              if (e.altKey && e.code === "KeyM") {
                e.preventDefault();
                // Fallback for a REFUSED global registration: normally the OS
                // hotkey swallows this key. The gate makes a double delivery
                // a no-op instead of a start-then-stop.
                if (voiceHotkeyGate()) onCaptureVoice?.();
              } else if (e.key === "Enter") {
                e.preventDefault();
                const text = e.currentTarget.value.trim();
                if (text) onCaptureSubmit?.(text);
              } else if (e.key === "Escape") {
                e.preventDefault();
                onCaptureCancel?.();
              }
            }}
          />
          <div className="notch-hint">
            <span className="notch-mono">
              {t.notch_capture_save ?? "⏎ daily note"}
            </span>
            <span className="notch-mono notch-hint-end">
              {t.notch_capture_voice ?? "⌥M voice"}
            </span>
          </div>
        </>
      );
    case "captured":
      // Where it landed is the whole message — same green row shape as S6.
      return (
        <div className="notch-row notch-ok" role="status">
          <span className="notch-grow notch-path">{state.rel}</span>
        </div>
      );
    case "recording":
      return (
        <>
          <VoiceWave history={levels} />
          <LiveCaption
            caption={state.caption}
            noInputText={
              // The short line: the caption box is ~226px, and the spotlight's
              // full sentence overflows it here.
              state.noInput ? (t.notch_no_sound ?? "No sound") : null
            }
          />
          <div className="notch-hint">
            <button type="button" className="notch-key" onClick={onCaptureCancel}>
              {t.notch_hint_cancel ?? "esc cancel"}
            </button>
            <button
              type="button"
              className="notch-key notch-key-bright notch-hint-end"
              onClick={onRecordStop}
            >
              {t.notch_hint_save ?? "⏎ save"}
            </button>
          </div>
        </>
      );
    case "cancelled":
      // The lip says it all; nothing to read in the body.
      return null;
    case "saving": {
      // The caption settles (everything confirmed) while whisper reads the
      // whole take; the meter is whisper's -pp, the row names the stage.
      const label = stageLabel(state, t);
      return (
        <>
          <LiveCaption caption={state.caption} />
          <div className="notch-row">
            <span className="notch-meter">
              <i
                style={{
                  width: `${state.stage === "saving" ? 100 : clampPercent(state.pct ?? 0)}%`,
                }}
              />
            </span>
            {/* No role here — the announcement comes from the live region
                NotchPanel keeps outside its keyed body (see below). */}
            <span className="notch-mono">{label}</span>
          </div>
        </>
      );
    }
    case "rejected":
      // What failed AND what would work, on the same screen.
      return (
        <>
          <div className="notch-row notch-warn" role="alert">
            <span className="notch-grow">
              {state.reason ??
                (
                  t.notch_rejected_body ??
                  "This format is not readable yet ({ext})"
                ).replace("{ext}", state.ext)}
            </span>
          </div>
          <div className="notch-row">
            <span className="notch-mono">
              {t.notch_rejected_accepts ?? "accepts"}
            </span>
            <span className="notch-grow">
              {t.notch_rejected_list ??
                "PDF · documents · sheets · HTML · images · audio"}
            </span>
          </div>
        </>
      );
  }
}
