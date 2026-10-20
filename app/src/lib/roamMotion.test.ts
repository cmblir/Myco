// How myco moves while it roams (docs/specs/2026-10-02-mascot-roam.md,
// decisions 2, 4 and 6): the pop out of the notch, hops with squash and
// stretch between the planner's stops, a clip per stop, a hop away from the
// pointer, and the soft way home (amendment 2026-10-03). Pure: time is stepped by the test.

import { describe, expect, it } from "vitest";
import { ROAM_MYCO_PX, mycoHome } from "./roam";
import type { RoamCue, RoamFrame } from "./roam";
import { POINTER_CLEAR_PX, tooClose } from "./roamPlan";
import type { Pt } from "./roamPlan";
import {
  ROAM_DOOR_Y,
  STOP_MS,
  clipMs,
  hopAt,
  hopCount,
  legHop,
  roamFrame,
  roamStart,
  roamTick,
  stopAct,
} from "./roamMotion";
import type { Hop, RoamSim } from "./roamMotion";
import { ROAM_BACK_MS, ROAM_HOME, stepRoam, wanderPlan } from "./roamTrigger";
import type { RoamPhase } from "./roamTrigger";
import { mascotBehaviour, resolveClip } from "./notchMascot";

const place = { width: 1512, height: 945, notch_left: 654 };
const home = mycoHome(place);
const reading: RoamCue = { job: "read", progress: { done: 11, total: 20 }, outcome: null };
const FRAME = 1000 / 60;

/** Step the sim `ms` at 60 fps, recording every frame and phase. */
function run(
  sim: RoamSim,
  ms: number,
  cue: RoamCue,
  pointer: () => Pt | null = () => null,
  reduced = false,
): { sim: RoamSim; frames: RoamFrame[]; phases: RoamSim["phase"][]; sims: RoamSim[] } {
  const frames: RoamFrame[] = [];
  const phases: RoamSim["phase"][] = [];
  const sims: RoamSim[] = [];
  for (let t = 0; t < ms; t += FRAME) {
    sim = roamTick(sim, FRAME, { place, cue, pointer: pointer(), reduced });
    frames.push(roamFrame(sim, cue));
    phases.push(sim.phase);
    sims.push(sim);
  }
  return { sim, frames, phases, sims };
}

describe("hops", () => {
  it("keeps the ground projection beneath the arc and meets it at each landing", () => {
    const h = legHop({ x: 100, y: 800 }, { x: 160, y: 770 }, 1, 0, null);
    const sim = { ...roamStart(place, 7), phase: "hop" as const, hop: h };
    for (const share of [0, 0.25, 0.5, 0.75, 1]) {
      const frame = roamFrame({ ...sim, t: (h.crouch ?? 0) + h.ms * share }, reading);
      const groundY = h.from.y + (h.to.y - h.from.y) * share;
      expect(frame).toMatchObject({ groundY });
      expect(frame.y).toBeLessThanOrEqual(groundY);
      if (share === 0 || share === 1) expect(frame.y).toBeCloseTo(groundY);
    }
    const flat = roamFrame({ ...sim, t: h.ms / 2, reduced: true }, reading);
    expect(flat).toMatchObject({ groundY: flat.y });
  });

  it("leaves the contact point on the doorstep while rising into the notch", () => {
    const sim = { ...roamStart(place, 7), phase: "enter" as const, at: { x: home.x, y: ROAM_DOOR_Y }, t: 250 };
    expect(roamFrame(sim, reading)).toMatchObject({ groundY: ROAM_DOOR_Y });
  });

  it("leave from one end, land on the other, and arc over the higher one", () => {
    for (const [a, b] of [
      [{ x: 100, y: 800 }, { x: 250, y: 800 }],
      [{ x: 100, y: 800 }, { x: 180, y: 680 }],
      [{ x: 400, y: 700 }, { x: 300, y: 820 }],
    ] as [Pt, Pt][]) {
      const h = legHop(a, b, 1, 0, null);
      expect(hopAt(h, 0)).toMatchObject(a);
      expect(hopAt(h, h.ms)).toMatchObject(b);
      const apex = Math.min(...Array.from({ length: 21 }, (_, i) => hopAt(h, (h.ms * i) / 20).y));
      expect(apex).toBeLessThan(Math.min(a.y, b.y));
    }
  });

  it("go up first and come down last", () => {
    const h = legHop({ x: 0, y: 800 }, { x: 60, y: 800 }, 1, 0, null);
    expect(hopAt(h, 0).vy).toBeLessThan(0);
    expect(hopAt(h, h.ms).vy).toBeGreaterThan(0);
  });
});

describe("the pop out of the notch", () => {
  const start = roamStart(place, 7);

  it("starts in the notch: at its myco's slot, wholly above the window's top edge", () => {
    const f = roamFrame(start, reading);
    expect(f.x).toBe(home.x);
    expect(f.y).toBeLessThanOrEqual(0);
  });

  it("drops straight down to the doorstep, stretched on the way and squashed on landing", () => {
    const { frames, phases } = run(start, 900, reading);
    const landed = phases.indexOf("stop");
    expect(landed).toBeGreaterThan(0);
    for (const f of frames.slice(0, landed)) expect(f.x).toBe(home.x);
    expect(frames[landed].y).toBe(ROAM_DOOR_Y);
    expect(Math.max(...frames.slice(0, landed).map((f) => f.sy))).toBeGreaterThan(1.05);
    expect(Math.min(...frames.slice(landed, landed + 12).map((f) => f.sy))).toBeLessThan(0.95);
    // Squash and stretch keep the volume.
    for (const f of frames) expect(f.sx * f.sy).toBeCloseTo(1, 5);
  });
});

describe("roaming", () => {
  const { frames, phases, sim } = run(roamStart(place, 7), 40_000, reading);

  it("hops between stops and pauses at each with a clip that fits the job", () => {
    const acts = new Set(frames.map((f) => f.act));
    expect(acts).toContain("running");
    expect(acts).toContain("look-around");
    expect(acts).toContain("idle");
    expect(sim.stops).toBeGreaterThanOrEqual(4);
    // Hops play the hop slot (idle's own pose until a clip ships); only a
    // stop plays a job's clip.
    frames.forEach((f, i) => {
      if (phases[i] === "hop") expect(f.act).toBe("hop");
    });
  });

  it("stays whole inside the window once out of the notch", () => {
    const out = phases.indexOf("stop");
    for (const f of frames.slice(out)) {
      expect(f.x - ROAM_MYCO_PX / 2).toBeGreaterThanOrEqual(0);
      expect(f.x + ROAM_MYCO_PX / 2).toBeLessThanOrEqual(place.width);
      expect(f.y - ROAM_MYCO_PX * f.sy).toBeGreaterThanOrEqual(-1);
      expect(f.y).toBeLessThanOrEqual(place.height);
    }
  });

  it("stretches in the air and squashes as it lands", () => {
    const air = frames.filter((_, i) => phases[i] === "hop");
    expect(Math.max(...air.map((f) => f.sy))).toBeGreaterThan(1.05);
    expect(Math.min(...frames.map((f) => f.sy))).toBeLessThan(0.95);
  });

  it("shows the job's steps beside it", () => {
    expect(frames.every((f) => f.progress === reading.progress)).toBe(true);
  });

  it("thinks instead of reading while saving or reflecting", () => {
    const thinking = run(roamStart(place, 7), 20_000, { ...reading, job: "think" });
    const acts = new Set(thinking.frames.map((f) => f.act));
    expect(acts).toContain("saving");
    expect(acts).not.toContain("running");
  });

  it("is the same walk for the same seed", () => {
    expect(run(roamStart(place, 7), 8000, reading).frames).toEqual(frames.slice(0, 480));
  });
});

describe("stopAct", () => {
  it("plays the job's own clip, and looks around every third stop", () => {
    expect([0, 1, 2, 3, 4, 5].map((n) => stopAct("read", n))).toEqual([
      "running",
      "running",
      "look-around",
      "running",
      "running",
      "look-around",
    ]);
    expect(stopAct("think", 0)).toBe("saving");
  });
});

/** Run until myco stands at a stop playing its clip. */
function atStop(enterClipMs: number | null = null): RoamSim {
  let sim = roamStart(place, 7, enterClipMs);
  for (let i = 0; i < 6000; i++) {
    sim = roamTick(sim, FRAME, { place, cue: reading, pointer: null });
    if (sim.phase === "stop" && sim.act === "running" && sim.t > 200) return sim;
  }
  throw new Error("never stopped");
}

describe("the pointer", () => {
  it("sends myco hopping away when it comes within 120 px, to a stop 200 px clear of it", () => {
    const stopped = atStop();
    const pointer = { x: stopped.at.x + 40, y: stopped.at.y - 40 };
    const next = roamTick(stopped, FRAME, { place, cue: reading, pointer });
    expect(next.phase).toBe("hop");
    expect(next.goal).not.toBeNull();
    const goal = next.goal as Pt;
    expect(Math.hypot(goal.x - pointer.x, goal.y - ROAM_MYCO_PX / 2 - pointer.y)).toBeGreaterThanOrEqual(
      POINTER_CLEAR_PX,
    );
  });

  it("is left alone farther off", () => {
    const stopped = atStop();
    const pointer = { x: stopped.at.x + 300, y: stopped.at.y - 32 };
    expect(roamTick(stopped, FRAME, { place, cue: reading, pointer }).phase).toBe("stop");
  });
});

describe("back into the notch", () => {
  it("on done hops to the doorstep at once, lands, and rises out of view", () => {
    const done: RoamCue = { ...reading, outcome: "done" };
    const { frames, phases } = run(atStop(), ROAM_BACK_MS, done);
    const enter = phases.indexOf("enter");
    const gone = phases.indexOf("gone");
    expect(enter).toBeGreaterThan(0);
    expect(gone).toBeGreaterThan(enter);
    // Lands on the doorstep under the cutout, and goes in from there.
    expect(frames[enter]).toMatchObject({ x: home.x, y: ROAM_DOOR_Y, act: "enter" });
    // Procedural, 300-450 ms: a squash where it landed, then it shrinks
    // and rises out of view, never back down and never growing again.
    const ms = (gone - enter) * FRAME;
    expect(ms).toBeGreaterThanOrEqual(300);
    expect(ms).toBeLessThanOrEqual(450 + FRAME);
    const going = frames.slice(enter, gone + 1);
    expect(Math.min(...going.map((f) => f.sy / f.sx))).toBeLessThan(0.75);
    for (let i = 1; i < going.length; i++) {
      expect(going[i].x).toBe(home.x);
      expect(going[i].y).toBeLessThanOrEqual(going[i - 1].y);
      // Its size (the squash keeps it) only ever shrinks.
      expect(going[i].sx * going[i].sy).toBeLessThanOrEqual(going[i - 1].sx * going[i - 1].sy + 1e-9);
    }
    expect(frames.every((f) => f.progress === null)).toBe(true);
  });

  it("shrinks smoothly above the window before the roaming character disappears", () => {
    for (const enterClipMs of [null, 2000]) {
      const { frames, phases } = run(atStop(enterClipMs), ROAM_BACK_MS, { ...reading, outcome: "done" });
      const gone = phases.indexOf("gone");
      const hand = frames[gone];
      // The compact return stays smooth without any resting replacement.
      const k = 26 / ROAM_MYCO_PX;
      expect(hand).toMatchObject({ x: home.x, y: home.y, act: "enter" });
      expect(hand.sx).toBeCloseTo(k, 6);
      expect(hand.sy).toBeCloseTo(k, 6);
      expect(mascotBehaviour("enter").pose).toBe(mascotBehaviour("idle").pose);
      // The frame before is all but there: nothing jumps at the hand-over.
      const before = frames[gone - 1];
      expect(Math.abs(before.y - hand.y)).toBeLessThan(4);
      expect(Math.abs(before.sy - hand.sy)).toBeLessThan(0.03);
      // Its whole box is above the window's top edge and no longer visible.
      expect(hand.y - ROAM_MYCO_PX * hand.sy).toBeLessThanOrEqual(0);
      expect(hand.y).toBeLessThanOrEqual(0);
    }
  });

  it("with an enter clip shipped, plays it through where it landed, then rises in", () => {
    const { frames, phases } = run(atStop(2000), ROAM_BACK_MS, { ...reading, outcome: "done" });
    const enter = phases.indexOf("enter");
    const gone = phases.indexOf("gone");
    expect(Math.abs((gone - enter) * FRAME - 2000)).toBeLessThanOrEqual(FRAME + 1);
    const going = frames.slice(enter, gone);
    // The clip carries its own squash; the frame adds none.
    for (const f of going) expect(f.sx).toBeCloseTo(f.sy, 9);
    // It stays on the doorstep while most of the clip plays.
    const held = going.filter((f) => f.y === ROAM_DOOR_Y).length * FRAME;
    expect(held).toBeGreaterThan(1500);
    expect(going.every((f) => f.act === "enter")).toBe(true);
  });

  it("an enter clip dropped into the motion library is picked up as is", () => {
    // assets/mascot/motion/enter.webp + enter.json: no code to change.
    const spec = resolveClip(
      "enter",
      { "../assets/mascot/motion/enter.json": { frames: 30, fps: 12, loop: false, pad: 0.15625 } },
      { "../assets/mascot/motion/enter.webp": "/enter.webp" },
    );
    expect(spec).toMatchObject({ frames: 30, fps: 12, loop: false });
    expect(clipMs(spec)).toBe(2500);
    expect(clipMs(null)).toBeNull();
    expect(mascotBehaviour("enter").clip).toBe("enter");
  });

  it("finishes a hop already in the air before turning back", () => {
    let sim = atStop();
    while (sim.phase === "stop") sim = roamTick(sim, FRAME, { place, cue: reading, pointer: null });
    sim = roamTick(sim, FRAME, { place, cue: reading, pointer: null });
    expect(sim.phase).toBe("hop");
    const landing = sim.hop?.to as Pt;
    const after = run(sim, ROAM_BACK_MS, { ...reading, outcome: "done" });
    const landed = after.frames.findIndex((f) => f.x === landing.x && f.y === landing.y);
    const turned = after.frames.findIndex((f) => f.x === home.x);
    expect(landed).toBeGreaterThan(0);
    expect(turned).toBeGreaterThan(landed);
    expect(after.phases[after.phases.length - 1]).toBe("gone");
  });

  it("on a failure shakes its head where it stands first, then goes back", () => {
    const failed: RoamCue = { ...reading, outcome: "failed" };
    const stopped = atStop();
    const { frames, phases } = run(stopped, ROAM_BACK_MS, failed);
    const shake = frames.findIndex((f) => f.act === "rejected");
    expect(shake).toBe(0);
    expect(frames[shake]).toMatchObject({ x: stopped.at.x, y: stopped.at.y });
    const shook = frames.filter((f) => f.act === "rejected").length * FRAME;
    expect(shook).toBeGreaterThanOrEqual(STOP_MS - FRAME);
    expect(phases[phases.length - 1]).toBe("gone");
  });

  it("is back in before the notch calls it back, even from the far corner of a big screen", () => {
    const big = { width: 2560, height: 1415, notch_left: 1220 };
    const corner = { ...roamStart(big, 1), phase: "stop" as const, hop: null, at: { x: 48, y: 1399 } };
    let sim: RoamSim = { ...corner, act: "running", stopMs: STOP_MS };
    let ms = 0;
    while (sim.phase !== "gone" && ms < ROAM_BACK_MS) {
      sim = roamTick(sim, FRAME, { place: big, cue: { ...reading, outcome: "failed" }, pointer: null });
      ms += FRAME;
    }
    expect(sim.phase).toBe("gone");
  });

  it("does not cut the head shake short for a pointer", () => {
    const stopped = atStop();
    const pointer = () => ({ x: stopped.at.x, y: stopped.at.y - 32 });
    const { frames } = run(stopped, STOP_MS - 100, { ...reading, outcome: "failed" }, pointer);
    expect(frames.every((f) => f.act === "rejected")).toBe(true);
  });

  it("keeps roaming when new work joins before it has gone in", () => {
    const stopped = atStop();
    const turning = roamTick(stopped, FRAME, { place, cue: { ...reading, outcome: "done" }, pointer: null });
    expect(turning.phase).toBe("hop");
    const { phases } = run(turning, 6000, reading);
    expect(phases).not.toContain("enter");
    expect(phases).toContain("stop");
  });
});

describe("an everyday walk (amendment 2026-10-03)", () => {
  const wander = (ms: number, stops: number): RoamCue => ({
    job: "wander",
    progress: null,
    outcome: null,
    walk: { ms, stops },
  });

  it("looks around and breathes at its stops, never a job's clip", () => {
    expect([0, 1, 2, 3].map((n) => stopAct("wander", n))).toEqual([
      "look-around",
      "idle",
      "look-around",
      "idle",
    ]);
  });

  it("makes its stops and goes home on its own, in about the walk's time", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const { walk } = wanderPlan(seed * 104_729);
      const cue = wander(walk.ms, walk.stops);
      const { sim, phases, frames } = run(roamStart(place, seed), walk.ms + 8000, cue);
      const gone = phases.indexOf("gone") * FRAME;
      expect(sim.phase, `seed ${seed}`).toBe("gone");
      // Small hops are slow: on long legs the walk's time wins over its
      // stop count, but it always makes one.
      expect(sim.stops, `seed ${seed}`).toBeGreaterThanOrEqual(1);
      expect(sim.stops, `seed ${seed}`).toBeLessThanOrEqual(walk.stops);
      expect(gone, `seed ${seed}`).toBeGreaterThanOrEqual(walk.ms - 2500);
      expect(gone, `seed ${seed}`).toBeLessThanOrEqual(walk.ms + 2500);
      // It leaves and comes back through the notch's own seat.
      expect(frames[0].x).toBe(home.x);
      expect(frames[phases.indexOf("gone")]).toMatchObject({ x: home.x });
      expect(frames.every((f) => f.progress === null)).toBe(true);
    }
  });

  it("a job taking the walk over keeps it out past the walk's stops", () => {
    const cue = wander(15_000, 2);
    let { sim } = run(roamStart(place, 3), 9000, cue);
    expect(sim.phase).not.toBe("gone");
    ({ sim } = run(sim, 40_000, reading));
    expect(sim.phase).not.toBe("gone");
    expect(sim.stops).toBeGreaterThan(2);
  });

  it("a job that starts while the walk is going in keeps myco out: one exit, never two", () => {
    // The notch and the roam window together, across the enter boundary.
    let shows = 0;
    let phase: RoamPhase = stepRoam(ROAM_HOME, { type: "work", panel: { kind: "idle" }, now: 0 }).phase;
    const send = (e: Parameters<typeof stepRoam>[1]) => {
      const step = stepRoam(phase, e);
      phase = step.phase;
      if (step.show) shows++;
    };
    let now = phase.at === "home" ? (phase.wanderAt as number) : 0;
    send({ type: "tick", now, quiet: true });
    expect(phase.at).toBe("out");
    const until = phase.at === "out" ? (phase.until as number) : 0;
    let cue = phase.at === "out" ? phase.cue : reading;
    let sim = roamStart(place, 5);
    while (sim.phase !== "enter") {
      sim = roamTick(sim, FRAME, { place, cue, pointer: null });
      now += FRAME;
    }
    // The window has started going in while the notch still has the walk out.
    expect(now).toBeLessThan(until);
    send({
      type: "work",
      panel: { kind: "running", percent: 5, detail: "1/20", elapsedMs: 0, job: "ingest" },
      now,
    });
    cue = phase.at === "out" ? phase.cue : cue;
    expect(cue).toMatchObject({ job: "read", outcome: null });
    for (let t = 0; t < 4000; t += FRAME) {
      sim = roamTick(sim, FRAME, { place, cue, pointer: null });
      now += FRAME;
      if (sim.phase === "gone") send({ type: "recalled", now });
    }
    send({ type: "tick", now: now + 2600 });
    expect(sim.phase).not.toBe("gone");
    expect(shows).toBe(1);
  });
});

describe("bouncy hops (amendment 2026-10-04)", () => {
  interface Leg {
    from: Pt;
    goal: Pt;
    /** The hops it set out to make; a run cut short makes fewer. */
    planned: number;
    hops: Hop[];
    /** Frame indexes per hop, and the first frame after the leg. */
    at: number[][];
    after: number;
  }

  /** The same hop, though a run cut short re-issues its landed hop to settle. */
  const sameHop = (a: Hop | undefined, b: Hop) => a !== undefined && a.from === b.from && a.to === b.to;

  /** The legs a run hopped, in order; the last, maybe cut off, is dropped. */
  function legsOf(sims: RoamSim[]): Leg[] {
    const legs: Leg[] = [];
    let open: Leg | null = null;
    sims.forEach((sim, i) => {
      const hop = sim.phase === "hop" ? sim.hop : null;
      if (!hop || !sim.leg || !sim.goal) {
        if (open) open.after = i;
        open = null;
        return;
      }
      if (sim.leg.i === 0 && !sameHop(open?.hops[0], hop)) {
        // A long leg goes in runs: one run ends where the next sets out.
        if (open) open.after = i;
        open = { from: sim.leg.from, goal: sim.leg.to, planned: sim.leg.n, hops: [], at: [], after: -1 };
        legs.push(open);
      }
      if (!open) return;
      if (!sameHop(open.hops[open.hops.length - 1], hop)) {
        open.hops.push(hop);
        open.at.push([]);
      }
      open.at[open.at.length - 1].push(i);
    });
    return legs.filter((l) => l.after > 0);
  }

  const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y);
  const seeds = [1, 2, 3, 4, 5, 6];
  const roams = seeds.map((seed) => run(roamStart(place, seed), 30_000, reading));

  it("a leg's hop count follows from its distance: 2 to 8 hops of 40-70 px", () => {
    for (let d = 80; d <= 560; d += 3) {
      const n = hopCount(d);
      expect(n, `${d}`).toBeGreaterThanOrEqual(2);
      expect(n, `${d}`).toBeLessThanOrEqual(8);
      expect(d / n, `${d}`).toBeGreaterThanOrEqual(40);
      expect(d / n, `${d}`).toBeLessThanOrEqual(70);
    }
    for (let d = 0; d <= 3000; d += 10) {
      expect(hopCount(d)).toBeGreaterThanOrEqual(2);
      expect(hopCount(d)).toBeLessThanOrEqual(8);
      expect(hopCount(d + 10)).toBeGreaterThanOrEqual(hopCount(d));
    }
  });

  it("travels a leg in that many small hops of 260-340 ms, end to end", () => {
    let checked = 0;
    for (const { sims } of roams) {
      for (const leg of legsOf(sims)) {
        expect(leg.hops.length).toBe(hopCount(dist(leg.from, leg.goal)));
        expect(leg.hops[0].from).toEqual(leg.from);
        for (let i = 1; i < leg.hops.length; i++) expect(leg.hops[i].from).toEqual(leg.hops[i - 1].to);
        expect(leg.hops[leg.hops.length - 1].to).toEqual(leg.goal);
        for (const h of leg.hops) {
          const ms = (h.crouch ?? 0) + h.ms;
          expect(ms).toBeGreaterThanOrEqual(260);
          expect(ms).toBeLessThanOrEqual(340);
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it("lands exactly on the waypoint", () => {
    for (const { sims, frames } of roams) {
      for (const leg of legsOf(sims)) {
        const f = frames[leg.after];
        expect([f.x, f.y]).toEqual([leg.goal.x, leg.goal.y]);
        expect(sims[leg.after].at).toEqual(leg.goal);
      }
    }
  });

  it("keeps every frame on screen", () => {
    for (const { frames, phases } of roams) {
      for (const f of frames.slice(phases.indexOf("stop"))) {
        expect(f.x - ROAM_MYCO_PX / 2).toBeGreaterThanOrEqual(0);
        expect(f.x + ROAM_MYCO_PX / 2).toBeLessThanOrEqual(place.width);
        expect(f.y - ROAM_MYCO_PX * f.sy).toBeGreaterThanOrEqual(-1);
        expect(f.y).toBeLessThanOrEqual(place.height);
      }
    }
  });

  it("is sprung like a cartoon: crouch, stretch up, neutral apex, squash down", () => {
    for (const { sims, frames } of roams) {
      for (const leg of legsOf(sims)) {
        leg.hops.forEach((h, k) => {
          const crouch = h.crouch ?? 0;
          const idx = leg.at[k];
          const inCrouch = idx.filter((i) => sims[i].t < crouch).map((i) => frames[i]);
          const inAir = idx.filter((i) => sims[i].t >= crouch && sims[i].t < crouch + h.ms);
          // Anticipation: about 0.8 high by 1.15 wide.
          const low = inCrouch.reduce((a, b) => (b.sy < a.sy ? b : a), inCrouch[0]);
          expect(low.sy).toBeLessThanOrEqual(0.83);
          expect(low.sx).toBeGreaterThanOrEqual(1.1);
          // Takeoff: about 1.15 high by 0.9 wide.
          const high = inAir.map((i) => frames[i]).reduce((a, b) => (b.sy > a.sy ? b : a));
          expect(high.sy).toBeGreaterThanOrEqual(1.1);
          expect(high.sx).toBeLessThanOrEqual(0.93);
          // Apex: neutral.
          const apex = inAir.reduce((a, b) =>
            Math.abs((sims[b].t - crouch) / h.ms - 0.5) < Math.abs((sims[a].t - crouch) / h.ms - 0.5) ? b : a,
          );
          expect(Math.abs(frames[apex].sy - 1)).toBeLessThan(0.05);
          // The landing squash opens the next hop's crouch: about 0.82.
          if (k > 0) expect(frames[idx[0]].sy).toBeCloseTo(0.82, 1);
        });
      }
    }
  });

  it("keeps the volume roughly constant: sx * sy within 0.85-1.15", () => {
    for (const { frames } of roams) {
      for (const f of frames) {
        expect(f.sx * f.sy).toBeGreaterThanOrEqual(0.85);
        expect(f.sx * f.sy).toBeLessThanOrEqual(1.15);
      }
    }
  });

  it("settles the last landing with one small rebound, on the spot", () => {
    for (const { sims, frames } of roams) {
      for (const leg of legsOf(sims)) {
        const h = leg.hops[leg.hops.length - 1];
        const land = (h.crouch ?? 0) + h.ms;
        const settle = leg.at[leg.hops.length - 1].filter((i) => sims[i].t >= land).map((i) => frames[i]);
        expect(settle.length).toBeGreaterThan(10);
        for (const f of settle) expect([f.x, f.y]).toEqual([leg.goal.x, leg.goal.y]);
        // Sampled up to a frame after touchdown, so a little above 0.82.
        expect(settle[0].sy).toBeLessThan(0.87);
        const over = settle.map((f) => f.sy > 1.02);
        const rebounds = over.filter((o, i) => o && !over[i - 1]).length;
        expect(rebounds).toBe(1);
        expect(Math.max(...settle.map((f) => f.sy))).toBeLessThan(1.1);
        expect(settle[settle.length - 1].sy).toBeCloseTo(1, 2);
      }
    }
  });

  it("leans into the travel by no more than 6 degrees, with the cap trailing at the apex", () => {
    for (const { sims, frames, phases } of roams) {
      frames.forEach((f, i) => {
        expect(Math.abs(f.lean ?? 0)).toBeLessThanOrEqual(6);
        if (phases[i] === "stop") expect(f.lean ?? 0).toBe(0);
      });
      for (const leg of legsOf(sims)) {
        const ux = (leg.goal.x - leg.from.x) / dist(leg.from, leg.goal);
        if (Math.abs(ux) < 0.5) continue;
        leg.hops.forEach((h, k) => {
          const crouch = h.crouch ?? 0;
          for (const i of leg.at[k]) {
            const s = (sims[i].t - crouch) / h.ms;
            if (s < 0 || s > 1) continue;
            expect(Math.sign(frames[i].lean ?? 0)).toBe(Math.sign(ux));
            // Rightward, a positive skew puts the cap behind the body.
            if (s > 0.4 && s < 0.6) {
              expect(Math.sign(frames[i].lag ?? 0)).toBe(Math.sign(ux));
              expect(Math.abs(frames[i].lag ?? 0)).toBeGreaterThan(0.5);
            }
          }
        });
      }
    }
  });

  it("keeps every hop small on everyday walks: runs of 2-8 hops of 40-70 px", () => {
    const wander = (ms: number, stops: number): RoamCue => ({
      job: "wander",
      progress: null,
      outcome: null,
      walk: { ms, stops },
    });
    let checked = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const { walk } = wanderPlan(seed * 104_729);
      const { sims } = run(roamStart(place, seed), walk.ms + 8000, wander(walk.ms, walk.stops));
      for (const leg of legsOf(sims)) {
        const d = dist(leg.from, leg.goal);
        expect(leg.planned, `seed ${seed}`).toBeGreaterThanOrEqual(2);
        expect(leg.planned, `seed ${seed}`).toBeLessThanOrEqual(8);
        expect(leg.hops.length, `seed ${seed}`).toBeLessThanOrEqual(leg.planned);
        // Under 80 px two hops can only be shorter: at least two wins.
        if (d < 80) continue;
        for (const h of leg.hops) {
          expect(dist(h.from, h.to), `seed ${seed}`).toBeGreaterThanOrEqual(40 - 1e-9);
          expect(dist(h.from, h.to), `seed ${seed}`).toBeLessThanOrEqual(70 + 1e-9);
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  /** The largest lean change between two frames in a row. */
  const leanJump = (frames: RoamFrame[]) =>
    Math.max(...frames.slice(1).map((f, i) => Math.abs((f.lean ?? 0) - (frames[i].lean ?? 0))));

  /** Run a job roam until myco is in the air, halfway through hop 2 of a long run. */
  function midRun(seed: number): RoamSim | null {
    let sim = roamStart(place, seed);
    for (let i = 0; i < 6000; i++) {
      sim = roamTick(sim, FRAME, { place, cue: reading, pointer: null });
      const h = sim.hop;
      if (sim.phase === "hop" && h && sim.leg && sim.leg.n > 4 && sim.leg.i === 2) {
        if (sim.t >= (h.crouch ?? 0) + h.ms / 2) return sim;
      }
    }
    return null;
  }

  it("work ending mid-run lands that hop and settles before it turns: no lean snap", () => {
    let checked = 0;
    for (let seed = 1; seed <= 50; seed++) {
      const air = midRun(seed);
      if (!air) continue;
      for (const outcome of ["done", "failed"] as const) {
        const cue = { ...reading, outcome };
        const { frames, sims, phases } = run(air, ROAM_BACK_MS, cue);
        expect(phases[phases.length - 1], `seed ${seed} ${outcome}`).toBe("gone");
        const all = [roamFrame(air, reading), ...frames];
        expect(leanJump(all), `seed ${seed} ${outcome}`).toBeLessThanOrEqual(2);
        // The hop in the air lands with its squash before anything else.
        const turned = sims.findIndex((s) => s.phase === "stop" || (s.leg?.i === 0 && s.hop !== air.hop));
        expect(turned, `seed ${seed} ${outcome}`).toBeGreaterThan(0);
        expect(Math.min(...frames.slice(0, turned).map((f) => f.sy))).toBeLessThan(0.87);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(60);
  });

  it("flees a pointer mid-run: a new goal within one hop, and never stands under it", () => {
    let checked = 0;
    for (let seed = 1; seed <= 50; seed++) {
      // The second leg that sets out from a stop, just as it leaves.
      let sim = roamStart(place, seed);
      let starts = 0;
      for (let i = 0; i < 6000 && starts < 2; i++) {
        const was = sim.phase;
        sim = roamTick(sim, FRAME, { place, cue: reading, pointer: null });
        if (was === "stop" && sim.phase === "hop") starts++;
      }
      expect(starts, `seed ${seed}`).toBe(2);
      const goal = sim.goal as Pt;
      const pointer = { x: goal.x, y: goal.y - ROAM_MYCO_PX / 2 };
      const { sims, frames } = run(sim, 8000, reading, () => pointer);
      const moved = sims.findIndex((s) => s.goal !== null && (s.goal.x !== goal.x || s.goal.y !== goal.y));
      expect(moved, `seed ${seed}`).toBeGreaterThanOrEqual(0);
      expect(moved * FRAME, `seed ${seed}`).toBeLessThanOrEqual(360);
      for (const s of sims) if (s.phase === "stop") expect(tooClose(s.at, pointer)).toBe(false);
      expect(leanJump([roamFrame(sim, reading), ...frames]), `seed ${seed}`).toBeLessThanOrEqual(2);
      checked++;
    }
    expect(checked).toBe(50);
  });

  it("slides with no bounce under reduced motion", () => {
    const { sims, frames, phases } = run(atStop(), 20_000, reading, () => null, true);
    const legs = legsOf(sims);
    expect(legs.length).toBeGreaterThan(0);
    frames.forEach((f, i) => {
      if (phases[i] !== "hop") return;
      expect([f.sx, f.sy, f.lean ?? 0, f.lag ?? 0]).toEqual([1, 1, 0, 0]);
    });
    for (const leg of legs) {
      const d = dist(leg.from, leg.goal);
      for (const i of leg.at.flat()) {
        const f = frames[i];
        // On the straight line between the leg's ends.
        const cross = (leg.goal.x - leg.from.x) * (f.y - leg.from.y) - (leg.goal.y - leg.from.y) * (f.x - leg.from.x);
        expect(Math.abs(cross / d)).toBeLessThan(1e-6);
      }
      expect([frames[leg.after].x, frames[leg.after].y]).toEqual([leg.goal.x, leg.goal.y]);
    }
  });

  it("with a hop clip shipped, each hop runs the clip's length and the frame adds no squash", () => {
    const { sims, frames } = run(roamStart(place, 7, null, 400), 20_000, reading);
    const legs = legsOf(sims);
    expect(legs.length).toBeGreaterThan(1);
    for (const leg of legs) {
      for (const h of leg.hops) expect((h.crouch ?? 0) + h.ms + (h.settle ?? 0)).toBe(400);
      for (const i of leg.at.flat()) {
        expect([frames[i].sx, frames[i].sy, frames[i].lag ?? 0, frames[i].act]).toEqual([1, 1, 0, "hop"]);
      }
      expect([frames[leg.after].x, frames[leg.after].y]).toEqual([leg.goal.x, leg.goal.y]);
    }
  });

  it("a hop clip dropped into the motion library is picked up as is", () => {
    const spec = resolveClip(
      "hop",
      { "../assets/mascot/motion/hop.json": { frames: 4, fps: 12, loop: true, pad: 0.15625 } },
      { "../assets/mascot/motion/hop.webp": "/hop.webp" },
    );
    expect(spec).toMatchObject({ frames: 4, fps: 12, loop: true });
    expect(clipMs(spec)).toBeCloseTo(333.33, 1);
    expect(mascotBehaviour("hop").clip).toBe("hop");
  });
});
