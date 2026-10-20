// The spin viewer's maps (spec 2026-10-04-myco-spin.md): pointer, keys and
// time to the turntable's playhead.

import { describe, expect, it } from "vitest";
import {
  IDLE_AFTER_MS,
  SPIN_TURN_S,
  dragToTime,
  dragVelocity,
  frameTime,
  idleTurn,
  inertia,
  keyToTime,
  wrap,
} from "./mycoSpin";

describe("wrap", () => {
  it("folds any time into one turn, past both ends", () => {
    expect(wrap(1.5)).toBeCloseTo(1.5);
    expect(wrap(SPIN_TURN_S + 1)).toBeCloseTo(1);
    expect(wrap(-1)).toBeCloseTo(SPIN_TURN_S - 1);
    expect(wrap(-3 * SPIN_TURN_S)).toBeCloseTo(0);
    expect(wrap(SPIN_TURN_S)).toBe(0);
  });
});

describe("dragToTime", () => {
  it("is one whole turn for a drag across the element", () => {
    expect(dragToTime(1, 300, 300)).toBeCloseTo(1);
    expect(dragToTime(1, -300, 300)).toBeCloseTo(1);
  });

  it("turns the front the way the pointer goes (the video turns it left)", () => {
    // Dragging left pulls the front left: forward in the video.
    expect(dragToTime(0, -75, 300)).toBeCloseTo(SPIN_TURN_S / 4);
    expect(dragToTime(0, 75, 300)).toBeCloseTo((3 * SPIN_TURN_S) / 4);
  });

  it("does not move on an element with no width yet", () => {
    expect(dragToTime(2, 50, 0)).toBe(2);
  });
});

describe("inertia", () => {
  it("coasts the way it was flung and slows down", () => {
    const a = inertia(0, 0.002, 16);
    expect(a.t).toBeGreaterThan(0);
    expect(Math.abs(a.v)).toBeLessThan(0.002);
  });

  it("lands in the same place for one long frame as for many short ones", () => {
    let s = { t: 1, v: -0.003 };
    for (let i = 0; i < 10; i++) s = inertia(s.t, s.v, 10);
    const once = inertia(1, -0.003, 100);
    expect(once.t).toBeCloseTo(s.t, 6);
  });

  it("wraps through the front and comes to a stop", () => {
    let s = { t: 0.1, v: -0.01 };
    for (let i = 0; i < 400 && s.v !== 0; i++) s = inertia(s.t, s.v, 16);
    expect(s.v).toBe(0);
    expect(s.t).toBeGreaterThanOrEqual(0);
    expect(s.t).toBeLessThan(SPIN_TURN_S);
  });
});

describe("dragVelocity", () => {
  it("is the drag's playhead speed per ms, capped", () => {
    expect(dragVelocity(-30, 300, 100)).toBeCloseTo(SPIN_TURN_S / 10 / 100);
    expect(Math.abs(dragVelocity(-3000, 300, 1))).toBeLessThan(0.05);
  });
});

describe("keyToTime", () => {
  it("steps 15 degrees per arrow press, the way the arrow points", () => {
    expect(keyToTime(0, "ArrowLeft")).toBeCloseTo(SPIN_TURN_S / 24);
    expect(keyToTime(0, "ArrowRight")).toBeCloseTo(SPIN_TURN_S - SPIN_TURN_S / 24);
  });

  it("goes back to the front on Home and ignores other keys", () => {
    expect(keyToTime(3.2, "Home")).toBe(0);
    expect(keyToTime(3.2, "ArrowUp")).toBeNull();
    expect(keyToTime(3.2, "a")).toBeNull();
  });
});

describe("idleTurn", () => {
  it("holds still until 4 s without a touch, then turns slowly", () => {
    expect(idleTurn(1, 16, IDLE_AFTER_MS - 1, false)).toBe(1);
    const t = idleTurn(1, 16, IDLE_AFTER_MS, false);
    expect(t).toBeGreaterThan(1);
    expect(t - 1).toBeLessThan(0.01);
  });

  it("never turns on its own under reduced motion", () => {
    expect(idleTurn(1, 16, 60_000, true)).toBe(1);
  });
});

describe("frameTime", () => {
  it("seeks to the middle of the frame that time falls in", () => {
    expect(frameTime(0)).toBeCloseTo(0.5 / 24);
    expect(frameTime(1 / 24 + 0.001)).toBeCloseTo(1.5 / 24);
    expect(frameTime(SPIN_TURN_S - 0.0001)).toBeCloseTo(143.5 / 24);
  });
});
