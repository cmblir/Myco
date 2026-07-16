// CLAUDE.md §8.4 three-viewport self-check for MULTIVERSE MODE inside the Graph.
// Multiverse is no longer a separate route — it's a toggle in the graph settings
// (Display › Multiverse). Seeding it on, the Graph view renders every project as
// a glowing universe-bubble. Asserts the 3D canvas mounts, there is no
// horizontal page overflow at mobile / small-window / fullscreen sizes, and the
// scene draws without a console/page error.
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
    JSON.stringify({ state: { route: "graph", lang: "ko", theme: "dark" }, version: 3 }),
  );
  localStorage.setItem("memex.onboarded", "1");
  // Turn multiverse mode on in the graph settings.
  localStorage.setItem("memex.graph.settings.v26", JSON.stringify({ multiverse: true }));
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

  const canvas = await page
    .waitForSelector(".mv-scene canvas", { timeout: 30000 })
    .then(() => true)
    .catch(() => false);
  await page.waitForTimeout(4000);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  await page.screenshot({ path: `${OUT}-graph-mv-${vp.name}.png` });
  const ok = canvas && !overflow && errors.length === 0;
  if (!ok) fails++;
  console.log(
    `graph-multiverse ${vp.name} ${vp.width}x${vp.height}: canvas=${canvas} hOverflow=${overflow} errors=${errors.length} -> ${ok ? "PASS" : "FAIL"}${errors.length ? " :: " + errors.join(" | ") : ""}`,
  );
  await page.close();
}

// The Multiverse toggle exists in the graph settings drawer.
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  // Seed with multiverse OFF, then open the drawer and confirm the toggle is there.
  await page.addInitScript(() => {
    localStorage.setItem(
      "memex-ui",
      JSON.stringify({ state: { route: "graph", lang: "ko", theme: "dark" }, version: 3 }),
    );
    localStorage.setItem("memex.onboarded", "1");
  });
  await page.goto("http://localhost:5173/?mock=1", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".graph-canvas canvas", { timeout: 30000 }).catch(() => {});
  // Open the settings drawer (gear button in the toolbar).
  await page.locator(".graph-toolbar__btn").nth(-2).click().catch(() => {});
  const hasToggle = await page
    .getByText(/멀티버스|Multiverse/)
    .first()
    .isVisible()
    .catch(() => false);
  if (!hasToggle) fails++;
  console.log(`settings-toggle present: ${hasToggle} -> ${hasToggle ? "PASS" : "FAIL"}`);
  await page.close();
}

await browser.close();
console.log(fails === 0 ? "MULTIVERSE (in-graph) PASS" : `MULTIVERSE (in-graph) FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
