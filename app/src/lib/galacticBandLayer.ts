// Galactic band — a decorative Milky-Way stripe across the deep-space sky: a
// few thousand faint white dust grains scattered along a tilted great-circle
// band far beyond the graph, slowly wheeling. Pure ambience (no node data),
// one Points draw call, deterministic scatter. Dark themes only.
import * as THREE from "three";

const GRAINS = 2600;
// Band geometry: sits beyond the galaxy anchors (~hundreds of units) but
// inside the far starfield shells, so it parallaxes between them.
const BAND_RADIUS = 1500;
const BAND_RADIUS_VAR = 420; // radial scatter
const BAND_THICKNESS = 130; // gaussian-ish spread off the band plane
const BAND_TILT = 0.42; // radians off the horizon — a diagonal Milky Way
const SPIN_SPEED = 0.0045; // rad/s — barely perceptible wheel

// Deterministic LCG stream (same recipe as the starfield).
function rand(n: number): number {
  let x = (n * 1664525 + 1013904223) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 2246822519) >>> 0;
  x ^= x >>> 13;
  return (x >>> 0) / 4294967296;
}

export class GalacticBandLayer {
  readonly group = new THREE.Group();
  private geom: THREE.BufferGeometry;
  private mat: THREE.PointsMaterial;

  constructor() {
    const pos = new Float32Array(GRAINS * 3);
    let s = 1;
    for (let i = 0; i < GRAINS; i++) {
      const theta = rand(s++) * Math.PI * 2;
      const r = BAND_RADIUS + (rand(s++) - 0.5) * 2 * BAND_RADIUS_VAR;
      // Sum of two uniforms ≈ triangular — denser at the band's midplane.
      const off = (rand(s++) + rand(s++) - 1) * BAND_THICKNESS;
      pos[i * 3] = Math.cos(theta) * r;
      pos[i * 3 + 1] = off;
      pos[i * 3 + 2] = Math.sin(theta) * r;
    }
    this.geom = new THREE.BufferGeometry();
    this.geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.mat = new THREE.PointsMaterial({
      color: 0xdde6f5,
      size: 1.2,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const pts = new THREE.Points(this.geom, this.mat);
    pts.frustumCulled = false;
    this.group.add(pts);
    this.group.rotation.z = BAND_TILT;
  }

  // Slow wheel about the band's own axis (caller gates on ambient motion).
  update(dt: number): void {
    this.group.rotation.y += SPIN_SPEED * dt;
  }

  dispose(): void {
    this.geom.dispose();
    this.mat.dispose();
  }
}
