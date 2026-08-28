// Drives NotchPanel in the notch webview (`?window=notch`): the panel renders
// whatever `NotchState` it is handed, and this file is the "whoever owns the
// native window" its header defers to. Split like NotchPanel itself: a pure
// reducer (`reduceNotch`) that turns events + time into the next state — the
// only part with rules worth testing — and a thin hook that feeds it from the
// real sources (Tauri drag-drop, the myco://tray-status push, timers) and
// mirrors open/collapsed into the OS window size.
//
// Drops arrive as absolute file paths only — Tauri's DragDrop event carries
// nothing else — so the url/text arms of notchDrop never fire here.
//
// S7/S8 quick capture also lives here: a lip click (mouse events reach a
// non-activating panel — P0 measured it) opens the capture input and asks the
// native side for key focus (notch_focus_capture); ⏎ appends to today's daily
// note via capture_note, ⌥M hands the take to lib/voiceCapture's machine and
// save_voice_capture — the same recorder the spotlight uses, mic release
// included.

import { useEffect, useReducer, useRef, useState } from "react";
import {
  DONE_DWELL_MS,
  clampPercent,
  describeNotch,
} from "../components/NotchPanel";
import type { NotchState } from "../components/NotchPanel";
import { TRAY_STATUS_EVENT } from "../components/TrayPanel";
import { ipc } from "./ipc";
import { LAST_VAULT_KEY } from "../stores/vaultStore";
import type { NotchGeometry, TrayStatusPayload } from "./ipc";
import { STRINGS } from "./i18n";
import { classifyDrop, writeDrop } from "./notchDrop";
import type { DropPayload } from "./notchDrop";
import { today } from "./taskLine";
import { createVoiceMachine } from "./voiceCapture";
import type { VoiceMachine, VoiceState } from "./voiceCapture";
import { useUIStore } from "../stores/uiStore";

/** `.notch.notch-open` is 300px in styles.css; the window must match. */
// Widest open card is capture (collapsed + 20) plus a 12px transparent slop
// per side; 300 left ~40px of invisible hover surface hanging off each edge,
// which read as the panel flapping open over nothing (worst on the left).
export const NOTCH_OPEN_WIDTH = 252;
// Tallest open card (capture ~139) plus slop. The OS window opens straight to
// this fixed size so the card never has to wait on a second resize; the
// unused remainder is transparent.
export const NOTCH_OPEN_MAX_H = 170;

/** How long S4/S9 hold before folding away. The sheet says only S6
 *  self-collapses, but this panel is non-activating — there is no click or key
 *  to dismiss it — so a surface that never gets replaced must fold itself.
 *  Accepted holds longer: "ingest reads it shortly" is worth reading. */
export const ACCEPTED_DWELL_MS = 8000;
export const REJECTED_DWELL_MS = 6000;

/** What the driver reacts to. `writeOk`/`writeFail` report the async
 *  `_inbox/` write that follows a drop; `statusPush` is the first running row
 *  of a tray-status push (null = nothing running); `tick` re-times the S5
 *  clock; `idleTimeout` is the dwell timer firing. The capture/rec family is
 *  S7/S8: open/submit/save/cancel for the text input, start/tick/stop/saved
 *  for the voice take (`captureCancel` also folds a cancelled recording —
 *  both gestures are the same esc). `reason` members arrive translated, like
 *  every free-text member of NotchState. */
export type NotchEvent =
  | { type: "dragEnter"; paths: string[] }
  | { type: "dragOver" }
  | { type: "dragLeave" }
  | {
      type: "drop";
      paths: string[];
      /** A pasted link/selection — no file behind it. Wins over `paths`. */
      payload?: DropPayload;
      unsupportedTemplate?: string;
    }
  | { type: "writeOk"; summary: string }
  | { type: "writeFail"; reason: string }
  | { type: "statusPush"; running: string | null }
  | { type: "tick" }
  | { type: "idleTimeout" }
  | { type: "hoverEnter" }
  | { type: "hoverLeave" }
  | { type: "captureOpen" }
  | { type: "captureSubmit" }
  | { type: "captureSaved"; rel: string }
  | { type: "captureFail"; reason: string }
  | { type: "captureCancel" }
  | { type: "recStart" }
  | { type: "recTick" }
  | { type: "recStop" }
  | { type: "recNote"; note: string }
  | { type: "recSaved"; rel: string }
  | { type: "recFail"; reason: string };

export interface NotchDriverState {
  panel: NotchState;
  /** Epoch ms when the current timed span — S5 `running` or S8 `recording` —
   *  began; null elsewhere. Kept beside the panel because an `elapsedMs`
   *  cannot be re-derived from itself when the next push or tick arrives. */
  runningSince: number | null;
}

export const NOTCH_IDLE: NotchDriverState = {
  panel: { kind: "idle" },
  runningSince: null,
};

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? "";
}

/** S3 lines for a drag: first file's name, plus a language-neutral meta
 *  ("PDF · +2"). No file size — the drag event carries paths only, and a
 *  stat round-trip mid-drag is not worth the line. */
export function dragLabel(paths: string[]): { name: string; meta: string } {
  const name = basename(paths[0] ?? "");
  const ext = /\.([^.]+)$/.exec(name)?.[1]?.toUpperCase() ?? "";
  const more = paths.length > 1 ? `+${paths.length - 1}` : "";
  return { name, meta: [ext, more].filter(Boolean).join(" · ") };
}

/** `first-name` or `first-name +N` — the S4 row for a (possibly multi-file)
 *  drop. Language-neutral on purpose: the row is a filename, not a sentence. */
export function batchLabel(first: string, count: number): string {
  return count > 1 ? `${first} +${count - 1}` : first;
}

/** What S9 shows in parentheses: the extension with its dot, or — for a
 *  folder / bare `README` — the name itself (classifyDrop's own rule). */
export function extLabel(title: string): string {
  const ext = /\.([^.]+)$/.exec(title)?.[1]?.toLowerCase();
  return ext ? `.${ext}` : title;
}

/** Best-effort percent out of a pre-translated running row ("재색인 218/302",
 *  "72%"). The tray payload carries no numbers of its own, so a row with
 *  neither pattern honestly reads 0 — a bar at rest, not a fake crawl. */
export function runningPercent(text: string): number {
  const pct = /(\d{1,3})\s*%/.exec(text);
  if (pct) return clampPercent(Number(pct[1]));
  const frac = /(\d+)\s*\/\s*(\d+)/.exec(text);
  if (frac && Number(frac[2]) > 0) {
    return clampPercent((Number(frac[1]) / Number(frac[2])) * 100);
  }
  return 0;
}

/** How long a state holds before the driver folds it away; null = holds until
 *  something replaces it (dragging, running — states with a live owner). */
export function dwellMsFor(panel: NotchState): number | null {
  switch (panel.kind) {
    case "done":
    case "captured":
      return DONE_DWELL_MS;
    case "accepted":
      return ACCEPTED_DWELL_MS;
    case "rejected":
      return REJECTED_DWELL_MS;
    default:
      return null;
  }
}

/** S8's waveform, display-only by design: twelve deterministic bars walked
 *  from the elapsed seconds — alive on every tick without a mic analyser. */
export function waveLevels(elapsedMs: number): number[] {
  const step = Math.floor(elapsedMs / 1000);
  return Array.from({ length: 12 }, (_, i) => 25 + ((step * 7 + i * 13) % 66));
}

/**
 * The S1→S10 walk as a reducer: idle →(dragEnter)→ dragging →(drop)→ accepted
 * →(statusPush running)→ running →(statusPush null)→ done →(4s)→ idle, with an
 * all-unsupported drop landing on rejected instead. Pure — `now` is injected —
 * and no-op transitions return `current` by reference so the hook's timers are
 * not restarted by pushes that changed nothing.
 */
export function reduceNotch(
  current: NotchDriverState,
  event: NotchEvent,
  now: number,
): NotchDriverState {
  const panel = current.panel;
  switch (event.type) {
    case "dragEnter": {
      // A drag is the user, present right now — it outranks passive states.
      // NOT capture or recording: those hold live user state (typed text, a
      // hot microphone), and the review's worst finding was a drag flipping
      // the panel away mid-recording with no UI left to stop the mic.
      if (panel.kind === "capture" || panel.kind === "recording")
        return current;
      const { name, meta } = dragLabel(event.paths);
      return { panel: { kind: "dragging", name, meta }, runningSince: null };
    }
    case "dragOver":
      return current;
    case "dragLeave":
      return panel.kind === "dragging" ? NOTCH_IDLE : current;
    case "drop": {
      const verdicts = classifyDrop(
        event.payload ?? { type: "files", paths: event.paths },
        event.unsupportedTemplate,
      );
      if (verdicts.length === 0) return NOTCH_IDLE;
      const accepted = verdicts.filter((v) => v.kind !== "unsupported");
      if (accepted.length === 0) {
        const first = verdicts[0];
        return {
          panel: {
            kind: "rejected",
            ext: extLabel(first.title),
            reason: first.reason,
          },
          runningSince: null,
        };
      }
      // Mixed drops show the accepted side; the readable files did land.
      return {
        panel: {
          kind: "accepted",
          rel: batchLabel(accepted[0].title, accepted.length),
        },
        runningSince: null,
      };
    }
    case "writeOk":
      // Refine the predicted name with what actually landed ("-2" suffixing
      // happens at write time) — unless the surface has already moved on.
      return panel.kind === "accepted"
        ? {
            panel: { kind: "accepted", rel: event.summary },
            runningSince: null,
          }
        : current;
    case "writeFail":
      return panel.kind === "accepted"
        ? {
            panel: { kind: "rejected", ext: "", reason: event.reason },
            runningSince: null,
          }
        : current;
    case "statusPush": {
      if (event.running !== null) {
        // A background run never interrupts the user mid-gesture (S3/S7/S8)
        // or talks over a refusal before it has been read.
        if (
          panel.kind === "dragging" ||
          panel.kind === "capture" ||
          panel.kind === "recording" ||
          panel.kind === "rejected"
        ) {
          return current;
        }
        const since =
          panel.kind === "running" ? (current.runningSince ?? now) : now;
        return {
          panel: {
            kind: "running",
            percent: runningPercent(event.running),
            detail: event.running,
            elapsedMs: Math.max(0, now - since),
          },
          runningSince: since,
        };
      }
      // The run this surface was narrating ended; its last line is the S6
      // summary (the tray payload has no richer outcome to offer).
      return panel.kind === "running"
        ? { panel: { kind: "done", summary: panel.detail }, runningSince: null }
        : current;
    }
    case "tick":
      return panel.kind === "running" && current.runningSince !== null
        ? {
            panel: {
              ...panel,
              elapsedMs: Math.max(0, now - current.runningSince),
            },
            runningSince: current.runningSince,
          }
        : current;
    case "idleTimeout":
      // Guard on dwellMsFor so a stale timer cannot kill a state that has a
      // live owner (a drag that started after the timer was armed).
      return dwellMsFor(panel) !== null ? NOTCH_IDLE : current;
    case "hoverEnter":
      // Pointer over the collapsed tab unfolds the peek hint — the owner's
      // headed-run call: hover discovery instead of hunting for a dot.
      return panel.kind === "idle"
        ? { panel: { kind: "peek" }, runningSince: null }
        : current;
    case "hoverLeave":
      return panel.kind === "peek"
        ? { panel: { kind: "idle" }, runningSince: null }
        : current;
    case "captureOpen":
      // From idle or the hover peek — a click during any other state is
      // aimed at what that state is showing, not at capture.
      return panel.kind === "idle" || panel.kind === "peek"
        ? { panel: { kind: "capture", text: "" }, runningSince: null }
        : current;
    case "captureSubmit":
      // Optimistic, like drop→accepted: the predicted landing is shown at
      // once (no saving spinner on a lip), and captureSaved/captureFail
      // refine or refute it when capture_note answers.
      return panel.kind === "capture"
        ? {
            panel: {
              kind: "captured",
              rel: `daily/${today(new Date(now))}.md`,
            },
            runningSince: null,
          }
        : current;
    case "captureSaved":
      return panel.kind === "captured"
        ? { panel: { kind: "captured", rel: event.rel }, runningSince: null }
        : current;
    case "captureFail":
      // From "captured" (the optimistic toast) — but also from idle: a save
      // slower than the 4s dwell would otherwise fail into the void after the
      // toast already collapsed, leaving the user believing it landed.
      return panel.kind === "captured" || panel.kind === "idle"
        ? {
            panel: { kind: "rejected", ext: "", reason: event.reason },
            runningSince: null,
          }
        : current;
    case "captureCancel":
      // esc in the input, or a cancelled recording (the machine's mic release
      // already happened — this only folds the surface).
      return panel.kind === "capture" || panel.kind === "recording"
        ? NOTCH_IDLE
        : current;
    case "recStart":
      // Unguarded on purpose: this event means the mic IS live (the machine
      // said so), and a live mic must be shown wherever the panel was.
      return {
        panel: { kind: "recording", elapsedMs: 0, levels: waveLevels(0) },
        runningSince: now,
      };
    case "recTick": {
      if (panel.kind !== "recording" || current.runningSince === null) {
        return current;
      }
      const elapsedMs = Math.max(0, now - current.runningSince);
      return {
        panel: { kind: "recording", elapsedMs, levels: waveLevels(elapsedMs) },
        runningSince: current.runningSince,
      };
    }
    case "recStop":
      // Stop → whisper save is in flight; the last recording frame holds (the
      // hook stops the ticker) until recSaved/recFail replaces it.
      return current;
    case "recNote":
      // The one-time model download narrating its percent on the lip. Only a
      // live recording surface has anywhere to show it.
      return panel.kind === "recording"
        ? { panel: { ...panel, note: event.note }, runningSince: current.runningSince }
        : current;
    case "recSaved":
      // The voice note landed in _inbox/ — exactly what S4 announces.
      return panel.kind === "recording"
        ? { panel: { kind: "accepted", rel: event.rel }, runningSince: null }
        : current;
    case "recFail":
      // Covers both the whisper preflight (still in capture) and a failed
      // save (recording) — either way the refusal must name its reason.
      return panel.kind === "capture" || panel.kind === "recording"
        ? {
            panel: { kind: "rejected", ext: "", reason: event.reason },
            runningSince: null,
          }
        : current;
  }
}

/** Sit a files drop in `_inbox/` and name what landed (`writeOk` summary),
 *  or resolve null when nothing was writable (the reducer already showed the
 *  rejection at drop time). */
async function persistDrop(
  payload: DropPayload,
  unsupportedTemplate?: string,
): Promise<string | null> {
  const outcome = await writeDrop(
    // writeDrop only uses vaultPath to build the dest our copyFile wrapper
    // strips back to a basename — copy_into_inbox confines to the active
    // vault's _inbox/ on the Rust side, so this webview never needs the path.
    "",
    payload,
    {
      inboxNames: async () => {
        // Best-effort collision list: list_inbox_entries needs the vault path,
        // which only the main window truly knows — its last-opened value is
        // shared via localStorage (vaultStore's LAST_VAULT_KEY). Without it
        // the write still lands confined; only client-side "-2" suffixing is
        // lost to whatever copy_into_inbox does with a taken name.
        const vault = localStorage.getItem(LAST_VAULT_KEY);
        if (!vault) return [];
        try {
          return (await ipc.listInboxEntries(vault)).map((e) => e.name);
        } catch {
          return [];
        }
      },
      copyFile: (from, to) => ipc.copyIntoInbox(from, basename(to)),
      // A pasted link/selection: the composed note goes through the
      // vault-confined sibling of copy_into_inbox.
      writeFile: (to, content) => ipc.writeInboxNote(basename(to), content),
      unsupportedTemplate,
    },
  );
  if (outcome.written.length === 0) return null;
  return batchLabel(basename(outcome.written[0]), outcome.written.length);
}

export interface NotchDrive {
  state: NotchState;
  /** S10: no notch on this display — same panel, floating pill. */
  pill: boolean;
  /** OS-measured notch width for `--notch-collapsed`; null until known. */
  collapsedWidth: number | null;
  /** S7 ⏎: append to today's daily note; the panel hands up trimmed text. */
  onCaptureSubmit: (text: string) => void;
  /** S7/S8 esc: fold the capture away (and release the mic mid-take). */
  onCaptureCancel: () => void;
  /** S7 ⌥M: whisper preflight, then the S8 voice take. */
  onCaptureVoice: () => void;
  /** S7 paste: a lone URL or an oversized selection is a SOURCE, not a
   *  daily-note line — it lands in `_inbox/` as a note instead of the input.
   *  Returns true when intercepted (the panel preventDefaults). */
  onCapturePaste: (text: string) => boolean;
}

/**
 * The notch window's driver. Returns null under `?notchMock=1` (the panel's
 * own dev walk owns the frames there); everywhere else it returns the live
 * state — which in a plain browser without Tauri simply stays idle, exactly
 * what the surface showed before it had a driver.
 */
/** How much of the collapsed surface peeks BELOW the hardware notch. Without
 * it the idle window sits exactly behind the cutout and is invisible — the
 * first live test's actual finding: nothing to aim a drop at. The mascot cap
 * renders inside this strip. */
export const NOTCH_PEEK_PX = 14;

export function useNotchDriver(): NotchDrive | null {
  // Read once at first render, like NotchPanel's readMockParams.
  const [mocking] = useState(
    () =>
      import.meta.env.DEV &&
      new URLSearchParams(location.search).has("notchMock"),
  );
  const lang = useUIStore((s) => s.lang);
  const t = STRINGS[lang];
  const [drv, raise] = useReducer(
    (s: NotchDriverState, e: NotchEvent) => reduceNotch(s, e, Date.now()),
    NOTCH_IDLE,
  );
  const [geom, setGeom] = useState<NotchGeometry | null>(null);

  // The drag-drop subscription is mount-once; the localized template rides a
  // ref so a language change does not tear the listener down mid-drag.
  const templateRef = useRef(t.notch_unsupported);
  templateRef.current = t.notch_unsupported;
  const writeFailedRef = useRef(t.notch_write_failed);
  writeFailedRef.current = t.notch_write_failed;
  const whisperMissingRef = useRef(t.voice_whisper_missing);
  whisperMissingRef.current = t.voice_whisper_missing;
  const modelProgressRef = useRef(t.voice_model_progress);
  modelProgressRef.current = t.voice_model_progress;
  const micDeniedRef = useRef(t.voice_mic_denied);
  micDeniedRef.current = t.voice_mic_denied;

  useEffect(() => {
    if (mocking) return;
    void ipc
      .notchGeometry()
      .then(setGeom)
      .catch(() => {
        /* plain-browser dev: no Tauri backend */
      });
  }, [mocking]);

  // Native drag-drop → reducer, drop → _inbox write. Same subscription shape
  // as PageIngest: Tauri intercepts drag-drop at the OS level, so the browser
  // drop event never fires inside the webview.
  useEffect(() => {
    if (mocking) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((event) => {
          const p = event.payload;
          if (p.type === "enter") {
            raise({ type: "dragEnter", paths: p.paths });
          } else if (p.type === "over") {
            raise({ type: "dragOver" });
          } else if (p.type === "leave") {
            raise({ type: "dragLeave" });
          } else {
            raise({
              type: "drop",
              paths: p.paths,
              unsupportedTemplate: templateRef.current,
            });
            void persistDrop({ type: "files", paths: p.paths }, templateRef.current).then(
              (summary) => {
                if (summary) raise({ type: "writeOk", summary });
              },
              (err: unknown) => {
                // The lip shows a translated line; the raw backend error is
                // for the console, not for a 300px surface with no scroll.
                console.error("notch drop write failed:", err);
                raise({
                  type: "writeFail",
                  reason: writeFailedRef.current ?? "Could not save the drop",
                });
              },
            );
          }
        }),
      )
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      })
      .catch(() => {
        /* plain-browser dev: no Tauri backend */
      });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [mocking]);

  // First-use whisper model download → the recording lip narrates its percent
  // instead of freezing on the last second for minutes (whisper.rs emits
  // whisper-model-progress only while that one-time download runs).
  useEffect(() => {
    if (mocking) return;
    let gone = false;
    let unlisten: (() => void) | null = null;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<{ pct: number }>("whisper-model-progress", (e) => {
          const template =
            modelProgressRef.current ??
            "downloading the voice model — one time, {pct}%";
          raise({
            type: "recNote",
            note: template.replace("{pct}", String(e.payload.pct)),
          });
        }),
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
  }, [mocking]);

  // Tray-status snapshot + push → statusPush (S5/S6 data source). Same event
  // the tray popover consumes; only the first live row narrates here.
  useEffect(() => {
    if (mocking) return;
    const push = (s: TrayStatusPayload): void => {
      const live = s.running.find((r) => r.text !== "");
      raise({ type: "statusPush", running: live ? live.text : null });
    };
    void ipc
      .getTrayStatus()
      .then(push)
      .catch(() => {
        /* plain-browser dev: no Tauri backend */
      });
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<TrayStatusPayload>(TRAY_STATUS_EVENT, (e) => push(e.payload)),
      )
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      })
      .catch(() => {
        /* plain-browser dev: no Tauri event bus */
      });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [mocking]);

  // S5's lip clock ticks once a second while something runs.
  const kind = drv.panel.kind;
  useEffect(() => {
    if (kind !== "running") return;
    const id = window.setInterval(() => raise({ type: "tick" }), 1000);
    return () => window.clearInterval(id);
  }, [kind]);

  // ---- S7/S8 quick capture --------------------------------------------------

  // Mirrors the voice machine's own state: the ticker and the recording-mode
  // keys follow the MACHINE (which owns the mic), not the panel, so a stopped
  // take stops its clock even while the last frame is still displayed.
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const machineRef = useRef<VoiceMachine | null>(null);
  const kindRef = useRef(kind);
  kindRef.current = kind;

  const machine = (): VoiceMachine => {
    machineRef.current ??= createVoiceMachine({
      getStream: () => navigator.mediaDevices.getUserMedia({ audio: true }),
      makeRecorder: (s) => new MediaRecorder(s),
      save: async (bytes) => {
        const saved = await ipc.saveVoiceCapture(Array.from(bytes));
        // The machine's onChange("saved") carries no rel — announce it here.
        raise({ type: "recSaved", rel: basename(saved.rel) });
        return saved;
      },
      onChange: (state, error) => {
        setVoiceState(state);
        if (state === "recording") raise({ type: "recStart" });
        else if (state === "saving") raise({ type: "recStop" });
        else if (state === "idle") raise({ type: "captureCancel" });
        else if (state === "error") {
          // The machine's two sentinel errors become the translated lines the
          // spotlight already ships; anything else is a real backend message.
          raise({
            type: "recFail",
            reason:
              error === "mic-denied"
                ? (micDeniedRef.current ?? "The microphone is not available")
                : error === "whisper-missing"
                  ? (whisperMissingRef.current ?? "whisper is not installed")
                  : (error ?? "Recording failed"),
          });
        }
      },
    });
    return machineRef.current;
  };

  // Lip click opens capture — mouse events reach the non-activating panel
  // (P0) — and asks the native side for KEY so the input can actually type.
  // The outcome is logged either way: on hardware this line is the honest
  // record of whether makeKeyWindow / the fallback took (see notch.rs).
  useEffect(() => {
    if (mocking) return;
    const onClick = (): void => {
      if (kindRef.current !== "idle" && kindRef.current !== "peek") return;
      raise({ type: "captureOpen" });
      void ipc.notchFocusCapture().then(
        (key) =>
          console.log(`notch: focus capture → isKeyWindow=${String(key)}`),
        (err: unknown) => console.error("notch: focus capture failed:", err),
      );
    };
    // Hover unfolds the peek hint; leaving folds it back. document-level
    // enter/leave, because collapsed the window is mostly transparent and the
    // whole surface should react, not just the 56px tab.
    const onEnter = (): void => {
      if (kindRef.current === "idle") raise({ type: "hoverEnter" });
    };
    const onLeave = (): void => {
      if (kindRef.current === "peek") raise({ type: "hoverLeave" });
      // A hover-grown surface must also fold when the pointer leaves an
      // UNUSED capture — otherwise a stray click pins it open with no mouse
      // way out (and no keyboard way out either, if key focus was refused).
      // Typed text keeps it open: leaving must never destroy content.
      else if (kindRef.current === "capture") {
        const field = document.querySelector<HTMLInputElement>(".notch-field");
        if (!field?.value.trim()) raise({ type: "captureCancel" });
      }
    };
    window.addEventListener("click", onClick);
    document.documentElement.addEventListener("mouseenter", onEnter);
    // mousemove as well: enter alone missed on the non-key panel (pointer can
    // already be inside when tracking starts). Same idle gate, so it costs
    // one no-op comparison per move once grown.
    document.documentElement.addEventListener("mousemove", onEnter);
    document.documentElement.addEventListener("mouseleave", onLeave);
    // The load-bearing hover source: DOM enter/leave only fire while THIS app
    // is active, and the notch is hovered mid-someone-else's-app. The native
    // side polls the pointer against the panel frame and emits transitions
    // (notch.rs spawn_hover_watch); the DOM pair above stays as the fast path.
    let unlistenHover: (() => void) | null = null;
    let hoverGone = false;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<boolean>("notch-hover", (e) => {
          if (e.payload) onEnter();
          else onLeave();
        }),
      )
      .then((u) => {
        if (hoverGone) u();
        else unlistenHover = u;
      })
      .catch((err: unknown) =>
        console.error("notch: hover listen failed:", err),
      );
    return () => {
      hoverGone = true;
      if (unlistenHover) unlistenHover();
      window.removeEventListener("click", onClick);
      document.documentElement.removeEventListener("mouseenter", onEnter);
      document.documentElement.removeEventListener("mousemove", onEnter);
      document.documentElement.removeEventListener("mouseleave", onLeave);
    };
  }, [mocking]);

  // Recording mode has no input to hang keys on: ⏎/⌥M stop-and-save, esc
  // cancels (mic release is the machine's job, never re-done here).
  useEffect(() => {
    if (kind !== "recording") return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Enter" || (e.altKey && e.code === "KeyM")) {
        e.preventDefault();
        void machine().stop();
      } else if (e.key === "Escape") {
        e.preventDefault();
        machine().cancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [kind]);

  // S8's lip clock + waveform walk, while the mic is actually live.
  useEffect(() => {
    if (voiceState !== "recording") return;
    const id = window.setInterval(() => raise({ type: "recTick" }), 1000);
    return () => window.clearInterval(id);
  }, [voiceState]);

  // Never leave the mic held by an unmounted webview.
  useEffect(() => {
    return () => machineRef.current?.cancel();
  }, []);

  const onCaptureSubmit = (text: string): void => {
    raise({ type: "captureSubmit" });
    void ipc.captureNote(text).then(
      (rel) => raise({ type: "captureSaved", rel }),
      (err: unknown) => {
        console.error("notch capture write failed:", err);
        raise({
          type: "captureFail",
          reason: writeFailedRef.current ?? "Could not save the drop",
        });
      },
    );
  };

  const onCaptureCancel = (): void => {
    if (kindRef.current === "recording") machine().cancel();
    else raise({ type: "captureCancel" });
  };

  // Paste-to-inbox threshold: past this a selection is reference material,
  // not a "- HH:MM" daily line (capture_note refuses >4 KiB anyway).
  const PASTE_NOTE_CHARS = 1000;
  const onCapturePaste = (text: string): boolean => {
    const trimmed = text.trim();
    const isUrl =
      /^https?:\/\/\S+$/.test(trimmed) && !trimmed.includes("\n");
    if (!isUrl && trimmed.length <= PASTE_NOTE_CHARS) return false;
    const payload: DropPayload = isUrl
      ? { type: "url", url: trimmed }
      : { type: "text", text: trimmed };
    raise({ type: "drop", paths: [], payload });
    void persistDrop(payload, templateRef.current).then(
      (summary) => {
        if (summary) raise({ type: "writeOk", summary });
      },
      (err: unknown) => {
        console.error("notch paste write failed:", err);
        raise({
          type: "writeFail",
          reason: writeFailedRef.current ?? "Could not save the drop",
        });
      },
    );
    return true;
  };

  const onCaptureVoice = (): void => {
    const missing = (): void =>
      raise({
        type: "recFail",
        reason: whisperMissingRef.current ?? "whisper is not installed",
      });
    void ipc.whisperCheck().then((s) => {
      if (!s.installed) {
        missing();
        return;
      }
      return machine().start();
    }, missing);
  };

  // Self-collapse: arm the state's dwell, if it has one. `drv.panel` is a new
  // object only when the reducer actually moved, so no-op pushes do not rearm.
  useEffect(() => {
    const dwell = dwellMsFor(drv.panel);
    if (dwell === null) return;
    const id = window.setTimeout(() => raise({ type: "idleTimeout" }), dwell);
    return () => window.clearTimeout(id);
  }, [drv.panel]);

  // Fit the OS window to the surface. With a real notch this is TWO-PHASE:
  // grow the transparent OS window first, unfurl the card only after the
  // resize acked. The state flip is synchronous but the resize is an IPC +
  // main-thread hop away, and the recorded jank was exactly that gap — one
  // frame of the open card painted clipped inside the collapsed window, then
  // a lateral jump as the window recentred under it.
  const pill = geom !== null && !geom.has_notch;
  const open = describeNotch(drv.panel, t, pill).open;
  const hasNotch = geom?.has_notch ?? false;
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    if (mocking || !hasNotch) return;
    const g = geom as NotchGeometry;
    if (open) {
      let live = true;
      const unfurl = (): void => {
        if (live) setGrown(true);
      };
      // Fixed open size: the card's exact height is unknowable before it
      // renders, and rendering is what must wait. The spare rows stay
      // transparent (and inside the hover watcher's leave slop).
      void ipc.notchResize(NOTCH_OPEN_WIDTH, NOTCH_OPEN_MAX_H).then(
        unfurl,
        unfurl, // plain-browser dev: no Tauri backend
      );
      return () => {
        live = false;
      };
    }
    setGrown(false);
    // Collapse order is the mirror: card folds instantly (render), the OS
    // window shrinks after it. Also the boot pass — this arms on mount and
    // corrects the builder's pill-sized default to the measured cutout.
    const id = window.setTimeout(() => {
      void ipc.notchResize(g.notch_w, g.notch_h + NOTCH_PEEK_PX).catch(() => {
        /* plain-browser dev: no Tauri backend */
      });
    }, 420);
    return () => window.clearTimeout(id);
  }, [mocking, hasNotch, open, geom]);
  // Notchless pill fallback: no hardware to hide behind and no recentring
  // cutout math — the measured-size follower is still the right tool there.
  useEffect(() => {
    if (mocking || hasNotch) return;
    const el = document.querySelector<HTMLElement>(".notch");
    if (!el || typeof ResizeObserver === "undefined") return;
    let last = "";
    const ro = new ResizeObserver(() => {
      const w = Math.ceil(el.offsetWidth);
      const h = Math.ceil(el.offsetHeight);
      const key = `${w}x${h}`;
      if (w > 0 && h > 0 && key !== last) {
        last = key;
        void ipc.notchResize(w, h).catch(() => {
          /* plain-browser dev: no Tauri backend */
        });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [mocking, hasNotch]);

  // Content below the hardware cutout: the panel's lip offsets by the real
  // notch height (0 on a notchless Mac, where the whole pill is visible).
  useEffect(() => {
    if (mocking) return;
    document.documentElement.style.setProperty(
      "--notch-cutout",
      `${geom?.has_notch ? geom.notch_h : 0}px`,
    );
  }, [mocking, geom]);

  if (mocking) return null;
  return {
    // Until the OS window has grown, the panel RENDERS collapsed even though
    // the reducer already moved — the other half of the two-phase open.
    state: hasNotch && open && !grown ? NOTCH_IDLE.panel : drv.panel,
    pill,
    collapsedWidth: geom?.has_notch ? geom.notch_w : null,
    onCaptureSubmit,
    onCaptureCancel,
    onCaptureVoice,
    onCapturePaste,
  };
}
