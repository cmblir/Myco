// Canvas-2D renderer for the Survey graph. Replaces the three.js GraphScene
// (5,120 lines, bloom, 20 ambient layers): one <canvas>, one continuous rAF
// loop, nodes coloured/sized by graphEncoding, edges, a 64-label cap with a
// gesture-time LOD drop, cluster hulls + dashed bridges under the "clusters"
// question, hover / click / drag / wheel / keyboard.
//
// Positions arrive from the sim worker (applyPositions, node order); styles
// arrive as encoding targets (restyle) and are eased toward per frame, so a
// question switch cross-fades instead of snapping. The loop never idles when
// static — the micro-drift is the owner-requested "living" motion.
import { hexToRgb01, type VaultGraph } from "./graphData";
import {
  RING_GAP,
  RING_MAPLESS,
  RING_NONE,
  RING_SELECTED,
  RING_UNRESOLVED,
  type Encoding,
} from "./graphEncoding";
import type { GraphTheme } from "./graphTheme";
import type { LayoutMetrics } from "./layoutMetrics";

/** Labels drawn at rest — measured cap carried over from the 3D scene. */
export const LABEL_CAP = 64;
/** Labels and hull titles stay off this long after the last gesture (LOD). */
const GESTURE_MS = 160;
/** Style ease per frame (~320 ms to settle at 60 fps). */
const LERP = 0.16;
const ZOOM_MIN = 0.06;
const ZOOM_MAX = 3.2;
const LABEL_MAX_CHARS = 22;
// Screen-space declutter cell. Two labels in the same cell would overlap, so
// only the bigger node (the list is radius-sorted) gets to draw one.
const LABEL_CELL_W = 96;
const LABEL_CELL_H = 16;
// ponytail: the per-node glow is a radial gradient per node per frame; above
// this many nodes draw flat discs only (hover/selection keep their glow).
const GLOW_MAX_NODES = 1500;
// ponytail: above this many edges they share one path and one alpha instead
// of per-edge alpha from the endpoints' encodings.
const EDGE_BATCH_MIN = 5000;
// ponytail: hit-testing is a linear scan over nodes per pointermove; a
// quadtree pays off past a few thousand nodes.

export interface Hull {
  community: number;
  /** Full caption, already localised ("트랜스포머 · 지도 없음"). */
  title: string;
  mapless: boolean;
}

export interface CanvasCallbacks {
  onNodeClick(id: string): void;
  /** Enter / double-click — open the note. */
  onNodeActivate(id: string): void;
  onVoidClick(): void;
  /** Hovered node (or null) with the pointer's canvas-relative position. */
  onHover(id: string | null, sx: number, sy: number): void;
  onDragStart(id: string): void;
  /** World coordinates. */
  onDrag(id: string, x: number, y: number): void;
  onDragEnd(id: string): void;
  /** The user zoomed or panned — stop auto-fitting on settle. */
  onTakeover(): void;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function rgb(hex: string, fallback: Rgb): Rgb {
  const c = hexToRgb01(hex);
  return c ? { r: c.r * 255, g: c.g * 255, b: c.b * 255 } : fallback;
}

const GREY: Rgb = { r: 140, g: 140, b: 140 };

export class GraphCanvas {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly cb: CanvasCallbacks;
  private theme: GraphTheme;

  private readonly ids: string[];
  private readonly index = new Map<string, number>();
  private readonly n: number;
  // World positions (from the sim) and last drawn screen positions (hit tests).
  private readonly x: Float32Array;
  private readonly y: Float32Array;
  private readonly sx: Float32Array;
  private readonly sy: Float32Array;
  // Current vs target style, eased per frame.
  private readonly r: Float32Array;
  private readonly tr: Float32Array;
  private readonly a: Float32Array;
  private readonly ta: Float32Array;
  private readonly c: Float32Array; // rgb triples, current
  private readonly tc: Float32Array; // rgb triples, target
  private readonly ring: Uint8Array;
  private readonly ghost: Uint8Array;
  private readonly community: Int32Array;
  private readonly drift: Float32Array;
  private readonly labels: string[];
  private readonly edges: Uint32Array;

  private W = 0;
  private H = 0;
  private dpr = 1;
  private view = { x: 0, y: 0, k: 1 };
  private target = { x: 0, y: 0, k: 1 };
  private hover = -1;
  private selected = -1;
  private hulls: Hull[] | null = null;
  private bridges: [number, number][] = [];
  private gestureUntil = 0;
  private drag: { i: number; started: boolean; sx: number; sy: number } | null = null;
  private pan: { sx: number; sy: number; moved: boolean } | null = null;
  private raf = 0;
  private disposed = false;
  private readonly reduced: boolean;
  private readonly ro: ResizeObserver;
  private bgGrad: CanvasGradient | null = null;
  private glowGrad: CanvasGradient | null = null;
  private gradKey = "";

  constructor(
    container: HTMLElement,
    graph: VaultGraph,
    theme: GraphTheme,
    cb: CanvasCallbacks,
    ariaLabel: string,
  ) {
    this.cb = cb;
    this.theme = theme;
    this.reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    this.ids = graph.nodes();
    this.n = this.ids.length;
    this.ids.forEach((id, i) => this.index.set(id, i));
    const n = this.n;
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.sx = new Float32Array(n);
    this.sy = new Float32Array(n);
    this.r = new Float32Array(n).fill(4);
    this.tr = new Float32Array(n).fill(4);
    this.a = new Float32Array(n).fill(1);
    this.ta = new Float32Array(n).fill(1);
    this.c = new Float32Array(n * 3).fill(140);
    this.tc = new Float32Array(n * 3).fill(140);
    this.ring = new Uint8Array(n);
    this.ghost = new Uint8Array(n);
    this.community = new Int32Array(n);
    this.drift = new Float32Array(n);
    this.labels = new Array<string>(n);
    this.ids.forEach((id, i) => {
      const at = graph.getNodeAttributes(id);
      this.x[i] = at.x;
      this.y[i] = at.y;
      this.ghost[i] = id.startsWith("ghost:") ? 1 : 0;
      this.community[i] = at.community;
      this.labels[i] = at.label;
      // Seeded per node so the drift phase is stable across rebuilds.
      let h = 2166136261;
      for (let k = 0; k < id.length; k++) h = Math.imul(h ^ id.charCodeAt(k), 16777619);
      this.drift[i] = ((h >>> 0) % 1000) / 1000 * Math.PI * 2;
    });
    const pairs: number[] = [];
    graph.forEachEdge((_e, _a, s, t) => {
      const si = this.index.get(s);
      const ti = this.index.get(t);
      if (si != null && ti != null) pairs.push(si, ti);
    });
    this.edges = Uint32Array.from(pairs);

    this.canvas = document.createElement("canvas");
    this.canvas.className = "sv-canvas__el";
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute("role", "application");
    this.canvas.setAttribute("aria-label", ariaLabel);
    container.appendChild(this.canvas);
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d context unavailable");
    this.ctx = ctx;

    this.ro = new ResizeObserver(() => this.resize(container));
    this.ro.observe(container);
    this.resize(container);

    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointerleave", this.onPointerLeave);
    this.canvas.addEventListener("dblclick", this.onDblClick);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.canvas.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("pointerup", this.onPointerUp);
  }

  // ── public API ────────────────────────────────────────────────────────────

  /** Worker tick: x/y/z triples in node order. The dragged node keeps the
   * pointer's position until the worker confirms the pin. */
  applyPositions(pos: Float32Array): void {
    const drag = this.drag?.started ? this.drag.i : -1;
    for (let i = 0; i < this.n && i * 3 + 1 < pos.length; i++) {
      if (i === drag) continue;
      this.x[i] = pos[i * 3];
      this.y[i] = pos[i * 3 + 1];
    }
  }

  /** New encoding targets for every node; the loop eases toward them. */
  restyle(encode: (id: string, i: number) => Encoding): void {
    for (let i = 0; i < this.n; i++) {
      const e = encode(this.ids[i], i);
      this.tr[i] = e.radius;
      this.ta[i] = e.alpha;
      const col = rgb(e.color, GREY);
      this.tc[i * 3] = col.r;
      this.tc[i * 3 + 1] = col.g;
      this.tc[i * 3 + 2] = col.b;
      this.ring[i] = e.ring;
    }
    if (this.reduced) this.snapStyles();
  }

  setTheme(theme: GraphTheme): void {
    this.theme = theme;
    this.gradKey = "";
  }

  setSelected(id: string | null): void {
    this.selected = id == null ? -1 : (this.index.get(id) ?? -1);
  }

  /** Cluster hulls (clusters question) or null to hide them. */
  setHulls(hulls: Hull[] | null): void {
    this.hulls = hulls;
  }

  /** Community pairs to join with a dashed bridge (clusters question). */
  setBridges(pairs: [number, number][]): void {
    this.bridges = pairs;
  }

  /** Frame the layout: from the settle metrics when given, else from the
   * visible nodes' bounding box. */
  fit(metrics?: LayoutMetrics, animate = true): void {
    let cx = 0;
    let cy = 0;
    let radius = 1;
    if (metrics && metrics.n > 0) {
      cx = metrics.cx;
      cy = metrics.cy;
      radius = metrics.radius;
    } else {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      let seen = 0;
      for (let i = 0; i < this.n; i++) {
        if (this.ta[i] < 0.02) continue;
        seen++;
        x0 = Math.min(x0, this.x[i]);
        y0 = Math.min(y0, this.y[i]);
        x1 = Math.max(x1, this.x[i]);
        y1 = Math.max(y1, this.y[i]);
      }
      if (seen === 0) return;
      cx = (x0 + x1) / 2;
      cy = (y0 + y1) / 2;
      radius = Math.max(1, Math.hypot(x1 - x0, y1 - y0) / 2);
    }
    const side = Math.min(this.W, this.H) || 1;
    this.target = {
      x: -cx,
      y: -cy,
      k: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, (side * 0.43) / radius)),
    };
    if (!animate || this.reduced) this.view = { ...this.target };
  }

  /** Centre the view on a node (list / keyboard selection). */
  focusNode(id: string): void {
    const i = this.index.get(id);
    if (i == null) return;
    this.target = { x: -this.x[i], y: -this.y[i], k: Math.max(this.target.k, 1.1) };
    if (this.reduced) this.view = { ...this.target };
  }

  zoomBy(f: number): void {
    this.target.k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this.target.k * f));
    this.cb.onTakeover();
  }

  /** Last drawn screen position of a node (tooltips), or null when hidden. */
  screenPositionOf(id: string): { x: number; y: number } | null {
    const i = this.index.get(id);
    if (i == null || this.a[i] < 0.02) return null;
    return { x: this.sx[i], y: this.sy[i] };
  }

  start(): void {
    if (this.raf) return;
    const tick = (ts: number): void => {
      if (this.disposed) return;
      this.step(ts / 1000);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    window.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.remove();
  }

  // ── frame ─────────────────────────────────────────────────────────────────

  private resize(container: HTMLElement): void {
    const rect = container.getBoundingClientRect();
    this.W = Math.max(1, rect.width);
    this.H = Math.max(1, rect.height);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.W * this.dpr);
    this.canvas.height = Math.round(this.H * this.dpr);
    this.canvas.style.width = `${this.W}px`;
    this.canvas.style.height = `${this.H}px`;
    this.gradKey = "";
  }

  private snapStyles(): void {
    this.r.set(this.tr);
    this.a.set(this.ta);
    this.c.set(this.tc);
  }

  private step(t: number): void {
    // View tween.
    const vk = this.reduced ? 1 : 0.18;
    this.view.x += (this.target.x - this.view.x) * vk;
    this.view.y += (this.target.y - this.view.y) * vk;
    this.view.k += (this.target.k - this.view.k) * vk;
    // Style ease.
    if (!this.reduced) {
      for (let i = 0; i < this.n; i++) {
        this.r[i] += (this.tr[i] - this.r[i]) * LERP;
        this.a[i] += (this.ta[i] - this.a[i]) * LERP;
      }
      for (let j = 0; j < this.c.length; j++) this.c[j] += (this.tc[j] - this.c[j]) * LERP;
    }
    this.draw(t);
  }

  private gradients(): void {
    const th = this.theme;
    const key = `${this.W}x${this.H}|${th.canvasCenter}|${th.live}`;
    if (key === this.gradKey) return;
    this.gradKey = key;
    const ctx = this.ctx;
    const cx = this.W / 2;
    const cy = this.H * 0.46;
    this.bgGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.hypot(this.W, this.H) * 0.55);
    this.bgGrad.addColorStop(0, th.canvasCenter);
    this.bgGrad.addColorStop(1, th.canvasEdge);
    const live = rgb(th.live, { r: 167, g: 139, b: 250 });
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.min(this.W, this.H) * 0.62);
    g.addColorStop(0, `rgba(${live.r},${live.g},${live.b},${(0.1 * th.glowK).toFixed(3)})`);
    g.addColorStop(1, `rgba(${live.r},${live.g},${live.b},0)`);
    this.glowGrad = g;
  }

  private draw(t: number): void {
    const ctx = this.ctx;
    const th = this.theme;
    const { W, H } = this;
    const k = this.view.k;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    this.gradients();
    if (this.bgGrad) {
      ctx.fillStyle = this.bgGrad;
      ctx.fillRect(0, 0, W, H);
    }
    if (this.glowGrad) {
      ctx.fillStyle = this.glowGrad;
      ctx.fillRect(0, 0, W, H);
    }
    const gesturing = performance.now() < this.gestureUntil || this.drag?.started === true;
    const drift = this.reduced || this.n > 3000 ? 0 : 1;
    const liveRgb = rgb(th.live, { r: 167, g: 139, b: 250 });
    const live = `${liveRgb.r},${liveRgb.g},${liveRgb.b}`;

    // Screen positions (+ micro-drift, render-only).
    for (let i = 0; i < this.n; i++) {
      const wob = drift * Math.sin(t * 0.55 + this.drift[i]) * 0.9;
      this.sx[i] = W / 2 + (this.x[i] + this.view.x) * k + wob;
      this.sy[i] = H / 2 + (this.y[i] + this.view.y) * k + wob * 0.6;
    }

    // Cluster hulls — "clusters" question only.
    if (this.hulls && this.hulls.length > 0) this.drawHulls(gesturing);

    // Bridges between cluster centroids.
    if (this.bridges.length > 0) this.drawBridges(live);

    // Edges.
    const m = this.edges.length / 2;
    const hov = this.hover;
    if (m > EDGE_BATCH_MIN) {
      ctx.beginPath();
      for (let e = 0; e < m; e++) {
        const s = this.edges[e * 2];
        const d = this.edges[e * 2 + 1];
        if (this.a[s] < 0.02 || this.a[d] < 0.02) continue;
        ctx.moveTo(this.sx[s], this.sy[s]);
        ctx.lineTo(this.sx[d], this.sy[d]);
      }
      ctx.strokeStyle = `rgba(${th.edgeRgb},0.06)`;
      ctx.lineWidth = 1;
      ctx.stroke();
    } else {
      ctx.lineWidth = 1;
      for (let e = 0; e < m; e++) {
        const s = this.edges[e * 2];
        const d = this.edges[e * 2 + 1];
        const lit = Math.min(this.a[s], this.a[d]);
        if (lit < 0.02 && s !== hov && d !== hov) continue;
        ctx.beginPath();
        ctx.moveTo(this.sx[s], this.sy[s]);
        ctx.lineTo(this.sx[d], this.sy[d]);
        if (hov >= 0 && (s === hov || d === hov)) {
          ctx.strokeStyle = `rgba(${live},0.7)`;
          ctx.lineWidth = 1.4;
        } else {
          ctx.strokeStyle = `rgba(${th.edgeRgb},${(0.03 + lit * 0.07).toFixed(3)})`;
          ctx.lineWidth = 1;
        }
        ctx.stroke();
      }
    }

    // Nodes.
    const glowAll = this.n <= GLOW_MAX_NODES;
    const warn = th.warn;
    const dim = th.dim;
    const candidates: number[] = [];
    for (let i = 0; i < this.n; i++) {
      const a = this.a[i];
      if (a < 0.02) continue;
      const x = this.sx[i];
      const y = this.sy[i];
      if (x < -40 || y < -40 || x > W + 40 || y > H + 40) continue;
      const cr = this.c[i * 3] | 0;
      const cg = this.c[i * 3 + 1] | 0;
      const cbl = this.c[i * 3 + 2] | 0;
      const rr = Math.max(1.6, this.r[i] * Math.min(1.6, Math.max(0.7, Math.sqrt(k))));
      if (this.ghost[i]) {
        ctx.beginPath();
        ctx.arc(x, y, Math.max(3, rr), 0, 6.283);
        ctx.setLineDash([2.5, 2.5]);
        ctx.strokeStyle = `rgba(${rgbOf(dim)},${a.toFixed(2)})`;
        ctx.lineWidth = 1.3;
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        if (i === this.selected) {
          const hr = rr + 22;
          const h = ctx.createRadialGradient(x, y, rr, x, y, hr);
          h.addColorStop(0, `rgba(${live},0.42)`);
          h.addColorStop(0.5, `rgba(${live},0.14)`);
          h.addColorStop(1, `rgba(${live},0)`);
          ctx.fillStyle = h;
          ctx.beginPath();
          ctx.arc(x, y, hr, 0, 6.283);
          ctx.fill();
        }
        if (glowAll || i === hov || i === this.selected) {
          // Glow radius = node +30% (+6px) — the brief's "노드 글로우 반경 +30%".
          const gr = rr * 1.3 + 6;
          const g = ctx.createRadialGradient(x, y, rr * 0.5, x, y, gr);
          const ga = 0.5 * Math.pow(a, 1.5) * th.glowK;
          g.addColorStop(0, `rgba(${cr},${cg},${cbl},${ga.toFixed(3)})`);
          g.addColorStop(1, `rgba(${cr},${cg},${cbl},0)`);
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(x, y, gr, 0, 6.283);
          ctx.fill();
        }
        ctx.globalAlpha = a;
        ctx.beginPath();
        ctx.arc(x, y, rr, 0, 6.283);
        ctx.fillStyle = `rgb(${cr},${cg},${cbl})`;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      // Ring — the shape channel, so no fact rides on colour alone.
      const ring = this.ring[i];
      if (ring !== RING_NONE) {
        ctx.beginPath();
        ctx.arc(x, y, rr + 4.5, 0, 6.283);
        ctx.lineWidth = ring === RING_SELECTED ? 2 : 1.2;
        if (ring === RING_GAP) {
          ctx.setLineDash([3, 3]);
          ctx.strokeStyle = warn;
        } else if (ring === RING_UNRESOLVED) {
          ctx.setLineDash([2, 3]);
          ctx.strokeStyle = dim;
        } else if (ring === RING_MAPLESS) {
          ctx.setLineDash([1.5, 3.5]);
          ctx.strokeStyle = `rgba(${rgbOf(warn)},0.7)`;
        } else {
          // RING_FRESH, RING_SELECTED, RING_SEARCH_HIT — solid live.
          ctx.setLineDash([]);
          ctx.strokeStyle = th.live;
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (a > 0.5) candidates.push(i);
    }

    // Labels — capped at rest, none during gestures (LOD).
    if (!gesturing && candidates.length > 0) {
      candidates.sort((p, q) => this.r[q] - this.r[p]);
      ctx.font = `500 11px ${th.font}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      const taken = new Set<number>();
      let drawn = 0;
      for (let j = 0; j < candidates.length && drawn < LABEL_CAP; j++) {
        const i = candidates[j];
        const cell =
          Math.round(this.sx[i] / LABEL_CELL_W) * 4096 + Math.round(this.sy[i] / LABEL_CELL_H);
        if (taken.has(cell)) continue;
        taken.add(cell);
        drawn++;
        const txt =
          this.labels[i].length > LABEL_MAX_CHARS
            ? `${this.labels[i].slice(0, LABEL_MAX_CHARS - 1)}…`
            : this.labels[i];
        const a = Math.min(1, this.a[i] * 0.95);
        ctx.fillStyle = this.ghost[i]
          ? `rgba(${rgbOf(dim)},${a.toFixed(2)})`
          : `rgba(${this.c[i * 3] | 0},${this.c[i * 3 + 1] | 0},${this.c[i * 3 + 2] | 0},${a.toFixed(2)})`;
        ctx.fillText(txt, this.sx[i], this.sy[i] + Math.max(2, this.r[i]) + 5);
      }
    }
  }

  private drawHulls(gesturing: boolean): void {
    const ctx = this.ctx;
    const th = this.theme;
    const box = new Map<number, { x0: number; y0: number; x1: number; y1: number; c: number }>();
    for (let i = 0; i < this.n; i++) {
      if (this.ghost[i] || this.a[i] < 0.02) continue;
      const cm = this.community[i];
      if (cm < 0) continue;
      let b = box.get(cm);
      if (!b) box.set(cm, (b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, c: 0 }));
      b.x0 = Math.min(b.x0, this.sx[i]);
      b.y0 = Math.min(b.y0, this.sy[i]);
      b.x1 = Math.max(b.x1, this.sx[i]);
      b.y1 = Math.max(b.y1, this.sy[i]);
      b.c++;
    }
    const warn = rgbOf(th.warn);
    const ok = rgbOf(th.ok);
    ctx.font = `500 11px ${th.font}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    for (const h of this.hulls!) {
      const b = box.get(h.community);
      if (!b || b.c < 2) continue;
      const pad = 17;
      const x = b.x0 - pad;
      const y = b.y0 - pad;
      const w = b.x1 - b.x0 + pad * 2;
      const hh = b.y1 - b.y0 + pad * 2;
      const rr = Math.min(26, w / 2, hh / 2);
      ctx.beginPath();
      ctx.moveTo(x + rr, y);
      ctx.arcTo(x + w, y, x + w, y + hh, rr);
      ctx.arcTo(x + w, y + hh, x, y + hh, rr);
      ctx.arcTo(x, y + hh, x, y, rr);
      ctx.arcTo(x, y, x + w, y, rr);
      ctx.closePath();
      ctx.fillStyle = h.mapless ? `rgba(${warn},0.07)` : `rgba(${ok},0.06)`;
      ctx.fill();
      ctx.setLineDash(h.mapless ? [4, 4] : []);
      ctx.strokeStyle = h.mapless ? `rgba(${warn},0.42)` : `rgba(${ok},0.34)`;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
      if (!gesturing) {
        ctx.fillStyle = h.mapless ? th.warn : th.ink3;
        ctx.fillText(h.title, x + 3, y - 5);
      }
    }
  }

  private drawBridges(live: string): void {
    const ctx = this.ctx;
    const cx = new Map<number, number>();
    const cy = new Map<number, number>();
    const cn = new Map<number, number>();
    const wanted = new Set<number>();
    for (const [a, b] of this.bridges) {
      wanted.add(a);
      wanted.add(b);
    }
    for (let i = 0; i < this.n; i++) {
      const cm = this.community[i];
      if (!wanted.has(cm) || this.a[i] < 0.02) continue;
      cx.set(cm, (cx.get(cm) ?? 0) + this.sx[i]);
      cy.set(cm, (cy.get(cm) ?? 0) + this.sy[i]);
      cn.set(cm, (cn.get(cm) ?? 0) + 1);
    }
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = `rgba(${live},0.45)`;
    ctx.lineWidth = 1.2;
    for (const [a, b] of this.bridges) {
      const na = cn.get(a);
      const nb = cn.get(b);
      if (!na || !nb) continue;
      ctx.beginPath();
      ctx.moveTo(cx.get(a)! / na, cy.get(a)! / na);
      ctx.lineTo(cx.get(b)! / nb, cy.get(b)! / nb);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  // ── interaction ───────────────────────────────────────────────────────────

  private local(e: PointerEvent | MouseEvent | WheelEvent): { mx: number; my: number } {
    const r = this.canvas.getBoundingClientRect();
    return { mx: e.clientX - r.left, my: e.clientY - r.top };
  }

  private toWorld(mx: number, my: number): { x: number; y: number } {
    return {
      x: (mx - this.W / 2) / this.view.k - this.view.x,
      y: (my - this.H / 2) / this.view.k - this.view.y,
    };
  }

  private nodeAt(mx: number, my: number): number {
    let best = -1;
    let bd = Infinity;
    for (let i = 0; i < this.n; i++) {
      if (this.a[i] < 0.05) continue;
      const d = Math.hypot(this.sx[i] - mx, this.sy[i] - my);
      if (d < Math.max(9, this.r[i] + 6) && d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }

  private gesture(): void {
    this.gestureUntil = performance.now() + GESTURE_MS;
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    const { mx, my } = this.local(e);
    if (this.drag) {
      const d = this.drag;
      if (!d.started) {
        if (Math.hypot(mx - d.sx, my - d.sy) < 3) return;
        d.started = true;
        this.cb.onDragStart(this.ids[d.i]);
      }
      this.gesture();
      const w = this.toWorld(mx, my);
      this.x[d.i] = w.x;
      this.y[d.i] = w.y;
      this.cb.onDrag(this.ids[d.i], w.x, w.y);
      return;
    }
    if (this.pan) {
      this.gesture();
      this.pan.moved = true;
      this.view.x += (mx - this.pan.sx) / this.view.k;
      this.view.y += (my - this.pan.sy) / this.view.k;
      this.target.x = this.view.x;
      this.target.y = this.view.y;
      this.pan.sx = mx;
      this.pan.sy = my;
      return;
    }
    const i = this.nodeAt(mx, my);
    this.canvas.style.cursor = i >= 0 ? "pointer" : "grab";
    if (i !== this.hover || i >= 0) {
      this.hover = i;
      this.cb.onHover(i >= 0 ? this.ids[i] : null, mx, my);
    }
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    this.canvas.setPointerCapture(e.pointerId);
    const { mx, my } = this.local(e);
    const i = this.nodeAt(mx, my);
    this.gesture();
    if (i >= 0) this.drag = { i, started: false, sx: mx, sy: my };
    else {
      this.pan = { sx: mx, sy: my, moved: false };
      this.canvas.style.cursor = "grabbing";
    }
    this.cb.onTakeover();
  };

  private readonly onPointerUp = (): void => {
    if (this.drag) {
      const d = this.drag;
      this.drag = null;
      if (d.started) this.cb.onDragEnd(this.ids[d.i]);
      else this.cb.onNodeClick(this.ids[d.i]);
    }
    if (this.pan) {
      const moved = this.pan.moved;
      this.pan = null;
      this.canvas.style.cursor = "grab";
      if (!moved) this.cb.onVoidClick();
    }
    this.gesture();
  };

  private readonly onPointerLeave = (): void => {
    if (this.hover >= 0) {
      this.hover = -1;
      this.cb.onHover(null, 0, 0);
    }
  };

  private readonly onDblClick = (e: MouseEvent): void => {
    const { mx, my } = this.local(e);
    const i = this.nodeAt(mx, my);
    if (i >= 0) this.cb.onNodeActivate(this.ids[i]);
  };

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.gesture();
    const { mx, my } = this.local(e);
    const before = this.toWorld(mx, my);
    const f = e.deltaY < 0 ? 1.08 : 1 / 1.08;
    const k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this.view.k * f));
    // Keep the world point under the cursor fixed.
    this.view = {
      k,
      x: (mx - this.W / 2) / k - before.x,
      y: (my - this.H / 2) / k - before.y,
    };
    this.target = { ...this.view };
    this.cb.onTakeover();
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    const visible: number[] = [];
    for (let i = 0; i < this.n; i++) if (this.ta[i] > 0.5) visible.push(i);
    if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowUp") {
      if (visible.length === 0) return;
      e.preventDefault();
      const dir = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
      const cur = visible.indexOf(this.selected);
      const next = visible[(cur + dir + visible.length) % visible.length];
      this.cb.onNodeClick(this.ids[next]);
      this.focusNode(this.ids[next]);
    } else if (e.key === "Enter" && this.selected >= 0) {
      e.preventDefault();
      this.cb.onNodeActivate(this.ids[this.selected]);
    } else if (e.key === "Escape") {
      this.cb.onVoidClick();
    }
  };
}

function rgbOf(hex: string): string {
  const c = rgb(hex, GREY);
  return `${c.r | 0},${c.g | 0},${c.b | 0}`;
}
