// Galactic core glow — one warm, softly pulsing halo at each galaxy's hub,
// the bright bulge that makes a star cluster read as an Andromeda-style
// galaxy instead of a swarm. One Points draw call, perspective-sized, colours
// taken from each group's hub star. Dark themes only (additive light).
import * as THREE from "three";
import type { VaultGraph } from "./graphData";

const MAX_CORES = 24;

const CORE_VERT = /* glsl */ `
attribute vec3 a_pcolor;
attribute float a_wsize;
attribute float a_phase;
uniform float u_pixelRatio;
uniform float u_sizeScale;
uniform float u_time;
varying vec3 v_color;
varying float v_pulse;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float dist = max(1.0, -mv.z);
  gl_Position = projectionMatrix * mv;
  // Slow breathing, per-core phase offset so the cluster doesn't blink in step.
  v_pulse = 0.85 + 0.15 * sin(u_time * 0.35 + a_phase);
  gl_PointSize = clamp(a_wsize * v_pulse * u_sizeScale * u_pixelRatio / dist, 6.0, 480.0);
  v_color = a_pcolor;
}
`;

const CORE_FRAG = /* glsl */ `
precision mediump float;
varying vec3 v_color;
varying float v_pulse;
void main() {
  float d = length(gl_PointCoord - vec2(0.5)) * 2.0;
  // Bright warm bulge + a wide soft halo (two-lobe falloff).
  float bulge = pow(max(0.0, 1.0 - d * 2.2), 2.0);
  float halo = pow(max(0.0, 1.0 - d), 3.0) * 0.35;
  float a = (bulge + halo) * 0.55 * v_pulse;
  if (a < 0.01) discard;
  // Whiten the very centre like a dense stellar bulge.
  vec3 col = mix(v_color, vec3(1.0, 0.97, 0.9), bulge * 0.6);
  gl_FragColor = vec4(col * (1.0 + bulge * 0.8), a);
}
`;

export class CoreGlowLayer {
  readonly points: THREE.Points;
  private geom: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;
  private graph: VaultGraph;
  private nodeIds: string[];

  constructor(graph: VaultGraph, nodeIds: string[], pr: number, enabled: boolean) {
    this.graph = graph;
    this.nodeIds = nodeIds;
    this.geom = new THREE.BufferGeometry();
    this.geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_CORES * 3), 3));
    this.geom.setAttribute("a_pcolor", new THREE.BufferAttribute(new Float32Array(MAX_CORES * 3), 3));
    this.geom.setAttribute("a_wsize", new THREE.BufferAttribute(new Float32Array(MAX_CORES), 1));
    this.geom.setAttribute("a_phase", new THREE.BufferAttribute(new Float32Array(MAX_CORES), 1));
    this.geom.setDrawRange(0, 0);
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        u_pixelRatio: { value: pr },
        u_sizeScale: { value: 1 },
        u_time: { value: 0 },
      },
      vertexShader: CORE_VERT,
      fragmentShader: CORE_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(this.geom, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 0; // beneath stars and edges — it's background light
    this.points.visible = enabled;
    this.refresh();
  }

  setEnabled(on: boolean): void {
    this.points.visible = on;
  }

  setSizeScale(s: number): void {
    this.mat.uniforms.u_sizeScale.value = s;
  }

  setNodeIds(ids: string[]): void {
    this.nodeIds = ids;
    this.refresh();
  }

  // Re-derive core positions/colours/sizes from the live groups. Throttled by
  // the caller (galaxy centroids move slowly).
  refresh(): void {
    const cx = new Map<number, number>();
    const cy = new Map<number, number>();
    const cz = new Map<number, number>();
    const cn = new Map<number, number>();
    const color = new Map<number, string>();
    for (const id of this.nodeIds) {
      const a = this.graph.getNodeAttributes(id);
      if (a.community < 0 || a.hidden) continue;
      cx.set(a.community, (cx.get(a.community) ?? 0) + a.x);
      cy.set(a.community, (cy.get(a.community) ?? 0) + a.y);
      cz.set(a.community, (cz.get(a.community) ?? 0) + a.z);
      cn.set(a.community, (cn.get(a.community) ?? 0) + 1);
      if (a.isHub) color.set(a.community, a.color);
    }
    const pos = this.geom.getAttribute("position") as THREE.BufferAttribute;
    const col = this.geom.getAttribute("a_pcolor") as THREE.BufferAttribute;
    const siz = this.geom.getAttribute("a_wsize") as THREE.BufferAttribute;
    const pha = this.geom.getAttribute("a_phase") as THREE.BufferAttribute;
    const c = new THREE.Color();
    let i = 0;
    for (const [cm, n] of cn) {
      if (i >= MAX_CORES) break;
      if (n < 3) continue; // tiny groups get no bulge
      pos.setXYZ(i, cx.get(cm)! / n, cy.get(cm)! / n, cz.get(cm)! / n);
      c.set(color.get(cm) ?? "#cfd8f0");
      col.setXYZ(i, c.r, c.g, c.b);
      // Bulge grows gently with the galaxy's population.
      siz.setX(i, 46 + Math.sqrt(n) * 16);
      pha.setX(i, cm * 1.7);
      i++;
    }
    this.geom.setDrawRange(0, i);
    pos.needsUpdate = true;
    col.needsUpdate = true;
    siz.needsUpdate = true;
    pha.needsUpdate = true;
  }

  update(dt: number): void {
    this.mat.uniforms.u_time.value += dt;
  }

  dispose(): void {
    this.geom.dispose();
    this.mat.dispose();
  }
}
