// Drives NotchPanel in the notch webview (`?window=notch`): the panel renders
// whatever `NotchState` it is handed, and this file is the "whoever owns the
// native window" its header defers to. Split like NotchPanel itself: a pure
// reducer (`reduceNotch`) that turns events + time into the next state — the
// only part with rules worth testing — and a thin hook that feeds it from the
// real sources (Tauri drag-drop, the myco://tray-status push, timers) and
// mirrors open/collapsed into the OS window size.
//
// Drops arrive as absolute file paths only — Tauri's DragDrop event carries
// nothing else — so the url/text arms of notchDrop never fire here (S7/S8
// capture ship with the native key-focus work, not this driver).

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
import { useUIStore } from "../stores/uiStore";

/** `.notch.notch-open` is 300px in styles.css; the window must match. */
export const NOTCH_OPEN_WIDTH = 300;

/** How long S4/S9 hold before folding away. The sheet says only S6
 *  self-collapses, but this panel is non-activating — there is no click or key
 *  to dismiss it — so a surface that never gets replaced must fold itself.
 *  Accepted holds longer: "ingest reads it shortly" is worth reading. */
export const ACCEPTED_DWELL_MS = 8000;
export const REJECTED_DWELL_MS = 6000;

/** What the driver reacts to. `writeOk`/`writeFail` report the async
 *  `_inbox/` write that follows a drop; `statusPush` is the first running row
 *  of a tray-status push (null = nothing running); `tick` re-times the S5
 *  clock; `idleTimeout` is the dwell timer firing. */
export type NotchEvent =
  | { type: "dragEnter"; paths: string[] }
  | { type: "dragOver" }
  | { type: "dragLeave" }
  | { type: "drop"; paths: string[]; unsupportedTemplate?: string }
  | { type: "writeOk"; summary: string }
  | { type: "writeFail"; reason: string }
  | { type: "statusPush"; running: string | null }
  | { type: "tick" }
  | { type: "idleTimeout" };

export interface NotchDriverState {
  panel: NotchState;
  /** Epoch ms when the current running span began; null outside `running`.
   *  Kept beside the panel because S5's `elapsedMs` cannot be re-derived from
   *  itself when the next push or tick arrives. */
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
      return DONE_DWELL_MS;
    case "accepted":
      return ACCEPTED_DWELL_MS;
    case "rejected":
      return REJECTED_DWELL_MS;
    default:
      return null;
  }
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
      // A drag is the user, present right now — it outranks everything.
      const { name, meta } = dragLabel(event.paths);
      return { panel: { kind: "dragging", name, meta }, runningSince: null };
    }
    case "dragOver":
      return current;
    case "dragLeave":
      return panel.kind === "dragging" ? NOTCH_IDLE : current;
    case "drop": {
      const verdicts = classifyDrop(
        { type: "files", paths: event.paths },
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
  }
}

/** Sit a files drop in `_inbox/` and name what landed (`writeOk` summary),
 *  or resolve null when nothing was writable (the reducer already showed the
 *  rejection at drop time). */
async function persistDrop(
  paths: string[],
  unsupportedTemplate?: string,
): Promise<string | null> {
  const outcome = await writeDrop(
    // writeDrop only uses vaultPath to build the dest our copyFile wrapper
    // strips back to a basename — copy_into_inbox confines to the active
    // vault's _inbox/ on the Rust side, so this webview never needs the path.
    "",
    { type: "files", paths },
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
      // Unreachable for drag-drop (paths only) — reached only if a url/text
      // payload is ever fed in before a vault-confined note write exists.
      writeFile: () =>
        Promise.reject(
          new Error("notch cannot write notes yet — file drops only"),
        ),
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
            void persistDrop(p.paths, templateRef.current).then(
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

  // Self-collapse: arm the state's dwell, if it has one. `drv.panel` is a new
  // object only when the reducer actually moved, so no-op pushes do not rearm.
  useEffect(() => {
    const dwell = dwellMsFor(drv.panel);
    if (dwell === null) return;
    const id = window.setTimeout(() => raise({ type: "idleTimeout" }), dwell);
    return () => window.clearTimeout(id);
  }, [drv.panel]);

  // Fit the OS window to the surface (resize_tray_panel's pattern): unfolded,
  // the CSS-fixed 300px body × measured height; collapsed with a real notch,
  // the OS-measured cap so the panel hides inside the hardware; pill, measured
  // both ways.
  const pill = geom !== null && !geom.has_notch;
  const open = describeNotch(drv.panel, t, pill).open;
  useEffect(() => {
    if (mocking) return;
    const el = document.querySelector<HTMLElement>(".notch");
    if (!el || typeof ResizeObserver === "undefined") return;
    let last = "";
    const ro = new ResizeObserver(() => {
      const hasNotch = geom?.has_notch ?? false;
      const w = open
        ? NOTCH_OPEN_WIDTH
        : hasNotch
          ? (geom as NotchGeometry).notch_w
          : Math.ceil(el.offsetWidth);
      const h =
        !open && hasNotch
          ? (geom as NotchGeometry).notch_h + NOTCH_PEEK_PX
          : Math.ceil(el.offsetHeight);
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
  }, [mocking, open, geom]);

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
    state: drv.panel,
    pill,
    collapsedWidth: geom?.has_notch ? geom.notch_w : null,
  };
}
