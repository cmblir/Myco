// Re-capture README screenshots from the app on the ?mock dev vault.
// Headed (real GPU) so the graph's selective bloom / calm-cosmic-web look
// renders. Writes PNGs to docs/screenshots/ and a frame sequence for mesh.gif.
// Usage (dev server on :5173): node scripts/capture-shots.mjs
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import path from "path";

const OUT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../docs/screenshots",
);
const BASE = "http://localhost:5173/?mock=1";
const VP = { width: 1280, height: 820 };

const browser = await chromium.launch({ headless: false });
const page = await browser.newPage({ viewport: VP, deviceScaleFactor: 2 });

// Workspace nav is the first .nav-group's .nav-item buttons, in order:
// overview(0) graph(1) history(2) provenance(3) tags(4).
const nav = (i) =>
  page.locator(".side-nav .nav-group").first().locator(".nav-item").nth(i);

// English UI for the English README, and pre-dismiss the onboarding overlay.
await page.addInitScript(() => {
  localStorage.setItem("memex.onboarded", "1");
  localStorage.setItem("memex-ui", JSON.stringify({ state: { lang: "en" }, version: 3 }));
});
await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForSelector(".side-nav .nav-item", { timeout: 30_000 });

async function shot(name, { settle = 800 } = {}) {
  await page.waitForTimeout(settle);
  await page.screenshot({ path: path.join(OUT, name) });
  console.log("wrote", name);
}

// Overview
await nav(0).click();
await page.waitForSelector(".page-title", { timeout: 20_000 });
await shot("overview.png");

// Provenance
await nav(3).click();
await page.waitForSelector(".page-title", { timeout: 20_000 });
await shot("provenance.png");

// Tags (new)
await nav(4).click();
await page.waitForSelector(".page-title", { timeout: 20_000 });
await shot("tags.png");

// Settings (tools nav-group, first item)
await page
  .locator(".side-nav .nav-group")
  .last()
  .locator(".nav-item")
  .first()
  .click();
await page.waitForSelector(".page-title", { timeout: 20_000 });
await shot("settings.png");

// Reader — open a wiki page from the sidebar page list
await page.locator(".nav-leaf").first().click().catch(() => {});
await page.waitForTimeout(1200);
await page.screenshot({ path: path.join(OUT, "reader.png") });
console.log("wrote reader.png");

// Graph hero — the seeded ~50-note starter vault (real LLM topic labels,
// honest "day one" look), let it settle + orbit.
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await nav(1).click();
await page.waitForSelector(".graph-canvas.graph-ready", { timeout: 90_000 });
await page.waitForTimeout(9000); // settle + a bit of auto-orbit
await page.screenshot({ path: path.join(OUT, "hero-mesh.png") });
console.log("wrote hero-mesh.png");

// mesh.gif frames — capture N frames of the idle auto-orbit.
const frames = 40;
for (let i = 0; i < frames; i++) {
  await page.screenshot({ path: path.join(OUT, `_frame_${String(i).padStart(3, "0")}.png`) });
  await page.waitForTimeout(140);
}
console.log(`wrote ${frames} gif frames`);

await browser.close();
