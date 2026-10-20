// Where myco stops next while it roams the screen (spec: docs/specs/
// 2026-10-02-mascot-roam.md, decision 4). Pure and seeded, in the roam
// window's own px (lib/roam): positions are myco's feet, its sprite spans
// x ± 32 and y - 64 .. y, and the window's top edge sits under the menu bar.

import { mulberry32 } from "./notchMascot";
import type { RoamPlace } from "./ipc";
import { ROAM_MYCO_PX } from "./roam";

export interface Pt {
  x: number;
  y: number;
}

/** Room kept between myco and every window edge. */
export const ROAM_EDGE = 16;
/** A stop is at least this far from the pointer… */
export const POINTER_CLEAR_PX = 200;
/** …and myco hops away once the pointer comes this close. */
export const FLEE_PX = 120;
/** A stop is a real move away from where it stands. */
const MIN_LEG = 160;
const TRIES = 32;
const HALF = ROAM_MYCO_PX / 2;

/** The pointer rules measure from myco's middle, not its feet. */
function fromPointer(at: Pt, pointer: Pt): number {
  return Math.hypot(at.x - pointer.x, at.y - HALF - pointer.y);
}

/** Keep the ground corridor clear, before near landings force a turn. */
function clearsRun(from: Pt, to: Pt, pointer: Pt): boolean {
  // Already near the pointer: allow a direct escape to a clear stop.
  if (fromPointer(from, pointer) < FLEE_PX) return true;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length2 = dx * dx + dy * dy;
  const share = length2 === 0 ? 0 : Math.min(1, Math.max(0,
    ((pointer.x - from.x) * dx + (pointer.y - (from.y - HALF)) * dy) / length2,
  ));
  return fromPointer({ x: from.x + dx * share, y: from.y + dy * share }, pointer) >= FLEE_PX;
}

/**
 * The next stop from `from`. Candidates favour the sides (a squared share of
 * the half-width in from either edge) and the lower part (a squared share of
 * 70 % of the height up from the floor); the first one at least
 * POINTER_CLEAR_PX from the pointer, with a clear ground corridor, and
 * MIN_LEG from `from` wins. A window with no such spot gets the candidate
 * farthest from the pointer.
 */
export function nextStop(place: RoamPlace, from: Pt, pointer: Pt | null, seed: number): Pt {
  const rand = mulberry32(seed);
  const x0 = ROAM_EDGE + HALF;
  const x1 = Math.max(x0, place.width - ROAM_EDGE - HALF);
  const y0 = ROAM_EDGE + ROAM_MYCO_PX;
  const y1 = Math.max(y0, place.height - ROAM_EDGE);
  let best: Pt = { x: x0, y: y1 };
  let bestClear = -1;
  for (let i = 0; i < TRIES; i++) {
    const inset = (x1 - x0) * 0.5 * rand() ** 2;
    const p = {
      x: rand() < 0.5 ? x0 + inset : x1 - inset,
      y: y1 - (y1 - y0) * 0.7 * rand() ** 2,
    };
    const clear = pointer ? fromPointer(p, pointer) : Infinity;
    if (clear >= POINTER_CLEAR_PX && Math.hypot(p.x - from.x, p.y - from.y) >= MIN_LEG &&
      (pointer === null || clearsRun(from, p, pointer))) {
      return p;
    }
    if (clear > bestClear) {
      best = p;
      bestClear = clear;
    }
  }
  return best;
}

/** The pointer is within FLEE_PX of myco standing at `at`: time to hop. */
export function tooClose(at: Pt, pointer: Pt | null): boolean {
  return pointer !== null && fromPointer(at, pointer) < FLEE_PX;
}
