// Interactive path trace pulse — a small comet of bright dots that travels the
// shortest-path node sequence from the start node to the end node, looping while
// a trace is active. The static path itself is lit by the filament layer; this is
// the moving accent that gives the "tracking start → end" feel.
//
// One THREE.Points cloud of a few staggered dots. Each frame the head advances a
// fraction of the whole path (constant speed regardless of hop count) and the
// trailing dots follow at fixed phase offsets, fading out — a comet tail. Colour
// is the START node's colour (consistent with source-coloured arrows). Positions
// are read live from graphology each frame so the trace tracks the moving layout.
import * as THREE from "three";
import type { VaultGraph } from "./graphData";

const TRAIN = 7; // dots in the comet (head + tail)
const TAIL_GAP = 0.035; // phase spacing between successive tail dots
const SPEED = 0.32; // full-path fractions per second (≈3s end-to-end)
const HEAD_SIZE = 13;

const VERT = /* glsl */ `
attribute float a_psize;
attribute vec3 a_pcolor;
uniform float u_pixelRatio;
varying vec3 v_color;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(a_psize * u_pixelRatio, 2.0, 22.0);
  v_color = a_pcolor;
}
`;

const FRAG = /* glsl */ `
precision mediump float;
varying vec3 v_color;
void main() {
  float d = length(gl_PointCoord - vec2(0.5)) * 2.0;
  float core = 1.0 - smoothstep(0.0, 1.0, d);
  float a = pow(core, 1.5);
  if (a < 0.01) discard;
  gl_FragColor = vec4(v_color * (1.3 + 0.7 * core), a);
}
`;

export class TracePulse {
  readonly points: THREE.Points;
  private geom: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;
  private graph: VaultGraph;
  private path: string[] = []; // ordered node ids, start → end
  private head = 0; // head phase in [0,1) along the whole path
  private color = new THREE.Color(0xffffff);
  private tmp = new THREE.Vector3();

  constructor(graph: VaultGraph, pr: number, dark: boolean) {
    this.graph = graph;
    this.geom = new THREE.BufferGeometry();
    this.geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(TRAIN * 3), 3));
    this.geom.setAttribute("a_pcolor", new THREE.BufferAttribute(new Float32Array(TRAIN * 3), 3));
    this.geom.setAttribute("a_psize", new THREE.BufferAttribute(new Float32Array(TRAIN), 1));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { u_pixelRatio: { value: pr } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: dark ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(this.geom, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3; // above ambient pulses
    this.points.visible = false;
    this.geom.setDrawRange(0, 0);
  }

  setDark(dark: boolean): void {
    this.mat.blending = dark ? THREE.AdditiveBlending : THREE.NormalBlending;
    this.mat.needsUpdate = true;
  }

  setPixelRatio(pr: number): void {
    this.mat.uniforms.u_pixelRatio.value = pr;
  }

  /** Start (or clear) a trace along an ordered node sequence. */
  setPath(path: string[] | null): void {
    const valid = (path ?? []).filter((id) => this.graph.hasNode(id));
    if (valid.length < 2) {
      this.path = [];
      this.points.visible = false;
      this.geom.setDrawRange(0, 0);
      return;
    }
    this.path = valid;
    this.head = 0;
    this.color.set(this.graph.getNodeAttributes(valid[0]).color ?? "#ffffff");
    this.points.visible = true;
    this.geom.setDrawRange(0, TRAIN);
    this.writeSizes();
  }

  private writeSizes(): void {
    const siz = this.geom.getAttribute("a_psize") as THREE.BufferAttribute;
    // Head brightest/biggest, tail shrinks — comet silhouette.
    for (let i = 0; i < TRAIN; i++) siz.setX(i, HEAD_SIZE * (1 - (i / TRAIN) * 0.8));
    siz.needsUpdate = true;
  }

  // Position along the whole path at fraction f in [0,1], written into `out`.
  // Recomputes segment lengths from live positions so the trace tracks the sim.
  private pointAt(f: number, out: THREE.Vector3): void {
    const p = this.path;
    // total length
    let total = 0;
    const seg: number[] = [];
    for (let i = 0; i < p.length - 1; i++) {
      const a = this.graph.getNodeAttributes(p[i]);
      const b = this.graph.getNodeAttributes(p[i + 1]);
      const dx = b.x - a.x,
        dy = b.y - a.y,
        dz = b.z - a.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      seg.push(d);
      total += d;
    }
    if (total < 1e-6) {
      const a = this.graph.getNodeAttributes(p[0]);
      out.set(a.x, a.y, a.z);
      return;
    }
    let target = f * total;
    for (let i = 0; i < seg.length; i++) {
      if (target <= seg[i] || i === seg.length - 1) {
        const local = seg[i] > 1e-6 ? target / seg[i] : 0;
        const a = this.graph.getNodeAttributes(p[i]);
        const b = this.graph.getNodeAttributes(p[i + 1]);
        out.set(
          a.x + (b.x - a.x) * local,
          a.y + (b.y - a.y) * local,
          a.z + (b.z - a.z) * local,
        );
        return;
      }
      target -= seg[i];
    }
  }

  // Advance the comet along the path and repaint. dt in seconds (clamped by the
  // caller). No-op when no trace is active.
  update(dt: number): void {
    if (this.path.length < 2) return;
    this.head = (this.head + SPEED * dt) % 1;
    const pos = this.geom.getAttribute("position") as THREE.BufferAttribute;
    const col = this.geom.getAttribute("a_pcolor") as THREE.BufferAttribute;
    for (let i = 0; i < TRAIN; i++) {
      let f = this.head - i * TAIL_GAP;
      if (f < 0) f += 1; // wrap the tail across the loop seam
      this.pointAt(f, this.tmp);
      pos.setXYZ(i, this.tmp.x, this.tmp.y, this.tmp.z);
      const fade = 1 - (i / TRAIN) * 0.85; // tail dims
      col.setXYZ(i, this.color.r * fade, this.color.g * fade, this.color.b * fade);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
  }

  dispose(): void {
    this.geom.dispose();
    this.mat.dispose();
  }
}
