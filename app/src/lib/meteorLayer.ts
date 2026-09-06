// Shooting stars — an occasional meteor streaks across the deep-space
// background (galaxy skin only). Each meteor is a short fading line trail that
// crosses the starfield shells tangentially every 8–20 s; at most MAX_METEORS
// fly at once, so the layer is one LineSegments draw call with a tiny fixed
// buffer. Deterministic seeding (seededUnit over a spawn counter) keeps the
// shower reproducible across sessions.
import * as THREE from "three";
import { seededUnit } from "./graphData";

const MAX_METEORS = 3;
const TRAIL_POINTS = 7; // head + 6 tail samples → 6 segments
const SEGS = TRAIL_POINTS - 1;
// Spawn shell: inside the far starfield (r 2400–6400) so meteors read as sky.
const SPAWN_R0 = 2600;
const SPAWN_R1 = 3800;
const SPEED_MIN = 1400; // world units / s
const SPEED_VAR = 1200;
const LIFE_MIN = 1.1; // seconds
const LIFE_VAR = 0.9;
const TRAIL_MIN = 320; // world-unit trail length
const TRAIL_VAR = 260;
const SPAWN_GAP_MIN = 8; // seconds between spawns
const SPAWN_GAP_VAR = 12;
const HEAD_COLOR = new THREE.Color("#dcebff");

interface Meteor {
  active: boolean;
  pos: THREE.Vector3;
  dir: THREE.Vector3;
  speed: number;
  life: number;
  age: number;
  trail: number;
}

export class MeteorLayer {
  readonly lines: THREE.LineSegments;
  private geom: THREE.BufferGeometry;
  private mat: THREE.LineBasicMaterial;
  private meteors: Meteor[] = [];
  private nextSpawn: number;
  private spawnCount = 0;
  private v = new THREE.Vector3();

  constructor() {
    this.geom = new THREE.BufferGeometry();
    const verts = MAX_METEORS * SEGS * 2;
    this.geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
    this.geom.setAttribute("color", new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
    this.mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending, // galaxy skin is always a dark void
      fog: false,
    });
    this.lines = new THREE.LineSegments(this.geom, this.mat);
    this.lines.frustumCulled = false;
    for (let i = 0; i < MAX_METEORS; i++) {
      this.meteors.push({
        active: false,
        pos: new THREE.Vector3(),
        dir: new THREE.Vector3(),
        speed: 0,
        life: 0,
        age: 0,
        trail: 0,
      });
    }
    this.nextSpawn = this.gap();
  }

  private rand(salt: number): number {
    return seededUnit(`meteor-${this.spawnCount}`, salt);
  }

  private gap(): number {
    return SPAWN_GAP_MIN + this.rand(70) * SPAWN_GAP_VAR;
  }

  private spawn(): void {
    const m = this.meteors.find((x) => !x.active);
    if (!m) return;
    this.spawnCount++;
    // Random point on the spawn shell…
    const theta = this.rand(71) * Math.PI * 2;
    const phi = Math.acos(2 * this.rand(72) - 1);
    const r = SPAWN_R0 + this.rand(73) * (SPAWN_R1 - SPAWN_R0);
    const sp = Math.sin(phi);
    m.pos.set(Math.cos(theta) * r * sp, Math.sin(theta) * r * sp, Math.cos(phi) * r);
    // …flying tangentially (⊥ to the radial) so it crosses the sky instead of
    // diving at the camera: dir = normalize(randomVec × radial).
    const rt = this.rand(74) * Math.PI * 2;
    const rp = Math.acos(2 * this.rand(75) - 1);
    const rs = Math.sin(rp);
    this.v.set(Math.cos(rt) * rs, Math.sin(rt) * rs, Math.cos(rp));
    m.dir.crossVectors(this.v, m.pos);
    if (m.dir.lengthSq() < 1e-6) m.dir.set(1, 0, 0);
    m.dir.normalize();
    m.speed = SPEED_MIN + this.rand(76) * SPEED_VAR;
    m.life = LIFE_MIN + this.rand(77) * LIFE_VAR;
    m.trail = TRAIL_MIN + this.rand(78) * TRAIL_VAR;
    m.age = 0;
    m.active = true;
  }

  // Advance meteors + spawn clock, rewrite the trail buffers. The caller gates
  // this on ambient motion / interaction / skin, so no checks here.
  update(dt: number): void {
    this.nextSpawn -= dt;
    if (this.nextSpawn <= 0) {
      this.spawn();
      this.nextSpawn = this.gap();
    }
    const pos = this.geom.getAttribute("position") as THREE.BufferAttribute;
    const col = this.geom.getAttribute("color") as THREE.BufferAttribute;
    for (let i = 0; i < MAX_METEORS; i++) {
      const m = this.meteors[i];
      const base = i * SEGS * 2;
      if (m.active) {
        m.age += dt;
        if (m.age >= m.life) m.active = false;
      }
      if (!m.active) {
        for (let k = 0; k < SEGS * 2; k++) col.setXYZ(base + k, 0, 0, 0);
        continue;
      }
      m.pos.addScaledVector(m.dir, m.speed * dt);
      // Whole-streak envelope: ease in, burn, fade out.
      const env = Math.sin(Math.PI * (m.age / m.life));
      // TRAIL_POINTS samples from the head backwards; brightness falls to 0 at
      // the tail tip so the streak reads as a comet, not a stick.
      const step = m.trail / SEGS;
      for (let s = 0; s < SEGS; s++) {
        const aHead = 1 - s / SEGS;
        const aTail = 1 - (s + 1) / SEGS;
        const o = base + s * 2;
        pos.setXYZ(
          o,
          m.pos.x - m.dir.x * step * s,
          m.pos.y - m.dir.y * step * s,
          m.pos.z - m.dir.z * step * s,
        );
        pos.setXYZ(
          o + 1,
          m.pos.x - m.dir.x * step * (s + 1),
          m.pos.y - m.dir.y * step * (s + 1),
          m.pos.z - m.dir.z * step * (s + 1),
        );
        const kh = env * aHead * aHead;
        const kt = env * aTail * aTail;
        col.setXYZ(o, HEAD_COLOR.r * kh, HEAD_COLOR.g * kh, HEAD_COLOR.b * kh);
        col.setXYZ(o + 1, HEAD_COLOR.r * kt, HEAD_COLOR.g * kt, HEAD_COLOR.b * kt);
      }
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
  }

  dispose(): void {
    this.geom.dispose();
    this.mat.dispose();
  }
}
