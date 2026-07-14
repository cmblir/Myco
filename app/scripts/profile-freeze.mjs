// FREEZE DIAGNOSIS (one-off): load the 12k skewed mock (real-vault shape),
// CDP-profile the first 25s, log every long task and how often the build
// effect runs, then report top JS self-time functions. Evidence gatherer —
// no assertions.
import { chromium } from "playwright";

const URL = "http://localhost:5173/?mock=1&big=12000&skew=1";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.addInitScript(() => {
  localStorage.setItem(
    "memex-ui",
    JSON.stringify({ state: { route: "graph", lang: "ko", theme: "dark" }, version: 3 }),
  );
  // Count long tasks from inside the page.
  window.__longTasks = [];
  new PerformanceObserver((list) => {
    for (const e of list.getEntries())
      window.__longTasks.push({ start: Math.round(e.startTime), dur: Math.round(e.duration) });
  }).observe({ entryTypes: ["longtask"] });
});
const cdp = await page.context().newCDPSession(page);
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
await cdp.send("Profiler.start");

const t0 = Date.now();
await page.goto(URL, { waitUntil: "domcontentloaded" });
// Poll responsiveness: a trivial evaluate should return fast; when the main
// thread is wedged it stalls. Sample every second for 25s.
const stalls = [];
for (let i = 0; i < 25; i++) {
  const s = Date.now();
  try {
    await Promise.race([
      page.evaluate(() => 1),
      new Promise((_, rej) => setTimeout(() => rej(new Error("stall")), 3000)),
    ]);
    stalls.push(Date.now() - s);
  } catch {
    stalls.push(-1); // >3s stall
  }
  await new Promise((r) => setTimeout(r, 1000 - Math.min(900, Date.now() - s)));
}
const { profile } = await cdp.send("Profiler.stop");

// Top self-time functions.
const nodesById = new Map(profile.nodes.map((n) => [n.id, n]));
const selfTime = new Map();
const total = profile.samples?.length ?? 0;
for (const id of profile.samples ?? []) {
  selfTime.set(id, (selfTime.get(id) ?? 0) + 1);
}
const top = [...selfTime.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 22)
  .map(([id, n]) => {
    const f = nodesById.get(id).callFrame;
    const url = (f.url || "").split("/").slice(-1)[0];
    return `${((n / total) * 100).toFixed(1)}%  ${f.functionName || "(anon)"}  ${url}:${f.lineNumber}`;
  });

const longTasks = await page.evaluate(() => window.__longTasks).catch(() => "unavailable");
const state = await page.evaluate(() => ({
  ready: !!document.querySelector(".graph-canvas.graph-ready"),
  nodes: window.__graphDev?.graph?.order ?? null,
})).catch(() => "wedged");
console.log("elapsed:", Date.now() - t0, "ms");
console.log("responsiveness per s (ms, -1 = >3s stall):", JSON.stringify(stalls));
console.log("long tasks:", JSON.stringify(longTasks));
console.log("state:", JSON.stringify(state));
console.log("TOP SELF-TIME:");
for (const l of top) console.log("  " + l);
await browser.close();
