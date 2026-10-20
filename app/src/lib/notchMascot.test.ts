// The notch mascot's pure parts: which pose/eyes/motion/clip each notch state
// gets, where the drawn eyes sit and how far they may look, when they blink,
// the spring that drives every kick, and the clip manifest that must fall back
// to the pose when a clip is missing. Node-only, like every test here.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  CLIP_LIBRARY,
  DOZE_AFTER_MS,
  MASCOT_POSES,
  REACTIONS,
  blinkKeyframes,
  blinkGaps,
  clipEnded,
  clipsAhead,
  clipFrame,
  clipNow,
  dozeArmed,
  dozeOff,
  enterRun,
  eyesFor,
  glowFromLevel,
  LOOK_REST,
  lookOffset,
  lookStep,
  mascotBehaviour,
  pointerAim,
  resolveClip,
  settled,
  springStep,
  stillAfter,
  stillBefore,
  type ClipRun,
  type ClipSpec,
  type MascotClipName,
  type MascotSprings,
} from "./notchMascot";
import { MOCK_FRAMES, type NotchState } from "../components/NotchPanel";
import { dwellMsFor } from "./notchDriver";

const KINDS: NotchState["kind"][] = [
  "idle",
  "peek",
  "dragging",
  "accepted",
  "running",
  "done",
  "capture",
  "captured",
  "recording",
  "saving",
  "cancelled",
  "rejected",
];

describe("mascotBehaviour — decision 3's table", () => {
  it("gives every notch state a pose from the character sheet", () => {
    for (const kind of KINDS) {
      expect(MASCOT_POSES).toContain(mascotBehaviour(kind).pose);
    }
    // The mock walk only uses kinds the table knows.
    for (const f of MOCK_FRAMES) expect(KINDS).toContain(f.state.kind);
  });

  it("maps the sheet's rows, with the motion library's clip for each state", () => {
    const row = (k: NotchState["kind"]) => {
      const b = mascotBehaviour(k);
      return [b.pose, b.eyes, b.loop, b.impulse, b.clip];
    };
    expect(row("idle")).toEqual(["resting", "open", "breathe", null, null]);
    // The peek holds attention, where wake hands over, and waves its
    // procedural hello under eyes that follow the cursor.
    expect(row("peek")).toEqual(["attention", "open", "breathe", "hello", null]);
    expect(row("dragging")).toEqual(["attention", "wide", "breathe", null, null]);
    expect(row("accepted")).toEqual(["success", "open", "breathe", "gulp", "gulp"]);
    expect(row("running")).toEqual(["reading", "open", "bob", null, "read-loop"]);
    expect(row("done")).toEqual(["success", "open", "breathe", "hop", "celebrate"]);
    expect(row("capture")[0]).toBe("attention");
    expect(row("captured")[4]).toBeNull();
    expect(row("recording")).toEqual(["attention", "open", "listen", null, null]);
    expect(row("saving")).toEqual(["thinking", "open", "bob", null, "think"]);
    expect(row("cancelled")).toEqual(["resting", "closed", "breathe", "sigh", null]);
    expect(row("rejected")).toEqual(["attention", "squint", "breathe", "shake", "shake-no"]);
  });

  it("accepted catches as attention, then settles to success", () => {
    const b = mascotBehaviour("accepted");
    expect(b.enterPose).toBe("attention");
    expect(b.enterMs).toBeGreaterThan(0);
    expect(b.fx).toBe("twinkle");
  });

  it("only the hovered peek follows the cursor; dragging leans and glows", () => {
    expect(KINDS.filter((k) => mascotBehaviour(k).track)).toEqual(["peek"]);
    const drag = mascotBehaviour("dragging");
    expect(drag.lean).toBeGreaterThan(0);
    expect(drag.glow).toBe(1);
  });

  it("a looping clip only where the state itself is ongoing work", () => {
    // A one-shot victory dance on repeat reads as a nag (MascotClip's rule).
    const looping = KINDS.filter((k) => {
      const clip = mascotBehaviour(k).clip;
      return clip !== null && CLIP_LIBRARY[clip].loop;
    });
    expect(looping).toEqual(["running", "saving"]);
  });

  it("out of the notch it also looks around: attention, on its own loop", () => {
    // Roam-only (docs/specs/2026-10-02-mascot-roam.md, decision 4): a stop
    // between the job's own clips. The clip turns the face, so no drawn eyes
    // follow the cursor over it.
    const b = mascotBehaviour("look-around");
    expect([b.pose, b.eyes, b.loop, b.impulse, b.clip, b.track]).toEqual([
      "attention",
      "open",
      "breathe",
      null,
      "look-around",
      false,
    ]);
    expect(CLIP_LIBRARY["look-around"]).toMatchObject({ from: "attention", to: "attention", loop: true });
  });

  it("going home it plays enter: resting to resting, once, the wing's idle pose", () => {
    // Roam-only (amendment 2026-10-03): the soft way back into the notch.
    // It lands on the idle still and hands the wing's idle myco its pose.
    const b = mascotBehaviour("enter");
    expect([b.pose, b.clip, b.impulse, b.track]).toEqual(["resting", "enter", null, false]);
    expect(b.pose).toBe(mascotBehaviour("idle").pose);
    expect(CLIP_LIBRARY.enter).toMatchObject({ from: "resting", to: "resting", loop: false });
  });

  it("between stops it plays hop: resting to resting, looping, the idle pose", () => {
    // Roam only (amendment 2026-10-04): the slot a krea hop clip drops into.
    const b = mascotBehaviour("hop");
    expect([b.pose, b.clip, b.impulse, b.track]).toEqual(["resting", "hop", null, false]);
    expect(CLIP_LIBRARY.hop).toMatchObject({ from: "resting", to: "resting", loop: true });
  });

  it("closed or squinting eyes do not blink", () => {
    for (const k of KINDS) {
      const b = mascotBehaviour(k);
      if (b.eyes === "closed" || b.eyes === "squint") expect(b.blink).toBe(false);
    }
  });

  it("click and triple-click reactions hold for 600 ms and 2.5 s", () => {
    expect(REACTIONS.poke).toMatchObject({ eyes: "squint", impulse: "squish", ms: 600 });
    expect(REACTIONS.dizzy).toMatchObject({ eyes: "spiral", ms: 2500 });
  });
});

describe("clip runs — what plays, in what order, and what holds after", () => {
  const spec = (name: MascotClipName): ClipSpec => ({
    url: `/assets/${name}.webp`,
    frames: 49,
    fps: 12,
    loop: CLIP_LIBRARY[name].loop,
    pad: 0.125,
  });
  const run = (kind: NotchState["kind"], clips: MascotClipName[], at = 0): ClipRun => ({
    kind,
    clips,
    at,
  });

  it("every one-shot a state plays ends on the pose that state holds", () => {
    for (const k of KINDS) {
      const { clip, pose } = mascotBehaviour(k);
      if (clip && !CLIP_LIBRARY[clip].loop) expect([k, CLIP_LIBRARY[clip].to]).toEqual([k, pose]);
    }
  });

  it("every clip a state plays starts on the pose that state shows first", () => {
    // The still is what shows before the strip decodes, after a hidden window
    // returns, and under reduced motion; a clip starting elsewhere jumps.
    // recording stood on attention with open eyes, and listen opens resting.
    const jumps: string[] = [];
    for (const k of KINDS) {
      const b = mascotBehaviour(k);
      const first = b.enterPose ?? b.pose;
      if (b.clip && CLIP_LIBRARY[b.clip].from !== first) {
        jumps.push(`${k}: still ${first}, ${b.clip} starts ${CLIP_LIBRARY[b.clip].from}`);
      }
    }
    expect(jumps).toEqual([]);
  });

  it("a state whose eyes follow the cursor plays no clip over them", () => {
    // A clip carries its own eyes and the drawn ones stand down under it, so
    // hello on the peek left the cursor moving nothing for its 4.1 s, every
    // hover (decision 3: the peek's eyes follow the cursor). hello's face
    // turns and tilts as it waves, so drawn eyes cannot sit on it either.
    expect(KINDS.filter((k) => mascotBehaviour(k).track && mascotBehaviour(k).clip)).toEqual([]);
  });

  it("a state the voice lights plays no clip over its glow", () => {
    // The glow is pinned to the still's cap and stands down under a clip, so
    // under one the level rAF drove nothing on screen, every frame, and the
    // take's own baked pulse brightened in silence (decision 3: the cap glow
    // pulses with the voice level).
    expect(KINDS.filter((k) => mascotBehaviour(k).loop === "listen" && mascotBehaviour(k).clip)).toEqual([]);
  });

  it("a loop ends where it starts, so it loops without a seam", () => {
    for (const [name, c] of Object.entries(CLIP_LIBRARY)) {
      if (c.loop) expect([name, c.to]).toEqual([name, c.from]);
    }
  });

  it("wake hands over to the peek's own pose, eyes open", () => {
    expect(CLIP_LIBRARY.wake.to).toBe(mascotBehaviour("peek").pose);
    expect(CLIP_LIBRARY.wake.end).toBe("open");
  });

  it("each clip in a run opens on the pose and eyes the one before ended on", () => {
    // A run of two clips (a peek from a doze played wake, then hello): a
    // seam between them jumps like a clip starting off its still does.
    const seams: string[] = [];
    const dozing = dozeOff(enterRun(null, "idle"));
    for (const k of KINDS) {
      for (const { clips } of [enterRun(null, k), enterRun(dozing, k)]) {
        for (let i = 1; i < clips.length; i++) {
          const [a, b] = [CLIP_LIBRARY[clips[i - 1]], CLIP_LIBRARY[clips[i]]];
          if (a.to !== b.from || a.end !== b.start) seams.push(`${k}: ${clips[i - 1]} → ${clips[i]}`);
        }
      }
    }
    expect(seams).toEqual([]);
  });

  it("a state enters with its own clip", () => {
    expect(enterRun(null, "rejected")).toEqual(run("rejected", ["shake-no"]));
    expect(enterRun(null, "peek").clips).toEqual([]);
    expect(enterRun(null, "idle").clips).toEqual([]);
    expect(enterRun(null, "dragging").clips).toEqual([]);
  });

  it("a peek that finds it dozing wakes first", () => {
    const idle = enterRun(null, "idle");
    const dozing = dozeOff(idle);
    expect(dozing).toEqual(run("idle", ["doze"]));
    expect(enterRun(dozing, "peek").clips).toEqual(["wake"]);
    expect(enterRun(idle, "peek").clips).toEqual([]);
    // Only the peek wakes it; a file dragged straight over just leans in.
    expect(enterRun(dozing, "dragging").clips).toEqual([]);
  });

  it("dozes after 90 s of collapsed idle — awake, on screen, motion welcome", () => {
    expect(DOZE_AFTER_MS).toBe(90_000);
    const idle = enterRun(null, "idle");
    expect(dozeArmed(idle, false, true)).toBe(true);
    expect(dozeArmed(idle, true, true)).toBe(false);
    expect(dozeArmed(idle, false, false)).toBe(false);
    expect(dozeArmed(dozeOff(idle), false, true)).toBe(false);
    expect(dozeArmed(enterRun(null, "peek"), false, true)).toBe(false);
    // Anything but idle stays awake.
    const peek = enterRun(null, "peek");
    expect(dozeOff(peek)).toBe(peek);
  });

  it("plays a run's clips in order and then holds", () => {
    const r = run("peek", ["wake", "shake-no"]);
    expect(clipNow(r, spec, false, true)).toMatchObject({ index: 0, name: "wake" });
    const r1 = clipEnded(r, 0);
    expect(clipNow(r1, spec, false, true)).toMatchObject({ index: 1, name: "shake-no" });
    expect(clipNow(clipEnded(r1, 1), spec, false, true)).toBeNull();
  });

  it("skips a missing clip: no wake still plays what follows, nothing shipped plays nothing", () => {
    const noWake = (n: MascotClipName) => (n === "wake" ? null : spec(n));
    expect(clipNow(run("peek", ["wake", "shake-no"]), noWake, false, true)).toMatchObject({
      index: 1,
      name: "shake-no",
    });
    expect(clipNow(run("rejected", ["shake-no"]), () => null, false, true)).toBeNull();
  });

  it("reduced motion and a hidden window play no clip", () => {
    const r = run("rejected", ["shake-no"]);
    expect(clipNow(r, spec, true, true)).toBeNull();
    expect(clipNow(r, spec, false, false)).toBeNull();
  });

  it("a late finish from a clip already left behind does not skip ahead", () => {
    const r = run("peek", ["wake", "shake-no"], 1);
    expect(clipEnded(r, 0)).toEqual(r);
  });

  it("the still after a one-shot keeps its last frame, eyes included", () => {
    const rejected = mascotBehaviour("rejected");
    // Before any clip has finished, the state's own still (the fallback).
    expect(stillAfter(rejected, run("rejected", ["shake-no"]))).toBe(rejected);
    // shake-no ends eyes open: the squint (the procedural shake) must not snap back.
    const after = stillAfter(rejected, run("rejected", ["shake-no"], 1));
    expect([after.pose, after.eyes, after.blink]).toEqual(["attention", "open", true]);
    // A clip that ends with its eyes closed hands over closed, not blinking.
    const shut = stillAfter(mascotBehaviour("idle"), run("idle", ["doze"], 1));
    expect([shut.pose, shut.eyes, shut.blink]).toEqual(["resting", "closed", false]);
    // A clip already showed the sparkles; they do not twinkle in again.
    const done = stillAfter(mascotBehaviour("done"), run("done", ["wake"], 1));
    expect([done.pose, done.fx]).toEqual(["attention", null]);
    // accepted's catch-then-glow belongs to the fallback; a clip already did it.
    expect(stillAfter(mascotBehaviour("accepted"), run("accepted", ["wake"], 1)).enterPose).toBeUndefined();
  });

  it("while a strip decodes, the still is the pose and eyes its clip opens on", () => {
    // A peek from a doze waited on wake's decode showing the peek's own
    // open-eyed attention: the sleeping mascot popped awake, shut its eyes
    // again and only then woke up.
    const waking = stillBefore(mascotBehaviour("peek"), "wake");
    expect([waking.pose, waking.eyes]).toEqual(["resting", "closed"]);
    // rejected's squint belongs to the procedural shake; shake-no opens on
    // open eyes.
    const shaking = stillBefore(mascotBehaviour("rejected"), "shake-no");
    expect([shaking.pose, shaking.eyes]).toEqual(["attention", "open"]);
    // The same for every clip a state can play, whichever state waits on it.
    for (const k of KINDS) {
      for (const name of [...enterRun(null, k).clips, ...enterRun(dozeOff(enterRun(null, "idle")), k).clips]) {
        const b = stillBefore(mascotBehaviour(k), name);
        expect([k, name, b.pose, b.eyes, b.enterPose]).toEqual([
          k,
          name,
          CLIP_LIBRARY[name].from,
          CLIP_LIBRARY[name].start,
          undefined,
        ]);
        // No blink cycle starts for the frame or two before the strip shows.
        expect(b.blink).toBe(false);
      }
    }
  });

  it("decodes ahead what the run has left, and wake while it dozes", () => {
    const dozing = dozeOff(enterRun(null, "idle"));
    expect(clipsAhead(dozing)).toEqual(["doze", "wake"]);
    expect(clipsAhead(enterRun(null, "rejected"))).toEqual(["shake-no"]);
    expect(clipsAhead(clipEnded(enterRun(null, "rejected"), 0))).toEqual([]);
    expect(clipsAhead(enterRun(null, "idle"))).toEqual([]);
  });
});

describe("eye geometry", () => {
  it("every pose has two measured eyes inside the face", () => {
    for (const pose of MASCOT_POSES) {
      const eyes = eyesFor(pose);
      expect(eyes).toHaveLength(2);
      expect(eyes[0].cx).toBeLessThan(eyes[1].cx);
      for (const e of eyes) {
        expect(e.cx).toBeGreaterThan(0.2);
        expect(e.cx).toBeLessThan(0.6);
        expect(e.cy).toBeGreaterThan(0.45);
        expect(e.cy).toBeLessThan(0.7);
        // Taller than wide: the sheet's eyes are upright ovals.
        expect(e.ry).toBeGreaterThan(e.rx);
      }
    }
  });

  it("the look-at offset never leaves the socket, however far the cursor", () => {
    const socket = { rx: 0.03, ry: 0.02 };
    for (const [x, y] of [
      [1e6, 0],
      [0, -1e6],
      [-3, 4],
      [1e9, 1e9],
      [0.001, 0.001],
    ]) {
      const o = lookOffset(x, y, socket);
      expect((o.dx / socket.rx) ** 2 + (o.dy / socket.ry) ** 2).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it("looks the way the cursor is, more the further it is", () => {
    const socket = { rx: 0.03, ry: 0.02 };
    const right = lookOffset(2, 0, socket);
    expect(right.dx).toBeGreaterThan(0);
    expect(Math.abs(right.dy)).toBeLessThan(1e-12);
    const up = lookOffset(0, -2, socket);
    expect(up.dy).toBeLessThan(0);
    expect(lookOffset(4, 0, socket).dx).toBeGreaterThan(lookOffset(0.5, 0, socket).dx);
  });

  it("a cursor on the eyes, or a broken reading, looks straight ahead", () => {
    const socket = { rx: 0.03, ry: 0.02 };
    expect(lookOffset(0, 0, socket)).toEqual({ dx: 0, dy: 0 });
    expect(lookOffset(Number.NaN, 1, socket)).toEqual({ dx: 0, dy: 0 });
    expect(lookOffset(Number.POSITIVE_INFINITY, 1, socket)).toEqual({ dx: 0, dy: 0 });
  });

  it("aims from the eyes' midpoint in mascot widths, one path for a DOM or a native pointer", () => {
    // notch.rs sends the pointer panel-local, which is the webview's
    // clientX/clientY, so both feeds land here unchanged.
    const box = { left: 10, top: 20, width: 56, height: 56 };
    const mid = { x: 0.5, y: 0.5 };
    expect(pointerAim(38, 48, box, mid)).toEqual({ x: 0, y: 0 });
    expect(pointerAim(38 + 56, 48 - 28, box, mid)).toEqual({ x: 1, y: -0.5 });
    // A pointer outside the window (the leave slop) still has a direction.
    expect(pointerAim(-20, 48, box, mid).x).toBeLessThan(0);
  });

  it("a mascot with no layout box yet looks straight ahead", () => {
    const empty = { left: 0, top: 0, width: 0, height: 0 };
    expect(pointerAim(100, 100, empty, { x: 0.5, y: 0.5 })).toEqual({ x: 0, y: 0 });
  });
});

describe("lookStep — the eyes' look-at spring", () => {
  it("holds straight ahead while no eyes are drawn, so they never snap on when a clip hands back", () => {
    // Run on unseen under a clip, it settled on the pointer; the eyes that
    // came back looked ahead until the pointer moved, then jumped the whole
    // way in one frame.
    let look = LOOK_REST;
    for (let i = 0; i < 120; i++) look = lookStep(look, null, 1 / 60);
    expect(look).toEqual(LOOK_REST);
    expect(lookStep({ x: { x: 0.03, v: 1 }, y: { x: -0.02, v: 0 } }, null, 1 / 60)).toEqual(LOOK_REST);
  });

  it("eases toward where the eyes aim over frames rather than jumping there", () => {
    const aim = { dx: 0.03, dy: 0.01 };
    const first = lookStep(LOOK_REST, aim, 1 / 60);
    expect(first.x.x).toBeGreaterThan(0);
    expect(first.x.x).toBeLessThan(aim.dx / 4);
    let look = LOOK_REST;
    for (let i = 0; i < 120; i++) look = lookStep(look, aim, 1 / 60);
    expect(look.x.x).toBeCloseTo(aim.dx, 4);
    expect(look.y.x).toBeCloseTo(aim.dy, 4);
  });
});

describe("blink schedule", () => {
  it("is seeded: the same seed blinks at the same times", () => {
    expect(blinkGaps(7)).toEqual(blinkGaps(7));
    expect(blinkGaps(7)).not.toEqual(blinkGaps(8));
  });

  it("blinks every 3–7 s", () => {
    for (const seed of [1, 2, 3, 42, 1234567]) {
      const gaps = blinkGaps(seed);
      expect(gaps.length).toBeGreaterThanOrEqual(4);
      for (const g of gaps) {
        expect(g).toBeGreaterThanOrEqual(3000);
        expect(g).toBeLessThanOrEqual(7000);
      }
    }
  });

  it("becomes one keyframe cycle with ordered offsets and closed lids at each blink", () => {
    const { keyframes, duration } = blinkKeyframes(42);
    const gaps = blinkGaps(42);
    expect(duration).toBe(gaps.reduce((a, b) => a + b, 0));
    const offsets = keyframes.map((k) => k.offset as number);
    expect(offsets[0]).toBe(0);
    expect(offsets[offsets.length - 1]).toBe(1);
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i]).toBeGreaterThan(offsets[i - 1]);
    }
    const shut = keyframes.filter((k) => k.transform !== "scaleY(1)");
    expect(shut).toHaveLength(gaps.length);
  });
});

describe("springStep", () => {
  const params = { stiffness: 420, damping: 18 };

  it("settles on its target", () => {
    let s = { x: 0, v: 0 };
    for (let i = 0; i < 240; i++) s = springStep(s, 1, 1 / 60, params);
    expect(s.x).toBeCloseTo(1, 3);
    expect(Math.abs(s.v)).toBeLessThan(1e-2);
  });

  it("stays stable on a huge frame gap (a backgrounded tab resuming)", () => {
    let s = { x: 0, v: 50 };
    for (let i = 0; i < 20; i++) {
      s = springStep(s, 0, 2.5, { stiffness: 4000, damping: 4 });
      expect(Number.isFinite(s.x)).toBe(true);
      expect(Math.abs(s.x)).toBeLessThan(10);
    }
  });

  it("loses energy every step when underdamped", () => {
    const energy = (s: { x: number; v: number }) => 0.5 * 420 * s.x ** 2 + 0.5 * s.v ** 2;
    let s = { x: 0, v: 8 };
    let e = energy(s);
    for (let i = 0; i < 120; i++) {
      s = springStep(s, 0, 1 / 60, { stiffness: 420, damping: 4 });
      const next = energy(s);
      expect(next).toBeLessThanOrEqual(e + 1e-9);
      e = next;
    }
  });

  it("settled() says when the rAF may stop", () => {
    const rest: MascotSprings = {
      x: { x: 0, v: 0 },
      y: { x: 0, v: 0 },
      sx: { x: 1, v: 0 },
      sy: { x: 1, v: 0 },
      r: { x: 0, v: 0 },
    };
    const targets = { x: 0, y: 0, sx: 1, sy: 1, r: 0 };
    expect(settled(rest, targets)).toBe(true);
    expect(settled({ ...rest, sy: { x: 1, v: 0.5 } }, targets)).toBe(false);
    expect(settled({ ...rest, r: { x: 3, v: 0 } }, targets)).toBe(false);
  });
});

describe("resolveClip — the manifest loader", () => {
  const json = {
    "../assets/mascot/motion/wake.json": { frames: 24, fps: 12, loop: false },
    "../assets/mascot/motion/read-loop.json": { frames: 30, fps: 15, loop: true },
    "../assets/mascot/motion/shake-no.json": { frames: "lots", fps: 12, loop: false },
  };
  const urls = {
    "../assets/mascot/motion/wake.webp": "/assets/wake-abc.webp",
    "../assets/mascot/motion/read-loop.webp": "/assets/read-loop-def.webp",
    "../assets/mascot/motion/shake-no.webp": "/assets/shake-no-123.webp",
  };

  it("reads a shipped clip", () => {
    expect(resolveClip("wake", json, urls)).toEqual({
      url: "/assets/wake-abc.webp",
      frames: 24,
      fps: 12,
      loop: false,
      pad: 0,
    });
    expect(resolveClip("read-loop", json, urls)?.loop).toBe(true);
  });

  it("a missing clip falls back to the pose (null), silently", () => {
    expect(resolveClip("think", json, urls)).toBeNull();
    expect(resolveClip("wake", {}, {})).toBeNull();
    // A manifest without its strip, or a strip without its manifest.
    expect(resolveClip("wake", json, {})).toBeNull();
    expect(resolveClip("wake", {}, urls)).toBeNull();
  });

  it("a malformed manifest is treated as missing", () => {
    expect(resolveClip("shake-no", json, urls)).toBeNull();
    for (const bad of [
      null,
      { frames: 0, fps: 12, loop: false },
      { frames: 12, fps: 0, loop: false },
      { frames: 12, fps: 500, loop: false },
      { frames: 12.5, fps: 12, loop: false },
      { frames: 12, fps: 12 },
    ]) {
      expect(
        resolveClip("wake", { "../assets/mascot/motion/wake.json": bad }, urls),
      ).toBeNull();
    }
  });

  it("reads the strip's pad, the room each frame has around the pose box", () => {
    const padded = { "../assets/mascot/motion/wake.json": { frames: 2, fps: 12, loop: false, pad: 0.125 } };
    expect(resolveClip("wake", padded, urls)?.pad).toBe(0.125);
    for (const pad of [-0.1, 0.5, 2, "0.125", Number.NaN]) {
      expect(
        resolveClip("wake", { "../assets/mascot/motion/wake.json": { frames: 2, fps: 12, loop: false, pad } }, urls),
      ).toBeNull();
    }
  });

  it("an eager JSON glob's { default } wrapper is unwrapped", () => {
    expect(
      resolveClip(
        "wake",
        { "../assets/mascot/motion/wake.json": { default: { frames: 2, fps: 12, loop: true } } },
        urls,
      ),
    ).toMatchObject({ frames: 2, loop: true });
  });
});

describe("clipFrame — a padded strip frame over the pose box", () => {
  it("draws the frame (1 + 2·pad)× the pose box, centred on it", () => {
    const f = clipFrame(0.125);
    expect(f.size).toBe(1.25);
    expect(f.x).toBe(-0.125);
    expect(f.y).toBe(-0.125);
    // Centred: the frame's middle is the pose box's middle.
    expect(f.x + f.size / 2).toBe(0.5);
    expect(f.y + f.size / 2).toBe(0.5);
  });

  it("keeps the character at the pose's scale", () => {
    // The strips: the pose crop (288 px of the 384 sheet) plus 36 px a side,
    // in 160 px frames — so the pose crop is 128 px of each frame.
    const pad = 36 / 288;
    const frameSize = 160;
    const poseInFrame = frameSize / (1 + 2 * pad);
    expect(poseInFrame).toBe(128);
    // Drawn over a 56 px pose box, that crop covers exactly the 56 px.
    const box = 56;
    expect(clipFrame(pad).size * box * (poseInFrame / frameSize)).toBeCloseTo(box, 9);
  });

  it("an unpadded strip fills the pose box", () => {
    const f = clipFrame(0);
    expect(f.size).toBe(1);
    expect(f.x).toBeCloseTo(0, 12);
    expect(f.y).toBeCloseTo(0, 12);
  });
});

describe("the shipped notch clips (assets/mascot/motion)", () => {
  const dir = resolve(__dirname, "../assets/mascot/motion");
  /** krea takes the library waits on (amendments 2026-10-03: enter,
   *  2026-10-04: hop): held to every rule below once their pair lands,
   *  absent until then. */
  const pending: readonly MascotClipName[] = ["enter", "hop"];
  const names = (Object.keys(CLIP_LIBRARY) as MascotClipName[]).filter(
    (n) => !pending.includes(n) || existsSync(resolve(dir, `${n}.json`)),
  );
  /** A VP8X WebP's canvas size: 24-bit width-1 and height-1 at bytes 24..29. */
  const webpSize = (file: string) => {
    const b = readFileSync(file);
    expect(b.toString("latin1", 8, 16), file).toBe("WEBPVP8X");
    return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
  };

  it("ship every library clip as a strip and a manifest the loader takes", () => {
    for (const name of names) {
      const manifest: unknown = JSON.parse(readFileSync(resolve(dir, `${name}.json`), "utf8"));
      const spec = resolveClip(
        name,
        { [`motion/${name}.json`]: manifest },
        { [`motion/${name}.webp`]: `${name}.webp` },
      );
      expect(spec, name).not.toBeNull();
      expect([name, spec?.loop]).toEqual([name, CLIP_LIBRARY[name].loop]);
      // Framed by scripts/mascot-key-clip.py: the pose crop plus a margin of
      // the 384 sheet a side (36 px, an eighth of the 288 px pose box; 45 px
      // for the takes keyed since, up to the take's own top edge), at the
      // notch layers' scale: the pose box is 128 px of every frame.
      const { frameSize } = manifest as { frameSize: number };
      expect([name, frameSize / (1 + 2 * (spec?.pad ?? 0))]).toEqual([name, 128]);
      expect([name, webpSize(resolve(dir, `${name}.webp`))]).toEqual([
        name,
        { w: (spec?.frames ?? 0) * frameSize, h: frameSize },
      ]);
    }
  });

  /** A shipped strip decoded to straight RGBA, `width` px per row. */
  const decode = async (name: MascotClipName) => {
    const { data, info } = await sharp(resolve(dir, `${name}.webp`))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width };
  };

  it("cut nothing: no frame has anything opaque on its edge", async () => {
    // A frame is the whole picture the take has, padded past the pose box. A
    // cap on its edge is a cap cut flat: hello's hop and celebrate's hops left
    // the generated frame, and the notch showed a flat-topped mushroom.
    const cut: string[] = [];
    for (const name of names) {
      const { frames, frameSize: s } = JSON.parse(
        readFileSync(resolve(dir, `${name}.json`), "utf8"),
      ) as { frames: number; frameSize: number };
      const { data, width } = await decode(name);
      const alpha = (x: number, y: number) => data[(y * width + x) * 4 + 3];
      for (let i = 0; i < frames; i++) {
        const x0 = i * s;
        for (let k = 0; k < s; k++) {
          const edge = [alpha(x0 + k, 0), alpha(x0 + k, s - 1), alpha(x0, k), alpha(x0 + s - 1, k)];
          if (edge.some((a) => a > 32)) {
            cut.push(`${name} frame ${i}`);
            break;
          }
        }
      }
    }
    expect(cut).toEqual([]);
  });

  it("show no light prop cut flat near the top, however faded at the edge", async () => {
    // gulp's orb drops in from above the take's picture, so the take cuts it
    // flat; faded over the frame's outer 12 px it still passed the edge test,
    // and the notch showed a bright half-disc with a straight top for 0.3 s
    // after every drop. A cut top is wide where it starts: its first opaque
    // light row spans at least half the prop's width, and solid light lies
    // right under it. A whole disc starts narrow, and a cap's rim light is a
    // thin arc over its dark top.
    const BAND = 24; // rows from the top: where a cut prop's top would show
    const runs = (row: boolean[]): [number, number][] => {
      const out: [number, number][] = [];
      for (let x = 0; x < row.length; x++) {
        if (!row[x]) continue;
        const x0 = x;
        while (x + 1 < row.length && row[x + 1]) x++;
        out.push([x0, x]);
      }
      return out;
    };
    const flat: string[] = [];
    for (const name of names) {
      const { frames, frameSize: s } = JSON.parse(
        readFileSync(resolve(dir, `${name}.json`), "utf8"),
      ) as { frames: number; frameSize: number };
      const { data, width } = await decode(name);
      for (let i = 0; i < frames; i++) {
        // Opaque light pixels (an orb, its glow), straight alpha.
        const light = Array.from({ length: BAND * 2 }, (_, y) =>
          Array.from({ length: s }, (_, x) => {
            const j = (y * width + i * s + x) * 4;
            const luma = 0.2126 * data[j] + 0.7152 * data[j + 1] + 0.0722 * data[j + 2];
            return data[j + 3] > 128 && luma > 96;
          }),
        );
        const top = light.slice(0, BAND).findIndex((row) => row.includes(true));
        if (top < 0) continue;
        for (const [x0, x1] of runs(light[top])) {
          const w = x1 - x0 + 1;
          const solid = [1, 2, 3].every(
            (k) => light[top + k].slice(x0, x1 + 1).filter(Boolean).length >= 0.8 * w,
          );
          const widest = Math.max(
            ...light
              .slice(top, top + BAND)
              .flatMap((row) => runs(row).filter(([a, b]) => b >= x0 && a <= x1))
              .map(([a, b]) => b - a + 1),
          );
          if (w >= 12 && solid && w >= 0.5 * widest) {
            flat.push(`${name} frame ${i}: ${w} px flat at row ${top}`);
          }
        }
      }
    }
    expect(flat).toEqual([]);
  });

  it("open and close in the pose layers' colours, so a hand-off does not shift hue", async () => {
    // Every take came out about a third more saturated and bluer than the
    // sheet; the shape matched, so the character went violet at each clip's
    // start and grey-violet at each hand-off. CIE76 ΔE between the body's mean
    // colour (the pose box, opaque in both, the eyes left out: the notch
    // layers have them painted out) in the strip's first and last frame and
    // in its from/to layer. Ungraded the strips measured 4.4-7.5; graded by
    // the keyer, 0.1-1.1. Below ~2.3 a difference is not visible. (Per pixel
    // the graded frames still differ by 2.6-3.6 on average: the take's own
    // shading and texture, which no colour grade changes.)
    const lab = (r: number, g: number, b: number): number[] => {
      const lin = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      const [R, G, B] = [lin(r), lin(g), lin(b)];
      const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
      const x = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
      const y = f(0.2126 * R + 0.7152 * G + 0.0722 * B);
      const z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
      return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
    };
    const drift: string[] = [];
    for (const name of names) {
      const { frames, frameSize: s, pad } = JSON.parse(
        readFileSync(resolve(dir, `${name}.json`), "utf8"),
      ) as { frames: number; frameSize: number; pad: number };
      const { data, width } = await decode(name);
      const box = Math.round(s / (1 + 2 * pad)); // 128 px of each 160 px frame
      const inset = (s - box) / 2;
      for (const [label, frame, pose] of [
        ["first", 0, CLIP_LIBRARY[name].from],
        ["last", frames - 1, CLIP_LIBRARY[name].to],
      ] as const) {
        const layer = await sharp(resolve(dir, `../notch/${pose}.${box}.png`))
          .ensureAlpha()
          .raw()
          .toBuffer();
        const eyes = eyesFor(pose);
        const diff = [0, 0, 0]; // summed Lab difference, strip − layer
        let n = 0;
        for (let y = 0; y < box; y++) {
          for (let x = 0; x < box; x++) {
            const u = (x + 0.5) / box;
            const v = (y + 0.5) / box;
            if (eyes.some((e) => ((u - e.cx) / (e.rx * 2.2)) ** 2 + ((v - e.cy) / (e.ry * 2)) ** 2 < 1)) continue;
            const i = (y * box + x) * 4;
            const j = ((y + inset) * width + frame * s + x + inset) * 4;
            if (layer[i + 3] <= 242 || data[j + 3] <= 242) continue;
            const a = lab(data[j], data[j + 1], data[j + 2]);
            const b = lab(layer[i], layer[i + 1], layer[i + 2]);
            for (let k = 0; k < 3; k++) diff[k] += a[k] - b[k];
            n++;
          }
        }
        const de = Math.hypot(...diff) / n;
        if (!(n > 4000 && de <= 2)) drift.push(`${name} ${label} vs ${pose}: ΔE ${de.toFixed(1)} over ${n} px`);
      }
    }
    expect(drift).toEqual([]);
  });

  it("play a state's one-shot through before the driver folds that state", () => {
    // A one-shot holds its last frame, the pose its state uses next; folded
    // first, it never gets there. sigh (4083 ms) under cancelled's 800 ms
    // showed 9 of 49 frames: an inhale with open eyes, then idle.
    const cut: string[] = [];
    for (const { state } of MOCK_FRAMES) {
      const { clip } = mascotBehaviour(state.kind);
      const dwell = dwellMsFor(state);
      if (!clip || CLIP_LIBRARY[clip].loop || dwell === null) continue;
      const { frames, fps } = JSON.parse(readFileSync(resolve(dir, `${clip}.json`), "utf8")) as {
        frames: number;
        fps: number;
      };
      const ms = (frames / fps) * 1000;
      if (ms > dwell) cut.push(`${state.kind}: ${clip} ${Math.round(ms)} ms > ${dwell} ms`);
    }
    expect(cut).toEqual([]);
  });

  it("stay within the notch budget: strips ≤ 1.6 MB together", () => {
    const strips = readdirSync(dir).filter((f) => f.endsWith(".webp"));
    expect(strips.sort()).toEqual(names.map((n) => `${n}.webp`).sort());
    const total = strips.reduce((sum, f) => sum + statSync(resolve(dir, f)).size, 0);
    expect(total).toBeLessThanOrEqual(1_600_000);
  });
});

describe("glowFromLevel", () => {
  it("rests at a soft glow and brightens with the voice, capped", () => {
    expect(glowFromLevel(0)).toBeCloseTo(0.35);
    expect(glowFromLevel(0.1)).toBeGreaterThan(glowFromLevel(0.02));
    expect(glowFromLevel(5)).toBe(1);
    expect(glowFromLevel(Number.NaN)).toBeCloseTo(0.35);
  });
});
