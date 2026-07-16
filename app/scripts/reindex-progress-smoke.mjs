// Reindex progress E2E. Reindex is the slowest thing the app does (~467 ms per
// embedded chunk — minutes on a real vault) and it used to run behind nothing
// but a disabled button. It now reports five states: idle / loading-model /
// indexing (determinate) / error / success.
//
// Checked across all three viewports (§8.4): the progress bar and the page path
// under it are the parts most likely to break a narrow card — a vault path is
// long and must ellipsize rather than wrap or stretch the layout.
//
// Usage (dev server on :5173):  node scripts/reindex-progress-smoke.mjs [--headed]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const headed = process.argv.includes("--headed");
const BASE = "http://localhost:5173/?mock=1";
const SHOTS = "test-results/reindex-progress";
mkdirSync(SHOTS, { recursive: true });

const VIEWPORTS = [
  { name: "mobile", width: 375, height: 667 },
  { name: "narrow", width: 768, height: 800 },
  { name: "full", width: 1280, height: 800 },
];

const browser = await chromium.launch({ headless: !headed });
const results = [];
const check = (n, ok, d = "") => results.push({ n, ok, d });

for (const vp of VIEWPORTS) {
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
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

  // At/below 768px the sidebar is an off-canvas overlay and starts collapsed,
  // so open it before reaching for a nav item (App.tsx's responsive effect).
  if (vp.width <= 768) {
    await page.locator(".topbar .icon-btn").first().click();
    await page.waitForTimeout(400); // let the slide-in settle before clicking
  }

  // Settings is in the last nav-group (tools), addressed by name rather than
  // position — that group also holds Schedules, and its order has changed
  // before. The Semantic search card is on Settings' own Model tab.
  await page
    .locator(".side-nav .nav-group")
    .last()
    .locator(".nav-item", { hasText: "Settings" })
    .first()
    .click();
  await page.waitForSelector(".page-title", { timeout: 20_000 });
  // Navigating auto-closes the mobile overlay; let it finish sliding out so the
  // screenshots capture the settled layout rather than a mid-transition frame.
  await page.waitForTimeout(500);
  await page.locator(".qbtn", { hasText: "Model" }).first().click();

  // The tab rail must not eat a narrow screen: below 768px it is a scrolling
  // row above the panel, not a 200px column beside it.
  const railHorizontal = await page.evaluate(() => {
    const nav = document.querySelector(".settings-grid > nav");
    return nav ? getComputedStyle(nav).flexDirection === "row" : null;
  });
  check(
    `${vp.name}: tab rail orientation`,
    vp.width <= 768 ? railHorizontal === true : railHorizontal === false,
    `flex-direction row = ${railHorizontal}`,
  );

  // The active tab must be on screen. The default tab is not the first one, so
  // a scrolling rail opens showing "Account" while the Model panel is rendered
  // unless the active tab is scrolled into view.
  const activeVisible = await page.evaluate(() => {
    const nav = document.querySelector(".settings-grid > nav");
    const active = nav?.querySelector(".qbtn.active");
    if (!nav || !active) return null;
    const n = nav.getBoundingClientRect();
    const a = active.getBoundingClientRect();
    return a.left >= n.left - 1 && a.right <= n.right + 1;
  });
  check(`${vp.name}: active tab is visible in the rail`, activeVisible === true);

  const btn = page.locator('[data-testid="reindex-btn"]');
  await btn.waitFor({ timeout: 20_000 });
  await btn.scrollIntoViewIfNeeded();

  // --- idle -------------------------------------------------------------
  check(`${vp.name}: idle shows the action`, (await btn.innerText()).includes("Reindex now"));
  check(`${vp.name}: idle is enabled`, await btn.isEnabled());

  await page.screenshot({ path: `${SHOTS}/${vp.name}-1-idle.png` });

  // --- loading model ----------------------------------------------------
  await btn.click();
  const loading = page.locator('[data-testid="reindex-loading"]');
  await loading.waitFor({ timeout: 5_000 }).catch(() => {});
  check(
    `${vp.name}: model load is announced, not silent`,
    (await btn.innerText()).includes("Loading model"),
    await btn.innerText(),
  );
  check(`${vp.name}: busy button is disabled`, await btn.isDisabled());
  await page.screenshot({ path: `${SHOTS}/${vp.name}-2-loading.png` });

  // --- indexing (determinate) -------------------------------------------
  const bar = page.locator('[data-testid="reindex-progress"] [role="progressbar"]');
  await bar.waitFor({ timeout: 10_000 });
  const first = Number(await bar.getAttribute("aria-valuenow"));
  check(`${vp.name}: progress bar appears`, await bar.isVisible());
  check(
    `${vp.name}: button counts pages`,
    /\d+\/\d+/.test(await btn.innerText()),
    await btn.innerText(),
  );
  await page.screenshot({ path: `${SHOTS}/${vp.name}-3-indexing.png` });

  // Progress advances rather than sitting at a fake constant.
  await page.waitForTimeout(400);
  const later = Number(await bar.getAttribute("aria-valuenow"));
  check(`${vp.name}: progress advances`, later > first, `${first}% → ${later}%`);

  // The page path must not blow out the card at any width.
  const overflow = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="reindex-progress"]');
    if (!el) return null;
    const card = el.closest(".card");
    return card ? card.scrollWidth - card.clientWidth : null;
  });
  check(`${vp.name}: progress does not overflow its card`, overflow === 0, `overflow=${overflow}px`);

  // --- success ----------------------------------------------------------
  const done = page.locator('[data-testid="reindex-done"]');
  await done.waitFor({ timeout: 20_000 });
  check(`${vp.name}: success state shown`, /Indexed \d+ pages/.test(await done.innerText()), await done.innerText());
  check(`${vp.name}: button returns to idle`, await btn.isEnabled());
  await page.screenshot({ path: `${SHOTS}/${vp.name}-4-done.png` });

  // No horizontal scroll anywhere on the page.
  const bodyOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check(`${vp.name}: no horizontal page scroll`, bodyOverflow <= 0, `overflow=${bodyOverflow}px`);

  check(`${vp.name}: no page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
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
