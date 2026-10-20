// How myco moves while it roams the screen (spec: docs/specs/
// 2026-10-02-mascot-roam.md, decisions 2, 4 and 6). A pure simulation the
// roam window steps once per frame (components/RoamWindow.tsx): it pops out
// of the notch, travels between the planner's stops (lib/roamPlan) in runs of
// small sprung hops (the 2026-10-04 amendment), pauses at each with a clip that
// fits the job, hops away from a pointer that comes close, and once the work
// is over goes back to the notch's doorstep, lands, and rises out of view
// (the 2026-10-03 amendment: no longer a dive gone in one frame). An
// everyday walk (cue.walk) goes home on its own after its stops.

import { SPRING_PARAMS, springStep } from "./notchMascot";
import type { ClipSpec, MascotKind, Spring } from "./notchMascot";
import type { RoamPlace } from "./ipc";
import { ROAM_MYCO_PX, mycoHome } from "./roam";
import type { RoamCue, RoamFrame, RoamWalk } from "./roam";
import { nextStop, tooClose } from "./roamPlan";
import type { Pt } from "./roamPlan";

/** Where the pop lands and the way home goes in from: under the notch's myco slot,
 *  clear of the open card's bottom edge. */
// ponytail: a fixed 136 px; the open card's real height if it ever grows past it.
export const ROAM_DOOR_Y = 136;
/** Feet this far above the window's top edge: myco is in the notch. */
const IN_NOTCH_Y = -24;
/** A stop holds about one cycle of its clip (49 frames at 12 fps). */
export const STOP_MS = 4100;
/** The breath it takes on the doorstep after the pop. */
const BREATH_MS = 600;
const POP_MS = 320;
/** Going in without a clip: a squash where it landed, then it shrinks and
 *  rises out of view over ENTER_RISE_MS, all in 300–450 ms. With an enter
 *  clip the clip plays where it landed and only its last ENTER_RISE_MS rise. */
const ENTER_MS = 400;
const ENTER_RISE_MS = 280;
/** The procedural squash, as height over width at its deepest. */
const ENTER_SQUASH = 0.7;
/** The compact exit size before the sprite disappears above the window. */
const EXIT_SCALE = 26 / ROAM_MYCO_PX;
/** A walk's stops share its time, less about this much for the hops of each
 *  leg and the hops home from where it stands (travelMs), and never stand
 *  shorter than WALK_STOP_MIN. */
const LEG_MS = 3400;

/** The bouncy hop (the 2026-10-04 amendment, "콩콩"): a leg is a run of
 *  hops about HOP_PX long, HOP_RUN[0]..HOP_RUN[1] of them. */
const HOP_PX = 55;
const HOP_RUN = [2, 8] as const;
/** The longest run: eight hops of 70 px. A longer leg goes in equal runs,
 *  each settling before the next sets out (leave). */
const MAX_RUN = HOP_RUN[1] * 70;
/** A hop, crouch and air, runs HOP_MS[0] at 40 px up to HOP_MS[1] at 70 px. */
const HOP_MS = [260, 340] as const;
/** The anticipation squash before each takeoff. */
const CROUCH_MS = 60;
/** The last landing's spring back, with one small rebound. */
const SETTLE_MS = 300;
/** Heights at the beats: crouch, takeoff, the fall, the landing. */
const SQUASH = 0.8;
const STRETCH = 1.15;
const FALL = 1.06;
const LAND = 0.82;
/** Width per height: 0.8 high is 1.14 wide, 1.15 high is 0.9 wide. */
const WIDTH_PER_HEIGHT = 0.7;
/** In the air, as a share of it: up into the stretch, neutral at the apex,
 *  drawn out a little on the way down. */
const AIR_SY: readonly (readonly [number, number])[] = [
  [0, SQUASH],
  [0.18, STRETCH],
  [0.5, 1],
  [0.85, FALL],
  [1, FALL],
];
const LEAN_DEG = 6;
const CAP_LAG_DEG = 3;
/** The settle's rebound: one ~240 ms swing, down to about a quarter by its
 *  crest. */
const SETTLE_W = (2 * Math.PI) / 240;
const SETTLE_K = Math.log(1 / 0.28) / 120;
/** The highest a hop's feet go: the stretched sprite's top on the window's
 *  top edge. */
const HOP_TOP = ROAM_MYCO_PX * STRETCH;
const WALK_STOP_MIN = 1500;

/** One ballistic arc from `from` to `to`: `lift` is the bump over the straight
 *  line, so the apex sits over the higher end. A run's hop crouches for
 *  `crouch` ms first, from a standstill when `fromRest`, and the last of a
 *  run settles for `settle` ms where it landed. */
export interface Hop {
  from: Pt;
  to: Pt;
  ms: number;
  lift: number;
  crouch?: number;
  settle?: number;
  fromRest?: boolean;
}

/** All of a hop: crouch, air and settle. */
function hopMs(h: Hop): number {
  return (h.crouch ?? 0) + h.ms + (h.settle ?? 0);
}

/** Feet position and vertical speed (px/ms) `t` ms into a hop's air. */
export function hopAt(h: Hop, t: number): Pt & { vy: number } {
  const s = Math.min(1, Math.max(0, t / h.ms));
  const dy = h.to.y - h.from.y;
  return {
    x: h.from.x + (h.to.x - h.from.x) * s,
    y: h.from.y + dy * s - h.lift * 4 * s * (1 - s),
    vy: (dy - h.lift * 4 * (1 - 2 * s)) / h.ms,
  };
}

/** How many hops a run of `d` px takes: about HOP_PX each, 2 to 8. A run is
 *  never longer than MAX_RUN, so its hops stay 40–70 px from 80 px up. */
export function hopCount(d: number): number {
  return Math.min(HOP_RUN[1], Math.max(HOP_RUN[0], Math.round(d / HOP_PX)));
}

function lerp(a: Pt, b: Pt, s: number): Pt {
  return { x: a.x + (b.x - a.x) * s, y: a.y + (b.y - a.y) * s };
}

/** Hop `i` of the `n` that take a leg from `from` to `goal`; the last lands
 *  on `goal` itself. With a hop clip (`clip`, its ms) each hop runs one
 *  cycle of it and settles in the clip, not here. */
export function legHop(from: Pt, goal: Pt, n: number, i: number, clip: number | null): Hop {
  const a = i === 0 ? from : lerp(from, goal, i / n);
  const b = i + 1 >= n ? goal : lerp(from, goal, (i + 1) / n);
  const len = Math.hypot(goal.x - from.x, goal.y - from.y) / n;
  const total =
    clip ?? Math.min(HOP_MS[1], Math.max(HOP_MS[0], HOP_MS[0] + ((len - 40) * (HOP_MS[1] - HOP_MS[0])) / 30));
  // Over the higher end by a small bump, kept under the window's top edge.
  const over = Math.abs(b.y - a.y) / 4;
  const bump = Math.min(10 + len * 0.3, Math.max(0, Math.min(a.y, b.y) - HOP_TOP));
  return {
    from: a,
    to: b,
    crouch: CROUCH_MS,
    ms: total - CROUCH_MS,
    lift: over + bump,
    settle: i + 1 >= n && clip === null ? SETTLE_MS : 0,
    fromRest: i === 0,
  };
}

/** A straight drop with the top end at rest: `|dy| / 4` puts the apex on the
 *  higher end, so the pop falls from a standstill. */
function plumb(from: Pt, to: Pt, ms: number): Hop {
  return { from, to, ms, lift: Math.abs(to.y - from.y) / 4 };
}

/** The clip a stop plays: the job's own, and every third stop a look around.
 *  A walk has no job: it looks around and breathes in turn. */
export function stopAct(job: RoamCue["job"], stop: number): MascotKind {
  if (job === "wander") return stop % 2 === 0 ? "look-around" : "idle";
  if (stop % 3 === 2) return "look-around";
  return job === "read" ? "running" : "saving";
}

export interface RoamSim {
  /** pop: out of the notch; hop: along a leg; stop: playing `act`; enter:
   *  going back in from the doorstep; gone: in the notch, and the window may
   *  order out. */
  phase: "pop" | "hop" | "stop" | "enter" | "gone";
  /** Where it stands, or where the current hop left from. */
  at: Pt;
  hop: Hop | null;
  /** Where this leg ends: the planner's stop, or the doorstep. */
  goal: Pt | null;
  /** The leg's current run: where it set out, where it lands (the goal, or a
   *  share of the way on a long leg), its hop count, and the hop it is on. */
  leg: { from: Pt; to: Pt; n: number; i: number } | null;
  /** ms into the current hop or stop. */
  t: number;
  stopMs: number;
  act: MascotKind;
  /** Stops made: picks the act and seeds the next stop. */
  stops: number;
  /** ms since the pop: a walk spreads what is left of its time. */
  age: number;
  seed: number;
  /** Height stretch, on the mascot's own sy spring; width keeps the volume. */
  sy: Spring;
  /** The shipped enter clip's length, or null: the procedural squash. */
  enterClipMs: number | null;
  /** The shipped hop clip's length, or null: the procedural spring. */
  hopClipMs: number | null;
  /** prefers-reduced-motion, as of the last step: hops slide flat. */
  reduced: boolean;
}

/** What a step reads: the window, the work, and the pointer (window px). */
export interface RoamInput {
  place: RoamPlace;
  cue: RoamCue;
  pointer: Pt | null;
  reduced?: boolean;
}

/** How long a motion library clip runs, or null with none shipped. */
export function clipMs(spec: ClipSpec | null): number | null {
  return spec ? (spec.frames / spec.fps) * 1000 : null;
}

/** Out of the notch: feet at its myco's slot, about to drop. */
export function roamStart(
  place: RoamPlace,
  seed: number,
  enterClip: number | null = null,
  hopClip: number | null = null,
): RoamSim {
  const home = mycoHome(place);
  const at = { x: home.x, y: IN_NOTCH_Y };
  return {
    phase: "pop",
    at,
    hop: plumb(at, { x: home.x, y: ROAM_DOOR_Y }, POP_MS),
    goal: null,
    leg: null,
    t: 0,
    stopMs: 0,
    act: "idle",
    stops: 0,
    age: 0,
    seed,
    sy: { x: 1, v: 0 },
    enterClipMs: enterClip,
    hopClipMs: hopClip,
    reduced: false,
  };
}

function enterMs(sim: RoamSim): number {
  return sim.enterClipMs ?? ENTER_MS;
}

const LAND_KICK = 5;
const STRETCH_PER_SPEED = 0.3;
const MAX_STRETCH = 0.22;

function door(place: RoamPlace): Pt {
  return { x: mycoHome(place).x, y: ROAM_DOOR_Y };
}

function same(a: Pt, b: Pt): boolean {
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;
}

function stand(sim: RoamSim, act: MascotKind, ms: number): RoamSim {
  return { ...sim, phase: "stop", hop: null, goal: null, leg: null, t: 0, act, stopMs: ms };
}

/** The first run of a leg from `from` to `goal`: a leg past MAX_RUN goes in
 *  the fewest equal runs that fit, `runs` of them. */
function firstRun(from: Pt, goal: Pt): { to: Pt; n: number; runs: number } {
  const runs = Math.max(1, Math.ceil(Math.hypot(goal.x - from.x, goal.y - from.y) / MAX_RUN));
  const to = runs > 1 ? lerp(from, goal, 1 / runs) : goal;
  return { to, n: hopCount(Math.hypot(to.x - from.x, to.y - from.y)), runs };
}

/** Off on a leg to `goal`, or on to its next run: the first hop. */
function leave(sim: RoamSim, goal: Pt): RoamSim {
  const { to, n } = firstRun(sim.at, goal);
  const leg = { from: sim.at, to, n, i: 0 };
  return { ...sim, phase: "hop", hop: legHop(sim.at, to, n, 0, sim.hopClipMs), goal, leg, t: 0 };
}

/** The run's next hop, from where the last one landed. */
function hopOn(sim: RoamSim): RoamSim {
  const leg = sim.leg as NonNullable<RoamSim["leg"]>;
  const i = leg.i + 1;
  return {
    ...sim,
    phase: "hop",
    hop: legHop(leg.from, leg.to, leg.n, i, sim.hopClipMs),
    leg: { ...leg, i },
    t: 0,
  };
}

/** Cuts the run short where its hop just landed, now headed for `goal`: that
 *  hop settles on the spot like a run's last one (its squash, the lean easing
 *  out), so nothing turns or stands up in the air. */
function settleHere(sim: RoamSim, goal: Pt): RoamSim {
  const hop = sim.hop as Hop;
  const leg = sim.leg as NonNullable<RoamSim["leg"]>;
  return {
    ...sim,
    phase: "hop",
    hop: { ...hop, settle: sim.hopClipMs === null ? SETTLE_MS : 0 },
    goal,
    leg: { ...leg, to: sim.at, n: leg.i + 1 },
  };
}

/** On to the next stop, away from the pointer. */
function roamOn(sim: RoamSim, input: RoamInput): RoamSim {
  const goal = nextStop(input.place, sim.at, input.pointer, sim.seed + sim.stops);
  return leave(sim, goal);
}

/** How long the hops from `from` to `to` take, settles included. */
function travelMs(from: Pt, to: Pt, clip: number | null): number {
  const { to: end, n, runs } = firstRun(from, to);
  const last = legHop(from, end, n, n - 1, clip);
  return runs * (n * ((last.crouch ?? 0) + last.ms) + (last.settle ?? 0));
}

/** How long the next stop of a walk stands: what is left of the walk, shared
 *  among the stops left. */
function walkStopMs(walk: RoamWalk, sim: RoamSim, doorstep: Pt): number {
  const left = Math.max(1, walk.stops - sim.stops);
  const home = travelMs(sim.at, doorstep, sim.hopClipMs) + enterMs(sim);
  const spare = walk.ms - sim.age - home - (left - 1) * LEG_MS;
  return Math.max(WALK_STOP_MIN, spare / left);
}

/** A walk that has made all its stops, or is out of time for the hops home
 *  from where it is, ends like done work. Small hops are slow, so on long
 *  legs time wins over the stop count, as the notch's own deadline would. */
function walked(sim: RoamSim, input: RoamInput): boolean {
  const { walk, outcome } = input.cue;
  if (walk === undefined || outcome !== null) return false;
  const home = travelMs(sim.at, door(input.place), sim.hopClipMs) + enterMs(sim);
  return sim.stops >= walk.stops || sim.age + home >= walk.ms;
}

/** Landed at `sim.at` (`sim.hop` the hop that landed, if any): what comes
 *  next. */
function arrive(sim: RoamSim, input: RoamInput): RoamSim {
  const { cue } = input;
  const doorstep = door(input.place);
  const goal = sim.goal;
  const midLeg = sim.leg !== null && sim.leg.i + 1 < sim.leg.n;
  if (cue.outcome !== null) {
    const homeward = goal !== null && same(goal, doorstep);
    // Already on the way home: the run goes on to the doorstep.
    if (midLeg && homeward) return hopOn(sim);
    if (same(sim.at, doorstep)) {
      return { ...sim, phase: "enter", hop: null, goal: null, leg: null, t: 0 };
    }
    // Turned back mid-run: this hop lands and settles first.
    if (midLeg) return settleHere(sim, doorstep);
    if (cue.outcome === "failed" && sim.act !== "rejected") return stand(sim, "rejected", STOP_MS);
    return leave(sim, doorstep);
  }
  if (sim.phase === "pop") return stand(sim, "idle", BREATH_MS);
  if (goal !== null && (midLeg || !same(sim.at, goal))) {
    // Every landing looks for the pointer: near it, or it on the goal, and
    // the run settles here and sets off for a stop clear of it.
    if (tooClose(sim.at, input.pointer) || tooClose(goal, input.pointer)) {
      if (!midLeg) return roamOn(sim, input);
      return settleHere(sim, nextStop(input.place, sim.at, input.pointer, sim.seed + sim.stops));
    }
    return midLeg ? hopOn(sim) : leave(sim, goal);
  }
  const ms = cue.walk ? walkStopMs(cue.walk, sim, doorstep) : STOP_MS;
  return { ...stand(sim, stopAct(cue.job, sim.stops), ms), stops: sim.stops + 1 };
}

/** One frame, `dt` ms long. */
export function roamTick(sim: RoamSim, dt: number, input: RoamInput): RoamSim {
  if (sim.phase === "gone") return sim;
  const step = Math.min(dt, 50);
  const t = sim.t + step;
  if (sim.phase === "enter") {
    // Work that started while a walk was going in takes the walk over: myco
    // stands back up on the doorstep and roams on, rather than going in only
    // to be sent out again.
    if (input.cue.outcome === null && !walked(sim, input)) {
      return { ...stand(sim, "idle", BREATH_MS), sy: { x: 1, v: 0 } };
    }
    // Otherwise going in finishes with the sprite above the window; no
    // resting mascot replaces it on the menu bar.
    const ms = enterMs(sim);
    return t >= ms ? { ...sim, phase: "gone", t: ms } : { ...sim, t, age: sim.age + step };
  }
  // Only the pop rides the spring; a run's hops shape themselves (hopFrame).
  const air = sim.hop && sim.phase === "pop" ? hopAt(sim.hop, t) : null;
  const target = air ? 1 + Math.min(MAX_STRETCH, Math.abs(air.vy) * STRETCH_PER_SPEED) : 1;
  let next: RoamSim = {
    ...sim,
    t,
    age: sim.age + step,
    sy: springStep(sim.sy, target, step / 1000, SPRING_PARAMS.sy),
    reduced: input.reduced ?? false,
  };
  // A walk past its last stop heads home the way done work does, once that
  // stop has stood its time.
  const home: RoamInput = walked(sim, input)
    ? { ...input, cue: { ...input.cue, outcome: "done" } }
    : input;

  if (next.phase === "stop") {
    if (input.cue.outcome !== null) {
      // A failure's head shake plays out where it stands; anything else
      // that ended turns back at once.
      return next.act === "rejected" && t < next.stopMs ? next : arrive(next, input);
    }
    if (tooClose(next.at, input.pointer)) return roamOn(next, input);
    if (t < next.stopMs) return next;
    return home === input ? roamOn(next, input) : arrive(next, home);
  }

  const hop = next.hop as Hop;
  if (t < hopMs(hop)) return next;
  // Landed where the arc ends; the pop with a squash on the spring.
  const kick = next.phase === "pop" ? LAND_KICK : 0;
  next = { ...next, at: hop.to, sy: { x: next.sy.x, v: next.sy.v - kick } };
  return arrive(next, home);
}

/** Going in from the doorstep `t` ms on: a squash where it stands (none
 *  under a clip, which carries its own), then a smoothstep rise and shrink
 *  that ends above mycoHome at the window's top edge, out of view. */
function enterFrame(sim: RoamSim): Pick<RoamFrame, "x" | "y" | "sx" | "sy"> {
  const rise = Math.min(ENTER_RISE_MS, enterMs(sim));
  const hold = enterMs(sim) - rise;
  const squash = sim.enterClipMs === null ? ENTER_SQUASH : 1;
  if (sim.t < hold) {
    // The hop's own landing squash is folded in: down to `squash`, eased.
    const r = 1 - (1 - squash) * Math.sin((Math.min(1, sim.t / hold) * Math.PI) / 2);
    return { x: sim.at.x, y: sim.at.y, sx: 1 / Math.sqrt(r), sy: Math.sqrt(r) };
  }
  const q = Math.min(1, (sim.t - hold) / rise);
  const e = q * q * (3 - 2 * q);
  const s = 1 + (EXIT_SCALE - 1) * e;
  const r = squash + (1 - squash) * e;
  return { x: sim.at.x, y: sim.at.y * (1 - e), sx: s / Math.sqrt(r), sy: s * Math.sqrt(r) };
}

/** Linear between `keys`' (share, value) beats. */
function keyed(keys: readonly (readonly [number, number])[], s: number): number {
  let i = 1;
  while (i < keys.length - 1 && s > keys[i][0]) i++;
  const [s0, v0] = keys[i - 1];
  const [s1, v1] = keys[i];
  return v0 + (v1 - v0) * Math.min(1, Math.max(0, (s - s0) / (s1 - s0)));
}

/** A run's hop `t` ms in: crouch where it stands, the arc (parabolic in y,
 *  linear in x), then on the last a settle on the spot. Reduced motion
 *  slides it flat at an even pace; a hop clip carries its own squash. */
function hopFrame(sim: RoamSim, h: Hop): Pick<RoamFrame, "x" | "y" | "groundY" | "sx" | "sy" | "lean" | "lag"> {
  const t = sim.t;
  const crouch = h.crouch ?? 0;
  if (sim.reduced) {
    const p = lerp(h.from, h.to, Math.min(1, t / (crouch + h.ms)));
    return { ...p, groundY: p.y, sx: 1, sy: 1, lean: 0, lag: 0 };
  }
  const len = Math.hypot(h.to.x - h.from.x, h.to.y - h.from.y);
  const ux = len > 0 ? (h.to.x - h.from.x) / len : 0;
  let p: Pt = h.from;
  let sy: number;
  let tilt = 1;
  let lag = 0;
  let groundY = h.from.y;
  if (t < crouch) {
    const q = t / crouch;
    // From a standstill it eases down; mid-run the landing flows into it.
    sy = h.fromRest ? 1 + (SQUASH - 1) * q * q * (3 - 2 * q) : LAND + (SQUASH - LAND) * q;
    if (h.fromRest) tilt = q;
  } else if (t < crouch + h.ms) {
    const s = (t - crouch) / h.ms;
    p = hopAt(h, t - crouch);
    groundY = h.from.y + (h.to.y - h.from.y) * s;
    sy = keyed(AIR_SY, s);
    lag = CAP_LAG_DEG * ux * Math.sin(Math.PI * s);
  } else {
    const q = t - crouch - h.ms;
    p = h.to;
    groundY = h.to.y;
    sy = 1 - (1 - LAND) * Math.exp(-SETTLE_K * q) * Math.cos(SETTLE_W * q);
    tilt = Math.max(0, 1 - q / SETTLE_MS);
  }
  if (sim.hopClipMs !== null) {
    sy = 1;
    lag = 0;
  }
  return { x: p.x, y: p.y, groundY, sx: 1 - WIDTH_PER_HEIGHT * (sy - 1), sy, lean: LEAN_DEG * ux * tilt, lag };
}

/** What the roam window draws for `sim`. */
export function roamFrame(sim: RoamSim, cue: RoamCue): RoamFrame {
  if (sim.phase === "enter" || sim.phase === "gone") {
    return { ...enterFrame(sim), groundY: sim.at.y, act: "enter", progress: null };
  }
  const progress = cue.outcome === null ? cue.progress : null;
  if (sim.phase === "hop" && sim.hop) return { ...hopFrame(sim, sim.hop), act: "hop", progress };
  const p = sim.phase === "pop" && sim.hop ? hopAt(sim.hop, sim.t) : sim.at;
  const sy = Math.min(1.3, Math.max(0.72, sim.sy.x));
  return {
    x: p.x,
    y: p.y,
    groundY: sim.phase === "pop" && sim.hop ? sim.hop.to.y : p.y,
    act: sim.phase === "stop" ? sim.act : "idle",
    sx: 1 / sy,
    sy,
    progress,
  };
}
