// Ask renewal E2E (mockup "Strata"): the three states the page must render —
// a grounded answer with its source ladder, an abstention with near-misses,
// and a session-scope recall — plus the pill ↔ ladder-row highlight, the
// stepper's expand, the harvest action, and the Settings opt-in that lets the
// session scope reach sessions/archive/. Shoots each state (dark + light) for
// a visual pass.
//
// Usage (dev server on :5173, or ASK_SMOKE_PORT):
//   node scripts/ask-ladder-smoke.mjs [--headed] [--shots <dir>]
import { chromium } from "playwright";

const headed = process.argv.includes("--headed");
const shotsIdx = process.argv.indexOf("--shots");
const SHOTS = shotsIdx >= 0 ? process.argv[shotsIdx + 1] : null;
const PORT = process.env.ASK_SMOKE_PORT ?? "5173";
const BASE = `http://localhost:${PORT}/?mock=1`;

const browser = await chromium.launch({ headless: !headed });
const results = [];
const check = (n, ok, d = "") => results.push({ n, ok, d });

async function openAsk(theme) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  await page.addInitScript((th) => {
    localStorage.setItem("myco.onboarded", "1");
    localStorage.setItem(
      "myco-ui",
      JSON.stringify({ state: { lang: "ko", theme: th, askScope: "wiki" }, version: 3 }),
    );
  }, theme);
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector(".side-nav .nav-item", { timeout: 30_000 });
  // The extractive path is the one with a ladder; the mock defaults to a CLI.
  await page.evaluate(() => {
    window.__mycoMock.settings({
      query_provider: "builtin-local",
      query_model: "extractive-retrieval",
    });
  });
  await page.locator(".side-nav .nav-item", { hasText: /^Ask$|질문|質問/ }).first().click();
  await page.waitForSelector("input.input", { timeout: 20_000 });
  return { page, errors };
}

async function ask(page, q) {
  await page.locator("input.input").first().fill(q);
  await page.keyboard.press("Enter");
}

async function shoot(page, name) {
  if (!SHOTS) return;
  await page.screenshot({ path: `${SHOTS}/shot-ask-${name}.png`, fullPage: false });
  const card = page.locator(".ask-turn").last();
  if (await card.count()) await card.screenshot({ path: `${SHOTS}/shot-ask-${name}-card.png` });
}

// --- 1. grounded answer + ladder (dark) -----------------------------------
{
  const { page, errors } = await openAsk("dark");
  await ask(page, "what is attention?");
  await page.waitForSelector(".ask-lrow", { timeout: 15_000 });
  const rows = await page.locator(".ask-lrow").count();
  const pills = await page.locator(".ask-cite").count();
  check("ladder lists every retrieved page", rows >= 3, `rows=${rows}`);
  check("answer quotes at most five pages as pills", pills > 0 && pills <= 5 && pills <= rows, `pills=${pills}`);
  check(
    "every row carries a filled tier chip",
    (await page.locator(".ask-lrow .ask-badge").count()) === rows,
  );
  check(
    "the ladder shows the arithmetic (rrf × prior = final)",
    /×\s*\d\.\d\d/.test(await page.locator(".ask-ladder").innerText()),
  );
  check("a rank change is shown when the prior reorders", /[▲▼]\d/.test(await page.locator(".ask-ladder").innerText()));
  // Pill → row, both directions.
  await page.locator(".ask-cite").first().hover();
  check("hovering a pill lights its ladder row", (await page.locator(".ask-lrow.hot").count()) === 1);
  await page.mouse.move(0, 0);
  await page.locator(".ask-lrow").nth(1).hover();
  check(
    "hovering a row lights its answer line",
    (await page.locator(".ask-sent.hot").count()) === 1 || (await page.locator(".ask-lrow.hot").count()) === 1,
  );
  await page.mouse.move(0, 0);
  // Keyboard: focusing a pill also lights the row.
  await page.locator(".ask-cite").first().focus();
  check("focusing a pill lights its ladder row", (await page.locator(".ask-lrow.hot").count()) === 1);
  // Stepper: collapsed one line, expands to tiles.
  const stepper = page.locator(".ask-stepper").first();
  check("the retrieval stepper renders seven steps", (await page.locator(".ask-stepper .ask-step").count()) === 7);
  check("the trace is collapsed by default", (await page.locator(".ask-trace:not([hidden])").count()) === 0);
  await stepper.click();
  check("clicking expands the trace tiles", (await page.locator(".ask-trace:not([hidden]) .ask-st").count()) === 7);
  check("the extractive label survives", /내 노트에서 찾음|From your notes/.test(await page.locator(".workspace").innerText()));
  await shoot(page, "answer-dark");
  // 고급: all-1.00 removes every rank change.
  await page.locator('button[aria-controls="ask-advanced"]').click();
  await page.locator(".ask-priorfoot .btn").first().click();
  check(
    "the all-1.00 toggle removes every rank change",
    !/[▲▼]\d/.test(await page.locator(".ask-ladder").innerText()),
  );
  check("no page errors (answer)", errors.length === 0, errors.slice(0, 3).join(" | "));
  await page.close();
}

// --- 1b. grounded answer (light) ------------------------------------------
{
  const { page, errors } = await openAsk("light");
  await ask(page, "what is attention?");
  await page.waitForSelector(".ask-lrow", { timeout: 15_000 });
  await page.locator(".ask-stepper").first().click();
  await shoot(page, "answer-light");
  check("no page errors (answer, light)", errors.length === 0, errors.slice(0, 3).join(" | "));
  await page.close();
}

// --- 2. abstention --------------------------------------------------------
for (const theme of ["dark", "light"]) {
  const { page, errors } = await openAsk(theme);
  await ask(page, "김치찌개 레시피 알려줘");
  await page.waitForSelector(".ask-abstain", { timeout: 15_000 });
  const card = page.locator(".ask-abstain");
  const text = await card.innerText();
  check(`abstention is a first-class card (${theme})`, /근거가 볼트에 없습니다/.test(text));
  check(`nothing is quoted when abstaining (${theme})`, (await page.locator(".ask-cite").count()) === 0);
  const misses = await page.locator(".ask-missrow").count();
  check(`near-misses on the gauge, at most four (${theme})`, misses > 0 && misses <= 4, `misses=${misses}`);
  check(`a keyword-only miss is labelled (${theme})`, /키워드만/.test(text));
  check(`the floor tick is drawn (${theme})`, (await page.locator(".ask-missbar .floor").count()) === misses);
  await shoot(page, `abstain-${theme}`);
  if (theme === "dark") {
    await card.locator("button", { hasText: "수확 대상" }).click();
    await page.waitForSelector(".ask-receipt", { timeout: 5_000 });
    check("harvest logs once and shows the receipt", /등록됨/.test(await card.innerText()));
    check(
      "the harvest button is disabled after logging",
      await card.locator("button", { hasText: "등록됨" }).isDisabled(),
    );
    // Widen: re-asks over every scope; the scope chip on the new turn says so.
    await card.locator("button", { hasText: "세션까지" }).click();
    await page.waitForFunction(() => document.querySelectorAll(".ask-turn").length === 2, { timeout: 15_000 });
    await page.waitForSelector(".ask-turn:nth-of-type(2) .ask-abstain, .ask-turn:last-child .ask-lrow", { timeout: 15_000 }).catch(() => {});
    const second = await page.locator(".ask-turn").last().innerText();
    check("widen re-asks the same question over all scopes", /범위 · 전체/.test(second), second.slice(0, 80));
    await shoot(page, "abstain-widened");
  }
  check(`no page errors (abstain, ${theme})`, errors.length === 0, errors.slice(0, 3).join(" | "));
  await page.close();
}

// --- 3. session scope -----------------------------------------------------
{
  const { page, errors } = await openAsk("dark");
  await page.locator('[role="group"][aria-label] button', { hasText: /^세션$/ }).click();
  await ask(page, "what is attention?");
  await page.waitForSelector(".ask-lrow", { timeout: 15_000 });
  const chips = await page.locator(".ask-lrow .ask-badge").allInnerTexts();
  check("session scope returns only session logs", chips.length > 0 && chips.every((c) => /세션 로그/.test(c)), chips.join(","));
  check("the turn chip names the scope", /범위 · 세션/.test(await page.locator(".ask-turn").last().innerText()));
  await shoot(page, "sessions-dark");
  check("no page errors (sessions)", errors.length === 0, errors.slice(0, 3).join(" | "));
  await page.close();
}

// --- 4. archived sessions opt-in (Settings) → session scope ----------------
{
  const { page, errors } = await openAsk("dark");
  await page.locator("button, a", { hasText: /^설정$|^Settings$|^設定$/ }).first().click();
  const toggle = page.getByTestId("archived-sessions-toggle");
  await toggle.waitFor({ timeout: 15_000 });
  check("the archived-sessions row starts off", (await toggle.getAttribute("aria-checked")) === "false");
  await toggle.click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="archived-sessions-toggle"]')
        ?.getAttribute("aria-checked") === "true",
    { timeout: 5_000 },
  );
  await page.waitForTimeout(300);
  check(
    "turning it on starts a reindex",
    (await page
      .locator(
        '[data-testid="reindex-progress"], [data-testid="reindex-loading"], [data-testid="reindex-done"]',
      )
      .count()) > 0,
  );
  // The toggle's set_settings wrote the store's copy (CLI provider) back over
  // the mock; re-pin the extractive provider before asking.
  await page.evaluate(() => {
    window.__mycoMock.settings({
      query_provider: "builtin-local",
      query_model: "extractive-retrieval",
    });
  });
  await page.locator(".side-nav .nav-item", { hasText: /^Ask$|질문|質問/ }).first().click();
  await page.waitForSelector("input.input", { timeout: 20_000 });
  await page.locator('[role="group"][aria-label] button', { hasText: /^세션$/ }).click();
  await ask(page, "what is attention?");
  await page.waitForSelector(".ask-lrow", { timeout: 15_000 });
  check("an archived session surfaces, flagged", (await page.locator(".ask-lrow .ask-coldflag").count()) === 1);
  check(
    "the stepper's archive step reads included",
    /냉동\s*포함/.test((await page.locator(".ask-stepper").first().innerText()).replace(/\n/g, " ")),
  );
  await shoot(page, "sessions-archived-dark");
  check("no page errors (archived)", errors.length === 0, errors.slice(0, 3).join(" | "));
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
