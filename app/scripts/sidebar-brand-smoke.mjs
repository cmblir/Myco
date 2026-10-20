// Synthetic browser review; never opens a native vault or changes its files.
// Usage: MYCO_TEST_URL=http://127.0.0.1:5173 node scripts/sidebar-brand-smoke.mjs
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = new URL(process.env.MYCO_TEST_URL ?? "http://127.0.0.1:5173");
const loopback = ["127.0.0.1", "localhost", "[::1]"];
assert.ok(
  loopback.includes(base.hostname),
  "Use a loopback development server",
);
const cases = [320, 375, 768, 1280].map((width) => ({
  width,
  reducedMotion: "reduce",
  hasTouch: false,
}));
cases.push({ width: 375, reducedMotion: "no-preference", hasTouch: true });
const browser = await chromium.launch();
try {
  for (const theme of ["light", "dark"]) {
    for (const { width, reducedMotion, hasTouch } of cases) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        reducedMotion,
        hasTouch,
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/*", (route) => {
        const url = new URL(route.request().url());
        return loopback.includes(url.hostname) ||
          !["http:", "https:"].includes(url.protocol)
          ? route.continue()
          : route.abort("blockedbyclient");
      });
      await page.addInitScript((theme) => {
        localStorage.setItem("myco.onboarded", "1");
        localStorage.setItem(
          "myco-ui",
          JSON.stringify({ version: 3, state: { lang: "en", theme } }),
        );
      }, theme);
      const url = new URL(base);
      url.search = "?mock=1&local=1&nowriter=1";
      await page.goto(url.toString());
      await page.locator(".home-page").waitFor();
      assert.ok(
        await page.evaluate(() => Boolean(window.__mycoMock)),
        "Synthetic IPC mock is required",
      );

      async function openSidebar() {
        if (width <= 768) {
          await page.locator(".app.sidebar-collapsed").waitFor();
          await page
            .getByRole("button", { name: "Toggle sidebar (⌘B)", exact: true })
            .click();
        }
        await page.waitForFunction(
          () =>
            Math.abs(
              document.querySelector(".sidebar").getBoundingClientRect().x,
            ) < 0.5,
        );
      }
      await openSidebar();
      const head = page.locator(".side-head");
      const home = head.getByRole("button", { name: "Home", exact: true });
      const settings = head.getByRole("button", {
        name: "Settings",
        exact: true,
      });
      assert.equal(
        await home.count(),
        1,
        "Home has one localized accessible name",
      );
      const geometry = await head.evaluate((head) => {
        const rect = (selector) => {
          const element = head.querySelector(selector);
          const box = element.getBoundingClientRect();
          return {
            x: box.x,
            right: box.right,
            width: box.width,
            height: box.height,
          };
        };
        return {
          home: rect(".brand"),
          mark: rect(".brand-mark img"),
          settings: rect(".side-gear"),
          width: head.clientWidth,
          overflow: head.scrollWidth > head.clientWidth,
          transition: getComputedStyle(head.querySelector(".brand"))
            .transitionDuration,
        };
      });
      for (const box of [geometry.home, geometry.settings]) {
        assert.ok(
          box.width >= 43.99 && box.height >= 43.99,
          "Header controls have 44px targets",
        );
      }
      // Transformed overlay rectangles can contain subpixel rounding error.
      assert.ok(Math.abs(geometry.mark.width - 32) < 0.01);
      assert.ok(Math.abs(geometry.mark.height - 32) < 0.01);
      assert.ok(
        geometry.home.width < geometry.width * 0.65,
        "Home surface follows the lockup rather than the full column",
      );
      assert.ok(
        geometry.settings.x - geometry.home.right >= 8,
        "Independent targets cannot overlap",
      );
      assert.equal(geometry.overflow, false);
      assert.equal(
        geometry.transition,
        reducedMotion === "reduce" ? "0s" : "0.14s",
      );

      await home.focus();
      await page.keyboard.press("Tab");
      assert.ok(
        await settings.evaluate(
          (element) => document.activeElement === element,
        ),
      );
      const focus = await settings.evaluate((element) => ({
        visible: element.matches(":focus-visible"),
        width: getComputedStyle(element).outlineWidth,
        style: getComputedStyle(element).outlineStyle,
      }));
      assert.deepEqual(focus, { visible: true, width: "2px", style: "solid" });
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        () =>
          document.querySelector(".side-gear").getAttribute("aria-current") ===
          "page",
      );
      await openSidebar();
      await settings.focus();
      await page.keyboard.press("Shift+Tab");
      assert.ok(
        await home.evaluate(
          (element) =>
            document.activeElement === element &&
            element.matches(":focus-visible"),
        ),
      );
      await page.keyboard.press("Enter");
      await page.locator(".home-page").waitFor();
      if (width <= 768) await openSidebar();
      await home.hover();
      if (width === 375 || width === 1280) {
        await page.screenshot({
          path: `/tmp/myco-sidebar-brand-${theme}-${width}.png`,
        });
      }
      assert.deepEqual(errors, []);
      console.log(
        `PASS ${theme} ${width}px ${reducedMotion}${hasTouch ? " touch" : ""}: Home ${geometry.home.width}×${geometry.home.height}, mark32, Settings44, keyboard routes/focus (mock IPC)`,
      );
      await context.close();
    }
  }
} finally {
  await browser.close();
}
