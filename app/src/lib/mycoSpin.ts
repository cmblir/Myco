// The spin viewer's pure maps (spec 2026-10-04-myco-spin.md): a turntable
// video's playhead driven by drag, inertia, keys and an idle turn. Each video
// is one turn at 24 fps whose last frame repeats the first (the front), so a
// turn is 144 frames and time 0 is the front. The video turns the front to
// the left as it plays.
//
// The coasting matches lib/myco3d's coastSpin, but that module imports
// three.js, which the video view must not pull in.

export const SPIN_FPS = 24;
const SPIN_FRAMES = 144;
export const SPIN_TURN_S = SPIN_FRAMES / SPIN_FPS;
/** Untouched this long, it starts turning on its own. */
export const IDLE_AFTER_MS = 4000;

/** 15° per arrow press. */
const KEY_STEP_S = SPIN_TURN_S / 24;
/** The idle turn: one turn per 24 s, a quarter of the video's speed. */
const IDLE_RATE = SPIN_TURN_S / 24_000;
/** Inertia's time constant: the fling loses 63% of its speed per TAU ms. */
const TAU = 350;
/** Playhead seconds per ms. */
const MAX_V = 0.02;
const STOP_V = 2e-5;

/** Fold a time into one turn, [0, SPIN_TURN_S). */
export function wrap(t: number): number {
  const r = t % SPIN_TURN_S;
  return r < 0 ? r + SPIN_TURN_S : r === 0 ? 0 : r;
}

/** A drag of dx px over an element `width` px wide: a full width is one
 *  turn, and the front follows the pointer (left is forward in the video). */
export function dragToTime(t: number, dx: number, width: number): number {
  if (width <= 0) return t;
  return wrap(t - (dx / width) * SPIN_TURN_S);
}

/** The playhead speed (s per ms) of a drag step, for the fling on release. */
export function dragVelocity(dx: number, width: number, dtMs: number): number {
  if (width <= 0) return 0;
  const v = -((dx / width) * SPIN_TURN_S) / Math.max(dtMs, 1);
  return Math.min(MAX_V, Math.max(-MAX_V, v));
}

/** One frame of coasting: exponential decay, integrated exactly so a long
 *  frame lands where many short ones would. */
export function inertia(t: number, v: number, dtMs: number): { t: number; v: number } {
  const k = Math.exp(-dtMs / TAU);
  const next = v * k;
  return { t: wrap(t + v * TAU * (1 - k)), v: Math.abs(next) < STOP_V ? 0 : next };
}

/** Arrows step 15° the way they point; Home is the front. Null: not ours. */
export function keyToTime(t: number, key: string): number | null {
  switch (key) {
    case "ArrowLeft":
      return wrap(t + KEY_STEP_S);
    case "ArrowRight":
      return wrap(t - KEY_STEP_S);
    case "Home":
      return 0;
    default:
      return null;
  }
}

/** The slow turn of an untouched viewer; none under reduced motion. */
export function idleTurn(t: number, dtMs: number, sinceTouchMs: number, reduced: boolean): number {
  if (reduced || sinceTouchMs < IDLE_AFTER_MS) return t;
  return wrap(t + dtMs * IDLE_RATE);
}

/** Where to seek for time t: the middle of its frame, so rounding never lands
 *  on the neighbour. */
export function frameTime(t: number): number {
  return (Math.floor(wrap(t) * SPIN_FPS) + 0.5) / SPIN_FPS;
}
