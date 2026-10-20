// When myco leaves the notch to roam and when it comes back (docs/specs/
// 2026-10-02-mascot-roam.md, decisions 1 and 6): a pure machine over the
// notch's own states, with the roam window's show and hide as its effects.

import { describe, expect, it } from "vitest";
import type { NotchState } from "../components/NotchPanel";
import { EMPTY_CAPTION } from "./liveCaption";
import { NOTCH_IDLE, reduceNotch } from "./notchDriver";
import {
  ROAM_BACK_MS,
  ROAM_DELAY_MS,
  ROAM_HOME,
  WANDER_GAP_MS,
  roamCueFor,
  roamQuiet,
  roamSteps,
  stepRoam,
  wanderPlan,
} from "./roamTrigger";
import type { RoamEvent, RoamPhase, RoamStep } from "./roamTrigger";

const running = (detail = "수확 중 11/20", job?: "index" | "reflect"): NotchState => ({
  kind: "running",
  percent: 55,
  detail,
  elapsedMs: 0,
  job,
});
const saving: NotchState = {
  kind: "saving",
  elapsedMs: 3000,
  caption: EMPTY_CAPTION,
  stage: "transcribing",
  pct: null,
};

/** Feed events in order, collecting every step. */
function walk(events: RoamEvent[], from: RoamPhase = ROAM_HOME): RoamStep[] {
  const steps: RoamStep[] = [];
  let phase = from;
  for (const e of events) {
    const step = stepRoam(phase, e);
    steps.push(step);
    phase = step.phase;
  }
  return steps;
}
const last = (steps: RoamStep[]) => steps[steps.length - 1];
const work = (panel: NotchState, now: number): RoamEvent => ({ type: "work", panel, now });

describe("going out", () => {
  it("waits 2 s after work starts, then shows the roam window once", () => {
    const steps = walk([
      work(running(), 0),
      { type: "tick", now: ROAM_DELAY_MS - 1 },
      { type: "tick", now: ROAM_DELAY_MS },
    ]);
    expect(steps.map((s) => s.phase.at)).toEqual(["due", "due", "out"]);
    expect(steps.map((s) => s.show ?? false)).toEqual([false, false, true]);
  });

  it("never roams for work that ends inside the 2 s", () => {
    const steps = walk([
      work(running(), 0),
      work({ kind: "done", summary: "" }, 1500),
      { type: "tick", now: ROAM_DELAY_MS },
    ]);
    expect(last(steps).phase.at).toBe("home");
    expect(steps.some((s) => s.show)).toBe(false);
  });

  it("counts the 2 s from the start, not from the latest progress line", () => {
    const steps = walk([
      work(running("수확 중 1/20"), 0),
      work(running("수확 중 2/20"), 1500),
      { type: "tick", now: ROAM_DELAY_MS },
    ]);
    expect(last(steps).phase.at).toBe("out");
  });

  it("is one roam: more work joins the one already out", () => {
    const out = walk([work(running(), 0), { type: "tick", now: ROAM_DELAY_MS }]);
    const steps = walk(
      [work(running("Indexing… 3/9", "index"), 2500), work(running("수확 중 12/20"), 3000)],
      last(out).phase,
    );
    expect(steps.every((s) => s.phase.at === "out" && !s.show)).toBe(true);
    expect(last(steps).phase).toMatchObject({ cue: { progress: { done: 12, total: 20 } } });
  });

  it("stays in the notch for good when the window will not show", () => {
    const steps = walk([
      work(running(), 0),
      { type: "tick", now: ROAM_DELAY_MS },
      { type: "shown", ok: false, now: ROAM_DELAY_MS },
      work(running("수확 중 12/20"), 3000),
      { type: "tick", now: 6000 },
    ]);
    expect(steps.slice(2).map((s) => s.phase.at)).toEqual(["spent", "spent", "spent"]);
    expect(steps.slice(3).some((s) => s.show)).toBe(false);
    expect(last(walk([work({ kind: "done", summary: "" }, 7000)], last(steps).phase)).phase.at).toBe(
      "home",
    );
  });
});

describe("coming back", () => {
  const out = last(walk([work(running(), 0), { type: "tick", now: ROAM_DELAY_MS }])).phase;

  it("on done tells the roam window to come back, with nothing hidden yet", () => {
    const step = stepRoam(out, work({ kind: "done", summary: "" }, 5000));
    expect(step.phase).toMatchObject({ at: "back", cue: { outcome: "done" } });
    expect(step.hide).toBeUndefined();
  });

  it("on a failure tells it the work failed", () => {
    const step = stepRoam(out, work({ kind: "rejected", ext: "", reason: "x" }, 5000));
    expect(step.phase).toMatchObject({ at: "back", cue: { outcome: "failed" } });
  });

  it("a long job that fails, through the notch's own reducer, brings myco back on the failure", () => {
    const running = reduceNotch(
      NOTCH_IDLE,
      { type: "statusPush", running: "수확 중 11/20", job: "ingest" },
      0,
    );
    const ended = reduceNotch(running, { type: "statusPush", running: null, failed: ["ingest"] }, 5000);
    const steps = walk([
      work(running.panel, 0),
      { type: "tick", now: ROAM_DELAY_MS },
      work(ended.panel, 5000),
    ]);
    expect(last(steps).phase).toMatchObject({ at: "back", cue: { outcome: "failed" } });
  });

  it("on anything else the notch moved to, comes back plainly", () => {
    for (const panel of [{ kind: "idle" }, { kind: "cancelled" }] as NotchState[]) {
      expect(stepRoam(out, work(panel, 5000)).phase).toMatchObject({ cue: { outcome: "done" } });
    }
  });

  it("is home once the window has ordered out", () => {
    const back = stepRoam(out, work({ kind: "done", summary: "" }, 5000)).phase;
    expect(stepRoam(back, { type: "recalled", now: 6000 }).phase.at).toBe("home");
  });

  it("calls myco back itself if the roam window never does", () => {
    const back = stepRoam(out, work({ kind: "done", summary: "" }, 5000)).phase;
    expect(stepRoam(back, { type: "tick", now: 5000 + ROAM_BACK_MS - 1 }).hide).toBeUndefined();
    const late = stepRoam(back, { type: "tick", now: 5000 + ROAM_BACK_MS });
    expect([late.phase.at, late.hide]).toEqual(["home", true]);
  });

  it("goes out again with work that starts on the way back", () => {
    const back = stepRoam(out, work({ kind: "done", summary: "" }, 5000)).phase;
    const step = stepRoam(back, work(running(), 5300));
    expect(step.phase).toMatchObject({ at: "out", cue: { outcome: null } });
    expect(step.show).toBeUndefined();
  });

  it("called back while the work still runs (a full-screen app, the notch hidden), tries once more after 2 s", () => {
    const steps = walk(
      [{ type: "recalled", now: 4000 }, { type: "tick", now: 4000 + ROAM_DELAY_MS }],
      out,
    );
    expect(steps.map((s) => s.phase.at)).toEqual(["due", "out"]);
    expect(last(steps).show).toBe(true);
  });
});

describe("off switches", () => {
  it("bring myco back at once and keep it home", () => {
    const out = last(walk([work(running(), 0), { type: "tick", now: ROAM_DELAY_MS }])).phase;
    const back = stepRoam(out, work({ kind: "done", summary: "" }, 5000)).phase;
    for (const phase of [out, back]) {
      expect(stepRoam(phase, { type: "off" })).toEqual({ phase: ROAM_HOME, hide: true });
    }
    const due = stepRoam(ROAM_HOME, work(running(), 0)).phase;
    expect(stepRoam(due, { type: "off" })).toEqual({ phase: ROAM_HOME });
  });
});

describe("roamCueFor — the stop clip per job", () => {
  it("reads while reading or ingesting, thinks while saving or reflecting", () => {
    expect(roamCueFor(running("x", "index"))?.job).toBe("read");
    expect(roamCueFor(running("수확 중 3/9"))?.job).toBe("read");
    for (const job of ["ingest", "distill"] as const) {
      expect(roamCueFor({ ...running(), job } as NotchState)?.job).toBe("read");
    }
    for (const job of ["reflect", "ask", "links"] as const) {
      expect(roamCueFor({ ...running(), job } as NotchState)?.job).toBe("think");
    }
    expect(roamCueFor(saving)).toEqual({ job: "think", progress: null, outcome: null });
  });

  it("is null for every state that is not work in progress", () => {
    for (const kind of ["idle", "peek", "done", "rejected", "accepted", "recording", "capture"]) {
      expect(roamCueFor({ kind } as NotchState)).toBeNull();
    }
  });
});

describe("roamSteps", () => {
  it("reads the steps off the running line", () => {
    expect(roamSteps("Indexing… 218/302")).toEqual({ done: 218, total: 302 });
    expect(roamSteps("수확 중 11/20")).toEqual({ done: 11, total: 20 });
    expect(roamSteps("링크 중 0/58")).toEqual({ done: 0, total: 58 });
  });

  it("has none for a line without them, or with nothing to count", () => {
    expect(roamSteps("Reflect running…")).toBeNull();
    expect(roamSteps("72%")).toBeNull();
    expect(roamSteps("3/0")).toBeNull();
  });
});

describe("everyday wandering (amendment 2026-10-03)", () => {
  const idle: NotchState = { kind: "idle" };
  const peek: NotchState = { kind: "peek" };
  /** Home with a walk planned, the way the notch's first idle state leaves it. */
  const rested = (now = 0) => stepRoam(ROAM_HOME, work(idle, now)).phase;
  const wanderAt = (p: RoamPhase): number => (p.at === "home" ? (p.wanderAt ?? NaN) : NaN);
  /** Out on a walk planned at 0, leaving at its time. */
  const walking = () => {
    const at = wanderAt(rested());
    return { at, step: stepRoam(rested(), { type: "tick", now: at, quiet: true }) };
  };

  it("plans 3–8 min gaps and 15–40 s walks of 2–4 stops, the same for the same seed", () => {
    const gaps = new Set<number>();
    for (let seed = 1; seed < 400; seed++) {
      const { gapMs, walk } = wanderPlan(seed * 7919);
      expect(gapMs).toBeGreaterThanOrEqual(WANDER_GAP_MS[0]);
      expect(gapMs).toBeLessThanOrEqual(WANDER_GAP_MS[1]);
      expect(walk.ms).toBeGreaterThanOrEqual(15_000);
      expect(walk.ms).toBeLessThanOrEqual(40_000);
      expect([2, 3, 4]).toContain(walk.stops);
      gaps.add(Math.floor(gapMs / 60_000));
    }
    expect(gaps.size).toBeGreaterThan(3);
    expect(wanderPlan(42)).toEqual(wanderPlan(42));
  });

  it("an idle notch plans the next walk 3–8 min out", () => {
    const at = wanderAt(rested(1000));
    expect(at - 1000).toBeGreaterThanOrEqual(WANDER_GAP_MS[0]);
    expect(at - 1000).toBeLessThanOrEqual(WANDER_GAP_MS[1]);
    // More idle pushes leave the plan alone.
    expect(stepRoam(rested(1000), work(idle, 5000)).phase).toEqual(rested(1000));
  });

  it("goes out once at its time, from the notch, on a walk", () => {
    const { at, step } = walking();
    expect(stepRoam(rested(), { type: "tick", now: at - 1, quiet: true })).toEqual({
      phase: rested(),
    });
    expect(step.show).toBe(true);
    expect(step.phase).toMatchObject({
      at: "out",
      cue: { job: "wander", progress: null, outcome: null },
    });
    const walk = step.phase.at === "out" ? step.phase.cue.walk : undefined;
    expect(walk).toEqual(wanderPlan(at).walk);
  });

  it("never goes out while the notch is open or the pointer is over it", () => {
    const at = wanderAt(rested());
    for (const quiet of [false, undefined]) {
      const step = stepRoam(rested(), { type: "tick", now: at, quiet });
      expect(step.show).toBeUndefined();
      // It waits a whole new gap instead.
      expect(wanderAt(step.phase)).toBeGreaterThanOrEqual(at + WANDER_GAP_MS[0]);
    }
    // The notch's hover peek and every open state are not quiet: the hook
    // only calls it quiet in `idle`.
    expect(roamQuiet(idle)).toBe(true);
    for (const panel of [peek, { kind: "capture", text: "" }, { kind: "done", summary: "" }] as NotchState[]) {
      expect(roamQuiet(panel)).toBe(false);
    }
  });

  it("refused by the roam window (full screen, locked or asleep, no notch), stays in and plans again", () => {
    const { at, step } = walking();
    const refused = stepRoam(step.phase, { type: "shown", ok: false, now: at });
    expect(refused.phase.at).toBe("home");
    expect(wanderAt(refused.phase)).toBeGreaterThanOrEqual(at + WANDER_GAP_MS[0]);
  });

  it("comes home when the walk is done, and plans the next one", () => {
    const { at, step } = walking();
    const walkMs = wanderPlan(at).walk.ms;
    // The roam window brings it back on its own and orders out.
    const home = stepRoam(step.phase, { type: "recalled", now: at + walkMs - 500 });
    expect(home.show).toBeUndefined();
    expect(wanderAt(home.phase)).toBeGreaterThanOrEqual(at + walkMs - 500 + WANDER_GAP_MS[0]);
    // If it has not by the walk's end, the notch says so; past the back stop
    // it orders the window out itself.
    const late = stepRoam(step.phase, { type: "tick", now: at + walkMs });
    expect(late.phase).toMatchObject({ at: "back", cue: { job: "wander", outcome: "done" } });
    const gone = stepRoam(late.phase, { type: "tick", now: at + walkMs + ROAM_BACK_MS });
    expect([gone.phase.at, gone.hide]).toEqual(["home", true]);
  });

  it("an idle push or a hover mid-walk does not end it", () => {
    const { step } = walking();
    for (const panel of [idle, peek]) {
      expect(stepRoam(step.phase, work(panel, 1)).phase).toEqual(step.phase);
    }
  });

  it("a job that starts mid-walk takes the walk over, with no second exit", () => {
    const { at, step } = walking();
    const steps = walk(
      [
        work(running(), at + 3000),
        { type: "tick", now: at + 3000 + ROAM_DELAY_MS },
        { type: "tick", now: at + 60_000 },
        work({ kind: "done", summary: "" }, at + 90_000),
      ],
      step.phase,
    );
    expect(steps.some((s) => s.show || s.hide)).toBe(false);
    expect(steps[0].phase).toEqual({
      at: "out",
      cue: { job: "read", progress: { done: 11, total: 20 }, outcome: null },
    });
    // The walk's own end no longer applies: the job's does.
    expect(steps[2].phase.at).toBe("out");
    expect(last(steps).phase).toMatchObject({ at: "back", cue: { job: "read", outcome: "done" } });
  });

  it("is never out twice: no show without the one before it ending", () => {
    // A day of mixed events: walks, a job, a refusal, a recall, the switch.
    const events: RoamEvent[] = [];
    let now = 0;
    const push = (e: RoamEvent) => events.push(e);
    push(work(idle, now));
    for (let i = 0; i < 6; i++) {
      now += WANDER_GAP_MS[1];
      push({ type: "tick", now, quiet: true });
      push({ type: "shown", ok: i !== 2, now });
      if (i === 1) push(work(running(), now + 1000));
      if (i === 1) push({ type: "tick", now: now + 1000 + ROAM_DELAY_MS });
      if (i === 1) push(work(idle, now + 9000));
      if (i === 4) push({ type: "off" });
      if (i === 4) push(work(idle, now + 100));
      push({ type: "recalled", now: now + 41_000 });
      push({ type: "tick", now: now + 41_000 + ROAM_BACK_MS });
    }
    let out = false;
    for (const s of walk(events)) {
      if (s.show) {
        expect(out).toBe(false);
        out = true;
      }
      if (s.hide || s.phase.at === "home" || s.phase.at === "spent") out = false;
    }
  });

  it("the off switches drop the plan: nothing goes out until it is on again", () => {
    const off = stepRoam(rested(), { type: "off" }).phase;
    expect(off).toBe(ROAM_HOME);
    expect(stepRoam(off, { type: "tick", now: WANDER_GAP_MS[1], quiet: true }).show).toBeUndefined();
  });
});
