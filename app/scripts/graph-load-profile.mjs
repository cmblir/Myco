// P2 companion to graph-frame-profile: attribute the LOAD-time long tasks
// (the freeze before the reveal), which is where the 10k budget actually goes.
//   node scripts/graph-load-profile.mjs 10000
import { chromium } from "playwright";

const BASE = process.env.BASE ?? "http://localhost:5199";
const n = Number(process.argv[2] ?? 10000);

// Headed by default: headless falls back to SwiftShader and shader
// compilation swamps every real cost.
const browser = await chromium.launch({ headless: process.argv.includes("--headless") });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => {
  localStorage.setItem(
    "myco-ui",
    JSON.stringify({ state: { route: "graph", lang: "en", theme: "dark" }, version: 3 }),
  );
  window.__longTasks = [];
  new PerformanceObserver((list) => {
    for (const e of list.getEntries())
      window.__longTasks.push({ start: Math.round(e.startTime), dur: Math.round(e.duration) });
  }).observe({ entryTypes: ["longtask"] });
});
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
await cdp.send("Profiler.start");
const t0 = Date.now();
await page.goto(`${BASE}/?mock=1&big=${n}`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".graph-canvas.graph-ready", { timeout: 240_000 });
const readyMs = Date.now() - t0;
const { profile } = await cdp.send("Profiler.stop");

const byId = new Map(profile.nodes.map((x) => [x.id, x]));
const self = new Map();
const total = profile.samples?.length || 1;
for (const id of profile.samples ?? []) self.set(id, (self.get(id) ?? 0) + 1);
const dur = (profile.endTime - profile.startTime) / 1000;
const top = [...self.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 25)
  .map(([id, c]) => {
    const f = byId.get(id).callFrame;
    return `${((c / total) * 100).toFixed(1)}%  ${Math.round((c / total) * dur)}ms  ${f.functionName || "(anon)"}  ${(f.url || "").split("/").pop()}:${f.lineNumber}`;
  });
const lt = await page.evaluate(() => window.__longTasks);
console.log(`n=${n} readyMs=${readyMs} profileWindow=${Math.round(dur)}ms`);
console.log("long tasks >80ms:", JSON.stringify(lt.filter((t) => t.dur > 80)));
console.log("TOP SELF-TIME:");
for (const l of top) console.log("  " + l);
await browser.close();
