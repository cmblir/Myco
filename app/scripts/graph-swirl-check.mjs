// Regression check for the per-frame galaxy swirl (graphScene.swirlTick).
// It cannot be a vitest — the swirl only exists on a live GraphScene, which
// needs WebGL. The invariants below are implementation-independent: a swirl
// step is a RIGID ROTATION of each community about its own centroid, so the
// centroid must not move and every member's distance to it must be preserved.
// That is exactly what breaks if the centroid pass, the per-community axis or
// the attribute cache ever go out of step.
//   node scripts/graph-swirl-check.mjs [n]
import { chromium } from "playwright";

const BASE = process.env.BASE ?? "http://localhost:5199";
const n = Number(process.argv[2] ?? 1300);

const browser = await chromium.launch({ headless: process.argv.includes("--headless") });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.addInitScript(() => {
  localStorage.setItem(
    "myco-ui",
    JSON.stringify({ state: { route: "graph", lang: "en", theme: "dark" }, version: 3 }),
  );
});
const page = await context.newPage();
await page.goto(`${BASE}/?mock=1&big=${n}`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".graph-canvas.graph-ready", { timeout: 240_000 });

const r = await page.evaluate(() => {
  const s = window.__graphDev.scene;
  const g = s.graph;
  const ids = s.nodeIds;
  s.perfLod = false; // the >5000 LOD skips the swirl entirely
  s.moonHosts = new Map(); // isolate the galaxy spin from the moon orbits
  const snap = ids.map((id) => {
    const a = g.getNodeAttributes(id);
    return { c: a.community, x: a.x, y: a.y, z: a.z };
  });
  const centroids = (get) => {
    const m = new Map();
    ids.forEach((id, i) => {
      const p = get(i);
      if (snap[i].c < 0) return;
      const e = m.get(snap[i].c) ?? { x: 0, y: 0, z: 0, n: 0 };
      e.x += p.x; e.y += p.y; e.z += p.z; e.n += 1;
      m.set(snap[i].c, e);
    });
    for (const e of m.values()) { e.x /= e.n; e.y /= e.n; e.z /= e.n; }
    return m;
  };
  const before = centroids((i) => snap[i]);
  for (let k = 0; k < 20; k++) s.swirlTick(1 / 60);
  const after = centroids((i) => g.getNodeAttributes(ids[i]));

  let centroidDrift = 0;
  for (const [c, b] of before) {
    const a = after.get(c);
    centroidDrift = Math.max(centroidDrift, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z));
  }
  let radiusDrift = 0;
  let moved = 0;
  let unaffiliatedMoved = 0;
  ids.forEach((id, i) => {
    const p = g.getNodeAttributes(id);
    const q = snap[i];
    const d = Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
    if (q.c < 0) {
      unaffiliatedMoved = Math.max(unaffiliatedMoved, d);
      return;
    }
    if (d > 1e-6) moved++;
    const b = before.get(q.c);
    const a = after.get(q.c);
    const r0 = Math.hypot(q.x - b.x, q.y - b.y, q.z - b.z);
    const r1 = Math.hypot(p.x - a.x, p.y - a.y, p.z - a.z);
    radiusDrift = Math.max(radiusDrift, Math.abs(r1 - r0));
  });
  const extent = Math.max(...snap.map((p) => Math.hypot(p.x, p.y, p.z)));
  return {
    nodes: ids.length,
    communities: before.size,
    extent: +extent.toFixed(1),
    moved,
    centroidDrift: +centroidDrift.toFixed(6),
    radiusDrift: +radiusDrift.toFixed(6),
    unaffiliatedMoved: +unaffiliatedMoved.toFixed(6),
  };
});
await browser.close();

// Tolerances are absolute world units against a field ~2-6k units across, i.e.
// float noise, not slack for a real drift.
const fail = [];
if (r.moved < r.nodes * 0.5) fail.push(`only ${r.moved}/${r.nodes} nodes moved — swirl is not running`);
if (r.centroidDrift > 1e-3) fail.push(`community centroid moved ${r.centroidDrift}`);
if (r.radiusDrift > 1e-3) fail.push(`orbit radius changed by ${r.radiusDrift}`);
if (r.unaffiliatedMoved > 1e-9) fail.push(`unaffiliated node moved ${r.unaffiliatedMoved}`);
console.log(JSON.stringify(r, null, 2));
if (fail.length) {
  console.error("FAIL:\n  " + fail.join("\n  "));
  process.exit(1);
}
console.log("OK — swirl is a rigid per-community rotation");
