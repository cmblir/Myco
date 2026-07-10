// Agent mode E2E (Feature 4). Loads the Ask page with ?mock=1&agent=1 (the flag
// activates an HTTP tool-capable provider in the mock so the in-app agent loop
// runs), switches to Agent mode, runs a read-only task and asserts ≥1 tool step
// streams + a cited answer, then runs a write task and asserts the per-write
// confirmation dialog gates the create_page call.
//
// Usage (dev server on :5173):  node scripts/agent-smoke.mjs [--headed]
import { chromium } from "playwright";

const headed = process.argv.includes("--headed");
const BASE = "http://localhost:5173/?mock=1&agent=1";

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

// Open Ask page (quick-nav "Ask the wiki" button in the sidebar).
await page.locator(".side-quick .qbtn", { hasText: "Ask" }).first().click();
await page.waitForSelector(".page-title", { timeout: 20_000 });

// Switch to Agent mode.
await page.locator(".segmented button", { hasText: "Agent" }).click();
await page.waitForSelector(".agent-panel", { timeout: 10_000 });
check("agent panel shown", (await page.locator(".agent-panel").count()) > 0);
check(
  "provider supported (no unsupported notice)",
  (await page.locator(".agent-unsupported").count()) === 0,
);

// --- Read-only task ---
await page.locator(".agent-input").fill("What is attention in the wiki?");
await page.locator(".btn", { hasText: "Run" }).first().click();

// A tool step trace should appear and the run should finish with an answer.
await page.waitForSelector(".agent-step-tool", { timeout: 15_000 }).catch(() => {});
const steps = await page.locator(".agent-step-tool").allInnerTexts();
check("tool step streamed", steps.length >= 1, steps.join(", "));
check("search_vault called", steps.includes("search_vault"), steps.join(", "));

await page
  .waitForFunction(() => !!document.querySelector(".agent-answer"), { timeout: 15_000 })
  .catch(() => {});
const answer = await page.locator(".agent-answer").innerText().catch(() => "");
check("cited answer rendered", /attention-mechanism|attention/i.test(answer), answer.slice(0, 80));

// --- Write task with confirmation gate ---
// Enable writes, then ask for a task that triggers a create_page tool call.
await page.locator(".agent-write-toggle input").check();

// The confirm dialog blocks the run; accept it via the dialog's OK button.
await page.locator(".agent-input").fill("Create a summary page for me");
await page.locator(".btn", { hasText: "Run" }).first().click();

// Wait for the confirmation dialog and accept it via the primary action.
let confirmed = false;
try {
  await page.waitForSelector(".memex-modal[role=dialog]", { timeout: 8000 });
  await page.locator(".memex-modal__btn--primary").first().click();
  confirmed = true;
} catch {
  /* dialog did not appear */
}
check("write confirmation dialog appeared", confirmed);

// After confirming, a create_page step should be recorded and confirmed.
await page.waitForTimeout(1500);
const stepsAfter = await page.locator(".agent-step-tool").allInnerTexts();
check("create_page step recorded", stepsAfter.includes("create_page"), stepsAfter.join(", "));

check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  — " + r.detail : ""}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} checks clean`);
process.exit(failed ? 1 : 0);
