// User-facing copy has to follow the chosen language — including on the config
// a fresh install actually has.
//
// uiStore defaults lang to "ko", so the account panel rendered a Korean header
// ("계정") directly above English literals ("Local user", "Vault path",
// "Change…"). The literals were invisible to review because they sat in the
// same JSX return as the translated header, and nothing tested rendered copy.
//
// Usage (dev server on :5173):  node scripts/i18n-smoke.mjs
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const results = [];
const check = (n, ok, d = "") => results.push({ n, ok, d });
// CSS uppercases <label>, so compare case-insensitively.
const hasText = (hay, needle) =>
  hay.toLowerCase().includes(needle.toLowerCase());

async function settingsText(lang) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript((l) => {
    localStorage.setItem("memex.onboarded", "1");
    // Only seed the store when overriding; otherwise let the real default win.
    if (l) {
      localStorage.setItem(
        "memex-ui",
        JSON.stringify({ state: { lang: l, theme: "light" }, version: 3 }),
      );
    }
  }, lang);
  await page.goto("http://localhost:5173/?mock=1", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.waitForSelector(".side-nav .nav-item", { timeout: 30_000 });
  await page.locator(".side-nav .nav-item", { hasText: /Settings|설정|設定/ })
    .first()
    .click();
  await page.waitForTimeout(800);
  // Settings is tabbed and opens on Model — the account panel is its own tab.
  await page
    .getByRole("button", { name: /^(Account|계정|アカウント)$/ })
    .first()
    .click();
  await page.waitForTimeout(800);
  const text = await page.locator("main").innerText();
  await page.close();
  return text;
}

// Default config — no lang seeded, so uiStore's own default ("ko") applies.
{
  const text = await settingsText(null);
  check("default install renders Korean chrome", /계정/.test(text), text.slice(0, 60));
  for (const en of ["Local user", "Vault path", "Change…"]) {
    // <label> is uppercased by CSS, so innerText says "VAULT PATH".
    check(`default install has no English "${en}"`, !hasText(text, en));
  }
  check("account label is translated", /로컬 사용자/.test(text));
  check("vault path label is translated", /볼트 경로/.test(text));
}

// Explicit English still reads English.
{
  const text = await settingsText("en");
  check("en still says 'Local user'", hasText(text, "Local user"));
  check("en still says 'Vault path'", hasText(text, "Vault path"));
}

// Japanese.
{
  const text = await settingsText("ja");
  check("ja translates the account label", /ローカルユーザー/.test(text));
  check("ja has no English 'Local user'", !hasText(text, "Local user"));
}

await browser.close();
let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.n}${r.d ? "  — " + r.d : ""}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
