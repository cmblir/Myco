// Universe bubbles — the multiverse tier's signature form. Each universe (one
// project/vault) is wrapped in a translucent glowing sphere so, from far out,
// the multiverse reads as a field of distinct luminous orbs (the "bubble
// universes" metaphor) rather than an ambiguous smear of point clouds. Fly into
// a bubble and you're among that project's individual stars (the normal graph).
//
// The membrane is a fresnel shell: alpha peaks at grazing angles (a bright rim
// ring) and stays faint face-on, so the stars inside remain visible through the
// middle while the boundary glows. One transparent sphere mesh per universe;
// universes are few (< ~100), so a small Group of meshes is simpler than
// instancing and costs nothing. Tinted by the project's stable identity hue.

import * as THREE from "three";
import type { VaultGraph } from "./graphData";
import { universeHue } from "./multiverseLayout";

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
  float rim = pow(f, 2.5);
  // A whisper of constant fill gives the orb faint volume without hiding its
  // interior; the rim carries the boundary.
  float a = (rim * 0.9 + 0.05) * u_opacity;
  gl_FragColor = vec4(u_color, a);
}
`;

interface Bubble {
  slug: string;
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
}

export class UniverseBubbleLayer {
  readonly group = new THREE.Group();
  private bubbles: Bubble[] = [];

  constructor(graph: VaultGraph, nodeIds: string[], opacity = 0.5) {
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

    const unit = new THREE.SphereGeometry(1, 48, 32);
    const col = new THREE.Color();
    for (const [slug, c] of centre) {
      // Enclose the whole star cloud with a little breathing room, with a floor
      // so a tiny (few-note) universe still reads as a real bubble.
      const R = Math.max(60, (maxR.get(slug) ?? 0) * 1.18);
      col.setHSL(universeHue(slug) / 360, 0.7, 0.6);
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
      const mesh = new THREE.Mesh(unit, mat);
      mesh.position.copy(c);
      mesh.scale.setScalar(R);
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.bubbles.push({ slug, mesh, mat });
    }
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
    // All bubbles share the one unit geometry — dispose it once.
    if (this.bubbles[0]) this.bubbles[0].mesh.geometry.dispose();
    this.group.clear();
    this.bubbles = [];
  }
}
