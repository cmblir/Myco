// Inertial flight model (pure math driven by shipController).
import { describe, expect, it } from "vitest";
import {
  BOOST_BLEND_DOWN,
  BOOST_BLEND_UP,
  FLIGHT,
  boostBlend,
  speedOf,
  stepBank,
  stepVelocity,
} from "./shipPhysics";

const FWD = { x: 0, y: 0, z: -1 };
const ZERO = { x: 0, y: 0, z: 0 };
const DT = 1 / 60;

function fly(steps: number, thrust = FWD, boost = false): { x: number; y: number; z: number } {
  let v = ZERO;
  for (let i = 0; i < steps; i++) v = stepVelocity(v, thrust, boost, DT);
  return v;
}

describe("stepVelocity", () => {
  it("accelerates under thrust", () => {
    const v1 = fly(1);
    const v2 = fly(10);
    expect(speedOf(v1)).toBeGreaterThan(0);
    expect(speedOf(v2)).toBeGreaterThan(speedOf(v1));
  });

  it("settles at a terminal speed under the cap (drag balances thrust)", () => {
    const v = fly(60 * 20); // 20 s of full thrust
    const terminal = speedOf(v);
    expect(terminal).toBeLessThanOrEqual(FLIGHT.maxSpeed);
    expect(terminal).toBeGreaterThan(FLIGHT.maxSpeed * 0.75);
    // Another second of thrust barely changes it — it's settled.
    let v2 = v;
    for (let i = 0; i < 60; i++) v2 = stepVelocity(v2, FWD, false, DT);
    expect(Math.abs(speedOf(v2) - terminal)).toBeLessThan(terminal * 0.02);
  });

  it("glides to a stop when thrust lifts (exponential drag, no hard stop)", () => {
    let v = fly(120);
    const cruising = speedOf(v);
    for (let i = 0; i < 30; i++) v = stepVelocity(v, ZERO, false, DT);
    const after = speedOf(v);
    expect(after).toBeLessThan(cruising); // decaying…
    expect(after).toBeGreaterThan(0); // …but not frozen
    for (let i = 0; i < 60 * 5; i++) v = stepVelocity(v, ZERO, false, DT);
    expect(speedOf(v)).toBeLessThan(cruising * 0.01); // effectively stopped
  });

  it("boost raises both acceleration and the speed cap", () => {
    const plain = speedOf(fly(60 * 20));
    const boosted = speedOf(fly(60 * 20, FWD, true));
    expect(boosted).toBeGreaterThan(plain * 1.5);
    expect(boosted).toBeLessThanOrEqual(FLIGHT.maxSpeed * FLIGHT.boost);
  });

  it("never exceeds the cap even with an absurd dt spike", () => {
    const v = stepVelocity(ZERO, FWD, true, 10);
    expect(speedOf(v)).toBeLessThanOrEqual(FLIGHT.maxSpeed * FLIGHT.boost + 1e-9);
  });
});

describe("stepBank", () => {
  it("rolls toward the turn and clamps at bankMax", () => {
    let bank = 0;
    for (let i = 0; i < 120; i++) bank = stepBank(bank, 5, DT); // hard left yaw
    expect(bank).toBeLessThan(0); // rolls INTO the turn (negative roll)
    expect(Math.abs(bank)).toBeLessThanOrEqual(FLIGHT.bankMax + 1e-9);
    expect(Math.abs(bank)).toBeGreaterThan(FLIGHT.bankMax * 0.9); // saturated
  });

  it("eases back to level when the yaw stops", () => {
    let bank = -FLIGHT.bankMax;
    for (let i = 0; i < 60 * 3; i++) bank = stepBank(bank, 0, DT);
    expect(Math.abs(bank)).toBeLessThan(0.01);
  });
});

describe("boostBlend", () => {
  it("rises monotonically to 1 while boosting and converges there", () => {
    let b = 0;
    let prev = 0;
    const steps = Math.ceil((BOOST_BLEND_UP / DT) * 1.5); // 1.5× the ramp time
    for (let i = 0; i < steps; i++) {
      b = boostBlend(b, true, DT);
      expect(b).toBeGreaterThanOrEqual(prev); // monotonic up
      expect(b).toBeLessThanOrEqual(1); // clamped
      prev = b;
    }
    expect(b).toBe(1); // fully engaged…
    expect(boostBlend(b, true, DT)).toBe(1); // …and stable there
  });

  it("falls monotonically back to 0 when boost ends and converges there", () => {
    let b = 1;
    let prev = 1;
    const steps = Math.ceil((BOOST_BLEND_DOWN / DT) * 1.5);
    for (let i = 0; i < steps; i++) {
      b = boostBlend(b, false, DT);
      expect(b).toBeLessThanOrEqual(prev); // monotonic down
      expect(b).toBeGreaterThanOrEqual(0); // clamped
      prev = b;
    }
    expect(b).toBe(0); // fully released…
    expect(boostBlend(b, false, DT)).toBe(0); // …and stable there
  });

  it("engages faster than it releases (asymmetric ramp)", () => {
    const up = boostBlend(0, true, DT) - 0;
    const down = 1 - boostBlend(1 - 1e-9, false, DT);
    expect(up).toBeGreaterThan(down);
    // And the ramp times land where they're tuned: ~0.25 s up, ~0.4 s down
    // (toBeCloseTo — 1/0.4 isn't exact in binary floating point).
    expect(boostBlend(0, true, BOOST_BLEND_UP)).toBeCloseTo(1, 9);
    expect(boostBlend(1, false, BOOST_BLEND_DOWN)).toBeCloseTo(0, 9);
  });

  it("clamps even with dt spikes and out-of-range inputs", () => {
    expect(boostBlend(0, true, 10)).toBe(1); // huge frame while boosting
    expect(boostBlend(1, false, 10)).toBe(0); // huge frame on release
    expect(boostBlend(5, false, DT)).toBe(1); // garbage above the range
    expect(boostBlend(-3, true, DT)).toBeGreaterThanOrEqual(0); // and below
    expect(boostBlend(-3, true, DT)).toBeLessThanOrEqual(1);
  });
});
