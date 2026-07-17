// The crash screen has to render, in every viewport, when the app is broken.
//
// It carries MYCO now, and that is exactly where a mascot is most likely to
// make things worse: MascotClip reads a store, sniffs the engine and decodes
// alpha video, so if any of that is what threw, mounting it inside the boundary
// would blank the window. The crash screen therefore uses a plain <img> on the
// poster frame — this suite exists to keep it that way, by breaking WebGL for
// real and asserting the boundary (and the still) survive it.
//
// Usage (dev server on :5173):  node scripts/crash-screen-smoke.mjs
import { chromium } from "playwright";

const VIEWPORTS = [
  { name: "mobile", width: 375, height: 667 },
  { name: "small", width: 768, height: 800 },
  { name: "full", width: 1280, height: 800 },
];
const SHOTS = "test-results/crash";
const browser = await chromium.launch({ headless: true });
const results = [];

for (const vp of VIEWPORTS) {
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
  page.on("pageerror", () => {}); // the throw is deliberate
  await page.addInitScript(() => {
    localStorage.setItem("memex.onboarded", "1");
    localStorage.setItem(
      "memex-ui",
      JSON.stringify({ state: { lang: "en", theme: "light" }, version: 3 }),
    );
  });
  await page.goto("http://localhost:5173/?mock=1", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector(".side-nav .nav-item", { timeout: 30_000 });

  // Break WebGL only NOW — Overview's MiniGalaxy uses it too, and breaking it
  // before load takes down the app before there is a sidebar to click.
  // Throwing from getContext is the real failure the graph boundary exists for.
  await page.evaluate(() => {
    const get = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      if (String(type).startsWith("webgl")) throw new Error("simulated GPU failure");
      return get.call(this, type, ...rest);
    };
  });
  // The sidebar collapses at the small viewports — open it first, same as
  // multiverse-smoke does, or the nav click just times out.
  if (vp.width <= 768) {
    await page.locator(".topbar .icon-btn").first().click();
    await page.waitForTimeout(400);
  }
  await page.locator(".side-nav .nav-item", { hasText: "Graph" }).first().click();
  await page.waitForSelector(".error-boundary", { timeout: 20_000 });
  await page.waitForTimeout(600);

  const out = await page.evaluate(() => {
    const eb = document.querySelector(".error-boundary");
    const img = document.querySelector(".error-boundary__mascot");
    return {
      rendered: !!eb,
      title: eb?.querySelector(".error-boundary__title")?.textContent ?? null,
      mascot: !!img,
      mascotLoaded: img ? img.naturalWidth > 0 : false,
      button: eb?.querySelector("button")?.textContent ?? null,
      // A modal/overlay must not scroll the page sideways.
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
  const ok =
    out.rendered && out.mascot && out.mascotLoaded && !out.overflowX && !!out.title;
  results.push({ n: `[${vp.name}] crash screen renders with a loaded still, no overflow`, ok, d: JSON.stringify(out) });
  await page.screenshot({ path: `${SHOTS}/${vp.name}.png` });
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
