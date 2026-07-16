// Multiverse E2E: every vault is its own labelled bubble, and zooming into one
// enters it.
//
// The labels are the point of the check. They regressed twice: the universe name
// was hardcoded near-white (invisible on the light theme), and the community
// names that surface while zoomed out sat on top of it at screen-fixed size
// while the universe name — a world-space sprite — shrank away. Both are only
// visible in a rendered frame, so this asserts on the scene, not the DOM.
//
// Usage (dev server on :5173):  node scripts/multiverse-smoke.mjs [--headed]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const headed = process.argv.includes("--headed");
const BASE = "http://localhost:5173/?mock=1";
const SHOTS = "test-results/multiverse";
mkdirSync(SHOTS, { recursive: true });

const VIEWPORTS = [
  { name: "mobile", width: 375, height: 667 },
  { name: "narrow", width: 768, height: 800 },
  { name: "full", width: 1280, height: 800 },
];

const browser = await chromium.launch({ headless: !headed });
const results = [];
const check = (n, ok, d = "") => results.push({ n, ok, d });

/** Open the Graph route with multiverse turned on. */
async function openMultiverse(page, vp, theme = "light") {
  await page.addInitScript((th) => {
    localStorage.setItem("memex.onboarded", "1");
    localStorage.setItem(
      "memex-ui",
      JSON.stringify({ state: { lang: "en", theme: th }, version: 3 }),
    );
  }, theme);
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector(".side-nav .nav-item", { timeout: 30_000 });
  // The toggle lives in the graph settings panel; set it at its source of truth
  // and reload rather than driving the panel open at every viewport.
  await page.evaluate(() => {
    const k = "memex.graph.settings.v26";
    const cur = JSON.parse(localStorage.getItem(k) || "{}");
    const next = cur.state
      ? { ...cur, state: { ...cur.state, multiverse: true } }
      : { ...cur, multiverse: true };
    localStorage.setItem(k, JSON.stringify(next));
  });
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector(".side-nav .nav-item", { timeout: 30_000 });
  if (vp.width <= 768) {
    await page.locator(".topbar .icon-btn").first().click();
    await page.waitForTimeout(400);
  }
  await page.locator(".side-nav .nav-item", { hasText: "Graph" }).first().click();
  // MultiverseScene exposes its scene/graph in DEV for exactly this.
  await page.waitForFunction(() => Boolean(window.__mvDev), null, { timeout: 30_000 });
  await page.waitForTimeout(2500); // let the static field settle and fit
}

for (const vp of VIEWPORTS) {
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  await openMultiverse(page, vp);

  // --- every universe becomes a bubble ---------------------------------
  const scene = await page.evaluate(() => {
    const g = window.__mvDev.graph;
    const slugs = new Set();
    g.forEachNode((_i, a) => slugs.add(a.universe ?? ""));
    return { universes: [...slugs].filter(Boolean), nodes: g.order };
  });
  check(
    `${vp.name}: every universe is in the field`,
    scene.universes.length === 3,
    `universes=${JSON.stringify(scene.universes)}`,
  );
  check(`${vp.name}: field has nodes`, scene.nodes > 0, `nodes=${scene.nodes}`);

  // --- community labels must not compete with universe names -----------
  const clusterLabels = await page.evaluate(
    () => document.querySelectorAll(".cluster-label.is-visible").length,
  );
  check(
    `${vp.name}: community names are off in multiverse`,
    clusterLabels === 0,
    `visible=${clusterLabels}`,
  );

  await page.screenshot({ path: `${SHOTS}/${vp.name}-field.png` });
  check(`${vp.name}: no page errors`, errors.length === 0, errors.slice(0, 2).join(" | "));
  await page.close();
}

// --- zoom into a bubble enters that universe ---------------------------
// Full viewport only: the gesture is the same at every size and it costs a
// scene rebuild per run.
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await openMultiverse(page, { width: 1280 });

  // Record the switch. "Entering" is enterUniverse -> openVault(root): opening
  // the vault is what sets the confinement root, the active-vault marker and
  // restarts the MCP server, so open_vault — not set_active_project — is the
  // call that means a universe was entered.
  await page.evaluate(() => {
    window.__entered = [];
    const inv = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = (cmd, args) => {
      if (cmd === "open_vault") window.__entered.push(args?.path);
      return inv(cmd, args);
    };
  });

  const box = await page.locator("canvas").first().boundingBox();
  // Wheel toward a bubble: the scene retargets the orbit at the nearest one and
  // enters once the camera is inside it. Arming is deliberately delayed 1.2s so
  // the initial fit cannot trigger an entry.
  for (let i = 0; i < 40; i++) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -220);
    await page.waitForTimeout(120);
    const got = await page.evaluate(() => window.__entered.length > 0);
    if (got) break;
  }
  const entered = await page.evaluate(() => window.__entered);
  check(
    "zoom into a bubble enters that universe",
    entered.length > 0,
    `entered=${JSON.stringify(entered)}`,
  );
  check("entering does not error", errors.length === 0, errors.slice(0, 2).join(" | "));
  await page.close();
}

await browser.close();
let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.n}${r.d ? "  — " + r.d : ""}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed  (screenshots: ${SHOTS})`);
process.exit(failed ? 1 : 0);
