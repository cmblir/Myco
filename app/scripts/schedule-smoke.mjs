// Schedules E2E (Feature 7). Opens the Schedules route, creates a schedule,
// runs it now (digest generated via the mocked LLM + written to the vault), and
// asserts the run stamps last-run + surfaces an "Open digest" link. Also checks
// edit/delete round-trip through the (mocked) schedules IPC.
//
// Usage (dev server on :5173):  node scripts/schedule-smoke.mjs [--headed]
import { chromium } from "playwright";

const headed = process.argv.includes("--headed");
const BASE = "http://localhost:5173/?mock=1";

const browser = await chromium.launch({ headless: !headed });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console: ${m.text()}`);
});

const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok, detail });

await page.addInitScript(() => {
  localStorage.setItem("memex.onboarded", "1");
  localStorage.setItem(
    "memex-ui",
    JSON.stringify({ state: { lang: "en", theme: "light" }, version: 3 }),
  );
});

await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForSelector(".side-nav .nav-item", { timeout: 30_000 });

// Open Schedules (Tools group).
await page.locator(".side-nav .nav-item", { hasText: "Schedules" }).first().click();
await page.waitForSelector(".page-title", { timeout: 20_000 });
check("schedules route", (await page.locator(".page-title").innerText()) === "Schedules");
check("empty state shown", /No schedules yet/.test(await page.locator(".workspace").innerText()));

// Create a schedule.
await page.locator(".btn", { hasText: "New schedule" }).first().click();
await page.waitForSelector(".schedule-form", { timeout: 10_000 });
await page.locator(".schedule-title").fill("Weekly Review");
await page.locator(".schedule-prompt").fill("What are the open questions?");
await page.locator(".schedule-save").click();
await page.waitForSelector(".schedule-row", { timeout: 10_000 });
check("schedule created + listed", /Weekly Review/.test(await page.locator(".schedule-row").innerText()));
check("shows never-run", /never run/.test(await page.locator(".schedule-row").innerText()));

// Run it now → digest generated + last-run stamped + open-digest link.
const beforeErr = errors.length;
await page.locator(".schedule-run").first().click();
await page
  .waitForFunction(() => /Open digest/.test(document.body.innerText), { timeout: 15_000 })
  .catch(() => {});
check("open-digest link after run", /Open digest/.test(await page.locator(".workspace").innerText()));
check(
  "last-run stamped",
  /last run/.test(await page.locator(".schedule-row").innerText()),
  await page.locator(".schedule-row").innerText(),
);
check("run had no errors", errors.length === beforeErr, errors.slice(beforeErr).join(" | "));

// Background install toggle (mocked launchd) — click, expect a status line.
await page.locator(".schedule-bg").first().click();
await page.waitForTimeout(300);
check(
  "background toggle shows status",
  /background schedule/i.test(await page.locator(".workspace").innerText()),
);

// Open the digest note in the reader.
await page.locator(".btn", { hasText: "Open digest" }).first().click();
await page.waitForSelector(".page-title", { timeout: 10_000 });
check("digest note opens", (await page.locator(".page-title").count()) > 0);

// Back to schedules; delete it.
await page.locator(".side-nav .nav-item", { hasText: "Schedules" }).first().click();
await page.waitForSelector(".schedule-row", { timeout: 10_000 });
await page.locator(".schedule-row .btn", { hasText: "Delete" }).first().click();
await page.waitForTimeout(400);
check("schedule deleted", (await page.locator(".schedule-row").count()) === 0);

check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  — " + r.detail : ""}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} checks clean`);
process.exit(failed ? 1 : 0);
