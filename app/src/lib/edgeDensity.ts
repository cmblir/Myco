// Edge-density accumulation, two modes:
//
// "web"  — the cosmic-web skin (IllustrisTNG): edges REPLACE the plain lines
//          and composite through a hard density ramp.
// "atmo" — the LIVING NEBULA: the same splats, half-resolution, softened by a
//          two-tap Kawase blur and composited as a faint breathing glow UNDER
//          the normal edges — where links crowd, the air itself glows in the
//          community's colour. Structure becomes atmosphere.
//
// Every edge is splatted additively into a HalfFloat offscreen target — where
// strands overlap the value climbs past what an on-screen additive line could
// show — then one fullscreen pass tone-compresses the density and colours it on
// a ramp: sparse strands deep blue-violet, converging bundles warming through
// orange, the densest cores white-hot. This is what turns "many faint lines"
// into a genuine density FIELD: brightness is earned by structure, not per-line
// alpha. The normal in-scene edge lines are hidden while this runs (hover/path
// feedback stays on the filament overlay, which is a separate layer).
//
// The splat pass reuses the SAME edge BufferGeometry as the scene (positions
// and vertex colours track sim ticks and timelapse hiding for free — a hidden
// edge's black vertices contribute zero density). The composite quad follows
// the gridBackdrop fullscreen-NDC pattern and is NOT on the bloom layer, so the
// ramp stays structurally bloom-proof like every other ambient layer.

import * as THREE from "three";

const SPLAT_OPACITY = 0.3; // per-line deposit; the ramp gain does the rest

const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.9998, 1.0); // fullscreen, behind content
}
`;

// Soft atmosphere composite (atmo mode): tone-compressed blurred density as a
// dim colour wash. Breathes gently on the ambience-gated clock.
const ATMO_FRAG = /* glsl */ `
precision mediump float;
uniform sampler2D u_density;
uniform float u_gain;
uniform float u_strength;
uniform float u_time;
varying vec2 vUv;
void main() {
  vec3 acc = texture2D(u_density, vUv).rgb;
  vec3 c = vec3(1.0) - exp(-acc * u_gain);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  if (l < 0.004) discard;
  float breathe = 1.0 + 0.08 * sin(u_time * 0.23);
  gl_FragColor = vec4(c * u_strength * breathe, 1.0);
}
`;

// 4-tap Kawase blur step (offset grows per pass) — cheap wide softening.
const BLUR_FRAG = /* glsl */ `
precision mediump float;
uniform sampler2D u_src;
uniform vec2 u_texel;
uniform float u_offset;
varying vec2 vUv;
void main() {
  vec2 o = u_texel * u_offset;
  vec3 c = texture2D(u_src, vUv + vec2( o.x,  o.y)).rgb
         + texture2D(u_src, vUv + vec2(-o.x,  o.y)).rgb
         + texture2D(u_src, vUv + vec2( o.x, -o.y)).rgb
         + texture2D(u_src, vUv + vec2(-o.x, -o.y)).rgb;
  gl_FragColor = vec4(c * 0.25, 1.0);
}
`;

const QUAD_FRAG = /* glsl */ `
precision mediump float;
uniform sampler2D u_density;
uniform float u_gain;
uniform float u_strength;
varying vec2 vUv;
// Deep blue -> violet -> warm orange -> white-hot, the dark-matter-sim ramp.
vec3 ramp(float t) {
  vec3 c1 = vec3(0.06, 0.09, 0.32);
  vec3 c2 = vec3(0.42, 0.48, 0.88);
  vec3 c3 = vec3(1.00, 0.70, 0.40);
  vec3 c4 = vec3(1.00, 0.95, 0.85);
  if (t < 0.45) return mix(c1, c2, t / 0.45);
  if (t < 0.80) return mix(c2, c3, (t - 0.45) / 0.35);
  return mix(c3, c4, (t - 0.80) / 0.20);
}
void main() {
  vec3 acc = texture2D(u_density, vUv).rgb;
  float d = dot(acc, vec3(0.2126, 0.7152, 0.0722));
  if (d < 0.002) discard;
  // Soft knee (Reinhard-style): unbounded accumulation maps smoothly to [0,1),
  // so no max/normalisation pass is ever needed.
  float t = 1.0 - exp(-d * u_gain);
  gl_FragColor = vec4(ramp(t) * t * u_strength, 1.0);
}
`;

export type DensityMode = "web" | "atmo";

export class EdgeDensityLayer {
  /** Fullscreen composite quad — add to the MAIN scene. */
  readonly quad: THREE.Mesh;
  readonly mode: DensityMode;
  private rt: THREE.WebGLRenderTarget;
  private blurA: THREE.WebGLRenderTarget | null = null;
  private blurB: THREE.WebGLRenderTarget | null = null;
  private blurMat: THREE.ShaderMaterial | null = null;
  private blurScene: THREE.Scene | null = null;
  private blurQuad: THREE.Mesh | null = null;
  private blurCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private densityScene = new THREE.Scene();
  private lines: THREE.LineSegments;
  private splatMat: THREE.LineBasicMaterial;
  private quadMat: THREE.ShaderMaterial;

  constructor(
    edgeGeom: THREE.BufferGeometry,
    width: number,
    height: number,
    pr: number,
    mode: DensityMode = "web",
  ) {
    this.mode = mode;
    // Atmosphere accumulates at half resolution — it gets blurred anyway, and
    // the splat + two blur passes then cost a quarter of the pixels.
    const scale = mode === "atmo" ? 0.5 : 1;
    const rw = Math.max(2, Math.floor(width * pr * scale));
    const rh = Math.max(2, Math.floor(height * pr * scale));
    this.rt = new THREE.WebGLRenderTarget(rw, rh, {
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this.splatMat = new THREE.LineBasicMaterial({
      vertexColors: true, // hidden edges are written black -> zero deposit
      transparent: true,
      opacity: SPLAT_OPACITY,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    });
    this.lines = new THREE.LineSegments(edgeGeom, this.splatMat);
    this.lines.frustumCulled = false;
    this.densityScene.add(this.lines);

    if (mode === "atmo") {
      const mkRt = (): THREE.WebGLRenderTarget =>
        new THREE.WebGLRenderTarget(rw, rh, {
          type: THREE.HalfFloatType,
          depthBuffer: false,
          stencilBuffer: false,
        });
      this.blurA = mkRt();
      this.blurB = mkRt();
      this.blurMat = new THREE.ShaderMaterial({
        uniforms: {
          u_src: { value: null },
          u_texel: { value: new THREE.Vector2(1 / rw, 1 / rh) },
          u_offset: { value: 1 },
        },
        vertexShader: QUAD_VERT,
        fragmentShader: BLUR_FRAG,
        depthWrite: false,
        depthTest: false,
      });
      this.blurQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blurMat);
      this.blurQuad.frustumCulled = false;
      this.blurScene = new THREE.Scene();
      this.blurScene.add(this.blurQuad);
    }

    this.quadMat =
      mode === "atmo"
        ? new THREE.ShaderMaterial({
            uniforms: {
              u_density: { value: null }, // bound to the final blur each frame
              u_gain: { value: 2.6 },
              u_strength: { value: 0.42 },
              u_time: { value: 0 },
            },
            vertexShader: QUAD_VERT,
            fragmentShader: ATMO_FRAG,
            transparent: true,
            depthWrite: false,
            depthTest: false,
            blending: THREE.AdditiveBlending,
          })
        : new THREE.ShaderMaterial({
            uniforms: {
              u_density: { value: this.rt.texture },
              // Single strand ~t 0.37 (clear blue-violet), ~4 crossings reach
              // the warm knee, dense cores saturate white (1200-node probe).
              u_gain: { value: 3.6 },
              u_strength: { value: 1.15 },
            },
            vertexShader: QUAD_VERT,
            fragmentShader: QUAD_FRAG,
            transparent: true,
            depthWrite: false,
            depthTest: false,
            blending: THREE.AdditiveBlending,
          });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.quadMat);
    this.quad.frustumCulled = false;
    this.quad.renderOrder = -500; // over the grid backdrop, under stars/nodes
  }

  /** Re-point at a rebuilt edge geometry (graph swap). */
  setGeometry(edgeGeom: THREE.BufferGeometry): void {
    this.lines.geometry = edgeGeom;
  }

  setSize(width: number, height: number, pr: number): void {
    const scale = this.mode === "atmo" ? 0.5 : 1;
    const rw = Math.max(2, Math.floor(width * pr * scale));
    const rh = Math.max(2, Math.floor(height * pr * scale));
    this.rt.setSize(rw, rh);
    this.blurA?.setSize(rw, rh);
    this.blurB?.setSize(rw, rh);
    if (this.blurMat) (this.blurMat.uniforms.u_texel.value as THREE.Vector2).set(1 / rw, 1 / rh);
  }

  /** Drive the atmosphere's breathing (ambience-gated clock; freezes with it). */
  setTime(t: number): void {
    if (this.mode === "atmo") this.quadMat.uniforms.u_time.value = t;
  }

  /** Accumulate this frame's edge splats (call before the main composite).
   * Atmo mode then softens them through two widening Kawase taps. */
  render(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void {
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    renderer.render(this.densityScene, camera);
    if (this.mode === "atmo" && this.blurMat && this.blurScene && this.blurA && this.blurB) {
      this.blurMat.uniforms.u_src.value = this.rt.texture;
      this.blurMat.uniforms.u_offset.value = 1.5;
      renderer.setRenderTarget(this.blurA);
      renderer.render(this.blurScene, this.blurCam);
      this.blurMat.uniforms.u_src.value = this.blurA.texture;
      this.blurMat.uniforms.u_offset.value = 3.5;
      renderer.setRenderTarget(this.blurB);
      renderer.render(this.blurScene, this.blurCam);
      this.quadMat.uniforms.u_density.value = this.blurB.texture;
    }
    renderer.setRenderTarget(prev);
  }

  dispose(): void {
    this.rt.dispose();
    this.blurA?.dispose();
    this.blurB?.dispose();
    this.blurMat?.dispose();
    this.blurQuad?.geometry.dispose();
    this.splatMat.dispose();
    this.quadMat.dispose();
    this.quad.geometry.dispose();
  }
}
