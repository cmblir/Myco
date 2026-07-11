// Inertial flight model (pure math driven by shipController).
import { describe, expect, it } from "vitest";
import { FLIGHT, speedOf, stepBank, stepVelocity } from "./shipPhysics";

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
