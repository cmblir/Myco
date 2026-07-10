// PDF annotation E2E (Feature 6). Opens a raw PDF from the sidebar (pdf.js
// renders it), asserts the viewer + a seeded sidecar highlight render, clicking
// the highlight routes to its citing note, and clicking a [[pdf::…]] link in a
// note opens the viewer at that page/anchor.
//
// Usage (dev server on :5173):  node scripts/pdf-smoke.mjs [--headed]
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

// --- Open the raw PDF from the sidebar (raw/ folder → the .pdf leaf) ---
await page.locator(".nav-item", { hasText: "raw" }).first().click();
await page
  .locator(".nav-leaf", { hasText: "attention-is-all-you-need" })
  .first()
  .click();

await page.waitForSelector('[data-testid="pdf-viewer"]', { timeout: 20_000 });
check("pdf viewer opens", true);

// pdf.js should render the page canvas with non-zero size.
await page
  .waitForFunction(
    () => {
      const c = document.querySelector(".pdf-canvas");
      return c && c.width > 0 && c.height > 0;
    },
    { timeout: 20_000 },
  )
  .catch(() => {});
const canvasOk = await page.evaluate(() => {
  const c = document.querySelector(".pdf-canvas");
  return !!c && c.width > 0 && c.height > 0;
});
check("pdf page canvas rendered", canvasOk);

const pageIndicator = await page.locator(".pdf-nav .muted").innerText().catch(() => "");
check("page indicator shows", /p\.\s*1\s*\/\s*1/.test(pageIndicator), pageIndicator);

// Seeded sidecar highlight renders as an overlay.
await page.waitForSelector(".pdf-highlight", { timeout: 10_000 }).catch(() => {});
check("seeded highlight renders", (await page.locator(".pdf-highlight").count()) >= 1);

// Clicking the highlight routes to its citing note (attention-mechanism).
await page.locator(".pdf-highlight").first().click();
await page.waitForSelector(".page-title", { timeout: 10_000 }).catch(() => {});
const title = await page.locator(".page-title").innerText().catch(() => "");
check("highlight click opens citing note", /attention-mechanism/i.test(title), title);

// --- Click a [[pdf::…]] link inside a note → viewer opens at page/anchor ---
await page.locator(".nav-item", { hasText: "wiki" }).first().click();
await page.locator(".nav-leaf", { hasText: "pdf-demo" }).first().click();
await page.waitForSelector(".memex-wikilink", { timeout: 10_000 });
check(
  "pdf pinpoint link rendered in note",
  (await page.locator(".memex-wikilink").count()) >= 1,
);
await page.locator(".memex-wikilink").first().click();
await page.waitForSelector('[data-testid="pdf-viewer"]', { timeout: 15_000 }).catch(() => {});
check("clicking pdf link opens viewer", (await page.locator('[data-testid="pdf-viewer"]').count()) > 0);

check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  — " + r.detail : ""}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} checks clean`);
process.exit(failed ? 1 : 0);
