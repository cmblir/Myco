// Topbar activity E2E. The owner's complaint was that the bar was
// disconnected from the app — a harvest run (twenty ingest passes, minutes of
// work) showed nothing at all, and distill left no trace once it ended.
//
// The invariant this guards: ONE spinner. Every live run reports through the
// activity chip's running list; the bar's own pills cover finished runs only.
// Two runners must collapse into one "활동 2" chip, never two spinning pills.
//
// Usage (dev server on :5199):  node scripts/topbar-activity-smoke.mjs
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const PORT = process.env.PORT ?? "5199";
const BASE = `http://localhost:${PORT}/?mock=1`;
const SHOTS = "test-results/topbar-activity";
mkdirSync(SHOTS, { recursive: true });

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "  ok" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** Drive the stores the Topbar reads. Vite serves each module at one URL, so a
 * dynamic import here resolves to the very instance the app is subscribed to. */
async function setStores(page, patch) {
  await page.evaluate(async (p) => {
    const { useHarvestStore } = await import("/src/stores/harvestStore.ts");
    const { useDistillRunStore } = await import(
      "/src/stores/distillRunStore.ts"
    );
    const { useUIStore } = await import("/src/stores/uiStore.ts");
    if (p.route) useUIStore.getState().setRoute(p.route);
    if (p.harvest) useHarvestStore.setState(p.harvest);
    if (p.distill) useDistillRunStore.setState(p.distill);
  }, patch);
  await page.waitForTimeout(400);
}

const IDLE = {
  harvest: {
    run: { total: 0, done: 0, phase: null },
    outcome: null,
    seen: true,
  },
  distill: { running: false, step: null, outcome: null, seen: true },
};

async function runTheme(browser, theme) {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });

  await page.addInitScript((t) => {
    localStorage.setItem("myco.onboarded", "1");
    localStorage.setItem(
      "myco-ui",
      JSON.stringify({ state: { lang: "ko", theme: t }, version: 3 }),
    );
  }, theme);
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector(".side-nav .nav-item", { timeout: 30_000 });
  // An early capture is a blank white frame even when the page is fine.
  await page.waitForTimeout(9000);

  const bar = page.locator(".topbar");
  const spinners = () => page.locator(".topbar .activity-ring").count();

  // 1 — a live harvest run, mid-ingest.
  await setStores(page, {
    ...IDLE,
    harvest: { ...IDLE.harvest, run: { total: 20, done: 7, phase: "ingesting" } },
  });
  await page.screenshot({ path: `${SHOTS}/${theme}-1-harvest-live.png` });
  check(
    `${theme}: harvest run is named in the bar`,
    (await bar.textContent()).includes("수확 중"),
    await bar.textContent(),
  );
  check(
    `${theme}: harvest shows done/total`,
    (await bar.textContent()).includes("7/20"),
  );

  // 2 — a live distill chain.
  await setStores(page, {
    ...IDLE,
    distill: { running: true, step: "maps", outcome: null, seen: true },
  });
  await page.screenshot({ path: `${SHOTS}/${theme}-2-distill-live.png` });
  check(
    `${theme}: distill run is named in the bar`,
    (await bar.textContent()).includes("증류 중"),
    await bar.textContent(),
  );

  // 3 — both at once: ONE collapsed chip, one ring, both listed in the popover.
  await setStores(page, {
    harvest: { ...IDLE.harvest, run: { total: 20, done: 7, phase: "ingesting" } },
    distill: { running: true, step: "maps", outcome: null, seen: true },
  });
  check(`${theme}: two runners draw one ring, not two`, (await spinners()) === 1);
  await page.locator(".topbar .activity-chip").click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/${theme}-3-two-runners.png` });
  const pop = await page.locator(".activity-pop, .model-chip-pop").textContent();
  check(`${theme}: popover lists harvest`, pop.includes("수확 중"), pop);
  check(`${theme}: popover lists distill`, pop.includes("증류 중"));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // 4 — both finished, on a page that explains neither: two done pills.
  await setStores(page, { route: "history" });
  await setStores(page, {
    harvest: { ...IDLE.harvest, outcome: "done", seen: false },
    distill: { running: false, step: null, outcome: "done", seen: false },
  });
  // The activity chip holds a 600 ms green completion beat before it fades
  // (ActivityChip's `linger`); wait it out so this frame is the settled one.
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${SHOTS}/${theme}-4-done-pills.png` });
  const done = await bar.textContent();
  check(`${theme}: harvest leaves a done pill`, done.includes("수확 완료"), done);
  check(`${theme}: distill leaves a done pill`, done.includes("증류 완료"));
  check(`${theme}: no spinner once both have finished`, (await spinners()) === 0);

  // 5 — visiting the page that explains a run retires its pill.
  await setStores(page, { route: "overview" });
  await page.waitForTimeout(400);
  const after = await bar.textContent();
  check(
    `${theme}: Overview clears the harvest pill`,
    !after.includes("수확 완료"),
    after,
  );
  check(
    `${theme}: ...and leaves distill's alone`,
    after.includes("증류 완료"),
    after,
  );

  check(`${theme}: no page errors`, errors.length === 0, errors.join(" | "));
  await page.close();
}

const browser = await chromium.launch();
for (const theme of ["dark", "light"]) await runTheme(browser, theme);
await browser.close();
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
