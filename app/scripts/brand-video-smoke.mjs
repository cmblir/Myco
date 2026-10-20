// Run against an exported kit served locally; no external requests or dependencies.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const base = process.env.MYCO_VIDEO_URL ?? "http://127.0.0.1:8767/index.html";
const output = process.env.MYCO_SCREENSHOTS ?? "/tmp/myco-video-browser";
const browser = await chromium.launch();
const errors = [];
let checks = 0;
await mkdir(output, { recursive: true });
function check(condition, label) {
  assert.ok(condition, label);
  console.log(`PASS ${label}`);
  checks++;
}
async function open(width = 1280, url = base) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  await page.goto(url);
  await page.waitForFunction(() => window.mycoMotions?.length > 0 && document.querySelectorAll(".motion-card").length === window.mycoMotions.length);
  return page;
}
const card = (page, id) => page.locator(`[data-variant="${id}"]`);
const motions = (page) => page.evaluate(() => window.mycoMotions);
async function revealPrevious(page) {
  const previous = page.locator("details.previous-motions");
  if (await previous.count() && !(await previous.evaluate((element) => element.open))) {
    await previous.locator("summary").click();
  }
}
async function checkTargets(page, label) {
  const smallTargets = await page.locator("button, a, summary").evaluateAll((elements) => elements
    .filter((element) => element.getClientRects().length)
    .filter((element) => { const rect = element.getBoundingClientRect(); return rect.width < 44 || rect.height < 44; })
    .map((element) => element.textContent.trim()));
  check(smallTargets.length === 0, `${label}: all targets at least 44 px (${smallTargets.join(", ")})`);
}
async function waitPlaying(page, id, extension) {
  await page.waitForFunction(({ id, extension }) => {
    const video = document.querySelector(`[data-variant="${id}"] video`);
    return !video.paused && video.readyState >= 2 && video.currentTime > .04 && (!extension || video.currentSrc.endsWith(extension));
  }, { id, extension }, { timeout: 15000 });
}
try {
  for (const width of [320, 375, 768, 1280]) {
    const page = await open(width);
    const collection = await motions(page);
    check(await page.locator(".motion-card").count() === collection.length, `${width}: ${collection.length} motion cards`);
    if (collection.some((motion) => motion.latest) && collection.some((motion) => !motion.latest)) {
      check(await page.locator("details.previous-motions").evaluate((element) => !element.open), `${width}: previous motions start collapsed`);
      check(await page.locator(".motion-card:visible").count() === collection.filter((motion) => motion.latest).length, `${width}: only latest motions visible initially`);
    }
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width}: no horizontal overflow`);
    await checkTargets(page, width);
    check(await page.locator("video").evaluateAll((videos) => videos.every((video) => video.paused && !video.currentSrc)), `${width}: no autoplay or eager video loads`);
    await page.screenshot({ path: `${output}/gallery-${width}.png`, fullPage: true });
    if (await page.locator("details.previous-motions").count()) {
      await revealPrevious(page);
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width}: expanded collection has no overflow`);
      await checkTargets(page, `${width} expanded`);
      await page.screenshot({ path: `${output}/gallery-${width}-expanded.png`, fullPage: true });
    }
    await page.close();
  }
  const page = await open();
  const collection = await motions(page);
  const ids = collection.map((motion) => motion.id);
  const first = (collection.find((motion) => motion.latest) ?? collection[0]).id;
  const last = ids.at(-1);
  await revealPrevious(page);
  for (const background of ["dark", "checker", "ivory"]) {
    await page.locator(`[data-background-choice="${background}"]`).click();
    check(await page.locator("body").getAttribute("data-background") === background, `${background}: preview background selection`);
  }
  for (const id of ids) {
    await card(page, id).locator('[data-action="toggle"]').click();
    await waitPlaying(page, id, ".webm");
    check(await page.locator("video").evaluateAll((videos) => videos.filter((video) => !video.paused).length === 1), `${id}: only one video plays`);
    const alpha = await card(page, id).locator("video").evaluate((video) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 2;
      const context = canvas.getContext("2d");
      context.drawImage(video, 0, 0, 2, 2, 0, 0, 2, 2);
      return context.getImageData(0, 0, 1, 1).data[3];
    });
    check(alpha === 0, `${id}: decoded WebM corner is transparent`);
  }
  await card(page, last).locator('[data-action="toggle"]').click();
  check(await card(page, last).locator("video").evaluate((video) => video.paused), "pause stops playback");
  await card(page, last).locator("video").evaluate((video) => { video.currentTime = Math.min(3, video.duration / 2); });
  await card(page, last).locator('[data-action="replay"]').click();
  await waitPlaying(page, last);
  check(await card(page, last).locator("video").evaluate((video) => video.currentTime < 1), "replay restarts from beginning");
  const previous = page.locator("details.previous-motions");
  if (await previous.count()) {
    const previousId = await previous.locator(".motion-card").first().getAttribute("data-variant");
    await card(page, previousId).locator('[data-action="replay"]').click();
    await waitPlaying(page, previousId);
    await previous.locator("summary").click();
    await page.waitForFunction(() => [...document.querySelectorAll("details.previous-motions video")].every((video) => video.paused));
    check(true, "closing previous collection pauses its video");
    await card(page, first).locator('[data-action="replay"]').click();
    await waitPlaying(page, first);
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForFunction(() => [...document.querySelectorAll("video")].every((video) => video.paused));
  check(await page.locator("#motion-notice").isVisible(), "live reduced-motion preference pauses and explains");
  await card(page, first).locator('[data-action="replay"]').click();
  await waitPlaying(page, first);
  check(true, "manual playback works with reduced motion enabled");
  await card(page, first).locator('[data-action="toggle"]').focus();
  await page.keyboard.press("Enter");
  check(await card(page, first).locator("video").evaluate((video) => video.paused), "keyboard Enter pauses playback");
  await page.keyboard.press("Tab");
  check(await card(page, first).locator('[data-action="replay"]').evaluate((button) => button === document.activeElement && getComputedStyle(button).outlineStyle !== "none"), "keyboard Tab reaches visible replay focus");
  await page.keyboard.press("Enter");
  await waitPlaying(page, first);
  check(true, "keyboard Enter replays video");
  await page.close();

  const fallback = await open();
  await fallback.route(`**/clips/${first}.webm`, (route) => route.abort());
  await card(fallback, first).locator('[data-action="toggle"]').click();
  await waitPlaying(fallback, first, ".mp4");
  check((await card(fallback, first).locator(".card-status").innerText()).includes("MP4"), "failed transparent video falls back to explained MP4");
  await fallback.close();

  const recovery = await open();
  await recovery.route(`**/clips/${first}.*`, (route) => route.abort());
  await card(recovery, first).locator('[data-action="toggle"]').click();
  await recovery.waitForFunction((id) => document.querySelector(`[data-variant="${id}"] [data-action="toggle"]`).textContent === window.mycoGalleryCopy.retry, first);
  check((await card(recovery, first).locator(".card-status").innerText()).includes("불러오지"), "total load failure has readable recovery");
  await recovery.unroute(`**/clips/${first}.*`);
  await card(recovery, first).locator('[data-action="toggle"]').click();
  await waitPlaying(recovery, first, ".mp4");
  check(true, "retry recovers after network failure");
  await recovery.close();

  for (const hasEditorMasters of [false, true]) {
    const packed = await browser.newPage();
    await packed.route("**/pack-config.js", (route) => route.fulfill({
      contentType: "text/javascript",
      body: `window.mycoPack={hasArchives:false,hasEditorMasters:${hasEditorMasters}};`,
    }));
    await packed.goto(base);
    await card(packed, first).waitFor();
    await revealPrevious(packed);
    check(await packed.locator("[data-archive]:visible").count() === 0, `${hasEditorMasters ? "full" : "web"} ZIP: archive links hidden`);
    check(await packed.locator("[data-editor-master]:visible").count() === (hasEditorMasters ? ids.length : 0), `${hasEditorMasters ? "full" : "web"} ZIP: only included editor downloads shown`);
    await packed.close();
  }

  if (process.env.MYCO_VIDEO_FILE) {
    const local = await open(375, pathToFileURL(process.env.MYCO_VIDEO_FILE).href);
    await card(local, first).locator('[data-action="toggle"]').click();
    await waitPlaying(local, first, ".mp4");
    check(true, "file URL plays MP4 after local alpha-check restriction");
    await local.close();
  }
  check(errors.length === 0, `no page errors (${errors.join("\n")})`);
  console.log(`\n${checks} video gallery checks passed. Screenshots: ${output}`);
} finally {
  await browser.close();
}
