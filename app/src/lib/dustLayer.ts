// Dust motes — a fine haze of tiny specks orbiting the nodes, visible up close
// while piloting the spaceship (fly mode). Each mote rides a small circular
// orbit in a random plane around one node, drifting slowly and twinkling, tinted
// with its node's colour. One THREE.Points cloud (single draw call), capped pool,
// only animated while shown. Deterministic seeding (seededUnit) so it's stable.
import * as THREE from "three";
import { seededUnit, type VaultGraph } from "./graphData";

const MAX_MOTES = 3000;
const NODE_R = 3.4; // matches graphScene NODE_RADIUS (node world radius = size*NODE_R)
const ORBIT_MIN = 1.6; // × node world radius
const ORBIT_VAR = 3.2;
const SPIN_MIN = 0.15; // radians/sec
const SPIN_VAR = 0.5;

const VERT = /* glsl */ `
attribute float a_dsize;
attribute vec3 a_dcolor;
uniform float u_pixelRatio;
varying vec3 v_color;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  // Shrink with distance so motes are specks, not blobs, when far.
  gl_PointSize = clamp(a_dsize * u_pixelRatio * (300.0 / -mv.z), 0.5, 4.0);
  v_color = a_dcolor;
}
`;

const FRAG = /* glsl */ `
precision mediump float;
varying vec3 v_color;
void main() {
  float d = length(gl_PointCoord - vec2(0.5)) * 2.0;
  float a = 1.0 - smoothstep(0.0, 1.0, d);
  if (a < 0.02) discard;
  gl_FragColor = vec4(v_color, a * 0.7);
}
`;

export class DustLayer {
  readonly points: THREE.Points;
  private geom: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;
  private graph: VaultGraph;
  private count = 0;
  private node: string[] = []; // node id each mote orbits
  private radius!: Float32Array; // orbit radius (world units)
  private angle!: Float32Array; // current angle
  private spin!: Float32Array; // angular speed
  private ux!: Float32Array; // orbit-plane basis vectors (u, v) per mote
  private uy!: Float32Array;
  private uz!: Float32Array;
  private vx!: Float32Array;
  private vy!: Float32Array;
  private vz!: Float32Array;
  private twk!: Float32Array; // twinkle phase
  private clock = 0;
  private baseCol = new THREE.Color();

  constructor(graph: VaultGraph, nodeIds: string[], pr: number, dark: boolean) {
    this.graph = graph;
    this.geom = new THREE.BufferGeometry();
    this.mat = new THREE.ShaderMaterial({
      uniforms: { u_pixelRatio: { value: pr } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: dark ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(this.geom, this.mat);
    this.points.frustumCulled = false;
    this.points.visible = false;
    this.seed(nodeIds);
  }

  setDark(dark: boolean): void {
    this.mat.blending = dark ? THREE.AdditiveBlending : THREE.NormalBlending;
    this.mat.needsUpdate = true;
  }

  setPixelRatio(pr: number): void {
    this.mat.uniforms.u_pixelRatio.value = pr;
  }

  setVisible(on: boolean): void {
    this.points.visible = on;
  }

  // (Re)build the mote pool, distributing motes across nodes weighted by size so
  // big hubs get a denser halo. Called on construction + graph rebuild.
  seed(nodeIds: string[]): void {
    const usable = nodeIds.filter((id) => this.graph.hasNode(id));
    this.count = usable.length === 0 ? 0 : Math.min(MAX_MOTES, usable.length * 4);
    const n = this.count;
    this.node = new Array(n);
    this.radius = new Float32Array(n);
    this.angle = new Float32Array(n);
    this.spin = new Float32Array(n);
    this.ux = new Float32Array(n);
    this.uy = new Float32Array(n);
    this.uz = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.vz = new Float32Array(n);
    this.twk = new Float32Array(n);
    const sizeAttr = new Float32Array(n);

    // Cumulative size weights for weighted node pick.
    const weights = usable.map((id) => this.graph.getNodeAttributes(id).size || 1);
    let total = 0;
    const cum = weights.map((w) => (total += w));

    const up = new THREE.Vector3();
    const axis = new THREE.Vector3();
    const u = new THREE.Vector3();
    const v = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      // weighted pick
      const r = seededUnit(`dust-n-${i}`, 61) * total;
      let lo = 0,
        hi = cum.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] < r) lo = mid + 1;
        else hi = mid;
      }
      const id = usable[lo];
      this.node[i] = id;
      const worldR = (this.graph.getNodeAttributes(id).size || 1) * NODE_R;
      this.radius[i] = worldR * (ORBIT_MIN + seededUnit(`dust-r-${i}`, 62) * ORBIT_VAR);
      this.angle[i] = seededUnit(`dust-a-${i}`, 63) * Math.PI * 2;
      const dir = seededUnit(`dust-d-${i}`, 64) < 0.5 ? -1 : 1;
      this.spin[i] = dir * (SPIN_MIN + seededUnit(`dust-s-${i}`, 65) * SPIN_VAR);
      this.twk[i] = seededUnit(`dust-t-${i}`, 66) * Math.PI * 2;
      sizeAttr[i] = 1.2 + seededUnit(`dust-z-${i}`, 67) * 2.2;
      // Random orbit plane: pick an axis, then two orthonormal in-plane vectors.
      axis
        .set(
          seededUnit(`dust-ax-${i}`, 68) * 2 - 1,
          seededUnit(`dust-ay-${i}`, 69) * 2 - 1,
          seededUnit(`dust-az-${i}`, 70) * 2 - 1,
        )
        .normalize();
      up.set(0, 1, 0);
      if (Math.abs(axis.dot(up)) > 0.9) up.set(1, 0, 0);
      u.crossVectors(axis, up).normalize();
      v.crossVectors(axis, u).normalize();
      this.ux[i] = u.x;
      this.uy[i] = u.y;
      this.uz[i] = u.z;
      this.vx[i] = v.x;
      this.vy[i] = v.y;
      this.vz[i] = v.z;
    }
    this.geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this.geom.setAttribute("a_dcolor", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this.geom.setAttribute("a_dsize", new THREE.BufferAttribute(sizeAttr, 1));
    this.geom.setDrawRange(0, n);
  }

  // Advance the motes around their nodes and repaint. No-op when hidden/empty.
  update(dt: number): void {
    if (!this.points.visible || this.count === 0) return;
    this.clock += dt;
    const pos = this.geom.getAttribute("position") as THREE.BufferAttribute;
    const col = this.geom.getAttribute("a_dcolor") as THREE.BufferAttribute;
    for (let i = 0; i < this.count; i++) {
      const a = this.graph.getNodeAttributes(this.node[i]);
      if (a.hidden) {
        col.setXYZ(i, 0, 0, 0);
        continue;
      }
      const ang = (this.angle[i] += this.spin[i] * dt);
      const c = Math.cos(ang) * this.radius[i];
      const s = Math.sin(ang) * this.radius[i];
      pos.setXYZ(
        i,
        a.x + this.ux[i] * c + this.vx[i] * s,
        a.y + this.uy[i] * c + this.vy[i] * s,
        a.z + this.uz[i] * c + this.vz[i] * s,
      );
      this.baseCol.set(a.color ?? "#9aa6c2");
      const tw = 0.5 + 0.5 * Math.sin(this.clock * 2 + this.twk[i]);
      col.setXYZ(i, this.baseCol.r * tw, this.baseCol.g * tw, this.baseCol.b * tw);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
  }

  dispose(): void {
    this.geom.dispose();
    this.mat.dispose();
  }
}
