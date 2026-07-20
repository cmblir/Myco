// Usage (dev server on :5173):  node scripts/provenance-smoke.mjs
//
// The Provenance page must show not just coverage % but WHICH sources each page
// cites, resolved to their provenance: a source imported from an AI conversation
// (vendor + conversation id + date) and a hand-authored one, plus a dangling
// citation flagged as missing. The mock seeds two pages with sources. 3 viewports.
import { chromium } from "playwright";

const VIEWPORTS = [
  { name: "mobile", width: 375, height: 667 },
  { name: "small", width: 768, height: 800 },
  { name: "full", width: 1280, height: 800 },
];
const browser = await chromium.launch({ headless: true });
const results = [];
const check = (n, ok, d = "") => results.push({ n, ok, d });

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
  await page.locator(".side-nav").getByRole("button", { name: /Provenance|출처|出典/ }).first().click();
  await page.waitForSelector(".list-row", { timeout: 20_000 });
  await page.waitForTimeout(400);

  // At least two pages expose a resolved source list.
  const sources = page.locator("[data-testid='prov-sources']");
  check(at("source lists render"), (await sources.count()) >= 2, String(await sources.count()));

  // Expand every source list, then the provenance for each seeded page must show.
  const n = await sources.count();
  for (let i = 0; i < n; i++) {
    await sources.nth(i).locator("summary").click().catch(() => {});
  }
  await page.waitForTimeout(200);
  const text = (await page.locator(".list").innerText()).replace(/\s+/g, " ");
  check(at("an imported ChatGPT source is labelled"), /ChatGPT/.test(text), text.slice(0, 80));
  check(at("a Claude Code source is labelled"), /Claude Code/.test(text));
  check(at("a hand-authored source is labelled"), /Written source/.test(text));
  check(at("a dangling citation is flagged missing"), /raw source missing/.test(text));
  // The conversation id prefix surfaces (first 8 chars of the mock uuid).
  check(at("a conversation id surfaces"), /ab12cd34/.test(text));

  await page.screenshot({ path: `test-results/provenance/${vp.name}.png`, fullPage: false });
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
