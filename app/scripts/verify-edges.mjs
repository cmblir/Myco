// Edge-connectivity verification: are nodes actually connected by edges that
// land on the right node positions? Loads the real 16-node / 49-edge wiki
// graph, lets the force layout settle, then (1) reads the three.js scene and
// checks every edge endpoint coincides with a node position (proves edges wire
// the correct nodes and follow them), and (2) screenshots for a visual check.
//
//   node scripts/verify-edges.mjs [baseUrl]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.argv[2] || "http://localhost:4173";
const OUT = "/tmp/memex-graph-qa";
mkdirSync(OUT, { recursive: true });
const VAULT = "/vault";
const p = (s) => `${VAULT}/wiki/${s}.md`;

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
const slugs = Object.keys(EDGES);
const forward = {};
for (const [s, ts] of Object.entries(EDGES)) forward[p(s)] = ts.map(p);
// expected undirected edge count
const seen = new Set();
for (const [s, ts] of Object.entries(EDGES)) for (const t of ts) {
  const key = [s, t].sort().join("|");
  seen.add(key);
}
const expectedEdges = seen.size;
const MOCK = {
  vault: VAULT,
  forward,
  fileTree: slugs.map((s) => ({ kind: "file", name: `${s}.md`, path: p(s) })),
  mtimes: slugs.map((s, i) => [p(s), 1700000000 + i * 1000]),
};

function initBrowser(mock) {
  const adjacency = { forward: mock.forward, backward: {}, unresolved: {}, tags: {} };
  const H = {
    ensure_default_vault: () => mock.vault,
    open_vault: (a) => ({ path: (a && a.path) || mock.vault, name: "Memex" }),
    list_files: () => mock.fileTree,
    build_link_graph: () => adjacency,
    file_mtimes: () => mock.mtimes,
    get_settings: () => ({ providers: {}, query_provider: "", query_model: "", ingest_provider: "", ingest_model: "" }),
    scan_provenance: () => [], git_log: () => [],
    claude_check: () => ({ installed: false, version: null, path: null }),
    agent_check: () => ({ installed: false, version: null, path: null }),
    has_provider_key: () => false,
    ollama_status: () => ({ binary_installed: false, binary_path: null, version: null, daemon_running: false, endpoint: "", models: [], error: null }),
    mcp_registration_info: () => ({ found: false, installed: false, python: null, script: null, command: null, desktop_json: null }),
  };
  window.__TAURI_INTERNALS__ = {
    invoke: async (c, a) => (H[c] ? H[c](a) : null),
    transformCallback: (cb) => cb, unregisterCallback: () => {}, convertFileSrc: (s) => s,
  };
  try {
    localStorage.setItem("memex-ui", JSON.stringify({ state: { route: "graph", lang: "en", theme: "dark", sidebarCollapsed: true }, version: 3 }));
    localStorage.setItem("memex.lastVaultPath", mock.vault);
  } catch { /* ignore */ }
}

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.addInitScript(initBrowser, MOCK);
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(`${BASE}/?vault=${VAULT}`, { waitUntil: "networkidle" });
await page.waitForSelector("canvas.graph-canvas-3d", { timeout: 15000 });
await page.waitForFunction(() => /[1-9]/.test(document.querySelector(".graph-stat")?.textContent || ""), { timeout: 15000 });
await page.waitForTimeout(6000); // settle

const probe = await page.evaluate(() => {
  const dev = window.__graphDev;
  if (!dev || !dev.scene) return { ok: false, why: "no __graphDev" };
  // dev.scene is the GraphScene instance; its node Points + edge LineSegments
  // are exposed as instance fields (dev build is not minified).
  const gs = dev.scene;
  const points = gs.points;
  const lines = gs.edges;
  if (!points || !lines) return { ok: false, why: `points=${!!points} lines=${!!lines}` };
  const np = points.geometry.getAttribute("position");
  const nodes = [];
  for (let i = 0; i < np.count; i++) nodes.push([np.getX(i), np.getY(i), np.getZ(i)]);
  const ep = lines.geometry.getAttribute("position");
  const segCount = ep.count / 2;
  let maxMiss = 0;
  let endpointsOnNode = 0;
  for (let i = 0; i < ep.count; i++) {
    const x = ep.getX(i), y = ep.getY(i), z = ep.getZ(i);
    let best = Infinity;
    for (const n of nodes) {
      const d = Math.hypot(x - n[0], y - n[1], z - n[2]);
      if (d < best) best = d;
    }
    if (best > maxMiss) maxMiss = best;
    if (best < 0.5) endpointsOnNode++;
  }
  // spread of node cluster — confirms the force layout pulled it together
  let cx = 0, cy = 0, cz = 0;
  for (const n of nodes) { cx += n[0]; cy += n[1]; cz += n[2]; }
  cx /= nodes.length; cy /= nodes.length; cz /= nodes.length;
  let rad = 0;
  for (const n of nodes) rad = Math.max(rad, Math.hypot(n[0] - cx, n[1] - cy, n[2] - cz));
  return {
    ok: true, nodeCount: nodes.length, edgeSegments: segCount,
    maxEndpointMiss: +maxMiss.toFixed(3),
    endpointsOnNode, totalEndpoints: ep.count,
    clusterRadius: +rad.toFixed(1),
  };
});

await page.screenshot({ path: `${OUT}/graph-edges.png` });
// zoom in for an edge close-up
for (let i = 0; i < 3; i++) await page.locator('.graph-toolbar__btn[aria-label="Zoom in"]').click();
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/graph-edges-zoom.png` });

const bad = errors.filter((e) => !/favicon|ResizeObserver loop/.test(e));
const stat = await page.evaluate(() => document.querySelector(".graph-stat")?.parentElement?.textContent || "");
const ok = probe.ok
  && probe.nodeCount === 16
  && probe.edgeSegments === expectedEdges
  && probe.endpointsOnNode === probe.totalEndpoints  // every endpoint sits on a node
  && probe.maxEndpointMiss < 0.5
  && bad.length === 0;
console.log(JSON.stringify({ expectedEdges, statText: stat.trim().slice(0, 40), probe, errors: bad, ok }, null, 2));
await ctx.close();
await browser.close();
console.log(ok ? "\nRESULT: PASS — nodes are correctly connected" : "\nRESULT: FAIL");
process.exit(ok ? 0 : 1);
