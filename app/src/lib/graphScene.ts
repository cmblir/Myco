// three.js renderer for the vault graph — the 3D "universe" replacement for the
// sigma.js 2D view. Encapsulates the entire WebGL scene behind an imperative
// API so PageGraph stays a thin React orchestrator (refs + effects + store
// subscriptions), structurally parallel to the sigma version it replaces.
//
// Stars are rendered as a THREE.Points cloud whose custom glow shader ports the
// old sigma NodeGlowProgram (bright core + soft radial halo, now with
// perspective size attenuation and distance fade). Edges are faint additive
// filaments. A starfield + FogExp2 + UnrealBloom give the deep-space look, and
// OrbitControls (with idle auto-rotate) provide the real z-axis orbit. Labels
// reuse the app font via CSS2DRenderer with sigma's hub-first size threshold.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import {
  CSS2DRenderer,
  CSS2DObject,
} from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { VaultGraph } from "./graphData";
import type { GraphTheme } from "./graphTheme";
import type { GraphSettings } from "./graphSettings";
import { NebulaLayer } from "./nebulaLayer";
import { PulseLayer } from "./pulseLayer";

// World radius (in sim units) per unit of node `size`, and how far the halo
// extends past the core — mirrors the old GLOW_SCALE 2.6 intent in 3D.
const NODE_RADIUS = 3.4;
const GLOW_SCALE = 3.2;
const PICK_BASE_PX = 14;

// Semantic zoom label budget: at the framed (zoomed-out) distance only the top
// LABEL_MIN hubs may label; zooming in grows the candidate pool up to LABEL_MAX
// (top-degree first). Capped so updateLabels only ever visits a tiny set/frame.
const LABEL_MIN = 12;
const LABEL_MAX = 64;

// Edges carry the "neural mesh": each end is tinted by its node's community
// colour (intra-cluster edges glow the cluster hue, inter-cluster edges gradient
// between the two), and the additive sum of a dense cluster's many edges builds
// the glow. These are per-end brightness multipliers on that colour.
// Edges are faint connective tissue, NOT a light source: on a 10k-node vault the
// additive sum of tens of thousands of bright edges floods the core to a white
// wash and drowns the star colours. Kept dim so the bright NODES (and hub cores)
// carry the light and the web only hints the weave between lobes — the galaxy/
// brain reads as points of light threaded on a faint mesh, not a glowing blob.
const EDGE_OPACITY = 0.2; // base material opacity (× linkThickness)
const EDGE_BASE = 0.22; // default per-end brightness (edges are tissue, not light)
const EDGE_HI = 1.15; // incident edges on hover (pop)
const EDGE_DIM = 0.06; // non-incident edges on hover (fade, not vanish)

// Reference look is a clean neural mesh on a calm void. The faint parallax
// starfield gives the cosmic-web depth cosmic-refs.md asks for; the dim graded
// shells (buildStarfield) read as deep-field stars, not confetti. Flip to off
// for the bare-void look.
const SHOW_NEBULA = true;
const SHOW_STARFIELD = true;

// Fat filament overlay (LineSegments2 over hub-incident edges). OFF as an
// always-on layer: in a hub-and-spoke community nearly every edge is
// hub-incident, so the overlay painted whole clusters as bright additive
// spokes whose summed luminance blew past the bloom threshold at the core —
// the "firework" look (specs/2026-07-03-graph-calm-cosmic-web.md). The
// infrastructure stays for Phase 3, where filaments return as a rare
// focus/path-only layer (hover incidents + shortestPath results).
const SHOW_FILAMENTS = false;
const FILAMENT_MAX = 1200; // cap on glowing strands (perf)
const FILAMENT_WIDTH = 2.4; // screen px (LineMaterial, worldUnits=false)
const FILAMENT_BASE = 0.9; // brighter than thin edges → catches bloom as a strand
const FILAMENT_HI = 1.6; // incident on hover (pop)
const FILAMENT_DIM = 0.12; // non-incident on hover (fade)

export interface GraphSceneCallbacks {
  onNodeClick(id: string): void;
  onNodeHover(id: string | null): void;
  onDragStart(id: string): void;
  onDrag(id: string, x: number, y: number, z: number): void;
  onDragEnd(id: string): void;
  onContextRestored(): void;
}

// Transient styling driven by PageGraph: hover neighbourhood + live-ingest tint.
export interface SceneStyleState {
  hoveredNode: string | null;
  neighbors: Set<string> | null;
  tints: Map<string, boolean>; // id → written (true) vs only read (false)
  pulseId: string | null;
  pulseScale: number;
}

const EMPTY_STYLE: SceneStyleState = {
  hoveredNode: null,
  neighbors: null,
  tints: new Map(),
  pulseId: null,
  pulseScale: 1,
};

const INGEST_WRITE = new THREE.Color("#ffd27a");
const INGEST_READ = new THREE.Color("#7fe1ff");

function parseRGBA(s: string): { color: THREE.Color; alpha: number } {
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/i.exec(s);
  if (m) {
    return {
      color: new THREE.Color(+m[1] / 255, +m[2] / 255, +m[3] / 255),
      alpha: m[4] !== undefined ? +m[4] : 1,
    };
  }
  try {
    return { color: new THREE.Color(s), alpha: 1 };
  } catch {
    return { color: new THREE.Color(0.6, 0.66, 0.8), alpha: 0.1 };
  }
}

const NODE_VERT = /* glsl */ `
attribute float a_size;
attribute vec3 a_color;
attribute float a_alpha;
attribute float a_intensity;
uniform float u_pixelRatio;
uniform float u_sizeScale;
uniform float u_fogNear;
uniform float u_fogFar;
uniform float u_time;
varying vec3 v_color;
varying float v_alpha;
varying float v_fade;
varying float v_int;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float dist = max(1.0, -mv.z);
  gl_PointSize = a_size * ${NODE_RADIUS.toFixed(1)} * ${GLOW_SCALE.toFixed(1)} * u_sizeScale * u_pixelRatio / dist;
  gl_PointSize *= (1.0 + a_intensity * 0.35); // hub cores a touch larger
  // Gentle breathing — slow and subtle (motion budget: idle motion must not
  // grab the eye).
  gl_PointSize *= 1.0 + 0.025 * sin(u_time * 0.6 + position.x * 0.03 + position.y * 0.021);
  // Floor at 1.3 so distant field stars are true pinpricks, not uniform
  // confetti; cap at 180 so a near hub can't fill the viewport with one sprite.
  gl_PointSize = clamp(gl_PointSize, 1.3, 180.0);
  gl_Position = projectionMatrix * mv;
  v_color = a_color;
  v_alpha = a_alpha;
  v_int = a_intensity;
  // Nearer stars brighter; distant ones fade into the fog. Floor at 0.25 so the
  // far field never fully vanishes.
  v_fade = clamp((u_fogFar - dist) / max(1.0, u_fogFar - u_fogNear), 0.25, 1.0);
}
`;

const NODE_FRAG = /* glsl */ `
precision mediump float;
varying vec3 v_color;
varying float v_alpha;
varying float v_fade;
varying float v_int;
void main() {
  float d = length(gl_PointCoord - vec2(0.5)) * 2.0;
  float core = 1.0 - smoothstep(0.30, 0.45, d);  // solid bright centre
  float glow = pow(max(0.0, 1.0 - d), 2.2);        // soft halo to the edge
  float a = max(core, glow * 0.6) * v_alpha * v_fade;
  if (a < 0.004) discard;
  // Hub cores get an HDR boost (v_int>1) so UnrealBloom catches only them, and
  // a white-hot push toward their centre; field stars keep their hue.
  vec3 base = v_color * (0.65 + 0.35 * v_fade);
  // HDR core boost MULTIPLIES the star's own colour (not neutral white), so a
  // blue-white core stays blue-white and an amber field star stays amber.
  // Peak ≈ base×2.7 (was ×4.6): additive overlap in a dense nucleus sums past
  // any per-sprite cap, so per-sprite HDR stays low — density earns brightness.
  vec3 col = base + base * core * (0.2 + v_int * 0.9);
  // Minimal white mix: ACES already rolls bright cores toward white, so the
  // shader must not force it — hubs stay hot in their OWN hue.
  col = mix(col, vec3(1.0), core * clamp(v_int * 0.22, 0.0, 0.28));
  gl_FragColor = vec4(col, a);
}
`;

export class GraphScene {
  private container: HTMLDivElement;
  private graph: VaultGraph;
  private theme: GraphTheme;
  private settings: GraphSettings;
  private cb: GraphSceneCallbacks;

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private baseBloom = 1.2; // theme-derived bloom strength before brightness scaling
  private labelRenderer: CSS2DRenderer;

  private points: THREE.Points;
  private nodeGeom: THREE.BufferGeometry;
  private nodeMat: THREE.ShaderMaterial;
  private nodeIds: string[];
  private idIndex = new Map<string, number>();

  private edges: THREE.LineSegments;
  private edgeGeom: THREE.BufferGeometry;
  private edgeMat: THREE.LineBasicMaterial;
  private edgePairs: [string, string][];
  // [srcIndex, tgtIndex] per edge (into nodeIds/idIndex), resolved once on
  // build/rebuild. The per-tick position path copies endpoint positions out of
  // the node position buffer by these integer indices — no graphology lookups,
  // no hex-colour parsing per edge per tick (the dominant 10k-node settle cost).
  private edgeEndIdx: Int32Array = new Int32Array(0);

  // Fat glowing filament overlay (hub-incident edges). Null when disabled or
  // when the graph has no hubs (edgeless / tiny vault).
  private filaments: LineSegments2 | null = null;
  private filamentGeom: LineSegmentsGeometry | null = null;
  private filamentMat: LineMaterial | null = null;
  private filamentEdges: number[] = []; // indices into edgePairs that get the glow

  // Direction arrowheads (one instanced cone per edge, at the target end). The
  // graph is undirected; direction follows edge insertion order, matching the
  // old sigma "Arrows" toggle. Hidden unless settings.arrows is on.
  private arrows: THREE.InstancedMesh;
  private arrowGeom: THREE.ConeGeometry;
  private arrowMat: THREE.MeshBasicMaterial;

  // Multi-shell parallax background (2-3 Points layers in one Group) for depth.
  private starfield: THREE.Group;
  private nebula: NebulaLayer;
  private nebulaTick = 0; // throttle nebula centroid recompute (every Nth tick)
  private pulse: PulseLayer; // signals flowing along edges (alive/communication)
  private lastFrame = 0; // performance.now() of the previous animation frame
  private labels = new Map<string, CSS2DObject>();
  // Degree-ranked label candidates (top LABEL_MAX). Semantic zoom slices this by
  // camera distance so more labels surface as you zoom in; everything else stays
  // label-silent so the cosmos isn't covered in date-stamp clutter. framedDist
  // is the fit() distance used as the zoom reference.
  private labelRank: string[] = [];
  private framedDist = 0;
  // Per-frame label bookkeeping so updateLabels touches only the ≤13 candidate
  // labels (labelable + hovered) instead of looping all 10k nodes every frame.
  private shownLabels = new Set<string>();
  private labelCandidates = new Set<string>();

  private style: SceneStyleState = EMPTY_STYLE;
  private raf: number | null = null;
  private resizeObs: ResizeObserver;
  private reducedMotion: boolean;

  // pointer / drag state
  private dragId: string | null = null;
  private dragMoved = false;
  private downAt: { x: number; y: number } | null = null;
  private hoverId: string | null = null;
  // Latest hover position awaiting a pick. pickNode projects all nodes, so we
  // coalesce to at most ONE pick per render frame instead of one per pointermove
  // (which fires 100-120×/s on fast moves / high-refresh input).
  private pendingPick: { x: number; y: number } | null = null;

  private raycaster = new THREE.Raycaster();
  private tmpVec = new THREE.Vector3();
  private tmpNdc = new THREE.Vector2();
  private dragPlane = new THREE.Plane();

  constructor(
    container: HTMLDivElement,
    graph: VaultGraph,
    theme: GraphTheme,
    settings: GraphSettings,
    cb: GraphSceneCallbacks,
  ) {
    this.container = container;
    this.graph = graph;
    this.theme = theme;
    this.settings = settings;
    this.cb = cb;
    this.reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    const pr = Math.min(window.devicePixelRatio || 1, 2); // cap bloom cost

    const bg = parseRGBA(theme.bg).color;
    const dark = bg.getHSL({ h: 0, s: 0, l: 0 }).l < 0.5;
    // Soft near-black with a faint blue cast (space, not a harsh flat black, and
    // no busy dot grid — the mesh reads better on a calm void).
    const sceneBg = dark ? new THREE.Color(0x05060d) : bg;
    this.scene.background = sceneBg;
    // Graded atmospheric depth (lower than the old 0.00065 so far parallax star
    // shells fade in instead of being fogged out).
    // Light fog for depth, but thin enough that the whole graph stays visible
    // when zoomed all the way out (a denser fog faded large vaults to black).
    this.scene.fog = new THREE.FogExp2(sceneBg.getHex(), dark ? 0.00012 : 0.00004);

    // far plane large enough to hold a wide, fully-zoomed-out layout.
    this.camera = new THREE.PerspectiveCamera(58, w / h, 0.5, 40000);
    this.camera.position.set(0, 0, 900);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
      alpha: true, // transparent canvas so the CSS dot-grid backdrop shows
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // Brightness slider drives overall scene exposure (light intensity).
    this.renderer.toneMappingExposure = settings.brightness;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.classList.add("graph-canvas-3d");
    container.appendChild(this.renderer.domElement);

    this.labelRenderer = new CSS2DRenderer();
    // At most ~13 labels ever show (TOP_N + hover), so depth-sorting all 10k
    // CSS2DObjects every frame — a fresh 10k-array build + sort + 10k zIndex DOM
    // writes — is pure waste. Disabling it removes that whole per-frame pass.
    this.labelRenderer.sortObjects = false;
    this.labelRenderer.setSize(w, h);
    const ld = this.labelRenderer.domElement;
    ld.style.position = "absolute";
    ld.style.inset = "0";
    ld.style.pointerEvents = "none";
    ld.classList.add("graph-labels-3d");
    container.appendChild(ld);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.rotateSpeed = 0.7;
    this.controls.zoomSpeed = 0.9;
    this.controls.minDistance = 8; // closer zoom-in
    this.controls.maxDistance = 30000; // far zoom-out for large / spread-out vaults
    this.controls.autoRotate = !this.reducedMotion;
    this.controls.autoRotateSpeed = 0.12; // premium idle motion is slow

    // Bloom — deep-space glow. The high-pass runs on the LINEAR (un-tone-mapped)
    // composer buffer, where lone field stars peak at luminance ~1.16; a dark
    // threshold of 1.3 sits just above that so ONLY the HDR hub cores
    // (a_intensity-boosted) and dense additive clumps bloom into glowing galaxy
    // centres — the field stays crisp instead of washing into fog.
    // HDR pipeline: render into an explicit HALF-FLOAT target so values >1.0
    // survive into the bloom high-pass instead of clamping to white (the
    // "uniform white puff" root cause). v0.184 defaults to HalfFloatType, but we
    // pass it explicitly so a future upgrade can't silently drop us to 8-bit LDR.
    const hdrTarget = new THREE.WebGLRenderTarget(
      Math.max(1, Math.floor(w * pr)),
      Math.max(1, Math.floor(h * pr)),
      { type: THREE.HalfFloatType },
    );
    this.composer = new EffectComposer(this.renderer, hdrTarget);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // Bloom runs on the LINEAR HDR buffer. Calibrated for ADDITIVE SUMMING, not
    // single sprites: two overlapping field stars already reach ~2.3, so the
    // dark threshold sits at 1.9 (gates pair-overlaps; only true hub cores and
    // dense nuclei bloom). Modest strength + a wider radius read as soft
    // atmospheric glow instead of a hard white disc.
    // Strength is brightness-INDEPENDENT: exposure already scales the whole image
    // via OutputPass, so double-multiplying would blow the glow into a wash.
    this.baseBloom = dark ? 0.45 : 0.25;
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(w, h),
      this.baseBloom,
      0.7, // radius (soft atmospheric halo, not a hard ring)
      dark ? 1.9 : 0.7, // threshold above the additive pair-overlap ceiling
    );
    this.composer.addPass(this.bloom);
    // OutputPass MUST be last: it re-applies renderer.toneMapping (ACES) +
    // toneMappingExposure + sRGB on the final HDR buffer. Without it the HDR
    // range is never compressed and bright pixels clamp to flat white.
    this.composer.addPass(new OutputPass());

    // --- nodes ---
    this.nodeIds = graph.nodes();
    this.nodeIds.forEach((id, i) => this.idIndex.set(id, i));
    const n = this.nodeIds.length;
    this.nodeGeom = new THREE.BufferGeometry();
    this.nodeGeom.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(n * 3), 3),
    );
    this.nodeGeom.setAttribute(
      "a_color",
      new THREE.BufferAttribute(new Float32Array(n * 3), 3),
    );
    this.nodeGeom.setAttribute(
      "a_size",
      new THREE.BufferAttribute(new Float32Array(n), 1),
    );
    this.nodeGeom.setAttribute(
      "a_alpha",
      new THREE.BufferAttribute(new Float32Array(n), 1),
    );
    this.nodeGeom.setAttribute(
      "a_intensity",
      new THREE.BufferAttribute(new Float32Array(n), 1),
    );
    this.nodeMat = new THREE.ShaderMaterial({
      uniforms: {
        u_pixelRatio: { value: pr },
        u_sizeScale: { value: this.sizeScale(h) },
        u_fogNear: { value: 200 },
        u_fogFar: { value: 2600 },
        u_time: { value: 0 },
      },
      vertexShader: NODE_VERT,
      fragmentShader: NODE_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      // Additive on dark themes so dense clumps self-brighten into glowing
      // galaxy cores; normal on light themes (additive would wash to white).
      blending: dark ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(this.nodeGeom, this.nodeMat);
    this.points.frustumCulled = false;
    this.scene.add(this.points);

    // --- edges ---
    this.edgePairs = graph.mapEdges((_e, _a, s, t) => [s, t] as [string, string]);
    this.buildEdgeIndex();
    this.edgeGeom = new THREE.BufferGeometry();
    this.edgeGeom.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(this.edgePairs.length * 6), 3),
    );
    this.edgeGeom.setAttribute(
      "color",
      new THREE.BufferAttribute(new Float32Array(this.edgePairs.length * 6), 3),
    );
    this.edgeMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: Math.min(1, EDGE_OPACITY * settings.linkThickness),
      depthWrite: false,
      // Additive on dark (colored edges glow + sum into the mesh); normal on
      // light (additive would wash saturated edges to white over a near-white bg).
      blending: dark ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.edges = new THREE.LineSegments(this.edgeGeom, this.edgeMat);
    this.edges.frustumCulled = false;
    this.scene.add(this.edges);

    // --- fat glowing filament overlay (hub-incident edges) ---
    if (SHOW_FILAMENTS) this.buildFilaments();

    // --- direction arrowheads (instanced cones, one per edge) ---
    this.arrowGeom = new THREE.ConeGeometry(2.2, 7, 10); // points +Y; oriented per-edge
    this.arrowMat = new THREE.MeshBasicMaterial({
      color: parseRGBA(theme.edgeHi).color,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.arrows = new THREE.InstancedMesh(
      this.arrowGeom,
      this.arrowMat,
      Math.max(1, this.edgePairs.length),
    );
    this.arrows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.arrows.frustumCulled = false;
    this.arrows.visible = settings.arrows;
    this.scene.add(this.arrows);

    // --- starfield (distant, dim, multi-shell parallax depth) — off by default ---
    this.starfield = SHOW_STARFIELD ? this.buildStarfield(dark) : new THREE.Group();
    if (SHOW_STARFIELD) this.scene.add(this.starfield);

    // --- nebula/dust (faint additive gas over the biggest galaxies) ---
    this.nebula = new NebulaLayer(this.graph, this.nodeIds, dark && SHOW_NEBULA);
    this.scene.add(this.nebula.group);

    // --- pulses (signals flowing along the edges, so the graph reads as alive) ---
    this.pulse = new PulseLayer(this.graph, this.edgePairs, pr, dark);
    this.scene.add(this.pulse.points);

    // --- label allow-set (declutter) ---
    this.computeLabelable();

    // --- labels ---
    for (const id of this.nodeIds) {
      const el = document.createElement("div");
      el.className = "graph-label-3d";
      el.textContent = this.graph.getNodeAttribute(id, "label");
      el.style.color = theme.ink;
      const obj = new CSS2DObject(el);
      obj.visible = false;
      this.scene.add(obj);
      this.labels.set(id, obj);
    }

    this.writeNodes();
    this.writeEdges();
    this.writeArrows();
    this.fit();

    // pointer events
    const el = this.renderer.domElement;
    el.addEventListener("pointermove", this.onPointerMove);
    el.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointerup", this.onPointerUp);
    el.addEventListener("webglcontextlost", this.onCtxLost);
    el.addEventListener("webglcontextrestored", this.onCtxRestored);

    this.resizeObs = new ResizeObserver(() => this.onResize());
    this.resizeObs.observe(container);
  }

  private sizeScale(height: number): number {
    // px-per-world-unit at unit distance: (viewportHeight/2) / tan(fov/2)
    const fovRad = (this.camera.fov * Math.PI) / 180;
    return height / 2 / Math.tan(fovRad / 2);
  }

  // Allow-set of ids that may label at rest: the global top-N by degree only.
  // (The old rule also labelled every Louvain hub, which on a small or dense
  // vault promoted nearly every node → overlapping label spam.) Recomputed on
  // rebuild so live-ingest newcomers can label. Deterministic (deg desc, id
  // tiebreak). Everything else still labels on hover.
  private computeLabelable(): void {
    const byDeg = [...this.nodeIds].sort((a, b) => {
      const da = this.graph.getNodeAttribute(a, "deg");
      const db = this.graph.getNodeAttribute(b, "deg");
      return db - da || (a < b ? -1 : 1);
    });
    this.labelRank = byDeg.slice(0, LABEL_MAX);
  }

  // Deterministic 0..1 LCG stream (no Math.random — keeps the cosmos identical
  // across reloads / theme toggles). `n` indexes the stream; reproducible.
  private static starRand(n: number): number {
    let x = (n * 1664525 + 1013904223) >>> 0; // Numerical Recipes LCG
    x ^= x >>> 15;
    x = (x * 2246822519) >>> 0;
    x ^= x >>> 13;
    return (x >>> 0) / 4294967296;
  }

  // Three parallax shells (near/mid/far). Closer shells are larger + brighter
  // and parallax faster against the graph as the camera orbits; the far shell is
  // a dense, tiny, very dim wash that fixes the horizon. sizeAttenuation:false
  // keeps points pixel-sized, and a plain low-opacity PointsMaterial (NOT the
  // additive HDR node shader) guarantees these never bloom — depth cue only.
  private buildStarfield(dark: boolean): THREE.Group {
    const group = new THREE.Group();
    const shells = dark
      ? [
          // Background must never compete with foreground (luminance budget) —
          // dimmer than the dim edges so the hierarchy stays nodes > edges > sky.
          { count: 900, r0: 2400, r1: 3000, size: 1.6, color: 0xbcc6e0, op: 0.3 },
          { count: 1100, r0: 3600, r1: 4600, size: 1.4, color: 0x8f9ec4, op: 0.2 },
          { count: 1400, r0: 5200, r1: 6400, size: 1.0, color: 0x6b7aa6, op: 0.12 },
        ]
      : [
          { count: 700, r0: 2400, r1: 3000, size: 1.5, color: 0xc6cee0, op: 0.28 },
          { count: 900, r0: 3600, r1: 4600, size: 1.1, color: 0xb2bcd2, op: 0.18 },
          { count: 1100, r0: 5200, r1: 6400, size: 0.8, color: 0xa6b0c8, op: 0.12 },
        ];
    let seed = 1; // global stream cursor so shells don't share point positions
    for (const s of shells) {
      const pos = new Float32Array(s.count * 3);
      for (let i = 0; i < s.count; i++) {
        const theta = GraphScene.starRand(seed++) * Math.PI * 2;
        const phi = Math.acos(2 * GraphScene.starRand(seed++) - 1);
        const r = s.r0 + GraphScene.starRand(seed++) * (s.r1 - s.r0);
        const sp = Math.sin(phi);
        pos[i * 3] = Math.cos(theta) * r * sp;
        pos[i * 3 + 1] = Math.sin(theta) * r * sp;
        pos[i * 3 + 2] = Math.cos(phi) * r;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      const m = new THREE.PointsMaterial({
        color: s.color,
        size: s.size,
        sizeAttenuation: false,
        transparent: true,
        opacity: s.op,
        depthWrite: false,
        fog: false,
      });
      const pts = new THREE.Points(g, m);
      pts.frustumCulled = false;
      group.add(pts);
    }
    return group;
  }

  // Recompute per-node position/color/size/alpha from the graph + style state.
  // Cheap at this node count, so it runs every sim tick and on every style
  // change — keeping hidden(timelapse) + hover dim + ingest tint consistent.
  private writeNodes(): void {
    const pos = this.nodeGeom.getAttribute("position") as THREE.BufferAttribute;
    const col = this.nodeGeom.getAttribute("a_color") as THREE.BufferAttribute;
    const siz = this.nodeGeom.getAttribute("a_size") as THREE.BufferAttribute;
    const alp = this.nodeGeom.getAttribute("a_alpha") as THREE.BufferAttribute;
    const intn = this.nodeGeom.getAttribute("a_intensity") as THREE.BufferAttribute;
    const { hoveredNode, neighbors, tints, pulseId, pulseScale } = this.style;
    const c = new THREE.Color();

    for (let i = 0; i < this.nodeIds.length; i++) {
      const id = this.nodeIds[i];
      const a = this.graph.getNodeAttributes(id);
      pos.setXYZ(i, a.x, a.y, a.z);

      // base colour from community palette
      c.set(a.color);
      let size = a.size;
      // baseAlpha carries the confidence encoding (low-confidence stars dimmer).
      let alpha = a.hidden ? 0 : (a.baseAlpha ?? 1);
      let inten = a.intensity;

      // live-ingest tint overrides colour
      const written = tints.get(id);
      if (written !== undefined) {
        c.copy(written ? INGEST_WRITE : INGEST_READ);
        if (pulseId === id) size = a.size * pulseScale;
      }

      // hover neighbourhood: hovered + neighbours pop (full alpha + bloom); the
      // rest stay VISIBLE for context (own colour, just faded + no bloom) instead
      // of vanishing — so the cosmos and the camera orbit stay legible.
      if (hoveredNode && neighbors) {
        if (id === hoveredNode || neighbors.has(id)) {
          // keep full colour / alpha / intensity
        } else {
          alpha = a.hidden ? 0 : 0.5;
          inten = 0; // non-neighbours must not bloom
        }
      }


      col.setXYZ(i, c.r, c.g, c.b);
      siz.setX(i, size);
      alp.setX(i, alpha);
      intn.setX(i, a.hidden ? 0 : inten); // hidden cores must not bloom
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    siz.needsUpdate = true;
    alp.needsUpdate = true;
    intn.needsUpdate = true;
  }

  private writeEdges(): void {
    const pos = this.edgeGeom.getAttribute("position") as THREE.BufferAttribute;
    const col = this.edgeGeom.getAttribute("color") as THREE.BufferAttribute;
    const { hoveredNode, neighbors } = this.style;
    const cs = new THREE.Color(); // reused per edge (no per-edge allocation)
    const ct = new THREE.Color();
    for (let i = 0; i < this.edgePairs.length; i++) {
      const [s, t] = this.edgePairs[i];
      const sa = this.graph.getNodeAttributes(s);
      const ta = this.graph.getNodeAttributes(t);
      pos.setXYZ(i * 2, sa.x, sa.y, sa.z);
      pos.setXYZ(i * 2 + 1, ta.x, ta.y, ta.z);
      // Each end takes its node's community colour → the cluster's edges glow its
      // hue and inter-cluster edges gradient between the two ends (the neural
      // mesh look). A brightness factor handles hover focus + timelapse hide.
      cs.set(sa.color);
      ct.set(ta.color);
      let f = EDGE_BASE;
      if (hoveredNode) {
        const incident =
          s === hoveredNode ||
          t === hoveredNode ||
          !!(neighbors && neighbors.has(s) && neighbors.has(t));
        f = incident ? EDGE_HI : EDGE_DIM;
      }
      if (sa.hidden || ta.hidden) f = 0; // timelapse-hidden ⇒ vanish
      col.setXYZ(i * 2, cs.r * f, cs.g * f, cs.b * f);
      col.setXYZ(i * 2 + 1, ct.r * f, ct.g * f, ct.b * f);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    // Filaments mirror the thin-edge brightness (hover/timelapse), so refresh
    // them whenever the edge style is rewritten.
    if (this.filaments) this.updateFilaments();
  }

  // Orient one cone per edge at the target end, pointing source→target. Scaled
  // by linkThickness so that slider also controls arrow size. Hidden endpoints
  // (timelapse) collapse the instance to zero scale.
  private writeArrows(): void {
    const lt = this.settings.linkThickness;
    const up = new THREE.Vector3(0, 1, 0);
    const sPos = new THREE.Vector3();
    const tPos = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const m = new THREE.Matrix4();
    const ZERO = new THREE.Vector3(0, 0, 0);
    for (let i = 0; i < this.edgePairs.length; i++) {
      const [s, t] = this.edgePairs[i];
      const a = this.graph.getNodeAttributes(s);
      const b = this.graph.getNodeAttributes(t);
      tPos.set(b.x, b.y, b.z);
      if (a.hidden || b.hidden) {
        m.compose(tPos, q.identity(), ZERO);
        this.arrows.setMatrixAt(i, m);
        continue;
      }
      sPos.set(a.x, a.y, a.z);
      dir.subVectors(tPos, sPos);
      const len = dir.length();
      if (len < 1e-3) {
        m.compose(tPos, q.identity(), ZERO);
        this.arrows.setMatrixAt(i, m);
        continue;
      }
      dir.divideScalar(len);
      q.setFromUnitVectors(up, dir);
      // Sit the cone just outside the target star, pointing into it.
      const back = b.size * NODE_RADIUS + 3.5 * lt;
      pos.copy(tPos).addScaledVector(dir, -back);
      scl.set(lt, lt, lt);
      m.compose(pos, q, scl);
      this.arrows.setMatrixAt(i, m);
    }
    this.arrows.instanceMatrix.needsUpdate = true;
  }

  private updateLabels(): void {
    const h = Math.max(1, this.container.clientHeight);
    const scale = this.sizeScale(h);
    const threshold = Math.max(1, 5 + (this.settings.textFadeThreshold - 1.1) * 6);
    const { hoveredNode } = this.style;

    // Only the labelable hubs (≤TOP_N) and the single hovered node can ever show
    // a label, so build that tiny candidate set and visit ONLY it — visiting all
    // 10k nodes every frame just to leave 9988 of them invisible is pure waste
    // (and every obj.position.set dirties a matrix three.js then re-walks).
    // Semantic zoom: the closer the camera is than the framed distance, the more
    // top-degree labels become candidates (bounded by LABEL_MAX). The size-gate
    // below still hides any candidate too small on screen, so this only ever
    // *adds* labels as you push in — and visits at most LABEL_MAX+1 nodes.
    const camDist = this.camera.position.distanceTo(this.controls.target);
    const ratio = this.framedDist > 0 ? camDist / this.framedDist : 1;
    const grown = Math.round(LABEL_MIN * Math.pow(1 / Math.max(0.15, ratio), 1.3));
    const budget = Math.max(LABEL_MIN, Math.min(LABEL_MAX, grown));
    const candidates = this.labelCandidates;
    candidates.clear();
    for (let i = 0; i < budget && i < this.labelRank.length; i++) {
      candidates.add(this.labelRank[i]);
    }
    if (hoveredNode) candidates.add(hoveredNode);

    // Hide any label shown last frame that is no longer a candidate.
    for (const id of this.shownLabels) {
      if (!candidates.has(id)) {
        const obj = this.labels.get(id);
        if (obj) obj.visible = false;
      }
    }
    this.shownLabels.clear();

    for (const id of candidates) {
      const obj = this.labels.get(id);
      if (!obj) continue;
      const a = this.graph.getNodeAttributes(id);
      obj.position.set(a.x, a.y, a.z);
      let vis: boolean;
      if (a.hidden) {
        vis = false;
      } else if (hoveredNode) {
        // On hover only the hovered node's label shows (sigma parity).
        vis = id === hoveredNode;
      } else {
        // Size gate so distant hubs stay quiet until you orbit toward them.
        this.tmpVec.set(a.x, a.y, a.z);
        const dist = Math.max(1, this.camera.position.distanceTo(this.tmpVec));
        const renderedPx = (a.size * NODE_RADIUS * scale) / dist;
        vis = renderedPx > threshold;
      }
      obj.visible = vis;
      if (vis) this.shownLabels.add(id);
    }
  }

  // ---- public API ----

  // Resolve [srcIdx, tgtIdx] per edge from the current idIndex. Cheap; run once
  // on build/rebuild so the per-tick path can copy endpoint positions by index.
  private buildEdgeIndex(): void {
    const idx = new Int32Array(this.edgePairs.length * 2);
    for (let e = 0; e < this.edgePairs.length; e++) {
      const [s, t] = this.edgePairs[e];
      idx[e * 2] = this.idIndex.get(s) ?? 0;
      idx[e * 2 + 1] = this.idIndex.get(t) ?? 0;
    }
    this.edgeEndIdx = idx;
  }

  // Combined endpoint degree of an edge — the ranking key when capping the
  // filament set to FILAMENT_MAX (keep the strands between the busiest nodes).
  private edgeDeg(e: number): number {
    const [s, t] = this.edgePairs[e];
    return (
      this.graph.getNodeAttribute(s, "deg") +
      this.graph.getNodeAttribute(t, "deg")
    );
  }

  // Build the fat-line filament overlay over hub-incident edges. Membership is
  // static per build (recomputed in rebuild()); positions/colours are refreshed
  // by updateFilaments() on every tick + style change. Capped by combined
  // endpoint degree so a super-hub can't push the fat-line count past budget.
  private buildFilaments(): void {
    const idx: number[] = [];
    for (let e = 0; e < this.edgePairs.length; e++) {
      const [s, t] = this.edgePairs[e];
      if (
        this.graph.getNodeAttribute(s, "isHub") ||
        this.graph.getNodeAttribute(t, "isHub")
      ) {
        idx.push(e);
      }
    }
    if (idx.length > FILAMENT_MAX) {
      idx.sort((a, b) => this.edgeDeg(b) - this.edgeDeg(a));
      idx.length = FILAMENT_MAX;
    }
    this.filamentEdges = idx;
    if (idx.length === 0) return; // no hubs (edgeless / tiny vault) → no overlay

    this.filamentGeom = new LineSegmentsGeometry();
    this.filamentGeom.setPositions(new Float32Array(idx.length * 6));
    this.filamentGeom.setColors(new Float32Array(idx.length * 6));
    this.filamentMat = new LineMaterial({
      vertexColors: true,
      transparent: true,
      linewidth: FILAMENT_WIDTH, // screen px (worldUnits defaults to false)
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.filamentMat.resolution.set(w, h);
    this.filaments = new LineSegments2(this.filamentGeom, this.filamentMat);
    this.filaments.frustumCulled = false;
    this.filaments.renderOrder = 1; // over the thin edge mesh, under the pulses
    this.scene.add(this.filaments);
    this.updateFilaments();
  }

  // Refresh filament endpoint positions + per-end colours from the live graph.
  // Mirrors writeEdges() brightness logic (hover focus + timelapse hide) but on
  // the bounded hub-incident subset, so it is cheap to run every tick.
  private updateFilaments(): void {
    if (!this.filaments || !this.filamentGeom) return;
    const n = this.filamentEdges.length;
    const pos = new Float32Array(n * 6);
    const col = new Float32Array(n * 6);
    const { hoveredNode, neighbors } = this.style;
    const cs = new THREE.Color();
    const ct = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const [s, t] = this.edgePairs[this.filamentEdges[i]];
      const sa = this.graph.getNodeAttributes(s);
      const ta = this.graph.getNodeAttributes(t);
      const o = i * 6;
      pos[o] = sa.x;
      pos[o + 1] = sa.y;
      pos[o + 2] = sa.z;
      pos[o + 3] = ta.x;
      pos[o + 4] = ta.y;
      pos[o + 5] = ta.z;
      let f = FILAMENT_BASE;
      if (hoveredNode) {
        const incident =
          s === hoveredNode ||
          t === hoveredNode ||
          !!(neighbors && neighbors.has(s) && neighbors.has(t));
        f = incident ? FILAMENT_HI : FILAMENT_DIM;
      }
      if (sa.hidden || ta.hidden) f = 0; // timelapse-hidden ⇒ vanish
      cs.set(sa.color);
      ct.set(ta.color);
      col[o] = cs.r * f;
      col[o + 1] = cs.g * f;
      col[o + 2] = cs.b * f;
      col[o + 3] = ct.r * f;
      col[o + 4] = ct.g * f;
      col[o + 5] = ct.b * f;
    }
    this.filamentGeom.setPositions(pos);
    this.filamentGeom.setColors(col);
  }

  // Per-tick HOT path: update ONLY positions (node + edge endpoints). Colours,
  // sizes, alpha and intensity never change while the sim merely moves nodes, so
  // rewriting them every tick (with a hex-colour parse per node AND per edge end)
  // was the dominant 10k-node settle cost. Edge endpoints are copied straight out
  // of the node position buffer by integer index — zero graphology access.
  private writePositions(): void {
    const npos = this.nodeGeom.getAttribute("position") as THREE.BufferAttribute;
    const nArr = npos.array as Float32Array;
    for (let i = 0; i < this.nodeIds.length; i++) {
      const a = this.graph.getNodeAttributes(this.nodeIds[i]);
      const o = i * 3;
      nArr[o] = a.x;
      nArr[o + 1] = a.y;
      nArr[o + 2] = a.z;
    }
    npos.needsUpdate = true;

    const epos = this.edgeGeom.getAttribute("position") as THREE.BufferAttribute;
    const eArr = epos.array as Float32Array;
    const idx = this.edgeEndIdx;
    for (let e = 0; e < this.edgePairs.length; e++) {
      const s = idx[e * 2] * 3;
      const t = idx[e * 2 + 1] * 3;
      const o = e * 6;
      eArr[o] = nArr[s];
      eArr[o + 1] = nArr[s + 1];
      eArr[o + 2] = nArr[s + 2];
      eArr[o + 3] = nArr[t];
      eArr[o + 4] = nArr[t + 1];
      eArr[o + 5] = nArr[t + 2];
    }
    epos.needsUpdate = true;
  }

  syncPositions(): void {
    this.writePositions();
    if (this.filaments) this.updateFilaments();
    if (this.arrows.visible) this.writeArrows();
    // Galaxies drift while the sim runs; refresh the gas every 12th tick (the
    // centroid recompute is O(nodes) but visually stable, so per-frame is waste).
    if ((this.nebulaTick = (this.nebulaTick + 1) % 12) === 0) this.nebula.update();
  }

  // Off-thread sim path: apply a position array posted by the sim worker (node
  // order == nodeIds order). Bulk-copies into the node buffer, mirrors the
  // positions back into graphology (hover/fit/nebula/arrows read attributes, so
  // they must stay current), then derives edge endpoints + extras. Replaces the
  // old "write graphology in onTick, read it back in writePositions" round-trip.
  applyPositions(pos: Float32Array): void {
    const npos = this.nodeGeom.getAttribute("position") as THREE.BufferAttribute;
    const nArr = npos.array as Float32Array;
    nArr.set(pos.length <= nArr.length ? pos : pos.subarray(0, nArr.length));
    npos.needsUpdate = true;

    const ids = this.nodeIds;
    for (let i = 0; i < ids.length; i++) {
      const a = this.graph.getNodeAttributes(ids[i]);
      const o = i * 3;
      a.x = pos[o];
      a.y = pos[o + 1];
      a.z = pos[o + 2];
    }

    const epos = this.edgeGeom.getAttribute("position") as THREE.BufferAttribute;
    const eArr = epos.array as Float32Array;
    const idx = this.edgeEndIdx;
    for (let e = 0; e < this.edgePairs.length; e++) {
      const sOff = idx[e * 2] * 3;
      const tOff = idx[e * 2 + 1] * 3;
      const o = e * 6;
      eArr[o] = nArr[sOff];
      eArr[o + 1] = nArr[sOff + 1];
      eArr[o + 2] = nArr[sOff + 2];
      eArr[o + 3] = nArr[tOff];
      eArr[o + 4] = nArr[tOff + 1];
      eArr[o + 5] = nArr[tOff + 2];
    }
    epos.needsUpdate = true;

    if (this.filaments) this.updateFilaments();
    if (this.arrows.visible) this.writeArrows();
    if ((this.nebulaTick = (this.nebulaTick + 1) % 12) === 0) this.nebula.update();
  }

  // Full attribute refresh (colour/size/alpha/intensity + edge colour). Call when
  // those actually change but no React style push happens — e.g. timelapse
  // reveal/hide toggling node `hidden`. The per-tick path never touches them.
  refreshStyle(): void {
    this.writeNodes();
    this.writeEdges();
  }

  setStyleState(s: SceneStyleState): void {
    this.style = s;
    this.writeNodes();
    this.writeEdges();
  }

  // Re-snapshot the (same, mutated) graph after live-ingest growth added nodes/
  // edges. Recreates the fixed-size buffers and label set; reuses the shared
  // materials/scene/camera so the camera framing and orbit are preserved.
  rebuild(): void {
    this.nodeIds = this.graph.nodes();
    this.idIndex = new Map(this.nodeIds.map((id, i) => [id, i]));
    const n = this.nodeIds.length;

    const oldNodeGeom = this.nodeGeom;
    this.nodeGeom = new THREE.BufferGeometry();
    this.nodeGeom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this.nodeGeom.setAttribute("a_color", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this.nodeGeom.setAttribute("a_size", new THREE.BufferAttribute(new Float32Array(n), 1));
    this.nodeGeom.setAttribute("a_alpha", new THREE.BufferAttribute(new Float32Array(n), 1));
    this.nodeGeom.setAttribute("a_intensity", new THREE.BufferAttribute(new Float32Array(n), 1));
    this.points.geometry = this.nodeGeom;
    oldNodeGeom.dispose();

    this.edgePairs = this.graph.mapEdges(
      (_e, _a, s, t) => [s, t] as [string, string],
    );
    this.buildEdgeIndex();
    const oldEdgeGeom = this.edgeGeom;
    this.edgeGeom = new THREE.BufferGeometry();
    this.edgeGeom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.edgePairs.length * 6), 3));
    this.edgeGeom.setAttribute("color", new THREE.BufferAttribute(new Float32Array(this.edgePairs.length * 6), 3));
    this.edges.geometry = this.edgeGeom;
    oldEdgeGeom.dispose();

    // Filaments: hub membership can change after live-ingest growth — drop the
    // old overlay and rebuild it over the new edge set.
    if (this.filaments) {
      this.scene.remove(this.filaments);
      this.filamentGeom?.dispose();
      this.filamentMat?.dispose();
      this.filaments = null;
      this.filamentGeom = null;
      this.filamentMat = null;
    }
    if (SHOW_FILAMENTS) this.buildFilaments();

    // Arrows: instance count is fixed at allocation, so rebuild for the new
    // edge count (reusing the shared cone geometry + material).
    const oldArrows = this.arrows;
    this.scene.remove(oldArrows);
    oldArrows.dispose();
    this.arrows = new THREE.InstancedMesh(
      this.arrowGeom,
      this.arrowMat,
      Math.max(1, this.edgePairs.length),
    );
    this.arrows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.arrows.frustumCulled = false;
    this.arrows.visible = this.settings.arrows;
    this.scene.add(this.arrows);

    // Labels: add any missing, drop any gone.
    const live = new Set(this.nodeIds);
    for (const [id, obj] of this.labels) {
      if (!live.has(id)) {
        obj.element.remove();
        this.scene.remove(obj);
        this.labels.delete(id);
      }
    }
    for (const id of this.nodeIds) {
      if (this.labels.has(id)) continue;
      const el = document.createElement("div");
      el.className = "graph-label-3d";
      el.textContent = this.graph.getNodeAttribute(id, "label");
      el.style.color = this.theme.ink;
      const obj = new CSS2DObject(el);
      obj.visible = false;
      this.scene.add(obj);
      this.labels.set(id, obj);
    }

    // Nebula: re-snapshot the (changed) node id set so new galaxies get gas.
    this.nebula.setNodeIds(this.nodeIds);
    // Pulses: re-snapshot the (changed) edge set so signals ride new links.
    this.pulse.setEdges(this.edgePairs);
    // Re-derive the label allow-set so live-ingest newcomers / new hubs can label.
    this.computeLabelable();

    this.writeNodes();
    this.writeEdges();
    this.writeArrows();
  }

  applyTheme(theme: GraphTheme): void {
    this.theme = theme;
    const bg = parseRGBA(theme.bg).color;
    const dark = bg.getHSL({ h: 0, s: 0, l: 0 }).l < 0.5;
    const sceneBg = dark ? new THREE.Color(0x05060d) : bg;
    this.scene.background = sceneBg;
    (this.scene.fog as THREE.FogExp2).color.copy(sceneBg);
    // Must mirror the constructor's calm calibration (duplicated constants —
    // keep in sync; Phase 1 extracts a single helper).
    this.baseBloom = dark ? 0.45 : 0.25;
    this.bloom.strength = this.baseBloom; // brightness drives exposure, not bloom
    this.bloom.threshold = dark ? 1.9 : 0.7;
    this.bloom.radius = 0.7;
    this.nodeMat.blending = dark ? THREE.AdditiveBlending : THREE.NormalBlending;
    this.nodeMat.needsUpdate = true;
    this.edgeMat.blending = dark ? THREE.AdditiveBlending : THREE.NormalBlending;
    this.edgeMat.needsUpdate = true;
    this.pulse.setDark(dark);
    this.nebula.setDark(dark && SHOW_NEBULA);
    this.edgeMat.opacity = Math.min(1, EDGE_OPACITY * this.settings.linkThickness);
    this.arrowMat.color.copy(parseRGBA(theme.edgeHi).color);
    for (const obj of this.labels.values()) {
      (obj.element as HTMLElement).style.color = theme.ink;
    }
    this.writeNodes();
    this.writeEdges();
    if (this.arrows.visible) this.writeArrows();
  }

  applySettings(settings: GraphSettings): void {
    this.settings = settings;
    this.edgeMat.opacity = Math.min(1, EDGE_OPACITY * settings.linkThickness);
    // Brightness: overall exposure + bloom glow intensity.
    // Brightness drives overall EXPOSURE only (applied by OutputPass at the end).
    // Bloom strength stays fixed so raising brightness lifts the whole image
    // without ballooning the core glow back into a white wash.
    this.renderer.toneMappingExposure = settings.brightness;
    this.bloom.strength = this.baseBloom;
    // Direction arrows: toggle visibility; re-place (also picks up linkThickness).
    this.arrows.visible = settings.arrows;
    if (settings.arrows) this.writeArrows();
  }

  zoomIn(): void {
    this.dollyBy(0.8);
  }
  zoomOut(): void {
    this.dollyBy(1.25);
  }
  private dollyBy(factor: number): void {
    const dir = this.tmpVec
      .copy(this.camera.position)
      .sub(this.controls.target);
    const len = THREE.MathUtils.clamp(
      dir.length() * factor,
      this.controls.minDistance,
      this.controls.maxDistance,
    );
    dir.setLength(len);
    this.camera.position.copy(this.controls.target).add(dir);
    this.controls.update();
  }

  fit(): void {
    // Bounding sphere of the (visible) nodes → frame the cluster.
    let cx = 0;
    let cy = 0;
    let cz = 0;
    let count = 0;
    for (const id of this.nodeIds) {
      const a = this.graph.getNodeAttributes(id);
      if (a.hidden) continue;
      cx += a.x;
      cy += a.y;
      cz += a.z;
      count++;
    }
    if (count === 0) return;
    cx /= count;
    cy /= count;
    cz /= count;
    let r = 1;
    for (const id of this.nodeIds) {
      const a = this.graph.getNodeAttributes(id);
      if (a.hidden) continue;
      r = Math.max(r, Math.hypot(a.x - cx, a.y - cy, a.z - cz));
    }
    this.controls.target.set(cx, cy, cz);
    const fovRad = (this.camera.fov * Math.PI) / 180;
    const dist = (r * 1.5) / Math.tan(fovRad / 2) + 60;
    this.framedDist = dist; // zoom reference for semantic-zoom label budget
    const dir = this.tmpVec
      .copy(this.camera.position)
      .sub(this.controls.target);
    if (dir.lengthSq() < 1) dir.set(0.3, 0.15, 1);
    dir.setLength(THREE.MathUtils.clamp(dist, this.controls.minDistance, this.controls.maxDistance));
    this.camera.position.copy(this.controls.target).add(dir);
    this.controls.update();
  }

  // Frame the camera on a single node — used by the inspector / search-to-focus
  // to fly to a star. Like fit() but centred on one node at a close distance.
  focusNode(id: string): void {
    if (!this.graph.hasNode(id)) return;
    const a = this.graph.getNodeAttributes(id);
    this.controls.target.set(a.x, a.y, a.z);
    const fovRad = (this.camera.fov * Math.PI) / 180;
    const r = Math.max(a.size * NODE_RADIUS * 4, 60);
    const dist = (r * 1.5) / Math.tan(fovRad / 2) + 40;
    const dir = this.tmpVec.copy(this.camera.position).sub(this.controls.target);
    if (dir.lengthSq() < 1) dir.set(0.3, 0.15, 1);
    dir.setLength(
      THREE.MathUtils.clamp(dist, this.controls.minDistance, this.controls.maxDistance),
    );
    this.camera.position.copy(this.controls.target).add(dir);
    this.controls.update();
  }

  start(): void {
    if (this.raf != null) return;
    this.lastFrame = performance.now();
    const loop = (): void => {
      const now = performance.now();
      const dt = Math.min(0.1, (now - this.lastFrame) / 1000); // clamp tab-refocus jumps
      this.lastFrame = now;
      this.controls.update();
      // One coalesced hover pick per frame (not one per pointermove event).
      this.processPick();
      // Life: signals flow along edges + stars breathe. Frozen for reduced-motion.
      if (!this.reducedMotion) {
        this.pulse.update(dt);
        this.nodeMat.uniforms.u_time.value += dt;
      }
      this.updateLabels();
      this.composer.render();
      this.labelRenderer.render(this.scene, this.camera);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  dispose(): void {
    if (this.raf != null) cancelAnimationFrame(this.raf);
    this.raf = null;
    this.resizeObs.disconnect();
    const el = this.renderer.domElement;
    el.removeEventListener("pointermove", this.onPointerMove);
    el.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("pointerup", this.onPointerUp);
    el.removeEventListener("webglcontextlost", this.onCtxLost);
    el.removeEventListener("webglcontextrestored", this.onCtxRestored);
    this.controls.dispose();
    for (const obj of this.labels.values()) {
      obj.element.remove();
      this.scene.remove(obj);
    }
    this.labels.clear();
    this.nodeGeom.dispose();
    this.nodeMat.dispose();
    this.edgeGeom.dispose();
    this.edgeMat.dispose();
    if (this.filaments) this.scene.remove(this.filaments);
    this.filamentGeom?.dispose();
    this.filamentMat?.dispose();
    this.arrows.dispose();
    this.arrowGeom.dispose();
    this.arrowMat.dispose();
    // Starfield is now a Group of shells — dispose each.
    for (const child of this.starfield.children) {
      const p = child as THREE.Points;
      (p.geometry as THREE.BufferGeometry).dispose();
      (p.material as THREE.Material).dispose();
    }
    this.nebula.dispose();
    this.scene.remove(this.nebula.group);
    this.pulse.dispose();
    this.scene.remove(this.pulse.points);
    this.bloom.dispose();
    this.composer.renderTarget1.dispose();
    this.composer.renderTarget2.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    el.remove();
    this.labelRenderer.domElement.remove();
  }

  // ---- interaction ----

  private onResize = (): void => {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
    this.labelRenderer.setSize(w, h);
    this.nodeMat.uniforms.u_sizeScale.value = this.sizeScale(h);
    // Fat lines are screen-space — they need the drawing-buffer resolution.
    this.filamentMat?.resolution.set(w, h);
  };

  private pickNode(clientX: number, clientY: number): string | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const scale = this.sizeScale(Math.max(1, rect.height));
    let best: string | null = null;
    let bestD = Infinity;
    for (const id of this.nodeIds) {
      const a = this.graph.getNodeAttributes(id);
      if (a.hidden) continue;
      this.tmpVec.set(a.x, a.y, a.z).project(this.camera);
      if (this.tmpVec.z > 1) continue; // behind camera / clipped
      const sx = (this.tmpVec.x * 0.5 + 0.5) * rect.width;
      const sy = (-this.tmpVec.y * 0.5 + 0.5) * rect.height;
      const d = Math.hypot(sx - px, sy - py);
      const dist = Math.max(
        1,
        this.camera.position.distanceTo(this.tmpVec.set(a.x, a.y, a.z)),
      );
      const renderedPx = (a.size * NODE_RADIUS * scale) / dist;
      const hitR = Math.max(PICK_BASE_PX, renderedPx);
      if (d < hitR && d < bestD) {
        bestD = d;
        best = id;
      }
    }
    return best;
  }

  private dragWorld(clientX: number, clientY: number, anchor: THREE.Vector3): THREE.Vector3 {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.tmpNdc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.tmpNdc, this.camera);
    const normal = this.camera.getWorldDirection(new THREE.Vector3());
    this.dragPlane.setFromNormalAndCoplanarPoint(normal, anchor);
    const out = new THREE.Vector3();
    this.raycaster.ray.intersectPlane(this.dragPlane, out);
    return out.lengthSq() > 0 ? out : anchor.clone();
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (this.dragId) {
      this.dragMoved = true;
      const a = this.graph.getNodeAttributes(this.dragId);
      const p = this.dragWorld(e.clientX, e.clientY, this.tmpVec.set(a.x, a.y, a.z).clone());
      this.cb.onDrag(this.dragId, p.x, p.y, p.z);
      return;
    }
    // Pointer held down but not dragging a star → the user is orbiting the
    // camera. Don't run hover picking (it would dim the scene mid-rotate).
    if (this.downAt) {
      this.renderer.domElement.style.cursor = "grabbing";
      return;
    }
    // Defer the (O(n)) pick to the next frame; only the latest position matters.
    this.pendingPick = { x: e.clientX, y: e.clientY };
  };

  // Run at most one hover pick per render frame (called from the loop).
  private processPick(): void {
    if (!this.pendingPick) return;
    const { x, y } = this.pendingPick;
    this.pendingPick = null;
    const id = this.pickNode(x, y);
    this.renderer.domElement.style.cursor = id ? "pointer" : "grab";
    if (id !== this.hoverId) {
      this.hoverId = id;
      this.cb.onNodeHover(id);
    }
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    this.downAt = { x: e.clientX, y: e.clientY };
    const id = this.pickNode(e.clientX, e.clientY);
    if (id) {
      this.dragId = id;
      this.dragMoved = false;
      this.controls.enabled = false; // don't orbit while dragging a star
      this.cb.onDragStart(id);
    } else if (this.hoverId) {
      // starting a camera orbit on empty space — drop the hover highlight so the
      // scene isn't stuck dimmed while the user rotates.
      this.hoverId = null;
      this.cb.onNodeHover(null);
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    const id = this.dragId;
    if (id) {
      this.controls.enabled = true;
      const moved =
        this.dragMoved &&
        this.downAt != null &&
        Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y) > 3;
      this.cb.onDragEnd(id);
      if (!moved) this.cb.onNodeClick(id);
      this.dragId = null;
      this.dragMoved = false;
    }
    this.downAt = null;
  };

  private onCtxLost = (e: Event): void => {
    e.preventDefault();
  };
  private onCtxRestored = (): void => {
    this.cb.onContextRestored();
  };
}
