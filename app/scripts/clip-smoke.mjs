// Web-clipper handoff E2E.
//
// A clip lands in the vault's `_inbox/` and the Rust side emits
// `memex://clip-saved`. The app used to answer that by refreshing the file tree
// and nothing else, so the clip sat there until auto-ingest's next tick — which
// defaults to an hour. "Clip it and it becomes a cited page" should not mean
// "in up to an hour".
//
// The contract this pins: a clip is picked up immediately when the user has
// auto-ingest on, and is never ingested behind the back of a user who has not.
//
// Usage (dev server on :5173):  node scripts/clip-smoke.mjs [--headed]
import { chromium } from "playwright";

const headed = process.argv.includes("--headed");
const BASE = "http://localhost:5173/?mock=1";

const browser = await chromium.launch({ headless: !headed });
const results = [];
const check = (n, ok, d = "") => results.push({ n, ok, d });

/** Load the app with auto-ingest in a known state, then fire a clip. */
async function clipWith(autoIngest) {
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

  // Set auto-ingest through the real Settings toggle. Importing the store from
  // `evaluate` would get a second module instance with its own state — the app
  // would never see the change.
  await page.locator(".side-nav .nav-group").last().locator(".nav-item", { hasText: "Settings" }).first().click();
  await page.waitForSelector(".page-title", { timeout: 20_000 });
  await page.locator(".qbtn", { hasText: "Model" }).first().click();
  const target = page.locator('button[role="switch"][aria-label="Auto-ingest inbox"]').first();
  await target.waitFor({ timeout: 20_000 });
  if (((await target.getAttribute("aria-checked")) === "true") !== autoIngest) {
    await target.click();
    await page.waitForTimeout(300);
  }

  // Let the scheduler's one-off 4s kick fire and find nothing. Without this the
  // test proves nothing: the kick would pick the clip up on its own within four
  // seconds and the check passes with the clip wiring removed — which it did,
  // the first time this was written. The gap being tested is the STEADY state,
  // where the next pass is up to an hour away.
  await page.waitForTimeout(5_500);

  // Fire the clip through the mock the APP installed (window.__memexMock).
  // Importing devMock from `evaluate` would emit into a second module
  // instance's empty listener registry and reach nobody.
  await page.evaluate(() => window.__memexMock.clip());

  // Watch for the Topbar's ingest chip in its POST-RUN state, not the spinner:
  // the mock's run is quick enough to be over before a poll sees it, and a test
  // that races the mock's speed is the same trap that made the reindex
  // navigation check pass against broken code. The chip persists until the user
  // visits the Ingest page, so it is there whether the run took 200 ms or two
  // minutes.
  const started = await page
    .locator(".pill", { hasText: /Ingest (done|failed)/i })
    .first()
    .waitFor({ timeout: 4_000 })
    .then(() => true)
    .catch(() => false);
  await page.close();
  return { started, errors };
}

// --- auto-ingest ON: the clip is picked up now, not in an hour -------------
{
  const { started, errors } = await clipWith(true);
  check("a clip starts an ingest when auto-ingest is on", started);
  check("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));
}

// --- auto-ingest OFF: nothing happens behind the user's back ---------------
{
  const { started, errors } = await clipWith(false);
  check("a clip never ingests when auto-ingest is off", !started);
  check("no page errors (off)", errors.length === 0, errors.slice(0, 2).join(" | "));
}

await browser.close();
let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.n}${r.d ? "  — " + r.d : ""}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
