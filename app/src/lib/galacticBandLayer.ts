// Per-galaxy dust bands — a faint ring of white dust hugging each LARGE
// galaxy's own disc plane (the spiral-arm haze around Andromeda), slowly
// wheeling with it. Replaces the old sky-wide Milky-Way stripe, which filled
// the whole viewport with meaningless dots on big vaults and made real nodes
// indistinguishable. Dust is world-sized (perspective-attenuated) and dim, so
// it reads as part of its galaxy, never as foreground stars. One draw call.
import * as THREE from "three";
import type { VaultGraph } from "./graphData";
import { galaxyNormal } from "./galaxyLayout";

// Only galaxies with real population get a band, grains scale with size.
const MIN_MEMBERS = 10;
const GRAINS_PER_MEMBER = 6;
const GRAINS_MIN = 60;
const GRAINS_MAX = 320;
const TOTAL_CAP = 2400;
// Band shape relative to the galaxy's star radius R: an annulus just outside
// the stars, thin along the disc normal.
const RADIUS_LO = 0.85;
const RADIUS_HI = 1.55;
const THICKNESS = 0.14; // × R along the normal
const SPIN_MIN = 0.02; // rad/s — dust wheels a touch slower than the stars
const SPIN_VAR = 0.03;

// Deterministic LCG stream (same recipe as the starfield).
function rand(n: number): number {
  let x = (n * 1664525 + 1013904223) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 2246822519) >>> 0;
  x ^= x >>> 13;
  return (x >>> 0) / 4294967296;
}

const DUST_VERT = /* glsl */ `
attribute float a_alpha;
uniform float u_pixelRatio;
uniform float u_sizeScale;
varying float v_alpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float dist = max(1.0, -mv.z);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(1.6 * u_sizeScale * u_pixelRatio / dist, 0.8, 3.2);
  v_alpha = a_alpha;
}
`;

const DUST_FRAG = /* glsl */ `
precision mediump float;
varying float v_alpha;
void main() {
  float d = length(gl_PointCoord - vec2(0.5)) * 2.0;
  float a = (1.0 - smoothstep(0.2, 1.0, d)) * v_alpha;
  if (a < 0.02) discard;
  gl_FragColor = vec4(vec3(0.82, 0.87, 0.96), a);
}
`;

interface Grain {
  community: number;
  angle: number; // base angle on the disc
  radius01: number; // RADIUS_LO..RADIUS_HI (× galaxy R)
  off: number; // -1..1 (× THICKNESS × R along the normal)
  speed: number; // rad/s
}

export class GalacticBandLayer {
  readonly points: THREE.Points;
  private geom: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;
  private graph: VaultGraph;
  private nodeIds: string[];
  private grains: Grain[] = [];
  private basisU = new Map<number, THREE.Vector3>();
  private basisV = new Map<number, THREE.Vector3>();
  private t = 0;

  constructor(graph: VaultGraph, nodeIds: string[], pr: number) {
    this.graph = graph;
    this.nodeIds = nodeIds;
    this.geom = new THREE.BufferGeometry();
    this.geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(TOTAL_CAP * 3), 3));
    this.geom.setAttribute("a_alpha", new THREE.BufferAttribute(new Float32Array(TOTAL_CAP), 1));
    this.geom.setDrawRange(0, 0);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { u_pixelRatio: { value: pr }, u_sizeScale: { value: 1 } },
      vertexShader: DUST_VERT,
      fragmentShader: DUST_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(this.geom, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 0; // background haze, under stars and edges
    this.rebuildGrains();
  }

  setSizeScale(s: number): void {
    this.mat.uniforms.u_sizeScale.value = s;
  }

  setNodeIds(ids: string[]): void {
    this.nodeIds = ids;
    this.rebuildGrains();
  }

  // Allocate grains per sized galaxy (deterministic). Membership changes only
  // on graph rebuilds.
  private rebuildGrains(): void {
    const counts = new Map<number, number>();
    for (const id of this.nodeIds) {
      const a = this.graph.getNodeAttributes(id);
      if (a.community >= 0) counts.set(a.community, (counts.get(a.community) ?? 0) + 1);
    }
    this.grains = [];
    this.basisU.clear();
    this.basisV.clear();
    let seed = 1;
    for (const [c, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      if (n < MIN_MEMBERS) continue;
      const want = Math.min(GRAINS_MAX, Math.max(GRAINS_MIN, n * GRAINS_PER_MEMBER));
      if (this.grains.length + want > TOTAL_CAP) break;
      const nm = galaxyNormal(c);
      const normal = new THREE.Vector3(nm.x, nm.y, nm.z);
      const u = new THREE.Vector3(0, 1, 0).cross(normal);
      if (u.lengthSq() < 1e-4) u.set(1, 0, 0);
      u.normalize();
      const v = new THREE.Vector3().crossVectors(normal, u).normalize();
      this.basisU.set(c, u);
      this.basisV.set(c, v);
      for (let i = 0; i < want; i++) {
        this.grains.push({
          community: c,
          angle: rand(seed++) * Math.PI * 2,
          radius01: RADIUS_LO + rand(seed++) * (RADIUS_HI - RADIUS_LO),
          off: (rand(seed++) + rand(seed++) - 1), // triangular — dense midplane
          speed: (SPIN_MIN + rand(seed++) * SPIN_VAR) * (c % 2 === 0 ? 1 : -1),
        });
      }
    }
    this.geom.setDrawRange(0, this.grains.length);
  }

  // Follow the live galaxies: centroid + star radius per group each frame,
  // then place every grain on its disc annulus. O(nodes + grains).
  update(dt: number): void {
    if (this.grains.length === 0) return;
    this.t += dt;
    const cx = new Map<number, number>();
    const cy = new Map<number, number>();
    const cz = new Map<number, number>();
    const cn = new Map<number, number>();
    for (const id of this.nodeIds) {
      const a = this.graph.getNodeAttributes(id);
      if (a.community < 0 || a.hidden || !this.basisU.has(a.community)) continue;
      cx.set(a.community, (cx.get(a.community) ?? 0) + a.x);
      cy.set(a.community, (cy.get(a.community) ?? 0) + a.y);
      cz.set(a.community, (cz.get(a.community) ?? 0) + a.z);
      cn.set(a.community, (cn.get(a.community) ?? 0) + 1);
    }
    // RMS star radius per galaxy — the band hugs the actual disc size.
    const r2 = new Map<number, number>();
    for (const id of this.nodeIds) {
      const a = this.graph.getNodeAttributes(id);
      const c = a.community;
      const n = cn.get(c);
      if (c < 0 || a.hidden || !n) continue;
      const dx = a.x - cx.get(c)! / n;
      const dy = a.y - cy.get(c)! / n;
      const dz = a.z - cz.get(c)! / n;
      r2.set(c, (r2.get(c) ?? 0) + dx * dx + dy * dy + dz * dz);
    }
    const pos = this.geom.getAttribute("position") as THREE.BufferAttribute;
    const alp = this.geom.getAttribute("a_alpha") as THREE.BufferAttribute;
    for (let i = 0; i < this.grains.length; i++) {
      const g = this.grains[i];
      const n = cn.get(g.community);
      if (!n) {
        alp.setX(i, 0);
        continue;
      }
      const R = Math.sqrt((r2.get(g.community) ?? 0) / n) * 1.35 || 30;
      const mx = cx.get(g.community)! / n;
      const my = cy.get(g.community)! / n;
      const mz = cz.get(g.community)! / n;
      const u = this.basisU.get(g.community)!;
      const v = this.basisV.get(g.community)!;
      const nm = galaxyNormal(g.community);
      const ang = g.angle + g.speed * this.t;
      const cs = Math.cos(ang) * g.radius01 * R;
      const sn = Math.sin(ang) * g.radius01 * R;
      const off = g.off * THICKNESS * R;
      pos.setXYZ(
        i,
        mx + u.x * cs + v.x * sn + nm.x * off,
        my + u.y * cs + v.y * sn + nm.y * off,
        mz + u.z * cs + v.z * sn + nm.z * off,
      );
      // Outer grains fade — the band dissolves into the void.
      const edge = (g.radius01 - RADIUS_LO) / (RADIUS_HI - RADIUS_LO);
      alp.setX(i, 0.32 * (1 - edge * 0.75));
    }
    pos.needsUpdate = true;
    alp.needsUpdate = true;
  }

  dispose(): void {
    this.geom.dispose();
    this.mat.dispose();
  }
}
