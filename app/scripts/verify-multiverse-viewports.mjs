// CLAUDE.md §8.4 three-viewport self-check for the Multiverse overview route.
// Asserts the universe cards render, there is no horizontal page overflow at
// mobile / small-window / fullscreen sizes, and (at full width) that entering a
// universe navigates to the graph route without a console/page error.
import { chromium } from "playwright";

const OUT = process.env.OUT || "/tmp/mv-vp";
const VIEWPORTS = [
  { name: "mobile", width: 375, height: 667 },
  { name: "small", width: 768, height: 800 },
  { name: "full", width: 1280, height: 800 },
];

const seed = () => {
  localStorage.setItem(
    "memex-ui",
    JSON.stringify({ state: { route: "multiverse", lang: "ko", theme: "dark" }, version: 3 }),
  );
  localStorage.setItem("memex.onboarded", "1");
};

const browser = await chromium.launch();
let fails = 0;

for (const vp of VIEWPORTS) {
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  await page.addInitScript(seed);
  await page.goto("http://localhost:5173/?mock=1", { waitUntil: "domcontentloaded" });

  await page.waitForSelector(".page-title", { timeout: 30000 }).catch(() => {});
  await page.waitForSelector(".mv-card", { timeout: 15000 }).catch(() => {});
  const cardCount = await page.locator(".mv-card").count();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  await page.screenshot({ path: `${OUT}-${vp.name}.png`, fullPage: true });
  const ok = cardCount >= 2 && !overflow && errors.length === 0;
  if (!ok) fails++;
  console.log(
    `${vp.name} ${vp.width}x${vp.height}: cards=${cardCount} hOverflow=${overflow} errors=${errors.length} -> ${ok ? "PASS" : "FAIL"}${errors.length ? " :: " + errors.join(" | ") : ""}`,
  );
  await page.close();
}

// Enter-flow check at full width: clicking a non-active universe's Enter button
// switches the active vault and lands on the graph route.
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  await page.addInitScript(seed);
  await page.goto("http://localhost:5173/?mock=1", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".mv-enter:not([disabled])", { timeout: 30000 });
  await page.locator(".mv-enter:not([disabled])").first().click();
  // The graph route renders a canvas; wait for it (three.js chunk parse).
  const arrived = await page
    .waitForFunction(() => !!document.querySelector(".graph-canvas canvas"), { timeout: 30000 })
    .then(() => true)
    .catch(() => false);
  await page.waitForTimeout(3000);
  const ok = arrived && errors.length === 0;
  if (!ok) fails++;
  console.log(
    `enter-flow: arrivedGraph=${arrived} errors=${errors.length} -> ${ok ? "PASS" : "FAIL"}${errors.length ? " :: " + errors.join(" | ") : ""}`,
  );
  await page.close();
}

await browser.close();
console.log(fails === 0 ? "MULTIVERSE VIEWPORTS PASS" : `MULTIVERSE VIEWPORTS FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
