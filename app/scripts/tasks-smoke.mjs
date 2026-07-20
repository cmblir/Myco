// Usage (dev server on :5173):  node scripts/tasks-smoke.mjs
//
// The Tasks page gathers every markdown checkbox across the vault: open items in
// a list, completed ones in a collapsible section, with a click on any item
// jumping to the note it lives in. The mock seeds 3 open + 2 done. 3 viewports.
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
  await page.locator(".side-nav").getByRole("button", { name: /^Tasks$|^할 일$|^タスク$/ }).first().click();
  await page.waitForSelector("[data-testid='tasks-open']", { timeout: 20_000 });
  await page.waitForTimeout(300);

  // Open tasks list (mock seeds 3 open).
  const openRows = page.locator("[data-testid='tasks-open'] .list-row");
  check(at("open tasks render"), (await openRows.count()) === 3, String(await openRows.count()));

  // Open/done tally chips.
  const bodyText = (await page.locator(".workspace").innerText()).replace(/\s+/g, " ");
  check(at("shows open count"), /3 open/.test(bodyText), bodyText.slice(0, 80));
  check(at("shows done count"), /2 done/.test(bodyText));

  // Completed section is present (2 done) and expandable.
  const done = page.locator("[data-testid='tasks-done']");
  check(at("completed section present"), (await done.count()) === 1);
  await done.locator("summary").click().catch(() => {});
  await page.waitForTimeout(150);
  const doneRows = done.locator(".list-row");
  check(at("completed lists done items"), (await doneRows.count()) === 2, String(await doneRows.count()));

  // No horizontal overflow, and capture the page while it still shows tasks.
  const sw = await page.evaluate(() => document.scrollingElement.scrollWidth);
  check(at("no horizontal overflow"), sw <= vp.width, `sw=${sw}`);
  await page.screenshot({ path: `test-results/tasks/${vp.name}.png`, fullPage: false }).catch(() => {});

  // Clicking an open task navigates away from the Tasks page (to the note).
  await openRows.first().click();
  await page.waitForTimeout(400);
  check(at("clicking a task navigates away"),
    (await page.locator("[data-testid='tasks-open']").count()) === 0);

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
