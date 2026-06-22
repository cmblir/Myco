// DEV-ONLY: capture the REAL app Graph page for the README — a live node drag
// driving the d3-force sim (grab a hub, orbit it so neighbours follow, release
// so it springs back to rest). Requires the vite dev server running and
// Playwright chromium. Frames -> ffmpeg -> docs/screenshots/graph-drag.gif.
import { chromium } from "playwright";
import { mkdirSync, rmSync } from "node:fs";

const URL = process.env.URL || "http://localhost:5173/?mock=1";
const OUT = process.env.OUT || "/tmp/graph-frames";
const W = 1280, H = 800;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H } });

// Seed localStorage before the app boots: open straight on the Graph route,
// English, dark theme, with slightly larger nodes so the hub is easy to grab.
await page.addInitScript(() => {
  localStorage.setItem("memex.lastVaultPath", "/Memex");
  localStorage.setItem(
    "memex-ui",
    JSON.stringify({
      state: { route: "graph", sidebarCollapsed: false, cmdOpen: false, lang: "en", theme: "dark", density: "comfortable", accent: "#181715", showCitations: true, expandedFolders: {} },
      version: 3,
    }),
  );
  localStorage.setItem(
    "memex.graph.settings.v20",
    JSON.stringify({ showOrphans: true, existingOnly: false, tagFilter: null, folderFilter: null, arrows: false, textFadeThreshold: 1.8, nodeSize: 3, linkThickness: 1.3, centerForce: 0.5, repelForce: 11, linkForce: 1, linkDistance: 60 }),
  );
});

await page.goto(URL, { waitUntil: "load" });
await page.waitForFunction("window.__graphDev && window.__graphDev.graph.order > 0", { timeout: 30000 });
await page.waitForTimeout(5500); // let d3-force settle + the camera fit

// Highest-degree (hub) node in page coords + the graph-area centre to orbit.
const info = await page.evaluate(() => {
  const d = window.__graphDev, g = d.graph;
  let hub = null, best = -1;
  g.forEachNode((n) => { const deg = g.degree(n); if (deg > best) { best = deg; hub = n; } });
  const r = d.rect();
  const p = d.renderer.graphToViewport({ x: g.getNodeAttribute(hub, "x"), y: g.getNodeAttribute(hub, "y") });
  return { x: r.left + p.x, y: r.top + p.y, cx: r.left + r.width * 0.58, cy: r.top + r.height * 0.5 };
});

let f = 0;
const shot = async () => {
  await page.screenshot({ path: `${OUT}/frame_${String(f++).padStart(3, "0")}.png` });
};

for (let i = 0; i < 6; i++) { await page.waitForTimeout(45); await shot(); } // resting

await page.mouse.move(info.x, info.y);
await page.mouse.down();
await page.waitForTimeout(70);

const DRAG = 56, RAD = 160, TURNS = 1.25;
const startAng = Math.atan2(info.y - info.cy, info.x - info.cx);
const startRad = Math.hypot(info.x - info.cx, info.y - info.cy);
for (let i = 0; i < DRAG; i++) {
  const t = i / (DRAG - 1);
  const ang = startAng + t * Math.PI * 2 * TURNS;
  const rad = startRad + (RAD - startRad) * Math.min(1, t * 3);
  await page.mouse.move(info.cx + Math.cos(ang) * rad, info.cy + Math.sin(ang) * rad, { steps: 2 });
  await page.waitForTimeout(35);
  await shot();
}
await page.mouse.up();

for (let i = 0; i < 28; i++) { await page.waitForTimeout(45); await shot(); } // spring back

await browser.close();
console.log(`\ncaptured ${f} frames to ${OUT}`);
