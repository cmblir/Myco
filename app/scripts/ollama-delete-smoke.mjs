// Usage (dev server on :5173):  node scripts/ollama-delete-smoke.mjs
//
// The installed-model list on Settings › Connections must let you remove a
// pulled Ollama model without a terminal: a trash button → inline "Remove?"
// confirm (no native dialog) → DELETE /api/delete. ?mock=1&ollama=1 fakes a
// running daemon with two models; the DELETE is intercepted so no real Ollama
// is needed. 3 viewports.
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
  });

  // Intercept the model delete so it succeeds without a real daemon, and record
  // which model name was sent.
  let deletedName = null;
  await page.route("**/api/delete", async (route) => {
    try {
      deletedName = JSON.parse(route.request().postData() || "{}").name ?? null;
    } catch {
      deletedName = null;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: '{"status":"success"}' });
  });

  await page.goto("http://localhost:5173/?mock=1&ollama=1", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector(".side-nav .nav-item", { timeout: 30_000 });
  const at = (n) => `[${vp.name}] ${n}`;

  // Open the nav drawer on narrow viewports, then Settings.
  if (vp.width <= 768) {
    await page.locator(".topbar .icon-btn").first().click();
    await page.waitForTimeout(300);
  }
  await page.locator(".side-nav").getByRole("button", { name: /Settings|설정|設定/ }).first().click();
  await page.waitForSelector(".page-title", { timeout: 20_000 });

  // The Connections tab holds the provider cards, incl. Ollama.
  await page.locator(".qbtn", { hasText: /Connections|연결|接続/ }).first().click();
  await page.waitForTimeout(600);

  // Two installed models render, each with a remove (trash) button.
  const removeButtons = page.getByRole("button", { name: /Remove model|모델 삭제|モデルを削除/ });
  await removeButtons.first().waitFor({ timeout: 10_000 }).catch(() => {});
  check(at("installed models list two remove buttons"), (await removeButtons.count()) === 2, String(await removeButtons.count()));

  // Click trash on the first → inline confirm (no native dialog): a Remove +
  // Cancel pair appears.
  await removeButtons.first().click();
  await page.waitForTimeout(200);
  const confirmYes = page.getByRole("button", { name: /^Remove$|^삭제$|^削除$/ });
  const cancel = page.getByRole("button", { name: /^Cancel$|^취소$/ });
  check(at("inline confirm shows a Remove button"), (await confirmYes.count()) >= 1);
  check(at("inline confirm shows a Cancel button"), (await cancel.count()) >= 1);

  // Cancel closes the confirm without deleting.
  await cancel.first().click();
  await page.waitForTimeout(200);
  check(at("cancel closes the confirm"), (await page.getByRole("button", { name: /^Remove$|^삭제$|^削除$/ }).count()) === 0);
  check(at("cancel sent no delete request"), deletedName === null, String(deletedName));

  // Trash again → Remove → the DELETE fires with the first model's name, then
  // the confirm closes (the mock re-lists two models, so the flow completed).
  await page.getByRole("button", { name: /Remove model|모델 삭제|モデルを削除/ }).first().click();
  await page.waitForTimeout(200);
  await page.getByRole("button", { name: /^Remove$|^삭제$|^削除$/ }).first().click();
  await page.waitForFunction(
    () => !document.body.textContent.includes("Remove?"),
    null,
    { timeout: 10_000 },
  ).catch(() => {});
  check(at("delete request fired with the model name"), deletedName === "gemma3:1b", String(deletedName));
  check(at("confirm closed after delete"), (await page.getByRole("button", { name: /^Remove$|^삭제$|^削除$/ }).count()) === 0);

  await page.screenshot({ path: `test-results/ollama-delete/${vp.name}.png` });
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
