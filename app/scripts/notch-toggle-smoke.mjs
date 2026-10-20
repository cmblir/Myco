import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
// Synthetic IPC failures exercise the actual settings UI; no native app or vault is used.
const base = process.env.MYCO_TEST_URL ?? "http://127.0.0.1:5173";
const output = process.env.MYCO_SCREENSHOTS ?? "/tmp/myco-notch-toggle";
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const report = [];
try {
  for (const width of [320, 375, 768, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(90000);
    page.setDefaultNavigationTimeout(90000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
      localStorage.setItem("myco.onboarded", "1");
      localStorage.setItem(
        "myco-ui",
        JSON.stringify({
          version: 3,
          state: {
            lang: "ko",
            theme: "dark",
            route: "settings",
            settingsTab: "appearance",
            sidebarCollapsed: true,
          },
        }),
      );
    });
    await page.goto(`${base}/?mock=1`);
    // On phones Settings starts with the section list, not hidden controls.
    await page.locator("#settings-choice-appearance").click();
    const toggle = page.getByTestId("notch-toggle");
    await toggle.waitFor({ timeout: 30000 });
    const hit = await toggle.boundingBox();
    assert.ok(hit.width >= 44 && hit.height >= 44);
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(
      await toggle
        .locator(".notch-settings-toggle__thumb")
        .evaluate((el) => getComputedStyle(el).transitionDuration),
      "0s",
    );
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await toggle.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    assert.equal(
      await toggle.evaluate((el) => getComputedStyle(el).outlineStyle),
      "solid",
    );
    const initial = (await toggle.getAttribute("aria-checked")) === "true";
    const target = !initial;
    await page.evaluate(() => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      window.notchCalls = [];
      window.__TAURI_INTERNALS__.invoke = (command, args) => {
        if (command !== "update_notch_enabled") return invoke(command, args);
        window.notchCalls.push(args.enabled);
        return new Promise((resolve, reject) => {
          window.notchFinish = resolve;
          window.notchFail = reject;
        });
      };
    });
    await toggle.click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="notch-toggle"]')
          ?.getAttribute("aria-busy") === "true",
    );
    assert.equal(await toggle.getAttribute("aria-checked"), String(target));
    assert.equal(await toggle.getAttribute("aria-busy"), "true");
    assert.equal(await toggle.isDisabled(), true);
    await toggle.evaluate((el) => el.click());
    assert.deepEqual(await page.evaluate(() => window.notchCalls), [target]);
    await page.evaluate(() =>
      window.notchFail(new Error("Synthetic settings write failure")),
    );
    await page
      .getByRole("alert")
      .filter({ hasText: "Synthetic settings write failure" })
      .waitFor();
    assert.equal(await toggle.getAttribute("aria-checked"), String(initial));
    assert.equal(await toggle.isEnabled(), true);
    await page.screenshot({
      path: `${output}/error-${width}.png`,
      fullPage: true,
    });
    await toggle.click();
    await page.evaluate(() => window.notchFinish(null));
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="notch-toggle"]')
          ?.getAttribute("aria-busy") === "false",
    );
    assert.equal(await toggle.getAttribute("aria-checked"), String(target));
    assert.equal(
      await page
        .getByRole("alert")
        .filter({ hasText: "Synthetic settings write failure" })
        .count(),
      0,
    );
    await toggle.click();
    await page.evaluate(() => window.notchFinish(null));
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="notch-toggle"]')
          ?.getAttribute("aria-busy") === "false",
    );
    assert.equal(await toggle.getAttribute("aria-checked"), String(initial));
    assert.deepEqual(await page.evaluate(() => window.notchCalls), [
      target,
      target,
      initial,
    ]);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    assert.deepEqual(errors, []);
    await page.screenshot({
      path: `${output}/success-${width}.png`,
      fullPage: true,
    });
    report.push({ width, checks: 15, errors });
    await page.close();
  }
  const notch = await browser.newPage({
    viewport: { width: 380, height: 260 },
  });
  const notchErrors = [];
  notch.on("pageerror", (error) => notchErrors.push(error.message));
  await notch.goto(`${base}/?mock=1&window=notch`);
  await notch.locator(".notch").waitFor();
  const emit = (event, payload) =>
    notch.evaluate(
      ({ event, payload }) =>
        window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
          event,
          payload,
        }),
      { event, payload },
    );
  await emit("notch-visibility", false);
  await notch.locator('.notch[data-state="idle"]').waitFor();
  await emit("notch-hover", true);
  await emit("myco://tray-status", {
    running: [{ text: "Synthetic job 40%" }],
  });
  await notch.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  assert.equal(
    await notch.locator(".notch").getAttribute("data-state"),
    "idle",
  );
  await emit("notch-visibility", true);
  await emit("notch-hover", true);
  await notch.locator('.notch[data-state="peek"]').waitFor();
  await notch.evaluate(() => {
    window.notchTrackStops = 0;
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: () =>
        new Promise((resolve) => {
          window.notchGrantMic = () =>
            resolve({
              getTracks: () => [{ stop: () => window.notchTrackStops++ }],
            });
        }),
    });
  });
  await notch.locator(".notch-act").first().click();
  await notch.waitForFunction(() => typeof window.notchGrantMic === "function");
  // Re-enabling under the pointer legitimately reopens the hover peek.
  await notch.mouse.move(379, 259);
  await emit("notch-visibility", false);
  await emit("notch-visibility", true);
  await notch.evaluate(() => window.notchGrantMic());
  await notch.waitForFunction(() => window.notchTrackStops === 1);
  await notch.locator('.notch[data-state="idle"]').waitFor();
  assert.deepEqual(notchErrors, []);
  report.push({ surface: "retained-notch", checks: 4, errors: notchErrors });
  await notch.close();
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
