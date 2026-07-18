// PageHistory rows had a role="link" span nested inside a disclosure <button>:
// invalid interactive nesting that polluted the button's accessible name. The
// row is now three sibling buttons — disclosure, Open report, chevron — each
// with its own name and no nesting.
import { chromium } from "playwright";
// Usage (dev server on :5173):  node scripts/history-a11y-smoke.mjs

const VIEWPORTS = [
  { name: "mobile", width: 375, height: 667 },
  { name: "small", width: 768, height: 800 },
  { name: "full", width: 1280, height: 800 },
];
const browser = await chromium.launch({ headless: true });
const results = [];
const check = (n, ok, d = "") => results.push({ n, ok, d });

for (const vp of VIEWPORTS) {
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
  await page.addInitScript(() => {
    localStorage.setItem("memex.onboarded", "1");
    localStorage.setItem("memex-ui", JSON.stringify({ state: { lang: "en", theme: "light" }, version: 3 }));
  });
  await page.goto("http://localhost:5173/?mock=1", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector(".side-nav .nav-item", { timeout: 30_000 });
  if (vp.width <= 768) {
    await page.locator(".topbar .icon-btn").first().click();
    await page.waitForTimeout(300);
  }
  await page.locator(".side-nav .nav-item", { hasText: /History|히스토리/ }).first().click();
  await page.waitForTimeout(1000);
  const at = (n) => `[${vp.name}] ${n}`;

  const info = await page.evaluate(() => {
    const card = document.querySelector(".card");
    if (!card) return { noCard: true };
    // No interactive element may sit inside another (button/a/[role=link]/[role=button]).
    const interactive = "button, a, [role='link'], [role='button']";
    const nested = [...card.querySelectorAll(interactive)].filter((el) =>
      el.parentElement?.closest(interactive),
    );
    const buttons = [...card.querySelectorAll("button")];
    const names = buttons.map(
      (b) => b.getAttribute("aria-label") || b.textContent?.trim() || "",
    );
    return {
      nestedCount: nested.length,
      buttonCount: buttons.length,
      names,
      hasRoleLink: !!card.querySelector("[role='link']"),
    };
  });

  if (info.noCard) {
    check(at("has a history row"), false, "no .card found");
  } else {
    check(at("no interactive element is nested in another"), info.nestedCount === 0, JSON.stringify(info.nestedCount));
    check(at("no role=link remains"), info.hasRoleLink === false);
    check(at("the row exposes three named buttons"), info.buttonCount >= 3 && info.names.every((n) => n.length > 0), JSON.stringify(info.names));
  }

  // The disclosure still works: clicking the first button toggles the preview.
  const firstBtn = page.locator(".card button").first();
  await firstBtn.click();
  await page.waitForTimeout(500);
  const expanded = await page.locator(".ingest-preview-body").count();
  check(at("disclosure still expands"), expanded > 0, String(expanded));

  await page.screenshot({ path: `test-results/history-a11y/${vp.name}.png` });
  await page.close();
}

await browser.close();
let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.n}${r.d ? "  — " + r.d : ""}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
