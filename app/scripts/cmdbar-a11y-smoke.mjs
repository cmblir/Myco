// The command palette has to be operable, and legible, without a mouse.
//
// It was the outlier: a modal overlay with no dialog role, no focus trap, and
// its only key handler bound to the <input>. One Tab away from the input the
// palette went dead — Escape and both arrows ignored — and Tab eventually
// walked focus onto live controls sitting *behind* the overlay. Worst of all,
// arrow selection was signalled by background-colour alone, so a screen reader
// announced nothing as the selection moved (WCAG 4.1.2, and the project's own
// "never encode information in colour alone" rule).
//
// Usage (dev server on :5173):  node scripts/cmdbar-a11y-smoke.mjs
import { chromium } from "playwright";

const VIEWPORTS = [
  { name: "mobile", width: 375, height: 667 },
  { name: "small", width: 768, height: 800 },
  { name: "full", width: 1280, height: 800 },
];

const browser = await chromium.launch({ headless: true });
const results = [];
const check = (n, ok, d = "") => results.push({ n, ok, d });

async function openPalette(vp) {
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
  await page.addInitScript(() => {
    localStorage.setItem("memex.onboarded", "1");
    localStorage.setItem(
      "memex-ui",
      JSON.stringify({ state: { lang: "en", theme: "light" }, version: 3 }),
    );
  });
  await page.goto("http://localhost:5173/?mock=1", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.waitForSelector(".side-nav .nav-item", { timeout: 30_000 });
  await page.keyboard.press("Meta+k");
  await page.waitForSelector(".cmd-panel", { timeout: 10_000 });
  await page.waitForTimeout(400);
  return page;
}

const SHOTS = "test-results/cmdbar";

const activeInfo = (page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    return {
      tag: el?.tagName ?? null,
      cls: el?.className ?? null,
      inPanel: !!document.querySelector(".cmd-panel")?.contains(el),
    };
  });

for (const vp of VIEWPORTS) {
  const page = await openPalette(vp);
  const at = (n) => `[${vp.name}] ${n}`;

  // --- semantics -----------------------------------------------------------
  const panel = page.locator(".cmd-panel");
  check(at("panel is a modal dialog"), (await panel.getAttribute("role")) === "dialog");
  check(at("panel is aria-modal"), (await panel.getAttribute("aria-modal")) === "true");
  check(at("panel is labelled"), !!(await panel.getAttribute("aria-label")));

  const input = page.locator(".cmd-input input");
  check(at("input is a combobox"), (await input.getAttribute("role")) === "combobox");
  check(at("input controls the list"), !!(await input.getAttribute("aria-controls")));

  const list = page.locator(".cmd-list");
  check(at("list is a listbox"), (await list.getAttribute("role")) === "listbox");

  // --- selection is announced, not just coloured ---------------------------
  await page.keyboard.type("a");
  await page.waitForTimeout(500);
  const firstRow = page.locator(".cmd-row.active").first();
  check(at("active row is an option"), (await firstRow.getAttribute("role")) === "option");
  check(at("active row is aria-selected"), (await firstRow.getAttribute("aria-selected")) === "true");
  const desc = await input.getAttribute("aria-activedescendant");
  check(at("input points at the active row"), !!desc && desc === (await firstRow.getAttribute("id")), String(desc));

  // ...and the sighted keyboard user must SEE it move. The rows are <button>s,
  // so an inline `background: transparent` reset once beat .cmd-row.active in
  // the cascade and the highlight never rendered at all — in either theme.
  const bgs = await page.evaluate(() => {
    const act = document.querySelector(".cmd-row.active");
    const inact = [...document.querySelectorAll(".cmd-row")].find(
      (r) => !r.classList.contains("active"),
    );
    return [
      act && getComputedStyle(act).backgroundColor,
      inact && getComputedStyle(inact).backgroundColor,
    ];
  });
  check(
    at("the active row is visibly highlighted"),
    !!bgs[0] && bgs[0] !== bgs[1] && bgs[0] !== "rgba(0, 0, 0, 0)",
    `active=${bgs[0]} inactive=${bgs[1]}`,
  );

  // Moving the selection must move what is announced.
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(300);
  const desc2 = await input.getAttribute("aria-activedescendant");
  check(at("arrowing moves aria-activedescendant"), !!desc2 && desc2 !== desc, `${desc} -> ${desc2}`);

  // --- keyboard works wherever focus is ------------------------------------
  await page.keyboard.press("Tab");
  await page.waitForTimeout(200);
  const afterTab = await activeInfo(page);
  check(at("Tab keeps focus inside the panel"), afterTab.inPanel, JSON.stringify(afterTab));

  // Many tabs must never escape a modal.
  for (let i = 0; i < 12; i++) await page.keyboard.press("Tab");
  await page.waitForTimeout(200);
  const afterMany = await activeInfo(page);
  check(at("focus never escapes the modal"), afterMany.inPanel, JSON.stringify(afterMany));

  await page.screenshot({ path: `${SHOTS}/${vp.name}.png` });

  // Escape must close from wherever focus landed.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  check(at("Escape closes the palette"), (await page.locator(".cmd-panel").count()) === 0);

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
