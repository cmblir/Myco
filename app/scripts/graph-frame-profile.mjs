// P2 graph performance budget: measure steady-state frame cost at scale.
//   node scripts/graph-frame-profile.mjs 1300 5000 10000 [--headless]
// Loads ?mock=1&big=N#/graph on the 5199 dev server, waits for the reveal,
// then wraps the per-frame methods on the live scene instance and samples rAF
// for 8s. Headed = real GPU (headless falls back to SwiftShader and the
// numbers are software-render fiction). Evidence gatherer — no assertions.
import { chromium } from "playwright";

const BASE = process.env.BASE ?? "http://localhost:5199";
const headless = process.argv.includes("--headless");
const sizes = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);
if (!sizes.length) sizes.push(1300, 5000, 10000);

// Instance methods wrapped with a timer. Instance props shadow the prototype,
// so this works without touching the class.
const PHASES = [
  "updateLod",
  "updateLabels",
  "render",
  "renderMinimap",
  "processPick",
  "swirlTick",
  "syncPositions",
  "updateGodRays",
  "animateArrows",
  "hoverPopTick",
];

function sample([phases, seconds]) {
  return new Promise((resolve) => {
    const dev = window.__graphDev;
    const scene = dev.scene;
    const acc = Object.create(null);
    const wrapped = [];
    const wrap = (obj, key, label) => {
      const fn = obj?.[key];
      if (typeof fn !== "function") return;
      acc[label] = 0;
      obj[key] = function (...args) {
        const t = performance.now();
        const r = fn.apply(this, args);
        acc[label] += performance.now() - t;
        return r;
      };
      wrapped.push([obj, key, fn]);
    };
    for (const p of phases) wrap(scene, p, p);
    wrap(scene.labelRenderer, "render", "css2d");
    wrap(scene.planets, "update", "planets");
    wrap(scene.controls, "update", "controls");

    const deltas = [];
    let last = performance.now();
    const t0 = last;
    const tick = () => {
      const now = performance.now();
      deltas.push(now - last);
      last = now;
      if (now - t0 < seconds * 1000) {
        requestAnimationFrame(tick);
        return;
      }
      for (const [obj, key, fn] of wrapped) obj[key] = fn;
      const n = deltas.length;
      const sorted = [...deltas].sort((a, b) => a - b);
      const info = scene.renderer?.info ?? {};
      const per = {};
      for (const k of Object.keys(acc)) per[k] = +(acc[k] / n).toFixed(3);
      resolve({
        frames: n,
        fps: +(n / ((now - t0) / 1000)).toFixed(1),
        medianMs: +sorted[Math.floor(n / 2)].toFixed(2),
        p95Ms: +sorted[Math.floor(n * 0.95)].toFixed(2),
        worstMs: +sorted[n - 1].toFixed(2),
        jsPerFrameMs: +(Object.values(acc).reduce((a, b) => a + b, 0) / n).toFixed(2),
        phaseMs: Object.fromEntries(Object.entries(per).sort((a, b) => b[1] - a[1])),
        draw: {
          calls: info.render?.calls ?? null,
          triangles: info.render?.triangles ?? null,
          points: info.render?.points ?? null,
          lines: info.render?.lines ?? null,
          geometries: info.memory?.geometries ?? null,
          textures: info.memory?.textures ?? null,
        },
        labels: scene.labels?.size ?? null,
        heapMB: performance.memory
          ? Math.round(performance.memory.usedJSHeapSize / 1048576)
          : null,
      });
    };
    requestAnimationFrame(tick);
  });
}

const browser = await chromium.launch({ headless });
const out = [];
for (const n of sizes) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    localStorage.setItem(
      "myco-ui",
      JSON.stringify({ state: { route: "graph", lang: "en", theme: "dark" }, version: 3 }),
    );
    window.__longTasks = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        window.__longTasks.push(Math.round(e.duration));
    }).observe({ entryTypes: ["longtask"] });
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message.slice(0, 160)));
  const t0 = Date.now();
  await page.goto(`${BASE}/?mock=1&big=${n}`, { waitUntil: "domcontentloaded" });
  let ready = true;
  try {
    await page.waitForSelector(".graph-canvas.graph-ready", { timeout: 240_000 });
  } catch {
    ready = false;
  }
  const readyMs = Date.now() - t0;
  await page.waitForTimeout(1500); // let the intro clock park
  // Ablation: force the >5000-node perf LOD off, so 10k is measured with the
  // SAME ambient layers 1.3k gets (otherwise 10k looks fast only because it is
  // a different, stripped-down picture).
  if (process.argv.includes("--nolod")) {
    await page.evaluate(() => {
      const s = window.__graphDev.scene;
      s.perfLod = false;
      s.applySettings?.(s.settings);
    });
    await page.waitForTimeout(500);
  }
  const res = await page.evaluate(sample, [PHASES, 6]).catch((e) => ({ error: String(e) }));
  // Second window: the same sampling while the user ORBITS. Idle is vsync-
  // locked at every size, so a drag (raycast pick + LOD + camera) is where the
  // budget actually gets spent.
  const box = await page.locator(".graph-canvas canvas").boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const dragging = page.evaluate(sample, [PHASES, 6]);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 0; i < 120; i++) {
    await page.mouse.move(cx + Math.sin(i / 6) * 260, cy + Math.cos(i / 9) * 150);
    await page.waitForTimeout(40);
  }
  await page.mouse.up();
  const drag = await dragging.catch((e) => ({ error: String(e) }));
  const boot = await page.evaluate(() => ({
    nodes: window.__graphDev?.graph?.order ?? null,
    edges: window.__graphDev?.graph?.size ?? null,
    longTasks: window.__longTasks.filter((d) => d > 100).sort((a, b) => b - a).slice(0, 6),
  }));
  out.push({ n, ready, readyMs, ...boot, idle: res, drag, errors: errors.slice(0, 3) });
  console.log(JSON.stringify(out[out.length - 1], null, 2));
  await context.close();
}
await browser.close();
console.log("\nSUMMARY");
for (const r of out) {
  const f = (s) => `fps=${s.fps} med=${s.medianMs} p95=${s.p95Ms} js=${s.jsPerFrameMs}`;
  console.log(`n=${r.n} nodes=${r.nodes} edges=${r.edges} ready=${r.readyMs}ms heap=${r.idle?.heapMB}MB`);
  console.log(`   idle  ${f(r.idle ?? {})}  ${JSON.stringify(r.idle?.phaseMs)}`);
  console.log(`   drag  ${f(r.drag ?? {})}  ${JSON.stringify(r.drag?.phaseMs)}`);
}
