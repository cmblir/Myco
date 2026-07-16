// Universe bubbles — the multiverse tier's signature form. Each universe (one
// project/vault) is wrapped in a translucent glowing sphere so, from far out,
// the multiverse reads as a field of distinct luminous orbs (the "bubble
// universes" metaphor) rather than an ambiguous smear of point clouds. Fly into
// a bubble and you're among that project's individual stars (the normal graph).
//
// The membrane is a fresnel shell: alpha peaks at grazing angles (a bright rim
// ring) and stays faint face-on, so the stars inside remain visible through the
// middle while the boundary glows. Each bubble also floats its project's name as
// a billboarded label. One transparent sphere + one label sprite per universe;
// universes are few (< ~100), so a small Group of meshes is simpler than
// instancing and costs nothing.
//
// Colour: hues are RANK-SPREAD by golden angle across the universes present, so
// no two bubbles ever share a colour (a stable per-slug hash could collide) —
// the point of the multiverse view is telling the universes apart at a glance.

import * as THREE from "three";
import type { VaultGraph } from "./graphData";
import { readTheme } from "./graphTheme";
import { isDarkInk } from "./inkContrast";

const VERT = /* glsl */ `
varying vec3 v_normal;
varying vec3 v_viewDir;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  v_normal = normalize(normalMatrix * normal);
  v_viewDir = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
precision highp float;
uniform vec3 u_color;
uniform float u_opacity;
varying vec3 v_normal;
varying vec3 v_viewDir;
void main() {
  // Fresnel: 0 facing the camera, 1 at the silhouette. A high power keeps the
  // face transparent (stars show through) and concentrates glow at the rim.
  float f = 1.0 - abs(dot(normalize(v_normal), normalize(v_viewDir)));
  float rim = pow(f, 2.8);
  // Almost all the alpha lives at the rim; the face is barely tinted so the
  // stars inside read clearly instead of being washed in the bubble's colour.
  float a = (rim * 0.95 + 0.015) * u_opacity;
  gl_FragColor = vec4(u_color, a);
}
`;

// Golden-angle hue by rank — maximally spread, so N bubbles are all distinct.
function spreadHue(rank: number): number {
  return (rank * 137.508) % 360;
}

interface Bubble {
  slug: string;
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  label?: THREE.Sprite;
}

export interface BubbleOpts {
  opacity?: number;
  /** slug → display title for the floating label (falls back to the slug). */
  titles?: Map<string, string>;
}

export class UniverseBubbleLayer {
  readonly group = new THREE.Group();
  private bubbles: Bubble[] = [];
  private unitGeom: THREE.SphereGeometry;
  private textures: THREE.Texture[] = [];
  private labelMats: THREE.SpriteMaterial[] = [];

  constructor(graph: VaultGraph, nodeIds: string[], opts: BubbleOpts = {}) {
    const opacity = opts.opacity ?? 0.32;
    const titles = opts.titles ?? new Map<string, string>();
    this.group.renderOrder = 1; // draw after the stars so it glazes over them

    // Aggregate each universe's centroid, then its enclosing radius.
    const sum = new Map<string, { x: number; y: number; z: number; n: number }>();
    for (const id of nodeIds) {
      const a = graph.getNodeAttributes(id);
      const slug = a.universe ?? "";
      if (!slug || a.hidden) continue;
      const s = sum.get(slug) ?? { x: 0, y: 0, z: 0, n: 0 };
      s.x += a.x;
      s.y += a.y;
      s.z += a.z;
      s.n += 1;
      sum.set(slug, s);
    }
    const centre = new Map<string, THREE.Vector3>();
    for (const [slug, s] of sum) {
      centre.set(slug, new THREE.Vector3(s.x / s.n, s.y / s.n, s.z / s.n));
    }
    const maxR = new Map<string, number>();
    for (const id of nodeIds) {
      const a = graph.getNodeAttributes(id);
      const slug = a.universe ?? "";
      const c = centre.get(slug);
      if (!c || a.hidden) continue;
      const d = Math.hypot(a.x - c.x, a.y - c.y, a.z - c.z);
      maxR.set(slug, Math.max(maxR.get(slug) ?? 0, d));
    }

    this.unitGeom = new THREE.SphereGeometry(1, 48, 32);
    const col = new THREE.Color();
    // Sort for a deterministic rank → deterministic colours across reloads.
    const slugs = [...centre.keys()].sort();
    slugs.forEach((slug, rank) => {
      const c = centre.get(slug)!;
      // Enclose the whole star cloud with a little breathing room, with a floor
      // so a tiny (few-note) universe still reads as a real bubble.
      const R = Math.max(60, (maxR.get(slug) ?? 0) * 1.18);
      const hue = spreadHue(rank);
      col.setHSL(hue / 360, 0.7, 0.6);
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          u_color: { value: new THREE.Vector3(col.r, col.g, col.b) },
          u_opacity: { value: opacity },
        },
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(this.unitGeom, mat);
      mesh.position.copy(c);
      mesh.scale.setScalar(R);
      mesh.frustumCulled = false;
      this.group.add(mesh);

      const label = this.makeLabel(titles.get(slug) ?? slug, hue, c, R);
      if (label) this.group.add(label);
      this.bubbles.push({ slug, mesh, mat, label: label ?? undefined });
    });
  }

  // A billboarded text sprite floating just above the bubble — the project's
  // name, glowing in the bubble's hue. Returns null if a 2D context is
  // unavailable (headless canvas), so the bubble still renders label-less.
  private makeLabel(
    text: string,
    hue: number,
    centre: THREE.Vector3,
    radius: number,
  ): THREE.Sprite | null {
    const fontPx = 64;
    const pad = 20;
    const measure = document.createElement("canvas").getContext("2d");
    if (!measure) return null;
    const font = `600 ${fontPx}px system-ui, sans-serif`;
    measure.font = font;
    const w = Math.ceil(measure.measureText(text).width) + pad * 2;
    const h = fontPx + pad * 2;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.font = font;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    // Take the ink from the same place the rest of the graph does — readTheme
    // decides light/dark from the actually-rendered --bg. This label used to be
    // hardcoded near-white for the dark cosmic backdrop, which made it all but
    // invisible on the light theme: the universe name, the one thing a bubble
    // exists to tell you, read as a faint smudge while the node labels inside it
    // (which do follow the theme) stayed crisp.
    const ink = readTheme().ink || "#f4f6ff";
    // The halo is the bubble's own hue, so a name still reads against the stars
    // packed behind it, and still ties the label to its bubble. It has to
    // contrast with the text, not match it: glow light under dark ink, dark
    // under light ink.
    const dark = isDarkInk(ink);
    const glow = new THREE.Color().setHSL(hue / 360, 0.7, dark ? 0.35 : 0.7);
    ctx.shadowColor = `#${glow.getHexString()}`;
    ctx.shadowBlur = 16;
    ctx.fillStyle = ink;
    // Two passes: the shadow is the readable halo, so lay it down twice rather
    // than fight the stars behind a single faint pass.
    ctx.fillText(text, w / 2, h / 2);
    ctx.fillText(text, w / 2, h / 2);

    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    this.textures.push(tex);
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.labelMats.push(mat);
    const sprite = new THREE.Sprite(mat);
    // World size proportional to the bubble so labels scale with universes.
    const worldH = Math.max(30, radius * 0.34);
    sprite.scale.set((worldH * w) / h, worldH, 1);
    sprite.position.copy(centre).add(new THREE.Vector3(0, radius * 1.05 + worldH * 0.5, 0));
    sprite.renderOrder = 3;
    return sprite;
  }

  setOpacity(o: number): void {
    for (const b of this.bubbles) b.mat.uniforms.u_opacity.value = o;
  }

  setVisible(on: boolean): void {
    this.group.visible = on;
  }

  // Centre + radius per universe, for the caller's fly-into hit test.
  centres(): { slug: string; centre: THREE.Vector3; radius: number }[] {
    return this.bubbles.map((b) => ({
      slug: b.slug,
      centre: b.mesh.position.clone(),
      radius: b.mesh.scale.x,
    }));
  }

  dispose(): void {
    for (const b of this.bubbles) b.mat.dispose();
    for (const m of this.labelMats) m.dispose();
    for (const t of this.textures) t.dispose();
    this.unitGeom.dispose();
    this.group.clear();
    this.bubbles = [];
    this.textures = [];
    this.labelMats = [];
  }
}
