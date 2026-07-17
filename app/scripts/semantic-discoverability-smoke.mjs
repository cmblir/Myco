// The semantic index has to be discoverable from where it is missed.
//
// Semantic search, related notes, graph similarity and the pages Ask retrieves
// all read an index that only a sub-panel of Settings ever built — and every one
// of them degraded to NOTHING when it was absent. The Related panel returned
// null, which is also what it returns when a page genuinely has no neighbours,
// so a user without an index saw a permanently absent feature and no reason why.
// Those are different facts and the UI has to say which.
//
// Usage (dev server on :5173):  node scripts/semantic-discoverability-smoke.mjs [--headed]
import { chromium } from "playwright";

const headed = process.argv.includes("--headed");
const BASE = "http://localhost:5173/?mock=1";

const browser = await chromium.launch({ headless: !headed });
const results = [];
const check = (n, ok, d = "") => results.push({ n, ok, d });

/** Open a wiki page in the Reader with the index at `indexed` pages. */
async function readerWith(indexed) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  await page.addInitScript(() => {
    localStorage.setItem("memex.onboarded", "1");
    localStorage.setItem(
      "memex-ui",
      JSON.stringify({ state: { lang: "en", theme: "light" }, version: 3 }),
    );
  });
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector(".side-nav .nav-item", { timeout: 30_000 });
  await page.evaluate((n) => window.__memexMock.indexedPages(n), indexed);

  // The palette is the reliable way to a page; the sidebar tree needs expanding.
  await page.keyboard.press("Meta+k");
  await page.waitForTimeout(300);
  await page.keyboard.type("attention");
  await page.waitForTimeout(600);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1_500);
  return { page, errors };
}

// --- no index: the feature explains itself and offers the way in -----------
{
  const { page, errors } = await readerWith(0);
  const nudge = page.locator("[data-testid='related-no-index']");
  check("with no index the Related panel says so", (await nudge.count()) === 1);
  check(
    "and offers the way to set it up",
    await nudge.locator("button").first().isVisible(),
  );
  // The button has to actually go somewhere.
  await nudge.locator("button").first().click();
  await page.waitForTimeout(600);
  check(
    "the nudge routes to Settings",
    /Settings/i.test(await page.locator(".page-title").innerText()),
    await page.locator(".page-title").innerText(),
  );
  check("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));
  await page.close();
}

// --- with an index: no nudge, just the notes -------------------------------
{
  const { page, errors } = await readerWith(51);
  check(
    "with an index there is no nudge",
    (await page.locator("[data-testid='related-no-index']").count()) === 0,
  );
  check("no page errors (indexed)", errors.length === 0, errors.slice(0, 2).join(" | "));
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
