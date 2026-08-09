// Ambient background engines for the Overview page.
//
// One engine per GRAPH LAYOUT NAME. The names are deliberately the graph's own
// ("galaxy", "strata", …) even though nothing here reads the real graph: a user
// who has learned "은하계" on the graph page should not have to learn a second
// vocabulary for the same look. They are two expressions of one idea, not two
// features.
//
// Every engine is driven by the SAME two inputs, so switching the look never
// changes what the screen says about the vault — a big vault stays busy-looking
// and a quiet one stays quiet, whichever theme is on.
//
// Canvas rather than CSS: several of these (growth that leaves a trail, signals
// travelling along edges) hold state between frames, which CSS keyframes cannot
// express. One rAF loop lives on the Overview page and stops when the tab is
// hidden.

export type OverviewThemeKey =
  | "galaxy"
  | "mycelium"
  | "spiral"
  | "synapse3d"
  | "celestial"
  | "radial"
  | "walrus"
  | "strata"
  | "semantic"
  | "atlas";

/** Order shown in the picker. Galaxy first — it is the default and the app's face. */
export const OVERVIEW_THEMES: OverviewThemeKey[] = [
  "galaxy",
  "mycelium",
  "spiral",
  "synapse3d",
  "celestial",
  "radial",
  "walrus",
  "strata",
  "semantic",
  "atlas",
];

export const DEFAULT_OVERVIEW_THEME: OverviewThemeKey = "galaxy";

export function isOverviewTheme(v: unknown): v is OverviewThemeKey {
  return typeof v === "string" && (OVERVIEW_THEMES as string[]).includes(v);
}

export interface ThemeInputs {
  /** How many elements to draw — derived from the vault's link count. */
  count: number;
  /** 0.35 (idle) … 1 (busy) — derived from how much the user wrote lately. */
  speed: number;
}

export interface ThemeEngine {
  step(ctx: CanvasRenderingContext2D, w: number, h: number, dt: number): void;
  /** True when the engine paints over its own previous frame (growth trails),
   *  so the caller must NOT clear the canvas between frames. */
  trails?: boolean;
}

const HUES = ["#8aabd6", "#cfa45c", "#89b79b", "#c58f8a", "#9d92c4", "#7fb8c4"];

/** Deterministic PRNG. A field that reshuffles on every resize stops reading as
 *  "my vault" and starts reading as noise. */
function prng(seed: number): () => number {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

type Factory = (inp: ThemeInputs) => ThemeEngine;

const FACTORIES: Record<OverviewThemeKey, Factory> = {
  galaxy: ({ count, speed }) => {
    const r = prng(29);
    let pts: { cx: number; cy: number; a: number; d: number; sp: number; z: number; c: string; x: number; y: number }[] = [];
    let W = 0;
    let H = 0;
    const seed = (w: number, h: number): void => {
      pts = [];
      const cl: [number, number, number][] = [[0.28, 0.42, 0.3], [0.56, 0.3, 0.26], [0.72, 0.6, 0.26], [0.42, 0.72, 0.18]];
      cl.forEach((c, ci) => {
        const n = Math.max(3, Math.round(count * c[2]));
        for (let i = 0; i < n; i++) {
          pts.push({ cx: c[0] * w, cy: c[1] * h, a: r() * 6.29, d: Math.sqrt(r()) * (w * 0.09 + 16), sp: 0.06 + r() * 0.1, z: 0.5 + r() * 0.8, c: HUES[ci], x: 0, y: 0 });
        }
      });
      W = w;
      H = h;
    };
    return {
      step(ctx, w, h, dt) {
        if (!pts.length || W !== w || H !== h) seed(w, h);
        for (const p of pts) {
          p.a += p.sp * dt * speed * 2;
          p.x = p.cx + Math.cos(p.a) * p.d;
          p.y = p.cy + Math.sin(p.a) * p.d * 0.62;
        }
        const reach = Math.min(70, w * 0.09);
        ctx.lineWidth = 0.7;
        for (let i = 0; i < pts.length; i++) {
          for (let j = i + 1; j < pts.length; j++) {
            const dd = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
            if (dd > reach) continue;
            ctx.strokeStyle = pts[i].c;
            ctx.globalAlpha = 0.3 * (1 - dd / reach);
            ctx.beginPath();
            ctx.moveTo(pts[i].x, pts[i].y);
            ctx.lineTo(pts[j].x, pts[j].y);
            ctx.stroke();
          }
        }
        for (const p of pts) {
          ctx.globalAlpha = 0.5 + p.z * 0.4;
          ctx.fillStyle = p.c;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.z * 2.1, 0, 6.29);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      },
    };
  },

  mycelium: ({ count, speed }) => {
    const r = prng(11);
    let tips: { x: number; y: number; a: number; life: number; gen: number }[] = [];
    let W = 0;
    let H = 0;
    const cap = Math.max(20, count * 2);
    // Several inoculation points spread across the frame, not one in the middle:
    // a single origin makes every tip overlap for the first second and the mat
    // reads as a puffball instead of something spreading.
    const seed = (w: number, h: number): void => {
      tips = [];
      for (let s = 0; s < 3; s++) {
        const sx = w * (0.22 + 0.28 * s);
        const sy = h * (0.34 + 0.22 * (s % 2));
        for (let i = 0; i < 3; i++) tips.push({ x: sx, y: sy, a: (i / 3) * 6.29 + r() * 0.8, life: 0, gen: 0 });
      }
      W = w;
      H = h;
    };
    return {
      trails: true,
      step(ctx, w, h, dt) {
        if (!tips.length || W !== w || H !== h) seed(w, h);
        // Growth leaves a trace, and the trace receding is the "not writing"
        // signal — so fade rather than clear.
        ctx.fillStyle = "rgba(15,15,14,0.006)";
        ctx.fillRect(0, 0, w, h);
        for (let i = tips.length - 1; i >= 0; i--) {
          const t = tips[i];
          t.a += (r() - 0.5) * 0.22;
          const sp = 52 * dt * speed;
          const nx = t.x + Math.cos(t.a) * sp;
          const ny = t.y + Math.sin(t.a) * sp;
          ctx.strokeStyle = "rgba(196,212,234,0.82)";
          ctx.lineWidth = Math.max(0.6, 2 - t.gen * 0.38);
          ctx.beginPath();
          ctx.moveTo(t.x, t.y);
          ctx.lineTo(nx, ny);
          ctx.stroke();
          t.x = nx;
          t.y = ny;
          t.life += dt;
          if (r() < 0.03 && t.gen < 4 && tips.length < cap) {
            tips.push({ x: t.x, y: t.y, a: t.a + (r() < 0.5 ? 0.7 : -0.7), life: 0, gen: t.gen + 1 });
            ctx.fillStyle = "rgba(220,228,240,0.85)";
            ctx.beginPath();
            ctx.arc(t.x, t.y, 1.7, 0, 6.29);
            ctx.fill();
          }
          if (t.x < -20 || t.x > w + 20 || t.y < -20 || t.y > h + 20 || t.life > 9) {
            ctx.fillStyle = "rgba(230,236,246,0.9)";
            ctx.beginPath();
            ctx.arc(t.x, t.y, 2.2, 0, 6.29);
            ctx.fill();
            tips.splice(i, 1);
          }
        }
        if (!tips.length) seed(w, h);
      },
    };
  },

  spiral: ({ count, speed }) => {
    const r = prng(31);
    let pts: { arm: number; u: number; off: number; c: string; s: number }[] = [];
    let W = 0;
    let H = 0;
    let t = 0;
    const seed = (): void => {
      pts = [];
      for (let i = 0; i < count * 2; i++) {
        const arm = i % 3;
        pts.push({ arm, u: 0.12 + r() * 0.88, off: (r() - 0.5) * 0.22, c: HUES[arm], s: 0.8 + r() * 1.4 });
      }
    };
    return {
      step(ctx, w, h, dt) {
        if (!pts.length || W !== w || H !== h) {
          seed();
          W = w;
          H = h;
        }
        t += dt * speed * 0.22;
        const cx = w * 0.5;
        const cy = h * 0.5;
        const R = Math.min(w, h) * 0.46;
        for (const p of pts) {
          const th = p.u * 5.4 + p.arm * (6.29 / 3) + t + p.off;
          const rr = R * Math.pow(p.u, 0.72);
          ctx.globalAlpha = 0.35 + 0.5 * (1 - p.u);
          ctx.fillStyle = p.c;
          ctx.beginPath();
          ctx.arc(cx + Math.cos(th) * rr, cy + Math.sin(th) * rr * 0.5, p.s, 0, 6.29);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      },
    };
  },

  synapse3d: ({ count, speed }) => {
    const r = prng(37);
    let nodes: { x: number; y: number; c: string }[] = [];
    let edges: [number, number][] = [];
    let pulses: { e: [number, number]; p: number }[] = [];
    let W = 0;
    let H = 0;
    let acc = 0;
    const seed = (w: number, h: number): void => {
      nodes = [];
      edges = [];
      pulses = [];
      for (let i = 0; i < count; i++) nodes.push({ x: (0.1 + r() * 0.8) * w, y: (0.12 + r() * 0.76) * h, c: HUES[i % HUES.length] });
      const reach = Math.min(w, h) * 0.3;
      for (let a = 0; a < nodes.length; a++) {
        for (let b = a + 1; b < nodes.length; b++) {
          if (Math.hypot(nodes[a].x - nodes[b].x, nodes[a].y - nodes[b].y) < reach) edges.push([a, b]);
        }
      }
      W = w;
      H = h;
    };
    return {
      step(ctx, w, h, dt) {
        if (!nodes.length || W !== w || H !== h) seed(w, h);
        ctx.lineWidth = 0.7;
        ctx.strokeStyle = "rgba(150,170,200,0.20)";
        for (const e of edges) {
          ctx.beginPath();
          ctx.moveTo(nodes[e[0]].x, nodes[e[0]].y);
          ctx.lineTo(nodes[e[1]].x, nodes[e[1]].y);
          ctx.stroke();
        }
        acc += dt;
        if (acc > 0.3 / Math.max(0.2, speed) && edges.length) {
          acc = 0;
          pulses.push({ e: edges[Math.floor(r() * edges.length)], p: 0 });
        }
        for (let i = pulses.length - 1; i >= 0; i--) {
          const pu = pulses[i];
          pu.p += dt * (0.7 + speed * 0.8);
          if (pu.p > 1) {
            pulses.splice(i, 1);
            continue;
          }
          const a = nodes[pu.e[0]];
          const b = nodes[pu.e[1]];
          ctx.globalAlpha = Math.sin(pu.p * Math.PI);
          ctx.fillStyle = "#cfe3ff";
          ctx.beginPath();
          ctx.arc(a.x + (b.x - a.x) * pu.p, a.y + (b.y - a.y) * pu.p, 2.1, 0, 6.29);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
        for (const n of nodes) {
          ctx.fillStyle = n.c;
          ctx.beginPath();
          ctx.arc(n.x, n.y, 1.9, 0, 6.29);
          ctx.fill();
        }
      },
    };
  },

  celestial: ({ count, speed }) => {
    const r = prng(41);
    let pts: { u: number; th: number; c: string; s: number }[] = [];
    let W = 0;
    let H = 0;
    let t = 0;
    const seed = (): void => {
      pts = [];
      for (let i = 0; i < count * 1.6; i++) pts.push({ u: r() * 2 - 1, th: r() * 6.29, c: HUES[i % HUES.length], s: 0.7 + r() * 1.5 });
    };
    return {
      step(ctx, w, h, dt) {
        if (!pts.length || W !== w || H !== h) {
          seed();
          W = w;
          H = h;
        }
        t += dt * speed * 0.2;
        const cx = w * 0.5;
        const cy = h * 0.5;
        const R = Math.min(w, h) * 0.42;
        let prev: [number, number] | null = null;
        pts.forEach((p, i) => {
          const rr = Math.sqrt(Math.max(0, 1 - p.u * p.u));
          const a = p.th + t;
          const x = cx + Math.cos(a) * rr * R;
          const y = cy + p.u * R * 0.72;
          const depth = (Math.sin(a) + 1) / 2;
          ctx.globalAlpha = 0.25 + depth * 0.65;
          ctx.fillStyle = p.c;
          ctx.beginPath();
          ctx.arc(x, y, p.s * (0.6 + depth * 0.8), 0, 6.29);
          ctx.fill();
          if (prev && i % 4) {
            ctx.globalAlpha = 0.1 + depth * 0.12;
            ctx.strokeStyle = p.c;
            ctx.lineWidth = 0.6;
            ctx.beginPath();
            ctx.moveTo(prev[0], prev[1]);
            ctx.lineTo(x, y);
            ctx.stroke();
          }
          prev = [x, y];
        });
        ctx.globalAlpha = 1;
      },
    };
  },

  radial: ({ count, speed }) => {
    const r = prng(43);
    let pts: { ring: number; a: number; sp: number; c: string; s: number }[] = [];
    let W = 0;
    let H = 0;
    const seed = (): void => {
      pts = [];
      for (let i = 0; i < count * 1.4; i++) {
        const ring = i % 4;
        pts.push({ ring, a: r() * 6.29, sp: (0.1 + ring * 0.045) * (ring % 2 ? -1 : 1), c: HUES[ring], s: 0.9 + r() * 1.3 });
      }
    };
    return {
      step(ctx, w, h, dt) {
        if (!pts.length || W !== w || H !== h) {
          seed();
          W = w;
          H = h;
        }
        const cx = w * 0.5;
        const cy = h * 0.5;
        const R = Math.min(w, h) * 0.42;
        ctx.lineWidth = 0.6;
        for (let k = 1; k <= 4; k++) {
          ctx.globalAlpha = 0.12;
          ctx.strokeStyle = HUES[k - 1];
          ctx.beginPath();
          ctx.ellipse(cx, cy, R * (k / 4), R * (k / 4) * 0.42, 0, 0, 6.29);
          ctx.stroke();
        }
        for (const p of pts) {
          p.a += p.sp * dt * speed * 2;
          const rr = R * ((p.ring + 1) / 4);
          ctx.globalAlpha = 0.85;
          ctx.fillStyle = p.c;
          ctx.beginPath();
          ctx.arc(cx + Math.cos(p.a) * rr, cy + Math.sin(p.a) * rr * 0.42, p.s, 0, 6.29);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      },
    };
  },

  walrus: ({ count, speed }) => {
    const r = prng(47);
    let tree: { x1: number; y1: number; x2: number; y2: number; c: string; ph: number; leaf?: boolean }[] = [];
    let W = 0;
    let H = 0;
    let t = 0;
    const seed = (w: number, h: number): void => {
      tree = [];
      const cx = w * 0.5;
      const cy = h * 0.5;
      const branches = 6;
      for (let b = 0; b < branches; b++) {
        const a = (b / branches) * 6.29 + r() * 0.3;
        const len = Math.min(w, h) * (0.18 + r() * 0.12);
        const ex = cx + Math.cos(a) * len;
        const ey = cy + Math.sin(a) * len * 0.55;
        tree.push({ x1: cx, y1: cy, x2: ex, y2: ey, c: HUES[b % HUES.length], ph: r() * 6.29 });
        const leaves = Math.max(2, Math.round(count / branches));
        for (let i = 0; i < leaves; i++) {
          const la = a + (r() - 0.5) * 1.5;
          const ll = len * (0.45 + r() * 0.5);
          tree.push({ x1: ex, y1: ey, x2: ex + Math.cos(la) * ll, y2: ey + Math.sin(la) * ll * 0.55, c: HUES[b % HUES.length], ph: r() * 6.29, leaf: true });
        }
      }
      W = w;
      H = h;
    };
    return {
      step(ctx, w, h, dt) {
        if (!tree.length || W !== w || H !== h) seed(w, h);
        t += dt * speed;
        for (const s of tree) {
          const b = 0.5 + 0.5 * Math.sin(t * 0.9 + s.ph);
          ctx.globalAlpha = (s.leaf ? 0.28 : 0.5) + b * 0.3;
          ctx.strokeStyle = s.c;
          ctx.lineWidth = s.leaf ? 0.7 : 1.3;
          ctx.beginPath();
          ctx.moveTo(s.x1, s.y1);
          ctx.lineTo(s.x2, s.y2);
          ctx.stroke();
          ctx.globalAlpha = 0.6 + b * 0.4;
          ctx.fillStyle = s.c;
          ctx.beginPath();
          ctx.arc(s.x2, s.y2, s.leaf ? 1.3 : 2.2, 0, 6.29);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      },
    };
  },

  strata: ({ speed }) => {
    let t = 0;
    // Band thickness is the real folder mix: sessions dominate, wiki is thin.
    const bands = [
      { y: 0.2, th: 3.0, sp: 10, c: "rgba(138,171,214,0.55)", ph: 0 },
      { y: 0.38, th: 15.0, sp: 30, c: "rgba(160,155,146,0.30)", ph: 1.4 },
      { y: 0.58, th: 5.0, sp: 15, c: "rgba(207,164,92,0.42)", ph: 2.7 },
      { y: 0.74, th: 2.0, sp: 8, c: "rgba(137,183,155,0.45)", ph: 4.1 },
    ];
    return {
      step(ctx, w, h, dt) {
        t += dt * speed * 1.4;
        for (const b of bands) {
          const wob = (k: number): number => Math.sin(k * 5.2 + t * (b.sp / 22) + b.ph) * 7 + Math.sin(k * 11 - t * (b.sp / 40) + b.ph) * 3;
          const thick = (k: number): number => b.th * (0.75 + 0.45 * Math.sin(k * 3.4 - t * 0.35 + b.ph));
          ctx.beginPath();
          const st = 6;
          for (let x = 0; x <= w + st; x += st) {
            const k = x / w;
            const y = b.y * h + wob(k) - thick(k);
            if (x === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          for (let x = w + st; x >= 0; x -= st) {
            const k = x / w;
            ctx.lineTo(x, b.y * h + wob(k) + thick(k));
          }
          ctx.closePath();
          ctx.fillStyle = b.c;
          ctx.fill();
        }
      },
    };
  },

  semantic: ({ count, speed }) => {
    const r = prng(53);
    let blobs: { x: number; y: number; rad: number; c: string; ph: number }[] = [];
    let pts: { b: number; a: number; d: number; c: string; s: number }[] = [];
    let W = 0;
    let H = 0;
    let t = 0;
    const seed = (w: number, h: number): void => {
      blobs = [];
      pts = [];
      for (let b = 0; b < 5; b++) blobs.push({ x: (0.2 + r() * 0.6) * w, y: (0.2 + r() * 0.6) * h, rad: Math.min(w, h) * (0.1 + r() * 0.09), c: HUES[b], ph: r() * 6.29 });
      for (let i = 0; i < count * 1.5; i++) pts.push({ b: i % 5, a: r() * 6.29, d: r(), c: HUES[i % 5], s: 0.8 + r() * 1.2 });
      W = w;
      H = h;
    };
    return {
      step(ctx, w, h, dt) {
        if (!blobs.length || W !== w || H !== h) seed(w, h);
        t += dt * speed;
        for (const b of blobs) {
          const pulse = 1 + 0.1 * Math.sin(t * 0.6 + b.ph);
          const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.rad * pulse * 1.7);
          g.addColorStop(0, `${b.c}33`);
          g.addColorStop(1, `${b.c}00`);
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(b.x, b.y, b.rad * pulse * 1.7, 0, 6.29);
          ctx.fill();
        }
        for (const p of pts) {
          const b = blobs[p.b];
          const pulse = 1 + 0.1 * Math.sin(t * 0.6 + b.ph);
          const a = p.a + t * 0.12;
          const rr = p.d * b.rad * pulse;
          ctx.globalAlpha = 0.85;
          ctx.fillStyle = p.c;
          ctx.beginPath();
          ctx.arc(b.x + Math.cos(a) * rr, b.y + Math.sin(a) * rr, p.s, 0, 6.29);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      },
    };
  },

  atlas: ({ count, speed }) => {
    const r = prng(59);
    let pts: { hx: number; hy: number; c: string; s: number; ph: number }[] = [];
    let W = 0;
    let H = 0;
    let t = 0;
    const seed = (w: number, h: number): void => {
      pts = [];
      for (let i = 0; i < count * 1.7; i++) {
        const reg = i % 5;
        pts.push({ hx: (0.14 + (reg % 3) * 0.3 + r() * 0.16) * w, hy: (0.2 + Math.floor(reg / 3) * 0.38 + r() * 0.2) * h, c: HUES[reg], s: 0.9 + r() * 1.3, ph: r() * 6.29 });
      }
      W = w;
      H = h;
    };
    return {
      step(ctx, w, h, dt) {
        if (!pts.length || W !== w || H !== h) seed(w, h);
        t += dt * speed * 0.6;
        // A faint graticule — this is the flat-map theme.
        ctx.strokeStyle = "rgba(150,150,150,0.07)";
        ctx.lineWidth = 0.6;
        for (let gx = 0; gx <= 4; gx++) {
          ctx.beginPath();
          ctx.moveTo((w * gx) / 4, 0);
          ctx.lineTo((w * gx) / 4, h);
          ctx.stroke();
        }
        for (let gy = 0; gy <= 3; gy++) {
          ctx.beginPath();
          ctx.moveTo(0, (h * gy) / 3);
          ctx.lineTo(w, (h * gy) / 3);
          ctx.stroke();
        }
        for (const p of pts) {
          ctx.globalAlpha = 0.8;
          ctx.fillStyle = p.c;
          ctx.beginPath();
          ctx.arc(p.hx + Math.sin(t + p.ph) * 3, p.hy + Math.cos(t * 0.8 + p.ph) * 2.4, p.s, 0, 6.29);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      },
    };
  },
};

/** Build a fresh engine. Engines own mutable state, so each canvas needs its own. */
export function createOverviewEngine(key: OverviewThemeKey, inp: ThemeInputs): ThemeEngine {
  return FACTORIES[key](inp);
}
