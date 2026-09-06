// Galaxy imposters — the FAR end of the cosmic-scale LOD. Each community
// (galaxy) draws one big billboarded sprite whose fragment shader paints a
// procedural barred-spiral disc: a blazing warm core, log-spiral arms with
// dust lanes, a soft halo, tinted by the galaxy's hue and slowly rotating.
// When the camera is far, these ARE the vault — thousands of individual node
// sprites would merge into a meaningless white blob (and cost a fortune on a
// 10k graph), so the node cloud fades out and these grand discs fade in; fly
// closer and the reverse happens (see GraphScene's LOD blend). Perspective-
// sized to each galaxy's world radius, so a big interlinked folder reads as a
// genuinely huge galaxy. One draw call. Dark themes only.
import * as THREE from "three";
import type { VaultGraph } from "./graphData";
import { galaxyNormal } from "./galaxyLayout";

const MAX = 48;

const VERT = /* glsl */ `
attribute vec3 a_pcolor;
attribute float a_wsize;
attribute float a_alpha;
attribute float a_seed;
uniform float u_pixelRatio;
uniform float u_sizeScale;
varying vec3 v_color;
varying float v_alpha;
varying float v_seed;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float dist = max(1.0, -mv.z);
  gl_Position = projectionMatrix * mv;
  // Disc spans a few galaxy radii on screen; clamp huge so a near flyby fills
  // the frame like a real galaxy rushing past.
  gl_PointSize = clamp(a_wsize * u_sizeScale * u_pixelRatio / dist, 8.0, 3000.0);
  v_color = a_pcolor;
  v_alpha = a_alpha;
  v_seed = a_seed;
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec3 v_color;
varying float v_alpha;
varying float v_seed;
uniform float u_time;

// Cheap value-noise for arm mottling / dust.
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p){
  vec2 i = floor(p); vec2 f = fract(p);
  f = f*f*(3.0-2.0*f);
  float a = hash(i), b = hash(i+vec2(1.0,0.0));
  float c = hash(i+vec2(0.0,1.0)), d = hash(i+vec2(1.0,1.0));
  return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
}

void main() {
  vec2 p = gl_PointCoord - vec2(0.5);
  float r = length(p) * 2.0;      // 0 centre → 1 edge
  if (r > 1.0) discard;
  float ang = atan(p.y, p.x);

  // Per-galaxy phase + spin so no two discs are identical / in sync.
  float phase = v_seed * 6.2831853;
  float spin = u_time * 0.06 + phase;

  // Two log-spiral arms: brightness peaks along theta ≈ k·ln(r) + spin.
  float arms = 2.0;
  float swirl = ang * arms - log(r + 0.06) * 5.0 * (1.0 + 0.3 * sin(phase)) + spin * 2.0;
  float arm = 0.5 + 0.5 * cos(swirl);
  arm = pow(arm, 2.2);
  // Mottle the arms with noise so they read as clumpy star clouds + dust.
  float mott = noise(vec2(swirl * 1.5, r * 8.0 + phase));
  arm *= 0.55 + 0.7 * mott;

  // Radial disc envelope: bright core, arms in the mid-disc, fading rim.
  float core = exp(-r * r * 10.0);            // dense central bulge
  float disc = smoothstep(1.0, 0.15, r);       // overall disc falloff
  float armBand = disc * smoothstep(0.9, 0.25, r) * arm;
  float halo = exp(-r * r * 2.2) * 0.35;

  float bright = core * 1.6 + armBand * 0.9 + halo;
  if (bright < 0.008) discard;

  // Colour: hue in the arms, warm white in the core (real galaxies burn white
  // at the centre). Core temperature leans warm.
  vec3 warm = vec3(1.0, 0.93, 0.82);
  vec3 col = mix(v_color, warm, core * 0.85);
  col += warm * core * 0.6;

  gl_FragColor = vec4(col * bright, min(1.0, bright) * v_alpha);
}
`;

export class GalaxyImposterLayer {
  readonly points: THREE.Points;
  private geom: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;
  private graph: VaultGraph;
  private nodeIds: string[];
  // community id → buffer slot, so the LOD blend can set per-galaxy alpha.
  private slotOf = new Map<number, number>();

  constructor(graph: VaultGraph, nodeIds: string[], pr: number, enabled: boolean) {
    this.graph = graph;
    this.nodeIds = nodeIds;
    this.geom = new THREE.BufferGeometry();
    this.geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX * 3), 3));
    this.geom.setAttribute("a_pcolor", new THREE.BufferAttribute(new Float32Array(MAX * 3), 3));
    this.geom.setAttribute("a_wsize", new THREE.BufferAttribute(new Float32Array(MAX), 1));
    this.geom.setAttribute("a_alpha", new THREE.BufferAttribute(new Float32Array(MAX), 1));
    this.geom.setAttribute("a_seed", new THREE.BufferAttribute(new Float32Array(MAX), 1));
    this.geom.setDrawRange(0, 0);
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        u_pixelRatio: { value: pr },
        u_sizeScale: { value: 1 },
        u_time: { value: 0 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(this.geom, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = -1; // behind everything — it's the backdrop galaxy
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

  update(dt: number): void {
    this.mat.uniforms.u_time.value += dt;
  }

  // Recompute per-galaxy centroid / radius / hue → sprite slots. Throttled by
  // the caller (galaxies drift slowly). Returns the community→slot map so the
  // LOD blend can drive per-galaxy alpha.
  refresh(): Map<number, number> {
    const cx = new Map<number, number>();
    const cy = new Map<number, number>();
    const cz = new Map<number, number>();
    const cn = new Map<number, number>();
    const hue = new Map<number, string>();
    for (const id of this.nodeIds) {
      const a = this.graph.getNodeAttributes(id);
      if (a.community < 0 || a.hidden) continue;
      cx.set(a.community, (cx.get(a.community) ?? 0) + a.x);
      cy.set(a.community, (cy.get(a.community) ?? 0) + a.y);
      cz.set(a.community, (cz.get(a.community) ?? 0) + a.z);
      cn.set(a.community, (cn.get(a.community) ?? 0) + 1);
      if (a.isHub) hue.set(a.community, a.color);
    }
    // RMS radius per galaxy.
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
    const col = this.geom.getAttribute("a_pcolor") as THREE.BufferAttribute;
    const siz = this.geom.getAttribute("a_wsize") as THREE.BufferAttribute;
    const seed = this.geom.getAttribute("a_seed") as THREE.BufferAttribute;
    const c3 = new THREE.Color();
    this.slotOf.clear();
    let i = 0;
    for (const [cm, n] of [...cn.entries()].sort((a, b) => b[1] - a[1])) {
      if (i >= MAX || n < 3) continue;
      const R = Math.sqrt((r2.get(cm) ?? 0) / n) || 30;
      pos.setXYZ(i, cx.get(cm)! / n, cy.get(cm)! / n, cz.get(cm)! / n);
      c3.set(hue.get(cm) ?? "#8fa6d8");
      col.setXYZ(i, c3.r, c3.g, c3.b);
      // Disc spans ~4.6× the star RMS radius so the galaxy reads as a sizable
      // luminous disc from across the void, not a faint dot.
      siz.setX(i, R * 4.6);
      // Tilt-derived seed so the arm phase matches the galaxy's disc identity.
      const nm = galaxyNormal(cm);
      seed.setX(i, (Math.abs(nm.x) + Math.abs(nm.z) * 1.7 + cm * 0.13) % 1);
      this.slotOf.set(cm, i);
      i++;
    }
    this.geom.setDrawRange(0, i);
    pos.needsUpdate = true;
    col.needsUpdate = true;
    siz.needsUpdate = true;
    seed.needsUpdate = true;
    return this.slotOf;
  }

  // Per-galaxy alpha (the LOD blend writes these each frame). `alphaOf` maps a
  // community id → 0..1; galaxies absent from the map fade to 0.
  setAlphas(alphaOf: (community: number) => number): void {
    const alp = this.geom.getAttribute("a_alpha") as THREE.BufferAttribute;
    for (const [cm, slot] of this.slotOf) alp.setX(slot, alphaOf(cm));
    alp.needsUpdate = true;
  }

  dispose(): void {
    this.geom.dispose();
    this.mat.dispose();
  }
}
