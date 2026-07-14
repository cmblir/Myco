// FREEZE DIAGNOSIS: boot the real frontend against the USER'S ACTUAL vault
// adjacency (dumped read-only to a JSON by the scratchpad scanner), profile
// with CDP, and log long tasks + responsiveness. This reproduces the exact
// data shape that freezes the desktop app, inside a profilable browser.
//   node scripts/profile-real-vault.mjs <adjacency.json>
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const DUMP = JSON.parse(readFileSync(process.argv[2], "utf8"));
// ATLAS=1 reproduces the 2026-07-14 freeze scenario (persisted atlas layout).
DUMP.atlas = process.env.ATLAS === "1";
const BASE = process.env.BASE ?? "http://localhost:5173";

function initBrowser(mock) {
  const adjacency = { forward: mock.forward, backward: {}, unresolved: {}, tags: {} };
  const handlers = {
    ensure_default_vault: () => mock.vault,
    open_vault: (a) => ({ path: (a && a.path) || mock.vault, name: "Documents" }),
    list_files: () => mock.fileTree,
    build_link_graph: () => adjacency,
    file_mtimes: () => mock.mtimes,
    get_settings: () => ({
      providers: {},
      query_provider: "",
      query_model: "",
      ingest_provider: "",
      ingest_model: "",
    }),
    scan_provenance: () => [],
    git_log: () => [],
    claude_check: () => ({ installed: false, version: null, path: null }),
    agent_check: () => ({ installed: false, version: null, path: null }),
    has_provider_key: () => false,
    ollama_status: () => ({ binary_installed: false, binary_path: null, version: null, daemon_running: false, endpoint: "", models: [], error: null }),
    mcp_registration_info: () => ({ found: false, installed: false, python: null, script: null, command: null, desktop_json: null }),
  };
  window.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => {
      const h = handlers[cmd];
      return h ? h(args) : null;
    },
    transformCallback: (cb) => cb,
    unregisterCallback: () => {},
    convertFileSrc: (s) => s,
  };
  try {
    if (mock.atlas) {
      localStorage.setItem(
        "memex.graph.settings.v26",
        JSON.stringify({ layout: "atlas" }),
      );
    }
    localStorage.setItem(
      "memex-ui",
      JSON.stringify({ state: { route: "graph", lang: "ko", theme: "dark" }, version: 3 }),
    );
    localStorage.setItem("memex.lastVaultPath", mock.vault);
  } catch {
    /* ignore */
  }
  window.__longTasks = [];
  new PerformanceObserver((list) => {
    for (const e of list.getEntries())
      window.__longTasks.push({ start: Math.round(e.startTime), dur: Math.round(e.duration) });
  }).observe({ entryTypes: ["longtask"] });
}

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--enable-webgl"],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.addInitScript(initBrowser, DUMP);
const page = await context.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message.slice(0, 200)));

const cdp = await context.newCDPSession(page);
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
await cdp.send("Profiler.start");

const t0 = Date.now();
await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
const stalls = [];
for (let i = 0; i < 40; i++) {
  const s = Date.now();
  try {
    await Promise.race([
      page.evaluate(() => 1),
      new Promise((_, rej) => setTimeout(() => rej(new Error("stall")), 5000)),
    ]);
    stalls.push(Date.now() - s);
  } catch {
    stalls.push(-1);
  }
  await new Promise((r) => setTimeout(r, Math.max(0, 1000 - (Date.now() - s))));
}
const { profile } = await cdp.send("Profiler.stop");

const nodesById = new Map(profile.nodes.map((n) => [n.id, n]));
const selfTime = new Map();
const total = profile.samples?.length ?? 1;
for (const id of profile.samples ?? []) selfTime.set(id, (selfTime.get(id) ?? 0) + 1);
const top = [...selfTime.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 25)
  .map(([id, n]) => {
    const f = nodesById.get(id).callFrame;
    const url = (f.url || "").split("/").slice(-1)[0];
    return `${((n / total) * 100).toFixed(1)}%  ${f.functionName || "(anon)"}  ${url}:${f.lineNumber}`;
  });

const longTasks = await page.evaluate(() => window.__longTasks).catch(() => "wedged");
const state = await page
  .evaluate(() => ({
    ready: !!document.querySelector(".graph-canvas.graph-ready") || !!document.querySelector(".graph-ready"),
    nodes: window.__graphDev?.graph?.order ?? null,
    edges: window.__graphDev?.graph?.size ?? null,
  }))
  .catch(() => "wedged");
console.log("elapsed:", Date.now() - t0);
console.log("responsiveness (ms/s, -1 = >5s stall):", JSON.stringify(stalls));
console.log("state:", JSON.stringify(state));
const lt = Array.isArray(longTasks) ? longTasks : [];
console.log(`long tasks: n=${lt.length} worst=${Math.max(0, ...lt.map((t) => t.dur))}ms last-start=${lt.length ? lt[lt.length - 1].start : 0}ms`);
console.log("worst 10:", JSON.stringify(lt.sort((a, b) => b.dur - a.dur).slice(0, 10)));
console.log("TOP SELF-TIME:");
for (const l of top) console.log("  " + l);
await page.screenshot({ path: "/tmp/real-vault-profile.png" });
await browser.close();
