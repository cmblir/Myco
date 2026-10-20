// Synthetic browser geometry and motion regressions; no native app or vault.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const base = new URL(process.env.MYCO_TEST_URL ?? "http://127.0.0.1:5173");
const loopback = ["127.0.0.1", "localhost", "[::1]"];
assert.ok(loopback.includes(base.hostname), "Use a loopback development server");
const shots = process.env.MYCO_MASCOT_SHOTS ?? join(tmpdir(), "myco-mascot-motion");
mkdirSync(shots, { recursive: true });
const browser = await chromium.launch();
const failures = [];
let checks = 0;
function check(ok, message) {
  checks++;
  if (!ok) failures.push(message);
  console.log(`${ok ? "PASS" : "FAIL"} ${message}`);
}
const url = (search) => new URL(`/?${search}`, base).toString();
async function context(width = 1280) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await context.route("**/*", (route) => {
    const target = new URL(route.request().url());
    return loopback.includes(target.hostname) || !["http:", "https:"].includes(target.protocol)
      ? route.continue() : route.abort("blockedbyclient");
  });
  await context.addInitScript(() => {
    localStorage.setItem("myco.onboarded", "1");
    localStorage.setItem("myco-ui", JSON.stringify({ version: 3, state: { lang: "en", theme: "light", mascotEnabled: true } }));
    const request = window.requestAnimationFrame;
    window.__mascotFrames = 0;
    window.requestAnimationFrame = (callback) => request.call(window, (at) => {
      window.__mascotFrames++;
      callback(at);
    });
  });
  return context;
}
async function numberGeometry(locator, text) {
  return locator.evaluate((element, text) => {
    element.textContent = text;
    const box = element.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(element);
    const ink = range.getBoundingClientRect();
    const css = getComputedStyle(element);
    return { width: box.width, height: box.height, lineHeight: css.lineHeight,
      centred: Math.abs((ink.left + ink.right - box.left - box.right) / 2) < 1.5 &&
        Math.abs((ink.top + ink.bottom - box.top - box.bottom) / 2) < 1.5,
      contained: ink.left >= box.left && ink.right <= box.right,
      right: box.right, left: box.left };
  }, text);
}

try {
  for (const width of [375, 768, 1280]) {
    const ctx = await context(width);
    const page = await ctx.newPage();
    await page.goto(url("mock=1&local=1&nowriter=1"));
    await page.locator(".nav-badge").first().waitFor({ state: "attached" });
    await page.evaluate(async () => (await import("/src/stores/uiStore.ts")).useUIStore.getState().setSidebarCollapsed(false));
    for (const text of ["2", "99", "28189"]) {
      const geometry = await numberGeometry(page.locator(".nav-badge").first(), text);
      check(geometry.centred && geometry.contained, `${width}: sidebar ${text} is centred and complete`);
      check(Math.abs(geometry.height - 20) < 0.5 && geometry.width >= 20, `${width}: sidebar ${text} ignores parent line height`);
      if (text === "2") check(Math.abs(geometry.width - geometry.height) < 1, `${width}: sidebar one-digit badge is round`);
    }
    await page.screenshot({ path: join(shots, `sidebar-${width}.png`) });
    for (const count of [2, 99, 28189]) {
      await page.goto(url("mock=1&window=notch"), { waitUntil: "networkidle" });
      await page.locator(".notch").waitFor();
      await page.evaluate(async (count) => {
        const snapshot = await window.__TAURI_INTERNALS__.invoke("get_tray_status");
        snapshot.panel.agenda = { ...snapshot.panel.agenda, total: count };
        window.__mycoMock.emit("myco://tray-status", snapshot);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }, count);
      const closed = await page.locator(".notch").evaluate((element) => {
        const box = element.getBoundingClientRect();
        const css = getComputedStyle(element);
        const hit = document.elementFromPoint(box.x + box.width / 2, box.bottom - 5);
        return { width: box.width, height: box.height, background: css.backgroundColor,
          image: css.backgroundImage, shadow: css.boxShadow,
          interactive: css.pointerEvents !== "none" && hit !== null && element.contains(hit) };
      });
      check(await page.locator(".notch-mascot, .notch-mark, .notch-mark-n, .notch-cap, .notch-winged, .notch-body").count() === 0,
        `${width}: waiting ${count} draws no collapsed avatar, badge, wing, cap or card`);
      check(closed.width === 204 && closed.height === 51 && closed.background === "rgba(0, 0, 0, 0)" && closed.image === "none" && closed.shadow === "none",
        `${width}: waiting ${count} retains only the cutout-sized transparent hotspot`);
      if (count === 2) check(closed.interactive, `${width}: the invisible notch hotspot still receives pointer input`);
    }
    await page.screenshot({ path: join(shots, `notch-${width}.png`) });
    await page.goto(url("window=roam&roamMock=1&roamAt=850"));
    await page.locator(".roam-shadow").waitFor();
    const contact = await page.locator(".roam-shadow").evaluate((el) => ({ width: el.getBoundingClientRect().width, opacity: Number(getComputedStyle(el).opacity) }));
    const apexMs = await page.evaluate(async () => {
      const { mockPlace, PREVIEW_SEED, previewCue } = await import("/src/lib/roamPreview.ts");
      const { roamStart, roamTick } = await import("/src/lib/roamMotion.ts");
      const place = mockPlace(innerWidth, innerHeight);
      const step = 1000 / 60;
      let sim = roamStart(place, PREVIEW_SEED);
      for (let ms = 0; ms < 20_000; ms += step) {
        sim = roamTick(sim, step, { place, cue: previewCue(ms, false), pointer: null });
        if (sim.phase === "hop" && sim.hop) {
          const share = (sim.t - (sim.hop.crouch ?? 0)) / sim.hop.ms;
          if (share > 0.45 && share < 0.55) return Math.ceil(ms + 2 * step);
        }
      }
      throw new Error("No hop apex found");
    });
    await page.goto(url(`window=roam&roamMock=1&roamAt=${apexMs}`));
    await page.locator(".roam-shadow").waitFor();
    const air = await page.locator(".roam-shadow").evaluate((el) => ({ width: el.getBoundingClientRect().width, opacity: Number(getComputedStyle(el).opacity), filter: getComputedStyle(el).filter, animation: getComputedStyle(el).animationName }));
    check(air.width < contact.width && air.opacity < contact.opacity, `${width}: hop apex shrinks and fades the ground shadow`);
    check(air.filter === "none" && air.animation === "none", `${width}: shadow adds no blur or animation loop`);
    check(await page.locator(".roam .notch-mascot").count() === 1, `${width}: hop keeps one original myco`);
    await page.screenshot({ path: join(shots, `roam-apex-${width}.png`) });
    await ctx.close();
  }

  const ctx = await context();
  const page = await ctx.newPage();
  await page.goto(url("window=roam&roamMock=1"));
  await page.locator(".roam-shadow").waitFor();
  await page.evaluate(() => {
    window.__fixtureHidden = true;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => window.__fixtureHidden ? "hidden" : "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(100);
  const before = await page.evaluate(() => window.__mascotFrames);
  await page.waitForTimeout(1000);
  const hiddenFrames = await page.evaluate(() => window.__mascotFrames) - before;
  console.log(JSON.stringify({ hiddenRoamFramesPerSecond: hiddenFrames, synthetic: true }));
  check(hiddenFrames === 0, "hidden roam window runs zero JS animation frames");
  await page.evaluate(() => { window.__fixtureHidden = false; document.dispatchEvent(new Event("visibilitychange")); });
  await page.waitForTimeout(120);
  check(await page.evaluate(() => window.__mascotFrames) > before, "visible roam resumes its existing frame loop");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForTimeout(100);
  check(await page.locator(".roam").count() === 0, "reduced motion removes the roaming surprise");
  await ctx.close();

  // The production cameo mounted against a synthetic 3D projection. Controlled
  // frame timestamps compare refresh rates without rendering GraphScene.
  async function cameoProbe(hz) {
    const ctx = await context();
    const page = await ctx.newPage();
    await page.goto(url("mock=1&local=1&nowriter=1"));
    await page.locator(".home-page").waitFor();
    await page.evaluate(async () => {
      const { default: React } = await import("/node_modules/.vite/deps/react.js");
      const { default: ReactDOM } = await import("/node_modules/.vite/deps/react-dom_client.js");
      const { default: Cameo } = await import("/src/components/MascotCameo.tsx");
      const { STRINGS } = await import("/src/lib/i18n.ts");
      let next = 0;
      window.__cameoRafs = new Map();
      window.requestAnimationFrame = (callback) => { window.__cameoRafs.set(++next, callback); return next; };
      window.cancelAnimationFrame = (id) => window.__cameoRafs.delete(id);
      const set = window.setTimeout;
      const clear = window.clearTimeout;
      window.__cameoDismissTimers = 0;
      window.__cameoActiveDismissTimers = new Set();
      window.setTimeout = (fn, ms, ...args) => {
        const id = set(() => { window.__cameoActiveDismissTimers.delete(id); fn(...args); }, ms);
        if (ms === 520) { window.__cameoDismissTimers++; window.__cameoActiveDismissTimers.add(id); }
        return id;
      };
      window.clearTimeout = (id) => { window.__cameoActiveDismissTimers.delete(id); clear(id); };
      window.__cameo3D = true;
      window.__cameoPositions = [];
      const scene = { is3D: () => window.__cameo3D, getFramedDist: () => 1000,
        mascotSpawnPoint: () => ({ x: 0, y: 0, z: 0 }),
        projectPoint: (p) => { window.__cameoPositions.push(p); return { sx: 400, sy: 300, pxPerWorld: 1, visible: true }; } };
      const host = document.createElement("div"); document.body.append(host);
      window.__cameoRoot = ReactDOM.createRoot(host);
      window.__cameoRoot.render(React.createElement(Cameo, { active: true, sceneRef: { current: scene }, t: STRINGS.en }));
    });
    await page.waitForFunction(() => typeof window.__mascotCameo === "function");
    await page.evaluate(() => window.__mascotCameo());
    await page.locator(".mascot-cameo").waitFor({ state: "attached" });
    const position = await page.evaluate((hz) => {
      for (let i = 0; i <= hz; i++) {
        const pending = [...window.__cameoRafs.values()]; window.__cameoRafs.clear();
        for (const frame of pending) frame(i * 1000 / hz);
      }
      return window.__cameoPositions.at(-1);
    }, hz);
    return { ctx, page, position };
  }
  const sixty = await cameoProbe(60);
  const fast = await cameoProbe(120);
  console.log(JSON.stringify({ cameoWorldAfterOneSecond: { sixtyHz: sixty.position, oneTwentyHz: fast.position }, synthetic: true }));
  check(Math.hypot(sixty.position.x - fast.position.x, sixty.position.y - fast.position.y) < 0.001, "graph cameo takes the same world path at 60 and 120 Hz");
  await sixty.page.evaluate(() => {
    window.__cameo3D = false;
    for (let i = 0; i < 20; i++) {
      const pending = [...window.__cameoRafs.values()]; window.__cameoRafs.clear();
      for (const frame of pending) frame(1100 + i * 16);
    }
  });
  check(await sixty.page.evaluate(() => window.__cameoDismissTimers) === 1, "leaving 3D arms exactly one dismissal timer");
  await sixty.page.evaluate(() => window.__cameoRoot.unmount());
  check(await sixty.page.evaluate(() => window.__cameoActiveDismissTimers.size) === 0, "unmount cancels the pending cameo dismissal");
  await fast.page.evaluate(() => {
    window.__fixtureHidden = true;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => window.__fixtureHidden ? "hidden" : "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await fast.page.waitForTimeout(50);
  check(await fast.page.locator(".mascot-cameo").count() === 0, "hidden graph stops its cameo video");
  check(await fast.page.evaluate(() => window.__cameoRafs.size) === 0, "hidden graph cancels the cameo frame loop");
  await fast.page.evaluate(() => { window.__fixtureHidden = false; document.dispatchEvent(new Event("visibilitychange")); });
  await fast.page.waitForTimeout(50);
  await fast.page.evaluate(() => window.__mascotCameo());
  await fast.page.locator(".mascot-cameo").waitFor({ state: "attached" });
  await fast.page.emulateMedia({ reducedMotion: "reduce" });
  await fast.page.waitForTimeout(50);
  check(await fast.page.locator(".mascot-cameo").count() === 0, "reduced motion immediately hides an existing graph cameo");
  check(await fast.page.evaluate(() => window.__cameoRafs.size) === 0, "reduced motion cancels the cameo frame loop");
  await sixty.ctx.close(); await fast.ctx.close();
} finally {
  await browser.close();
}
console.log(`${checks - failures.length}/${checks} checks passed; synthetic screenshots: ${shots}`);
if (failures.length) process.exitCode = 1;
