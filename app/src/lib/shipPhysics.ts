// Spaceship flight model — pure math (no three.js) so the feel is unit-tested:
// thrust ACCELERATES the ship, exponential drag bleeds speed off when the keys
// lift, and a hard cap keeps flight bounded. Terminal velocity ≈ accel/drag
// sits just under maxSpeed, so holding W settles near the cap instead of
// slamming into it. Banking is a visual: the hull rolls into a turn
// proportionally to the (smoothed) yaw rate, like an aircraft.

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface FlightTuning {
  /** thrust acceleration, world units/s² */
  accel: number;
  /** exponential damping coefficient, 1/s (v ×= e^(−drag·dt) each step) */
  drag: number;
  /** hard speed cap, world units/s */
  maxSpeed: number;
  /** Shift boost multiplier on accel AND the cap */
  boost: number;
  /** max visual bank roll, radians */
  bankMax: number;
  /** bank easing rate, 1/s */
  bankRate: number;
}

export const FLIGHT: FlightTuning = {
  // Tuned against the layout scale (linkDistance 45, framed vault ≈ 1-2k
  // units): cruising crosses a cluster in seconds, not the whole vault —
  // the first cut (950 cap) flew past everything before it registered.
  accel: 900,
  drag: 2.6, // terminal ≈ 900/2.6 ≈ 346 — just under the cap
  maxSpeed: 360,
  boost: 2.5,
  bankMax: 0.55,
  bankRate: 6,
};

// One integration step. `thrustDir` is the WORLD-space thrust direction (unit
// length, or zero when coasting); returns the new velocity. Drag applies every
// step — releasing the keys glides the ship to a stop instead of freezing it.
export function stepVelocity(
  vel: Vec3,
  thrustDir: Vec3,
  boosting: boolean,
  dt: number,
  tune: FlightTuning = FLIGHT,
): Vec3 {
  const a = tune.accel * (boosting ? tune.boost : 1) * dt;
  let x = vel.x + thrustDir.x * a;
  let y = vel.y + thrustDir.y * a;
  let z = vel.z + thrustDir.z * a;
  const k = Math.exp(-tune.drag * dt);
  x *= k;
  y *= k;
  z *= k;
  const cap = tune.maxSpeed * (boosting ? tune.boost : 1);
  const sp = Math.hypot(x, y, z);
  if (sp > cap) {
    const f = cap / sp;
    x *= f;
    y *= f;
    z *= f;
  }
  return { x, y, z };
}

export function speedOf(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

// Ease the visual bank roll toward −yawRate (turn left ⇒ roll left), clamped
// to bankMax. Frame-rate independent (exponential smoothing over dt).
export function stepBank(
  bank: number,
  yawRate: number,
  dt: number,
  tune: FlightTuning = FLIGHT,
): number {
  const target = Math.max(-tune.bankMax, Math.min(tune.bankMax, -yawRate * 0.9));
  const t = 1 - Math.exp(-tune.bankRate * dt);
  return bank + (target - bank) * t;
}
