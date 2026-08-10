// A renderer of its own for the mycelium view.
//
// Why not another skin on GraphScene: four attempts at this look failed the
// same way. GraphScene is a deep-space renderer — starfield, nebula, bloom,
// FogExp2, AgX tone mapping, a sky texture, an EffectComposer chain — and a
// skin can only switch those OFF one at a time. Each attempt was another layer
// of space being hidden, and the background stayed blue because the composited
// output still went through the space post-processing. Fighting a host
// renderer's look is not the same as having your own.
//
// So this owns everything it draws with: renderer, scene, camera, controls, and
// NO post-processing chain at all. That absence is the design — hyphae are
// matte filaments on a substrate, and bloom is exactly what turns a node into a
// star. Nothing here can make it look like space, because none of that code is
// on this path.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";

/** One stroke-width bucket of hyphae. */
export interface MatBucket {
  width: number;
  positions: Float32Array;
  /** Growth index per segment, ascending — drives the grow-in. */
  birth: Float32Array;
}

export interface Septum {
  id: string;
  /** Final (settled) position. */
  x: number;
  y: number;
  z: number;
  /** Starting position the note spreads out FROM as the mat grows. */
  sx: number;
  sy: number;
  sz: number;
  /** 0..1 — bigger for a more-linked note. */
  weight: number;
  color: THREE.ColorRepresentation;
}

export interface MyceliumSceneOpts {
  /** Substrate colour. A warm near-black loam, not a blue void. */
  ground?: number;
  onPick?: (id: string) => void;
  onHover?: (id: string | null) => void;
}

const GROUND = 0x0b0a08;

export class MyceliumScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private container: HTMLElement;
  private opts: MyceliumSceneOpts;

  private mat: LineSegments2[] = [];
  private birth: Float32Array[] = [];
  // Growth is a LERP of two position sets per bucket/septum (start → final),
  // driven by the same clock that reveals segments — "spreading" and
  // "connecting" are one animation, not two. setProgress writes the lerp
  // straight into the geometry's existing GPU buffer (see there for why).
  private matStart: Float32Array[] = [];
  private matFinal: Float32Array[] = [];
  private clock = -1;
  private growSecs = 3.2;
  /** Bounding box of the FINAL layout, computed once from the raw arrays —
   *  fit() must frame the settled mat, not whatever the mid-grow buffer holds. */
  private finalBox: THREE.Box3 = new THREE.Box3();

  private septa: THREE.Points | null = null;
  private septaIds: string[] = [];
  private septaStart: Float32Array = new Float32Array(0);
  private septaFinal: Float32Array = new Float32Array(0);
  private raf: number | null = null;
  private last = 0;
  private ro: ResizeObserver;
  private hovered: string | null = null;

  constructor(container: HTMLElement, opts: MyceliumSceneOpts = {}) {
    this.container = container;
    this.opts = opts;

    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h);
    // No tone mapping. AgX lifted near-black with a blue cast, which is what
    // kept the substrate looking like a sky however dark it was set.
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = "block";

    this.scene.background = new THREE.Color(opts.ground ?? GROUND);

    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 20000);
    this.camera.position.set(0, 0, 1400);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    // A mat lies on a substrate; free-tumbling it just shows the field edge-on.
    this.controls.maxPolarAngle = Math.PI * 0.85;
    this.controls.minPolarAngle = Math.PI * 0.15;

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);

    this.renderer.domElement.addEventListener("pointermove", this.onMove);
    this.renderer.domElement.addEventListener("click", this.onClick);
  }

  private onMove = (e: PointerEvent): void => {
    const id = this.pick(e);
    if (id !== this.hovered) {
      this.hovered = id;
      this.renderer.domElement.style.cursor = id ? "pointer" : "grab";
      this.opts.onHover?.(id);
    }
  };
  private onClick = (e: MouseEvent): void => {
    const id = this.pick(e as unknown as PointerEvent);
    if (id) this.opts.onPick?.(id);
  };

  /** Nearest septum under the pointer, in screen space — cheaper and steadier
   *  than raycasting a Points cloud, whose threshold has to track zoom. */
  private pick(e: PointerEvent): string | null {
    if (!this.septa) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const pos = this.septa.geometry.getAttribute("position") as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    let best: string | null = null;
    let bestD = 14; // px
    for (let i = 0; i < pos.count; i++) {
      v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).project(this.camera);
      const sx = ((v.x + 1) / 2) * rect.width;
      const sy = ((1 - v.y) / 2) * rect.height;
      const d = Math.hypot(sx - px, sy - py);
      if (d < bestD) {
        bestD = d;
        best = this.septaIds[i];
      }
    }
    return best;
  }

  /** `start` is the clustered spawn positions; `final` is the settled layout —
   *  SAME edge order/bucket membership as `start` (both come from the same
   *  buildHyphaMat call over the same graph), so the two arrays line up
   *  index-for-index and setProgress can lerp between them directly. */
  setMat(final: MatBucket[], start: MatBucket[]): void {
    for (const m of this.mat) {
      this.scene.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.mat = [];
    this.birth = [];
    this.matStart = [];
    this.matFinal = [];
    this.finalBox = new THREE.Box3();
    const res = new THREE.Vector2();
    this.renderer.getSize(res);
    for (let i = 0; i < final.length; i++) {
      const f = final[i];
      if (f.positions.length === 0) continue;
      const s = start[i]?.positions.length === f.positions.length ? start[i].positions : f.positions;
      for (let k = 0; k < f.positions.length; k += 3) {
        this.finalBox.expandByPoint(new THREE.Vector3(f.positions[k], f.positions[k + 1], f.positions[k + 2]));
      }
      const geo = new LineSegmentsGeometry();
      geo.setPositions(s); // start at the CLUSTERED positions; growth lerps toward f
      // LineMaterial, because LineBasicMaterial ignores `linewidth` on
      // essentially every platform — the reason hyphae were always hairlines.
      const mtl = new LineMaterial({
        color: 0xd8d0bd,
        linewidth: f.width,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
        worldUnits: false,
      });
      mtl.resolution.copy(res);
      const line = new LineSegments2(geo, mtl);
      line.frustumCulled = false;
      this.scene.add(line);
      this.mat.push(line);
      this.birth.push(f.birth);
      this.matStart.push(s);
      this.matFinal.push(f.positions);
    }
    this.setProgress(0);
  }

  setSepta(items: Septum[]): void {
    if (this.septa) {
      this.scene.remove(this.septa);
      this.septa.geometry.dispose();
      (this.septa.material as THREE.Material).dispose();
      this.septa = null;
    }
    this.septaIds = items.map((s) => s.id);
    this.septaStart = new Float32Array(items.length * 3);
    this.septaFinal = new Float32Array(items.length * 3);
    if (items.length === 0) return;
    const pos = new Float32Array(items.length * 3);
    const col = new Float32Array(items.length * 3);
    const size = new Float32Array(items.length);
    const c = new THREE.Color();
    items.forEach((s, i) => {
      this.septaStart[i * 3] = s.sx;
      this.septaStart[i * 3 + 1] = s.sy;
      this.septaStart[i * 3 + 2] = s.sz;
      this.septaFinal[i * 3] = s.x;
      this.septaFinal[i * 3 + 1] = s.y;
      this.septaFinal[i * 3 + 2] = s.z;
      this.finalBox.expandByPoint(new THREE.Vector3(s.x, s.y, s.z));
      // Start at the clustered spawn point — growth lerps toward the final spot.
      pos[i * 3] = s.sx;
      pos[i * 3 + 1] = s.sy;
      pos[i * 3 + 2] = s.sz;
      c.set(s.color);
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
      size[i] = 3 + s.weight * 7;
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("a_color", new THREE.BufferAttribute(col, 3));
    geo.setAttribute("a_size", new THREE.BufferAttribute(size, 1));
    // A FLAT disc with a soft edge — deliberately not the glow shader the space
    // renderer uses. A halo is what makes a node read as a star, and a septum
    // is a thickening of a thread, not a light source.
    const mtl = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {},
      vertexShader: `
        attribute vec3 a_color;
        attribute float a_size;
        varying vec3 v_color;
        void main() {
          v_color = a_color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = a_size * (320.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec3 v_color;
        void main() {
          vec2 d = gl_PointCoord - vec2(0.5);
          float r = length(d) * 2.0;
          if (r > 1.0) discard;
          float a = smoothstep(1.0, 0.72, r);
          gl_FragColor = vec4(v_color, a);
        }`,
    });
    this.septa = new THREE.Points(geo, mtl);
    this.septa.frustumCulled = false;
    this.scene.add(this.septa);
  }

  /** Reveal the mat up to `t` (0..1) of its growth — AND spread every note and
   *  hypha from its clustered start toward its final position by the same
   *  `t`. Node spread and edge reveal are one animation, driven by one clock:
   *  a straight-line thread that only just extended into view would still
   *  read as decorative; it has to arrive AT the note it connects. */
  setProgress(t: number): void {
    for (let i = 0; i < this.mat.length; i++) {
      const b = this.birth[i];
      let lo = 0;
      let hi = b.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (b[mid] <= t) lo = mid + 1;
        else hi = mid;
      }
      (this.mat[i].geometry as unknown as { instanceCount: number }).instanceCount = lo;

      const s = this.matStart[i];
      const f = this.matFinal[i];
      if (s !== f) {
        // Mutate the EXISTING interleaved buffer in place (instanceStart and
        // instanceEnd are two attribute views over one shared buffer) and flag
        // it for re-upload — calling setPositions() again here would allocate
        // a fresh GPU buffer every frame for the whole grow-in.
        const geo = this.mat[i].geometry as LineSegmentsGeometry;
        const buf = (geo.getAttribute("instanceStart") as THREE.InterleavedBufferAttribute)
          .data as THREE.InterleavedBuffer;
        const arr = buf.array as Float32Array;
        for (let k = 0; k < f.length; k++) arr[k] = s[k] + (f[k] - s[k]) * t;
        buf.needsUpdate = true;
      }
    }
    if (this.septa) {
      const posAttr = this.septa.geometry.getAttribute("position") as THREE.BufferAttribute;
      for (let i = 0; i < this.septaIds.length; i++) {
        const o = i * 3;
        posAttr.setXYZ(
          i,
          this.septaStart[o] + (this.septaFinal[o] - this.septaStart[o]) * t,
          this.septaStart[o + 1] + (this.septaFinal[o + 1] - this.septaStart[o + 1]) * t,
          this.septaStart[o + 2] + (this.septaFinal[o + 2] - this.septaStart[o + 2]) * t,
        );
      }
      posAttr.needsUpdate = true;
    }
  }

  startGrowth(secs: number): void {
    this.growSecs = Math.max(0, secs);
    if (this.growSecs === 0) {
      this.clock = -1;
      this.setProgress(1);
      return;
    }
    this.clock = 0;
    this.setProgress(0);
  }

  /** Lock (true) or free (false) the camera's tilt — the 2D view is a flat map
   *  you pan/zoom, not an orbitable scene; positions are already flattened to
   *  z≈0 by the caller, so a level, front-on view is all that's needed. */
  setPlanar(on: boolean): void {
    this.controls.enableRotate = !on;
    this.controls.minPolarAngle = on ? Math.PI / 2 : Math.PI * 0.15;
    this.controls.maxPolarAngle = on ? Math.PI / 2 : Math.PI * 0.85;
  }

  /** Frame the FINAL layout — using the precomputed box, not the live (possibly
   *  still-growing) geometry, so the camera doesn't frame the tiny starting
   *  cluster and get left behind as the mat spreads out from it. */
  fit(): void {
    const box = this.finalBox;
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const fov = (this.camera.fov * Math.PI) / 180;
    const dist = (sphere.radius * 1.25) / Math.tan(fov / 2);
    this.controls.target.copy(sphere.center);
    this.camera.position.set(sphere.center.x, sphere.center.y, sphere.center.z + dist);
    this.camera.near = Math.max(0.1, dist / 500);
    this.camera.far = dist * 8;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // LineMaterial rasterises width in screen pixels, so a stale resolution
    // leaves every hypha the wrong weight after a resize.
    for (const m of this.mat) (m.material as LineMaterial).resolution.set(w, h);
  }

  start(): void {
    if (this.raf != null) return;
    this.last = performance.now();
    const loop = (): void => {
      const now = performance.now();
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      if (this.clock >= 0) {
        this.clock += dt;
        const k = Math.min(1, this.clock / this.growSecs);
        // Ease out — hyphae push hardest at the start and settle at the rim.
        this.setProgress(1 - Math.pow(1 - k, 2));
        if (k >= 1) this.clock = -1;
      }
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.raf != null) cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  dispose(): void {
    this.stop();
    this.ro.disconnect();
    this.renderer.domElement.removeEventListener("pointermove", this.onMove);
    this.renderer.domElement.removeEventListener("click", this.onClick);
    this.controls.dispose();
    this.setMat([], []);
    this.setSepta([]);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
