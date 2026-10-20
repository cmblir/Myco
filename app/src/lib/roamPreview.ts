// The roam window's dev preview (docs/specs/2026-10-02-mascot-roam.md,
// Acceptance › Browser). `?window=roam&roamMock=1` runs the real motion
// (lib/roamMotion) over a scripted job, with the mouse as the pointer;
// `&roamAt=MS` pins that walk at MS for a deterministic screenshot, and
// `&roamFail=1` ends the job in a failure, and `&roamWander=1` swaps the job
// for an everyday walk (the 2026-10-03 amendment). `&roamFrame=N` pins one of the
// hand-set beats below instead. The browser viewport stands in for the whole
// screen: a painted menu bar and cutout on top, the roam window under them.

import type { RoamPlace } from "./ipc";
import { ROAM_MYCO_PX, mycoHome } from "./roam";
import type { RoamCue, RoamFrame } from "./roam";
import { roamFrame, roamStart, roamTick } from "./roamMotion";
import type { RoamSim } from "./roamMotion";

/** The 14" MacBook Pro devMock reports: its menu bar is the cutout's height. */
export const ROAM_MOCK_BAR = 37;
export const ROAM_MOCK_NOTCH_W = 204;

/** The roam window under a `width × height` screen's menu bar, Dock hidden. */
export function mockPlace(width: number, height: number): RoamPlace {
  return {
    width,
    height: height - ROAM_MOCK_BAR,
    notch_left: (width - ROAM_MOCK_NOTCH_W) / 2,
  };
}

/** One beat: under myco's home in the notch, its feet `home` of its height
 *  below the window's top edge (the rest of it still in the menu bar), or at
 *  a share of the width and a height above the floor. */
interface Beat extends Omit<RoamFrame, "x" | "y"> {
  at: { home: number } | { x: number; lift: number };
}

const STILL = { sx: 1, sy: 1 };

const BEATS: readonly Beat[] = [
  // Pops out of the notch, stretched along the drop.
  { at: { home: 0.55 }, act: "idle", sx: 0.82, sy: 1.22, progress: null },
  {
    at: { x: 0.2, lift: 0 },
    act: "running",
    ...STILL,
    progress: { done: 11, total: 20 },
  },
  // Mid-hop between stops: up, stretched along the arc.
  {
    at: { x: 0.45, lift: 160 },
    act: "idle",
    sx: 0.86,
    sy: 1.16,
    progress: { done: 12, total: 20 },
  },
  {
    at: { x: 0.72, lift: 40 },
    act: "saving",
    ...STILL,
    progress: { done: 14, total: 20 },
  },
  {
    at: { x: 0.9, lift: 0 },
    act: "idle",
    ...STILL,
    progress: { done: 15, total: 20 },
  },
  { at: { x: 0.6, lift: 0 }, act: "rejected", ...STILL, progress: null }, // the job failed
  // Going back in: halfway up from the doorstep, shrinking out of view,
  // still a little squashed (lib/roamMotion's enter).
  { at: { home: 1.05 }, act: "enter", sx: 0.76, sy: 0.65, progress: null },
];

/** Stops stand this far above the window's bottom edge. */
const FLOOR_GAP = 24;

export function roamPreviewFrames(place: RoamPlace): readonly RoamFrame[] {
  const home = mycoHome(place);
  const floor = place.height - FLOOR_GAP;
  return BEATS.map(({ at, ...rest }) =>
    "home" in at
      ? { ...rest, x: home.x, y: ROAM_MYCO_PX * at.home }
      : { ...rest, x: place.width * at.x, y: floor - at.lift },
  );
}

export interface RoamMock {
  on: boolean;
  /** Pinned beat, or null for the live walk. */
  pinned: number | null;
  /** The live walk pinned at this many ms, or null to run it. */
  at: number | null;
  /** The scripted job ends in a failure. */
  fail: boolean;
  /** No job: an everyday walk instead. */
  wander: boolean;
}

/** `?roamMock=1[&roamFrame=N | &roamAt=MS][&roamFail=1][&roamWander=1]`, dev builds only. A
 *  pure function of the search string, so the node tests need no `location`. */
export function readRoamMock(search: string): RoamMock {
  const params = new URLSearchParams(search);
  if (!import.meta.env.DEV || !params.has("roamMock"))
    return { on: false, pinned: null, at: null, fail: false, wander: false };
  const n = Number.parseInt(params.get("roamFrame") ?? "", 10);
  const at = Number.parseInt(params.get("roamAt") ?? "", 10);
  return {
    on: true,
    pinned: Number.isInteger(n) && n >= 0 ? n % BEATS.length : null,
    at: Number.isInteger(at) && at >= 0 ? at : null,
    fail: params.has("roamFail"),
    wander: params.has("roamWander"),
  };
}

/** When the scripted job ends. */
export const PREVIEW_DONE_MS = 24_000;
/** Any seed works; a fixed one makes `roamAt` shots repeatable. */
export const PREVIEW_SEED = 20261003;

/** The everyday walk the preview takes: 3 stops in 24 s. */
const PREVIEW_WANDER: RoamCue = {
  job: "wander",
  progress: null,
  outcome: null,
  walk: { ms: 24_000, stops: 3 },
};

/** The scripted job: a harvest counting up 11/20 onward, joined by a save
 *  (think, no steps) at 14 s, over at PREVIEW_DONE_MS. Or, with `wander`, a
 *  walk, which ends itself. */
export function previewCue(ms: number, fail: boolean, wander = false): RoamCue {
  if (wander) return PREVIEW_WANDER;
  if (ms < 14_000) {
    return {
      job: "read",
      progress: { done: Math.min(20, 11 + Math.floor(ms / 3000)), total: 20 },
      outcome: null,
    };
  }
  return {
    job: "think",
    progress: null,
    outcome: ms < PREVIEW_DONE_MS ? null : fail ? "failed" : "done",
  };
}

/** The live walk `ms` into the script, stepped at 60 fps with no pointer. */
export function previewWalk(
  place: RoamPlace,
  ms: number,
  fail: boolean,
  wander = false,
): { sim: RoamSim; frame: RoamFrame } {
  const step = 1000 / 60;
  let sim = roamStart(place, PREVIEW_SEED);
  let t = 0;
  for (; t + step <= ms; t += step) {
    sim = roamTick(sim, step, { place, cue: previewCue(t, fail, wander), pointer: null });
  }
  return { sim, frame: roamFrame(sim, previewCue(t, fail, wander)) };
}
