// Auto-refresh verification (systematic-debugging Phase 4).
// Proves the file tree picks up EXTERNAL changes without a restart: the mocked
// list_files returns one extra file from its 2nd call onward (simulating a file
// created outside the app), and we assert the sidebar shows it within the poll
// window. Also asserts the 3D graph does NOT churn while adjacency is unchanged
// (the equality guard), by polling the graph route for console errors.
//
//   node scripts/verify-refresh.mjs [baseUrl]
import { chromium } from "playwright";

const BASE = process.argv[2] || "http://localhost:4173";
const VAULT = "/vault";
const p = (slug) => `${VAULT}/wiki/${slug}.md`;
const BASE_SLUGS = ["gpt-1", "nanochat", "openai", "andrej-karpathy"];
const NEW_SLUG = "external-new-file";

function initBrowser(args) {
  const { vault, baseFiles, newFile } = args;
  const fwd = {};
  for (const f of baseFiles) fwd[f.path] = [];
  const adjacency = { forward: fwd, backward: {}, unresolved: {}, tags: {} };
  let listCalls = 0;
  const handlers = {
    ensure_default_vault: () => vault,
    open_vault: (a) => ({ path: (a && a.path) || vault, name: "Memex" }),
    list_files: () => {
      listCalls += 1;
      // From the 2nd call onward (the first auto-refresh poll), an external file
      // has "appeared" on disk.
      return listCalls >= 2 ? [...baseFiles, newFile] : baseFiles;
    },
    build_link_graph: () => adjacency, // unchanged forever → graph must not rebuild
    file_mtimes: () => baseFiles.map((f, i) => [f.path, 1700000000 + i * 1000]),
    get_settings: () => ({ providers: {}, query_provider: "", query_model: "", ingest_provider: "", ingest_model: "" }),
    scan_provenance: () => [],
    git_log: () => [],
    claude_check: () => ({ installed: false, version: null, path: null }),
    agent_check: () => ({ installed: false, version: null, path: null }),
    has_provider_key: () => false,
    ollama_status: () => ({ binary_installed: false, binary_path: null, version: null, daemon_running: false, endpoint: "", models: [], error: null }),
    mcp_registration_info: () => ({ found: false, installed: false, python: null, script: null, command: null, desktop_json: null }),
  };
  window.__TAURI_INTERNALS__ = {
    invoke: async (cmd, a) => (handlers[cmd] ? handlers[cmd](a) : null),
    transformCallback: (cb) => cb,
    unregisterCallback: () => {},
    convertFileSrc: (s) => s,
  };
  try {
    localStorage.setItem("memex-ui", JSON.stringify({ state: { route: args.route || "overview", lang: "en", theme: "dark", sidebarCollapsed: false }, version: 3 }));
    localStorage.setItem("memex.lastVaultPath", vault);
  } catch {
    /* ignore */
  }
}

const MOCK = {
  vault: VAULT,
  baseFiles: BASE_SLUGS.map((s) => ({ kind: "file", name: `${s}.md`, path: p(s) })),
  newFile: { kind: "file", name: `${NEW_SLUG}.md`, path: p(NEW_SLUG) },
};

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
let fail = false;

// --- Test 1: external file appears via auto-refresh (sidebar tree) ---
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(initBrowser, MOCK);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/?vault=${VAULT}`, { waitUntil: "networkidle" });
  await page.waitForSelector(".sidebar", { timeout: 10000 });
  await page.waitForTimeout(1200);
  const before = await page.getByText(NEW_SLUG, { exact: false }).count();
  let appeared = false;
  try {
    await page.getByText(NEW_SLUG, { exact: false }).first().waitFor({ state: "visible", timeout: 9000 });
    appeared = true;
  } catch {
    appeared = false;
  }
  const after = await page.getByText(NEW_SLUG, { exact: false }).count();
  const ok = before === 0 && appeared && after > 0;
  if (!ok) fail = true;
  console.log(JSON.stringify({ test: "external-file-auto-refresh", before, appeared, after, ok }, null, 2));
  await ctx.close();
}

// --- Test 2: graph does NOT churn while adjacency is unchanged (guard) ---
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(initBrowser, { ...MOCK, route: "graph" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`${BASE}/?vault=${VAULT}`, { waitUntil: "networkidle" });
  let canvasOk = false;
  try {
    await page.waitForSelector("canvas.graph-canvas-3d", { timeout: 12000 });
    // poll window spans ~2 auto-refresh ticks; graph must stay alive + quiet
    await page.waitForTimeout(9000);
    canvasOk = await page.evaluate(() => !!document.querySelector("canvas.graph-canvas-3d"));
  } catch {
    canvasOk = false;
  }
  const bad = errors.filter((e) => !/favicon|ResizeObserver loop/.test(e));
  const ok = canvasOk && bad.length === 0;
  if (!ok) fail = true;
  console.log(JSON.stringify({ test: "graph-no-churn-on-poll", canvasOk, errors: bad, ok }, null, 2));
  await ctx.close();
}

await browser.close();
console.log(fail ? "\nRESULT: FAIL" : "\nRESULT: PASS");
process.exit(fail ? 1 : 0);
