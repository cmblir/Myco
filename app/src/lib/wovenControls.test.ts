// Woven follows every shared control (graph-visual-rules R13): each motion and
// appearance control the drawer offers the default look changes what Woven
// draws. GraphScene itself runs here, in node, over a fake renderer and DOM.
// A control goes through the scene's own live path (applySettings, and
// applyTheme for a skin or the app theme, as PageGraph calls them) or through
// a rebuild where PageGraph rebuilds; the render loop then runs, and the
// frame's drawable state (every visible object's geometry, material and
// uniforms, the strand shader's injected uniforms, the post passes, the
// camera, the labels) is compared with the preset's. A control Woven ignores
// leaves that state as it was and fails here, naming itself.
import * as THREE from "three";
import type { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installTauriMock } from "./devMock";
import { buildGraph, computeAllowed, flattenMarkdown, recolorGraph, type VaultGraph } from "./graphData";
import { GraphScene } from "./graphScene";
import { DEFAULT_GRAPH_SETTINGS, VIBE_PRESETS, type GraphSettings } from "./graphSettings";
import { isLightBackground } from "./graphSkins";
import { makeTheme } from "./graphTheme";
import type { Adjacency, FileNode } from "./ipc";
import { ATLAS_RADIUS_MUL } from "./layoutConfig";
import type { PulseLayer } from "./pulseLayer";
import type { TracePulse } from "./tracePulse";
import type { WaveLayer } from "./waveLayer";
import type { WovenGraphLayer } from "./wovenGraphLayer";
import { buildWovenLayout, wovenInput, type WovenLayout } from "./wovenLayout";

// A seeded Math.random, in place before any module loads: Louvain keeps the
// Math.random it found at import as its default RNG. Restarted for every
// scene, so two builds from the same settings colour and lay out alike.
const rng = vi.hoisted(() => {
  const original = Math.random;
  let state = 7;
  Math.random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    reset: () => {
      state = 7;
    },
    restore: () => {
      Math.random = original;
    },
  };
});
afterAll(() => rng.restore());

// No WebGL in node: a renderer that accepts every call and draws nothing.
vi.mock("three", async (importOriginal) => {
  const three = await importOriginal<typeof THREE>();
  class FakeRenderer {
    domElement = fakeElement();
    toneMapping: THREE.ToneMapping = three.NoToneMapping;
    toneMappingExposure = 1;
    outputColorSpace = three.SRGBColorSpace;
    autoClear = true;
    private pixelRatio = 1;
    setPixelRatio(ratio: number): void {
      this.pixelRatio = ratio;
    }
    getPixelRatio(): number {
      return this.pixelRatio;
    }
    getSize(into: THREE.Vector2): THREE.Vector2 {
      return into.set(960, 609);
    }
    getClearColor(into: THREE.Color): THREE.Color {
      return into;
    }
    getClearAlpha(): number {
      return 0;
    }
    getRenderTarget(): null {
      return null;
    }
    setClearColor = vi.fn();
    setSize = vi.fn();
    render = vi.fn();
    compile = vi.fn();
    setRenderTarget = vi.fn();
    clear = vi.fn();
    setViewport = vi.fn();
    setScissor = vi.fn();
    setScissorTest = vi.fn();
    dispose = vi.fn();
  }
  return { ...three, WebGLRenderer: FakeRenderer };
});

// The ship's hull is a GLB fetched by URL; flight is checked by its camera only.
vi.mock("./shipController", () => ({
  ShipController: class {
    setDark = vi.fn();
    enable = vi.fn();
    disable = vi.fn();
    update = vi.fn();
    dispose = vi.fn();
    getSpeed(): number {
      return 0;
    }
  },
}));

function fakeElement(): Record<string, unknown> {
  const element: Record<string, unknown> = {
    style: {},
    dataset: {},
    classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn(), contains: () => false },
    clientWidth: 960,
    clientHeight: 609,
    textContent: "",
    parentElement: null,
    parentNode: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    appendChild: (child: unknown) => child,
    removeChild: vi.fn(),
    remove: vi.fn(),
    setAttribute: vi.fn(),
    removeAttribute: vi.fn(),
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 960, bottom: 609, width: 960, height: 609 }),
    querySelector: () => null,
    querySelectorAll: () => [],
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    hasPointerCapture: () => false,
    getContext: () => fakeContext(),
  };
  element.getRootNode = () => element;
  element.ownerDocument = element;
  return element;
}

/** A 2D canvas context that takes every call (the nebula and sprite textures). */
function fakeContext(): unknown {
  const context: unknown = new Proxy({} as Record<string | symbol, unknown>, {
    get: (target, key) => {
      if (key in target) return target[key];
      if (key === "getImageData" || key === "createImageData")
        return (...size: number[]) => {
          const [w, h] = size.length > 2 ? [size[2], size[3]] : [size[0], size[1]];
          return { data: new Uint8ClampedArray(Math.max(1, w * h) * 4), width: w, height: h };
        };
      if (key === "measureText") return () => ({ width: 10 });
      return () => context;
    },
    set: (target, key, value) => {
      target[key] = value;
      return true;
    },
  });
  return context;
}

// The app theme's CSS variables, as makeTheme("auto") reads them.
const APP_THEMES = {
  dark: { "--bg": "#0f1115", "--ink": "#e6e8eb", "--accent": "#7aa7ff" },
  light: { "--bg": "#fefefe", "--ink": "#111418", "--accent": "#3b82f6" },
};
let appTheme: Record<string, string> = APP_THEMES.dark;
let reduced = false;
let pending: FrameRequestCallback | null = null;
let clock = 0;

beforeEach(() => {
  appTheme = APP_THEMES.dark;
  reduced = false;
  vi.stubGlobal("document", { createElement: fakeElement, createElementNS: fakeElement, documentElement: fakeElement(), body: fakeElement() });
  vi.stubGlobal("window", {
    matchMedia: () => ({ matches: reduced, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    devicePixelRatio: 1,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("location", { search: "?mock=1" });
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: (name: string) => appTheme[name] ?? "" }));
  vi.stubGlobal("ResizeObserver", class { observe = vi.fn(); disconnect = vi.fn(); });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    pending = callback;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    pending = null;
  });
  vi.spyOn(performance, "now").mockImplementation(() => clock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The mock vault as PageGraph reads it: its links and every note it allows. */
let vault: { adjacency: Adjacency; allowed: Set<string> } | null = null;
async function mockVault(): Promise<{ adjacency: Adjacency; allowed: Set<string> }> {
  if (vault) return vault;
  installTauriMock();
  const invoke = (window as unknown as { __TAURI_INTERNALS__: { invoke: <T>(command: string) => Promise<T> } })
    .__TAURI_INTERNALS__.invoke;
  const root = (await invoke<{ path: string }>("open_vault")).path;
  const adjacency = await invoke<Adjacency>("build_link_graph");
  const files = flattenMarkdown(await invoke<FileNode[]>("list_files"));
  const allowed = computeAllowed(adjacency, files, {
    tagFilter: null, folderFilter: null, vaultRoot: root, search: "", existingOnly: false, showOrphans: true,
  });
  vault = { adjacency, allowed };
  return vault;
}

const field = <T,>(owner: object, name: string): T => Reflect.get(owner, name) as T;
const PRESET: GraphSettings = { ...DEFAULT_GRAPH_SETTINGS, ...VIBE_PRESETS.ribbon };

interface Woven {
  scene: GraphScene;
  graph: VaultGraph;
  layout: WovenLayout;
  layer: WovenGraphLayer;
  settings: GraphSettings;
  /** PageGraph's display effect, plus its theme effect when the skin changes. */
  apply(patch: Partial<GraphSettings>): void;
  /** PageGraph's theme effect after the app theme flipped. */
  theme(name: keyof typeof APP_THEMES): void;
  step(frames: number): void;
  drawn(): string;
}

/** PageGraph's Woven build: graph, scene, the worker's layout, fit, start. */
async function woven(patch: Partial<GraphSettings> = {}): Promise<Woven> {
  const { adjacency, allowed } = await mockVault();
  rng.reset();
  // Each scene keeps its own clock and its own frame loop.
  clock = 0;
  const settings: GraphSettings = { ...PRESET, ...patch };
  const theme = makeTheme(settings.skin);
  const ids = [...allowed].sort();
  const graph = buildGraph(adjacency, allowed, {
    nodeSize: settings.nodeSize,
    starDim: theme.starDim,
    edgeColor: theme.edge,
    showGhosts: true,
    // A note's nearest few, standing in for the embedding index.
    semanticEdges: settings.semanticEdges
      ? ids.flatMap((source, i) => [1, 5, 11].map((k) => ({ source, target: ids[(i + k) % ids.length], score: 0.8 })))
      : undefined,
    folderGalaxies: settings.folderGalaxies,
    lightBg: isLightBackground(theme),
  });
  const noop = vi.fn();
  const scene = new GraphScene(fakeElement() as unknown as HTMLDivElement, graph, theme, settings, {
    onNodeClick: noop, onNodeHover: noop, onDragStart: noop, onDrag: noop, onDragEnd: noop,
    onVoidClick: noop, onContextLost: noop, onContextRestored: noop,
  });
  const layout = buildWovenLayout(wovenInput(graph, settings.linkDistance * ATLAS_RADIUS_MUL));
  for (const [id, position] of layout.positions) graph.mergeNodeAttributes(id, position);
  scene.setWovenLayout(layout);
  scene.syncPositions();
  scene.layoutSettled();
  scene.fit();
  scene.start();
  const loop = pending as FrameRequestCallback | null;
  pending = null;
  let own = 0;
  const self: Woven = {
    scene, graph, layout, settings,
    layer: field<WovenGraphLayer>(scene, "woven"),
    apply(next) {
      clock = own;
      const skinChanged = next.skin !== undefined && next.skin !== self.settings.skin;
      self.settings = { ...self.settings, ...next };
      if (skinChanged) self.theme(appTheme === APP_THEMES.dark ? "dark" : "light");
      else scene.applySettings(self.settings);
    },
    theme(name) {
      clock = own;
      appTheme = APP_THEMES[name];
      const resolved = makeTheme(self.settings.skin);
      recolorGraph(graph, isLightBackground(resolved), self.settings.skin === "sigma");
      scene.applySettings(self.settings);
      scene.applyTheme(resolved);
    },
    step(frames) {
      for (let i = 0; i < frames; i++) {
        clock = own += 1000 / 60;
        loop?.(clock);
      }
      pending = null;
    },
    drawn: () => drawn(scene),
  };
  return self;
}

const num = (v: number): number => Number(v.toPrecision(6));
/** Order-sensitive checksum of a typed array. */
function checksum(values: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i] * (1 + (i % 13));
  return num(sum);
}
function uniformValue(value: unknown): unknown {
  if (typeof value === "number") return num(value);
  if (typeof value === "boolean") return value;
  if (value instanceof THREE.Color) return value.getHexString();
  if (value instanceof THREE.Vector2 || value instanceof THREE.Vector3 || value instanceof THREE.Vector4)
    return value.toArray().map(num);
  return value == null ? null : "object";
}
const uniformsOf = (uniforms: Record<string, { value: unknown }>): unknown =>
  Object.keys(uniforms).sort().map((name) => [name, uniformValue(uniforms[name].value)]);

/** What compiling a material with an injected shader (onBeforeCompile) sets. */
function injected(material: THREE.Material): unknown {
  if (material.onBeforeCompile === THREE.Material.prototype.onBeforeCompile) return null;
  const shader = {
    uniforms: {} as Record<string, { value: unknown }>,
    vertexShader: THREE.ShaderLib.basic.vertexShader,
    fragmentShader: THREE.ShaderLib.basic.fragmentShader,
  };
  material.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, null as unknown as THREE.WebGLRenderer);
  return [uniformsOf(shader.uniforms), shader.fragmentShader.length];
}

function describeMaterial(material: THREE.Material): unknown {
  const m = material as THREE.Material & { color?: THREE.Color; uniforms?: Record<string, { value: unknown }> };
  return [
    m.type, m.blending, num(m.opacity), m.transparent, m.depthTest, m.depthWrite,
    m.color?.getHexString() ?? null, m.uniforms ? uniformsOf(m.uniforms) : null, injected(m),
  ];
}

function describeObject(object: THREE.Object3D): unknown {
  const out: unknown[] = [object.type, object.renderOrder, object.position.toArray().map(num), object.quaternion.toArray().map(num), object.scale.toArray().map(num)];
  const label = object as CSS2DObject;
  if ((label as CSS2DObject & { isCSS2DObject?: boolean }).isCSS2DObject) out.push(String((label.element as unknown as { textContent: string }).textContent));
  const mesh = object as THREE.Mesh;
  if (mesh.geometry instanceof THREE.BufferGeometry) {
    const g = mesh.geometry;
    out.push(Object.keys(g.attributes).sort().map((name) => [name, checksum(g.getAttribute(name).array)]), g.drawRange.start, g.drawRange.count);
  }
  const instanced = object as THREE.InstancedMesh;
  if (instanced.isInstancedMesh) out.push(instanced.count, checksum(instanced.instanceMatrix.array), instanced.instanceColor ? checksum(instanced.instanceColor.array) : null);
  if (mesh.material) out.push((Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map(describeMaterial));
  return out;
}

/** Everything the next frame would draw, as one comparable string. */
function drawn(scene: GraphScene): string {
  const root = field<THREE.Scene>(scene, "scene");
  const renderer = field<THREE.WebGLRenderer>(scene, "renderer");
  const camera = field<THREE.PerspectiveCamera>(scene, "camera");
  const density = field<{ mode: string; lines: THREE.LineSegments } | null>(scene, "edgeDensity");
  const fog = root.fog as THREE.FogExp2;
  const parts: unknown[] = [
    renderer.toneMapping, num(renderer.toneMappingExposure),
    root.background instanceof THREE.Color ? root.background.getHexString() : root.background ? "texture" : null,
    fog.color.getHexString(), num(fog.density),
    camera.position.toArray().map(num), camera.quaternion.toArray().map(num),
    ["fxaaPass", "cinePass", "godPass"].map((pass) => field<{ enabled: boolean } | undefined>(scene, pass)?.enabled ?? null),
    num(field<{ strength: number }>(scene, "bloom").strength),
    field<boolean>(scene, "minimapOn"),
    density ? [density.mode, describeObject(density.lines)] : null,
  ];
  root.traverseVisible((object) => parts.push(describeObject(object)));
  return JSON.stringify(parts);
}

// 4 s: past the first idle neural firing (3 s), long enough for any motion.
const FRAMES = 240;

describe("Woven follows every shared control", () => {
  it("draws the same frame from the same settings, so a difference below is the control's", async () => {
    const [a, b] = [await woven(), await woven()];
    a.step(FRAMES);
    b.step(FRAMES);
    expect(a.drawn()).toBe(b.drawn());
  });

  // [control, the value it is set to, and (when the preset's own value is
  // not the other side) the value it is compared with]
  const live: [string, Partial<GraphSettings>, Partial<GraphSettings>?][] = [
    ["Color mode: black", { skin: "black" }],
    ["Color mode: white", { skin: "white" }],
    ["Color mode: galaxy", { skin: "galaxy" }],
    ["Color mode: cosmic web", { skin: "web" }],
    ["Color mode: sigma", { skin: "sigma" }],
    ["Sky: dense", { skyStyle: "dense" }],
    ["Sky: grid", { skyStyle: "grid" }],
    ["Sky: void", { skyStyle: "void" }],
    ["Node colour: white", { nodeColor: "white" }],
    ["Node colour: black", { nodeColor: "black" }],
    ["Colour above N", { nodeColor: "auto", monoBelow: 0 }, { nodeColor: "auto", monoBelow: 2000 }],
    ["Link colour: community webs", { edgeTint: "community" }],
    ["Colour depth", { nodeColorDepth: 2 }],
    // Every step of the slider, so it keeps its whole range.
    ["Link thickness 0.3 → 1", { linkThickness: 0.3 }, { linkThickness: 1 }],
    ["Link thickness 1 → 2", { linkThickness: 1 }, { linkThickness: 2 }],
    ["Link thickness 2 → 3", { linkThickness: 2 }, { linkThickness: 3 }],
    ["Glow", { brightness: 1.5 }],
    ["Note name visibility", { textFadeThreshold: 0.2 }],
    ["Arrows", { arrows: true }],
    ["Arrow size", { arrows: true, arrowSize: 0.5 }, { arrows: true, arrowSize: 2 }],
    ["Ambient motion", { ambientMotion: !PRESET.ambientMotion }],
    ["Recency glow", { recencyGlow: !PRESET.recencyGlow }],
    ["Cinematic finish", { cinematic: !PRESET.cinematic }],
    ["Edge flow", { edgeFlow: !PRESET.edgeFlow }],
    ["Minimap", { minimap: !PRESET.minimap }],
    ["Neural firing", { neuralFiring: !PRESET.neuralFiring }],
    // At 4 × the first event opens 3.75 s in, inside the 4 s run.
    ["Cosmic events", { cosmicEvents: false }, { cosmicEvents: true, cosmicFrequency: 4 }],
    ["Event frequency", { cosmicFrequency: 4 }, { cosmicEvents: true, cosmicFrequency: 1 }],
    ["Pixel nodes", { pixelNodes: !PRESET.pixelNodes }],
  ];
  it.each(live)("%s", async (_name, change, against = {}) => {
    const [base, changed] = [await woven(), await woven()];
    base.apply(against);
    changed.apply({ ...against, ...change });
    base.step(FRAMES);
    changed.step(FRAMES);
    expect(changed.drawn()).not.toBe(base.drawn());
  });

  it.each([
    ["Node size", { nodeSize: 1.5 }],
    ["Layout size", { linkDistance: 140 }],
    ["Semantic links", { semanticEdges: true }],
  ] as [string, Partial<GraphSettings>][])("%s (rebuilt, as PageGraph rebuilds it)", async (_name, change) => {
    const [base, changed] = [await woven(), await woven(change)];
    base.step(FRAMES);
    changed.step(FRAMES);
    expect(changed.drawn()).not.toBe(base.drawn());
  });

  it("App theme: light", async () => {
    const [base, changed] = [await woven(), await woven()];
    changed.theme("light");
    base.step(FRAMES);
    changed.step(FRAMES);
    expect(changed.drawn()).not.toBe(base.drawn());
    // The ground is the app's, and the strands are ink, not light (R4, R5).
    const ground = field<THREE.Scene>(changed.scene, "scene").background as THREE.Color;
    expect(ground.getHexString()).toBe("fefefe");
    const strands = changed.layer.group.getObjectByName("woven-relationships") as THREE.LineSegments;
    expect((strands.material as THREE.Material).blending).toBe(THREE.NormalBlending);
  });

  it("Near-field planets, close to a note", async () => {
    const [base, changed] = [await woven(), await woven()];
    changed.apply({ nearFieldPlanets: !PRESET.nearFieldPlanets });
    for (const w of [base, changed]) {
      const hub = w.graph.nodes().reduce((a, b) => (w.graph.degree(a) >= w.graph.degree(b) ? a : b));
      const { x, y, z } = w.graph.getNodeAttributes(hub);
      field<{ target: THREE.Vector3 }>(w.scene, "controls").target.set(x, y, z);
      field<THREE.Camera>(w.scene, "camera").position.set(x, y - 10, z + 40);
      w.step(FRAMES);
    }
    expect(changed.drawn()).not.toBe(base.drawn());
  });

  it("Click burst, on selecting a note", async () => {
    const [base, changed] = [await woven(), await woven({ clickBurst: !PRESET.clickBurst })];
    for (const w of [base, changed]) {
      w.scene.impulse(w.graph.nodes()[0]);
      w.step(30);
    }
    expect(changed.drawn()).not.toBe(base.drawn());
  });

  it("Trace path", async () => {
    const [base, changed] = [await woven(), await woven()];
    const route = changed.layout.routes[0];
    changed.scene.setTrace([route.source, route.target]);
    base.step(30);
    changed.step(30);
    expect(changed.drawn()).not.toBe(base.drawn());
  });

  it("Hover pop: the hovered note swells", async () => {
    const w = await woven();
    const id = w.layout.routes[0].source;
    const size = () =>
      (field<THREE.BufferGeometry>(w.scene, "nodeGeom").getAttribute("a_size") as THREE.BufferAttribute).getX(w.graph.nodes().indexOf(id));
    const before = size();
    field<(id: string) => void>(w.scene, "setHoverPop").call(w.scene, id);
    w.step(30);
    expect(size()).toBeCloseTo(before * 1.3, 4);
  });

  it("Bundled strands stays off on every path to Woven, the Layout chip's too", async () => {
    // The chip patches only the layout, so the last look's edgeBundles comes
    // along; the drawer says the strands are the bundles, and the scene agrees.
    const chip = await woven({ ...VIBE_PRESETS.default, layout: "ribbon" });
    chip.apply({ edgeBundles: true });
    chip.step(FRAMES);
    expect(field<{ group: THREE.Group }>(chip.scene, "bundles").group.visible).toBe(false);
    const [base, left] = [await woven(), await woven({ edgeBundles: true })];
    base.step(FRAMES);
    left.step(FRAMES);
    expect(left.drawn()).toBe(base.drawn());
  });

  it("its cluster clouds sit on the clusters as laid out, not where the notes were before", async () => {
    // A baked layout syncs its positions once; the clouds refresh only every
    // 12th sync, so without the settle hook they stayed on the pre-layout
    // centroids (a grey haze mid-frame after the picker or a rebuild).
    const w = await woven();
    w.step(2);
    const nebula = field<{ sprites: THREE.Sprite[] }>(w.scene, "nebula");
    const centroids = field<() => THREE.Vector3[]>(nebula, "computeCentroids").call(nebula).slice(0, 8);
    expect(centroids.length).toBeGreaterThan(1);
    centroids.forEach((c, i) => {
      expect(nebula.sprites[i].visible).toBe(true);
      expect(nebula.sprites[i].position.distanceTo(new THREE.Vector3(c.x, c.y, c.z))).toBeLessThan(1e-3);
    });
  });

  it("Spaceship: leaving the flight restores Woven's z-up orbit", async () => {
    const w = await woven();
    w.scene.setFlyMode(true);
    w.scene.setFlyMode(false);
    expect(field<THREE.Camera>(w.scene, "camera").up.toArray()).toEqual([0, 0, 1]);
  });

  it("Reduced motion stops every motion and leaves the picture whole", async () => {
    reduced = true;
    const w = await woven();
    w.step(2);
    const still = w.drawn();
    w.step(FRAMES);
    expect(w.drawn()).toBe(still);
    expect(w.layer.group.visible).toBe(true);
  });
});

/** Distance from a point to the strand between two notes as drawn now. */
function offStrand(layer: WovenGraphLayer, s: string, t: string, point: THREE.Vector3): number {
  const strand = layer.strand(s, t);
  if (!strand) return Infinity;
  const segment = new THREE.Line3();
  const closest = new THREE.Vector3();
  let best = Infinity;
  for (let o = 0; o < strand.points.length; o += 6) {
    segment.start.fromArray(strand.points, o);
    segment.end.fromArray(strand.points, o + 3);
    best = Math.min(best, segment.closestPointToPoint(point, true, closest).distanceTo(point));
  }
  return best;
}
/** Distance from a point to the straight chord between two notes. */
function offChord(graph: VaultGraph, s: string, t: string, point: THREE.Vector3): number {
  const a = graph.getNodeAttributes(s);
  const b = graph.getNodeAttributes(t);
  const chord = new THREE.Line3(new THREE.Vector3(a.x, a.y, a.z), new THREE.Vector3(b.x, b.y, b.z));
  return chord.closestPointToPoint(point, true, new THREE.Vector3()).distanceTo(point);
}

describe("Woven's moving marks ride its strands, and its strands stay on their notes", () => {
  it("pulses travel along the strands, not the chords", async () => {
    const w = await woven();
    w.step(FRAMES);
    const pulse = field<PulseLayer>(w.scene, "pulse");
    expect(pulse.points.visible).toBe(true);
    const edges = field<[string, string][]>(w.scene, "edgePairs");
    const ride = field<Int32Array>(pulse, "edgeIdx");
    const position = pulse.points.geometry.getAttribute("position");
    const point = new THREE.Vector3();
    let bent = 0;
    for (let i = 0; i < field<number>(pulse, "count"); i++) {
      const [s, t] = edges[ride[i]];
      point.fromBufferAttribute(position, i);
      expect(offStrand(w.layer, s, t, point)).toBeLessThan(1e-3);
      if (offChord(w.graph, s, t, point) > 5) bent++;
    }
    expect(bent).toBeGreaterThan(10);
  });

  it("the click wave's sparks, the trace comet and the arrows ride the strands too", async () => {
    const w = await woven({ arrows: true });
    const hub = w.graph.nodes().reduce((a, b) => (w.graph.degree(a) >= w.graph.degree(b) ? a : b));
    w.scene.impulse(hub);
    const route = w.layout.routes.find((r) => r.source === hub || r.target === hub)!;
    w.scene.setTrace([route.source, route.target]);
    w.step(20);
    const point = new THREE.Vector3();

    const wave = field<WaveLayer>(w.scene, "wave");
    const plan = field<{ edges: { s: string; t: string }[] }>(wave, "plan");
    const sparks = wave.sparks.geometry;
    let lit = 0;
    plan.edges.forEach((edge, i) => {
      if (sparks.getAttribute("a_alpha").getX(i) <= 0) return;
      lit++;
      expect(offStrand(w.layer, edge.s, edge.t, point.fromBufferAttribute(sparks.getAttribute("position"), i))).toBeLessThan(1e-3);
    });
    expect(lit).toBeGreaterThan(0);

    const comet = field<TracePulse>(w.scene, "tracePulse").points.geometry.getAttribute("position");
    for (let i = 0; i < comet.count; i++)
      expect(offStrand(w.layer, route.source, route.target, point.fromBufferAttribute(comet, i))).toBeLessThan(1e-3);

    const arrows = field<THREE.InstancedMesh>(w.scene, "arrows");
    const edges = field<[string, string][]>(w.scene, "edgePairs");
    const matrix = new THREE.Matrix4();
    edges.forEach(([s, t], i) => {
      arrows.getMatrixAt(i, matrix);
      expect(offStrand(w.layer, s, t, point.setFromMatrixPosition(matrix))).toBeLessThan(1e-3);
    });
  });

  it("strands end on their notes while the scene moves; the notes do not drift off them", async () => {
    const w = await woven();
    const linked = new Map(w.graph.filterNodes((id) => w.graph.degree(id) > 0).map((id) => [id, { ...w.graph.getNodeAttributes(id) }]));
    const unlinked = new Map(w.graph.filterNodes((id) => w.graph.degree(id) === 0).map((id) => [id, { ...w.graph.getNodeAttributes(id) }]));
    const camera = field<THREE.Camera>(w.scene, "camera").position.clone();
    w.step(FRAMES);
    // The scene moved: the camera swayed and the unlinked notes turned.
    expect(field<THREE.Camera>(w.scene, "camera").position.distanceTo(camera)).toBeGreaterThan(1);
    expect(unlinked.size).toBeGreaterThan(1);
    for (const [id, was] of unlinked)
      expect(Math.hypot(w.graph.getNodeAttribute(id, "x") - was.x, w.graph.getNodeAttribute(id, "y") - was.y)).toBeGreaterThan(0.1);
    // A linked note stays where its strands were routed to it.
    for (const [id, was] of linked) expect(w.graph.getNodeAttribute(id, "x")).toBe(was.x);
    // The notes draw where the graph has them (no GPU drift)…
    expect(field<THREE.ShaderMaterial>(w.scene, "nodeMat").uniforms.u_driftAmp.value).toBe(0);
    const position = field<THREE.BufferGeometry>(w.scene, "nodeGeom").getAttribute("position");
    w.graph.nodes().forEach((id, i) => {
      const a = w.graph.getNodeAttributes(id);
      expect([position.getX(i), position.getY(i), position.getZ(i)]).toEqual([
        expect.closeTo(a.x, 3), expect.closeTo(a.y, 3), expect.closeTo(a.z, 3),
      ]);
    });
    // …and each strand starts and ends on them.
    for (const route of w.layout.routes) {
      const strand = w.layer.strand(route.source, route.target)!;
      const start = new THREE.Vector3().fromArray(strand.points, 0);
      const end = new THREE.Vector3().fromArray(strand.points, strand.points.length - 3);
      const a = w.graph.getNodeAttributes(route.source);
      const b = w.graph.getNodeAttributes(route.target);
      expect(start.distanceTo(new THREE.Vector3(a.x, a.y, a.z))).toBeLessThan(1e-3);
      expect(end.distanceTo(new THREE.Vector3(b.x, b.y, b.z))).toBeLessThan(1e-3);
    }
  });

  it("the idle orbit sways the web inside the frame instead of turning it off the screen", async () => {
    const w = await woven();
    const camera = field<THREE.PerspectiveCamera>(w.scene, "camera");
    const onScreen = (point: THREE.Vector3): THREE.Vector3 => {
      camera.updateMatrixWorld();
      return point.clone().project(camera);
    };
    let rim = new THREE.Vector3();
    let reach = 0;
    w.layer.forEachFramePoint((point) => {
      const x = Math.abs(onScreen(point).x);
      if (x > reach) [reach, rim] = [x, point.clone()];
    });
    const landed = onScreen(rim);
    // One full sway at the auto-rotate speed: 60 s × WOVEN_SWAY / 0.12 = 40 s.
    let widest = 0;
    let swung = 0;
    for (let second = 0; second < 40; second++) {
      w.step(60);
      w.layer.forEachFramePoint((point) => {
        const p = onScreen(point);
        widest = Math.max(widest, Math.abs(p.x), Math.abs(p.y));
      });
      swung = Math.max(swung, onScreen(rim).distanceTo(landed));
    }
    // The rim note travels tens of pixels (NDC × half the 960 px canvas)…
    expect(swung * 480).toBeGreaterThan(20);
    // …the web never leaves the frame, and the sway comes back to the landing.
    expect(widest).toBeLessThan(1);
    expect(onScreen(rim).distanceTo(landed)).toBeLessThan(swung / 4);
  });
});
