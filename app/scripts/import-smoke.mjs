// Usage (dev server on :5173):  node scripts/import-smoke.mjs
//
// The conversation-import card must render on Ingest, run an import, and show
// both the success and the secret-quarantine warning (the mock returns one of
// each). 3 viewports.
import { chromium } from "playwright";

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
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem("memex.onboarded", "1");
    localStorage.setItem("memex-ui", JSON.stringify({ state: { lang: "en", theme: "light" }, version: 3 }));
    // The card calls the dialog plugin's open() for the file path; stub it to a
    // fixed path so the flow proceeds to import_conversations (which the mock
    // answers).
    window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
  });
  await page.goto("http://localhost:5173/?mock=1", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector(".side-nav .nav-item", { timeout: 30_000 });
  if (vp.width <= 768) {
    await page.locator(".topbar .icon-btn").first().click();
    await page.waitForTimeout(300);
  }
  await page.locator(".qbtn", { hasText: /Ingest|가져오기|取り込み/ }).first().click();
  await page.waitForTimeout(800);
  const at = (n) => `[${vp.name}] ${n}`;

  // The card renders.
  const card = page.locator("section.zotero-import", { hasText: /Import a conversation/ });
  check(at("import card renders"), (await card.count()) >= 1, String(await card.count()));

  const btn = card.getByRole("button", { name: /Choose a file/ });
  check(at("import button present"), (await btn.count()) === 1);

  // Click it: the mock dialog returns a path, import_conversations returns one
  // imported + one quarantined, so both the success line and the secret warning
  // must appear.
  await btn.click();
  await page.waitForTimeout(800);
  const resultText = await card.locator(".zotero-import__result").allInnerTexts();
  check(at("success line shows the import count"), resultText.some((x) => /_inbox/.test(x)), JSON.stringify(resultText));
  check(at("secret quarantine warning shows"), (await card.locator("[data-testid='import-secret-warning']").count()) === 1);

  // The session-sweep buttons import everything on disk in one click.
  const cc = card.getByRole("button", { name: /Claude Code sessions/ });
  const cx = card.getByRole("button", { name: /Codex sessions/ });
  check(at("Claude Code sweep button present"), (await cc.count()) === 1);
  check(at("Codex sweep button present"), (await cx.count()) === 1);
  await cc.click();
  // A progress bar shows while the sweep streams (mock: ~14 files over ~840ms).
  await page.waitForSelector("[data-testid='import-progress']", { timeout: 5_000 }).catch(() => {});
  check(at("a progress bar shows during the sweep"),
    (await card.locator("[data-testid='import-progress']").count()) === 1);

  // Then the result line lands.
  await page
    .waitForFunction(
      () =>
        [...document.querySelectorAll(".zotero-import__result")].some((el) =>
          /_inbox/.test(el.textContent || ""),
        ),
      null,
      { timeout: 10_000 },
    )
    .catch(() => {});
  const sweepText = await card.locator(".zotero-import__result").allInnerTexts();
  check(at("sweep reports an import count into _inbox"),
    sweepText.some((x) => /_inbox/.test(x) && /\d/.test(x)), JSON.stringify(sweepText));

  // The failures list + retry appear (mock returns 2 failures).
  const failures = card.locator("[data-testid='import-failures']");
  check(at("failures list appears"), (await failures.count()) === 1);
  const retry = failures.getByRole("button", { name: /Retry failed/ });
  check(at("retry button present"), (await retry.count()) === 1);
  // Retry succeeds in the mock → failures clear.
  await retry.click();
  await page.waitForFunction(
    () => document.querySelector("[data-testid='import-failures']") === null,
    null,
    { timeout: 10_000 },
  ).catch(() => {});
  check(at("retry clears the failures"),
    (await card.locator("[data-testid='import-failures']").count()) === 0);

  await page.screenshot({ path: `test-results/import-card/${vp.name}.png` });
  check(at("no page errors"), errors.length === 0, errors.slice(0, 1).join("; "));
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
