// "Communication" pulses — bright dots that continuously travel along the edges
// like signals firing through a neural network, so the graph reads as alive.
//
// One THREE.Points cloud of N pulses; each pulse rides one edge with its own
// phase, speed and direction. Every frame each pulse advances along its edge and
// takes the edge's gradient colour at that point. Additive blending + a soft
// disc shader make them glow. Deterministic seeding (seededUnit) so the motion
// is reproducible. Single draw call, O(N) per frame — cheap at a few hundred.
import * as THREE from "three";
import { seededUnit, type VaultGraph } from "./graphData";

// Motion budget: 140 moving additive sparks suffice to imply "alive" without
// reading as fireworks (was 520 — itself a firework grammar).
const MAX_PULSES = 140;
const SPEED_MIN = 0.12; // edge fractions per second
const SPEED_VAR = 0.33;

const PULSE_VERT = /* glsl */ `
attribute float a_psize;
attribute vec3 a_pcolor;
uniform float u_pixelRatio;
varying vec3 v_color;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(a_psize * u_pixelRatio, 1.5, 14.0);
  v_color = a_pcolor;
}
`;

const PULSE_FRAG = /* glsl */ `
precision mediump float;
varying vec3 v_color;
void main() {
  float d = length(gl_PointCoord - vec2(0.5)) * 2.0;
  float core = 1.0 - smoothstep(0.0, 1.0, d);
  float a = pow(core, 1.6);
  if (a < 0.01) discard;
  // Bright hot centre so the additive pipeline + bloom catch it as a signal.
  gl_FragColor = vec4(v_color * (1.2 + 0.8 * core), a);
}
`;

export class PulseLayer {
  readonly points: THREE.Points;
  private geom: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;
  private graph: VaultGraph;
  private edgePairs: [string, string][];
  private count = 0;
  private edgeIdx!: Int32Array; // which edge each pulse rides
  private phase!: Float32Array; // 0..1 position along the edge
  private speed!: Float32Array; // signed (direction baked in)
  private cs = new THREE.Color();
  private ct = new THREE.Color();

  constructor(graph: VaultGraph, edgePairs: [string, string][], pr: number, dark: boolean) {
    this.graph = graph;
    this.edgePairs = edgePairs;
    this.geom = new THREE.BufferGeometry();
    this.mat = new THREE.ShaderMaterial({
      uniforms: { u_pixelRatio: { value: pr } },
      vertexShader: PULSE_VERT,
      fragmentShader: PULSE_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: dark ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(this.geom, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2; // over edges/nodes
    this.rebuildPulses();
  }

  setDark(dark: boolean): void {
    this.mat.blending = dark ? THREE.AdditiveBlending : THREE.NormalBlending;
    this.mat.needsUpdate = true;
  }

  setPixelRatio(pr: number): void {
    this.mat.uniforms.u_pixelRatio.value = pr;
  }

  // Re-snapshot edges (live-ingest rebuild) and reseed the pulse pool.
  setEdges(edgePairs: [string, string][]): void {
    this.edgePairs = edgePairs;
    this.rebuildPulses();
  }

  private rebuildPulses(): void {
    this.count = Math.min(MAX_PULSES, this.edgePairs.length);
    const n = this.count;
    this.edgeIdx = new Int32Array(n);
    this.phase = new Float32Array(n);
    this.speed = new Float32Array(n);
    const E = this.edgePairs.length;
    for (let i = 0; i < n; i++) {
      // Spread pulses across all edges (not just the first n), seeded.
      this.edgeIdx[i] = E > 0 ? Math.floor(seededUnit(`pulse-e-${i}`, 40) * E) % E : 0;
      this.phase[i] = seededUnit(`pulse-p-${i}`, 41);
      const dir = seededUnit(`pulse-d-${i}`, 43) < 0.5 ? -1 : 1;
      this.speed[i] = dir * (SPEED_MIN + seededUnit(`pulse-s-${i}`, 42) * SPEED_VAR);
    }
    this.geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this.geom.setAttribute("a_pcolor", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this.geom.setAttribute("a_psize", new THREE.BufferAttribute(new Float32Array(n), 1));
    const siz = this.geom.getAttribute("a_psize") as THREE.BufferAttribute;
    for (let i = 0; i < n; i++) siz.setX(i, 4 + seededUnit(`pulse-z-${i}`, 44) * 5);
    siz.needsUpdate = true;
    this.geom.setDrawRange(0, n);
  }

  // Advance every pulse along its edge and repaint. dt in seconds (clamped by
  // the caller). Skips when paused (reduced motion) — caller just stops calling.
  update(dt: number): void {
    if (this.count === 0) return;
    const pos = this.geom.getAttribute("position") as THREE.BufferAttribute;
    const col = this.geom.getAttribute("a_pcolor") as THREE.BufferAttribute;
    for (let i = 0; i < this.count; i++) {
      let p = this.phase[i] + this.speed[i] * dt;
      p -= Math.floor(p); // wrap to [0,1)
      this.phase[i] = p;
      const [s, t] = this.edgePairs[this.edgeIdx[i]];
      const sa = this.graph.getNodeAttributes(s);
      const ta = this.graph.getNodeAttributes(t);
      if (sa.hidden || ta.hidden) {
        // Park it far outside the frustum — black colour alone only hides
        // under additive blending; on light themes it drew as a dark dot.
        pos.setXYZ(i, 1e8, 1e8, 1e8);
        col.setXYZ(i, 0, 0, 0);
        continue;
      }
      pos.setXYZ(
        i,
        sa.x + (ta.x - sa.x) * p,
        sa.y + (ta.y - sa.y) * p,
        sa.z + (ta.z - sa.z) * p,
      );
      // Take the edge's gradient colour at this point, with a soft head/tail
      // fade so a pulse brightens mid-edge and dims at the endpoints.
      this.cs.set(sa.color);
      this.ct.set(ta.color);
      const fade = Math.sin(Math.PI * p); // 0 at ends, 1 mid-edge
      col.setXYZ(
        i,
        (this.cs.r + (this.ct.r - this.cs.r) * p) * fade,
        (this.cs.g + (this.ct.g - this.cs.g) * p) * fade,
        (this.cs.b + (this.ct.b - this.cs.b) * p) * fade,
      );
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
  }

  dispose(): void {
    this.geom.dispose();
    this.mat.dispose();
  }
}
