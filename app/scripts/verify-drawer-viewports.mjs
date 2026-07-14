// CLAUDE.md §8.4 three-viewport self-check for the graph settings drawer —
// asserts the new "Bundled strands" toggle renders and the drawer produces no
// horizontal page overflow at mobile / small-window / fullscreen sizes.
import { chromium } from "playwright";

const OUT = process.env.OUT || "/tmp/drawer-vp";
const VIEWPORTS = [
  { name: "mobile", width: 375, height: 667 },
  { name: "small", width: 768, height: 800 },
  { name: "full", width: 1280, height: 800 },
];

const browser = await chromium.launch();
let fails = 0;
for (const vp of VIEWPORTS) {
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
  // Seed the route directly — at mobile width the sidebar nav is collapsed, so
  // clicking the tab text is impossible (verify-graph.mjs precedent).
  await page.addInitScript(() => {
    localStorage.setItem(
      "memex-ui",
      JSON.stringify({ state: { route: "graph", lang: "ko", theme: "dark" }, version: 3 }),
    );
  });
  await page.goto("http://localhost:5173/?mock=1", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".graph-canvas canvas", { timeout: 30000 });
  // Open the settings drawer (gear).
  await page
    .locator('button[title*="설정"], button[aria-label*="설정"], button[title*="Settings"], button[aria-label*="Settings"]')
    .last()
    .click()
    .catch(async () => page.locator(".graph-toolbar button").last().click());
  const toggle = page.getByText("번들 스트랜드", { exact: false }).first();
  let toggleVisible = true;
  try {
    await toggle.scrollIntoViewIfNeeded({ timeout: 5000 });
    await toggle.waitFor({ state: "visible", timeout: 5000 });
  } catch {
    toggleVisible = false;
  }
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  await page.screenshot({ path: `${OUT}-${vp.name}.png` });
  const ok = toggleVisible && !overflow;
  if (!ok) fails++;
  console.log(
    `${vp.name} ${vp.width}x${vp.height}: toggle=${toggleVisible} hOverflow=${overflow} -> ${ok ? "PASS" : "FAIL"}`,
  );
  await page.close();
}
await browser.close();
console.log(fails === 0 ? "VIEWPORTS PASS" : `VIEWPORTS FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
