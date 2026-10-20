import * as THREE from "three";
import type { VaultGraph } from "./graphData";
import type { GraphSettings } from "./graphSettings";
import {
  EDGE_BASE_DARK,
  EDGE_BASE_LIGHT,
  EDGE_DIM,
  EDGE_END_FADE,
  EDGE_GREY_MIX,
  EDGE_HI,
  EDGE_NEUTRAL_DARK_HEX,
  EDGE_NEUTRAL_LIGHT_HEX,
  EDGE_OPACITY_DARK,
  EDGE_OPACITY_LIGHT,
  FOCUS_EDGE_DIM,
} from "./layoutConfig";
import type { WovenLayout } from "./wovenLayout";

/** How the scene lights a link on its ground and skin (GraphScene.linkInk):
 *  the values every look's links take (graph-visual-rules, Lines). */
export interface LinkInk {
  /** Each end's note colour is pulled this far toward the neutral. */
  neutral: THREE.Color;
  greyMix: number;
  /** Resting per-end light; material opacity per unit of Link thickness. */
  base: number;
  opacity: number;
  /** Additive light on a dark ground; ink (normal blending) on light and sigma. */
  additive: boolean;
  /** Saturation multiplier on each end: sigma's vivid veil, 1 elsewhere. */
  saturate: number;
}

/** A plain ground's link light, until the scene hands over its own. */
const plainInk = (dark: boolean): LinkInk => ({
  neutral: new THREE.Color(dark ? EDGE_NEUTRAL_DARK_HEX : EDGE_NEUTRAL_LIGHT_HEX),
  greyMix: EDGE_GREY_MIX,
  base: dark ? EDGE_BASE_DARK : EDGE_BASE_LIGHT,
  opacity: dark ? EDGE_OPACITY_DARK : EDGE_OPACITY_LIGHT,
  additive: dark,
  saturate: 1,
});

/** Push a colour away from its own grey by `k` (sigma's vivid veil; GraphScene.writeEdges). */
function saturate(c: THREE.Color, k: number): void {
  if (k === 1) return;
  const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  const push = (v: number) => Math.min(1, Math.max(0, l + (v - l) * k));
  c.setRGB(push(c.r), push(c.g), push(c.b));
}

/** GraphScene's edge-flow uniforms (its clock, amplitude and ground). */
type FlowUniforms = Record<"u_flowTime" | "u_flowAmp" | "u_flowDark", { value: number }>;

/** The scene's interaction state the strands answer to (GraphScene.style). */
export interface StrandState {
  hoveredNode: string | null;
  neighbors: ReadonlySet<string> | null;
  focus: ReadonlySet<string> | null;
  pathNodes: readonly string[] | null;
}

const AT_REST: StrandState = { hoveredNode: null, neighbors: null, focus: null, pathNodes: null };
// The strands are every other look's link light (graph-visual-rules R4). Until
// 2026-10-02 they ran at 3x it on a dark ground (STRAND_GAIN), as the picture
// of this look; beside the default look they read as bright cables.
//
// A corridor stacks every strand it carries on one path, where straight links
// would spread out. Past this many strands a big vault's corridors would sum
// to white and outshine the notes (graph-visual-rules R4), so the resting and
// dimmed light thins as 1/sqrt(strands); hover and a traced path stay full.
const BUNDLE_FULL_STRANDS = 900;
// Below it the strands light brighter by the same law, up to this much: a
// small vault's few 1 px strands at the shared light all but vanished (68
// notes, 99 strands). The lift scales every state alike, so each keeps the
// shared ratio to rest (a hovered strand ~5x), which a vertex light clamped
// at 1 could not. On a dark ground it is the material's colour (additive
// light into a half-float target keeps values above 1), leaving the material
// opacity to the Link thickness slider, the links' own (0.2 x thickness): as
// opacity the lift filled that range at the old preset (0.6 x 0.55 x 3 = 0.99),
// so the slider did nothing above it. On paper a colour above 1 is lighter
// ink, not more, so there the lift stacks the ink: that many layers of the
// links' own opacity, which keeps the slider's range where every other look's
// is.
const SPARSE_GAIN = 3;

/**
 * Woven's links: every real edge drawn once along the strand its layout routed,
 * as the same light as every other look's links (graph-visual-rules R3, R4):
 * each end in its note's colour pulled toward the shared neutral, additive on
 * a dark ground, dim at rest, lifted on hover and on a traced path, sunk outside
 * a held focus. A strand tapers from EDGE_END_FADE at its notes to full light
 * where it runs with the others, so the bundles glow by their own density and
 * the fans thin out toward each note. The notes are GraphScene's own sprites.
 */
export class WovenGraphLayer {
  readonly group = new THREE.Group();
  /** The strands as drawn: the cosmic web skin's density field splats it too. */
  readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.LineBasicMaterial;
  private readonly index: Map<string, number>;
  /** Route "source|target" → its first vertex and vertex count. */
  private readonly spans = new Map<string, [number, number]>();
  private ink = plainInk(true);
  private readonly density: number;
  private readonly sparse: number;
  /** Per vertex: taper (end fade → 1 → end fade) and source→target mix. */
  private readonly taper: Float32Array;
  private readonly along: Float32Array;

  constructor(
    private readonly graph: VaultGraph,
    readonly layout: WovenLayout,
    dark = true,
  ) {
    this.index = new Map(graph.nodes().map((id, i) => [id, i]));
    const crowd = Math.sqrt(BUNDLE_FULL_STRANDS / Math.max(1, layout.routes.length));
    this.density = Math.min(1, crowd);
    this.sparse = Math.min(SPARSE_GAIN, Math.max(1, crowd));
    const vertices = layout.routes.reduce((n, route) => n + (route.points.length / 3 - 1) * 2, 0);
    this.taper = new Float32Array(vertices);
    this.along = new Float32Array(vertices);
    // Each strand's flow band phase and speed, staggered like the links'.
    const stagger = new Float32Array(vertices);
    let cursor = 0;
    layout.routes.forEach((route, index) => {
      const steps = route.points.length / 3 - 1;
      this.spans.set(`${route.source}|${route.target}`, [cursor, steps * 2]);
      stagger.fill((index * 0.6180339887) % 1, cursor, cursor + steps * 2);
      for (let segment = 0; segment < steps; segment++)
        for (let end = 0; end < 2; end++) {
          const t = (segment + end) / steps;
          this.along[cursor] = t;
          this.taper[cursor++] = EDGE_END_FADE + (1 - EDGE_END_FADE) * Math.sin(Math.PI * t);
        }
    });
    this.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(vertices * 3), 3));
    this.geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(vertices * 4), 4));
    this.geometry.setAttribute("a_prog", new THREE.BufferAttribute(this.along, 1));
    this.geometry.setAttribute("a_rnd", new THREE.BufferAttribute(stagger, 1));
    this.material = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false });
    this.setDark(dark);
    const lines = new THREE.LineSegments(this.geometry, this.material);
    lines.name = "woven-relationships";
    lines.frustumCulled = false;
    this.group.add(lines);
  }

  /** A plain dark or light ground's link light (see setInk). */
  setDark(dark: boolean): void {
    this.setInk(plainInk(dark));
  }

  /** Light the strands as the scene lights its links (GraphScene.linkInk, on
   *  every skin, theme and Link colour change): additive light on a dark
   *  ground, ink on light and sigma. The next sync repaints. */
  setInk(ink: LinkInk): void {
    this.ink = ink;
    this.material.blending = ink.additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    this.material.color.setScalar(ink.additive ? this.sparse : 1);
    this.material.needsUpdate = true;
  }

  /** Ride the scene's edge flow along each strand, source to target: the
   *  links' band (GraphScene.patchEdgeFlow) on the same clock and amplitude.
   *  A strand's light is its vertex alpha, not its colour, so the band scales
   *  the strand's own colour (about the links' 6x at its peak on a dark
   *  ground, deeper ink on a light one), and stays silent where the strand is
   *  hidden or sunk outside a focus. */
  flowWith(uniforms: FlowUniforms): void {
    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          "#include <common>\nattribute float a_prog;\nattribute float a_rnd;\nvarying float v_prog;\nvarying float v_rnd;",
        )
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nv_prog = a_prog;\nv_rnd = a_rnd;");
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          "#include <common>\nuniform float u_flowTime;\nuniform float u_flowAmp;\nuniform float u_flowDark;\nvarying float v_prog;\nvarying float v_rnd;",
        )
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
          if (u_flowAmp > 0.0) {
            float ph = fract(u_flowTime * (0.10 + v_rnd * 0.06) + v_rnd * 7.0);
            float w = exp(-pow((v_prog - ph) * 6.0, 2.0)) * u_flowAmp * smoothstep(0.025, 0.06, vColor.a);
            diffuseColor.rgb *= 1.0 + w * mix(-0.8, 8.0, u_flowDark);
          }`,
        );
    };
    this.material.customProgramCacheKey = () => "myco-strand-flow";
    this.material.needsUpdate = true;
  }

  /** Follow the notes' live positions and paint each strand for `state`.
   *  `attributes` is GraphScene's node buffer: a note at alpha 0 is hidden. */
  sync(attributes: THREE.BufferGeometry, settings: GraphSettings, state: StrandState = AT_REST): void {
    const alphas = attributes.getAttribute("a_alpha");
    const position = this.geometry.getAttribute("position") as THREE.BufferAttribute;
    const ink = this.geometry.getAttribute("color") as THREE.BufferAttribute;
    const xyz = position.array as Float32Array;
    const rgba = ink.array as Float32Array;
    const { hoveredNode, neighbors, focus, pathNodes } = state;
    const path = new Set<string>();
    for (let i = 1; i < (pathNodes?.length ?? 0); i++) {
      path.add(`${pathNodes![i - 1]}|${pathNodes![i]}`);
      path.add(`${pathNodes![i]}|${pathNodes![i - 1]}`);
    }
    const from = new THREE.Color();
    const to = new THREE.Color();
    let cursor = 0;
    for (const route of this.layout.routes) {
      const { source: s, target: t } = route;
      const sa = this.graph.getNodeAttributes(s);
      const ta = this.graph.getNodeAttributes(t);
      // A dragged note pulls its strand ends with it; the bundle stays put.
      const rest0 = this.layout.positions.get(s)!;
      const rest1 = this.layout.positions.get(t)!;
      const sx = sa.x - rest0.x, sy = sa.y - rest0.y, sz = sa.z - rest0.z;
      const tx = ta.x - rest1.x, ty = ta.y - rest1.y, tz = ta.z - rest1.z;
      // Same state order as GraphScene.writeEdges, plus the traced path the
      // straight-line filaments would otherwise light.
      let light = this.ink.base * this.density;
      if (path.has(`${s}|${t}`)) light = EDGE_HI;
      else if (focus && !(focus.has(s) && focus.has(t))) light = FOCUS_EDGE_DIM * this.density;
      else if (hoveredNode)
        light =
          s === hoveredNode || t === hoveredNode || (neighbors?.has(s) && neighbors.has(t))
            ? EDGE_HI
            : EDGE_DIM * this.density;
      if (!(alphas.getX(this.index.get(s)!) > 0 && alphas.getX(this.index.get(t)!) > 0)) light = 0;
      saturate(from.set(sa.color).lerp(this.ink.neutral, this.ink.greyMix), this.ink.saturate);
      saturate(to.set(ta.color).lerp(this.ink.neutral, this.ink.greyMix), this.ink.saturate);
      const steps = route.points.length / 3 - 1;
      for (let segment = 0; segment < steps; segment++)
        for (let end = 0; end < 2; end++) {
          const sample = (segment + end) * 3;
          const k = this.along[cursor];
          const a = (1 - k) ** 3;
          const b = k ** 3;
          const o = cursor * 3;
          xyz[o] = route.points[sample] + sx * a + tx * b;
          xyz[o + 1] = route.points[sample + 1] + sy * a + ty * b;
          xyz[o + 2] = route.points[sample + 2] + sz * a + tz * b;
          const c = cursor * 4;
          rgba[c] = from.r + (to.r - from.r) * k;
          rgba[c + 1] = from.g + (to.g - from.g) * k;
          rgba[c + 2] = from.b + (to.b - from.b) * k;
          // ≤ 1: blending into the half-float target does not clamp alpha.
          rgba[c + 3] = Math.min(1, light * this.taper[cursor]);
          cursor++;
        }
    }
    const opacity = Math.min(1, this.ink.opacity * settings.linkThickness);
    this.material.opacity = this.ink.additive ? opacity : 1 - (1 - opacity) ** this.sparse;
    position.needsUpdate = true;
    ink.needsUpdate = true;
  }

  /** The strand between two notes as drawn now: its segments (two xyz per
   *  segment) and whether it runs from `a` to `b`. Null when there is none. */
  strand(a: string, b: string): { points: Float32Array; forward: boolean } | null {
    const forward = this.spans.get(`${a}|${b}`);
    const span = forward ?? this.spans.get(`${b}|${a}`);
    if (!span) return null;
    const xyz = this.geometry.getAttribute("position").array as Float32Array;
    return { points: xyz.subarray(span[0] * 3, (span[0] + span[1]) * 3), forward: !!forward };
  }

  /** Place `out` a share `f` of the way from `a` to `b` along their strand as
   *  drawn now: GraphScene's pulses, sparks, trace comet and arrows ride it
   *  (a LinkRoute). False when the two notes have no strand. */
  pointAlong(a: string, b: string, f: number, out: THREE.Vector3): boolean {
    const forward = this.spans.get(`${a}|${b}`);
    const span = forward ?? this.spans.get(`${b}|${a}`);
    if (!span) return false;
    const xyz = this.geometry.getAttribute("position").array as Float32Array;
    const segments = span[1] / 2;
    const u = Math.min(1, Math.max(0, forward ? f : 1 - f)) * segments;
    const segment = Math.min(segments - 1, Math.floor(u));
    const k = u - segment;
    const o = (span[0] + segment * 2) * 3;
    out.set(
      xyz[o] + (xyz[o + 3] - xyz[o]) * k,
      xyz[o + 1] + (xyz[o + 4] - xyz[o + 1]) * k,
      xyz[o + 2] + (xyz[o + 5] - xyz[o + 2]) * k,
    );
    return true;
  }

  /** Every point the frame must hold: the notes and every strand vertex. */
  forEachFramePoint(visit: (point: THREE.Vector3) => void): void {
    const point = new THREE.Vector3();
    for (const id of this.index.keys()) {
      const a = this.graph.getNodeAttributes(id);
      visit(point.set(a.x, a.y, a.z));
    }
    const positions = this.geometry.getAttribute("position");
    for (let i = 0; i < positions.count; i++) visit(point.fromBufferAttribute(positions, i));
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.group.removeFromParent();
    this.group.clear();
  }
}
