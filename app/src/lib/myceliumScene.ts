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

/** One stroke-width bucket of hyphae. Colour rides per-vertex (see setMat)
 *  rather than a further per-bucket flat colour — a strand's colour varies
 *  by cluster along its own length (see buildMyceliumMat). */
export interface MatBucket {
  width: number;
  positions: Float32Array;
  /** Flat [r1,g1,b1, r2,g2,b2, …] (0..1), same layout as `positions`. */
  colors: Float32Array;
  /** Growth index per segment, ascending — drives the grow-in. */
  birth: Float32Array;
}

export interface Septum {
  id: string;
  /** Position on the grown mat — fixed; the mat doesn't move once grown. */
  x: number;
  y: number;
  z: number;
  /** Growth index (0..1) of the mat node this note sits on — see setProgress,
   *  which hides a septum until growth reaches it, same as a hypha segment. */
  birth: number;
  /** 0..1 — bigger for a more-linked note. */
  weight: number;
  color: THREE.ColorRepresentation;
}

/** A label's on-screen position for one rendered frame — see setLabelIds. */
export interface FrameLabel {
  id: string;
  x: number;
  y: number;
  /** 1 near the camera, fading toward MIN_LABEL_OPACITY on the far side of
   *  the mat — see depthT. In 2D the whole mat sits at roughly one distance
   *  from the locked-off camera, so this is ~1 everywhere and has no effect. */
  opacity: number;
}

export interface MyceliumSceneOpts {
  /** Substrate colour. A warm near-black loam, not a blue void. */
  ground?: number;
  onPick?: (id: string) => void;
  onHover?: (id: string | null) => void;
  /** Called once per rendered frame with the current screen position of every
   *  always-on label (see setLabelIds) that's grown in and on-screen — drives
   *  the hub-label overlay, which has to track the camera every frame since
   *  the mat itself never moves but the view does. */
  onFrame?: (labels: FrameLabel[]) => void;
}

const GROUND = 0x0b0a08;
// Hyphae opacity: normal, and dimmed while a neighbour highlight is active
// (setHighlight) — everything not part of the highlighted set fades toward
// the substrate so the lit path actually reads as "the answer".
const HYPHA_OPACITY = 0.85;
const HYPHA_DIM_OPACITY = 0.18;
// A label for a strand at the back of the ball must not read as if it were
// in front — see depthT/depthOpacity. Not so dim it's illegible; just enough
// recession to read as farther away.
const MIN_LABEL_OPACITY = 0.35;

export class MyceliumScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private container: HTMLElement;
  private opts: MyceliumSceneOpts;

  private mat: LineSegments2[] = [];
  private birth: Float32Array[] = [];
  private clock = -1;
  private growSecs = 3.2;
  /** Bounding box of the mat, computed once from the raw arrays — fit() must
   *  frame the whole grown mat, not just whatever is revealed mid-grow. */
  private finalBox: THREE.Box3 = new THREE.Box3();

  private septa: THREE.Points | null = null;
  private septaIds: string[] = [];
  /** note id -> its index in septaIds/the geometry's attribute arrays — O(1)
   *  lookup for setHighlight instead of an indexOf scan per hover change. */
  private septaIndexOf = new Map<string, number>();
  /** Septa indices currently carrying a non-zero a_hi (the hovered note plus
   *  its wikilink neighbours) — see setHighlight, which clears exactly these
   *  before applying the next set. */
  private highlightIdxs: number[] = [];
  /** The real hyphal path(s) between the hovered note and its neighbours,
   *  drawn bright over the (dimmed) base mat — see setHighlight. Lazily
   *  created on first use. */
  private highlightLine: LineSegments2 | null = null;
  /** Always-on hub label ids (see setLabelIds) — capped small by the caller. */
  private labelIds: string[] = [];
  /** Current growth progress (setProgress's `t`) — a label must not float
   *  over a septum that hasn't grown in yet. */
  private growT = 0;
  private raf: number | null = null;
  private last = 0;
  private ro: ResizeObserver;
  private hovered: string | null = null;
  /** true = 2D (flat, camera locked). Gates depthWrite on every mat/septa/
   *  highlight material — see setPlanar. The flat map has no real depth to
   *  speak of, so it keeps the original depthWrite:false look; the 3D view
   *  needs it on for near strands to actually occlude far ones. */
  private planar = false;

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
    this.renderer.domElement.addEventListener("pointerleave", this.onLeave);
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
  // pointermove alone never fires again once the cursor leaves the canvas —
  // without this, hovering a septum then moving the pointer off-canvas left
  // the label and the highlight stuck showing the last-hovered note.
  private onLeave = (): void => {
    if (this.hovered !== null) {
      this.hovered = null;
      this.renderer.domElement.style.cursor = "grab";
      this.opts.onHover?.(null);
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

  /** A septum's on-screen position (canvas-local CSS px), or null if it isn't
   *  in the current septa set or sits behind the camera. Used by the hover
   *  test harness to move the pointer onto a known note, and reused by the
   *  always-on hub-label projection each frame. */
  projectToScreen(id: string): { x: number; y: number } | null {
    const idx = this.septaIndexOf.get(id);
    if (idx == null || !this.septa) return null;
    const pos = this.septa.geometry.getAttribute("position") as THREE.BufferAttribute;
    const v = new THREE.Vector3(pos.getX(idx), pos.getY(idx), pos.getZ(idx));
    // Behind the camera: project()'s perspective divide by a negative w can
    // land inside [-1,1] NDC anyway, so check view-space z rather than trust
    // the projected coordinates blindly.
    const view = v.clone().applyMatrix4(this.camera.matrixWorldInverse);
    if (view.z > 0) return null;
    v.project(this.camera);
    const w = this.renderer.domElement.clientWidth;
    const h = this.renderer.domElement.clientHeight;
    return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h };
  }

  /** The mat doesn't move once grown — only more of it gets revealed over
   *  time (see setProgress), so positions here are set once and never lerped. */
  setMat(buckets: MatBucket[]): void {
    for (const m of this.mat) {
      this.scene.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.mat = [];
    this.birth = [];
    this.finalBox = new THREE.Box3();
    const res = new THREE.Vector2();
    this.renderer.getSize(res);
    for (const b of buckets) {
      if (b.positions.length === 0) continue;
      for (let k = 0; k < b.positions.length; k += 3) {
        this.finalBox.expandByPoint(new THREE.Vector3(b.positions[k], b.positions[k + 1], b.positions[k + 2]));
      }
      const geo = new LineSegmentsGeometry();
      geo.setPositions(b.positions);
      // Per-vertex colour (cluster hue, blended toward the flat base — see
      // buildMyceliumMat) rather than one flat material colour per bucket, so
      // a strand's colour can vary by cluster along its own length. `color:
      // 0xffffff` leaves vertex colour unmultiplied (LineMaterial's fragment
      // chunk does diffuseColor.rgb *= vColor).
      geo.setColors(b.colors);
      // LineMaterial, because LineBasicMaterial ignores `linewidth` on
      // essentially every platform — the reason hyphae were always hairlines.
      // depthWrite ties to the current 2D/3D mode (see setPlanar): off in 2D
      // (unchanged, flat-map look), on in 3D so a near strand actually
      // occludes a far one instead of both just blending by draw order.
      const mtl = new LineMaterial({
        color: 0xffffff,
        vertexColors: true,
        linewidth: b.width,
        transparent: true,
        opacity: HYPHA_OPACITY,
        depthWrite: !this.planar,
        worldUnits: false,
      });
      mtl.resolution.copy(res);
      const line = new LineSegments2(geo, mtl);
      line.frustumCulled = false;
      this.scene.add(line);
      this.mat.push(line);
      this.birth.push(b.birth);
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
    this.septaIndexOf = new Map(items.map((s, i) => [s.id, i]));
    this.highlightIdxs = []; // fresh geometry — nothing highlighted yet
    if (items.length === 0) return;
    const pos = new Float32Array(items.length * 3);
    const col = new Float32Array(items.length * 3);
    const size = new Float32Array(items.length);
    const birth = new Float32Array(items.length);
    const hi = new Float32Array(items.length); // 0 = normal; see setHighlight
    const c = new THREE.Color();
    items.forEach((s, i) => {
      pos[i * 3] = s.x;
      pos[i * 3 + 1] = s.y;
      pos[i * 3 + 2] = s.z;
      this.finalBox.expandByPoint(new THREE.Vector3(s.x, s.y, s.z));
      c.set(s.color);
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
      // Fixed screen-space size (device px, via pixelRatio) — like hyphae
      // linewidth (LineMaterial worldUnits:false), NOT perspective-attenuated
      // by distance. See the vertex shader below for why: a world-scaled size
      // here was measured sub-pixel (0.17-0.43px) at this renderer's actual
      // camera distance, for every TARGET_RADIUS this view has used — septa
      // were never really visible, independent of colour.
      size[i] = (6 + s.weight * 8) * this.renderer.getPixelRatio();
      birth[i] = s.birth;
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("a_color", new THREE.BufferAttribute(col, 3));
    geo.setAttribute("a_size", new THREE.BufferAttribute(size, 1));
    geo.setAttribute("a_birth", new THREE.BufferAttribute(birth, 1));
    geo.setAttribute("a_hi", new THREE.BufferAttribute(hi, 1));
    // A FLAT disc with a soft edge — deliberately not the glow shader the space
    // renderer uses. A halo is what makes a node read as a star, and a septum
    // is a thickening of a thread, not a light source.
    const mtl = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: !this.planar, // see setPlanar — real occlusion only in 3D
      uniforms: { u_t: { value: 0 }, u_dim: { value: 0 } },
      vertexShader: `
        attribute vec3 a_color;
        attribute float a_size;
        attribute float a_birth;
        attribute float a_hi;
        uniform float u_t;
        varying vec3 v_color;
        varying float v_grown;
        varying float v_hi;
        void main() {
          v_color = a_color;
          v_hi = a_hi;
          // Hidden until growth reaches this note's spot on the mat — same
          // birth-index reveal as a hypha segment, just per-point.
          v_grown = step(a_birth, u_t);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          // Hover/neighbour highlight grows the point a touch, not a halo —
          // size reads as "lit up" without turning a septum into a glow.
          float sizeBoost = 1.0 + v_hi * 0.6;
          // Fixed screen-space size, not distance-attenuated — see a_size's
          // assignment in setSepta for why. A septum only needs to be findable
          // from a normal viewing distance, not shrink into invisibility on a
          // big mat the way a physically-scaled marker would.
          gl_PointSize = a_size * v_grown * sizeBoost;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec3 v_color;
        varying float v_grown;
        varying float v_hi;
        uniform float u_dim;
        void main() {
          if (v_grown < 0.5) discard;
          vec2 d = gl_PointCoord - vec2(0.5);
          float r = length(d) * 2.0;
          if (r > 1.0) discard;
          float a = smoothstep(1.0, 0.72, r);
          // Brighten toward white rather than just raising alpha — reads as
          // "lit up", not "less transparent".
          vec3 col = mix(v_color, vec3(1.0), v_hi * 0.55);
          // While a highlight is active (u_dim=1), everything not flagged
          // a_hi fades toward the substrate; the hovered note (v_hi=1) and
          // its neighbours (v_hi=0.7, set by setHighlight) stay lit.
          float dimMul = mix(1.0, mix(0.15, 1.0, v_hi), u_dim);
          gl_FragColor = vec4(col, a * dimMul);
        }`,
    });
    this.septa = new THREE.Points(geo, mtl);
    this.septa.frustumCulled = false;
    this.scene.add(this.septa);
  }

  /** Brighten the hovered note + its wikilink neighbours, dim everything
   *  else, and draw `pathPositions` (the real hyphal route between them —
   *  see MyceliumView's matPath-based BFS) as a bright overlay. Pass a null
   *  id to clear the highlight entirely (undim, hide the overlay). A note
   *  with no neighbours is just "brighten this one point, dim the rest" —
   *  Part 1's original hover behaviour, as the neighbours-empty case. */
  setHighlight(hoveredId: string | null, neighborIds: string[], pathPositions: Float32Array): void {
    if (!this.septa) return;
    const attr = this.septa.geometry.getAttribute("a_hi") as THREE.BufferAttribute;
    for (const i of this.highlightIdxs) attr.setX(i, 0);
    this.highlightIdxs = [];
    const hoveredIdx = hoveredId != null ? this.septaIndexOf.get(hoveredId) : undefined;
    if (hoveredIdx != null) {
      attr.setX(hoveredIdx, 1);
      this.highlightIdxs.push(hoveredIdx);
    }
    for (const nid of neighborIds) {
      const idx = this.septaIndexOf.get(nid);
      if (idx == null) continue;
      attr.setX(idx, 0.7);
      this.highlightIdxs.push(idx);
    }
    attr.needsUpdate = true;

    const active = hoveredIdx != null;
    (this.septa.material as THREE.ShaderMaterial).uniforms.u_dim.value = active ? 1 : 0;
    const hyphaOpacity = active ? HYPHA_DIM_OPACITY : HYPHA_OPACITY;
    for (const m of this.mat) (m.material as LineMaterial).opacity = hyphaOpacity;

    this.updateHighlightLine(pathPositions);
  }

  /** (Re)builds the bright overlay line from scratch each call — the
   *  highlighted path is small (a note's own links, ~1.2 hyphal hops apart
   *  on average) and only changes on a hover-id change, not every frame, so
   *  a fresh LineSegmentsGeometry per call is cheap enough. */
  private updateHighlightLine(positions: Float32Array): void {
    if (!this.highlightLine) {
      // Same depth rule as the base mat (see setPlanar): in 3D the highlight
      // is a real path through the ball and should weave behind nearer
      // strands, not float on top regardless of where the hovered note is.
      const mtl = new LineMaterial({
        color: 0xfff2d8,
        linewidth: 3,
        transparent: true,
        opacity: 0.95,
        depthWrite: !this.planar,
        worldUnits: false,
      });
      const res = new THREE.Vector2();
      this.renderer.getSize(res);
      mtl.resolution.copy(res);
      this.highlightLine = new LineSegments2(new LineSegmentsGeometry(), mtl);
      this.highlightLine.frustumCulled = false;
      this.highlightLine.renderOrder = 1; // over the dimmed base mat
      this.scene.add(this.highlightLine);
    }
    this.highlightLine.visible = positions.length > 0;
    if (positions.length > 0) {
      this.highlightLine.geometry.dispose();
      const geo = new LineSegmentsGeometry();
      geo.setPositions(positions);
      this.highlightLine.geometry = geo;
    }
  }

  /** Note ids that should carry an always-on label (the caller caps this
   *  small — see MyceliumView's HUB_LABEL_CAP). Their screen positions are
   *  reported to opts.onFrame every rendered frame. */
  setLabelIds(ids: string[]): void {
    this.labelIds = ids;
  }

  /** Reveal the mat up to `t` (0..1) of its growth — hyphae by instance count
   *  (binary search on each bucket's ascending birth index) and septa by the
   *  same birth threshold on the GPU (see setSepta's shader). Nothing moves;
   *  growing is revealing, not animating a spread. */
  setProgress(t: number): void {
    this.growT = t;
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
    }
    if (this.septa) {
      (this.septa.material as THREE.ShaderMaterial).uniforms.u_t.value = t;
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

  /** Growth state snapshot — cheap, read-only, for the screenshot/measurement
   *  harness (window.__myceliumDev). Not used by the running app itself. */
  debugSnapshot(): {
    revealed: number[];
    totalSegments: number[];
    samplePos: [number, number, number] | null;
  } {
    const revealed = this.mat.map(
      (m) => (m.geometry as unknown as { instanceCount: number }).instanceCount,
    );
    const totalSegments = this.birth.map((b) => b.length);
    let samplePos: [number, number, number] | null = null;
    if (this.septa && this.septaIds.length > 0) {
      const pos = this.septa.geometry.getAttribute("position") as THREE.BufferAttribute;
      samplePos = [pos.getX(0), pos.getY(0), pos.getZ(0)];
    }
    return { revealed, totalSegments, samplePos };
  }

  /** Lock (true) or free (false) the camera's tilt — the 2D view is a flat map
   *  you pan/zoom, not an orbitable scene; positions are already flattened to
   *  z≈0 by the caller, so a level, front-on view is all that's needed. */
  setPlanar(on: boolean): void {
    this.controls.enableRotate = !on;
    this.controls.minPolarAngle = on ? Math.PI / 2 : Math.PI * 0.15;
    this.controls.maxPolarAngle = on ? Math.PI / 2 : Math.PI * 0.85;
    this.planar = on;
    // Live-update whatever materials already exist (setMat/setSepta run
    // before this in MyceliumView's mount order) — see the depthWrite
    // comments on each material's creation for why this is the one thing
    // that actually makes orbiting read as a volume.
    for (const m of this.mat) (m.material as LineMaterial).depthWrite = !on;
    if (this.septa) (this.septa.material as THREE.ShaderMaterial).depthWrite = !on;
    if (this.highlightLine) (this.highlightLine.material as LineMaterial).depthWrite = !on;
  }

  /** 0 (nearest point of the mat's bounding sphere, from the current camera)
   *  .. 1 (farthest) — a cheap depth cue for labels. Not a true occlusion
   *  test (that would mean raycasting the whole mat per label per frame);
   *  distance through the mat's own bounding sphere is a fair proxy since
   *  the grown mat is roughly a ball. In 2D the flattened disc sits at
   *  ~one distance from the locked-off camera, so this comes out ~constant
   *  and the depth fade has no visible effect — nothing to fix there. */
  private depthT(pos: THREE.Vector3): number {
    const sphere = this.finalBox.getBoundingSphere(new THREE.Sphere());
    if (sphere.radius <= 1e-6) return 0;
    const centerDist = this.camera.position.distanceTo(sphere.center);
    const dist = this.camera.position.distanceTo(pos);
    const t = (dist - (centerDist - sphere.radius)) / (2 * sphere.radius);
    return Math.max(0, Math.min(1, t));
  }

  /** Opacity a label for this note should render at right now — see depthT.
   *  Used by the hover label, whose position follows the cursor rather than
   *  a projected point (see MyceliumView), so it can't come from onFrame's
   *  per-frame label list the way the always-on hub labels do. */
  depthOpacity(id: string): number {
    const idx = this.septaIndexOf.get(id);
    if (idx == null || !this.septa) return 1;
    const pos = this.septa.geometry.getAttribute("position") as THREE.BufferAttribute;
    const v = new THREE.Vector3(pos.getX(idx), pos.getY(idx), pos.getZ(idx));
    return 1 - this.depthT(v) * (1 - MIN_LABEL_OPACITY);
  }

  /** Frame the WHOLE grown mat — using the precomputed box, not the live
   *  (possibly still-growing, i.e. partially revealed) geometry, so the camera
   *  doesn't frame just what's visible early in the grow-in and get left
   *  behind as more of the mat reveals. */
  fit(): void {
    const box = this.finalBox;
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const fov = (this.camera.fov * Math.PI) / 180;
    // Padding above 1 (bounding-sphere radius / tan(fov/2) exactly fills the
    // frame vertically). 1.25 left ~1/5 of the frame as margin — measured at
    // 1244 notes, the mat read as small (~12% of the canvas by pixel count).
    // A sphere's silhouette is rotation-invariant, so tightening this is safe
    // in 3D too: orbiting never pushes the mat past the frame the way it
    // would for a non-spherical bound.
    const dist = (sphere.radius * 1.05) / Math.tan(fov / 2);
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
    if (this.highlightLine) (this.highlightLine.material as LineMaterial).resolution.set(w, h);
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
      if (this.opts.onFrame && this.labelIds.length > 0) this.reportLabelFrame();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** Project every always-on label id to screen space for this frame, skipping
   *  whichever haven't grown in yet (see setProgress's growT), sit behind the
   *  camera, or would stack on a higher-degree label already placed this
   *  frame (busy hubs cluster close together on the mat, and 20 legible
   *  labels beats 20 overlapping ones). Capped list (setLabelIds), so the
   *  O(n^2) stacking check is cheap even at 60fps. */
  private reportLabelFrame(): void {
    if (!this.septa) return;
    const birthAttr = this.septa.geometry.getAttribute("a_birth") as THREE.BufferAttribute;
    const posAttr = this.septa.geometry.getAttribute("position") as THREE.BufferAttribute;
    const MIN_GAP = 22; // px — roughly one label's line height
    const out: FrameLabel[] = [];
    for (const id of this.labelIds) {
      const idx = this.septaIndexOf.get(id);
      if (idx == null || birthAttr.getX(idx) > this.growT) continue;
      const s = this.projectToScreen(id);
      if (!s) continue;
      if (out.some((o) => Math.abs(o.x - s.x) < MIN_GAP && Math.abs(o.y - s.y) < MIN_GAP)) continue;
      const v = new THREE.Vector3(posAttr.getX(idx), posAttr.getY(idx), posAttr.getZ(idx));
      const opacity = 1 - this.depthT(v) * (1 - MIN_LABEL_OPACITY);
      out.push({ id, x: s.x, y: s.y, opacity });
    }
    this.opts.onFrame!(out);
  }

  stop(): void {
    if (this.raf != null) cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  dispose(): void {
    this.stop();
    this.ro.disconnect();
    this.renderer.domElement.removeEventListener("pointermove", this.onMove);
    this.renderer.domElement.removeEventListener("pointerleave", this.onLeave);
    this.renderer.domElement.removeEventListener("click", this.onClick);
    this.controls.dispose();
    this.setMat([]);
    this.setSepta([]);
    if (this.highlightLine) {
      this.scene.remove(this.highlightLine);
      this.highlightLine.geometry.dispose();
      (this.highlightLine.material as THREE.Material).dispose();
      this.highlightLine = null;
    }
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
