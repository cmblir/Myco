// Perf probe for the Memex graph (calm-cosmic-web exit criteria).
// Usage: node graph-perf.mjs [stressN] [--headed]
// Loads ?mock=1&stress=N#/graph, waits for the settle, verifies the perf-gate
// UI, then samples fps over 5s via rAF. Headless runs on SwiftShader
// (software GL — fps are relative only); pass --headed for real-GPU numbers.
import { chromium } from "playwright";

const headed = process.argv.includes("--headed");
const stress = process.argv.find((a) => /^\d+$/.test(a)) ?? "8000";
const url = `http://localhost:5173/?mock=1&stress=${stress}#/graph`;

const browser = await chromium.launch({ headless: !headed });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console: ${m.text()}`);
});

console.log(`loading ${url}`);
const t0 = Date.now();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
// The hash route is ignored on a cold load — click into the graph view.
await page.getByText("그래프", { exact: true }).first().click({ timeout: 30_000 });

// Wait for the scene reveal (graph-ready lands when the layout settles or the
// 12s safety fires).
try {
  await page.waitForSelector(".graph-canvas.graph-ready", { timeout: 90_000 });
} catch (e) {
  const state = await page.evaluate(() => ({
    hasCanvas: !!document.querySelector(".graph-canvas canvas"),
    canvasClass: document.querySelector(".graph-canvas")?.className ?? null,
    bodyText: document.body.innerText.slice(0, 300),
    webgl: (() => {
      const c = document.createElement("canvas");
      return !!(c.getContext("webgl2") || c.getContext("webgl"));
    })(),
    nodes: window.__graphDev?.graph?.order ?? null,
  })).catch(() => "evaluate failed");
  console.error("TIMEOUT diag:", JSON.stringify(state, null, 2));
  console.error("errors:", errors.slice(0, 10));
  await browser.close();
  process.exit(1);
}
const readyMs = Date.now() - t0;

const counts = await page.evaluate(() => {
  const dev = window.__graphDev;
  return dev ? { nodes: dev.graph.order, edges: dev.graph.size } : null;
});
const perfBanner = await page.locator(".graph-perf-banner").count();

// fps: count rAF ticks for 5s after the reveal.
const fps = await page.evaluate(
  () =>
    new Promise((resolve) => {
      let frames = 0;
      const start = performance.now();
      const tick = () => {
        frames++;
        if (performance.now() - start < 5000) requestAnimationFrame(tick);
        else resolve(frames / ((performance.now() - start) / 1000));
      };
      requestAnimationFrame(tick);
    }),
);

console.log(JSON.stringify({
  stress: Number(stress),
  counts,
  readyMs,
  perfBannerShown: perfBanner > 0,
  fps: Math.round(fps * 10) / 10,
  errors: errors.slice(0, 5),
}, null, 2));

await browser.close();
