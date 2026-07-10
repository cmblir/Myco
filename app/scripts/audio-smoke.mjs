// Audio Overview E2E (Feature 5). Opens a wiki page in the Reader, triggers
// "Audio overview" (script generated from the page + neighbours via the mocked
// LLM), and asserts the transcript renders speaker-tagged turns with page
// citations and a player. Playback uses the browser Web Speech API; headless
// Chromium may have no voices, so we only assert the UI + that Play doesn't
// throw (the panel degrades to transcript-only when TTS is unavailable).
//
// Usage (dev server on :5173):  node scripts/audio-smoke.mjs [--headed]
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
const check = (name, ok, detail = "") => results.push({ name, ok, detail });

await page.addInitScript(() => {
  localStorage.setItem("memex.onboarded", "1");
  localStorage.setItem(
    "memex-ui",
    JSON.stringify({ state: { lang: "en", theme: "light" }, version: 3 }),
  );
});

await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForSelector(".side-nav .nav-item", { timeout: 30_000 });

// Open a wiki page via the sidebar tree.
await page.locator(".nav-item", { hasText: "wiki" }).first().click();
await page
  .locator(".nav-leaf", { hasText: "attention-mechanism" })
  .first()
  .click();
await page.waitForSelector(".page-title", { timeout: 20_000 });

// Trigger the audio overview.
await page.locator(".btn", { hasText: "Audio overview" }).first().click();

// The panel should appear and then render the transcript once generation
// completes (mocked LLM returns dialogue JSON).
await page.waitForSelector(".audio-panel", { timeout: 15_000 });
check("audio panel appears", true);

await page
  .waitForFunction(() => document.querySelectorAll(".au-turn").length > 0, {
    timeout: 15_000,
  })
  .catch(() => {});
const turns = await page.locator(".au-turn").count();
check("transcript turns rendered", turns >= 2, `turns=${turns}`);

const speakers = await page.locator(".au-speaker").allInnerTexts();
check(
  "speaker tags present",
  speakers.some((s) => /Host/i.test(s)) && speakers.some((s) => /Guest/i.test(s)),
  speakers.join(","),
);

const cites = await page.locator(".au-cite").count();
check("page citations present", cites >= 1, `cites=${cites}`);

// The player controls exist (Play or the no-TTS notice).
const hasPlay = (await page.locator(".au-controls").count()) > 0;
check("player controls present", hasPlay);

// Clicking Play must not throw (works with voices, degrades without).
const beforeErr = errors.length;
const playBtn = page.locator(".au-controls .btn").first();
if (await playBtn.isEnabled().catch(() => false)) {
  await playBtn.click().catch(() => {});
  await page.waitForTimeout(500);
}
check("play does not error", errors.length === beforeErr, errors.slice(beforeErr).join(" | "));

// Open-transcript jump exists (transcript persisted to audio/).
check(
  "open-transcript link present",
  (await page.locator(".btn", { hasText: "Open transcript" }).count()) > 0,
);

check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  — " + r.detail : ""}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} checks clean`);
process.exit(failed ? 1 : 0);
