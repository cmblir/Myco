// Study route E2E (Feature 3, part 2). Drives the seeded deck through the full
// review loop (front → reveal → grade → persist), verifies the due count drops
// after grading, runs the quiz generator, and exercises "Make cards" on a page.
//
// Usage (dev server must be running on :5173):
//   node scripts/study-smoke.mjs [--headed]
import { chromium } from "playwright";

const headed = process.argv.includes("--headed");
const BASE = "http://localhost:5173/?mock=1";

const browser = await chromium.launch({ headless: !headed });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console: ${m.text()}`);
});

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
}

// Seed onboarding + language so the app boots straight into the workspace.
await page.addInitScript(() => {
  localStorage.setItem("memex.onboarded", "1");
  localStorage.setItem(
    "memex-ui",
    JSON.stringify({ state: { lang: "en", theme: "light" }, version: 3 }),
  );
});

await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForSelector(".side-nav .nav-item", { timeout: 30_000 });

// The sidebar badge shows the seeded deck's due total (3).
const badge = await page.locator(".nav-item .nav-badge").first().textContent().catch(() => null);
check("sidebar due badge", badge === "3", `badge=${badge}`);

// Open the Study route.
await page.locator(".side-nav .nav-item", { hasText: "Study" }).first().click();
await page.waitForSelector(".page-title", { timeout: 20_000 });
check("study route title", (await page.locator(".page-title").textContent()) === "Study");

// Deck list shows the seeded deck with a due pill.
await page.waitForSelector(".deck-row", { timeout: 10_000 });
const deckText = await page.locator(".deck-row").first().innerText();
check("deck listed", /transformers/i.test(deckText), deckText.replace(/\n/g, " "));
check("deck due pill", /3 due/.test(deckText), deckText.replace(/\n/g, " "));

// Enter the deck → review session.
await page.locator(".deck-row").first().click();
await page.waitForSelector(".study-card", { timeout: 10_000 });
check("review front shown", (await page.locator(".study-front").count()) > 0);
check(
  "progress 1 of 3",
  /1 \/ 3/.test(await page.locator(".workspace").innerText()),
);

// Grade all three due cards (reveal → Good).
for (let i = 1; i <= 3; i++) {
  await page.locator(".study-flip").click();
  await page.waitForSelector(".study-back", { timeout: 5000 });
  if (i === 1) {
    check("answer revealed", (await page.locator(".study-back").count()) > 0);
    check(
      "citation shown",
      /Source:/.test(await page.locator(".study-card").innerText()),
    );
  }
  await page.locator(".grade-good").click();
  await page.waitForTimeout(200);
}

await page.waitForSelector(".study-done", { timeout: 10_000 });
check("all done reached", (await page.locator(".study-done").count()) > 0);

// Back to decks — the graded cards are now scheduled in the future, so the deck
// should no longer report due cards (persistence round-tripped through disk).
await page.locator(".btn", { hasText: "All decks" }).first().click();
await page.waitForSelector(".deck-row", { timeout: 10_000 });
const deckAfter = await page.locator(".deck-row").first().innerText();
check(
  "due cleared after review",
  /All caught up/.test(deckAfter),
  deckAfter.replace(/\n/g, " "),
);

// Quiz mode: enter deck, switch to Quiz, generate, answer one question.
await page.locator(".deck-row").first().click();
await page.waitForSelector(".segmented", { timeout: 10_000 });
await page.locator(".segmented button", { hasText: "Quiz" }).click();
await page.locator(".btn", { hasText: "Generate quiz" }).click();
await page.waitForSelector(".quiz-choice", { timeout: 10_000 });
check("quiz generated", (await page.locator(".quiz-choice").count()) >= 2);
await page.locator(".quiz-choice").first().click();
await page.waitForTimeout(200);
check(
  "quiz feedback shown",
  /(Correct|Not quite)/.test(await page.locator(".workspace").innerText()),
);

// "Make cards" from a wiki page: open one via the sidebar tree.
await page.locator(".nav-item", { hasText: "wiki" }).first().click();
await page.locator(".nav-leaf", { hasText: "attention-mechanism" }).first().click();
await page.waitForSelector(".page-title", { timeout: 20_000 });
const beforeErr = errors.length;
try {
  const makeBtn = page.locator(".btn", { hasText: "Make cards" }).first();
  await makeBtn.waitFor({ timeout: 10_000 });
  await makeBtn.click();
  await page
    .waitForFunction(() => /cards added/.test(document.body.innerText), { timeout: 15_000 })
    .catch(() => {});
  check(
    "make cards result",
    /cards added/.test(await page.locator(".workspace").innerText()),
    "no 'cards added' message",
  );
  check("make cards no errors", errors.length === beforeErr, errors.slice(beforeErr).join(" | "));
} catch (e) {
  await page.screenshot({ path: "/tmp/study-makecards.png" }).catch(() => {});
  check("make cards result", false, String(e).split("\n")[0]);
}

await browser.close();

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  — " + r.detail : ""}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} checks clean`);
if (errors.length) console.log(`\n${errors.length} page/console errors:\n` + errors.join("\n"));
process.exit(failed ? 1 : 0);
