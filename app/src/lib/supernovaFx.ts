// Supernova — the selection accent: a bright core flash plus an expanding
// shockwave ring at the clicked star, gone in under a second. Rendered as a
// single perspective-sized point sprite whose fragment shader draws the ring
// from an animated u_t uniform, so the whole effect is one draw call and zero
// per-frame buffer writes.
import * as THREE from "three";

const NOVA_DUR = 0.8; // seconds

const NOVA_VERT = /* glsl */ `
uniform float u_pixelRatio;
uniform float u_sizeScale;
uniform float u_wsize;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float dist = max(1.0, -mv.z);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(u_wsize * u_sizeScale * u_pixelRatio / dist, 4.0, 420.0);
}
`;

const NOVA_FRAG = /* glsl */ `
precision mediump float;
uniform float u_t; // 0 → 1 over the effect's life
uniform vec3 u_color;
void main() {
  float d = length(gl_PointCoord - vec2(0.5)) * 2.0;
  // Shockwave: a gaussian ring expanding outward, widening and fading.
  float et = 1.0 - (1.0 - u_t) * (1.0 - u_t); // easeOut
  float r = mix(0.06, 0.85, et);
  float w = 0.05 + 0.10 * u_t;
  float ring = exp(-pow((d - r) / w, 2.0)) * (1.0 - u_t);
  // Core flash: hot centre that dies quickly.
  float core = (1.0 - u_t) * (1.0 - u_t) * (1.0 - smoothstep(0.0, 0.3, d));
  float a = ring * 0.9 + core * 1.2;
  if (a < 0.01) discard;
  gl_FragColor = vec4(u_color * (1.4 + core * 1.6), a);
}
`;

export class SupernovaFx {
  readonly points: THREE.Points;
  private geom: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;
  private t = -1; // <0 ⇒ idle

  constructor(pr: number, dark: boolean) {
    this.geom = new THREE.BufferGeometry();
    this.geom.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(3), 3),
    );
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        u_pixelRatio: { value: pr },
        u_sizeScale: { value: 1 },
        u_wsize: { value: 40 },
        u_t: { value: 0 },
        u_color: { value: new THREE.Color("#9fd8ff") },
      },
      vertexShader: NOVA_VERT,
      fragmentShader: NOVA_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: dark ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(this.geom, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4; // topmost accent
    this.points.visible = false;
  }

  setDark(dark: boolean): void {
    this.mat.blending = dark ? THREE.AdditiveBlending : THREE.NormalBlending;
    this.mat.needsUpdate = true;
  }

  setSizeScale(s: number): void {
    this.mat.uniforms.u_sizeScale.value = s;
  }

  // Detonate at a star. `size` is the node's size attribute; the ring expands
  // to a few node-glow radii so even a small star reads a clear shockwave.
  trigger(x: number, y: number, z: number, size: number, color: string): void {
    const pos = this.geom.getAttribute("position") as THREE.BufferAttribute;
    pos.setXYZ(0, x, y, z);
    pos.needsUpdate = true;
    this.mat.uniforms.u_wsize.value = Math.max(30, size * 3.4 * 3.2 * 3);
    (this.mat.uniforms.u_color.value as THREE.Color).set(color);
    this.t = 0;
    this.mat.uniforms.u_t.value = 0;
    this.points.visible = true;
  }

  update(dt: number): void {
    if (this.t < 0) return;
    this.t += dt;
    if (this.t >= NOVA_DUR) {
      this.t = -1;
      this.points.visible = false;
      return;
    }
    this.mat.uniforms.u_t.value = this.t / NOVA_DUR;
  }

  dispose(): void {
    this.geom.dispose();
    this.mat.dispose();
  }
}
