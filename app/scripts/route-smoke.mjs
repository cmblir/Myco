// Route smoke test (Stage 8 E2E slice). Boots the app against the ?mock dev
// server and visits every workspace + tools route, asserting each renders
// without a page error or console error. This is the tractable E2E surface:
// full native coverage (keychain, CLI spawning, MCP registration) needs
// tauri-driver/WebDriver against the packaged binary and is out of scope here.
//
// Usage (dev server must be running on :5173):
//   node scripts/route-smoke.mjs [--headed]
import { chromium } from "playwright";

const headed = process.argv.includes("--headed");
const BASE = "http://localhost:5173/?mock=1";

// Sidebar workspace nav is the first .nav-group's .nav-item buttons, in order.
const WORKSPACE = ["overview", "graph", "history", "provenance"];

const browser = await chromium.launch({ headless: !headed });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console: ${m.text()}`);
});

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
}

await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForSelector(".side-nav .nav-item", { timeout: 30_000 });
check("boot", (await page.locator("#root *").count()) > 0);

// Walk the four workspace routes by clicking their nav buttons in order.
for (let i = 0; i < WORKSPACE.length; i++) {
  const before = errors.length;
  await page
    .locator(".side-nav .nav-group")
    .first()
    .locator(".nav-item")
    .nth(i)
    .click();
  // Each page renders a .page-title (or the graph canvas) — wait for content.
  await page
    .waitForFunction(
      () => !!document.querySelector(".page-title, .graph-canvas"),
      { timeout: 20_000 },
    )
    .catch(() => {});
  await page.waitForTimeout(WORKSPACE[i] === "graph" ? 6000 : 800);
  check(
    WORKSPACE[i],
    errors.length === before,
    errors.slice(before).join(" | "),
  );
}

// Settings lives in the tools nav-group (last).
{
  const before = errors.length;
  await page
    .locator(".side-nav .nav-group")
    .last()
    .locator(".nav-item")
    .first()
    .click();
  await page.waitForSelector(".page-title", { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(800);
  check("settings", errors.length === before, errors.slice(before).join(" | "));
}

await browser.close();

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  — " + r.detail : ""}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} routes clean`);
process.exit(failed ? 1 : 0);
