// Usage (dev server on :5173):  node scripts/wikify-grounding-smoke.mjs
//
// Wikification v2 (phases 1+2): before the ingest agent runs, the source is
// matched against the existing vault (phase 1 retrieval) and a read-only planning
// call turns that into an explicit ADD/UPDATE/MERGE/NOOP plan (phase 2). The
// ingest panel shows the plan so the agent updates existing pages instead of
// duplicating. The mock returns candidates + a plan referencing seeded pages.
// (When the planner yields nothing the panel falls back to the phase-1 candidate
// list; that path is covered by unit tests.) 3 viewports.
import { chromium } from "playwright";

const VIEWPORTS = [
  { name: "mobile", width: 375, height: 667 },
  { name: "small", width: 768, height: 800 },
  { name: "full", width: 1280, height: 800 },
];
const browser = await chromium.launch({ headless: true });
const results = [];
const check = (n, ok, d = "") => results.push({ n, ok, d });

const SOURCE_BODY =
  "This conversation is about the attention mechanism and self-attention in the " +
  "transformer architecture, and how embeddings and tokenization feed into it.";

for (const vp of VIEWPORTS) {
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem("memex.onboarded", "1");
    localStorage.setItem("memex-ui", JSON.stringify({ state: { lang: "en", theme: "light" }, version: 3 }));
  });
  await page.goto("http://localhost:5173/?mock=1", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector(".side-nav .nav-item", { timeout: 30_000 });
  const at = (n) => `[${vp.name}] ${n}`;

  if (vp.width <= 768) {
    await page.locator(".topbar .icon-btn").first().click();
    await page.waitForTimeout(300);
  }
  await page.locator(".qbtn", { hasText: /Ingest|가져오기|取り込み/ }).first().click();
  await page.waitForTimeout(500);

  // Fill the paste form and run (skip the file <input>; target the text ones).
  await page.locator('input[type="text"], input:not([type])').first().fill("Attention deep dive");
  await page.locator("textarea").first().fill(SOURCE_BODY);
  const run = page.getByRole("button", { name: /Ingest with Claude/ });
  check(at("run button present"), (await run.count()) >= 1);
  await run.first().click();

  // The ingest-plan panel appears with explicit ADD/UPDATE/MERGE/NOOP decisions.
  await page.waitForSelector("[data-testid='ingest-plan']", { timeout: 15_000 }).catch(() => {});
  const panel = page.locator("[data-testid='ingest-plan']");
  check(at("ingest plan panel appears"), (await panel.count()) === 1, String(await panel.count()));
  const panelText = (await panel.innerText().catch(() => "")).replace(/\s+/g, " ");
  check(at("plan shows an UPDATE decision"), /UPDATE/.test(panelText), panelText.slice(0, 100));
  check(at("plan shows an ADD decision"), /ADD/.test(panelText));
  check(at("plan names a seeded target page"),
    /attention-mechanism|embeddings|tokenization/.test(panelText), panelText.slice(0, 100));

  await page.screenshot({ path: `test-results/wikify-grounding/${vp.name}.png`, fullPage: false });
  check(at("no page errors"), errors.length === 0, errors.slice(0, 1).join("; "));
  await page.close();
}

await browser.close();
let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.n}${r.d ? "  — " + r.d : ""}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
