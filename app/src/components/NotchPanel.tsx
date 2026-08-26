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
import { STRINGS } from "../lib/i18n";
import type { Strings } from "../lib/i18n";
import { formatTicker } from "../lib/time";
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
  | { kind: "peek" }
  | { kind: "dragging"; name: string; meta: string }
  | { kind: "accepted"; rel: string }
  | { kind: "running"; percent: number; detail: string; elapsedMs: number }
  | { kind: "done"; summary: string }
  | { kind: "capture"; text: string }
  | { kind: "recording"; elapsedMs: number; levels: number[] }
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
    case "peek":
      // S2 invites, it does not accept — nothing is read in this state.
      return {
        lip: t.notch_peek ?? "Drop it here",
        tone: "live",
        open: true,
        dwellMs: null,
      };
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
    case "recording":
      return {
        lip: (t.notch_recording ?? "Recording · {t}").replace(
          "{t}",
          clock(state.elapsedMs),
        ),
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
  { state: { kind: "done", summary: "3 pages updated · 1 created" }, pill: false },
  {
    state: { kind: "capture", text: "why we picked OTP over magic links" },
    pill: false,
  },
  {
    state: {
      kind: "recording",
      elapsedMs: 7000,
      levels: [30, 62, 88, 45, 72, 96, 38, 66, 52, 84, 28, 58],
    },
    pill: false,
  },
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
}

export default function NotchPanel({
  state,
  pill = false,
  collapsedWidth = null,
}: NotchPanelProps): JSX.Element {
  const lang = useUIStore((s) => s.lang);
  const t = STRINGS[lang];
  const [mock] = useState(readMockParams);
  const [step, setStep] = useState(0);

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
      <div className="notch-lip">
        <i aria-hidden className={`notch-cap notch-cap-${view.tone}`} />
        {/* No live region here: the lip TICKS ("Ingesting · 00:42"), so
            aria-live would re-announce every second, and the rows that matter
            (done at :367, rejected at :419) carry their own status/alert. */}
        {view.lip ? <span className="notch-lip-label">{view.lip}</span> : null}
      </div>
      {view.open ? (
        // Keyed by state so the 160ms fade replays on every transition.
        <div className="notch-body" key={frame.state.kind}>
          <NotchBody state={frame.state} t={t} />
        </div>
      ) : null}
    </div>
  );
}

function NotchBody({
  state,
  t,
}: {
  state: NotchState;
  t: Strings;
}): JSX.Element | null {
  switch (state.kind) {
    case "idle":
      return null;
    case "peek":
      return (
        <div className="notch-dz">
          {t.notch_peek_body ?? "Files · links · selected text"}
        </div>
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
            <span className="notch-mono">{t.notch_accepted_next ?? "next"}</span>
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
      // ponytail: display-only field — a webview cannot take key focus until
      // the native notch window exists to give it. Wire it to an <input> and a
      // save command in the same change that lands the Rust window.
      return (
        <>
          <div className="notch-field">
            {state.text}
            <i aria-hidden className="notch-caret" />
          </div>
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
    case "recording":
      return (
        <>
          <div className="notch-row">
            <span aria-hidden className="notch-wave">
              {state.levels.map((level, i) => (
                <i key={i} style={{ height: `${clampPercent(level)}%` }} />
              ))}
            </span>
          </div>
          <div className="notch-hint">
            <span className="notch-mono">
              {t.voice_hint_recording ?? "⏎ save · esc cancel"}
            </span>
          </div>
        </>
      );
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
