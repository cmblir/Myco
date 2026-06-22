// Verify the "Arrows" (direction) toggle actually renders 3D arrowheads, and
// audit that toggling it changes the scene. Run against `vite dev` (DEV build
// exposes window.__graphDev). Screenshots arrows on/off.
//
//   node scripts/verify-arrows.mjs [baseUrl]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.argv[2] || "http://localhost:5173";
const OUT = "/tmp/memex-graph-qa";
mkdirSync(OUT, { recursive: true });
const VAULT = "/vault";
const p = (s) => `${VAULT}/wiki/${s}.md`;
const EDGES = {
  "alec-radford": ["gpt-1", "openai", "source-gpt1"],
  "andrej-karpathy": ["byte-pair-encoding", "llm-training-pipeline", "nanochat", "nanogpt", "openai", "source-nanochat"],
  bookcorpus: ["gpt-1", "source-gpt1"],
  "gpt-1": ["alec-radford", "bookcorpus", "openai", "pretrain-finetune-paradigm", "source-gpt1", "transformer-decoder-only"],
  "llm-training-pipeline": ["gpt-1", "nanochat", "nanogpt", "pretrain-finetune-paradigm", "source-gpt1"],
  nanochat: ["andrej-karpathy", "llm-training-pipeline", "nanogpt", "source-nanochat"],
  nanogpt: ["gpt-1", "llm-training-pipeline", "nanochat", "openai", "transformer-decoder-only"],
  openai: ["alec-radford", "andrej-karpathy", "gpt-1", "source-gpt1"],
  "pretrain-finetune-paradigm": ["gpt-1", "openai", "source-gpt1"],
  "source-gpt1": ["alec-radford", "bookcorpus", "openai", "transformer-decoder-only"],
  "source-nanochat": ["andrej-karpathy", "nanochat", "nanogpt"],
  "transformer-decoder-only": ["gpt-1", "nanochat", "nanogpt"],
};
const slugs = [...new Set([...Object.keys(EDGES), ...Object.values(EDGES).flat()])];
const forward = {};
for (const [s, ts] of Object.entries(EDGES)) forward[p(s)] = ts.map(p);
const MOCK = {
  vault: VAULT, forward,
  fileTree: slugs.map((s) => ({ kind: "file", name: `${s}.md`, path: p(s) })),
  mtimes: slugs.map((s, i) => [p(s), 1700000000 + i * 1000]),
};

function initBrowser(mock) {
  const adjacency = { forward: mock.forward, backward: {}, unresolved: {}, tags: {} };
  const H = {
    ensure_default_vault: () => mock.vault,
    open_vault: (a) => ({ path: (a && a.path) || mock.vault, name: "Memex" }),
    list_files: () => mock.fileTree, build_link_graph: () => adjacency, file_mtimes: () => mock.mtimes,
    get_settings: () => ({ providers: {}, query_provider: "", query_model: "", ingest_provider: "", ingest_model: "" }),
    scan_provenance: () => [], git_log: () => [],
    claude_check: () => ({ installed: false, version: null, path: null }),
    agent_check: () => ({ installed: false, version: null, path: null }),
    has_provider_key: () => false,
    ollama_status: () => ({ binary_installed: false, binary_path: null, version: null, daemon_running: false, endpoint: "", models: [], error: null }),
    mcp_registration_info: () => ({ found: false, installed: false, python: null, script: null, command: null, desktop_json: null }),
  };
  window.__TAURI_INTERNALS__ = { invoke: async (c, a) => (H[c] ? H[c](a) : null), transformCallback: (cb) => cb, unregisterCallback: () => {}, convertFileSrc: (s) => s };
  try {
    localStorage.setItem("memex-ui", JSON.stringify({ state: { route: "graph", lang: "en", theme: "dark", sidebarCollapsed: true }, version: 3 }));
    localStorage.setItem("memex.lastVaultPath", mock.vault);
  } catch { /* ignore */ }
}

const readArrows = () => {
  const a = window.__graphDev?.scene?.arrows;
  if (!a) return { found: false };
  // sample a few instance matrices; a placed arrow has non-zero scale
  const m = new (window.__graphDev.scene.arrows.matrix.constructor || Object)();
  let placed = 0;
  const tmp = a.instanceMatrix;
  for (let i = 0; i < a.count; i++) {
    // scale = length of first column of the 4x4 (elements 0,1,2)
    const e = tmp.array;
    const o = i * 16;
    const sx = Math.hypot(e[o], e[o + 1], e[o + 2]);
    if (sx > 0.01) placed++;
  }
  void m;
  return { found: true, visible: a.visible, count: a.count, placed };
};

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.addInitScript(initBrowser, MOCK);
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(`${BASE}/?vault=${VAULT}`, { waitUntil: "networkidle" });
await page.waitForSelector("canvas.graph-canvas-3d", { timeout: 15000 });
await page.waitForFunction(() => /[1-9]/.test(document.querySelector(".graph-stat")?.textContent || ""), { timeout: 15000 });
await page.waitForTimeout(5000);

const before = await page.evaluate(readArrows);
// open drawer + flip the Arrows toggle on
await page.locator(".graph-toolbar__btn").last().click();
const arrowsToggle = page.locator(".graph-toggle", { hasText: "Arrows" }).locator(".graph-toggle__switch");
await arrowsToggle.waitFor({ timeout: 5000 });
await arrowsToggle.click();
await page.waitForTimeout(1500);
const afterOn = await page.evaluate(readArrows);
await page.screenshot({ path: `${OUT}/graph-arrows-on.png` });
// flip off
await arrowsToggle.click();
await page.waitForTimeout(800);
const afterOff = await page.evaluate(readArrows);

const bad = errors.filter((e) => !/favicon|ResizeObserver loop/.test(e));
const ok =
  before.found && before.visible === false &&
  afterOn.visible === true && afterOn.count > 0 && afterOn.placed === afterOn.count &&
  afterOff.visible === false &&
  bad.length === 0;
console.log(JSON.stringify({ before, afterOn, afterOff, errors: bad, ok }, null, 2));
await ctx.close();
await browser.close();
console.log(ok ? "\nRESULT: PASS — Arrows toggle renders direction cones" : "\nRESULT: FAIL");
process.exit(ok ? 0 : 1);
