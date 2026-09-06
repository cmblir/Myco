// Rare ambient cosmic events — the first ~15 s into a session, then every
// 40–120 s of idle time, either a BLACK HOLE opens near a galaxy (dark core,
// hot spinning accretion disc, a stream of sparks spiralling in) or a
// WORMHOLE bridges two galaxies (a portal ring at each end, particles diving
// into one and bursting out of the other). triggerAt() is the on-demand door.
// Purely visual: the layout is never touched. One event at a time; both
// effects are a couple of point-sprite draw calls with small particle pools.
// Additive light — the scene gates updates to dark skins + ambient motion.
import * as THREE from "three";

const EVENT_GAP_MIN = 40; // seconds between events
const EVENT_GAP_VAR = 80;
// The FIRST event of a session lands fast (~15 s) so people actually see one;
// every later gap uses the full EVENT_GAP range above.
const FIRST_EVENT_DELAY = 15;
// Scheduling/placement use Math.random ON PURPOSE — events should genuinely
// surprise (a different sky every session); only the per-spark constants stay
// seeded so a running event animates coherently.
const BH_DUR = 10; // black hole lifetime
const WH_DUR = 8; // wormhole lifetime
const SPARKS = 64; // shared particle pool size

// Deterministic per-event RNG (same scheme as the meteor layer).
function evSeed(n: number, salt = 0): number {
  let x = ((n + 1) * 1664525 + 1013904223 + salt * 374761393) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 2246822519) >>> 0;
  x ^= x >>> 13;
  return (x >>> 0) / 4294967296;
}

// One perspective-sized sprite whose fragment shader draws the event core:
// u_kind 0 = black hole (dark disc + hot spinning accretion ring),
// u_kind 1 = wormhole portal (cool swirling ring, translucent centre).
const CORE_VERT = /* glsl */ `
uniform float u_pixelRatio;
uniform float u_sizeScale;
uniform float u_wsize;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float dist = max(1.0, -mv.z);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(u_wsize * u_sizeScale * u_pixelRatio / dist, 8.0, 460.0);
}
`;

const CORE_FRAG = /* glsl */ `
precision mediump float;
uniform float u_t;    // 0..1 event life
uniform float u_time; // running clock (spin)
uniform float u_kind; // 0 black hole, 1 wormhole
uniform vec3 u_color;
void main() {
  vec2 p = gl_PointCoord - vec2(0.5);
  float d = length(p) * 2.0;
  float ang = atan(p.y, p.x);
  // Envelope: swell in, hold, collapse out.
  float env = smoothstep(0.0, 0.15, u_t) * (1.0 - smoothstep(0.82, 1.0, u_t));
  // Spinning brightness variation around the ring (two hot lobes, doppler-ish).
  float spin = 0.75 + 0.25 * sin(ang * 2.0 + u_time * (u_kind > 0.5 ? 2.2 : 3.4));
  float ring = exp(-pow((d - 0.52) / 0.10, 2.0)) * spin;
  float haze = exp(-pow((d - 0.52) / 0.30, 2.0)) * 0.25;
  float a = (ring + haze) * env;
  vec3 col = u_color * (1.2 + ring * 1.4);
  if (u_kind < 0.5) {
    // Black hole: the event horizon PUNCHES OUT the centre (normal blending
    // paints it truly black over whatever is behind).
    float hole = 1.0 - smoothstep(0.30, 0.42, d);
    col = mix(col, vec3(0.0), hole);
    a = max(a, hole * env * 0.95);
  } else {
    // Wormhole: faint energy sheet across the throat.
    float sheet = (1.0 - smoothstep(0.0, 0.45, d)) * 0.35 * (0.7 + 0.3 * sin(u_time * 3.0 + d * 9.0));
    a += sheet * env;
  }
  if (a < 0.01) discard;
  gl_FragColor = vec4(col, a);
}
`;

const SPARK_VERT = /* glsl */ `
attribute vec3 a_pcolor;
attribute float a_alpha;
uniform float u_pixelRatio;
varying vec3 v_color;
varying float v_alpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(130.0 * u_pixelRatio / max(1.0, -mv.z), 1.5, 8.0);
  v_color = a_pcolor;
  v_alpha = a_alpha;
}
`;

const SPARK_FRAG = /* glsl */ `
precision mediump float;
varying vec3 v_color;
varying float v_alpha;
void main() {
  float d = length(gl_PointCoord - vec2(0.5)) * 2.0;
  float a = pow(max(0.0, 1.0 - d), 1.8) * v_alpha;
  if (a < 0.02) discard;
  gl_FragColor = vec4(v_color * 1.4, a);
}
`;

const BH_COLOR = new THREE.Color("#ffb36b"); // hot accretion amber
const WH_COLOR = new THREE.Color("#7fd0ff"); // cool portal ice

export type EventKind = "blackhole" | "wormhole";

export class CosmicEvents {
  readonly group = new THREE.Group();
  private coreA: THREE.Points;
  private coreB: THREE.Points; // second portal (wormhole exit); hidden for BH
  private matA: THREE.ShaderMaterial;
  private matB: THREE.ShaderMaterial;
  private sparks: THREE.Points;
  private sparkGeom: THREE.BufferGeometry;
  private sparkMat: THREE.ShaderMaterial;
  private kind: EventKind = "blackhole";
  private active = false;
  private t = 0;
  private dur = BH_DUR;
  private nextIn: number;
  private count = 0; // event counter → deterministic RNG stream
  private posA = new THREE.Vector3();
  private posB = new THREE.Vector3();
  private basisU = new THREE.Vector3();
  private basisV = new THREE.Vector3();
  private c = new THREE.Color();

  constructor(pr: number) {
    const mkCore = (): { pts: THREE.Points; mat: THREE.ShaderMaterial } => {
      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(3), 3));
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          u_pixelRatio: { value: pr },
          u_sizeScale: { value: 1 },
          u_wsize: { value: 80 },
          u_t: { value: 0 },
          u_time: { value: 0 },
          u_kind: { value: 0 },
          u_color: { value: new THREE.Color() },
        },
        vertexShader: CORE_VERT,
        fragmentShader: CORE_FRAG,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        // Normal blending ON PURPOSE: the black hole must darken what's
        // behind it, which additive light can never do.
        blending: THREE.NormalBlending,
      });
      const pts = new THREE.Points(geom, mat);
      pts.frustumCulled = false;
      pts.renderOrder = 5; // above every graph layer
      pts.visible = false;
      return { pts, mat };
    };
    const a = mkCore();
    const b = mkCore();
    this.coreA = a.pts;
    this.matA = a.mat;
    this.coreB = b.pts;
    this.matB = b.mat;
    this.group.add(this.coreA);
    this.group.add(this.coreB);

    this.sparkGeom = new THREE.BufferGeometry();
    this.sparkGeom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(SPARKS * 3), 3));
    this.sparkGeom.setAttribute("a_pcolor", new THREE.BufferAttribute(new Float32Array(SPARKS * 3), 3));
    this.sparkGeom.setAttribute("a_alpha", new THREE.BufferAttribute(new Float32Array(SPARKS), 1));
    this.sparkMat = new THREE.ShaderMaterial({
      uniforms: { u_pixelRatio: { value: pr } },
      vertexShader: SPARK_VERT,
      fragmentShader: SPARK_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    this.sparks = new THREE.Points(this.sparkGeom, this.sparkMat);
    this.sparks.frustumCulled = false;
    this.sparks.renderOrder = 5;
    this.sparks.visible = false;
    this.group.add(this.sparks);

    this.nextIn = FIRST_EVENT_DELAY;
  }

  setSizeScale(s: number): void {
    this.matA.uniforms.u_sizeScale.value = s;
    this.matB.uniforms.u_sizeScale.value = s;
  }

  isActive(): boolean {
    return this.active;
  }

  // Advance the clock; when the countdown lapses ask the scene for galaxy
  // centres and open an event. `centres` must return ≥1 world positions.
  // Frequency multiplier (settings.cosmicFrequency). Higher fires more often;
  // applied by dividing the idle gap. Clamped so a stray 0 can't stall forever.
  private freq = 1;
  setFrequency(f: number): void {
    this.freq = Math.max(0.05, f);
  }

  update(dt: number, centres: () => { x: number; y: number; z: number; r: number }[]): void {
    if (!this.active) {
      // Advance the clock faster when the user wants events more often.
      this.nextIn -= dt * this.freq;
      if (this.nextIn <= 0) this.trigger(centres());
      return;
    }
    this.t += dt;
    if (this.t >= this.dur) {
      this.active = false;
      this.coreA.visible = false;
      this.coreB.visible = false;
      this.sparks.visible = false;
      this.nextIn = EVENT_GAP_MIN + Math.random() * EVENT_GAP_VAR;
      return;
    }
    const life = this.t / this.dur;
    this.matA.uniforms.u_t.value = life;
    this.matA.uniforms.u_time.value += dt;
    if (this.kind === "wormhole") {
      this.matB.uniforms.u_t.value = life;
      this.matB.uniforms.u_time.value += dt;
    }
    this.updateSparks(life);
  }

  /** Open an event of an explicit kind at an explicit world position — the
   * on-demand door beside the random idle scheduler (demos, deletion FX
   * later). One event at a time: a running event wins and the call is
   * dropped. `wsize` is the core's world size (defaults near a mid galaxy). */
  triggerAt(kind: EventKind, pos: { x: number; y: number; z: number }, wsize = 90): void {
    if (this.active) return;
    this.count++;
    this.kind = kind;
    this.active = true;
    this.t = 0;
    this.dur = kind === "blackhole" ? BH_DUR : WH_DUR;
    this.posA.set(pos.x, pos.y, pos.z);
    this.setupCore(this.coreA, this.matA, this.posA, wsize);
    if (kind === "wormhole") {
      // No second anchor is given, so the exit portal opens a short hop away —
      // far enough to read as a bridge, near enough to share the framing.
      this.posB.set(pos.x + wsize * 2.6, pos.y + wsize * 0.9, pos.z - wsize * 1.8);
      this.setupCore(this.coreB, this.matB, this.posB, wsize * 0.75);
    } else {
      this.coreB.visible = false;
    }
    this.openSparks();
  }

  private trigger(centres: { x: number; y: number; z: number; r: number }[]): void {
    if (centres.length === 0) {
      this.nextIn = 10; // no galaxies yet — retry soon
      return;
    }
    this.count++;
    const s = (): number => Math.random();
    this.kind = centres.length > 1 && s() < 0.5 ? "wormhole" : "blackhole";
    this.active = true;
    this.t = 0;
    this.dur = this.kind === "blackhole" ? BH_DUR : WH_DUR;

    const gi = Math.floor(s() * centres.length) % centres.length;
    const ga = centres[gi];
    // Off to the side of the galaxy, not in its core — an event you notice
    // happening NEAR the stars, eating at the edge.
    const off = ga.r * (1.1 + 0.5 * s());
    const theta = s() * Math.PI * 2;
    this.posA.set(
      ga.x + Math.cos(theta) * off,
      ga.y + (s() - 0.5) * ga.r * 0.6,
      ga.z + Math.sin(theta) * off,
    );
    const scale = Math.max(70, ga.r * 0.9);
    this.setupCore(this.coreA, this.matA, this.posA, scale);
    if (this.kind === "wormhole") {
      const gj = (gi + 1 + Math.floor(s() * (centres.length - 1))) % centres.length;
      const gb = centres[gj];
      const theta2 = s() * Math.PI * 2;
      this.posB.set(
        gb.x + Math.cos(theta2) * gb.r * 1.2,
        gb.y + (s() - 0.5) * gb.r * 0.6,
        gb.z + Math.sin(theta2) * gb.r * 1.2,
      );
      this.setupCore(this.coreB, this.matB, this.posB, Math.max(55, gb.r * 0.7));
    } else {
      this.coreB.visible = false;
    }
    this.openSparks();
  }

  // Shared tail of trigger()/triggerAt(): orthonormal basis around the A-core
  // for the spark spiral + make the pool visible.
  private openSparks(): void {
    this.basisU.set(0.7, 0.2, -0.7).normalize();
    this.basisV.crossVectors(this.basisU, new THREE.Vector3(0, 1, 0)).normalize();
    this.sparks.visible = true;
  }

  private setupCore(
    pts: THREE.Points,
    mat: THREE.ShaderMaterial,
    pos: THREE.Vector3,
    wsize: number,
  ): void {
    const p = (pts.geometry as THREE.BufferGeometry).getAttribute(
      "position",
    ) as THREE.BufferAttribute;
    p.setXYZ(0, pos.x, pos.y, pos.z);
    p.needsUpdate = true;
    mat.uniforms.u_wsize.value = wsize;
    mat.uniforms.u_kind.value = this.kind === "blackhole" ? 0 : 1;
    (mat.uniforms.u_color.value as THREE.Color).copy(
      this.kind === "blackhole" ? BH_COLOR : WH_COLOR,
    );
    mat.uniforms.u_t.value = 0;
    pts.visible = true;
  }

  // Black hole: sparks spiral INTO the horizon and vanish. Wormhole: half the
  // pool dives into portal A, the other half erupts out of portal B.
  private updateSparks(life: number): void {
    const pos = this.sparkGeom.getAttribute("position") as THREE.BufferAttribute;
    const col = this.sparkGeom.getAttribute("a_pcolor") as THREE.BufferAttribute;
    const alp = this.sparkGeom.getAttribute("a_alpha") as THREE.BufferAttribute;
    const base = this.kind === "blackhole" ? BH_COLOR : WH_COLOR;
    const reach = (this.matA.uniforms.u_wsize.value as number) * 0.8; // spiral start radius
    for (let i = 0; i < SPARKS; i++) {
      // Each spark loops its own staggered phase over the event.
      const p = (life * (2.2 + evSeed(i, 11) * 1.4) + evSeed(i, 12)) % 1;
      const outbound = this.kind === "wormhole" && i % 2 === 1;
      const from = outbound ? this.posB : this.posA;
      // Infall shrinks the orbit to zero; outflow grows it from zero.
      const r = (outbound ? p : 1 - p) * reach * (0.55 + 0.45 * evSeed(i, 15));
      const swirl =
        evSeed(i, 13) * Math.PI * 2 + p * (6 + evSeed(i, 14) * 4) * (outbound ? -1 : 1);
      const cu = Math.cos(swirl);
      const sv = Math.sin(swirl);
      pos.setXYZ(
        i,
        from.x + (this.basisU.x * cu + this.basisV.x * sv) * r,
        from.y + (this.basisU.y * cu + this.basisV.y * sv) * r,
        from.z + (this.basisU.z * cu + this.basisV.z * sv) * r,
      );
      this.c.copy(base);
      col.setXYZ(i, this.c.r, this.c.g, this.c.b);
      alp.setX(i, Math.sin(Math.PI * p) * 0.8);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    alp.needsUpdate = true;
  }

  dispose(): void {
    (this.coreA.geometry as THREE.BufferGeometry).dispose();
    (this.coreB.geometry as THREE.BufferGeometry).dispose();
    this.matA.dispose();
    this.matB.dispose();
    this.sparkGeom.dispose();
    this.sparkMat.dispose();
  }
}
