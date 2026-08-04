// Re-capture README screenshots from the app on the ?mock dev vault.
// Headed (real GPU) so the graph's selective bloom / calm-cosmic-web look
// renders. Writes PNGs to docs/screenshots/ and a frame sequence for mesh.gif.
// Usage (dev server on :5173): node scripts/capture-shots.mjs
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import path from "path";
import fs from "node:fs";
import os from "node:os";
import { execSync } from "node:child_process";

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
  localStorage.setItem("myco.onboarded", "1");
  localStorage.setItem("myco-ui", JSON.stringify({ state: { lang: "en" }, version: 3 }));
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

// Settings — by label, not by position. The TOOLS group grew a Schedules
// entry above it, so `.nav-item.first()` silently captured Schedules under
// the settings.png filename.
await page.locator(".side-nav .nav-item", { hasText: "Settings" }).first().click();
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
// Wait for the sidebar to hydrate before clicking. Without this the click
// lands on nothing, the app stays on Overview, and the graph wait below times
// out after 90s having never navigated.
await page.waitForSelector(".side-nav .nav-item", { timeout: 30_000 });
await nav(1).click();
await page.waitForSelector(".graph-canvas.graph-ready", { timeout: 90_000 });
await page.waitForTimeout(9000); // settle + a bit of auto-orbit
// Park the cursor outside the canvas. Whatever node sat under the pointer
// after the nav click otherwise keeps a hover tooltip open, printed straight
// across the cluster labels.
await page.mouse.move(5, 5);
// Deliberately NOT clicking "fit": it zooms past the label fade threshold, so
// per-node labels switch on and collide with the cluster labels. The settled
// zoom is what every previous hero shot used.
const heroRaw = path.join(os.tmpdir(), "myco-hero-raw.png");
await page.screenshot({ path: heroRaw });
// Downscale for the README. The shot is 2560px wide (deviceScaleFactor 2);
// GitHub renders it in a ~900px column, and the nebula gradients make the
// full-size PNG ~2 MB — heavy for the first image on the page.
execSync(
  `ffmpeg -y -i ${heroRaw} -vf "scale=1920:-1:flags=lanczos" ${path.join(OUT, "hero-mesh.png")}`,
  { stdio: "inherit" },
);
fs.rmSync(heroRaw, { force: true });
console.log(
  `wrote hero-mesh.png (${Math.round(fs.statSync(path.join(OUT, "hero-mesh.png")).size / 1024)} KB)`,
);

// mesh.gif — sample the idle auto-orbit, then assemble. The frames used to be
// left behind in docs/screenshots/ with no assembly step at all, so the GIF
// silently kept whatever was committed months earlier.
const frames = 32;
const frameDir = fs.mkdtempSync(path.join(os.tmpdir(), "myco-mesh-"));
for (let i = 0; i < frames; i++) {
  await page.screenshot({ path: path.join(frameDir, `f_${String(i).padStart(3, "0")}.png`) });
  await page.waitForTimeout(140);
}
await browser.close();

// 128 colours and a coarse Bayer dither: the glow gradients are what cost
// bytes here, and a finer dither pushed the file past 5 MB for a README that
// loads it inline.
execSync(
  `ffmpeg -y -framerate 15 -i ${frameDir}/f_%03d.png ` +
    `-vf "fps=15,scale=800:-1:flags=lanczos,split[s0][s1];` +
    `[s0]palettegen=max_colors=96[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5" ` +
    `${path.join(OUT, "mesh.gif")}`,
  { stdio: "inherit" },
);
fs.rmSync(frameDir, { recursive: true, force: true });
const kb = Math.round(fs.statSync(path.join(OUT, "mesh.gif")).size / 1024);
console.log(`wrote mesh.gif (${kb} KB)`);
