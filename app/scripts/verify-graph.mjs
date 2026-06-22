// Self-verification harness for the 3D graph view (CLAUDE.md §8.4).
// Boots the built app under Playwright with a mocked Tauri IPC layer seeded
// with the real 16-node wiki link graph, forces route=graph + dark theme via
// localStorage, then screenshots the three required viewports and reports any
// console errors / a WebGL + node-count probe. Run against `vite preview`.
//
//   node scripts/verify-graph.mjs [baseUrl]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.argv[2] || "http://localhost:4173";
const OUT = "/tmp/memex-graph-qa";
mkdirSync(OUT, { recursive: true });

// Real wiki structure (slug → outgoing wikilink slugs), from the graph analysis.
const EDGES = {
  "alec-radford": ["gpt-1", "openai", "source-gpt1"],
  "andrej-karpathy": ["byte-pair-encoding", "llm-training-pipeline", "llm101n", "midtraining", "nanochat", "nanogpt", "openai", "source-bpe", "source-nanochat"],
  bookcorpus: ["gpt-1", "source-gpt1"],
  "byte-pair-encoding": ["andrej-karpathy", "llm-training-pipeline", "midtraining", "nanochat", "source-bpe"],
  "gpt-1": ["alec-radford", "bookcorpus", "openai", "pretrain-finetune-paradigm", "source-gpt1", "transformer-decoder-only"],
  "llm-training-pipeline": ["byte-pair-encoding", "gpt-1", "midtraining", "nanochat", "nanogpt", "pretrain-finetune-paradigm", "source-bpe", "source-gpt1", "source-nanochat"],
  llm101n: ["andrej-karpathy", "nanochat", "source-nanochat"],
  midtraining: ["andrej-karpathy", "llm-training-pipeline", "nanochat", "source-nanochat"],
  nanochat: ["andrej-karpathy", "byte-pair-encoding", "llm-training-pipeline", "llm101n", "midtraining", "nanogpt", "source-bpe", "source-nanochat"],
  nanogpt: ["andrej-karpathy", "gpt-1", "llm-training-pipeline", "nanochat", "openai", "source-gpt1", "source-nanochat", "transformer-decoder-only"],
  openai: ["alec-radford", "andrej-karpathy", "gpt-1", "source-gpt1", "source-nanochat"],
  "pretrain-finetune-paradigm": ["gpt-1", "llm-training-pipeline", "openai", "source-gpt1", "source-nanochat"],
  "source-bpe": ["andrej-karpathy", "byte-pair-encoding", "llm-training-pipeline", "nanochat"],
  "source-gpt1": ["alec-radford", "bookcorpus", "openai", "pretrain-finetune-paradigm", "transformer-decoder-only"],
  "source-nanochat": ["andrej-karpathy", "llm-training-pipeline", "llm101n", "midtraining", "nanochat", "nanogpt"],
  "transformer-decoder-only": ["gpt-1", "nanochat", "nanogpt", "source-gpt1"],
};

const VAULT = "/vault";
const p = (slug) => `${VAULT}/wiki/${slug}.md`;
const slugs = Object.keys(EDGES);
const forward = {};
for (const [s, ts] of Object.entries(EDGES)) forward[p(s)] = ts.map(p);
const fileTree = slugs.map((s) => ({ kind: "file", name: `${s}.md`, path: p(s) }));
const mtimes = slugs.map((s, i) => [p(s), 1700000000 + i * 1000]);
const MOCK = { vault: VAULT, forward, fileTree, mtimes };

// Runs at document-start in the page: stub Tauri invoke + seed localStorage.
function initBrowser(mock) {
  const adjacency = { forward: mock.forward, backward: {}, unresolved: {}, tags: {} };
  const handlers = {
    ensure_default_vault: () => mock.vault,
    open_vault: (a) => ({ path: (a && a.path) || mock.vault, name: "Memex" }),
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
    localStorage.setItem(
      "memex-ui",
      JSON.stringify({ state: { route: "graph", lang: "en", theme: "dark" }, version: 3 }),
    );
    localStorage.setItem("memex.lastVaultPath", mock.vault);
  } catch {
    /* ignore */
  }
}

const viewports = [
  { name: "mobile", width: 375, height: 667 },
  { name: "small", width: 768, height: 800 },
  { name: "full", width: 1280, height: 800 },
];

const browser = await chromium.launch({
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
    "--enable-webgl",
  ],
});

let anyError = false;
for (const vp of viewports) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1,
  });
  await context.addInitScript(initBrowser, MOCK);
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

  await page.goto(`${BASE}/?vault=${VAULT}`, { waitUntil: "networkidle" });

  // Wait for the lazy 3D chunk to mount its canvas + the graph to gain data.
  let probe = { ok: false };
  try {
    await page.waitForSelector("canvas.graph-canvas-3d", { timeout: 15000 });
    await page.waitForFunction(
      () => {
        const stat = document.querySelector(".graph-stat");
        return stat && /[1-9]/.test(stat.textContent || "");
      },
      { timeout: 15000 },
    );
    // Let the force layout settle + bloom render.
    await page.waitForTimeout(4500);
    probe = await page.evaluate(() => {
      const cv = document.querySelector("canvas.graph-canvas-3d");
      const gl = cv && (cv.getContext("webgl2") || cv.getContext("webgl"));
      const labels = document.querySelectorAll(".graph-label-3d");
      let visibleLabels = 0;
      labels.forEach((l) => {
        const parent = l.parentElement;
        if (parent && parent.style.display !== "none") visibleLabels++;
      });
      return {
        ok: true,
        hasCanvas: !!cv,
        canvasW: cv ? cv.width : 0,
        canvasH: cv ? cv.height : 0,
        hasGL: !!gl,
        stat: document.querySelector(".graph-stat")?.textContent || "",
        labelCount: labels.length,
        visibleLabels,
      };
    });
  } catch (e) {
    probe = { ok: false, err: String(e) };
  }

  const file = `${OUT}/graph-${vp.name}-${vp.width}x${vp.height}.png`;
  await page.screenshot({ path: file });

  // Timelapse smoke (full viewport only): exercise the highest-risk feature —
  // the growing-subset live-physics replay that react-force-graph-3d could not
  // express — and confirm it runs without throwing. First .graph-toolbar__btn
  // is the timelapse play toggle.
  let timelapse = null;
  if (vp.name === "full" && probe.ok) {
    try {
      const btn = page.locator(".graph-toolbar__btn").first();
      await btn.click();
      await page.waitForTimeout(2500);
      const pressed = await btn.getAttribute("aria-pressed");
      await page.screenshot({ path: `${OUT}/graph-timelapse.png` });
      timelapse = { clicked: true, ariaPressed: pressed };
    } catch (e) {
      timelapse = { clicked: false, err: String(e) };
      anyError = true;
    }
  }

  const bad = errors.filter((e) => !/favicon|ResizeObserver loop/.test(e));
  if (bad.length || !probe.ok || !probe.hasGL) anyError = true;
  console.log(JSON.stringify({ viewport: vp.name, size: `${vp.width}x${vp.height}`, file, probe, timelapse, errors: bad }, null, 2));
  await context.close();
}

// --- Brightness control check: open the drawer, drive the Brightness slider
// to a high then low value, screenshot each, confirm no errors. ---
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await context.addInitScript(initBrowser, MOCK);
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  let brightness = { ok: false };
  try {
    await page.goto(`${BASE}/?vault=${VAULT}`, { waitUntil: "networkidle" });
    await page.waitForSelector("canvas.graph-canvas-3d", { timeout: 15000 });
    await page.waitForFunction(() => /[1-9]/.test(document.querySelector(".graph-stat")?.textContent || ""), { timeout: 15000 });
    await page.waitForTimeout(3000);
    // Open the settings drawer (last toolbar button) and grab the slider.
    await page.locator(".graph-toolbar__btn").last().click();
    const slider = page.locator(".graph-slider", { hasText: "Brightness" }).locator("input[type=range]");
    await slider.waitFor({ timeout: 5000 });
    await slider.fill("2.3");
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${OUT}/graph-brightness-high.png` });
    await slider.fill("0.4");
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${OUT}/graph-brightness-low.png` });
    const val = await slider.inputValue();
    brightness = { ok: true, finalSliderValue: val };
  } catch (e) {
    brightness = { ok: false, err: String(e) };
    anyError = true;
  }
  const bad = errors.filter((e) => !/favicon|ResizeObserver loop/.test(e));
  if (bad.length) anyError = true;
  console.log(JSON.stringify({ check: "brightness", brightness, errors: bad }, null, 2));
  await context.close();
}

await browser.close();
console.log(anyError ? "\nRESULT: FAIL" : "\nRESULT: PASS");
process.exit(anyError ? 1 : 0);
