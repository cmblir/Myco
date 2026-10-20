// myco out of the notch (spec: docs/specs/2026-10-02-mascot-roam.md). The
// roam window (src-tauri/src/roam.rs, `?window=roam`) is a see-through panel
// over the notch screen's visible frame; components/RoamWindow.tsx draws one
// RoamFrame in it. Coordinates are that window's own px (RoamPlace's): x
// right and y down from its top-left, just under the menu bar.

import type { RoamPlace } from "./ipc";
import type { MascotKind } from "./notchMascot";

/** myco's box out of the notch (decision 4: about 64 px). */
export const ROAM_MYCO_PX = 64;

/** roam.rs, to every webview: the RoamPlace once myco is out, null once back. */
export const ROAM_VISIBILITY_EVENT = "roam-visibility";
/** The notch to the roam window: the RoamCue for the work myco is out for. */
export const ROAM_CUE_EVENT = "roam-cue";
/** The roam window to the notch, once it has loaded: send the cue again (the
 *  first roam builds the window, which loads after the cue went out). */
export const ROAM_HELLO_EVENT = "roam-hello";

/** A job's steps, as the notch reads them off its running line. */
export interface RoamSteps {
  done: number;
  total: number;
}

/** What the notch tells the roam window about the work myco is out for
 *  (lib/roamTrigger sends it, lib/roamMotion plays it). `job` picks the stop
 *  clip: read-loop while reading or ingesting, think while saving or
 *  reflecting, and a look around or a breath on an everyday walk. `outcome`
 *  is set once the work has ended: myco then goes back into the notch, after
 *  a head shake on a failure. */
export interface RoamCue {
  job: "read" | "think" | "wander";
  progress: RoamSteps | null;
  outcome: "done" | "failed" | null;
  /** Only on an everyday walk (job "wander", no work running): how long it
   *  lasts and how many stops it makes before going home on its own. */
  walk?: RoamWalk;
}

/** One everyday walk (the 2026-10-03 amendment): 15–40 s, 2–4 stops. */
export interface RoamWalk {
  ms: number;
  stops: number;
}

/** One frame of myco roaming. */
export interface RoamFrame {
  /** Its feet: x at its centre, y at its base. */
  x: number;
  y: number;
  /** The contact plane beneath a hop; absent means the feet are grounded. */
  groundY?: number;
  /** What it does there, in the notch mascot's own vocabulary, so the pose,
   *  the clip and the motion come from the same table (lib/notchMascot):
   *  `running` reads (read-loop), `saving` thinks (think), `rejected` shakes
   *  its head (shake-no), `look-around` looks around, `idle` breathes,
   *  `hop` travels between stops. */
  act: MascotKind;
  /** Squash and stretch on top of the mascot's own motion; 1 is at rest. */
  sx: number;
  sy: number;
  /** A hop's tilt into the travel, in degrees (clockwise leans right), and
   *  its cap trailing the body, as a skew in degrees; absent is 0. */
  lean?: number;
  lag?: number;
  /** The job's steps ("20개 중 11개"), shown as "11/20" beside myco. */
  progress: RoamSteps | null;
}

/** The entry point inside the collapsed notch surface, in roam-window px.
 *  The resting menu bar has no mascot; a walk appears from and disappears
 *  above this point without covering the menu beside the cutout. */
export function mycoHome(place: RoamPlace): { x: number; y: number } {
  return {
    x: place.notch_left + ROAM_MYCO_PX / 2,
    y: 0,
  };
}
