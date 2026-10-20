// When myco leaves the notch to roam the screen, and when it comes back
// (spec: docs/specs/2026-10-02-mascot-roam.md, decisions 1, 6 and 7). It runs
// in the notch webview, over the notch's own states (lib/notchDriver): work
// still running 2 s after it started sends myco out (roam.rs `roam_show`),
// more work joins the roam already out, and once the work is over the roam
// window is told so and brings myco back itself. With nothing running, myco
// also goes out for a short walk every few minutes (the 2026-10-03
// amendment), from the same seat and through the same window. A pure machine
// (`stepRoam`), whose show and hide the hook below carries out.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { NotchState } from "../components/NotchPanel";
import { prefersReducedMotion, subscribeReducedMotion } from "../components/NotchMascot";
import { useUIStore } from "../stores/uiStore";
import { ipc } from "./ipc";
import { mulberry32 } from "./notchMascot";
import { ROAM_CUE_EVENT, ROAM_HELLO_EVENT } from "./roam";
import type { RoamCue, RoamSteps, RoamWalk } from "./roam";

/** Work this long in the running sends myco out. */
export const ROAM_DELAY_MS = 2000;
/** The roam window brings myco back on its own; past this the notch calls it
 *  back itself. lib/roamMotion's small hops cross a 2560 px screen's diagonal
 *  in about 12 s, after a failure's 4 s head shake. */
// ponytail: sized for screens up to ~2560 px; a bigger one gets cut off at 20 s.
export const ROAM_BACK_MS = 20_000;
/** The gap between everyday walks: 3 to 8 min. */
export const WANDER_GAP_MS: readonly [number, number] = [180_000, 480_000];

/** The next everyday walk, from `seed`: the gap before it, and the walk
 *  itself, 2–4 stops of 7.5–10 s each (15–40 s in all). */
export function wanderPlan(seed: number): { gapMs: number; walk: RoamWalk } {
  const rand = mulberry32(seed);
  const [lo, hi] = WANDER_GAP_MS;
  const gapMs = Math.round(lo + (hi - lo) * rand());
  const stops = 2 + Math.floor(rand() * 3);
  return { gapMs, walk: { stops, ms: Math.round(stops * (7500 + 2500 * rand())) } };
}

/** The notch is closed and nothing is over it: its idle state, which the
 *  pointer turns into the hover peek and every open state replaces. Only
 *  then does myco go out for a walk. */
export function roamQuiet(panel: NotchState): boolean {
  return panel.kind === "idle";
}

export type RoamPhase =
  /** In the notch, nothing running; the next walk at `wanderAt`, if one is
   *  planned (none while roaming is off). */
  | { at: "home"; wanderAt?: number }
  /** Work started at `since`; out once it has run ROAM_DELAY_MS. */
  | { at: "due"; since: number; cue: RoamCue }
  /** Out, on work or (`until` set) on a walk that ends at `until`. */
  | { at: "out"; cue: RoamCue; until?: number }
  /** The work is over (`cue.outcome`), and the roam window is bringing myco
   *  back, since `since`. */
  | { at: "back"; since: number; cue: RoamCue }
  /** The roam window would not show (the notch is hidden, or a full-screen
   *  app holds its screen): myco stays in the notch until the work is over. */
  | { at: "spent" };

export const ROAM_HOME: RoamPhase = { at: "home" };

export type RoamEvent =
  /** The notch's state, whenever it changes. */
  | { type: "work"; panel: NotchState; now: number }
  /** `quiet`: the notch is closed and the pointer is not over it. */
  | { type: "tick"; now: number; quiet?: boolean }
  /** roam_show answered: whether myco went out. */
  | { type: "shown"; ok: boolean; now: number }
  /** The roam window ordered out (roam.rs `roam-visibility` null). */
  | { type: "recalled"; now: number }
  /** The setting, the mascot or reduced motion turned roaming off. */
  | { type: "off" };

export interface RoamStep {
  phase: RoamPhase;
  /** Order the roam window in. */
  show?: true;
  /** Order it out now. */
  hide?: true;
}

/** "11/20" off a running line ("수확 중 11/20", "Indexing… 218/302"). */
export function roamSteps(text: string): RoamSteps | null {
  const m = /(\d+)\s*\/\s*(\d+)/.exec(text);
  return m && Number(m[2]) > 0 ? { done: Number(m[1]), total: Number(m[2]) } : null;
}

/** Running rows whose work is reading; the rest think. A run the notch
 *  started itself (a drop) carries no row kind, and it ingests. */
const READING: ReadonlySet<string> = new Set(["index", "ingest", "distill"]);

/** The cue for work the notch reports in progress, or null for any other
 *  state: read-loop while reading or ingesting, think while saving or
 *  reflecting (decision 4). */
export function roamCueFor(panel: NotchState): RoamCue | null {
  if (panel.kind === "saving") return { job: "think", progress: null, outcome: null };
  if (panel.kind !== "running") return null;
  return {
    job: panel.job === undefined || READING.has(panel.job) ? "read" : "think",
    progress: roamSteps(panel.detail),
    outcome: null,
  };
}

/** Home, with the next walk planned from `now`. */
function rest(now: number): RoamPhase {
  return { at: "home", wanderAt: now + wanderPlan(now).gapMs };
}

export function stepRoam(phase: RoamPhase, e: RoamEvent): RoamStep {
  switch (e.type) {
    case "work": {
      const cue = roamCueFor(e.panel);
      switch (phase.at) {
        case "home":
          if (cue) return { phase: { at: "due", since: e.now, cue } };
          return { phase: phase.wanderAt === undefined ? rest(e.now) : phase };
        case "due":
          return { phase: cue ? { ...phase, cue } : rest(e.now) };
        case "out":
          // Work takes a walk over where it stands: the window is out
          // already, so there is no second exit. Anything else (an idle push,
          // the hover peek) leaves the walk alone.
          if (phase.until !== undefined) return { phase: cue ? { at: "out", cue } : phase };
          // The notch's failures are `rejected` (a drop) and `failed` (a
          // job); whatever else it moved on to, myco just goes back.
          return {
            phase: cue
              ? { at: "out", cue }
              : {
                  at: "back",
                  since: e.now,
                  cue: { ...phase.cue, outcome: e.panel.kind === "rejected" || e.panel.kind === "failed" ? "failed" : "done",
                },
                },
          };
        case "back":
          return { phase: cue ? { at: "out", cue } : phase };
        case "spent":
          return { phase: cue ? phase : rest(e.now) };
      }
      break;
    }
    case "tick":
      if (phase.at === "home" && phase.wanderAt !== undefined && e.now >= phase.wanderAt) {
        // An open or hovered notch skips this walk and waits a whole gap.
        if (!e.quiet) return { phase: rest(e.now) };
        const { walk } = wanderPlan(e.now);
        const cue: RoamCue = { job: "wander", progress: null, outcome: null, walk };
        return { phase: { at: "out", cue, until: e.now + walk.ms }, show: true };
      }
      if (phase.at === "due" && e.now - phase.since >= ROAM_DELAY_MS) {
        return { phase: { at: "out", cue: phase.cue }, show: true };
      }
      if (phase.at === "out" && phase.until !== undefined && e.now >= phase.until) {
        // The roam window ends a walk on its own; this is the notch's word
        // that the time is up, should it still be out.
        return { phase: { at: "back", since: e.now, cue: { ...phase.cue, outcome: "done" } } };
      }
      if (phase.at === "back" && e.now - phase.since >= ROAM_BACK_MS) {
        return { phase: rest(e.now), hide: true };
      }
      return { phase };
    case "shown":
      if (e.ok) return { phase };
      if (phase.at === "out") return { phase: phase.until === undefined ? { at: "spent" } : rest(e.now) };
      return { phase: phase.at === "back" ? rest(e.now) : phase };
    case "recalled":
      // Called back mid-work: one more try, which roam_show refuses while
      // whatever called it back still holds. A walk is just over.
      if (phase.at === "out") {
        return { phase: phase.until === undefined ? { at: "due", since: e.now, cue: phase.cue } : rest(e.now) };
      }
      return { phase: phase.at === "back" ? rest(e.now) : phase };
    case "off":
      return phase.at === "out" || phase.at === "back"
        ? { phase: ROAM_HOME, hide: true }
        : { phase: ROAM_HOME };
  }
}

/**
 * The machine, live in the notch webview. `panel` is the notch's state (null
 * under the notch's dev mock, where nothing roams); `away` is whether myco is
 * out (roam.rs `roam-visibility`, which the driver listens to). Off with the
 * setting, the mascot or reduced motion (decision 7), for walks and work
 * alike; a full-screen app, a locked or sleeping screen are roam.rs's to
 * refuse.
 */
export function useRoamTrigger(panel: NotchState | null, away: boolean): void {
  const roams = useUIStore((s) => s.mascotRoam && s.mascotEnabled);
  const reduced = useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion);
  const allowed = roams && !reduced;
  const [phase, setPhase] = useState<RoamPhase>(ROAM_HOME);
  const phaseRef = useRef<RoamPhase>(ROAM_HOME);
  const send = useRef((e: RoamEvent): void => {
    const step = stepRoam(phaseRef.current, e);
    phaseRef.current = step.phase;
    setPhase(step.phase);
    if (step.show) {
      void ipc.roamShow().then(
        (ok) => send.current({ type: "shown", ok, now: Date.now() }),
        (err: unknown) => {
          console.error("roam: show failed:", err);
          send.current({ type: "shown", ok: false, now: Date.now() });
        },
      );
    }
    if (step.hide) {
      void ipc.roamHide().catch((err: unknown) => console.error("roam: hide failed:", err));
    }
  });

  const panelRef = useRef(panel);
  panelRef.current = panel;
  useEffect(() => {
    if (!panel) return;
    send.current(allowed ? { type: "work", panel, now: Date.now() } : { type: "off" });
  }, [panel, allowed]);

  // The 2 s wait, the next walk, a walk's end and the back stop: one
  // timeout, only in those phases.
  useEffect(() => {
    const due =
      phase.at === "due"
        ? phase.since + ROAM_DELAY_MS
        : phase.at === "back"
          ? phase.since + ROAM_BACK_MS
          : phase.at === "home"
            ? (phase.wanderAt ?? null)
            : phase.at === "out"
              ? (phase.until ?? null)
              : null;
    if (due === null) return;
    const id = window.setTimeout(() => {
      const shown = panelRef.current;
      send.current({ type: "tick", now: Date.now(), quiet: shown !== null && roamQuiet(shown) });
    }, Math.max(0, due - Date.now()));
    return () => window.clearTimeout(id);
  }, [phase]);

  const wasAway = useRef(away);
  useEffect(() => {
    if (wasAway.current && !away) send.current({ type: "recalled", now: Date.now() });
    wasAway.current = away;
  }, [away]);

  // The cue goes to the roam window whenever it says something new (the lip
  // clock re-renders the running state every second; the cue does not move).
  const cue = phase.at === "out" || phase.at === "back" ? phase.cue : null;
  const cueRef = useRef(cue);
  cueRef.current = cue;
  const said = cue ? JSON.stringify(cue) : null;
  useEffect(() => {
    if (said === null) return;
    void import("@tauri-apps/api/event")
      .then(({ emit }) => emit(ROAM_CUE_EVENT, cueRef.current))
      .catch(() => {
        /* plain-browser dev: no Tauri event bus */
      });
  }, [said]);

  // A roam window that loaded after the cue went out asks for it again.
  useEffect(() => {
    let gone = false;
    let stop: (() => void) | null = null;
    void import("@tauri-apps/api/event")
      .then(({ emit, listen }) =>
        listen(ROAM_HELLO_EVENT, () => {
          if (cueRef.current) void emit(ROAM_CUE_EVENT, cueRef.current);
        }),
      )
      .then((u) => {
        if (gone) u();
        else stop = u;
      })
      .catch(() => {
        /* plain-browser dev: no Tauri event bus */
      });
    return () => {
      gone = true;
      stop?.();
    };
  }, []);
}
