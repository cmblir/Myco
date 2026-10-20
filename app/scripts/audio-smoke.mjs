// Audio Overview E2E (Feature 5). Opens a wiki page in the Reader, triggers
// "Audio overview" (explicit in-memory native-command lookalikes; no model,
// native authority, remote/process drain, or disk publication), and asserts the
// synthetic transcript renders speaker-tagged turns with page
// citations and a player. Playback uses the browser Web Speech API; headless
// Chromium may have no voices, so we only assert the UI + that Play doesn't
// throw (the panel degrades to transcript-only when TTS is unavailable).
//
// Usage (dev server on :5173):  node scripts/audio-smoke.mjs [--headed]
import { chromium } from "playwright";

const headed = process.argv.includes("--headed");
const BASE = `${process.env.MYCO_TEST_URL ?? "http://127.0.0.1:5173"}/?mock=1&audioFixture=1&audioDelayMs=1500`;

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
  localStorage.setItem("myco.onboarded", "1");
  localStorage.setItem(
    "myco-ui",
    JSON.stringify({ state: { lang: "en", theme: "light" }, version: 3 }),
  );
});

await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForSelector(".side-nav .nav-item", { timeout: 30_000 });

// Synthetic role selections let this fixture reach Audio UI without granting
// real native authority or representing downloaded local weights as ready.
await page.evaluate(async () => {
  const { selectedRolesFixture } = await import("/src/lib/modelRoles.testSupport.ts");
  const invoke = window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__);
  const calls = [];
  window.__audioSmokeCalls = calls;
  window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
    if (command === "get_settings") {
      return { ...await invoke(command, args), model_roles: selectedRolesFixture({}) };
    }
    const call = { command, jobId: args.context?.jobId ?? null };
    if (command.startsWith("audio_overview_")) calls.push(call);
    const result = await invoke(command, args);
    if (command === "audio_overview_begin") call.jobId = result.jobId;
    return result;
  };
});

// Open a wiki page via the sidebar tree.
await page.locator(".nav-item", { hasText: "wiki" }).first().click();
await page
  .locator(".nav-leaf", { hasText: "attention-mechanism" })
  .first()
  .click();
await page.waitForSelector(".page-title, .u-page__title", { timeout: 20_000 });

// Stop is a generation action. The synthetic delayed result must not publish
// or render turns after Stop; this does not establish native/model drain.
await page.locator(".rd-more").getByRole("button", { name: "More", exact: true }).click();
await page.getByRole("menuitem", { name: "Audio overview", exact: true }).click();
await page.waitForFunction(() => window.__audioSmokeCalls.some((call) => call.command === "audio_overview_generate"));
await page.getByRole("button", { name: "Stop generating", exact: true }).click();
await page.getByText("Audio cancellation requested.", { exact: true }).waitFor();
await page.waitForTimeout(1_700);
check("synthetic generation Stop ignores late dialogue", (await page.locator(".au-turn").count()) === 0);
const stoppedCalls = await page.evaluate(() => window.__audioSmokeCalls);
const stoppedBegin = stoppedCalls.find((call) => call.command === "audio_overview_begin");
const stoppedCancel = stoppedCalls.find((call) => call.command === "audio_overview_cancel");
check("synthetic Stop cancels the exact begun job", !!stoppedBegin?.jobId && stoppedBegin.jobId === stoppedCancel?.jobId);
check("synthetic Stop publishes no transcript", stoppedCalls.every((call) => call.command !== "audio_overview_publish"));
await page.locator(".audio-panel").getByRole("button", { name: "Close", exact: true }).click();

// Trigger the audio overview.
await page.locator(".rd-more").getByRole("button", { name: "More", exact: true }).click();
await page.getByRole("menuitem", { name: "Audio overview", exact: true }).click();

// The panel should appear and then render the transcript once generation
// completes (explicit synthetic dialogue, without any model execution).
await page.waitForSelector(".audio-panel", { timeout: 15_000 });
check("audio panel appears", true);

await page.waitForFunction(() => document.querySelectorAll(".au-turn").length > 0, undefined, { timeout: 15_000 });
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
if (await playBtn.isEnabled()) {
  await playBtn.click();
  await page.waitForTimeout(500);
  check("play does not error", errors.length === beforeErr, errors.slice(beforeErr).join(" | "));
} else {
  console.log("UNVERIFIED audio playback: headless browser has no speech-synthesis voice");
}

// Open-transcript jump exists (synthetic in-memory audio/ entry only).
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
console.log("SYNTHETIC ONLY: model quality, native authority, process drain, disk publication, and installed playback remain unverified here.");
process.exit(failed ? 1 : 0);
