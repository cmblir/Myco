// The notch mascot's rules, kept pure so they are testable without a DOM
// (spec: docs/specs/2026-10-02-notch-mascot.md). components/NotchMascot.tsx
// renders what these return: a pose layer, SVG eyes over it, and one spring
// transform on the whole sprite. Nothing here touches the DOM or a clock.

import anchors from "../assets/mascot/notch/anchors.json";
import type { NotchState } from "../components/NotchPanel";

export const MASCOT_POSES = ["resting", "reading", "thinking", "attention", "success"] as const;
export type MascotPose = (typeof MASCOT_POSES)[number];

/** What the drawn eyes do. Blinking and look-at ride on top of `open`/`wide`. */
export type EyeMode = "open" | "wide" | "squint" | "spiral" | "closed";
/** Ambient motion, all CSS (compositor-run, no JS frames). */
export type MascotLoop = "breathe" | "bob" | "listen";
/** One spring kick on entering a state or reacting to a click. */
export type MascotImpulse = "hello" | "gulp" | "hop" | "sigh" | "shake" | "squish";

/**
 * The notch's clips from the motion library
 * (docs/specs/2026-10-02-mascot-motion-library.md): the pose a clip's first and
 * last frame show, the eyes its first frame opens on and its last frame ends
 * on, and whether it loops. A
 * one-shot ends on the pose its state holds next, so the hand-off to the still
 * does not jump; a loop ends where it starts. Read off the shipped strips
 * (assets/mascot/README.md). sigh is not here: it runs 4.1 s and cancelled
 * says so for 800 ms, so the driver folded it at frame 9, mid-inhale with open
 * eyes. Nor is listen: its retake listens on attention, but with its own glow
 * baked in, and recording keeps its attention still and the cap glow that
 * follows the voice (decision 3). Nor is hello: a clip stands the drawn eyes
 * down, so over the peek the cursor moved nothing for its 4.1 s, and its face
 * turns and tilts as it waves, so drawn eyes cannot sit on it. The peek waves
 * its procedural kick under eyes that follow the cursor.
 */
export const CLIP_LIBRARY = {
  "read-loop": { from: "reading", to: "reading", start: "open", end: "open", loop: true },
  doze: { from: "resting", to: "resting", start: "closed", end: "closed", loop: true },
  wake: { from: "resting", to: "attention", start: "closed", end: "open", loop: false },
  think: { from: "thinking", to: "thinking", start: "open", end: "open", loop: true },
  "shake-no": { from: "attention", to: "attention", start: "open", end: "open", loop: false },
  gulp: { from: "attention", to: "success", start: "open", end: "open", loop: false },
  celebrate: { from: "success", to: "success", start: "open", end: "open", loop: false },
  // Roam stops only (docs/specs/2026-10-02-mascot-roam.md): no notch state
  // plays it.
  "look-around": { from: "attention", to: "attention", start: "open", end: "open", loop: true },
  // Roam only, on the way home (the 2026-10-03 amendment): it lands on the
  // idle still and ends on the wing's idle pose. Not shipped yet; until its
  // pair lands in assets/mascot/motion/, lib/roamMotion squashes procedurally.
  enter: { from: "resting", to: "resting", start: "open", end: "open", loop: false },
  // Roam only, one cycle per hop between stops (the 2026-10-04 amendment). Not
  // shipped yet; until its pair lands, lib/roamMotion springs each hop itself.
  hop: { from: "resting", to: "resting", start: "open", end: "open", loop: true },
} as const satisfies Record<
  string,
  { from: MascotPose; to: MascotPose; start: EyeMode; end: EyeMode; loop: boolean }
>;
export type MascotClipName = keyof typeof CLIP_LIBRARY;

export interface MascotBehaviour {
  pose: MascotPose;
  /** Held for `enterMs` before `pose` takes over (accepted: catch, then glow). */
  enterPose?: MascotPose;
  enterMs?: number;
  eyes: EyeMode;
  blink: boolean;
  /** Eyes follow the cursor. */
  track: boolean;
  loop: MascotLoop;
  impulse: MascotImpulse | null;
  /** Static lean toward the content side, in degrees. */
  lean: number;
  /** Cap-underside glow, 0..1; `listen` drives it from the voice level. */
  glow: number;
  /** krea.ai clip that replaces the pose layer while it plays, if shipped. */
  clip: MascotClipName | null;
  /** The pose's detached props: bubbles bob, sparkles twinkle once. */
  fx: "bob" | "twinkle" | null;
}

const BASE: MascotBehaviour = {
  pose: "resting",
  eyes: "open",
  blink: true,
  track: false,
  loop: "breathe",
  impulse: null,
  lean: 0,
  glow: 0,
  clip: null,
  fx: null,
};

/** What the mascot is doing: a notch state, or a roam-only act out of the
 *  notch (lib/roam's RoamFrame): a stop's look around, a hop between stops,
 *  or going home. */
export type MascotKind = NotchState["kind"] | "look-around" | "enter" | "hop";

/** Decision 3: myco's states in coucou's grammar. */
export function mascotBehaviour(kind: MascotKind): MascotBehaviour {
  switch (kind) {
    case "idle":
      return BASE;
    case "peek":
      return { ...BASE, pose: "attention", track: true, impulse: "hello" };
    case "dragging":
      return { ...BASE, pose: "attention", eyes: "wide", lean: 9, glow: 1 };
    case "accepted":
      return {
        ...BASE,
        pose: "success",
        enterPose: "attention",
        enterMs: 450,
        impulse: "gulp",
        glow: 0.6,
        clip: "gulp",
        fx: "twinkle",
      };
    case "running":
      return { ...BASE, pose: "reading", loop: "bob", glow: 0.4, clip: "read-loop" };
    case "done":
      return { ...BASE, pose: "success", impulse: "hop", glow: 0.4, clip: "celebrate", fx: "twinkle" };
    case "captured":
      // S7's saved line: the same green outcome as done, a smaller cheer.
      return { ...BASE, pose: "success", impulse: "hop", fx: "twinkle" };
    case "capture":
      return { ...BASE, pose: "attention", glow: 0.6 };
    case "recording":
      return { ...BASE, pose: "attention", loop: "listen", glow: 0.35 };
    case "saving":
      return { ...BASE, pose: "thinking", loop: "bob", glow: 0.3, clip: "think", fx: "bob" };
    case "cancelled":
      return { ...BASE, eyes: "closed", blink: false, impulse: "sigh" };
    case "rejected":
    case "failed":
      return {
        ...BASE,
        pose: "attention",
        eyes: "squint",
        blink: false,
        impulse: "shake",
        clip: "shake-no",
      };
    case "look-around":
      return { ...BASE, pose: "attention", clip: "look-around" };
    case "enter":
      return { ...BASE, clip: "enter" };
    case "hop":
      return { ...BASE, clip: "hop" };
  }
}

/** Click = annoyed squish; triple-click = dizzy. They override the state's
 *  eyes for `ms`, then the state's own behaviour returns. */
export const REACTIONS = {
  poke: { eyes: "squint", impulse: "squish", ms: 600 },
  dizzy: { eyes: "spiral", impulse: "shake", ms: 2500 },
} as const satisfies Record<string, { eyes: EyeMode; impulse: MascotImpulse; ms: number }>;

// ---- Eyes -------------------------------------------------------------------

/** One eye at rest, in 0..1 units of the layer's square crop. */
export interface EyeAnchor {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  /** Resting's own closed crescent, where the sheet drew one. */
  arc?: { rx: number; ry: number };
}

interface PoseAnchors {
  eyes: EyeAnchor[];
  closed: boolean;
  glow: { cx: number; cy: number; w: number; h: number };
  fx: boolean;
}

const POSE_ANCHORS = anchors.poses as Record<MascotPose, PoseAnchors>;

/** The two eyes, left to right, measured from the pose by gen-notch-mascot.py. */
export function eyesFor(pose: MascotPose): readonly EyeAnchor[] {
  return POSE_ANCHORS[pose].eyes;
}

export function glowFor(pose: MascotPose): PoseAnchors["glow"] {
  return POSE_ANCHORS[pose].glow;
}

export function hasFx(pose: MascotPose): boolean {
  return POSE_ANCHORS[pose].fx;
}

/** How far an eye may travel from its rest centre: eyes on a sphere move
 *  sideways more than up and down. In crop units, from the eye's radii. */
export function socketFor(eye: EyeAnchor): { rx: number; ry: number } {
  return { rx: eye.rx * 1.6, ry: eye.ry * 0.6 };
}

/**
 * Where the eyes look. (x, y) is the cursor relative to the eyes' midpoint in
 * crop units (1 = one mascot width). Distance saturates — a cursor one width
 * away gets half the travel, a far one nearly all — and the result is clamped
 * inside the socket ellipse. Anything non-finite looks straight ahead.
 */
export function lookOffset(
  x: number,
  y: number,
  socket: { rx: number; ry: number },
): { dx: number; dy: number } {
  const d = Math.hypot(x, y);
  if (!Number.isFinite(d) || d === 0) return { dx: 0, dy: 0 };
  const reach = d / (d + 1);
  let dx = (x / d) * reach * socket.rx;
  let dy = (y / d) * reach * socket.ry;
  const e = (dx / socket.rx) ** 2 + (dy / socket.ry) ** 2;
  if (e > 1) {
    const k = 1 / Math.sqrt(e);
    dx *= k;
    dy *= k;
  }
  return { dx, dy };
}

/**
 * What `lookOffset` takes, from a pointer in the webview's client coordinates:
 * the pointer relative to the eyes' midpoint (`mid`, crop units), in mascot
 * widths. The DOM's pointermove and notch.rs's panel-local feed share these
 * coordinates, so both land here. No layout box yet = look straight ahead.
 */
export function pointerAim(
  px: number,
  py: number,
  box: { left: number; top: number; width: number; height: number },
  mid: { x: number; y: number },
): { x: number; y: number } {
  if (!(box.width > 0 && box.height > 0)) return { x: 0, y: 0 };
  return {
    x: (px - (box.left + mid.x * box.width)) / box.width,
    y: (py - (box.top + mid.y * box.height)) / box.height,
  };
}

/** Cap-underside glow while recording: a soft rest, brighter with the voice.
 *  Same ×5 gain VoiceWave uses (speech sits at ~0.05–0.2 RMS). */
export function glowFromLevel(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) return 0.35;
  return Math.min(1, 0.35 + 0.65 * Math.min(1, rms * 5));
}

// ---- Blink ------------------------------------------------------------------

/** mulberry32: a tiny seeded PRNG, so a blink schedule (and a roam's stops,
 *  lib/roamPlan) is reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BLINKS_PER_CYCLE = 5;

/** Milliseconds between blinks, 3–7 s each, for one repeating cycle. */
export function blinkGaps(seed: number): number[] {
  const rand = mulberry32(seed);
  return Array.from({ length: BLINKS_PER_CYCLE }, () => Math.round(3000 + rand() * 4000));
}

/**
 * The blink cycle as Web Animations keyframes on the eyes' scaleY: handed to
 * `element.animate(…, { iterations: Infinity })` it runs on the compositor
 * with no JS timer. Each blink is centred `LEAD` ms before the end of its gap,
 * so every interval — the wrap-around included — is exactly one gap.
 */
export function blinkKeyframes(seed: number): { keyframes: Keyframe[]; duration: number } {
  const gaps = blinkGaps(seed);
  const duration = gaps.reduce((a, b) => a + b, 0);
  const LEAD = 200;
  const HALF = 70; // a blink is ~140 ms, lid down and up
  const open = "scaleY(1)";
  const keyframes: Keyframe[] = [{ offset: 0, transform: open }];
  let t = 0;
  for (const gap of gaps) {
    t += gap;
    const at = t - LEAD;
    keyframes.push(
      { offset: (at - HALF) / duration, transform: open },
      { offset: at / duration, transform: "scaleY(0.1)" },
      { offset: (at + HALF) / duration, transform: open },
    );
  }
  keyframes.push({ offset: 1, transform: open });
  return { keyframes, duration };
}

// ---- Springs ----------------------------------------------------------------

export interface Spring {
  x: number;
  v: number;
}
export interface SpringParams {
  stiffness: number;
  damping: number;
}

/**
 * One step of a unit-mass damped spring toward `target`, solved in closed
 * form rather than integrated: exact for any `dt`, so a long frame (a
 * backgrounded window resuming) can never blow it up, and energy only falls.
 */
export function springStep(s: Spring, target: number, dt: number, p: SpringParams): Spring {
  const y0 = s.x - target;
  const v0 = s.v;
  const w0 = Math.sqrt(p.stiffness);
  const zeta = p.damping / (2 * w0);
  if (Math.abs(zeta - 1) < 1e-6) {
    const b = v0 + w0 * y0;
    const e = Math.exp(-w0 * dt);
    return { x: target + (y0 + b * dt) * e, v: (b - w0 * (y0 + b * dt)) * e };
  }
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    const a = y0;
    const b = (v0 + zeta * w0 * y0) / wd;
    const e = Math.exp(-zeta * w0 * dt);
    const c = Math.cos(wd * dt);
    const sn = Math.sin(wd * dt);
    return {
      x: target + e * (a * c + b * sn),
      v: e * ((b * wd - zeta * w0 * a) * c - (a * wd + zeta * w0 * b) * sn),
    };
  }
  const root = Math.sqrt(zeta * zeta - 1);
  const r1 = -w0 * (zeta - root);
  const r2 = -w0 * (zeta + root);
  const c1 = (v0 - r2 * y0) / (r1 - r2);
  const c2 = y0 - c1;
  const e1 = Math.exp(r1 * dt);
  const e2 = Math.exp(r2 * dt);
  return { x: target + c1 * e1 + c2 * e2, v: c1 * r1 * e1 + c2 * r2 * e2 };
}

/** The sprite's transform channels: translate (crop units), scale, rotate (deg). */
export type MascotChannel = "x" | "y" | "sx" | "sy" | "r";
export type MascotSprings = Record<MascotChannel, Spring>;
export type MascotTargets = Record<MascotChannel, number>;

export const SPRING_REST: MascotTargets = { x: 0, y: 0, sx: 1, sy: 1, r: 0 };

/** Bouncy for squash and hops, looser for the head shake. */
export const SPRING_PARAMS: Record<MascotChannel, SpringParams> = {
  x: { stiffness: 380, damping: 7 },
  y: { stiffness: 260, damping: 14 },
  sx: { stiffness: 420, damping: 13 },
  sy: { stiffness: 420, damping: 13 },
  r: { stiffness: 300, damping: 10 },
};

/** Velocity kicks per impulse. Scale is volume-kept: squash one axis, the
 *  other bulges. Translations are fractions of the mascot's size. */
export const IMPULSES: Record<MascotImpulse, Partial<MascotTargets>> = {
  hello: { r: -160 },
  gulp: { sy: -5, sx: 4, y: 0.6 },
  hop: { y: -1.6, sy: 3, sx: -2 },
  sigh: { y: 0.7, sy: -1.6, sx: 1 },
  shake: { x: 2.2 },
  squish: { sy: -7, sx: 5.5 },
};

export function kick(s: MascotSprings, impulse: MascotImpulse): MascotSprings {
  const next = { ...s };
  for (const [ch, dv] of Object.entries(IMPULSES[impulse]) as [MascotChannel, number][]) {
    next[ch] = { x: s[ch].x, v: s[ch].v + dv };
  }
  return next;
}

export function stepAll(s: MascotSprings, t: MascotTargets, dt: number): MascotSprings {
  const next = {} as MascotSprings;
  for (const ch of Object.keys(s) as MascotChannel[]) {
    next[ch] = springStep(s[ch], t[ch], dt, SPRING_PARAMS[ch]);
  }
  return next;
}

/** The drawn eyes' look-at offset (crop units), one spring per axis. */
export interface Look {
  x: Spring;
  y: Spring;
}
export const LOOK_REST: Look = { x: { x: 0, v: 0 }, y: { x: 0, v: 0 } };
const LOOK_SPRING: SpringParams = { stiffness: 170, damping: 22 };

/**
 * One frame of the look-at spring toward `aim` (lookOffset's). With no eyes
 * drawn (a clip carries its own) there is nothing to aim and it holds straight
 * ahead: run on unseen, it settled on the pointer, and the eyes a clip handed
 * back to jumped there in one frame.
 */
export function lookStep(look: Look, aim: { dx: number; dy: number } | null, dt: number): Look {
  if (!aim) return LOOK_REST;
  return {
    x: springStep(look.x, aim.dx, dt, LOOK_SPRING),
    y: springStep(look.y, aim.dy, dt, LOOK_SPRING),
  };
}

/** True once every channel is at rest — the point where the rAF stops. */
export function settled(s: MascotSprings, t: MascotTargets): boolean {
  return (Object.keys(s) as MascotChannel[]).every(
    (ch) => Math.abs(s[ch].x - t[ch]) < 2e-3 && Math.abs(s[ch].v) < 2e-2,
  );
}

// ---- Clips ------------------------------------------------------------------

export interface ClipSpec {
  url: string;
  frames: number;
  fps: number;
  loop: boolean;
  /** Room each frame has around the pose box, as a fraction of that box on
   *  every side: hops and falling props leave the pose box. 0 = none. */
  pad: number;
}

function byName(modules: Record<string, unknown>, file: string): unknown {
  const key = Object.keys(modules).find((k) => k.endsWith(`/${file}`));
  return key === undefined ? undefined : modules[key];
}

/**
 * A clip's sprite strip and manifest, from Vite's eager globs over
 * assets/mascot/motion/. Null — and the pose layer stays — whenever either
 * half is missing or the manifest is not `{ frames, fps, loop, pad? }` with
 * sane numbers: clips land later, one by one, and an absent one is not an
 * error.
 */
export function resolveClip(
  name: MascotClipName,
  manifests: Record<string, unknown>,
  urls: Record<string, unknown>,
): ClipSpec | null {
  let m = byName(manifests, `${name}.json`);
  if (m && typeof m === "object" && "default" in m) m = (m as { default: unknown }).default;
  const url = byName(urls, `${name}.webp`);
  if (typeof url !== "string" || !m || typeof m !== "object") return null;
  const { frames, fps, loop, pad = 0 } = m as Record<string, unknown>;
  if (typeof frames !== "number" || !Number.isInteger(frames) || frames < 1 || frames > 600) {
    return null;
  }
  if (typeof fps !== "number" || !(fps >= 1 && fps <= 60)) return null;
  if (typeof loop !== "boolean") return null;
  if (typeof pad !== "number" || !(pad >= 0 && pad < 0.5)) return null;
  return { url, frames, fps, loop, pad };
}

/**
 * Where a strip frame is drawn, in units of the pose box (0..1 = the box): a
 * frame carries `pad` of the box on every side, so it is drawn (1 + 2·pad)×
 * the box and centred on it. The pose crop inside the frame then lands on the
 * box exactly and the character keeps the still pose's scale; the padding
 * hangs outside, where nothing may clip it.
 */
export function clipFrame(pad: number): { x: number; y: number; size: number } {
  return { x: -pad, y: -pad, size: 1 + 2 * pad };
}

// ---- Clip runs --------------------------------------------------------------

/** Collapsed idle with nothing happening this long dozes off. */
export const DOZE_AFTER_MS = 90_000;

/** The clips one state plays, in order, and how far it has got: `at` is the
 *  clip on screen, and `clips.length` once all are through and the still
 *  holds. */
export interface ClipRun {
  kind: MascotKind;
  clips: readonly MascotClipName[];
  at: number;
}

/** Entering `kind`: its own clip, except that a peek which finds the mascot
 *  dozing wakes it first, then plays the peek's own clip if it has one. */
export function enterRun(prev: ClipRun | null, kind: MascotKind): ClipRun {
  const dozing = prev !== null && prev.clips[prev.at] === "doze";
  const own = mascotBehaviour(kind).clip;
  const clips: MascotClipName[] = [
    ...(kind === "peek" && dozing ? (["wake"] as const) : []),
    ...(own ? [own] : []),
  ];
  return { kind, clips, at: 0 };
}

/** Whether the doze clock runs: idle (always collapsed), not dozing yet, on
 *  screen, and motion welcome. Hidden, no timer runs at all. */
export function dozeArmed(run: ClipRun, reduced: boolean, visible: boolean): boolean {
  return run.kind === "idle" && run.clips.length === 0 && !reduced && visible;
}

/** The strips to decode now: what the run has still to play, and while it
 *  dozes the clips a peek would open with, so the first wake does not wait on
 *  its decode. */
export function clipsAhead(run: ClipRun): MascotClipName[] {
  const ahead = run.clips.slice(run.at);
  return run.clips[run.at] === "doze" ? [...ahead, ...enterRun(run, "peek").clips] : ahead;
}

/** The doze clock ran out: idle loops the doze clip. Anything else is awake. */
export function dozeOff(run: ClipRun): ClipRun {
  return run.kind === "idle" ? { kind: "idle", clips: ["doze"], at: 0 } : run;
}

/**
 * The clip to show now: the first from `at` that resolves, so a missing clip
 * is skipped (no wake still plays what follows) and a run with none shipped
 * shows the still. Reduced motion and a hidden window play nothing.
 */
export function clipNow(
  run: ClipRun,
  resolve: (name: MascotClipName) => ClipSpec | null,
  reduced: boolean,
  visible: boolean,
): { index: number; name: MascotClipName; spec: ClipSpec } | null {
  if (reduced || !visible) return null;
  for (let index = run.at; index < run.clips.length; index++) {
    const name = run.clips[index];
    const spec = resolve(name);
    if (spec) return { index, name, spec };
  }
  return null;
}

/** Clip `index` ended (played through, or failed to load): on to the next.
 *  A late end from a clip already left behind changes nothing. */
export function clipEnded(run: ClipRun, index: number): ClipRun {
  return index + 1 > run.at ? { ...run, at: index + 1 } : run;
}

/**
 * The still once a clip has handed back keeps the clip's last frame: its end
 * pose (the state's own, by CLIP_LIBRARY) and its eyes — rejected's squint is
 * the procedural shake's, and snapping to it after shake-no would jump. What
 * the clip already did (accepted's catch, the sparkles' entrance) is not done
 * again. Before any clip has ended, the state's own still.
 */
export function stillAfter(b: MascotBehaviour, run: ClipRun): MascotBehaviour {
  const played = run.at > 0 ? run.clips[run.at - 1] : undefined;
  if (!played) return b;
  const { to, end } = CLIP_LIBRARY[played];
  return {
    ...b,
    pose: to,
    enterPose: undefined,
    enterMs: undefined,
    eyes: end,
    blink: end === "open",
    fx: b.fx === "twinkle" ? null : b.fx,
  };
}

/**
 * The still while a clip is due but its strip has not decoded: the pose and
 * eyes the clip opens on, so however long the decode takes the clip starts
 * without a jump (wake opens resting with its eyes closed, not on the peek's
 * open-eyed attention). No blink cycle starts for the frame or two it shows.
 */
export function stillBefore(b: MascotBehaviour, name: MascotClipName): MascotBehaviour {
  const { from, start } = CLIP_LIBRARY[name];
  return { ...b, pose: from, enterPose: undefined, enterMs: undefined, eyes: start, blink: false };
}
