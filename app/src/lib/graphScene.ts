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
import { ShipController } from "./shipController";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { FXAAShader } from "three/examples/jsm/shaders/FXAAShader.js";
import {
  CSS2DRenderer,
  CSS2DObject,
} from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { seededUnit, type VaultGraph } from "./graphData";
import type { GraphTheme } from "./graphTheme";
import { skinAmbience } from "./graphSkins";
import { galaxyNormal } from "./galaxyLayout";
import type { GraphSettings } from "./graphSettings";
import { NebulaLayer } from "./nebulaLayer";
import { PulseLayer } from "./pulseLayer";
import { TracePulse } from "./tracePulse";
import { DustLayer } from "./dustLayer";
import { EdgeDensityLayer } from "./edgeDensity";
import { ClusterLabels } from "./clusterLabels";
import { WaveLayer } from "./waveLayer";
import { SupernovaFx } from "./supernovaFx";
import { planWave } from "./activationWave";
import { MeteorLayer } from "./meteorLayer";
import { CoreGlowLayer } from "./coreGlowLayer";
import { CosmicEvents, type EventKind } from "./cosmicEvents";
import { GalacticBandLayer } from "./galacticBandLayer";
import { GalaxyImposterLayer } from "./galaxyImposterLayer";
import { PlanetLayer } from "./planetLayer";
import { CommunityHullLayer } from "./communityHullLayer";
import { EdgeBundleLayer } from "./edgeBundleLayer";
import type { LayoutMetrics } from "./layoutMetrics";
import {
  cosmicScale,
  imposterAlpha,
  nodeLodAlpha,
  zoomFromScreenSize,
  zoomLevel,
  type CosmicScale,
} from "./cosmicLod";
import {
  pickByDegree,
  synapseDelay,
  SYNAPSE_INTENSITY,
  SYNAPSE_MAX_DEPTH,
  SYNAPSE_MAX_EDGES,
  SYNAPSE_MAX_NODES,
} from "./synapseFire";

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
// Edge material opacity and per-end brightness — theme-branched. Light theme
// paints edges over near-white paper with NormalBlending, so the mesh needs a
// darker neutral, higher opacity, and higher per-end brightness to read as
// connective tissue instead of vanishing.
const EDGE_OPACITY_DARK = 0.2;
// Light bg uses NormalBlending (not additive), so thousands of overlapping
// star-spoke edges STACK into an opaque grey wash that buries the nodes. Keep
// the per-edge alpha low so a dense hub-and-spoke vault stays readable on paper.
const EDGE_OPACITY_LIGHT = 0.16;
const EDGE_BASE_DARK = 0.22; // per-end brightness (edges are tissue, not light)
const EDGE_BASE_LIGHT = 0.4;
const EDGE_HI = 1.15; // incident edges on hover (pop)
const EDGE_DIM = 0.05; // non-incident edges on hover (fade, not vanish)
// Hover micro-pop: the hovered star eases to ×HOVER_POP_SCALE over
// HOVER_POP_MS and back on leave. Deliberately parallel to the ingest pulse
// (style.pulseId/pulseScale) — hijacking those would fight a live ingest glow.
const HOVER_POP_SCALE = 1.3;
const HOVER_POP_MS = 150;
// Structure is grey; signal is nodes (calm-cosmic-web spec A2): default edges
// are pulled halfway toward a neutral so the mesh reads as connective tissue
// and the community hues live in the stars. Dark theme: cool mid-grey. Light
// theme: dark slate so the neutral half doesn't disappear into #fafaf9.
const EDGE_NEUTRAL_DARK = new THREE.Color("#8b93a8");
const EDGE_NEUTRAL_LIGHT = new THREE.Color("#2c3446");
const EDGE_GREY_MIX = 0.5;
// Cosmic-web skin: the edges ARE the picture (dark-matter-simulation look).
// Tiny stars, and thin violet filaments whose brightness comes from OVERLAP —
// each line is faint, additive blending sums where strands cross, so density
// paints itself. Nodes shrink to points so the web reads as tissue, not bulbs.
const EDGE_NEUTRAL_WEB = new THREE.Color("#6f7ce0");
const EDGE_OPACITY_WEB = 0.16;
const EDGE_BASE_WEB = 0.6; // single strand faint but visible; crossings glow
// Sigma skin: the coloured Gephi veil — visible community-hue strands over the
// charcoal board, curving (sag boost) like the classic sigma.js hairball.
const EDGE_OPACITY_SIGMA = 0.34;
const EDGE_BASE_SIGMA = 0.85;
const EDGE_GREY_MIX_SIGMA = 0.08; // near-full community hue on the veil
const EDGE_SAG_BOOST_SIGMA = 2.6;
const EDGE_GREY_MIX_WEB = 0.85; // near-uniform filament tissue, faint hue hint
const WEB_NODE_SCALE = 0.34; // node size multiplier on the web skin
// Midpoint-split edge treatment (spec A2, Holten-style): each edge renders as
// TWO segments s→m, m→t so alpha can peak at the middle and fade at the ends —
// N spokes converging on a hub no longer sum to a bright disc at the core.
const EDGE_END_FADE = 0.45; // endpoint brightness × (mid stays ×1.0)
// The midpoint also sags ~5% of the edge length along a deterministic per-edge
// perpendicular, so spoke bundles read organic instead of ruler-straight.
const EDGE_SAG = 0.05;
// Length-based alpha falloff (cosmos.gl linkVisibilityDistanceRange port):
// short intra-cluster links render solid; long stretched links fade toward a
// floor so the void between lobes isn't crossed by bright ruler lines.
// Thresholds scale with the linkDistance setting (they're layout-relative).
const EDGE_LEN_FADE_START = 2.5; // × linkDistance — full brightness below this
const EDGE_LEN_FADE_END = 8; // × linkDistance — floor brightness above this
const EDGE_LEN_FADE_MIN = 0.25;

// Reference look is a clean neural mesh on a calm void. The faint parallax
// starfield gives the cosmic-web depth cosmic-refs.md asks for; the dim graded
// shells (buildStarfield) read as deep-field stars, not confetti. Flip to off
// for the bare-void look.
const SHOW_NEBULA = true;
const SHOW_STARFIELD = true;

// Fat filament overlay (LineSegments2). Phase 3 (spec A2) revival: NOT an
// always-on layer over every hub-incident edge — that was the "firework" look
// (whole clusters painted as bright additive spokes summing past the bloom
// threshold). Filaments now light ONLY the current focus subgraph: the hovered
// node's incident edges and a Cmd-click shortest path. They read as filaments
// precisely because they are rare and few — capped hard at FILAMENT_CAP.
const FILAMENT_CAP = 200; // max strands lit at once (a focus set is small)
const FILAMENT_WIDTH = 2.0; // screen px (LineMaterial, worldUnits=false)
const FILAMENT_BASE = 0.7; // per-end brightness of a lit strand
const FILAMENT_PATH = 1.0; // shortest-path strands pop brightest

export interface GraphSceneCallbacks {
  /** additive = Cmd/Ctrl held → shortest-path gesture (spec B3), not a plain click. */
  onNodeClick(id: string, additive: boolean): void;
  onNodeHover(id: string | null): void;
  onDragStart(id: string): void;
  onDrag(id: string, x: number, y: number, z: number): void;
  onDragEnd(id: string): void;
  /** Click on empty space (no node, no orbit drag) — focus-stack exit. */
  onVoidClick(): void;
  /** WebGL context died (WKWebView backgrounding etc.) — show the error state. */
  onContextLost(): void;
  onContextRestored(): void;
}

// Transient styling driven by PageGraph: hover neighbourhood + live-ingest tint.
export interface SceneStyleState {
  hoveredNode: string | null;
  neighbors: Set<string> | null;
  // Focus isolation (click 1-hop / 2-hop, legend community): members keep full
  // style, everything else sinks to a near-invisible context layer — deeper
  // than the hover dim, and it HOLDS until popped (spec B3).
  focus: Set<string> | null;
  // Ordered shortest-path node sequence (Cmd-click, spec B3). Its consecutive
  // pairs light as the brightest filament strands. Null when no path is active.
  pathNodes: string[] | null;
  tints: Map<string, boolean>; // id → written (true) vs only read (false)
  pulseId: string | null;
  pulseScale: number;
}

const EMPTY_STYLE: SceneStyleState = {
  hoveredNode: null,
  neighbors: null,
  focus: null,
  pathNodes: null,
  tints: new Map(),
  pulseId: null,
  pulseScale: 1,
};

// Focus-isolation context layer: non-members at 0.08 alpha (hover's soft dim is
// 0.15 — focus is a held state, so it cuts deeper), their edges near-invisible.
const FOCUS_NODE_DIM = 0.08;
const FOCUS_EDGE_DIM = 0.03;

// Idle time after the last orbit/zoom before auto-rotate resumes (spec A7).
const ROTATE_IDLE_MS = 8000;

// Interaction LOD (spec B6): during an orbit/drag the moving overlays (pulses,
// labels, arrows) are hidden so the frame is just the two static draw calls
// (nodes + edges); they ease back this many ms after the gesture ends. Thin
// edges stay up throughout — they cost one draw call and anchor the motion.
const LOD_RESTORE_MS = 150;

// Idle galaxy swirl (folder-galaxies mode): each galaxy slowly rotates about
// its own seeded disc axis, alternating direction per group — the "several
// living galaxies" motion. Rad/s; deliberately slower than the camera rotate.
const SWIRL_SPEED = 0.05;
// Orphan "moons": isolated notes orbit their nearest linked star, visibly
// faster than the galactic swirl, and ease onto a close orbit radius.
const MOON_SPEED = 0.35;
const MOON_RADIUS_MIN = 4; // × host node's world radius
const MOON_RADIUS_VAR = 4;

// Above this node count the scene builds in performance mode (spec B5):
// 1 starfield shell instead of 3, no nebula, no pulses — the ambient layers
// are the first spend to cut, the graph itself stays untouched. Decided at
// build time; live-ingest growth past the line applies on the next rebuild.
// It also drops selective bloom back to a single bloom pass (spec A1 perf gate).
const PERF_LOD_NODES = 5000;

// Selective bloom (spec A1): only the node layer blooms, so edges / pulses /
// filaments / starfield / labels are structurally bloom-proof — no additive
// edge sum can ever cross the threshold. Nodes render on BLOOM_LAYER (plus the
// default layer 0); the bloom composer renders layer 1 alone, the final
// composer renders everything and additively mixes the bloom texture back in.
const BLOOM_LAYER = 1;

// Effective monochrome amount (u_mono uniform) from the node-colour setting +
// the vault's node count: "white"/"black" → always 1, "community" → 0,
// "auto" → mono (1) until the vault grows past monoBelow nodes.
function monoFor(s: GraphSettings, nodeCount: number): number {
  if (s.nodeColor === "white" || s.nodeColor === "black") return 1;
  // Cosmic-web skin: mono is the look. Stars are pale points and the violet
  // filaments carry the picture — community confetti would fight the density
  // read that IS this skin, so the skin decides (like "white"/"black" above).
  if (s.skin === "web") return 1;
  if (s.nodeColor === "auto") return nodeCount < s.monoBelow ? 1 : 0;
  return 0;
}

// The mono ink (u_monoColor). "white" starlight is invisible on the white
// skin — "black" is the explicit dark ink, and "auto" picks whichever the
// current background can actually show.
const MONO_WHITE = new THREE.Color(0.9, 0.94, 1.0);
const MONO_BLACK = new THREE.Color(0.09, 0.1, 0.13);
function monoColorFor(s: GraphSettings, dark: boolean): THREE.Color {
  if (s.nodeColor === "black") return MONO_BLACK;
  if (s.nodeColor === "white") return MONO_WHITE;
  return dark ? MONO_WHITE : MONO_BLACK; // "auto" (and irrelevant for community)
}

// Cinematic finish (display-space, after OutputPass): a whisper of radial
// chromatic aberration, a soft vignette, and animated filmic grain that lives
// mostly in the shadows — the "shot on a camera" grade. Cheap: one fullscreen
// pass, three texture taps. u_time freezes with the ambience gate, so
// reduced-motion sees static grain.
const CINE_FRAG = /* glsl */ `
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform float u_time;
uniform float u_vig;
uniform float u_grain;
uniform float u_ca;
float hash12(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
void main() {
  vec2 uv = vUv;
  vec2 c = uv - 0.5;
  float r2 = dot(c, c);
  vec2 off = c * (u_ca * r2 * 4.0);
  vec3 col;
  col.r = texture2D(tDiffuse, uv + off).r;
  col.g = texture2D(tDiffuse, uv).g;
  col.b = texture2D(tDiffuse, uv - off).b;
  col *= 1.0 - u_vig * smoothstep(0.2, 0.72, r2);
  float g = hash12(uv * vec2(1917.0, 1013.0) + fract(u_time * 0.61) * 41.7) - 0.5;
  float shadow = 1.0 - smoothstep(0.0, 0.55, dot(col, vec3(0.3333)));
  col += g * u_grain * (0.35 + 0.65 * shadow);
  gl_FragColor = vec4(col, 1.0);
}
`;

// Additive composite of the base HDR render + the (nodes-only) bloom texture,
// run before the ACES OutputPass so tone-mapping still sees the summed HDR.
const MIX_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const MIX_FRAG = /* glsl */ `
uniform sampler2D baseTexture;
uniform sampler2D bloomTexture;
varying vec2 vUv;
void main() {
  gl_FragColor = texture2D(baseTexture, vUv) + texture2D(bloomTexture, vUv);
}
`;

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
attribute float a_kind; // stellar class: 0 main, 1 dwarf, 2 giant, 3 neutron
attribute float a_age; // days since last modified (9999 = unknown/old)
attribute float a_hit; // 1 = current search match (pulse-in-phase highlight)
attribute float a_spawn; // condensation intro: per-node birth delay (s)
uniform float u_spawnClock; // intro clock (s); <0 = intro off, all stars full
uniform float u_pixelRatio;
uniform float u_sizeScale;
uniform float u_fogNear;
uniform float u_fogFar;
uniform float u_time;
uniform float u_darkTheme; // 1 on dark background, 0 on light
varying vec3 v_color;
varying float v_alpha;
varying float v_fade;
varying float v_int;
varying float v_dark;
varying float v_kind;
varying float v_age;
varying float v_hit;
uniform float u_driftAmp; // curl micro-drift amplitude (world units; 0 = off)
void main() {
  // Curl micro-drift: once settled, every star orbits a frozen divergence-free
  // field (curl of A = (sin ky, sin kz, sin kx)/k is exactly -cos of the next
  // axis — zero divergence by construction, so stars circulate locally and
  // never migrate). Two octaves for an organic swirl. Rides u_time, which only
  // advances under the ambient-motion gate — reduced-motion sees a still sky.
  vec3 p = position;
  if (u_driftAmp > 0.0) {
    float t1 = u_time * 0.11;
    float t2 = u_time * 0.23;
    vec3 q1 = position * 0.012;
    vec3 q2 = position * 0.031;
    vec3 c1 = -vec3(cos(q1.z + t1), cos(q1.x + t1), cos(q1.y + t1));
    vec3 c2 = vec3(cos(q2.z + t2), cos(q2.x - t2), cos(q2.y + t2 * 0.7));
    p += u_driftAmp * (c1 + 0.5 * c2);
  }
  // Condensation intro: each star is born a little away from its place along a
  // deterministic direction and eases home on its own delay (staggered by
  // cluster) — a nebula condensing into stars. One-shot; u_spawnClock < 0
  // disables (reduced-motion, or the intro has already played this visit).
  float birth = u_spawnClock < 0.0
    ? 1.0
    : clamp((u_spawnClock - a_spawn) / 0.9, 0.0, 1.0);
  float birthE = 1.0 - pow(1.0 - birth, 3.0); // easeOutCubic
  if (birthE < 1.0) {
    vec3 dir = normalize(
      vec3(sin(position.x * 12.9898), cos(position.y * 78.233), sin(position.z * 37.719)) +
      vec3(1e-4));
    p += dir * (1.0 - birthE) * 90.0;
  }
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float dist = max(1.0, -mv.z);
  gl_PointSize = a_size * ${NODE_RADIUS.toFixed(1)} * ${GLOW_SCALE.toFixed(1)} * u_sizeScale * u_pixelRatio / dist;
  gl_PointSize *= (1.0 + a_intensity * 0.35); // hub cores a touch larger
  // Stellar class scales the sprite: giants swell, dwarfs/neutrons shrink.
  v_kind = floor(a_kind + 0.5);
  if (v_kind > 2.5) gl_PointSize *= 0.55;
  else if (v_kind > 1.5) gl_PointSize *= 1.5;
  else if (v_kind > 0.5) gl_PointSize *= 0.72;
  // Gentle breathing — slow and subtle (motion budget: idle motion must not
  // grab the eye). Neutron stars pulse fast and a little deeper (pulsar wink).
  float bAmp = v_kind > 2.5 ? 0.07 : 0.025;
  float bFreq = v_kind > 2.5 ? 3.4 : 0.6;
  gl_PointSize *= 1.0 + bAmp * sin(u_time * bFreq + position.x * 0.03 + position.y * 0.021);
  // Search hits pulse IN PHASE (motion is pre-attentive: the matched set pops
  // out together no matter how cluttered the sky). One shared phase, no
  // per-node offset — lockstep IS the signal here, unlike the ambient breathing.
  if (a_hit > 0.5) gl_PointSize *= 1.0 + 0.22 * sin(u_time * 4.0);
  // Light bg (NormalBlending, no additive self-brightening): bump sprite size so
  // the dark stars have enough AREA to read on paper. Dark bg stays as-is.
  gl_PointSize *= mix(1.5, 1.0, u_darkTheme);
  // Floor so distant field stars are true pinpricks (higher on light so they
  // don't vanish); cap so a near hub can't fill the viewport with one sprite.
  gl_PointSize = clamp(gl_PointSize, mix(2.4, 1.3, u_darkTheme), 180.0);
  // Condensation intro (see birth offset above): grow in from nothing. Applied
  // after the clamp so a being-born star really is invisible, not floored.
  gl_PointSize *= birthE;
  gl_Position = projectionMatrix * mv;
  v_color = a_color;
  v_alpha = a_alpha * birthE;
  v_int = a_intensity;
  v_dark = u_darkTheme;
  // Nearer stars brighter; distant ones fade into the fog. Floor at 0.18 so the
  // far field never fully vanishes.
  v_fade = clamp((u_fogFar - dist) / max(1.0, u_fogFar - u_fogNear), 0.18, 1.0);
  v_age = a_age;
  v_hit = a_hit;
}
`;

const NODE_FRAG = /* glsl */ `
precision mediump float;
uniform float u_lodFade; // cosmic-scale LOD: 1 near (nodes shown) → 0 far
uniform float u_mono;    // 0 = community colour, 1 = monochrome ink
uniform vec3 u_monoColor; // the ink — starlight white or near-black
uniform float u_colorDepth; // gamma on node colour (>1 darker/deeper, <1 lighter)
uniform float u_recency;  // 1 = recency glow on (recent edits burn hotter)
uniform float u_searchOn; // 1 = a search is active (hits pulse, rest recede)
uniform float u_flat;     // 1 = flat sigma discs (no glow profile, no spikes)
uniform float u_saturate; // >1 boosts colour saturation (the vivid Gephi board)
uniform float u_flare;    // 1 = anamorphic streaks on the brightest cores
varying vec3 v_color;
varying float v_alpha;
varying float v_fade;
varying float v_int;
varying float v_dark;
varying float v_kind;
varying float v_age;
varying float v_hit;
void main() {
  vec2 pc = gl_PointCoord - vec2(0.5);
  float d = length(pc) * 2.0;
  // Pixel-true edges (SDF discs): fwidth(d) is the screen-space footprint of
  // one pixel in disc units, so every smoothstep band below is clamped to at
  // least ~1px. Large sprites keep their designed profile; tiny distant ones
  // melt into clean round dots instead of crawling/shimmering as the camera
  // drifts (research round 2, Tier-1 #4).
  float aa = fwidth(d) * 1.1;
  // Stellar-class light profiles — the sky must read as a POPULATION, not a
  // wall of identical glows.
  float core;
  float glow;
  float spikes = 0.0;
  if (u_flat > 0.5) {
    // Sigma: a crisp flat disc with a pixel-exact soft edge — data-viz marks,
    // not glowing stars. Class profiles/spikes deliberately skipped.
    float hw = max(0.06, aa);
    core = 1.0 - smoothstep(0.86 - hw, 0.86 + hw, d);
    glow = 0.0;
  } else if (v_kind > 2.5) {
    // Neutron star: piercing pinpoint, hardly any halo, diffraction spikes.
    float hw = max(0.06, aa);
    core = 1.0 - smoothstep(0.16 - hw, 0.16 + hw, d);
    glow = pow(max(0.0, 1.0 - d), 5.0) * 0.5;
    float fall = max(0.0, 1.0 - d);
    float sw = max(0.05, fwidth(pc.y) * 1.5);
    spikes = ((1.0 - smoothstep(0.0, sw, abs(pc.y))) +
              (1.0 - smoothstep(0.0, sw, abs(pc.x)))) * fall * fall * 0.7;
  } else if (v_kind > 1.5) {
    // Red giant: a big soft diffuse ball, no hard centre (already wide —
    // inherently anti-aliased).
    core = (1.0 - smoothstep(0.0, 0.75, d)) * 0.55;
    glow = pow(max(0.0, 1.0 - d), 1.4);
  } else if (v_kind > 0.5) {
    // Dwarf: small dense core, thin halo — most of the quiet population.
    float hw = max(0.06, aa);
    core = 1.0 - smoothstep(0.24 - hw, 0.24 + hw, d);
    glow = pow(max(0.0, 1.0 - d), 3.2) * 0.35;
  } else {
    // Main sequence (the original glow star).
    float hw = max(0.075, aa);
    core = 1.0 - smoothstep(0.375 - hw, 0.375 + hw, d);
    glow = pow(max(0.0, 1.0 - d), 2.2);
  }
  // Anamorphic flare: the brightest cores (v_int is the HDR hub boost) get a
  // thin horizontal streak — the cinema-lens signature. Never on flat sigma
  // discs, and only for genuine hubs so the field stays calm.
  if (u_flare > 0.5 && u_flat < 0.5 && v_int > 0.85) {
    float fall = max(0.0, 1.0 - d);
    float fw = max(0.02, fwidth(pc.y) * 1.5);
    spikes += (1.0 - smoothstep(0.0, fw, abs(pc.y))) * fall * fall * fall *
              (v_int - 0.85) * 1.7;
  }
  // Separation ring (halo-lite): carve a dim band between core and halo so
  // overlapping stars keep readable edges instead of fusing into one blob.
  // Depth-weighted — NEAR stars (the occluders) get the stronger ring; the far
  // field stays a soft continuum. Spikes are added after, so beacons keep them.
  float ring = smoothstep(0.40, 0.50, d) * (1.0 - smoothstep(0.62, 0.78, d));
  glow *= 1.0 - ring * 0.45 * v_fade;
  // Alpha profile per theme:
  //   dark:  additive blending sums over the void — a low halo alpha is fine.
  //   light: NormalBlending over near-white paper — the halo needs a higher
  //          alpha to tint the dst at all, otherwise stars evaporate.
  float aDark = max(core, glow * 0.6) + spikes;
  float aLight = max(core, glow * 0.85) + spikes;
  float a = mix(aLight, aDark, v_dark) * v_alpha * v_fade * u_lodFade;
  // Light bg: punch up node alpha so the dark stars actually tint the near-white
  // paper (NormalBlend over #fafaf9 needs real opacity or stars evaporate).
  a = mix(min(1.0, a * 1.7), a, v_dark);
  if (a < 0.004) discard;
  vec3 base = v_color * (0.65 + 0.35 * v_fade);
  // Monochrome mode: drop the hue but KEEP brightness — each star becomes a
  // point of the chosen ink (u_monoColor: starlight white, or near-black for
  // light backgrounds where white is invisible). Peak channel preserved so a
  // big vault reads as a clean field, not a rainbow. u_mono 0 = full colour.
  if (u_mono > 0.0) {
    float peak = max(base.r, max(base.g, base.b));
    base = mix(base, u_monoColor * max(peak, 0.55), u_mono);
  }
  // Saturation boost (sigma skin): push hues away from their luma toward the
  // vivid Gephi palette. Identity at 1.0.
  if (u_saturate != 1.0) {
    float sl = dot(base, vec3(0.2126, 0.7152, 0.0722));
    base = clamp(mix(vec3(sl), base, u_saturate), 0.0, 2.0);
  }
  // Colour depth: a gamma on the star colour. On the white skin pale community
  // hues wash out — raising depth (>1) darkens/deepens them so they read on
  // paper; <1 lightens. Identity at 1.0, so the default is untouched.
  base = pow(max(base, vec3(0.0)), vec3(u_colorDepth));
  // Class tints: giants burn warm, neutrons burn white-hot. (Skipped in full
  // monochrome so nothing re-introduces a hue.)
  if (u_mono < 0.99) {
    if (v_kind > 2.5) base = mix(base, vec3(0.92, 0.96, 1.0), 0.65 * (1.0 - u_mono));
    else if (v_kind > 1.5) base = mix(base, base * vec3(1.22, 0.88, 0.66), 1.0 - u_mono);
  }
  // Core inflection differs by theme. Dark: additive brighten toward hue + a
  // touch of white (glowing star on void). Light: DARKEN the core (NormalBlend
  // over near-white bg needs a strong-hued or near-black centre to read).
  vec3 lift = base * core * (0.2 + v_int * 0.9);
  vec3 colDark = base + lift;
  colDark = mix(colDark, vec3(1.0), core * clamp(v_int * 0.22, 0.0, 0.28));
  vec3 colLight = base - lift * 0.7;
  colLight = mix(colLight, vec3(0.0), core * clamp(v_int * 0.35, 0.0, 0.5));
  vec3 col = mix(colLight, colDark, v_dark);
  // Depth desaturation: distant stars drift toward grey as well as dim, the
  // atmospheric-perspective cue additive blending otherwise erases.
  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(luma), col, 0.4 + 0.6 * v_fade);
  // Recency glow: notes touched in the last ~2 weeks burn hotter and a touch
  // warmer (exp decay, ~14-day half-feel) — the vault reads as a map of the
  // owner's current attention. One meaning per channel: temperature = recency.
  if (u_recency > 0.5) {
    float rec = exp(-max(v_age, 0.0) / 14.0);
    col *= 1.0 + 0.55 * rec;
    col = mix(col, col * vec3(1.16, 0.97, 0.78), rec * 0.45);
  }
  // Active search: matches lift, everything else recedes — the matched set is
  // the only thing the eye is offered. (The in-phase size pulse rides u_time in
  // the vertex stage; with ambient motion frozen this static lift still marks
  // the hits.)
  if (u_searchOn > 0.5) {
    col *= mix(0.45, 1.35, v_hit);
    a *= mix(0.5, 1.0, v_hit);
  }
  // Pre-tonemap luminance clamp: caps each sprite's additive CONTRIBUTION at
  // 3.0, so an N-sprite overlap sums to at most 3N instead of unbounded HDR —
  // the structural backstop the per-intensity caps alone can't give.
  col = min(col, vec3(3.0));
  // Light-theme values may have gone below zero from the darkening branch —
  // clamp so NormalBlending doesn't get negative source values.
  col = max(col, vec3(0.0));
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
  // Post-processing. Single-composer path (perfLod) uses `composer`; the
  // selective-bloom path uses bloomComposer (nodes only) + finalComposer
  // (everything + mix). Exactly one path is live per scene, chosen by `selective`.
  private composer!: EffectComposer;
  private bloomComposer?: EffectComposer;
  private finalComposer?: EffectComposer;
  private mixPass?: ShaderPass;
  private fxaaPass?: ShaderPass;
  private cinePass?: ShaderPass;
  private selective = false;
  // Live theme darkness (ctor + applyTheme). On light the bloom pass renders
  // BLACK (points hidden) so the additive mix is a no-op — bloom is a dark-
  // theme effect; on light nothing may bloom (threshold sits above LDR) and
  // summing the sprites twice would fade the dark-core stars.
  private darkTheme = true;
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
  // Midpoint-split support, all sized per edge and rebuilt with edgeEndIdx:
  // deterministic sag direction (random unit vector, 3 floats) + magnitude,
  // and the style-derived endpoint colours (s rgb, t rgb — grey-mixed and
  // focus-factored by writeEdges). The per-tick path multiplies the cached
  // colours by the live length falloff instead of re-deriving style.
  private edgeSagDir: Float32Array = new Float32Array(0);
  private edgeSagMag: Float32Array = new Float32Array(0);
  private edgeBaseCol: Float32Array = new Float32Array(0);
  // 1 = an endpoint is timelapse-hidden → collapse the edge's geometry.
  // Colour-only hiding (×0 = black) is additive-blind: on LIGHT themes black
  // edges DRAW over the near-white paper, so a "hidden" web stayed visible.
  private edgeHiddenArr: Uint8Array = new Uint8Array(0);
  // Undirected edge lookup "a|b" (and "b|a") → edgePairs index, built with
  // edgeEndIdx. Lets a shortest-path node sequence resolve to strand indices
  // without an O(edges) scan per hop.
  private edgeKey = new Map<string, number>();
  // Theme-branched edge look. Set in the constructor and by applyTheme; the
  // hot writeEdgeGeometry uses `edgeBaseBrightness` via the cached base
  // colours, so the values must match writeEdges' current dark/light choice.
  private edgeNeutral: THREE.Color = EDGE_NEUTRAL_DARK;
  private edgeOpacity = EDGE_OPACITY_DARK;
  private edgeBaseBrightness = EDGE_BASE_DARK;
  private appliedEdgeTint: GraphSettings["edgeTint"] = "grey";
  private appliedSkyStyle: GraphSettings["skyStyle"] = "stars";

  // Fat glowing filament overlay — the Phase 3 focus/path layer (spec A2). A
  // fixed FILAMENT_CAP-slot buffer, allocated once; each style change fills the
  // active focus strands (hover incidents + shortest path) and sets the draw
  // count via geometry.instanceCount. Always present but usually draws zero.
  private filaments: LineSegments2 | null = null;
  private filamentGeom: LineSegmentsGeometry | null = null;
  private filamentMat: LineMaterial | null = null;
  // Slot i (< filamentCount) lights edgePairs[filamentEdges[i]]; isPath[i] marks
  // shortest-path strands (brighter). filamentCount ≤ FILAMENT_CAP.
  private filamentEdges = new Int32Array(FILAMENT_CAP);
  private filamentIsPath = new Uint8Array(FILAMENT_CAP);
  private filamentCount = 0;

  // Direction arrows: one instanced cone per edge that FLIES source→target like
  // a little spaceship, looping, oriented along its travel direction. The graph
  // is undirected; direction follows edge insertion order. Hidden unless
  // settings.arrows is on (which also hides the ambient round pulses, since the
  // flying arrows are the same "signal" shown with a heading).
  private arrows: THREE.InstancedMesh;
  private arrowGeom: THREE.ConeGeometry;
  private arrowMat: THREE.MeshBasicMaterial;
  // Tint for arrows whose source node has no colour attr (theme highlight).
  private arrowFallback = new THREE.Color(0xffffff);
  private arrowPhase = new Float32Array(0); // 0..1 position of each arrow on its edge
  private arrowSpeed = new Float32Array(0); // edge-fractions per second (all +, source→target)

  // Multi-shell parallax background (2-3 Points layers in one Group) for depth.
  private starfield: THREE.Group;
  // Recenter the starfield on the camera every frame (an infinite-sky feel):
  // the camera is always INSIDE the shells, so stars fill the frame at any
  // distance. The multiverse turns this on — its galaxies spread far beyond the
  // fixed shell radii, which otherwise render as a bounded ball of stars with
  // the outer galaxies floating on pure black. Off (default) for single vaults,
  // where the origin-centred shells give parallax depth.
  private starfieldFollow = false;
  private nebula: NebulaLayer;
  private nebulaTick = 0; // throttle nebula centroid recompute (every Nth tick)
  private pulse: PulseLayer; // signals flowing along edges (alive/communication)
  private tracePulse: TracePulse; // interactive start→end path trace comet
  private dust: DustLayer; // motes orbiting nodes, shown in spaceship fly mode
  private wave: WaveLayer; // click-triggered neural activation ripple
  private nova: SupernovaFx; // selection shockwave at the clicked star
  private meteor: MeteorLayer; // shooting stars across the galaxy-skin sky
  private coreGlow: CoreGlowLayer; // Andromeda-style bulge per galaxy
  private cosmic: CosmicEvents; // rare black-hole / wormhole events
  private band: GalacticBandLayer; // dust bands hugging each large galaxy
  private imposter: GalaxyImposterLayer; // far-LOD spiral-galaxy discs
  private hulls: CommunityHullLayer; // atlas-mode translucent community fills
  private bundles: EdgeBundleLayer; // bundled inter-community strands (GRAPH-01)
  private atlasMode = false; // static 2D ForceAtlas2 layout (no sim, flat)
  private strataMode = false; // static 2D time-strata chart (no sim, flat)
  private synapse2dMode = false; // static 2D nervous-system layout (spread + fibres)
  private synapse3dMode = false; // nervous-system RENDER over the live 3D sim
  // Either static 2D layout is flat: top-down camera lock, flat bg, no galaxy FX.
  private get flatLayout(): boolean {
    return this.atlasMode || this.synapse2dMode || this.strataMode;
  }
  // Nervous-system rendering (nerve-fibre edges + rapid firing) — both the 2D
  // and the 3D synapse layouts.
  private get synapseRender(): boolean {
    return this.synapse2dMode || this.synapse3dMode;
  }
  // Cosmic-web skin: tiny nodes, filament edges that brighten by overlap.
  private get webSkin(): boolean {
    return this.settings.skin === "web";
  }
  // Sigma skin: flat vivid discs + a coloured edge veil (the Gephi look).
  private get sigmaSkin(): boolean {
    return this.settings.skin === "sigma";
  }
  // Per-skin node size multiplier, folded into u_sizeScale wherever it is set.
  private skinNodeScale(): number {
    return this.webSkin ? WEB_NODE_SCALE : this.sigmaSkin ? 0.72 : 1;
  }
  private imposterEnabled = false; // dark-theme gate (LOD then controls visibility)
  private planets: PlanetLayer; // near-LOD: nearest nodes → procedural planet spheres
  private planetsEnabled = false; // dark-3D layout + nearFieldPlanets toggle
  // Research-bridge hints (gap panel): dashed lines between the centroids of
  // community pairs that are semantically close but structurally unlinked.
  private bridgeLines: THREE.LineSegments;
  private bridgePairs: [number, number][] = [];
  private bridgeTick = 0;
  // Cosmic-scale LOD state (see cosmicLod). onScale fires when the camera
  // crosses a scale band (star → system → galaxy → cluster) for the HUD.
  private lastScale: CosmicScale | null = null;
  private onScale: ((s: CosmicScale) => void) | null = null;
  private imposterTick = 0;
  private imposterTick2 = 0;
  // Cached galaxy centroids for the LOD blend (recomputed on a cadence, not
  // every frame — O(n) is wasteful per-frame at 10k nodes).
  private lodCents: Map<number, { x: number; y: number; z: number; r: number }> | null = null;
  private coreGlowTick = 0; // throttle centroid refresh
  private synapse: WaveLayer; // idle spontaneous micro-firings (dim ripples)
  private synapseTimer = 3; // seconds until the next idle firing
  private synapseCount = 0; // deterministic RNG stream cursor
  // Immersive spaceship mode: a procedural ship + third-person chase rig. Its
  // listeners live only while enabled, so nothing leaks into inputs / orbit.
  private ship!: ShipController;
  private flyMode = false;
  private baseFlySpeed = 600;
  private clusterLabels: ClusterLabels; // community names at rest (reverse semantic zoom)
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
  // Auto-rotate yields to the user (spec A7): any orbit/zoom pauses it, and it
  // resumes only after ROTATE_IDLE_MS without interaction.
  private rotateResumeTimer: ReturnType<typeof setTimeout> | null = null;
  // Interaction LOD (spec B6): true while orbiting/dragging — overlays hidden.
  private interacting = false;
  private lodRestoreTimer: ReturnType<typeof setTimeout> | null = null;
  // Build-time performance mode for very large vaults (spec B5).
  private perfLod = false;

  // pointer / drag state
  private dragId: string | null = null;
  private dragMoved = false;
  private downAt: { x: number; y: number } | null = null;
  private hoverId: string | null = null;
  // Hover micro-pop blends (0..1) per node — the hovered star eases toward 1,
  // everything else drains toward 0 and is dropped once fully back at base
  // size. A tiny array: it only ever holds stars mid-animation.
  private hoverPops: { id: string; blend: number; target: 0 | 1 }[] = [];
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
    // Set the layout flags EARLY: buildStarfield + fog + camera setup all
    // branch on them and run before the hull/atlas block further down.
    this.atlasMode = settings.layout === "atlas";
    // Strata is a 2D time chart — same top-down camera lock and flat-map
    // treatment as atlas, but WITHOUT the community hull fills (a community
    // stretched across the whole time axis would paint one huge balloon).
    // Spiral stays a full-3D orbit (a disc with a bulge; the tilt is the point).
    this.strataMode = settings.layout === "strata";
    this.synapse2dMode = settings.layout === "synapse";
    this.synapse3dMode = settings.layout === "synapse3d";
    this.appliedEdgeTint = settings.edgeTint;
    this.appliedSkyStyle = settings.skyStyle;
    this.cb = cb;
    this.reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    const pr = Math.min(window.devicePixelRatio || 1, 2); // cap bloom cost

    const bg = parseRGBA(theme.bg).color;
    const dark = bg.getHSL({ h: 0, s: 0, l: 0 }).l < 0.5;
    this.darkTheme = dark;
    // Soft near-black with a faint blue cast (space, not a harsh flat black, and
    // no busy dot grid — the mesh reads better on a calm void). Fixed skins
    // (black / white / galaxy) pin the background via theme.sceneBg instead.
    const sceneBg = theme.sceneBg
      ? new THREE.Color(theme.sceneBg)
      : dark
        ? new THREE.Color(0x05060d)
        : bg;
    this.scene.background = sceneBg;
    // Placeholder density only — fit() re-derives it from the framed distance
    // (0.55/framedDist) so the haze ratio is stable at any vault size.
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
    // AgX over ACES: ACES's hue skew twists bright blue/cyan cores toward
    // purple — exactly this palette's failure mode. AgX preserves hue under
    // the HDR glow (research round 2, Tier-1 #3). Slight exposure lift keeps
    // the perceived brightness at the old ACES level.
    this.renderer.toneMapping = THREE.AgXToneMapping;
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
    this.controls.autoRotate = this.autoRotateWanted();
    this.controls.autoRotateSpeed = 0.12; // premium idle motion is slow
    // Flat layouts lock to a top-down 2D map (no orbit tilt vs the flat bg).
    this.applyLayoutCamera();
    // Interaction pauses the idle rotation; it eases back after 8 s of quiet.
    this.controls.addEventListener("start", this.onControlsStart);
    this.controls.addEventListener("end", this.onControlsEnd);

    // Bloom — deep-space glow. The high-pass runs on the LINEAR (un-tone-mapped)
    // composer buffer, where lone field stars peak at luminance ~1.16; a dark
    // threshold of 1.3 sits just above that so ONLY the HDR hub cores
    // (a_intensity-boosted) and dense additive clumps bloom into glowing galaxy
    // centres — the field stays crisp instead of washing into fog.
    // HDR pipeline: render into an explicit HALF-FLOAT target so values >1.0
    // survive into the bloom high-pass instead of clamping to white (the
    // "uniform white puff" root cause). v0.184 defaults to HalfFloatType, but we
    // pass it explicitly so a future upgrade can't silently drop us to 8-bit LDR.
    // Performance mode (spec B5) — decided before the post-processing graph so
    // the bloom pipeline can pick its cheaper path. Big vaults also drop the
    // ambient layers below.
    this.perfLod = graph.order > PERF_LOD_NODES;
    // Selective bloom (spec A1) everywhere but the perf-gated large-vault path,
    // where the doubled render passes aren't worth it — there a single bloom
    // pass over the whole scene is used (edges bloom too, but at 5k+ nodes the
    // node glow dominates anyway and the frame budget matters more).
    this.selective = !this.perfLod;
    // Fresh HDR (half-float) target per composer so values >1 survive the bloom
    // high-pass instead of clamping to white.
    const mkHdrTarget = (): THREE.WebGLRenderTarget =>
      new THREE.WebGLRenderTarget(
        Math.max(1, Math.floor(w * pr)),
        Math.max(1, Math.floor(h * pr)),
        { type: THREE.HalfFloatType },
      );
    // Bloom runs on the LINEAR HDR buffer. Calibrated for ADDITIVE SUMMING, not
    // single sprites: two overlapping field stars already reach ~2.3, so the
    // dark threshold sits at 1.9 (gates pair-overlaps; only true hub cores and
    // dense nuclei bloom). Modest strength + a wider radius read as soft
    // atmospheric glow instead of a hard white disc.
    // Strength is brightness-INDEPENDENT: exposure already scales the whole image
    // via OutputPass, so double-multiplying would blow the glow into a wash.
    this.baseBloom = this.sigmaSkin ? 0.12 : dark ? 0.45 : 0.25;
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(w, h),
      this.baseBloom,
      0.7, // radius (soft atmospheric halo, not a hard ring)
      // Dark: above the additive pair-overlap ceiling. Light: above the LDR
      // ceiling (1.0) — the near-white background sits at ~0.96 luminance, so
      // any threshold below it bloomed the ENTIRE frame into the wash that
      // made the light theme unreadable; only HDR node cores may bloom.
      dark ? 1.9 : 1.05,
    );

    if (this.selective) {
      // Pass 1: render ONLY the node layer, bloom it. renderToScreen off — the
      // result stays a linear HDR texture the mix pass reads.
      this.bloomComposer = new EffectComposer(this.renderer, mkHdrTarget());
      this.bloomComposer.renderToScreen = false;
      this.bloomComposer.setPixelRatio(pr);
      this.bloomComposer.setSize(w, h);
      this.bloomComposer.addPass(new RenderPass(this.scene, this.camera));
      this.bloomComposer.addPass(this.bloom);
      // Pass 2: render the WHOLE scene, add the nodes-only bloom back in, then
      // tone-map. Edges/pulses/filaments/starfield never entered the bloom, so
      // no additive edge sum can bloom (spec A1: edges are structurally proof).
      this.finalComposer = new EffectComposer(this.renderer, mkHdrTarget());
      this.finalComposer.setPixelRatio(pr);
      this.finalComposer.setSize(w, h);
      this.finalComposer.addPass(new RenderPass(this.scene, this.camera));
      this.mixPass = new ShaderPass(
        new THREE.ShaderMaterial({
          uniforms: {
            baseTexture: { value: null },
            bloomTexture: { value: this.bloomComposer.renderTarget2.texture },
          },
          vertexShader: MIX_VERT,
          fragmentShader: MIX_FRAG,
        }),
        "baseTexture",
      );
      this.finalComposer.addPass(this.mixPass);
      // OutputPass converts to display space (ACES + sRGB); the finishing
      // passes below deliberately run AFTER it — AA and film grade both
      // belong on the final LDR image, not the HDR sum.
      this.finalComposer.addPass(new OutputPass());
      this.attachFinishing(this.finalComposer, w, h, pr);
    } else {
      this.composer = new EffectComposer(this.renderer, mkHdrTarget());
      this.composer.setPixelRatio(pr);
      this.composer.setSize(w, h);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.composer.addPass(this.bloom);
      this.composer.addPass(new OutputPass());
      this.attachFinishing(this.composer, w, h, pr);
    }

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
    this.nodeGeom.setAttribute(
      "a_kind",
      new THREE.BufferAttribute(new Float32Array(n), 1),
    );
    this.nodeGeom.setAttribute(
      "a_age",
      new THREE.BufferAttribute(new Float32Array(n).fill(9999), 1),
    );
    this.nodeGeom.setAttribute(
      "a_hit",
      new THREE.BufferAttribute(new Float32Array(n), 1),
    );
    this.nodeGeom.setAttribute(
      "a_spawn",
      new THREE.BufferAttribute(new Float32Array(n), 1),
    );
    this.nodeMat = new THREE.ShaderMaterial({
      uniforms: {
        u_pixelRatio: { value: pr },
        u_sizeScale: { value: this.sizeScale(h) * this.skinNodeScale() },
        u_fogNear: { value: 200 },
        u_fogFar: { value: 2600 },
        u_time: { value: 0 },
        u_darkTheme: { value: dark ? 1 : 0 },
        u_lodFade: { value: 1 },
        u_mono: { value: monoFor(settings, graph.order) },
        u_monoColor: { value: monoColorFor(settings, dark).clone() },
        u_colorDepth: { value: settings.nodeColorDepth },
        u_recency: { value: settings.recencyGlow ? 1 : 0 },
        u_searchOn: { value: 0 },
        u_spawnClock: { value: -1 },
        u_flat: { value: settings.skin === "sigma" ? 1 : 0 },
        u_saturate: { value: settings.skin === "sigma" ? 1.45 : 1 },
        u_flare: { value: settings.cinematic ? 1 : 0 },
        // Sub-pixel at typical framing (~2 world units), so the GPU-only drift
        // never visibly detaches stars from their CPU-anchored edges. Flat 2D
        // maps stay perfectly still — drift is a galaxy-space affordance.
        u_driftAmp: { value: this.flatLayout ? 0 : 2.2 },
      },
      vertexShader: NODE_VERT,
      fragmentShader: NODE_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      // Additive on dark themes so dense clumps self-brighten into glowing
      // galaxy cores; normal on light themes (additive would wash to white) and
      // on the sigma skin (flat discs must stay crisp, not bloom into glow).
      blending: dark && settings.skin !== "sigma" ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(this.nodeGeom, this.nodeMat);
    this.points.frustumCulled = false;
    // Nodes live on BOTH the default layer (final render) and the bloom layer
    // (selective bloom pass renders layer 1 alone). Harmless in the single-pass
    // path, where the camera never restricts to layer 1.
    if (this.selective) this.points.layers.enable(BLOOM_LAYER);
    this.scene.add(this.points);

    // --- edges ---
    this.edgePairs = graph.mapEdges((_e, _a, s, t) => [s, t] as [string, string]);
    this.buildEdgeIndex();
    this.edgeGeom = new THREE.BufferGeometry();
    // 4 vertices per edge (two segments s→m, m→t) for the midpoint split.
    this.edgeGeom.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(this.edgePairs.length * 12), 3),
    );
    this.edgeGeom.setAttribute(
      "color",
      new THREE.BufferAttribute(new Float32Array(this.edgePairs.length * 12), 3),
    );
    // Pick the theme-branched edge look up front so both the material and the
    // vertex-colour derivation (writeEdges) draw from the same values. The web
    // skin overrides: faint additive violet strands that sum where they cross.
    this.edgeNeutral = this.webSkin
      ? EDGE_NEUTRAL_WEB
      : dark
        ? EDGE_NEUTRAL_DARK
        : EDGE_NEUTRAL_LIGHT;
    this.edgeOpacity = this.webSkin
      ? EDGE_OPACITY_WEB
      : this.sigmaSkin
        ? EDGE_OPACITY_SIGMA
        : dark
          ? EDGE_OPACITY_DARK
          : EDGE_OPACITY_LIGHT;
    this.edgeBaseBrightness = this.webSkin
      ? EDGE_BASE_WEB
      : this.sigmaSkin
        ? EDGE_BASE_SIGMA
        : dark
          ? EDGE_BASE_DARK
          : EDGE_BASE_LIGHT;
    this.edgeMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: Math.min(1, this.edgeOpacity * settings.linkThickness),
      depthWrite: false,
      // Additive on dark (colored edges glow + sum into the mesh); normal on
      // light (additive would wash saturated edges to white over a near-white
      // bg) and on sigma (the veil is layered colour, not light).
      blending: dark && !this.sigmaSkin ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.edges = new THREE.LineSegments(this.edgeGeom, this.edgeMat);
    this.edges.frustumCulled = false;
    this.scene.add(this.edges);
    // Cosmic-web skin: edges render as an accumulated density field instead.
    this.ensureEdgeDensity(this.webSkin);
    // Galaxy chart minimap (corner inset + click-to-fly).
    this.setMinimap(settings.minimap);

    // --- filament focus/path layer (lit only on hover / shortest path) ---
    this.buildFilaments();

    // --- direction arrowheads (instanced cones, one per edge) ---
    // Small cone (well under a node's world radius) tinted per-instance with the
    // SOURCE node's colour; white material base so instanceColor shows true.
    // NormalBlending (not additive) so colours read as their hue, not white glow.
    this.arrowGeom = new THREE.ConeGeometry(0.5, 1.6, 8); // points +Y; oriented per-edge
    this.arrowMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });
    this.arrowFallback = parseRGBA(theme.edgeHi).color;
    const arrowCount = Math.max(1, this.edgePairs.length);
    this.arrows = new THREE.InstancedMesh(this.arrowGeom, this.arrowMat, arrowCount);
    this.arrows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.arrows.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(arrowCount * 3).fill(1),
      3,
    );
    this.arrows.frustumCulled = false;
    this.arrows.visible = settings.arrows;
    this.scene.add(this.arrows);

    // --- starfield (distant, dim, multi-shell parallax depth) ---
    // Built regardless, gated by visibility so a skin switch (black ⇄ galaxy)
    // toggles it live without a scene rebuild.
    const amb = skinAmbience(settings.skin, dark);
    this.starfield = this.buildStarfield(dark);
    this.starfield.visible = SHOW_STARFIELD && amb.starfield;
    this.scene.add(this.starfield);
    this.ensureGridBackdrop(settings.skyStyle === "grid", dark);

    // --- nebula/dust (faint additive gas over the biggest galaxies) ---
    // Nebula is just ~9 sprites (8 community clouds + 1 halo), so it's cheap even
    // on a 10k-node vault — enable it regardless of perf-LOD so community colours
    // still read on large graphs (matches applyTheme, which omits the perfLod gate).
    // NOT in a flat 2D layout: viewed top-down the big soft halo sprite reads
    // as one giant white puck dead centre, burying the map.
    const flat = settings.layout === "atlas" || settings.layout === "synapse";
    this.nebula = new NebulaLayer(
      this.graph,
      this.nodeIds,
      SHOW_NEBULA && amb.nebula && !flat,
    );
    this.scene.add(this.nebula.group);

    // --- pulses (signals flowing along the edges, so the graph reads as alive) ---
    this.pulse = new PulseLayer(this.graph, this.edgePairs, pr, dark);
    this.pulse.points.visible = !this.perfLod && !settings.arrows;
    this.scene.add(this.pulse.points);

    // --- trace comet (interactive start→end path traversal accent) ---
    this.tracePulse = new TracePulse(this.graph, pr, dark);
    if (this.selective) this.tracePulse.points.layers.enable(BLOOM_LAYER);
    this.scene.add(this.tracePulse.points);

    // --- dust motes (orbit nodes; only shown while piloting the spaceship) ---
    this.dust = new DustLayer(this.graph, this.nodeIds, pr, dark);
    this.scene.add(this.dust.points);

    // --- activation wave + supernova (click-triggered, explicit interaction) ---
    this.wave = new WaveLayer(this.graph, pr, dark);
    this.wave.setSizeScale(this.sizeScale(h));
    this.scene.add(this.wave.sparks);
    this.scene.add(this.wave.flashes);
    this.nova = new SupernovaFx(pr, dark);
    this.nova.setSizeScale(this.sizeScale(h));
    // Flashes + shockwave may bloom (they're node-scale light events).
    if (this.selective) {
      this.wave.flashes.layers.enable(BLOOM_LAYER);
      this.nova.points.layers.enable(BLOOM_LAYER);
    }
    this.scene.add(this.nova.points);

    // --- idle synapse firing (dim spontaneous ripples) + meteors (galaxy sky) ---
    this.synapse = new WaveLayer(this.graph, pr, dark);
    this.synapse.setSizeScale(this.sizeScale(h));
    this.scene.add(this.synapse.sparks);
    this.scene.add(this.synapse.flashes);
    this.meteor = new MeteorLayer();
    this.meteor.lines.visible = amb.meteors && !this.perfLod;
    this.scene.add(this.meteor.lines);

    // Painted "galaxy" adornments (procedural spiral imposters, core bulges,
    // dust bands) are DISABLED by request — the real node clusters are the
    // galaxies; nothing is faked on top. Constructed but never enabled so the
    // rest of the wiring (rebuild/resize/dispose) stays uniform.
    this.coreGlow = new CoreGlowLayer(this.graph, this.nodeIds, pr, false);
    this.scene.add(this.coreGlow.points);
    this.cosmic = new CosmicEvents(pr);
    this.cosmic.setFrequency(settings.cosmicFrequency);
    this.cosmic.setSizeScale(this.sizeScale(h));
    this.scene.add(this.cosmic.group);
    this.band = new GalacticBandLayer(this.graph, this.nodeIds, pr);
    this.band.points.visible = false;
    this.scene.add(this.band.points);
    this.imposter = new GalaxyImposterLayer(this.graph, this.nodeIds, pr, false);
    this.imposterEnabled = false; // never paint spiral discs
    this.scene.add(this.imposter.points);
    // Near-field LOD planets (the close end of the LOD; imposters are the far
    // end). Constructed disabled; updatePlanetGate() flips it on for dark 3D
    // layouts when the user enables nearFieldPlanets.
    this.planets = new PlanetLayer(this.graph, this.nodeIds, this.camera, pr, dark, false);
    this.scene.add(this.planets.sphere);
    this.scene.add(this.planets.rings);
    this.scene.add(this.planets.moons);
    this.updatePlanetGate();
    // Research-bridge hints: hidden until the gap panel supplies pairs.
    this.bridgeLines = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineDashedMaterial({
        color: 0x8b6cff,
        dashSize: 6,
        gapSize: 5,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
      }),
    );
    this.bridgeLines.frustumCulled = false;
    this.bridgeLines.visible = false;
    this.scene.add(this.bridgeLines);
    // Static 2D ForceAtlas2 layouts. "atlas" draws translucent per-community
    // territory hulls (Gephi map). "synapse" is the same flat pipeline tuned
    // to spread the cores apart with nerve-fibre bridges — NO hull fills (a
    // nervous system has no territories, just fibres). Positions are set by
    // applyAtlasLayout (no worker sim).
    this.hulls = new CommunityHullLayer(this.graph, dark);
    this.hulls.setVisible(this.atlasMode);
    this.scene.add(this.hulls.mesh);
    // Bundled inter-community strands (GRAPH-01): rebuilt on layoutSettled()
    // (galaxy mode) / atlas apply, so they always follow the measured layout.
    this.bundles = new EdgeBundleLayer(this.graph, dark, w, h);
    this.bundles.setVisible(settings.edgeBundles);
    this.scene.add(this.bundles.group);

    // --- spaceship (immersive third-person flight; enabled via setFlyMode) ---
    this.ship = new ShipController(
      this.camera,
      this.renderer.domElement,
      this.scene,
      this.baseFlySpeed,
    );
    this.ship.setDark(dark);

    // --- cluster auto-labels (community names while zoomed out) ---
    this.clusterLabels = new ClusterLabels(this.graph);
    this.scene.add(this.clusterLabels.group);

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
    this.initArrowMotion();
    this.writeArrowColors();
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

  // Star shells on a SPHERE around the origin — a full field on every side, so
  // it fills the frame from any angle (crucial for spaceship fly-through and
  // for the 2D layouts, where the map is a tiny cluster in a big sky). Used for
  // every layout: the 2D layouts lock camera rotation, so the sphere never
  // tilts against the flat map (the old "이격"); it just pans/zooms coherently.
  // sizeAttenuation:false keeps points pixel-sized; a plain low-opacity
  // PointsMaterial (NOT the additive HDR node shader) never blooms.
  //
  // skyStyle picks the density/appearance: dense fills every side hard (the
  // "4면이 꽉 찬 우주"); grid adds a dark dotted backdrop (big-data-viz look);
  // void is an almost-empty sky.
  private buildStarfield(dark: boolean): THREE.Group {
    const group = new THREE.Group();
    const style = this.settings.skyStyle;
    // Base three-shell field; density multiplied per style. Flat 2D layouts
    // never go below "dense" — a sparse plane left big empty gaps in fly mode.
    const flatFull = this.flatLayout;
    const densMul =
      style === "void" ? 0.25 : style === "dense" || flatFull ? 2.2 : 1;
    const near = dark
      ? [
          { count: 900, r0: 900, r1: 3000, size: 1.6, color: 0xbcc6e0, op: 0.3 },
          { count: 1100, r0: 3200, r1: 4600, size: 1.4, color: 0x8f9ec4, op: 0.2 },
          { count: 1400, r0: 5000, r1: 6800, size: 1.0, color: 0x6b7aa6, op: 0.14 },
        ]
      : [
          { count: 700, r0: 900, r1: 3000, size: 1.5, color: 0xc6cee0, op: 0.24 },
          { count: 900, r0: 3200, r1: 4600, size: 1.1, color: 0xb2bcd2, op: 0.16 },
          { count: 1100, r0: 5000, r1: 6800, size: 0.8, color: 0xa6b0c8, op: 0.1 },
        ];
    let shells = near.map((s) => ({ ...s, count: Math.round(s.count * densMul) }));
    // Performance mode keeps only the mid shell — one draw call of depth cue.
    if (this.perfLod) shells = [shells[1]];
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

  /**
   * Keep the starfield centred on the camera (an "infinite sky"): the camera
   * never leaves the shells, so stars fill the frame at any distance and can
   * never render as a bounded ball the scene outgrows. The multiverse enables
   * this; single-vault keeps the origin-centred parallax shells.
   */
  setStarfieldFollowCamera(on: boolean): void {
    this.starfieldFollow = on;
    if (!on) this.starfield.position.set(0, 0, 0);
  }

  // --- screen-space dotted-grid backdrop (the big-data-viz / reference look) ---
  // A fullscreen dot grid that fills the ENTIRE viewport whatever the camera
  // does (the two-wall world-space version left a big empty gap down the
  // middle). The vertex shader ignores the camera and parks the quad on the
  // far plane; the fragment shader stamps a dot at each grid cell, with a
  // subtle parallax offset from the camera direction so it still reads as
  // depth, not a flat UI overlay.
  private gridBackdrop: THREE.Mesh | null = null;
  private ensureGridBackdrop(on: boolean, dark: boolean): void {
    if (on && !this.gridBackdrop) {
      const geo = new THREE.PlaneGeometry(2, 2);
      const mat = new THREE.ShaderMaterial({
        transparent: true,
        depthTest: false,
        depthWrite: false,
        uniforms: {
          u_color: { value: new THREE.Color(dark ? 0x4a5a8c : 0x8a94b4) },
          u_alpha: { value: dark ? 0.5 : 0.3 },
          u_cells: { value: 46 },
          u_aspect: { value: 1 },
          u_offset: { value: new THREE.Vector2(0, 0) },
        },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = vec4(position.xy, 0.9999, 1.0); // fullscreen, far
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 u_color; uniform float u_alpha; uniform float u_cells;
          uniform float u_aspect; uniform vec2 u_offset;
          varying vec2 vUv;
          void main() {
            vec2 uv = vUv;
            uv.x *= u_aspect;          // square cells regardless of viewport
            uv += u_offset;            // subtle camera-driven parallax
            vec2 c = fract(uv * u_cells) - 0.5;
            float d = length(c);
            float a = (1.0 - smoothstep(0.05, 0.11, d)) * u_alpha;
            if (a < 0.01) discard;
            gl_FragColor = vec4(u_color, a);
          }
        `,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = -1000; // draw first; everything else paints over it
      this.gridBackdrop = mesh;
      this.scene.add(mesh);
    } else if (!on && this.gridBackdrop) {
      this.scene.remove(this.gridBackdrop);
      this.gridBackdrop.geometry.dispose();
      (this.gridBackdrop.material as THREE.Material).dispose();
      this.gridBackdrop = null;
    }
    if (this.gridBackdrop) {
      const h = Math.max(1, this.container.clientHeight);
      const w = Math.max(1, this.container.clientWidth);
      (this.gridBackdrop.material as THREE.ShaderMaterial).uniforms.u_aspect.value = w / h;
      (this.gridBackdrop.material as THREE.ShaderMaterial).uniforms.u_color.value.set(
        dark ? 0x4a5a8c : 0x8a94b4,
      );
      (this.gridBackdrop.material as THREE.ShaderMaterial).uniforms.u_alpha.value = dark
        ? 0.5
        : 0.3;
    }
  }

  // Camera interaction mode by layout. Flat layouts (atlas / synapse) lock to a
  // top-down 2D map: orbit disabled (the tilt is what made the flat map fight
  // the background), pan in the screen plane, zoom only — fit() parks the
  // camera straight-on down the +Z axis so the map's own XY plane fills the
  // screen. Galaxy keeps full 3D orbit. Rotate stays off, so the OrbitControls
  // Y-up polar convention (which assumes an XZ ground plane, not our XY map
  // plane) never gets a chance to re-tilt the view.
  private applyLayoutCamera(): void {
    const flat = this.flatLayout;
    this.controls.enableRotate = !flat;
    this.controls.screenSpacePanning = flat;
    if (flat) this.controls.autoRotate = false;
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
    const kind = this.nodeGeom.getAttribute("a_kind") as THREE.BufferAttribute;
    const age = this.nodeGeom.getAttribute("a_age") as THREE.BufferAttribute;
    const hit = this.nodeGeom.getAttribute("a_hit") as THREE.BufferAttribute;
    const { hoveredNode, neighbors, focus, tints, pulseId, pulseScale } =
      this.style;
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

      // Focus isolation outranks hover: non-members sink to the deep context
      // layer no matter what; hover only differentiates WITHIN the members.
      if (focus && !focus.has(id)) {
        alpha = a.hidden ? 0 : FOCUS_NODE_DIM;
        inten = 0; // outside the focus must not bloom
      } else if (hoveredNode && neighbors) {
        // hover neighbourhood: hovered + neighbours pop (full alpha + bloom);
        // the rest sink to a faint context layer (0.15 — the old 0.5 was too
        // timid to read as focus) but stay visible so the cosmos and orbit
        // remain legible.
        if (id === hoveredNode || neighbors.has(id)) {
          // keep full colour / alpha / intensity
        } else {
          alpha = a.hidden ? 0 : 0.15;
          inten = 0; // non-neighbours must not bloom
        }
      }

      col.setXYZ(i, c.r, c.g, c.b);
      siz.setX(i, size);
      alp.setX(i, alpha);
      intn.setX(i, a.hidden ? 0 : inten); // hidden cores must not bloom
      kind.setX(i, a.starKind ?? 0);
      age.setX(i, a.age ?? 9999);
      hit.setX(i, this.searchHits?.has(id) ? 1 : 0);
    }
    // Reapply the hover micro-pop on top of the full rewrite so a style push
    // mid-pop (or while the pop is settled at full scale) doesn't snap the
    // star back to base size.
    for (const p of this.hoverPops) {
      const idx = this.idIndex.get(p.id);
      if (idx !== undefined) siz.setX(idx, this.popSize(p.id, p.blend));
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    siz.needsUpdate = true;
    alp.needsUpdate = true;
    intn.needsUpdate = true;
    kind.needsUpdate = true;
    age.needsUpdate = true;
    hit.needsUpdate = true;
  }

  // ── Condensation intro ────────────────────────────────────────────────
  // One-shot birth animation: stars ease in from a small offset, staggered by
  // cluster. Runs on the page's FIRST scene of a visit (PageGraph gates the
  // call), never on filter-rebuild churn. −1 = idle/off.
  private spawnClock = -1;

  /** Per-node birth delays: clusters condense one after another, stars within
   * a cluster shimmer in over a short window. Deterministic. */
  private writeSpawnDelays(): void {
    const spawn = this.nodeGeom.getAttribute("a_spawn") as THREE.BufferAttribute;
    const rankOf = new Map<number, number>();
    for (let i = 0; i < this.nodeIds.length; i++) {
      const cm = this.graph.getNodeAttribute(this.nodeIds[i], "community");
      if (!rankOf.has(cm)) rankOf.set(cm, rankOf.size);
      const rank = Math.min(rankOf.get(cm) ?? 0, 12);
      spawn.setX(i, rank * 0.09 + GraphScene.starRand(i * 3 + 1) * 0.4);
    }
    spawn.needsUpdate = true;
  }

  /** Play the condensation intro (no-op under reduced motion). */
  playCondensation(): void {
    if (this.reducedMotion) return;
    this.writeSpawnDelays();
    this.spawnClock = 0;
    this.nodeMat.uniforms.u_spawnClock.value = 0;
  }

  // Current search-match set (pulse-in-phase highlight). Null = no search.
  private searchHits: Set<string> | null = null;

  /** Highlight the current search matches: they pulse in phase and everything
   * else recedes. Pass null (or an empty set) to clear. */
  setSearchHits(ids: Set<string> | null): void {
    this.searchHits = ids && ids.size > 0 ? ids : null;
    this.nodeMat.uniforms.u_searchOn.value = this.searchHits ? 1 : 0;
    this.writeNodes();
  }

  // Rendered a_size for a node at a given hover-pop blend — composes with the
  // ingest pulse exactly the way writeNodes does, then eases the pop on top.
  private popSize(id: string, blend: number): number {
    const a = this.graph.getNodeAttributes(id);
    const { pulseId, pulseScale, tints } = this.style;
    const base =
      pulseId === id && tints.get(id) !== undefined ? a.size * pulseScale : a.size;
    const e = 1 - Math.pow(1 - blend, 3); // ease-out cubic: fast attack, soft landing
    return base * (1 + (HOVER_POP_SCALE - 1) * e);
  }

  // Hover micro-pop bookkeeping: the newly hovered star eases toward full pop,
  // every other tracked star eases back. Gated on ambientOn() — reduced-motion
  // users get no pop (the neighbourhood highlight already marks hover).
  private setHoverPop(id: string | null): void {
    for (const p of this.hoverPops) if (p.id !== id) p.target = 0;
    if (!id || !this.ambientOn()) return;
    const cur = this.hoverPops.find((p) => p.id === id);
    if (cur) cur.target = 1;
    else this.hoverPops.push({ id, blend: 0, target: 1 });
  }

  // Advance the pop blends and rewrite ONLY the affected a_size floats (a
  // handful at most) — the full writeNodes pass is style-driven, not per-frame.
  // Entries settled at full pop stop writing; drained entries restore base
  // size once and drop out, so an idle frame touches no buffers at all.
  private hoverPopTick(dt: number): void {
    if (this.hoverPops.length === 0) return;
    const siz = this.nodeGeom.getAttribute("a_size") as THREE.BufferAttribute;
    const step = (dt * 1000) / HOVER_POP_MS;
    let touched = false;
    for (let i = this.hoverPops.length - 1; i >= 0; i--) {
      const p = this.hoverPops[i];
      const before = p.blend;
      p.blend =
        p.target === 1 ? Math.min(1, p.blend + step) : Math.max(0, p.blend - step);
      if (p.blend !== before) {
        const idx = this.idIndex.get(p.id);
        if (idx !== undefined) {
          siz.setX(idx, this.popSize(p.id, p.blend));
          touched = true;
        }
      }
      if (p.blend === 0 && p.target === 0) this.hoverPops.splice(i, 1);
    }
    if (touched) siz.needsUpdate = true;
  }

  // Rebuild the endpoint-colour cache from style (community hue pulled halfway
  // to neutral grey, hover focus factor, timelapse hide), then re-derive the
  // vertex buffers. Style changes are rare; the per-tick paths reuse the cache.
  private writeEdges(): void {
    const { hoveredNode, neighbors, focus } = this.style;
    const base = this.edgeBaseCol;
    const cs = new THREE.Color(); // reused per edge (no per-edge allocation)
    const ct = new THREE.Color();
    for (let i = 0; i < this.edgePairs.length; i++) {
      const [s, t] = this.edgePairs[i];
      const sa = this.graph.getNodeAttributes(s);
      const ta = this.graph.getNodeAttributes(t);
      // Each end takes its node's community colour. Default: greyed halfway
      // (structure is grey; signal is nodes). "community" tint keeps the full
      // hue and brightens — thousands of intra-cluster edges then stack into
      // the coloured translucent veil of the classic Gephi hairball, and
      // inter-cluster strands gradient between their communities' hues.
      // The synapse LAYOUT inverts the emphasis: the long INTER-cluster
      // bridges glow as bright gradient nerve fibres while dense intra-cluster
      // edges dim into tight cores (ganglia joined by nerves — the reference).
      const web = this.settings.edgeTint === "community";
      // Web skin: near-uniform filament tissue (strong pull to the violet
      // neutral) — density, not hue, carries the picture there.
      const greyMix = this.webSkin
        ? EDGE_GREY_MIX_WEB
        : this.sigmaSkin
          ? EDGE_GREY_MIX_SIGMA
          : web || this.synapseRender
            ? 0.12
            : EDGE_GREY_MIX;
      cs.set(sa.color).lerp(this.edgeNeutral, greyMix);
      ct.set(ta.color).lerp(this.edgeNeutral, greyMix);
      if (this.sigmaSkin) {
        // Vivid veil: push the strand hues away from grey (mirrors the node
        // shader's u_saturate, which never touches edge vertex colours).
        const boost = (c: THREE.Color): void => {
          const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
          c.setRGB(
            Math.min(1, Math.max(0, l + (c.r - l) * 1.5)),
            Math.min(1, Math.max(0, l + (c.g - l) * 1.5)),
            Math.min(1, Math.max(0, l + (c.b - l) * 1.5)),
          );
        };
        boost(cs);
        boost(ct);
      }
      let f = this.edgeBaseBrightness * (web && !this.webSkin ? 1.55 : 1);
      if (this.synapseRender) {
        const inter =
          sa.community !== ta.community && sa.community >= 0 && ta.community >= 0;
        f = this.edgeBaseBrightness * (inter ? 2.4 : 0.5);
      }
      if (focus && !(focus.has(s) && focus.has(t))) {
        // Edge leaves the focus set → near-invisible context, hover ignored.
        f = FOCUS_EDGE_DIM;
      } else if (hoveredNode) {
        const incident =
          s === hoveredNode ||
          t === hoveredNode ||
          !!(neighbors && neighbors.has(s) && neighbors.has(t));
        f = incident ? EDGE_HI : EDGE_DIM;
      }
      if (sa.hidden || ta.hidden) f = 0; // timelapse-hidden ⇒ vanish
      this.edgeHiddenArr[i] = sa.hidden || ta.hidden ? 1 : 0;
      const o = i * 6;
      base[o] = cs.r * f;
      base[o + 1] = cs.g * f;
      base[o + 2] = cs.b * f;
      base[o + 3] = ct.r * f;
      base[o + 4] = ct.g * f;
      base[o + 5] = ct.b * f;
    }
    this.writeEdgeGeometry();
    // Recompute which strands the focus/path layer lights (style just changed),
    // then paint them. The per-tick path only repaints; it never re-selects.
    if (this.filaments) {
      this.refreshFilamentTargets();
      this.updateFilaments();
    }
  }

  // Orient one cone per edge at the target end, pointing source→target. Scaled
  // by arrowSize (× linkThickness so a thicker link keeps a proportional head)
  // and tinted with the SOURCE node's colour. Hidden endpoints (timelapse)
  // collapse the instance to zero scale.
  // Seed a per-edge phase + speed so the flying arrows aren't synchronised.
  // Deterministic (seededUnit) so motion is reproducible across rebuilds.
  private initArrowMotion(): void {
    const n = this.edgePairs.length;
    this.arrowPhase = new Float32Array(n);
    this.arrowSpeed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this.arrowPhase[i] = seededUnit(`arrow-p-${i}`, 51);
      this.arrowSpeed[i] = 0.16 + seededUnit(`arrow-s-${i}`, 52) * 0.22; // 0.16..0.38 /s
    }
  }

  // Paint each arrow with its SOURCE node's colour. Colours change rarely (theme
  // / rebuild), so this is separate from the per-frame matrix animation.
  private writeArrowColors(): void {
    const col = new THREE.Color();
    for (let i = 0; i < this.edgePairs.length; i++) {
      const a = this.graph.getNodeAttributes(this.edgePairs[i][0]);
      if (a.color) col.set(a.color);
      else col.copy(this.arrowFallback);
      this.arrows.setColorAt(i, col);
    }
    if (this.arrows.instanceColor) this.arrows.instanceColor.needsUpdate = true;
  }

  // Advance every arrow along its edge toward the target and re-orient it along
  // its heading — a fleet of little ships flying source→target, looping. Reads
  // live node positions so arrows track the moving layout. dt in seconds.
  private animateArrows(dt: number): void {
    const lt = this.settings.linkThickness;
    const asz = this.settings.arrowSize * lt;
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
      let p = this.arrowPhase[i] + this.arrowSpeed[i] * dt;
      p -= Math.floor(p); // wrap to [0,1): reaches target, respawns at source
      this.arrowPhase[i] = p;
      const [s, t] = this.edgePairs[i];
      const a = this.graph.getNodeAttributes(s);
      const b = this.graph.getNodeAttributes(t);
      if (a.hidden || b.hidden) {
        m.compose(ZERO, q.identity(), ZERO);
        this.arrows.setMatrixAt(i, m);
        continue;
      }
      sPos.set(a.x, a.y, a.z);
      tPos.set(b.x, b.y, b.z);
      dir.subVectors(tPos, sPos);
      const len = dir.length();
      if (len < 1e-3) {
        m.compose(sPos, q.identity(), ZERO);
        this.arrows.setMatrixAt(i, m);
        continue;
      }
      dir.divideScalar(len);
      q.setFromUnitVectors(up, dir); // cone's +Y axis points toward the target
      // Fly along the edge, stopping short of the target star's surface so the
      // ship visibly "arrives" at the node rather than overlapping its core.
      const back = b.size * NODE_RADIUS;
      const travel = Math.max(0, len - back);
      pos.copy(sPos).addScaledVector(dir, p * travel);
      scl.set(asz, asz, asz);
      m.compose(pos, q, scl);
      this.arrows.setMatrixAt(i, m);
    }
    this.arrows.instanceMatrix.needsUpdate = true;
  }

  private updateLabels(): void {
    // Interaction LOD (spec B6): during an orbit/drag drop every per-node label
    // (hidden this frame, restored when the gesture's debounce lapses) so the
    // CSS2D layer isn't reflowing 10k transforms mid-motion.
    if (this.interacting) {
      if (this.shownLabels.size > 0) {
        for (const id of this.shownLabels) {
          const obj = this.labels.get(id);
          if (obj) obj.visible = false;
        }
        this.shownLabels.clear();
      }
      return;
    }
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
    // Reverse semantic zoom: community names show while zoomed out and hand
    // over to per-node labels as the camera pushes in.
    this.clusterLabels.setZoomRatio(ratio);
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

  // Resolve [srcIdx, tgtIdx] per edge from the current idIndex, plus the
  // deterministic per-edge sag vector/magnitude and the endpoint-colour cache.
  // Cheap; run once on build/rebuild so the per-tick path can copy endpoint
  // positions by index.
  private buildEdgeIndex(): void {
    const nEdges = this.edgePairs.length;
    const idx = new Int32Array(nEdges * 2);
    const sagDir = new Float32Array(nEdges * 3);
    const sagMag = new Float32Array(nEdges);
    this.edgeKey.clear();
    for (let e = 0; e < nEdges; e++) {
      const [s, t] = this.edgePairs[e];
      idx[e * 2] = this.idIndex.get(s) ?? 0;
      idx[e * 2 + 1] = this.idIndex.get(t) ?? 0;
      // Undirected lookup for the filament focus/path layer.
      this.edgeKey.set(`${s}|${t}`, e);
      this.edgeKey.set(`${t}|${s}`, e);
      // Seeded random unit vector — crossed with the live edge direction each
      // tick to get a stable perpendicular, so the sag doesn't swim as the sim
      // settles and is identical across reloads.
      const key = `${s}|${t}`;
      const theta = seededUnit(key, 31) * Math.PI * 2;
      const phi = Math.acos(2 * seededUnit(key, 32) - 1);
      const sinPhi = Math.sin(phi);
      sagDir[e * 3] = Math.cos(theta) * sinPhi;
      sagDir[e * 3 + 1] = Math.sin(theta) * sinPhi;
      sagDir[e * 3 + 2] = Math.cos(phi);
      sagMag[e] = EDGE_SAG * (0.7 + 0.6 * seededUnit(key, 33)); // ~5% ± 30%
    }
    this.edgeEndIdx = idx;
    this.edgeSagDir = sagDir;
    this.edgeSagMag = sagMag;
    this.edgeBaseCol = new Float32Array(nEdges * 6);
    this.edgeHiddenArr = new Uint8Array(nEdges);
  }

  // Derive the edge vertex buffers (4 verts/edge: s, mid, mid, t) from the
  // node position buffer + the endpoint-colour cache. The ONLY writer of edge
  // geometry — shared by the per-tick paths and writeEdges. Per edge it adds
  // the midpoint (+6 position floats), the sag offset, and the length falloff;
  // profiled at 10k edges (see calm-cosmic-web spec A2).
  private writeEdgeGeometry(): void {
    const nArr = (this.nodeGeom.getAttribute("position") as THREE.BufferAttribute)
      .array as Float32Array;
    const epos = this.edgeGeom.getAttribute("position") as THREE.BufferAttribute;
    const ecol = this.edgeGeom.getAttribute("color") as THREE.BufferAttribute;
    const pArr = epos.array as Float32Array;
    const cArr = ecol.array as Float32Array;
    const idx = this.edgeEndIdx;
    const sagDir = this.edgeSagDir;
    const sagMag = this.edgeSagMag;
    const base = this.edgeBaseCol;
    const fadeStart = this.settings.linkDistance * EDGE_LEN_FADE_START;
    const fadeEnd = this.settings.linkDistance * EDGE_LEN_FADE_END;
    const fadeSpan = Math.max(1e-6, fadeEnd - fadeStart);
    const hiddenArr = this.edgeHiddenArr;
    for (let e = 0; e < this.edgePairs.length; e++) {
      const s = idx[e * 2] * 3;
      const t = idx[e * 2 + 1] * 3;
      const sx = nArr[s];
      const sy = nArr[s + 1];
      const sz = nArr[s + 2];
      if (hiddenArr[e]) {
        // Zero-length segments rasterise to nothing under ANY blending mode.
        const po0 = e * 12;
        const co0 = e * 12;
        for (let k = 0; k < 4; k++) {
          pArr[po0 + k * 3] = sx;
          pArr[po0 + k * 3 + 1] = sy;
          pArr[po0 + k * 3 + 2] = sz;
          cArr[co0 + k * 3] = 0;
          cArr[co0 + k * 3 + 1] = 0;
          cArr[co0 + k * 3 + 2] = 0;
        }
        continue;
      }
      const tx = nArr[t];
      const ty = nArr[t + 1];
      const tz = nArr[t + 2];
      const dx = tx - sx;
      const dy = ty - sy;
      const dz = tz - sz;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      // midpoint + perpendicular sag (perp = normalize(dir × sagDir) × ~5% len)
      let mx = (sx + tx) * 0.5;
      let my = (sy + ty) * 0.5;
      let mz = (sz + tz) * 0.5;
      const rx = sagDir[e * 3];
      const ry = sagDir[e * 3 + 1];
      const rz = sagDir[e * 3 + 2];
      const px = dy * rz - dz * ry;
      const py = dz * rx - dx * rz;
      const pz = dx * ry - dy * rx;
      const pLen = Math.sqrt(px * px + py * py + pz * pz);
      if (pLen > 1e-6) {
        const k = (sagMag[e] * (this.sigmaSkin ? EDGE_SAG_BOOST_SIGMA : 1) * len) / pLen;
        mx += px * k;
        my += py * k;
        mz += pz * k;
      }
      const po = e * 12;
      pArr[po] = sx;
      pArr[po + 1] = sy;
      pArr[po + 2] = sz;
      pArr[po + 3] = mx;
      pArr[po + 4] = my;
      pArr[po + 5] = mz;
      pArr[po + 6] = mx;
      pArr[po + 7] = my;
      pArr[po + 8] = mz;
      pArr[po + 9] = tx;
      pArr[po + 10] = ty;
      pArr[po + 11] = tz;
      // length falloff × cached endpoint colours; ends ×EDGE_END_FADE, mid ×1
      const lf =
        len <= fadeStart
          ? 1
          : len >= fadeEnd
            ? EDGE_LEN_FADE_MIN
            : 1 - (1 - EDGE_LEN_FADE_MIN) * ((len - fadeStart) / fadeSpan);
      const bo = e * 6;
      const sr = base[bo] * lf;
      const sg = base[bo + 1] * lf;
      const sb = base[bo + 2] * lf;
      const tr = base[bo + 3] * lf;
      const tg = base[bo + 4] * lf;
      const tb = base[bo + 5] * lf;
      const mr = (sr + tr) * 0.5;
      const mg = (sg + tg) * 0.5;
      const mb = (sb + tb) * 0.5;
      const co = e * 12;
      cArr[co] = sr * EDGE_END_FADE;
      cArr[co + 1] = sg * EDGE_END_FADE;
      cArr[co + 2] = sb * EDGE_END_FADE;
      cArr[co + 3] = mr;
      cArr[co + 4] = mg;
      cArr[co + 5] = mb;
      cArr[co + 6] = mr;
      cArr[co + 7] = mg;
      cArr[co + 8] = mb;
      cArr[co + 9] = tr * EDGE_END_FADE;
      cArr[co + 10] = tg * EDGE_END_FADE;
      cArr[co + 11] = tb * EDGE_END_FADE;
    }
    epos.needsUpdate = true;
    ecol.needsUpdate = true;
  }

  // Build the focus/path filament layer once with a fixed FILAMENT_CAP-slot
  // buffer (spec A2). Draws zero strands until a hover / shortest path lights
  // some; the pool is never reallocated, only refilled + re-counted.
  private buildFilaments(): void {
    this.filamentGeom = new LineSegmentsGeometry();
    this.filamentGeom.setPositions(new Float32Array(FILAMENT_CAP * 6));
    this.filamentGeom.setColors(new Float32Array(FILAMENT_CAP * 6));
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
    this.filamentCount = 0;
    this.filamentGeom.instanceCount = 0;
    this.scene.add(this.filaments);
  }

  // Choose which strands are lit from the current style: the shortest path
  // (Cmd-click) first — brightest — then the hovered node's incident edges.
  // Deduped and capped. Cheap: bounded by FILAMENT_CAP + the hovered node's
  // degree, both small. Call on any style change; updateFilaments then paints
  // the chosen strands each tick.
  private refreshFilamentTargets(): void {
    const { hoveredNode, pathNodes } = this.style;
    let n = 0;
    const seen = new Set<number>();
    const add = (e: number | undefined, isPath: boolean): void => {
      if (e == null || n >= FILAMENT_CAP || seen.has(e)) return;
      seen.add(e);
      this.filamentEdges[n] = e;
      this.filamentIsPath[n] = isPath ? 1 : 0;
      n++;
    };
    if (pathNodes && pathNodes.length > 1) {
      for (let i = 0; i + 1 < pathNodes.length; i++) {
        add(this.edgeKey.get(`${pathNodes[i]}|${pathNodes[i + 1]}`), true);
      }
    }
    if (hoveredNode && this.graph.hasNode(hoveredNode)) {
      for (const nb of this.graph.neighbors(hoveredNode)) {
        add(this.edgeKey.get(`${hoveredNode}|${nb}`), false);
      }
    }
    this.filamentCount = n;
  }

  // Paint the chosen strands from live positions. Path strands pop brightest;
  // hover incidents sit a notch lower; timelapse-hidden endpoints vanish. Draw
  // count = filamentCount (0 → nothing renders).
  private updateFilaments(): void {
    if (!this.filaments || !this.filamentGeom) return;
    const n = this.filamentCount;
    if (n === 0) {
      this.filamentGeom.instanceCount = 0;
      return;
    }
    const pos = new Float32Array(n * 6);
    const col = new Float32Array(n * 6);
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
      const f =
        sa.hidden || ta.hidden
          ? 0
          : this.filamentIsPath[i]
            ? FILAMENT_PATH
            : FILAMENT_BASE;
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
    this.filamentGeom.instanceCount = n;
  }

  // Per-tick HOT path: update node positions, then re-derive the edge vertex
  // buffers (midpoint/sag/length-falloff) from them via the cached endpoint
  // colours. Node colours/sizes/alpha/intensity never change while the sim
  // merely moves nodes, so the expensive style derivation (graphology reads +
  // hex parses) stays out of the tick; the edge pass is pure float arithmetic
  // over typed arrays.
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
    this.writeEdgeGeometry();
  }

  // Rotate every galaxy's members about their group centroid around the
  // galaxy's seeded disc axis (matching the worker's disc flattening), and
  // orbit orphan "moons" around their nearest linked star. Mutates the graph
  // attributes directly (the applyPositions precedent): while the sim is
  // running its next tick simply overwrites this, and at rest the swirl owns
  // the motion. The worker's copy catches up via syncBack before any reheat.
  private moonHosts: Map<string, string> | null = null;
  private rotAxis = new THREE.Vector3();
  private rotVec = new THREE.Vector3();

  // Nearest linked star for every isolated note — computed lazily once per
  // build (O(orphans × nodes), both small on the vaults this gate allows).
  private computeMoonHosts(): Map<string, string> {
    const hosts = new Map<string, string>();
    const linked: { id: string; x: number; y: number; z: number }[] = [];
    for (const id of this.nodeIds) {
      const a = this.graph.getNodeAttributes(id);
      if (a.deg > 0 && !a.hidden) linked.push({ id, x: a.x, y: a.y, z: a.z });
    }
    if (linked.length === 0) return hosts;
    for (const id of this.nodeIds) {
      const a = this.graph.getNodeAttributes(id);
      // Moons are UNAFFILIATED orphans only. A link-less note that belongs to
      // a folder galaxy must stay in ITS galaxy — capturing it toward the
      // nearest linked star (usually the big neighbouring galaxy) visibly
      // dragged whole link-less folders into the biggest mass.
      if (a.deg > 0 || a.community >= 0) continue;
      let best = linked[0].id;
      let bd = Infinity;
      for (const h of linked) {
        const d =
          (h.x - a.x) * (h.x - a.x) +
          (h.y - a.y) * (h.y - a.y) +
          (h.z - a.z) * (h.z - a.z);
        if (d < bd) {
          bd = d;
          best = h.id;
        }
      }
      hosts.set(id, best);
    }
    return hosts;
  }

  private swirlTick(dt: number): void {
    const cx = new Map<number, number>();
    const cy = new Map<number, number>();
    const cz = new Map<number, number>();
    const cn = new Map<number, number>();
    for (const id of this.nodeIds) {
      const a = this.graph.getNodeAttributes(id);
      // Spin per CLUSTER (community), each about its own seeded disc axis —
      // matching the worker, which now packs every cluster as its own clump
      // and flattens it onto galaxyNormal(community).
      if (a.community < 0) continue;
      cx.set(a.community, (cx.get(a.community) ?? 0) + a.x);
      cy.set(a.community, (cy.get(a.community) ?? 0) + a.y);
      cz.set(a.community, (cz.get(a.community) ?? 0) + a.z);
      cn.set(a.community, (cn.get(a.community) ?? 0) + 1);
    }
    const base = this.settings.folderGalaxies ? SWIRL_SPEED * dt : 0;
    for (const id of this.nodeIds) {
      if (base === 0) break; // galaxy spin off — moons below still run
      const a = this.graph.getNodeAttributes(id);
      const c = a.community;
      if (c < 0) continue;
      const n = cn.get(c)!;
      const nm = galaxyNormal(c); // same seeded axis the worker flattens onto
      const delta = c % 2 === 0 ? base : -base; // alternate spin per galaxy
      this.rotAxis.set(nm.x, nm.y, nm.z);
      this.rotVec
        .set(a.x - cx.get(c)! / n, a.y - cy.get(c)! / n, a.z - cz.get(c)! / n)
        .applyAxisAngle(this.rotAxis, delta);
      a.x = cx.get(c)! / n + this.rotVec.x;
      a.y = cy.get(c)! / n + this.rotVec.y;
      a.z = cz.get(c)! / n + this.rotVec.z;
    }

    // Orphan moons: orbit the nearest linked star on a seeded tilted plane,
    // easing onto a close ring so far-flung orphans get "captured".
    if (!this.moonHosts) this.moonHosts = this.computeMoonHosts();
    for (const [id, hostId] of this.moonHosts) {
      if (!this.graph.hasNode(id) || !this.graph.hasNode(hostId)) continue;
      const a = this.graph.getNodeAttributes(id);
      const h = this.graph.getNodeAttributes(hostId);
      if (a.hidden || h.hidden) continue;
      const tilt = galaxyNormal(Math.floor(seededUnit(id, 61) * 1e6));
      this.rotAxis.set(tilt.x, tilt.y, tilt.z);
      this.rotVec.set(a.x - h.x, a.y - h.y, a.z - h.z);
      const dist = this.rotVec.length() || 1;
      // Capture: ease the orbit radius toward a few host radii.
      const target =
        h.size * NODE_RADIUS * (MOON_RADIUS_MIN + MOON_RADIUS_VAR * seededUnit(id, 62));
      const eased = dist + (target - dist) * Math.min(1, dt * 0.25);
      this.rotVec
        .applyAxisAngle(this.rotAxis, MOON_SPEED * dt)
        .multiplyScalar(eased / dist);
      a.x = h.x + this.rotVec.x;
      a.y = h.y + this.rotVec.y;
      a.z = h.z + this.rotVec.z;
    }
    this.syncPositions();
  }

  /** HUD hook: called when the camera crosses a cosmic-scale band. */
  setScaleListener(cb: (s: CosmicScale) => void): void {
    this.onScale = cb;
  }

  // Per-frame cosmic-scale LOD. Blends the node cloud (near) against galaxy
  // imposters (far) from the camera's distance to what it's looking at, and
  // fades edges / core glow with the nodes so the far view is pure discs.
  // Flying = always fully "near" (you're among the stars).
  private updateLod(dt: number): void {
    if (!this.imposterEnabled) {
      // Imposters off (light skin) — nodes always full, nothing to blend.
      if (this.nodeMat.uniforms.u_lodFade.value !== 1) {
        this.nodeMat.uniforms.u_lodFade.value = 1;
      }
      if (this.imposter.points.visible) this.imposter.points.visible = false;
      return;
    }
    // Galaxy centroids drift slowly — recompute on a cadence, reuse between.
    if (!this.lodCents || (this.imposterTick = (this.imposterTick + 1) % 15) === 0) {
      this.lodCents = this.galaxyCentresById();
    }
    const cents = this.lodCents;
    const vh = Math.max(1, this.container.clientHeight);
    const sc = this.sizeScale(vh);
    // Zoom from the largest galaxy's on-screen size: a galaxy filling the view
    // resolves into stars (zoom 0); when every galaxy is a small dot you're out
    // in the cluster and they read as discs (zoom 1). Flying = always inside.
    // Falls back to framed-distance when there are no galaxy groups.
    let maxFrac = 0;
    for (const c of cents.values()) {
      const d = Math.max(1, this.camera.position.distanceTo(this.tmpVec.set(c.x, c.y, c.z)));
      maxFrac = Math.max(maxFrac, (c.r * 2 * sc) / d / vh);
    }
    const zoom = this.flyMode
      ? 0
      : cents.size > 0
        ? zoomFromScreenSize(maxFrac)
        : zoomLevel(this.camera.position.distanceTo(this.controls.target), this.framedDist);
    // Ease the fade so crossing a threshold never strobes (kills flicker).
    const targetFade = nodeLodAlpha(zoom);
    const cur = this.nodeMat.uniforms.u_lodFade.value as number;
    const nodeFade = cur + (targetFade - cur) * Math.min(1, dt * 6);
    this.nodeMat.uniforms.u_lodFade.value = nodeFade;
    // Fully zoomed in → hide the imposter layer outright so its big sprites
    // don't run fragment shaders (pure overdraw) behind the node cloud.
    const impVisible = nodeFade < 0.985;
    if (this.imposter.points.visible !== impVisible) {
      this.imposter.points.visible = impVisible;
    }
    if (!impVisible) return;
    this.imposter.update(dt);
    if ((this.imposterTick2 = (this.imposterTick2 + 1) % 15) === 0) {
      this.imposter.refresh();
    }
    // Edges + core bulges ride with the nodes so the far view is just discs.
    this.edgeMat.opacity =
      Math.min(1, this.edgeOpacity * this.settings.linkThickness) * nodeFade;
    // Per-galaxy imposter alpha: global zoom × local on-screen-size override.
    this.imposter.setAlphas((cm) => {
      const c = cents.get(cm);
      if (!c) return zoom; // no live centroid — follow global zoom
      const dist = Math.max(1, this.camera.position.distanceTo(this.tmpVec.set(c.x, c.y, c.z)));
      const screenFrac = ((c.r * 2 * sc) / dist) / vh; // galaxy diameter / viewport
      return imposterAlpha(zoom, screenFrac);
    });
    // Scale-band HUD notification (star / system / galaxy / cluster).
    if (this.onScale) {
      const s = cosmicScale(zoom, cents.size > 2);
      if (s !== this.lastScale) {
        this.lastScale = s;
        this.onScale(s);
      }
    }
  }

  // community id → {centroid, RMS radius}. Shared by the LOD blend.
  private galaxyCentresById(): Map<number, { x: number; y: number; z: number; r: number }> {
    const cx = new Map<number, number>();
    const cy = new Map<number, number>();
    const cz = new Map<number, number>();
    const cn = new Map<number, number>();
    for (const id of this.nodeIds) {
      const a = this.graph.getNodeAttributes(id);
      if (a.community < 0 || a.hidden) continue;
      cx.set(a.community, (cx.get(a.community) ?? 0) + a.x);
      cy.set(a.community, (cy.get(a.community) ?? 0) + a.y);
      cz.set(a.community, (cz.get(a.community) ?? 0) + a.z);
      cn.set(a.community, (cn.get(a.community) ?? 0) + 1);
    }
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
    const out = new Map<number, { x: number; y: number; z: number; r: number }>();
    for (const [c, n] of cn) {
      if (n < 3) continue;
      out.set(c, {
        x: cx.get(c)! / n,
        y: cy.get(c)! / n,
        z: cz.get(c)! / n,
        r: Math.sqrt((r2.get(c) ?? 0) / n) || 30,
      });
    }
    return out;
  }

  // Live galaxy centres + rough radii — where cosmic events may open.
  private galaxyCentres(): { x: number; y: number; z: number; r: number }[] {
    return [...this.galaxyCentresById().values()];
  }

  /** Mount a multiverse overlay (e.g. universe bubbles) into the scene. The
   *  caller owns the object's lifecycle (build + dispose); this only parents it
   *  so it renders each frame. Used only in multiverse mode. */
  addOverlay(obj: THREE.Object3D): void {
    this.scene.add(obj);
  }

  // Per-frame hook for overlay layers (the multiverse bubbles breathe with it).
  // Runs only while ambient motion is allowed, so reduced-motion / the ambience
  // toggle quiet the overlays exactly like the scene's own idle life.
  private overlayTick: ((t: number) => void) | null = null;
  setOverlayTick(fn: ((t: number) => void) | null): void {
    this.overlayTick = fn;
  }

  // Seeded deep-sky background (equirect bake) — swapped in async once baked.
  private skyTex: THREE.Texture | null = null;
  setSkyTexture(tex: THREE.Texture | null): void {
    this.skyTex?.dispose();
    this.skyTex = tex;
    if (tex) this.scene.background = tex;
  }

  // ── Galaxy chart minimap ──────────────────────────────────────────────
  // A corner inset rendering the WHOLE graph straight-on from far out, with a
  // marker for the main camera — the fix for "I flew somewhere and now I'm
  // lost". Same scene, second orthographic camera, scissored viewport after
  // the main composite; ambient backdrops (starfield/grid/density quad/meteors)
  // hide during the pass so the chart stays a clean map. Click-to-fly: a click
  // inside the inset retargets the orbit pivot to that world point.
  private minimapOn = false;
  private minimapCam: THREE.OrthographicCamera | null = null;
  private minimapMarker: THREE.Group | null = null;
  private minimapMarkerLine: THREE.Line | null = null;
  private minimapBounds = { cx: 0, cy: 0, cz: 0, r: 1 };
  private minimapBoundsTick = 0;
  private static readonly MINIMAP_MARGIN = 12;

  setMinimap(on: boolean): void {
    this.minimapOn = on;
    if (on && !this.minimapCam) {
      this.minimapCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100000);
      const dot = new THREE.Points(
        new THREE.BufferGeometry().setAttribute(
          "position",
          new THREE.BufferAttribute(new Float32Array(3), 3),
        ),
        new THREE.PointsMaterial({
          color: 0xff5a3d,
          size: 7,
          sizeAttenuation: false,
          depthTest: false,
          depthWrite: false,
        }),
      );
      dot.frustumCulled = false;
      const lineGeom = new THREE.BufferGeometry().setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(6), 3),
      );
      this.minimapMarkerLine = new THREE.Line(
        lineGeom,
        new THREE.LineBasicMaterial({
          color: 0xff5a3d,
          transparent: true,
          opacity: 0.8,
          depthTest: false,
          depthWrite: false,
        }),
      );
      this.minimapMarkerLine.frustumCulled = false;
      this.minimapMarker = new THREE.Group();
      this.minimapMarker.add(dot, this.minimapMarkerLine);
      this.minimapMarker.visible = false; // only during the minimap pass
      this.minimapMarker.renderOrder = 999;
      this.scene.add(this.minimapMarker);
    } else if (!on && this.minimapCam) {
      if (this.minimapMarker) {
        this.scene.remove(this.minimapMarker);
        this.minimapMarker.traverse((o) => {
          const m = o as THREE.Mesh;
          (m.geometry as THREE.BufferGeometry | undefined)?.dispose?.();
          (m.material as THREE.Material | undefined)?.dispose?.();
        });
        this.minimapMarker = null;
        this.minimapMarkerLine = null;
      }
      this.minimapCam = null;
    }
  }

  /** Inset rect in CSS px (top-left origin), or null when hidden/too small. */
  private minimapRect(): { x: number; y: number; size: number } | null {
    if (!this.minimapOn) return null;
    const el = this.renderer.domElement;
    const w = el.clientWidth;
    const h = el.clientHeight;
    const size = Math.min(190, Math.floor(Math.min(w, h) * 0.24));
    if (size < 80) return null; // too cramped to be a useful chart
    const m = GraphScene.MINIMAP_MARGIN;
    return { x: w - size - m, y: h - size - m, size };
  }

  private renderMinimap(): void {
    const rect = this.minimapRect();
    if (!rect || !this.minimapCam || this.nodeIds.length === 0) return;
    // Refresh bounds every ~20 frames (O(n) over the position buffer).
    if (this.minimapBoundsTick-- <= 0) {
      this.minimapBoundsTick = 20;
      const pos = this.nodeGeom.getAttribute("position") as THREE.BufferAttribute;
      let cx = 0;
      let cy = 0;
      let cz = 0;
      const n = this.nodeIds.length;
      for (let i = 0; i < n; i++) {
        cx += pos.getX(i);
        cy += pos.getY(i);
        cz += pos.getZ(i);
      }
      cx /= n;
      cy /= n;
      cz /= n;
      let r2 = 1;
      for (let i = 0; i < n; i++) {
        const dx = pos.getX(i) - cx;
        const dy = pos.getY(i) - cy;
        r2 = Math.max(r2, dx * dx + dy * dy);
      }
      this.minimapBounds = { cx, cy, cz, r: Math.sqrt(r2) };
    }
    const b = this.minimapBounds;
    const half = b.r * 1.15;
    const cam = this.minimapCam;
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.position.set(b.cx, b.cy, b.cz + b.r * 3 + 100);
    cam.near = 0.1;
    cam.far = b.r * 8 + 1000;
    cam.lookAt(b.cx, b.cy, b.cz);
    cam.updateProjectionMatrix();
    // Camera marker: where the pilot is, and which way they face.
    if (this.minimapMarker && this.minimapMarkerLine) {
      this.minimapMarker.visible = true;
      this.minimapMarker.position.copy(this.camera.position);
      const dir = this.camera.getWorldDirection(this.tmpVec);
      const lp = this.minimapMarkerLine.geometry.getAttribute(
        "position",
      ) as THREE.BufferAttribute;
      lp.setXYZ(0, 0, 0, 0);
      lp.setXYZ(1, dir.x * b.r * 0.22, dir.y * b.r * 0.22, dir.z * b.r * 0.22);
      lp.needsUpdate = true;
    }
    // Backdrops off — the chart is nodes/edges/bubbles only.
    const sf = this.starfield.visible;
    const gb = this.gridBackdrop?.visible ?? false;
    const dq = this.edgeDensity?.quad.visible ?? false;
    const mt = this.meteor.lines.visible;
    this.starfield.visible = false;
    if (this.gridBackdrop) this.gridBackdrop.visible = false;
    if (this.edgeDensity) this.edgeDensity.quad.visible = false;
    this.meteor.lines.visible = false;

    const r = this.renderer;
    const el = r.domElement;
    const h = el.clientHeight;
    // GL viewport origin is bottom-left.
    const vx = rect.x;
    const vy = h - rect.y - rect.size;
    const prevAuto = r.autoClear;
    r.autoClear = false;
    r.setScissorTest(true);
    r.setViewport(vx, vy, rect.size, rect.size);
    r.setScissor(vx, vy, rect.size, rect.size);
    const bg = this.scene.background;
    r.setClearColor(this.darkTheme ? 0x05070f : 0xf2f3f7, 1);
    this.scene.background = null;
    r.clear(true, true, false);
    r.render(this.scene, cam);
    this.scene.background = bg;
    r.setScissorTest(false);
    r.setViewport(0, 0, el.clientWidth, h);
    r.autoClear = prevAuto;

    if (this.minimapMarker) this.minimapMarker.visible = false;
    this.starfield.visible = sf;
    if (this.gridBackdrop) this.gridBackdrop.visible = gb;
    if (this.edgeDensity) this.edgeDensity.quad.visible = dq;
    this.meteor.lines.visible = mt;
  }

  /** If the pointer is inside the minimap, retarget the orbit pivot to the
   * clicked world point (click-to-fly) and swallow the event. */
  private minimapClick(e: PointerEvent): boolean {
    const rect = this.minimapRect();
    if (!rect) return false;
    const el = this.renderer.domElement;
    const bounds = el.getBoundingClientRect();
    const px = e.clientX - bounds.left;
    const py = e.clientY - bounds.top;
    if (px < rect.x || px > rect.x + rect.size || py < rect.y || py > rect.y + rect.size) {
      return false;
    }
    const b = this.minimapBounds;
    const half = b.r * 1.15;
    const u = (px - rect.x) / rect.size;
    const v = (py - rect.y) / rect.size;
    const to = new THREE.Vector3(
      b.cx + (u - 0.5) * 2 * half,
      b.cy + (0.5 - v) * 2 * half,
      b.cz,
    );
    this.targetTween = {
      t: 0,
      dur: 0.85,
      from: this.controls.target.clone(),
      to,
    };
    return true;
  }

  /** FXAA + cinematic grade, appended after OutputPass on whichever composer
   * chain this scene built. Toggled live via settings.cinematic. */
  private attachFinishing(composer: EffectComposer, w: number, h: number, pr: number): void {
    this.fxaaPass = new ShaderPass(FXAAShader);
    (this.fxaaPass.material.uniforms.resolution.value as THREE.Vector2).set(
      1 / Math.max(1, w * pr),
      1 / Math.max(1, h * pr),
    );
    composer.addPass(this.fxaaPass);
    this.cinePass = new ShaderPass(
      new THREE.ShaderMaterial({
        uniforms: {
          tDiffuse: { value: null },
          u_time: { value: 0 },
          u_vig: { value: 0.26 },
          u_grain: { value: 0.045 },
          u_ca: { value: 0.0012 },
        },
        vertexShader: MIX_VERT,
        fragmentShader: CINE_FRAG,
      }),
      "tDiffuse",
    );
    composer.addPass(this.cinePass);
    const on = this.settings.cinematic;
    this.fxaaPass.enabled = on;
    this.cinePass.enabled = on;
  }

  // Edge-density field (cosmic-web skin): edges splat into an offscreen HDR
  // accumulator and composite through a density ramp; the plain edge lines hide
  // while it runs (hover/path feedback lives on the filament overlay).
  private edgeDensity: EdgeDensityLayer | null = null;
  private ensureEdgeDensity(on: boolean): void {
    if (on && !this.edgeDensity) {
      const el = this.renderer.domElement;
      this.edgeDensity = new EdgeDensityLayer(
        this.edgeGeom,
        el.clientWidth || 2,
        el.clientHeight || 2,
        this.renderer.getPixelRatio(),
      );
      this.scene.add(this.edgeDensity.quad);
    } else if (!on && this.edgeDensity) {
      this.scene.remove(this.edgeDensity.quad);
      this.edgeDensity.dispose();
      this.edgeDensity = null;
    }
    this.edges.visible = !on;
  }

  /** Live camera world position (clone) — the multiverse uses it to detect when
   *  the user has dollied INTO a universe bubble (zoom-to-enter). */
  getCameraPosition(): THREE.Vector3 {
    return this.camera.position.clone();
  }

  /** The orbit pivot. Symmetric with getCameraPosition; used by the dev harness
   *  to observe the eased retarget. */
  getOrbitTarget(): THREE.Vector3 {
    return this.controls.target.clone();
  }

  /** Re-aim the orbit pivot (multiverse: point it at the bubble the user is
   *  zooming toward so a dolly-in pulls the camera INTO that universe). */
  /** Ease the orbit pivot to `v` over ~220 ms (only the target moves; the wheel
   *  dolly keeps driving the camera). A hard copy() here made the view snap —
   *  measured up to ~21° in one frame when the nearest bubble flipped as the
   *  user scrolled in. Reduced motion still snaps. */
  setOrbitTarget(v: THREE.Vector3): void {
    if (this.reducedMotion) {
      this.controls.target.copy(v);
      this.targetTween = null;
      return;
    }
    // Already there (or heading there) — don't restart the ease every wheel tick.
    if (this.controls.target.distanceToSquared(v) < 1) return;
    this.targetTween = {
      t: 0,
      dur: 0.22,
      from: this.controls.target.clone(),
      to: v.clone(),
    };
  }

  private targetTween: {
    t: number;
    dur: number;
    from: THREE.Vector3;
    to: THREE.Vector3;
  } | null = null;

  private targetTweenTick(dt: number): void {
    const tw = this.targetTween;
    if (!tw) return;
    tw.t = Math.min(tw.dur, tw.t + dt);
    const u = tw.t / tw.dur;
    const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2; // easeInOutCubic
    this.controls.target.lerpVectors(tw.from, tw.to, e);
    this.controls.update();
    if (tw.t >= tw.dur) this.targetTween = null;
  }

  /** Current node positions (nodeIds order) — the worker syncBack payload. */
  snapshotPositions(): Float32Array {
    const out = new Float32Array(this.nodeIds.length * 3);
    for (let i = 0; i < this.nodeIds.length; i++) {
      const a = this.graph.getNodeAttributes(this.nodeIds[i]);
      const o = i * 3;
      out[o] = a.x;
      out[o + 1] = a.y;
      out[o + 2] = a.z;
    }
    return out;
  }

  syncPositions(): void {
    this.writePositions();
    if (this.filaments) this.updateFilaments();
    // Arrows animate per-frame in the render loop (not per sim tick).
    // Galaxies drift while the sim runs; refresh the gas + cluster-label
    // centroids every 12th tick (the recompute is O(nodes) but visually
    // stable, so per-frame is waste).
    if ((this.nebulaTick = (this.nebulaTick + 1) % 12) === 0) {
      this.nebula.update();
      this.clusterLabels.update();
    }
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

    this.writeEdgeGeometry();

    if (this.filaments) this.updateFilaments();
    // Arrows animate per-frame in the render loop (not per sim tick).
    if ((this.nebulaTick = (this.nebulaTick + 1) % 12) === 0) {
      this.nebula.update();
      this.clusterLabels.update();
    }
  }

  // Full attribute refresh (colour/size/alpha/intensity + edge colour). Call when
  // those actually change but no React style push happens — e.g. timelapse
  // reveal/hide toggling node `hidden`. The per-tick path never touches them.
  refreshStyle(): void {
    this.writeNodes();
    this.writeEdges();
    // timelapse `hidden` flips affect which cluster labels are alive
    this.clusterLabels.update();
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
    this.nodeGeom.setAttribute("a_kind", new THREE.BufferAttribute(new Float32Array(n), 1));
    this.nodeGeom.setAttribute("a_age", new THREE.BufferAttribute(new Float32Array(n).fill(9999), 1));
    this.nodeGeom.setAttribute("a_hit", new THREE.BufferAttribute(new Float32Array(n), 1));
    this.nodeGeom.setAttribute("a_spawn", new THREE.BufferAttribute(new Float32Array(n), 1));
    this.points.geometry = this.nodeGeom;
    oldNodeGeom.dispose();
    this.writeSpawnDelays();

    this.edgePairs = this.graph.mapEdges(
      (_e, _a, s, t) => [s, t] as [string, string],
    );
    this.buildEdgeIndex();
    const oldEdgeGeom = this.edgeGeom;
    this.edgeGeom = new THREE.BufferGeometry();
    this.edgeGeom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.edgePairs.length * 12), 3));
    this.edgeGeom.setAttribute("color", new THREE.BufferAttribute(new Float32Array(this.edgePairs.length * 12), 3));
    this.edges.geometry = this.edgeGeom;
    this.edgeDensity?.setGeometry(this.edgeGeom);
    oldEdgeGeom.dispose();

    // Filaments: drop the old focus/path layer and rebuild over the new edge
    // set (edgeKey / edgePairs indices changed).
    if (this.filaments) {
      this.scene.remove(this.filaments);
      this.filamentGeom?.dispose();
      this.filamentMat?.dispose();
      this.filaments = null;
      this.filamentGeom = null;
      this.filamentMat = null;
    }
    this.buildFilaments();

    // Arrows: instance count is fixed at allocation, so rebuild for the new
    // edge count (reusing the shared cone geometry + material).
    const oldArrows = this.arrows;
    this.scene.remove(oldArrows);
    oldArrows.dispose();
    const arrowCount2 = Math.max(1, this.edgePairs.length);
    this.arrows = new THREE.InstancedMesh(this.arrowGeom, this.arrowMat, arrowCount2);
    this.arrows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.arrows.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(arrowCount2 * 3).fill(1),
      3,
    );
    this.arrows.frustumCulled = false;
    this.arrows.visible = this.settings.arrows;
    this.scene.add(this.arrows);
    this.initArrowMotion();
    this.writeArrowColors();

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
    // Trace: the node set changed under it — clear; React re-pushes if still valid.
    this.tracePulse.setPath(null);
    // Dust: re-seed for the new node set.
    this.dust.seed(this.nodeIds);
    // Cluster labels: communities may have grown/changed after live ingest.
    this.clusterLabels.rebuild();
    // Re-derive the label allow-set so live-ingest newcomers / new hubs can label.
    this.computeLabelable();
    // Node set changed — orphan moons re-pick their hosts lazily, and the
    // core bulges re-derive their groups.
    this.moonHosts = null;
    this.coreGlow.setNodeIds(this.nodeIds);
    this.band.setNodeIds(this.nodeIds);
    this.imposter.setNodeIds(this.nodeIds);
    this.planets.setNodeIds(this.nodeIds); // refresh per-node planet identity cache
    if (this.atlasMode) this.hulls.rebuild();
    // Graph contents changed (live ingest / filter) → re-aggregate strands.
    this.bundles.markTopologyDirty();
    if (this.settings.edgeBundles) this.bundles.rebuild();

    this.writeNodes();
    this.writeEdges();
    this.initArrowMotion();
    this.writeArrowColors();
  }

  applyTheme(theme: GraphTheme): void {
    this.theme = theme;
    const bg = parseRGBA(theme.bg).color;
    const dark = bg.getHSL({ h: 0, s: 0, l: 0 }).l < 0.5;
    this.darkTheme = dark;
    const sceneBg = theme.sceneBg
      ? new THREE.Color(theme.sceneBg)
      : dark
        ? new THREE.Color(0x05060d)
        : bg;
    this.scene.background = this.skyTex ?? sceneBg;
    (this.scene.fog as THREE.FogExp2).color.copy(sceneBg);
    // Starfield shells are colour-baked per dark/light at build time, and the
    // active skin decides whether they show at all — rebuild them so a theme or
    // skin change (this method is called for both) lands live.
    const amb = skinAmbience(this.settings.skin, dark);
    this.scene.remove(this.starfield);
    for (const child of this.starfield.children) {
      const p = child as THREE.Points;
      (p.geometry as THREE.BufferGeometry).dispose();
      (p.material as THREE.Material).dispose();
    }
    this.starfield = this.buildStarfield(dark);
    this.starfield.visible = SHOW_STARFIELD && amb.starfield;
    this.scene.add(this.starfield);
    this.ensureGridBackdrop(this.settings.skyStyle === "grid", dark);
    // Must mirror the constructor's calm calibration (duplicated constants —
    // keep in sync; Phase 1 extracts a single helper).
    this.baseBloom = dark ? 0.45 : 0.25;
    this.bloom.strength = this.baseBloom; // brightness drives exposure, not bloom
    this.bloom.threshold = dark ? 1.9 : 1.05; // light: above the LDR bg (see ctor)
    this.bloom.radius = 0.7;
    this.nodeMat.blending =
      dark && !this.sigmaSkin ? THREE.AdditiveBlending : THREE.NormalBlending;
    this.nodeMat.uniforms.u_darkTheme.value = dark ? 1 : 0;
    this.nodeMat.uniforms.u_flat.value = this.sigmaSkin ? 1 : 0;
    this.nodeMat.uniforms.u_saturate.value = this.sigmaSkin ? 1.45 : 1;
    // "auto" mono ink follows the background (white starlight ↔ dark ink).
    (this.nodeMat.uniforms.u_monoColor.value as THREE.Color).copy(
      monoColorFor(this.settings, dark),
    );
    this.nodeMat.needsUpdate = true;
    this.edgeMat.blending =
      dark && !this.sigmaSkin ? THREE.AdditiveBlending : THREE.NormalBlending;
    this.edgeMat.needsUpdate = true;
    this.pulse.setDark(dark);
    this.tracePulse.setDark(dark);
    this.dust.setDark(dark);
    this.wave.setDark(dark);
    this.nova.setDark(dark);
    this.synapse.setDark(dark);
    this.ship.setDark(dark);
    this.hulls.setDark(dark);
    this.bundles.setDark(dark);
    this.meteor.lines.visible = amb.meteors && !this.perfLod && !this.flatLayout;
    // Painted galaxy adornments stay off across theme changes (see ctor).
    this.coreGlow.setEnabled(false);
    this.band.points.visible = false;
    this.imposterEnabled = false;
    this.updatePlanetGate(); // skin/theme flip may enable/disable planets
    this.nebula.setDark(SHOW_NEBULA && amb.nebula && !this.flatLayout);
    // Light theme legibility (edges pulled to dark slate + higher opacity/base).
    this.edgeNeutral = this.webSkin
      ? EDGE_NEUTRAL_WEB
      : dark
        ? EDGE_NEUTRAL_DARK
        : EDGE_NEUTRAL_LIGHT;
    this.edgeOpacity = this.webSkin
      ? EDGE_OPACITY_WEB
      : this.sigmaSkin
        ? EDGE_OPACITY_SIGMA
        : dark
          ? EDGE_OPACITY_DARK
          : EDGE_OPACITY_LIGHT;
    this.edgeBaseBrightness = this.webSkin
      ? EDGE_BASE_WEB
      : this.sigmaSkin
        ? EDGE_BASE_SIGMA
        : dark
          ? EDGE_BASE_DARK
          : EDGE_BASE_LIGHT;
    this.edgeMat.opacity = Math.min(1, this.edgeOpacity * this.settings.linkThickness);
    // Web skin shrinks stars to points (a skin switch must land live, and the
    // resize handler owns this uniform otherwise — same formula, same source).
    this.nodeMat.uniforms.u_sizeScale.value =
      this.sizeScale(this.renderer.domElement.clientHeight || 1) * this.skinNodeScale();
    // Density-field edges follow the skin (created/torn down live).
    this.ensureEdgeDensity(this.webSkin);
    // Arrows are tinted per-instance by source-node colour; only the no-colour
    // fallback tracks the theme. writeArrowColors() below repaints them.
    this.arrowFallback = parseRGBA(theme.edgeHi).color;
    for (const obj of this.labels.values()) {
      (obj.element as HTMLElement).style.color = theme.ink;
    }
    this.writeNodes();
    this.writeEdges();
    this.writeArrowColors();
  }

  /** Start (or clear with null) an interactive trace along an ordered node
   * sequence. The static path is lit by the filament layer via pushStyle; this
   * drives the moving comet accent. */
  setTrace(path: string[] | null): void {
    this.tracePulse.setPath(path);
  }

  /** Selection impulse: detonate a supernova at the node and ripple a neural
   * activation wave outward through its BFS rings. An explicit interaction
   * accent (like the trace comet), so it runs regardless of the ambient-motion
   * toggle — but honours the OS reduced-motion preference. */
  impulse(id: string): void {
    if (this.reducedMotion || !this.settings.clickBurst || !this.graph.hasNode(id)) return;
    const a = this.graph.getNodeAttributes(id);
    this.nova.trigger(a.x, a.y, a.z, a.size, a.color);
    this.wave.setPlan(planWave((n) => this.graph.neighbors(n), id));
  }

  /** Detonate the selection supernova at a node WITHOUT the activation wave —
   * the timelapse finale on the last-revealed star. Honours the OS
   * reduced-motion preference like impulse(). */
  supernovaAt(id: string): void {
    if (this.reducedMotion || !this.graph.hasNode(id)) return;
    const a = this.graph.getNodeAttributes(id);
    this.nova.trigger(a.x, a.y, a.z, a.size, a.color);
  }

  /** On-demand cosmic event (black hole / wormhole) at an explicit world
   * position — bypasses the idle scheduler's random timer. Same gates as the
   * scheduled path (dark theme, ambient motion on, not perf mode); a running
   * event wins and the call is dropped. */
  cosmicEventAt(kind: EventKind, worldPos: { x: number; y: number; z: number }): void {
    if (!this.darkTheme || this.perfLod || !this.ambientOn()) return;
    this.cosmic.triggerAt(kind, worldPos);
  }

  // One idle synapse firing: a degree-weighted random node ripples a small dim
  // wave (1–2 hops). Deterministic (starRand over a counter) so idle activity
  // replays identically. Skipped while a previous ripple is still running.
  private fireSynapse(): void {
    // Synapse LAYOUT is an explicit "living nervous system" — fire far more
    // often (a fraction of the idle cadence) so signals are always travelling
    // the nerve fibres; otherwise keep the rare ambient rhythm.
    const delay = synapseDelay(GraphScene.starRand(1000 + this.synapseCount * 3));
    this.synapseTimer = this.synapseRender ? delay * 0.25 : delay;
    const rand = GraphScene.starRand(2000 + this.synapseCount * 7);
    this.synapseCount++;
    if (this.synapse.isActive()) return;
    const id = pickByDegree(
      this.nodeIds,
      (n) => this.graph.getNodeAttribute(n, "deg") ?? 0,
      rand,
    );
    if (!id || this.graph.getNodeAttribute(id, "hidden")) return;
    this.synapse.setPlan(
      planWave((n) => this.graph.neighbors(n), id, {
        maxDepth: SYNAPSE_MAX_DEPTH,
        maxNodes: SYNAPSE_MAX_NODES,
        maxEdges: SYNAPSE_MAX_EDGES,
      }),
      SYNAPSE_INTENSITY,
    );
  }

  /** Enter/leave immersive spaceship mode. ON: the ShipController takes the
   * camera (third-person chase, WASD/mouse steer), OrbitControls + idle rotation
   * pause, and dust motes appear. OFF: release the ship, restore OrbitControls at
   * the current camera position, hide dust. */
  setFlyMode(on: boolean): void {
    if (on === this.flyMode) return;
    this.flyMode = on;
    if (on) {
      this.controls.enabled = false;
      this.controls.autoRotate = false;
      this.ship.enable();
      this.dust.setVisible(true);
    } else {
      this.ship.disable();
      this.dust.setVisible(false);
      // Re-seat OrbitControls: pivot a sensible distance ahead of the camera's
      // current heading so orbiting resumes around what the pilot was facing.
      const fwd = this.tmpVec.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
      this.controls.target.copy(this.camera.position).addScaledVector(fwd, 300);
      this.camera.up.set(0, 1, 0);
      this.controls.enabled = true;
      this.controls.autoRotate = this.autoRotateWanted();
      this.controls.update();
    }
  }

  isFlying(): boolean {
    return this.flyMode;
  }

  /** Current ship speed (world units/s) for the fly-mode HUD readout. */
  shipSpeed(): number {
    return this.ship.getSpeed();
  }

  applySettings(settings: GraphSettings): void {
    this.settings = settings;
    // Node-colour mode (community / white / auto-by-count) — live, no rebuild.
    this.nodeMat.uniforms.u_mono.value = monoFor(settings, this.nodeIds.length);
    (this.nodeMat.uniforms.u_monoColor.value as THREE.Color).copy(
      monoColorFor(settings, this.darkTheme),
    );
    this.nodeMat.uniforms.u_colorDepth.value = settings.nodeColorDepth;
    this.nodeMat.uniforms.u_recency.value = settings.recencyGlow ? 1 : 0;
    this.nodeMat.uniforms.u_flare.value = settings.cinematic ? 1 : 0;
    if (this.fxaaPass) this.fxaaPass.enabled = settings.cinematic;
    if (this.cinePass) this.cinePass.enabled = settings.cinematic;
    this.setMinimap(settings.minimap);
    this.cosmic.setFrequency(settings.cosmicFrequency);
    // Sky style flip (star density / dotted grid / void) — rebuild the field.
    if (settings.skyStyle !== this.appliedSkyStyle) {
      this.appliedSkyStyle = settings.skyStyle;
      this.scene.remove(this.starfield);
      for (const child of this.starfield.children) {
        const p = child as THREE.Points;
        (p.geometry as THREE.BufferGeometry).dispose();
        (p.material as THREE.Material).dispose();
      }
      this.starfield = this.buildStarfield(this.darkTheme);
      const showSky = SHOW_STARFIELD && skinAmbience(settings.skin, this.darkTheme).starfield;
      this.starfield.visible = showSky;
      this.scene.add(this.starfield);
      this.ensureGridBackdrop(settings.skyStyle === "grid", this.darkTheme);
    }
    // Edge tint mode flip (grey connective tissue ↔ community-hue webs)
    // rewrites the endpoint-colour cache — O(edges), only on actual change.
    if (settings.edgeTint !== this.appliedEdgeTint) {
      this.appliedEdgeTint = settings.edgeTint;
      this.writeEdges();
    }
    this.edgeMat.opacity = Math.min(1, this.edgeOpacity * settings.linkThickness);
    // Brightness: overall exposure + bloom glow intensity.
    // Brightness drives overall EXPOSURE only (applied by OutputPass at the end).
    // Bloom strength stays fixed so raising brightness lifts the whole image
    // without ballooning the core glow back into a white wash.
    this.renderer.toneMappingExposure = settings.brightness;
    this.bloom.strength = this.baseBloom;
    // Direction arrows: toggle the flying-arrow fleet + repaint source colours.
    this.arrows.visible = settings.arrows;
    if (settings.arrows) this.writeArrowColors();
    // Ambient motion (one switch for auto-rotate / pulses / breathing). The
    // pulse layer is hidden rather than disposed so re-enabling is instant.
    // Arrows ON hides the round pulses — the flying arrows ARE the signals now.
    this.controls.autoRotate = this.autoRotateWanted();
    this.pulse.points.visible =
      this.ambientOn() && !this.perfLod && !settings.arrows;
    this.updatePlanetGate(); // nearFieldPlanets toggle (also re-checks perf/skin/layout)
    if (this.rotateResumeTimer != null && !this.ambientOn()) {
      clearTimeout(this.rotateResumeTimer);
      this.rotateResumeTimer = null;
    }
    // Bundled strands toggle — rebuild on enable so the arcs match the current
    // (possibly swirled) layout instead of a stale snapshot.
    if (settings.edgeBundles !== this.bundles.group.visible) {
      this.bundles.setVisible(settings.edgeBundles);
      if (settings.edgeBundles) this.bundles.rebuild();
    }
    // Length-falloff thresholds scale with linkDistance — re-derive so a slider
    // move updates edge brightness even before the sim posts its next tick.
    this.writeEdgeGeometry();
  }

  /** Layout-at-rest hook (worker settle / atlas apply / timelapse end): refresh
   * the settle-cadence decorations — bundled strands follow the final centroids. */
  layoutSettled(): void {
    if (this.settings.edgeBundles) this.bundles.rebuild();
  }

  /** Cinematic orbit for timelapse replays: a slow-but-visible sweep so the
   * assembling galaxy is seen from a moving camera (recordings read as a
   * produced shot, not a locked-off screencap). Restores the ambient policy
   * (and its slow idle speed) when the replay ends. */
  setCinematicOrbit(on: boolean): void {
    this.controls.autoRotateSpeed = on ? 0.9 : 0.12;
    this.controls.autoRotate = on ? !this.reducedMotion : this.ambientOn();
  }

  /**
   * Show/hide the community names that surface while zoomed out.
   *
   * They are right for a single vault — pull back and the clusters name
   * themselves — but wrong one tier up: the multiverse draws its own universe
   * names, and a cluster topic from inside a bubble competes with the name of
   * the bubble itself.
   */
  setClusterLabelsVisible(on: boolean): void {
    this.clusterLabels.setEnabled(on);
  }

  /** The WebGL canvas — used by the timelapse recorder (captureStream). */
  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  // All idle motion (auto-rotate, pulses, breathing) honours BOTH the OS
  // reduced-motion preference and the user's "Ambient motion" toggle.
  private ambientOn(): boolean {
    return !this.reducedMotion && this.settings.ambientMotion;
  }

  // Auto-rotate wants ambient motion AND a 3D layout — a flat 2D map must not
  // spin, but its other ambient life (synapse firing, pulses) stays on.
  private autoRotateWanted(): boolean {
    return this.ambientOn() && !this.flatLayout;
  }

  /** Gap panel: dashed hint lines between semantically-close but unlinked
   * community pairs. Pass [] to hide. Community centroids drift with the sim,
   * so the render loop refreshes the segment ends on a slow tick. */
  setBridgeHints(pairs: [number, number][]): void {
    this.bridgePairs = this.flatLayout ? [] : pairs;
    this.refreshBridgeLines();
  }

  private refreshBridgeLines(): void {
    const on = this.bridgePairs.length > 0;
    this.bridgeLines.visible = on;
    if (!on) return;
    const cents = this.galaxyCentresById();
    const pts: THREE.Vector3[] = [];
    for (const [a, b] of this.bridgePairs) {
      const ca = cents.get(a);
      const cb = cents.get(b);
      if (!ca || !cb) continue;
      pts.push(new THREE.Vector3(ca.x, ca.y, ca.z), new THREE.Vector3(cb.x, cb.y, cb.z));
    }
    this.bridgeLines.geometry.dispose();
    this.bridgeLines.geometry = new THREE.BufferGeometry().setFromPoints(pts);
    this.bridgeLines.computeLineDistances();
    this.bridgeLines.visible = pts.length > 0;
  }

  // Near-field planets show on DARK 3D layouts only: lit spheres assume a dark
  // void (wrong on the white/paper skin), and 3D bodies make no sense in the
  // top-down 2D atlas/synapse map. Also gated by the user toggle and the
  // perf-LOD cap. They still RENDER under reduced-motion (structure, not
  // ambience) — only their spin freezes (see PlanetLayer.update()).
  private updatePlanetGate(): void {
    // The web skin keeps nodes as bare points — resolving the nearest ones
    // into full-colour planet spheres would break its monochrome density read.
    this.planetsEnabled =
      this.settings.nearFieldPlanets &&
      this.darkTheme &&
      !this.perfLod &&
      !this.flatLayout &&
      !this.webSkin &&
      !this.sigmaSkin;
    this.planets.setEnabled(this.planetsEnabled);
  }

  // Auto-rotate pauses the moment the user orbits/zooms and resumes only after
  // a quiet ROTATE_IDLE_MS — idle ambience must never fight the hand (spec A7).
  private onControlsStart = (): void => {
    if (this.rotateResumeTimer != null) {
      clearTimeout(this.rotateResumeTimer);
      this.rotateResumeTimer = null;
    }
    this.camTween = null; // the hand always wins over an in-flight camera move
    this.controls.autoRotate = false;
    this.beginInteraction();
  };
  private onControlsEnd = (): void => {
    if (this.rotateResumeTimer != null) clearTimeout(this.rotateResumeTimer);
    this.rotateResumeTimer = setTimeout(() => {
      this.rotateResumeTimer = null;
      this.controls.autoRotate = this.autoRotateWanted();
    }, ROTATE_IDLE_MS);
    this.endInteraction();
  };

  // --- Interaction LOD (spec B6). Enter immediately (a gesture just started);
  // leave after a short debounce so a continuous orbit doesn't strobe the
  // overlays back on between frames. ---
  private beginInteraction(): void {
    if (this.lodRestoreTimer != null) {
      clearTimeout(this.lodRestoreTimer);
      this.lodRestoreTimer = null;
    }
    if (this.interacting) return;
    this.interacting = true;
    // Pulses + arrows are objects — hide them outright. Labels are gated inside
    // updateLabels (it skips its work while interacting). Thin edges stay up.
    this.pulse.points.visible = false;
    this.arrows.visible = false;
    this.clusterLabels.group.visible = false;
  }
  private endInteraction(): void {
    if (this.lodRestoreTimer != null) clearTimeout(this.lodRestoreTimer);
    this.lodRestoreTimer = setTimeout(() => {
      this.lodRestoreTimer = null;
      this.interacting = false;
      // Restore to each layer's real state (perf mode / ambient toggle / arrows
      // setting), not blindly to visible.
      this.pulse.points.visible =
        this.ambientOn() && !this.perfLod && !this.settings.arrows;
      this.arrows.visible = this.settings.arrows;
      this.clusterLabels.group.visible = true;
    }, LOD_RESTORE_MS);
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

  fit(m?: LayoutMetrics, animateMs = 0): void {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    let r = 1;
    if (m && m.n > 0) {
      // Worker-measured settled extent (backlog A1) — same centroid + 95th-
      // percentile rule, computed once off-thread instead of re-scanned here.
      cx = m.cx;
      cy = m.cy;
      cz = m.cz;
      r = Math.max(1, m.radius);
    } else {
      // Bounding sphere of the (visible) nodes → frame the cluster.
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
      // 95th-percentile radius, NOT the max: a few far outliers (a drifted
      // orphan, a stray ghost) would otherwise blow up the frame and shrink the
      // whole graph to a speck in the middle of the canvas.
      const dists: number[] = [];
      for (const id of this.nodeIds) {
        const a = this.graph.getNodeAttributes(id);
        if (a.hidden) continue;
        dists.push(Math.hypot(a.x - cx, a.y - cy, a.z - cz));
      }
      dists.sort((p, q) => p - q);
      r = Math.max(1, dists[Math.floor((dists.length - 1) * 0.95)] ?? 1);
    }
    const toTarget = new THREE.Vector3(cx, cy, cz);
    const fovRad = (this.camera.fov * Math.PI) / 180;
    const dist = (r * 1.5) / Math.tan(fovRad / 2) + 60;
    this.framedDist = dist; // zoom reference for semantic-zoom label budget
    // Dynamic depth cues (calm-cosmic-web spec A4): fixed fog constants are a
    // no-op on a big vault and fog out a small one. Deriving them from the
    // framed distance keeps the near/far RATIO stable at any vault size — the
    // back of the graph always sits in haze, the front always reads crisp.
    this.nodeMat.uniforms.u_fogNear.value = 0.35 * dist;
    this.nodeMat.uniforms.u_fogFar.value = 1.7 * dist;
    // Flat layouts: a 2D map has no depth to haze, and distance fog on a
    // top-down view just greys the edges — push fog far away (≈off).
    (this.scene.fog as THREE.FogExp2).density = this.flatLayout ? 0.02 / dist : 0.55 / dist;
    const dir = this.tmpVec.copy(this.camera.position).sub(toTarget);
    if (this.flatLayout) {
      // Straight-on top-down: the map is the flat 2D plane it was laid out on.
      dir.set(0, 0, 1);
    } else if (dir.lengthSq() < 1) {
      dir.set(0.3, 0.15, 1);
    }
    dir.setLength(THREE.MathUtils.clamp(dist, this.controls.minDistance, this.controls.maxDistance));
    const toPos = toTarget.clone().add(dir);
    if (animateMs > 0) {
      // Cinematic arrival (first settle): ease from wherever the camera is
      // onto the framed pose instead of snapping — the load ends with a
      // camera FLIGHT into the settled galaxy. startCamTween handles
      // reduced-motion by snapping.
      this.startCamTween(toPos, toTarget, animateMs);
    } else {
      this.controls.target.copy(toTarget);
      this.camera.position.copy(toPos);
      this.controls.update();
    }
  }

  // Frame the camera on a single node — used by the inspector / search-to-focus
  // to fly to a star. Like fit() but centred on one node at a close distance.
  focusNode(id: string): void {
    if (!this.graph.hasNode(id)) return;
    const a = this.graph.getNodeAttributes(id);
    const toTarget = new THREE.Vector3(a.x, a.y, a.z);
    const fovRad = (this.camera.fov * Math.PI) / 180;
    const r = Math.max(a.size * NODE_RADIUS * 4, 60);
    const dist = (r * 1.5) / Math.tan(fovRad / 2) + 40;
    const dir = this.tmpVec.copy(this.camera.position).sub(toTarget);
    if (dir.lengthSq() < 1) dir.set(0.3, 0.15, 1);
    dir.setLength(
      THREE.MathUtils.clamp(dist, this.controls.minDistance, this.controls.maxDistance),
    );
    // Fly, don't teleport: search-to-focus / inspector jumps ease the camera
    // to the star (the product's own "fly to a star" story). Reduced motion
    // (or an in-progress user gesture) snaps instead.
    this.startCamTween(toTarget.clone().add(dir), toTarget, 750);
  }

  // --- eased camera flight (focusNode / future cinematic moves) -------------
  private camTween: {
    t: number;
    dur: number;
    p0: THREE.Vector3;
    p1: THREE.Vector3;
    a0: THREE.Vector3;
    a1: THREE.Vector3;
    onDone?: () => void;
  } | null = null;

  private startCamTween(
    toPos: THREE.Vector3,
    toTarget: THREE.Vector3,
    durMs: number,
    onDone?: () => void,
  ): void {
    if (this.reducedMotion || durMs <= 0) {
      this.controls.target.copy(toTarget);
      this.camera.position.copy(toPos);
      this.controls.update();
      onDone?.();
      return;
    }
    this.camTween = {
      t: 0,
      dur: durMs / 1000,
      p0: this.camera.position.clone(),
      p1: toPos,
      a0: this.controls.target.clone(),
      a1: toTarget,
      onDone,
    };
  }

  /** Fly the camera INTO a universe bubble (multiverse mode) — a dolly toward
   *  the bubble that ends among its stars — then invoke `onArrive` (the caller
   *  switches the active vault there). Reduced motion snaps + arrives at once. */
  flyInto(centre: THREE.Vector3, radius: number, onArrive: () => void): void {
    const dir = this.tmpVec.copy(this.camera.position).sub(centre);
    if (dir.lengthSq() < 1) dir.set(0.3, 0.15, 1);
    // End just inside the membrane, looking at the bubble's core, so we arrive
    // amid the project's stars right as the vault switches.
    dir.setLength(Math.max(40, radius * 0.85));
    this.startCamTween(centre.clone().add(dir), centre.clone(), 950, onArrive);
  }

  /** Advance the camera flight; a user gesture cancels it (onControlsStart). */
  private camTweenTick(dt: number): void {
    const tw = this.camTween;
    if (!tw) return;
    tw.t = Math.min(tw.dur, tw.t + dt);
    const u = tw.t / tw.dur;
    // easeInOutCubic — gentle launch, gentle arrival.
    const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
    this.controls.target.lerpVectors(tw.a0, tw.a1, e);
    this.camera.position.lerpVectors(tw.p0, tw.p1, e);
    this.controls.update();
    if (tw.t >= tw.dur) {
      const done = tw.onDone;
      this.camTween = null;
      done?.(); // fire arrival AFTER clearing, so a re-entrant tween is allowed
    }
  }

  // One frame of the post-processing graph. Selective path: nodes-only bloom
  // pass into a texture, then a full-scene pass that mixes the bloom back in
  // before ACES tone-mapping (spec A1). Single path: legacy full-scene bloom.
  private render(): void {
    // Cosmic-web skin: accumulate this frame's edge splats first, so the ramp
    // quad the composers are about to draw samples fresh density.
    if (this.edgeDensity) this.edgeDensity.render(this.renderer, this.camera);
    if (this.selective && this.bloomComposer && this.finalComposer) {
      const camMask = this.camera.layers.mask;
      // Bloom pass: restrict the camera to layer 1 (nodes only) AND drop the
      // scene background — the mix pass ADDS this whole texture onto the final
      // render, so any background here would be summed twice (invisible on the
      // near-black dark theme, but on light it doubled the near-white bg into
      // a blown-out frame).
      const bg = this.scene.background;
      this.scene.background = null;
      this.camera.layers.set(BLOOM_LAYER);
      // Light theme: bloom pass renders BLACK (see darkTheme docs) so the mix
      // adds nothing and stars are drawn exactly once.
      const showPoints = this.points.visible;
      if (!this.darkTheme) this.points.visible = false;
      this.bloomComposer.render();
      this.points.visible = showPoints;
      this.camera.layers.mask = camMask; // restore (default: layer 0)
      this.scene.background = bg;
      this.finalComposer.render();
    } else {
      this.composer.render();
    }
  }


  start(): void {
    if (this.raf != null) return;
    this.lastFrame = performance.now();
    const loop = (): void => {
      const now = performance.now();
      const dt = Math.min(0.1, (now - this.lastFrame) / 1000); // clamp tab-refocus jumps
      this.lastFrame = now;
      // Condensation intro clock — an explicit one-shot, so it advances even
      // with ambient motion off; parks at −1 when done (zero steady-state cost).
      if (this.spawnClock >= 0) {
        this.spawnClock += dt;
        this.nodeMat.uniforms.u_spawnClock.value =
          this.spawnClock > 4 ? (this.spawnClock = -1) : this.spawnClock;
      }
      if (this.flyMode) {
        this.ship.update(dt);
      } else {
        this.camTweenTick(dt); // eased focus-flight (no-op when idle)
        this.targetTweenTick(dt); // eased orbit-pivot retarget (no-op when idle)
        this.controls.update();
      }
      this.updateLod(dt);
      // Near-field planets: the nodes nearest the camera resolve into procedural
      // spheres. Structure, not ambience — always updated when enabled (spin
      // only advances when ambient motion is on, so reduced-motion sees still,
      // lit planets). Passed the LIVE position buffer so a rebuild() is safe.
      if (this.planetsEnabled) {
        this.planets.update(
          dt,
          this.nodeGeom.getAttribute("position") as THREE.BufferAttribute,
          this.ambientOn(),
        );
      }
      // Bridge hints track drifting centroids on a slow cadence.
      if (this.bridgeLines.visible && (this.bridgeTick = (this.bridgeTick + 1) % 30) === 0) {
        this.refreshBridgeLines();
      }
      // Infinite-sky mode (multiverse): ride the shells along with the camera
      // so the deep field never runs out, no matter how wide the scene spans.
      if (this.starfieldFollow) this.starfield.position.copy(this.camera.position);
      // Overlay life (multiverse bubble breathing) — ambience-gated.
      if (this.overlayTick && this.ambientOn()) this.overlayTick(now / 1000);
      // Film grain rides the same ambience-gated clock as the stars: with
      // ambient motion off (or reduced motion) the grain freezes too.
      if (this.cinePass) {
        this.cinePass.material.uniforms.u_time.value =
          this.nodeMat.uniforms.u_time.value;
      }
      // Grid backdrop parallax: drift the fullscreen dot grid with the camera's
      // look direction so it reads as depth behind the graph, not a flat UI
      // overlay pinned to the window.
      if (this.gridBackdrop) {
        const d = this.camera.getWorldDirection(this.tmpVec);
        const u = (this.gridBackdrop.material as THREE.ShaderMaterial).uniforms.u_offset
          .value as THREE.Vector2;
        u.set(d.x * 0.35 + this.camera.position.x * 0.00002, d.y * 0.35 + this.camera.position.y * 0.00002);
      }
      // One coalesced hover pick per frame (not one per pointermove event).
      // Suppressed while flying (drag = steer, not hover).
      if (!this.flyMode) this.processPick();
      // Life: signals flow along edges + stars breathe. Frozen for
      // reduced-motion and by the "Ambient motion" toggle (one switch for all
      // idle motion — spec B4).
      if (this.ambientOn() && !this.interacting) {
        // Round pulses only when the flying-arrow fleet isn't the signal layer.
        // The cosmic-web skin also mutes them: hundreds of community-coloured
        // particles read as confetti over its faint monochrome filaments.
        if (!this.settings.arrows && !this.webSkin) this.pulse.update(dt);
        this.nodeMat.uniforms.u_time.value += dt;
        // Meteors cross the galaxy-skin sky (visibility gates the skin/perf).
        if (this.meteor.lines.visible) this.meteor.update(dt);
        // Idle galaxy swirl + orphan moons. The O(n + edges) rewrite is the
        // perf-LOD's problem, so big vaults skip it.
        if (!this.perfLod && this.dragId == null) {
          this.swirlTick(dt);
        }
        // Galactic core bulges pulse; centroids refresh at a slow cadence.
        if (this.coreGlow.points.visible) {
          this.coreGlow.update(dt);
          if ((this.coreGlowTick = (this.coreGlowTick + 1) % 30) === 0) {
            this.coreGlow.refresh();
          }
        }
        // Rare black-hole / wormhole events, near live galaxy centres. A
        // separate opt-out (cosmicEvents) from the ambient-motion switch, and
        // never over a flat 2D map (they're 3D galaxy FX).
        if (this.darkTheme && !this.perfLod && this.settings.cosmicEvents && !this.flatLayout) {
          this.cosmic.update(dt, () => this.galaxyCentres());
        }
        // Each large galaxy's dust band wheels with it.
        if (this.band.points.visible) this.band.update(dt);
        // Spontaneous synapse firings keep the idle brain alive. Perf mode
        // drops them with the other ambient layers; a dedicated toggle lets a
        // user silence them for a still graph.
        if (!this.perfLod && this.settings.neuralFiring) {
          this.synapseTimer -= dt;
          if (this.synapseTimer <= 0) this.fireSynapse();
        }
      }
      // Flying arrows: the fleet streams source→target whenever arrows are on
      // (an explicit toggle, so it runs even with ambient motion off).
      if (this.arrows.visible && !this.interacting) this.animateArrows(dt);
      // Trace comet animates regardless of the ambient-motion toggle — it's an
      // explicit interaction, not idle ambience. No-ops when no trace is active.
      this.tracePulse.update(dt);
      // Same for the click impulse (wave + supernova) — explicit accents. The
      // synapse ripple also finishes its run even if ambience pauses mid-wave.
      this.wave.update(dt);
      this.nova.update(dt);
      this.synapse.update(dt);
      this.dust.update(dt);
      // Hover micro-pop: entries exist only while a pop is animating (the
      // ambient/reduced-motion gate happens at creation time in setHoverPop).
      this.hoverPopTick(dt);
      this.updateLabels();
      this.render();
      this.labelRenderer.render(this.scene, this.camera);
      this.renderMinimap();
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
    if (this.rotateResumeTimer != null) clearTimeout(this.rotateResumeTimer);
    if (this.lodRestoreTimer != null) clearTimeout(this.lodRestoreTimer);
    // Spaceship: drop fly controls + their global key listeners, hide dust.
    this.ship.dispose();
    this.controls.removeEventListener("start", this.onControlsStart);
    this.controls.removeEventListener("end", this.onControlsEnd);
    this.controls.dispose();
    for (const obj of this.labels.values()) {
      obj.element.remove();
      this.scene.remove(obj);
    }
    this.labels.clear();
    this.skyTex?.dispose();
    this.skyTex = null;
    this.setMinimap(false);
    if (this.edgeDensity) {
      this.scene.remove(this.edgeDensity.quad);
      this.edgeDensity.dispose();
      this.edgeDensity = null;
    }
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
    this.tracePulse.dispose();
    this.scene.remove(this.tracePulse.points);
    this.dust.dispose();
    this.scene.remove(this.dust.points);
    this.wave.dispose();
    this.scene.remove(this.wave.sparks);
    this.scene.remove(this.wave.flashes);
    this.nova.dispose();
    this.scene.remove(this.nova.points);
    this.synapse.dispose();
    this.scene.remove(this.synapse.sparks);
    this.scene.remove(this.synapse.flashes);
    this.meteor.dispose();
    this.scene.remove(this.meteor.lines);
    this.coreGlow.dispose();
    this.scene.remove(this.coreGlow.points);
    this.cosmic.dispose();
    this.scene.remove(this.cosmic.group);
    this.band.dispose();
    this.scene.remove(this.band.points);
    this.imposter.dispose();
    this.scene.remove(this.imposter.points);
    this.planets.dispose();
    this.scene.remove(this.planets.sphere);
    this.scene.remove(this.planets.rings);
    this.scene.remove(this.planets.moons);
    this.bridgeLines.geometry.dispose();
    (this.bridgeLines.material as THREE.Material).dispose();
    this.scene.remove(this.bridgeLines);
    this.hulls.dispose();
    this.scene.remove(this.hulls.mesh);
    this.bundles.dispose();
    this.scene.remove(this.bundles.group);
    this.ensureGridBackdrop(false, this.darkTheme); // frees the grid mesh
    this.clusterLabels.dispose();
    this.scene.remove(this.clusterLabels.group);
    this.bloom.dispose();
    if (this.selective) {
      this.bloomComposer?.renderTarget1.dispose();
      this.bloomComposer?.renderTarget2.dispose();
      this.bloomComposer?.dispose();
      this.finalComposer?.renderTarget1.dispose();
      this.finalComposer?.renderTarget2.dispose();
      this.finalComposer?.dispose();
      this.mixPass?.material.dispose();
    } else {
      this.composer.renderTarget1.dispose();
      this.composer.renderTarget2.dispose();
      this.composer.dispose();
    }
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
    if (this.selective) {
      this.bloomComposer?.setSize(w, h);
      this.finalComposer?.setSize(w, h);
    } else {
      this.composer.setSize(w, h);
    }
    this.bloom.setSize(w, h);
    this.labelRenderer.setSize(w, h);
    this.nodeMat.uniforms.u_sizeScale.value = this.sizeScale(h) * this.skinNodeScale();
    if (this.fxaaPass) {
      (this.fxaaPass.material.uniforms.resolution.value as THREE.Vector2).set(
        1 / Math.max(1, w * this.renderer.getPixelRatio()),
        1 / Math.max(1, h * this.renderer.getPixelRatio()),
      );
    }
    this.edgeDensity?.setSize(w, h, this.renderer.getPixelRatio());
    this.wave.setSizeScale(this.sizeScale(h));
    this.nova.setSizeScale(this.sizeScale(h));
    this.synapse.setSizeScale(this.sizeScale(h));
    this.coreGlow.setSizeScale(this.sizeScale(h));
    this.cosmic.setSizeScale(this.sizeScale(h));
    this.band.setSizeScale(this.sizeScale(h));
    this.imposter.setSizeScale(this.sizeScale(h));
    // Fat lines are screen-space — they need the drawing-buffer resolution.
    this.filamentMat?.resolution.set(w, h);
    this.bundles.setSize(w, h);
    if (this.gridBackdrop) {
      (this.gridBackdrop.material as THREE.ShaderMaterial).uniforms.u_aspect.value = w / h;
    }
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
    if (this.flyMode) return; // the ship owns drag-to-steer; no hover/drag
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
      this.setHoverPop(id);
      this.cb.onNodeHover(id);
    }
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    // Minimap click-to-fly wins over drag/orbit/pick inside its inset.
    if (this.minimapClick(e)) {
      e.stopPropagation();
      return;
    }
    this.downAt = { x: e.clientX, y: e.clientY };
    if (this.flyMode) return; // no node-drag while flying; the ship steers
    const id = this.pickNode(e.clientX, e.clientY);
    if (id) {
      this.dragId = id;
      this.dragMoved = false;
      this.controls.enabled = false; // don't orbit while dragging a star
      // A drag never fires OrbitControls' start/end, so drive the LOD directly
      // (spec B6: overlays drop during a node drag too).
      this.beginInteraction();
      this.cb.onDragStart(id);
    } else if (this.hoverId) {
      // starting a camera orbit on empty space — drop the hover highlight so the
      // scene isn't stuck dimmed while the user rotates.
      this.hoverId = null;
      this.setHoverPop(null);
      this.cb.onNodeHover(null);
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (this.flyMode) {
      // A stationary click selects the node under the cursor → its info opens in
      // the ship HUD; a click on empty space clears it. Drags are steering.
      const still =
        this.downAt != null &&
        Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y) <= 3;
      if (still && e.target === this.renderer.domElement) {
        const hit = this.pickNode(e.clientX, e.clientY);
        if (hit) this.cb.onNodeClick(hit, false);
        else this.cb.onVoidClick();
      }
      this.downAt = null;
      return;
    }
    const id = this.dragId;
    if (id) {
      this.controls.enabled = true;
      const moved =
        this.dragMoved &&
        this.downAt != null &&
        Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y) > 3;
      this.cb.onDragEnd(id);
      this.endInteraction();
      if (!moved) this.cb.onNodeClick(id, e.metaKey || e.ctrlKey);
    } else if (
      this.downAt != null &&
      e.target === this.renderer.domElement &&
      Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y) <= 3
    ) {
      // Stationary click on empty space (no node hit, no orbit) — the focus
      // stack's "step out" gesture.
      this.cb.onVoidClick();
    }
    this.dragId = null;
    this.dragMoved = false;
    this.downAt = null;
  };

  private onCtxLost = (e: Event): void => {
    e.preventDefault();
    this.cb.onContextLost();
  };
  private onCtxRestored = (): void => {
    this.cb.onContextRestored();
  };
}
