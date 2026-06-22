// DEV-ONLY hero render: a ~14k-star SPIRAL GALAXY in Memex's glow-star style,
// for the README hero image (captured via Playwright). Never bundled into the
// app (no entry imports it; big-graph.html is dev-served only).
//
// This is a galaxy, not a network diagram: a dense warm bulge, two logarithmic
// spiral arms of blue-white stars dotted with pink star-forming regions, and a
// faint outer halo — over dark space, with bloom from the glow node program.
// Edges are intentionally omitted: galaxies are points of light, and an edge
// web reads as a hairball, not a galaxy.
import Graph from "graphology";
import Sigma from "sigma";
import { fitViewportToNodes } from "@sigma/utils";
import NodeGlowProgram from "./lib/graphNodeGlow";

const R = 3000; // galaxy radius in world units
const N_BULGE = 5200;
const N_ARMS = 9500;
const N_HALO = 1600;
const N_FIELD = 1100; // faint deep-space field stars scattered across the frame
const ARMS = 2;
const TURNS = 1.15; // how far each arm winds (in turns) across the disk

// Standard normal (Box–Muller).
function randn(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Radius-based star colour: warm white core -> golden -> blue-white arms ->
// faint blue halo. Returned with an alpha that fades outward for depth.
function starColor(f: number): string {
  // f: 0 at core, 1 at rim.
  const stops: [number, [number, number, number]][] = [
    [0.0, [255, 246, 222]],
    [0.12, [255, 226, 168]],
    [0.3, [206, 224, 255]],
    [0.55, [159, 182, 240]],
    [1.0, [96, 112, 162]],
  ];
  let lo = stops[0], hi = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (f >= stops[i][0] && f <= stops[i + 1][0]) {
      lo = stops[i];
      hi = stops[i + 1];
      break;
    }
  }
  const t = (f - lo[0]) / Math.max(1e-6, hi[0] - lo[0]);
  const r = Math.round(lo[1][0] + (hi[1][0] - lo[1][0]) * t);
  const g = Math.round(lo[1][1] + (hi[1][1] - lo[1][1]) * t);
  const b = Math.round(lo[1][2] + (hi[1][2] - lo[1][2]) * t);
  const alpha = (0.95 - 0.5 * f).toFixed(2); // core bright, rim faint
  return `rgba(${r},${g},${b},${alpha})`;
}

function build(): { g: Graph; focusId: string } {
  const g = new Graph({ type: "undirected" });
  let id = 0;
  const add = (x: number, y: number, size: number, color: string): string => {
    const key = `s${id++}`;
    g.addNode(key, { x, y, size, color });
    return key;
  };

  // --- Central bulge: dense, bright, warm. Blooms to a white-gold core. ---
  for (let i = 0; i < N_BULGE; i++) {
    const rr = Math.abs(randn()) * R * 0.08;
    const a = Math.random() * Math.PI * 2;
    const f = Math.min(1, rr / R);
    const size = Math.max(1.1, 3.6 - f * 6 + Math.abs(randn()) * 0.7);
    add(Math.cos(a) * rr, Math.sin(a) * rr, size, starColor(f * 0.4));
  }
  // A few big bright giants right at the centre for a strong core bloom.
  for (let i = 0; i < 40; i++) {
    const rr = Math.abs(randn()) * R * 0.025;
    const a = Math.random() * Math.PI * 2;
    add(Math.cos(a) * rr, Math.sin(a) * rr, 7 + Math.random() * 6, "rgba(255,248,228,1)");
  }

  // --- Spiral arms: log spiral, blue-white, with pink star-forming regions. ---
  for (let i = 0; i < N_ARMS; i++) {
    const arm = i % ARMS;
    // bias radius inward so density falls with distance
    const u = Math.pow(Math.random(), 0.55);
    const r = R * (0.04 + 0.96 * u);
    const f = r / R;
    const phase = (arm / ARMS) * Math.PI * 2;
    // logarithmic winding + angular scatter (arms widen outward)
    const theta = phase + TURNS * 2 * Math.PI * Math.log(1 + r / R) / Math.log(2) + randn() * (0.10 + 0.10 * f);
    const rJit = r + randn() * R * 0.02;
    const x = Math.cos(theta) * rJit;
    const y = Math.sin(theta) * rJit;
    const giant = Math.random() < 0.015;
    let size = Math.max(0.7, (1 - f) * 2.0 + 0.6 + Math.abs(randn()) * 0.4);
    if (giant) size += 2.5 + Math.random() * 3;
    // ~6% of arm stars are pink/red HII regions for colour pop.
    const color = Math.random() < 0.06
      ? `rgba(255,${150 + Math.floor(Math.random() * 40)},${190 + Math.floor(Math.random() * 30)},${(0.85 - 0.4 * f).toFixed(2)})`
      : starColor(0.3 + f * 0.7);
    add(x, y, size, color);
  }

  // --- Faint halo: sparse, dim, scattered field stars around the disk. ---
  for (let i = 0; i < N_HALO; i++) {
    const r = R * (0.2 + Math.random() * 1.05);
    const a = Math.random() * Math.PI * 2;
    add(Math.cos(a) * r, Math.sin(a) * r, 0.6 + Math.random() * 0.8, starColor(Math.min(1, r / R)));
  }

  // --- Deep-space field: tiny faint stars across the whole frame for depth. ---
  for (let i = 0; i < N_FIELD; i++) {
    const r = R * (0.1 + Math.random() * 1.7);
    const a = Math.random() * Math.PI * 2;
    const dim = (0.18 + Math.random() * 0.25).toFixed(2);
    add(Math.cos(a) * r, Math.sin(a) * r, 0.5 + Math.random() * 0.6, `rgba(200,212,240,${dim})`);
  }

  // --- Focus cluster: a tight knot of bright stars on an arm, so the GIF's
  // zoom-in reveals individual clustered nodes (a "community"). ---
  const fr = R * 0.58;
  const ftheta = (TURNS * 2 * Math.PI * Math.log(1 + fr / R)) / Math.log(2);
  const fcx = Math.cos(ftheta) * fr;
  const fcy = Math.sin(ftheta) * fr;
  let focusId = "";
  for (let i = 0; i < 60; i++) {
    const a = Math.random() * Math.PI * 2;
    const rr = Math.abs(randn()) * R * 0.018;
    const k = add(
      fcx + Math.cos(a) * rr,
      fcy + Math.sin(a) * rr,
      2 + Math.abs(randn()) * 2.5,
      Math.random() < 0.5 ? "rgba(206,224,255,0.95)" : "rgba(255,210,170,0.95)",
    );
    if (i === 0) focusId = k;
  }

  return { g, focusId };
}

const container = document.getElementById("app");
if (container) {
  const { g: graph, focusId } = build();
  const renderer = new Sigma(graph, container as HTMLElement, {
    defaultNodeType: "glow",
    nodeProgramClasses: { glow: NodeGlowProgram },
    renderLabels: false,
    renderEdgeLabels: false,
    zIndex: false,
    enableEdgeEvents: false,
  });
  fitViewportToNodes(renderer, graph.nodes(), { animate: false });
  const cam = renderer.getCamera();
  cam.setState({ ratio: cam.getState().ratio * 0.78 });

  // Animation hook for the GIF capture script. __frame(t), t in [0,1]:
  // continuous rotation (full turn so it loops) + a boomerang zoom from the
  // wide galaxy into the focus star cluster and back out.
  const base = cam.getState();
  const focus = renderer.getNodeDisplayData(focusId) ?? { x: base.x, y: base.y };
  const w = window as unknown as {
    __frame?: (t: number) => void;
    __graphReady?: boolean;
    __nodeCount?: number;
  };
  w.__frame = (t: number): void => {
    const turn = t * Math.PI * 2; // full rotation -> seamless loop
    const tri = t < 0.5 ? t * 2 : (1 - t) * 2; // 0 -> 1 -> 0
    const k = tri * tri * (3 - 2 * tri); // smoothstep ease
    cam.setState({
      x: base.x + (focus.x - base.x) * k,
      y: base.y + (focus.y - base.y) * k,
      ratio: base.ratio * (1 - k) + base.ratio * 0.05 * k,
      angle: turn,
    });
  };
  w.__graphReady = true;
  w.__nodeCount = graph.order;
  console.info("[bigGraph] rendered galaxy:", graph.order, "stars; focus", focusId);
}
