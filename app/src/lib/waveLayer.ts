// Renderer for the neural activation wave (see activationWave.ts for the pure
// plan/timing). Two Points clouds: SPARKS travel the plan's tree edges ring by
// ring, and FLASHES swell each reached node with a soft additive halo. Both
// read live node positions each frame so the wave tracks a settling layout.
// Buffers are (re)allocated per trigger — plans are capped small (≤300 edges,
// ≤400 nodes) and triggers are user clicks, so churn is negligible.
import * as THREE from "three";
import type { VaultGraph } from "./graphData";
import {
  edgeProgress,
  nodeFlash,
  waveDuration,
  type WavePlan,
} from "./activationWave";

// Spark look: small hot dots, screen-sized like the ambient pulses.
const SPARK_VERT = /* glsl */ `
attribute vec3 a_pcolor;
attribute float a_alpha;
uniform float u_pixelRatio;
varying vec3 v_color;
varying float v_alpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(7.0 * u_pixelRatio, 2.0, 16.0);
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
  float core = 1.0 - smoothstep(0.0, 1.0, d);
  float a = pow(core, 1.6) * v_alpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(v_color * (1.3 + 0.7 * core), a);
}
`;

// Flash look: perspective-attenuated halos slightly larger than the node
// sprite, so a firing node visibly swells in place.
const FLASH_VERT = /* glsl */ `
attribute vec3 a_pcolor;
attribute float a_alpha;
attribute float a_wsize;
uniform float u_pixelRatio;
uniform float u_sizeScale;
varying vec3 v_color;
varying float v_alpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float dist = max(1.0, -mv.z);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(a_wsize * u_sizeScale * u_pixelRatio / dist, 2.0, 220.0);
  v_color = a_pcolor;
  v_alpha = a_alpha;
}
`;

const FLASH_FRAG = /* glsl */ `
precision mediump float;
varying vec3 v_color;
varying float v_alpha;
void main() {
  float d = length(gl_PointCoord - vec2(0.5)) * 2.0;
  float glow = pow(max(0.0, 1.0 - d), 2.0);
  float a = glow * v_alpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(v_color * (1.2 + glow), a);
}
`;

// World size of a flash halo per unit of node `size` — a bit past the node
// glow (NODE_RADIUS 3.4 × GLOW_SCALE 3.2) so the swell reads outside the star.
const FLASH_WORLD = 3.4 * 3.2 * 1.5;

export class WaveLayer {
  readonly sparks: THREE.Points;
  readonly flashes: THREE.Points;
  private sparkGeom: THREE.BufferGeometry;
  private flashGeom: THREE.BufferGeometry;
  private sparkMat: THREE.ShaderMaterial;
  private flashMat: THREE.ShaderMaterial;
  private graph: VaultGraph;
  private plan: WavePlan | null = null;
  private t = 0;
  private intensity = 1;
  private c = new THREE.Color();

  constructor(graph: VaultGraph, pr: number, dark: boolean) {
    this.graph = graph;
    this.sparkGeom = new THREE.BufferGeometry();
    this.flashGeom = new THREE.BufferGeometry();
    const blending = dark ? THREE.AdditiveBlending : THREE.NormalBlending;
    this.sparkMat = new THREE.ShaderMaterial({
      uniforms: { u_pixelRatio: { value: pr } },
      vertexShader: SPARK_VERT,
      fragmentShader: SPARK_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending,
    });
    this.flashMat = new THREE.ShaderMaterial({
      uniforms: { u_pixelRatio: { value: pr }, u_sizeScale: { value: 1 } },
      vertexShader: FLASH_VERT,
      fragmentShader: FLASH_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending,
    });
    this.sparks = new THREE.Points(this.sparkGeom, this.sparkMat);
    this.sparks.frustumCulled = false;
    this.sparks.renderOrder = 3; // over edges, pulses and nodes
    this.flashes = new THREE.Points(this.flashGeom, this.flashMat);
    this.flashes.frustumCulled = false;
    this.flashes.renderOrder = 3;
    this.sparkGeom.setDrawRange(0, 0);
    this.flashGeom.setDrawRange(0, 0);
  }

  setDark(dark: boolean): void {
    const blending = dark ? THREE.AdditiveBlending : THREE.NormalBlending;
    this.sparkMat.blending = blending;
    this.flashMat.blending = blending;
    this.sparkMat.needsUpdate = true;
    this.flashMat.needsUpdate = true;
  }

  // px-per-world-unit at unit distance (graphScene.sizeScale) — flashes are
  // perspective-sized like the node sprites.
  setSizeScale(s: number): void {
    this.flashMat.uniforms.u_sizeScale.value = s;
  }

  isActive(): boolean {
    return this.plan != null;
  }

  // Arm a new wave (replacing any running one) or clear with null. `intensity`
  // scales all alphas — 1 for the click impulse, dimmer for idle synapse fires.
  setPlan(plan: WavePlan | null, intensity = 1): void {
    this.plan = plan;
    this.t = 0;
    this.intensity = intensity;
    if (!plan) {
      this.sparkGeom.setDrawRange(0, 0);
      this.flashGeom.setDrawRange(0, 0);
      return;
    }
    const ne = plan.edges.length;
    const nn = plan.nodes.length;
    this.sparkGeom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(ne * 3), 3));
    this.sparkGeom.setAttribute("a_pcolor", new THREE.BufferAttribute(new Float32Array(ne * 3), 3));
    this.sparkGeom.setAttribute("a_alpha", new THREE.BufferAttribute(new Float32Array(ne), 1));
    this.flashGeom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(nn * 3), 3));
    this.flashGeom.setAttribute("a_pcolor", new THREE.BufferAttribute(new Float32Array(nn * 3), 3));
    this.flashGeom.setAttribute("a_alpha", new THREE.BufferAttribute(new Float32Array(nn), 1));
    this.flashGeom.setAttribute("a_wsize", new THREE.BufferAttribute(new Float32Array(nn), 1));
    this.sparkGeom.setDrawRange(0, ne);
    this.flashGeom.setDrawRange(0, nn);
    this.update(0);
  }

  // Advance the wave clock and repaint both clouds from live node positions.
  // Cheap no-op when idle; self-clears once the plan's duration elapses.
  update(dt: number): void {
    const plan = this.plan;
    if (!plan) return;
    this.t += dt;
    if (this.t > waveDuration(plan)) {
      this.setPlan(null);
      return;
    }
    const t = this.t;

    const sPos = this.sparkGeom.getAttribute("position") as THREE.BufferAttribute;
    const sCol = this.sparkGeom.getAttribute("a_pcolor") as THREE.BufferAttribute;
    const sAlp = this.sparkGeom.getAttribute("a_alpha") as THREE.BufferAttribute;
    for (let i = 0; i < plan.edges.length; i++) {
      const e = plan.edges[i];
      const p = edgeProgress(e.depth, t);
      if (p == null || !this.graph.hasNode(e.s) || !this.graph.hasNode(e.t)) {
        sAlp.setX(i, 0);
        continue;
      }
      const sa = this.graph.getNodeAttributes(e.s);
      const ta = this.graph.getNodeAttributes(e.t);
      if (sa.hidden || ta.hidden) {
        sAlp.setX(i, 0);
        continue;
      }
      sPos.setXYZ(
        i,
        sa.x + (ta.x - sa.x) * p,
        sa.y + (ta.y - sa.y) * p,
        sa.z + (ta.z - sa.z) * p,
      );
      // Spark carries the TARGET node's hue toward it (the signal "delivers"
      // the next ring's colour), fading in/out at the endpoints.
      this.c.set(ta.color);
      sCol.setXYZ(i, this.c.r, this.c.g, this.c.b);
      sAlp.setX(i, Math.sin(Math.PI * p) * this.intensity);
    }
    sPos.needsUpdate = true;
    sCol.needsUpdate = true;
    sAlp.needsUpdate = true;

    const fPos = this.flashGeom.getAttribute("position") as THREE.BufferAttribute;
    const fCol = this.flashGeom.getAttribute("a_pcolor") as THREE.BufferAttribute;
    const fAlp = this.flashGeom.getAttribute("a_alpha") as THREE.BufferAttribute;
    const fSiz = this.flashGeom.getAttribute("a_wsize") as THREE.BufferAttribute;
    for (let i = 0; i < plan.nodes.length; i++) {
      const n = plan.nodes[i];
      const k = nodeFlash(n.depth, t);
      if (k <= 0 || !this.graph.hasNode(n.id)) {
        fAlp.setX(i, 0);
        continue;
      }
      const a = this.graph.getNodeAttributes(n.id);
      if (a.hidden) {
        fAlp.setX(i, 0);
        continue;
      }
      fPos.setXYZ(i, a.x, a.y, a.z);
      this.c.set(a.color);
      fCol.setXYZ(i, this.c.r, this.c.g, this.c.b);
      fAlp.setX(i, k * 0.85 * this.intensity);
      // Swell with the flash: halo grows from node-glow size to ×1.5.
      fSiz.setX(i, a.size * FLASH_WORLD * (0.7 + 0.5 * k));
    }
    fPos.needsUpdate = true;
    fCol.needsUpdate = true;
    fAlp.needsUpdate = true;
    fSiz.needsUpdate = true;
  }

  dispose(): void {
    this.sparkGeom.dispose();
    this.flashGeom.dispose();
    this.sparkMat.dispose();
    this.flashMat.dispose();
  }
}
