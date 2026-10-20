// The roam window's preview (`?window=roam&roamMock=1&roamFrame=N`) and the
// frame model it shares with the live window: where myco pops out, and a walk
// that shows each beat the spec asks to be looked at (docs/specs/
// 2026-10-02-mascot-roam.md, Acceptance › Browser).

import { describe, expect, it } from "vitest";
import { ROAM_MYCO_PX, mycoHome } from "./roam";
import {
  PREVIEW_DONE_MS,
  ROAM_MOCK_BAR,
  mockPlace,
  previewCue,
  previewWalk,
  readRoamMock,
  roamPreviewFrames,
} from "./roamPreview";
import { ROAM_BACK_MS } from "./roamTrigger";

// devMock's 14" MacBook Pro, Dock hidden: 1512×982 pt, a 204 pt cutout.
const place = mockPlace(1512, 982);

describe("mockPlace", () => {
  it("is the 14-inch screen under its notch-tall menu bar", () => {
    expect(ROAM_MOCK_BAR).toBe(37);
    // The collapsed surface starts at the cutout, without a menu-bar wing.
    expect(place).toEqual({
      width: 1512,
      height: 982 - 37,
      notch_left: 654,
    });
  });
});

describe("mycoHome", () => {
  it("enters through the cutout without occupying the menu beside it", () => {
    expect(mycoHome(place)).toEqual({
      x: place.notch_left + ROAM_MYCO_PX / 2,
      y: 0,
    });
  });
});

describe("readRoamMock", () => {
  it("is off without roamMock", () => {
    expect(readRoamMock("?window=roam")).toMatchObject({ on: false, pinned: null, at: null });
  });

  it("pins the live walk at a time, on a failure with roamFail", () => {
    expect(readRoamMock("?window=roam&roamMock=1&roamAt=5000")).toMatchObject({
      at: 5000,
      fail: false,
    });
    expect(readRoamMock("?window=roam&roamMock=1&roamAt=x").at).toBeNull();
    expect(readRoamMock("?window=roam&roamMock=1&roamFail=1").fail).toBe(true);
  });

  it("pins a frame, wrapping past the end, and walks live without one", () => {
    const n = roamPreviewFrames(place).length;
    expect(readRoamMock("?window=roam&roamMock=1")).toEqual({
      on: true,
      pinned: null,
      at: null,
      fail: false,
      wander: false,
    });
    expect(readRoamMock("?window=roam&roamMock=1&roamFrame=2").pinned).toBe(2);
    expect(
      readRoamMock(`?window=roam&roamMock=1&roamFrame=${n + 1}`).pinned,
    ).toBe(1);
    expect(
      readRoamMock("?window=roam&roamMock=1&roamFrame=x").pinned,
    ).toBeNull();
    expect(
      readRoamMock("?window=roam&roamMock=1&roamFrame=-1").pinned,
    ).toBeNull();
  });
});

describe("roamPreviewFrames", () => {
  const frames = roamPreviewFrames(place);
  const home = mycoHome(place);

  it("pops out of the notch first and goes back into it last", () => {
    const pop = frames[0];
    expect(pop.x).toBe(home.x);
    // Part of it still above the window's top edge, in the menu bar.
    expect(pop.y).toBeLessThan(ROAM_MYCO_PX);
    // Stretched along the drop, thin across it.
    expect(pop.sy).toBeGreaterThan(1);
    expect(pop.sx).toBeLessThan(1);
    // Going in under the cutout: shrinking out of view, still squashed.
    const enter = frames[frames.length - 1];
    expect(enter).toMatchObject({ x: home.x, act: "enter" });
    expect(Math.max(enter.sx, enter.sy)).toBeLessThan(1);
    expect(enter.sy).toBeLessThan(enter.sx);
  });

  it("stops with each clip the roam plays, and breathes between", () => {
    const acts = new Set(frames.map((f) => f.act));
    for (const act of ["running", "saving", "rejected", "idle"]) {
      expect(acts).toContain(act);
    }
  });

  it("shows a hop mid-air: above both its neighbours, stretched", () => {
    const i = frames.findIndex(
      (f, k) => k > 0 && f.sy > 1 && f.y > ROAM_MYCO_PX,
    );
    expect(i).toBeGreaterThan(0);
    const hop = frames[i];
    expect(hop.y).toBeLessThan(frames[i - 1].y);
    expect(hop.y).toBeLessThan(frames[i + 1].y);
  });

  it("keeps every stop whole inside the window, in its lower part", () => {
    for (const f of frames.slice(1, -1)) {
      expect(f.x - ROAM_MYCO_PX / 2).toBeGreaterThanOrEqual(0);
      expect(f.x + ROAM_MYCO_PX / 2).toBeLessThanOrEqual(place.width);
      expect(f.y - ROAM_MYCO_PX).toBeGreaterThanOrEqual(0);
      expect(f.y).toBeLessThanOrEqual(place.height);
    }
    const stops = frames.slice(1, -1).filter((f) => f.sy === 1);
    expect(stops.length).toBeGreaterThan(0);
    for (const f of stops) expect(f.y).toBeGreaterThan(place.height / 2);
  });

  it("counts the job's steps up beside myco, never past the total", () => {
    const counted = frames.filter((f) => f.progress !== null);
    expect(counted.length).toBeGreaterThan(0);
    let last = 0;
    for (const { progress } of counted) {
      expect(progress?.done).toBeGreaterThanOrEqual(last);
      expect(progress?.done).toBeLessThanOrEqual(progress?.total ?? 0);
      last = progress?.done ?? 0;
    }
  });

  it("is the same walk for the same window", () => {
    expect(roamPreviewFrames(mockPlace(1512, 982))).toEqual(frames);
  });
});

describe("the live walk's script", () => {
  it("reads with steps counting up, then thinks, then ends", () => {
    expect(previewCue(0, false)).toEqual({
      job: "read",
      progress: { done: 11, total: 20 },
      outcome: null,
    });
    expect(previewCue(9000, false).progress?.done).toBeGreaterThan(11);
    expect(previewCue(16_000, false)).toMatchObject({ job: "think", outcome: null });
    expect(previewCue(PREVIEW_DONE_MS, false).outcome).toBe("done");
    expect(previewCue(PREVIEW_DONE_MS, true).outcome).toBe("failed");
  });

  it("walks the real motion: out of the notch, around, and back in", () => {
    const home = mycoHome(place);
    expect(previewWalk(place, 0, false).frame).toMatchObject({ x: home.x });
    expect(previewWalk(place, 0, false).frame.y).toBeLessThanOrEqual(0);
    const mid = previewWalk(place, 12_000, false);
    expect(mid.sim.stops).toBeGreaterThan(0);
    // Back in before the notch would call it back.
    expect(previewWalk(place, PREVIEW_DONE_MS + ROAM_BACK_MS, false).sim.phase).toBe("gone");
    expect(previewWalk(place, PREVIEW_DONE_MS + ROAM_BACK_MS, true).sim.phase).toBe("gone");
    expect(previewWalk(place, 12_000, false)).toEqual(mid);
  });

  it("with roamWander, walks an everyday walk: no job, no steps, home on its own", () => {
    expect(readRoamMock("?window=roam&roamMock=1&roamWander=1").wander).toBe(true);
    const cue = previewCue(0, false, true);
    expect(cue).toMatchObject({ job: "wander", progress: null, outcome: null });
    const walkMs = cue.walk?.ms ?? 0;
    expect(walkMs).toBeGreaterThanOrEqual(15_000);
    expect(walkMs).toBeLessThanOrEqual(40_000);
    // Its outcome never comes from the script: the walk ends itself.
    expect(previewCue(PREVIEW_DONE_MS + 1, false, true)).toEqual(cue);
    const acts = new Set(
      Array.from({ length: 40 }, (_, i) => previewWalk(place, i * 500, false, true).frame.act),
    );
    expect([...acts].sort()).toEqual(["hop", "idle", "look-around"]);
    expect(previewWalk(place, walkMs + 2500, false, true).sim.phase).toBe("gone");
  });
});
