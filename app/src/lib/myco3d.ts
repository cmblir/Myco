// myco in 3D: one procedural model (lathe + sphere geometry, no model file),
// two skins, studio lights, and the pure math the Myco3D component turns it
// with. Units: 1 = 100 px of the 384 px pose sheet (assets/mascot/poses), so
// the proportions below are measured straight off those PNGs.

import * as THREE from "three";

export type Myco3DSkin = "black" | "white";

export const MYCO3D_SKINS: readonly Myco3DSkin[] = ["black", "white"];

interface SkinSpec {
  cap: string;
  capUnder: string;
  body: string;
  eye: string;
  /** Eyes glow a little on black so they read in shadow; none on white. */
  eyeGlow: number;
  /** The underside's faint inner glow (the poses' lavender gill light). */
  underGlow: number;
  underGlowColor: string;
  sheen: string;
  key: number;
  rim: string;
  rimIntensity: number;
  fillSky: string;
  fillGround: string;
  fillIntensity: number;
  /** Strength of the room reflection (the sheen and clearcoat need one). */
  env: number;
  /** The solid ground of the preview window. */
  ground: string;
}

export const SKINS: Record<Myco3DSkin, SkinSpec> = {
  black: {
    cap: "#15111c",
    capUnder: "#3b2e5a",
    body: "#17131e",
    eye: "#ffffff",
    eyeGlow: 0.8,
    underGlow: 0.9,
    underGlowColor: "#7a5fd8",
    sheen: "#5a5068",
    key: 1.6,
    rim: "#b08cff",
    rimIntensity: 2.4,
    fillSky: "#d9d2f2",
    fillGround: "#000000",
    fillIntensity: 0.25,
    env: 0.22,
    ground: "#0b0a10",
  },
  white: {
    cap: "#f3f1ee",
    capUnder: "#f7f5f3",
    body: "#efedea",
    eye: "#2b2833",
    eyeGlow: 0,
    underGlow: 0,
    underGlowColor: "#000000",
    sheen: "#ffffff",
    key: 2.4,
    rim: "#ffffff",
    rimIntensity: 1.6,
    fillSky: "#ffffff",
    fillGround: "#6f6c69",
    fillIntensity: 0.55,
    env: 0.4,
    ground: "#dedcd8",
  },
};

/** The height the model turns about (between the eyes and the cap's crown). */
export const MYCO3D_CENTER_Y = 1.25;

type PartName = "cap" | "capUnder" | "body" | "eyeL" | "eyeR" | "handL" | "handR";

export interface Myco3DModel {
  character: THREE.Group;
  parts: Record<PartName, THREE.Mesh>;
  /** Key, rim, fill: fixed to the camera, not turned with the character. */
  lights: THREE.Light[];
  dispose(): void;
}

const v2 = (r: number, y: number): THREE.Vector2 => new THREE.Vector2(r, y);

// Profiles (r, y), measured row by row off the attention and resting poses'
// alpha (ground at the sheet's y 318, axis at the cap's centre x 194). They
// are smoothed through a spline so the lathe has no flat bands. Point order
// sets which way the normals face: up the outside for the cap and body, out
// from the stem for the underside.
const smooth = (pts: THREE.Vector2[]): THREE.Vector2[] =>
  new THREE.SplineCurve(pts).getPoints(pts.length * 8);

const BODY: THREE.Vector2[] = smooth([
  v2(0, 0),
  v2(0.36, 0.02),
  v2(0.56, 0.1),
  v2(0.65, 0.24),
  v2(0.68, 0.44),
  v2(0.67, 0.72),
  v2(0.6, 1.0),
  v2(0.42, 1.24),
  v2(0, 1.32),
]);
const CAP: THREE.Vector2[] = smooth([
  v2(1.0, 0.8),
  v2(1.1, 0.84),
  v2(1.17, 0.92),
  v2(1.21, 1.02),
  v2(1.225, 1.1),
  v2(1.22, 1.18),
  v2(1.185, 1.34),
  v2(1.125, 1.5),
  v2(1.055, 1.66),
  v2(0.97, 1.82),
  v2(0.86, 1.98),
  v2(0.73, 2.14),
  v2(0.56, 2.3),
  v2(0.4, 2.4),
  v2(0.2, 2.48),
  v2(0, 2.51),
]);
const CAP_UNDER: THREE.Vector2[] = smooth([
  v2(0, 1.12),
  v2(0.3, 1.08),
  v2(0.6, 0.98),
  v2(0.85, 0.87),
  v2(1.0, 0.8),
]);

/** Body radius at height y, read off the body profile. */
function bodyRadiusAt(y: number): number {
  for (let i = 1; i < BODY.length; i++) {
    const a = BODY[i - 1];
    const b = BODY[i];
    if (y <= b.y) return a.x + ((b.x - a.x) * (y - a.y)) / (b.y - a.y);
  }
  return 0;
}

const EYE_Y = 0.7;
const EYE_X = 0.14;

export function buildMyco3D(skin: Myco3DSkin): Myco3DModel {
  const s = SKINS[skin];
  const fabric = (color: string): THREE.MeshPhysicalMaterial =>
    new THREE.MeshPhysicalMaterial({
      color,
      roughness: 0.5,
      metalness: 0,
      clearcoat: 0.35,
      clearcoatRoughness: 0.45,
      sheen: 0.7,
      sheenRoughness: 0.5,
      sheenColor: new THREE.Color(s.sheen),
    });

  const lathe = (pts: THREE.Vector2[]): THREE.LatheGeometry =>
    new THREE.LatheGeometry(pts, 96);
  const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material): THREE.Mesh => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = false;
    return m;
  };

  const capMat = fabric(s.cap);
  const underMat = fabric(s.capUnder);
  underMat.emissive.set(s.underGlowColor);
  underMat.emissiveIntensity = s.underGlow;
  const bodyMat = fabric(s.body);
  const eyeMat = new THREE.MeshPhysicalMaterial({
    color: s.eye,
    emissive: new THREE.Color(s.eye),
    emissiveIntensity: s.eyeGlow,
    roughness: 0.25,
    clearcoat: 1,
    sheen: 0.2,
  });

  const cap = mesh(lathe(CAP), capMat);
  const capUnder = mesh(lathe(CAP_UNDER), underMat);
  const body = mesh(lathe(BODY), bodyMat);

  // Oval eyes sit on the body's surface and face out along its normal.
  const eyeGeo = new THREE.SphereGeometry(1, 32, 24);
  eyeGeo.scale(0.062, 0.1, 0.03);
  const r = bodyRadiusAt(EYE_Y);
  const z = Math.sqrt(r * r - EYE_X * EYE_X) + 0.004;
  const eye = (x: number): THREE.Mesh => {
    const e = mesh(eyeGeo, eyeMat);
    e.position.set(x, EYE_Y, z);
    e.rotation.y = Math.asin(x / r);
    return e;
  };
  const eyeL = eye(-EYE_X);
  const eyeR = eye(EYE_X);

  // Orb hands: the right one raised beside the body (attention), the left low.
  const handGeo = new THREE.SphereGeometry(1, 48, 32);
  const handR = mesh(handGeo, bodyMat);
  handR.scale.setScalar(0.33);
  handR.position.set(0.84, 0.5, 0.3);
  // Mostly behind the body from the front, as on the sheet, where only the
  // raised hand shows.
  const handL = mesh(handGeo, bodyMat);
  handL.scale.setScalar(0.25);
  handL.position.set(-0.46, 0.27, -0.52);

  const character = new THREE.Group();
  character.name = "myco3d";
  character.add(body, capUnder, cap, eyeL, eyeR, handL, handR);

  const key = new THREE.DirectionalLight(0xffffff, s.key);
  key.position.set(-3.5, 5, 6);
  const rim = new THREE.DirectionalLight(s.rim, s.rimIntensity);
  rim.position.set(4, 3, -5);
  const fill = new THREE.HemisphereLight(s.fillSky, s.fillGround, s.fillIntensity);

  return {
    character,
    parts: { cap, capUnder, body, eyeL, eyeR, handL, handR },
    lights: [key, rim, fill],
    dispose() {
      for (const g of [cap.geometry, capUnder.geometry, body.geometry, eyeGeo, handGeo]) {
        g.dispose();
      }
      for (const m of [capMat, underMat, bodyMat, eyeMat]) m.dispose();
    },
  };
}

// ---- Turning ----------------------------------------------------------------

export interface Spin {
  yaw: number;
  pitch: number;
  /** Radians per millisecond. */
  vYaw: number;
  vPitch: number;
}

// Tipped 10° toward the camera (negative pitch), so the cap's lavender
// underside shows as a crescent under the front rim, as on the pose sheet.
export const REST_SPIN: Spin = Object.freeze({
  yaw: 0,
  pitch: (-10 * Math.PI) / 180,
  vYaw: 0,
  vPitch: 0,
});
export const PITCH_LIMIT = (25 * Math.PI) / 180;

const RAD_PER_PX = 0.01;
const MAX_V = 0.03;
/** Inertia's time constant: the fling loses 63% of its speed per TAU ms. */
const TAU = 350;
const STOP_V = 2e-5;
const KEY_YAW = (15 * Math.PI) / 180;
const KEY_PITCH = (5 * Math.PI) / 180;

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/** A pointer moved (dx, dy) CSS px over dtMs: turn by it and remember the speed. */
export function dragSpin(s: Spin, dx: number, dy: number, dtMs: number): Spin {
  const dt = Math.max(dtMs, 1);
  const dYaw = dx * RAD_PER_PX;
  const pitch = clamp(s.pitch + dy * RAD_PER_PX, -PITCH_LIMIT, PITCH_LIMIT);
  return {
    yaw: s.yaw + dYaw,
    pitch,
    vYaw: clamp(dYaw / dt, -MAX_V, MAX_V),
    vPitch: clamp((pitch - s.pitch) / dt, -MAX_V, MAX_V),
  };
}

/** One frame of coasting after release: exponential decay, integrated exactly
 *  so a long frame lands where many short ones would. */
export function coastSpin(s: Spin, dtMs: number): Spin {
  const k = Math.exp(-dtMs / TAU);
  const travel = TAU * (1 - k);
  let vYaw = s.vYaw * k;
  let vPitch = s.vPitch * k;
  const yaw = s.yaw + s.vYaw * travel;
  const rawPitch = s.pitch + s.vPitch * travel;
  const pitch = clamp(rawPitch, -PITCH_LIMIT, PITCH_LIMIT);
  if (pitch !== rawPitch) vPitch = 0;
  if (Math.abs(vYaw) < STOP_V) vYaw = 0;
  if (Math.abs(vPitch) < STOP_V) vPitch = 0;
  return { yaw, pitch, vYaw, vPitch };
}

/** The pivot's rotation: yaw about the model's own axis, then pitch about the
 *  camera's horizontal, so a tilt always faces the camera whatever the yaw. */
export function spinEuler(s: Spin): THREE.Euler {
  return new THREE.Euler(s.pitch, s.yaw, 0, "XYZ");
}

export function isCoasting(s: Spin): boolean {
  return s.vYaw !== 0 || s.vPitch !== 0;
}

/** Arrow keys turn in steps; Home turns back to the front. Null: not ours. */
export function keySpin(s: Spin, key: string): Spin | null {
  const still = { ...s, vYaw: 0, vPitch: 0 };
  const pitch = (d: number): number => clamp(s.pitch + d, -PITCH_LIMIT, PITCH_LIMIT);
  switch (key) {
    case "ArrowLeft":
      return { ...still, yaw: s.yaw - KEY_YAW };
    case "ArrowRight":
      return { ...still, yaw: s.yaw + KEY_YAW };
    case "ArrowUp":
      return { ...still, pitch: pitch(-KEY_PITCH) };
    case "ArrowDown":
      return { ...still, pitch: pitch(KEY_PITCH) };
    case "Home":
      return { ...REST_SPIN };
    default:
      return null;
  }
}

// ---- Idle -------------------------------------------------------------------

const BREATH_MS = 4000;
const BLINK_EVERY_MS = 4200;
const BLINK_AT_MS = 3000;
const BLINK_MS = 140;

/** Vertical scale of a slow breath. */
export function breathScale(tMs: number): number {
  return 1 + 0.012 * Math.sin((2 * Math.PI * tMs) / BREATH_MS);
}

/** How open the eyes are: 1 open, 0.1 at the bottom of a blink. */
export function eyeOpen(tMs: number): number {
  const p = (tMs % BLINK_EVERY_MS) - BLINK_AT_MS;
  if (p < 0 || p > BLINK_MS) return 1;
  return 1 - 0.9 * Math.sin((Math.PI * p) / BLINK_MS);
}

// ---- Preview route ----------------------------------------------------------

/** `?window=myco3d&skin=black|white&bg=solid&yaw=<degrees>`. */
export function parseMyco3DParams(search: string): {
  skin: Myco3DSkin;
  solid: boolean;
  yaw: number;
} {
  const q = new URLSearchParams(search);
  const skin = q.get("skin") === "white" ? "white" : "black";
  const deg = Number(q.get("yaw") ?? 0);
  return {
    skin,
    solid: q.get("bg") === "solid",
    yaw: Number.isFinite(deg) ? (deg * Math.PI) / 180 : 0,
  };
}
