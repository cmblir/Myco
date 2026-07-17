// A timelapse interrupted by unmount or a scene rebuild must still produce a
// file, and must not leave the canvas capture track live.
//
// stopTlRecorder was only reachable from the RAF finish path and the pause
// button; every teardown path cancelled the RAF and left the recorder running
// against a canvas that was about to be disposed — no file, no error. The
// capture track was never released even on the happy path.
//
// Usage (dev server on :5173):  node scripts/timelapse-smoke.mjs
import { chromium } from "playwright";

const browser = await chromium.launch({
  headless: true,
  args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const results = [];
const check = (n, ok, d = "") => results.push({ n, ok, d });

async function graphPage() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(() => {
    localStorage.setItem("memex.onboarded", "1");
    localStorage.setItem(
      "memex-ui",
      JSON.stringify({ state: { lang: "en", theme: "light" }, version: 3 }),
    );
    window.__rec = { states: [], stopped: 0, downloads: [] };
    const R = window.MediaRecorder;
    window.MediaRecorder = class extends R {
      constructor(stream, opts) {
        super(stream, opts);
        window.__rec.stream = stream;
        window.__rec.instance = this;
      }
      stop() {
        window.__rec.stopped++;
        return super.stop();
      }
    };
    window.MediaRecorder.isTypeSupported = R.isTypeSupported.bind(R);
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) window.__rec.downloads.push(this.download);
      else click.call(this);
    };
  });
  await page.goto("http://localhost:5173/?mock=1", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.waitForSelector(".side-nav .nav-item", { timeout: 30_000 });
  await page.locator(".side-nav .nav-item", { hasText: "Graph" }).first().click();
  await page.waitForSelector(".graph-ready", { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(2_500);
  return page;
}

const state = (page) =>
  page.evaluate(() => ({
    recState: window.__rec.instance?.state ?? null,
    stopped: window.__rec.stopped,
    track: window.__rec.stream?.getTracks()[0]?.readyState ?? null,
    downloads: window.__rec.downloads,
  }));

async function record(page) {
  const btn = page.getByRole("button", { name: /record/i }).first();
  if ((await btn.count()) === 0) return false;
  await btn.click();
  await page.waitForTimeout(2_500);
  return true;
}

// --- interrupted by navigating away -----------------------------------------
{
  const page = await graphPage();
  if (!(await record(page))) {
    console.log("SKIP: no Record button found");
    process.exit(2);
  }
  await page.locator(".side-nav .nav-item", { hasText: "Overview" }).first().click();
  await page.waitForTimeout(2_000);
  // Guard against the check passing because we never actually left the Graph.
  const left = (await page.locator(".graph-ready").count()) === 0;
  check("navigating away really unmounts the graph", left);
  const s = await state(page);
  check("unmount mid-record stops the recorder", s.recState === "inactive", JSON.stringify(s));
  check("unmount mid-record still downloads a clip", s.downloads.length === 1, JSON.stringify(s.downloads));
  check("unmount mid-record releases the capture track", s.track === "ended", String(s.track));
  await page.close();
}

// --- interrupted by a scene rebuild (layout change) --------------------------
{
  const page = await graphPage();
  await record(page);
  // The layout chips live in the controls drawer, and `layout` is a build-effect
  // dep — so switching it is a real scene rebuild under a live recording. The
  // settings are read through a lazy initializer, so seeding localStorage does
  // nothing; the drawer has to be driven.
  await page.getByRole("button", { name: /graph settings/i }).first().click();
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: /atlas/i }).first().click();
  await page.waitForTimeout(2_500);
  const s = await state(page);
  // A silent skip here would read as coverage we do not have.
  check("the rebuild scenario actually rebuilt", s.stopped > 0 || s.recState === "inactive", JSON.stringify(s));
  check("rebuild mid-record stops the recorder", s.recState === "inactive", JSON.stringify(s));
  check("rebuild mid-record still downloads a clip", s.downloads.length === 1);
  check("rebuild mid-record releases the capture track", s.track === "ended", String(s.track));
  await page.close();
}

// --- the happy path still works, and releases its track ----------------------
{
  const page = await graphPage();
  await record(page);
  const pause = page.getByRole("button", { name: /pause/i }).first();
  if ((await pause.count()) > 0) {
    await pause.click();
    await page.waitForTimeout(1_500);
    const s = await state(page);
    check("pause downloads the clip", s.downloads.length === 1, JSON.stringify(s.downloads));
    check("pause releases the capture track", s.track === "ended", String(s.track));
  }
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
