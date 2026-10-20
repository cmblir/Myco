// Synthetic in-memory IPC workflows; no private exports or accounts are read.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
const base = process.env.MYCO_TEST_URL ?? "http://127.0.0.1:5173";
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname));
const output = process.env.MYCO_SCREENSHOTS ?? "/tmp/myco-import-workflows";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: !process.argv.includes("--headed"),
});
let checks = 0;
try {
  for (const width of [375, 768, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/*", (r) => {
      const u = new URL(r.request().url());
      return ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) ||
        !["http:", "https:"].includes(u.protocol)
        ? r.continue()
        : r.abort("blockedbyclient");
    });
    await page.addInitScript(() => {
      localStorage.setItem("myco.onboarded", "1");
      localStorage.setItem(
        "myco-ui",
        JSON.stringify({ version: 3, state: { lang: "en", theme: "light" } }),
      );
      window.importCalls = [];
      window.failImportRetry = true;
      window.holdImportSweep = true;
      let internals;
      Object.defineProperty(window, "__TAURI_INTERNALS__", {
        configurable: true,
        get: () => internals,
        set: (value) => {
          const invoke = value.invoke;
          value.invoke = async (command, args) => {
            if (command === "import_paths") {
              window.importCalls.push(args);
              if (window.failImportRetry)
                throw new Error("Synthetic retry transport failure");
            }
            const result = await invoke(command, args);
            if (command === "import_session_sweep" && window.holdImportSweep)
              await new Promise((resolve) => {
                window.finishImportSweep = resolve;
              });
            return result;
          };
          internals = value;
        },
      });
    });
    async function navigate(label) {
      if (await page.locator(".app.sidebar-collapsed").count())
        await page.getByTitle(/^Toggle sidebar/).click();
      await page
        .locator(".side-nav .nav-item")
        .filter({
          has: page.locator(".ni-text", {
            hasText: new RegExp("^" + label + "$"),
          }),
        })
        .click();
    }
    async function openImport() {
      await navigate("Add sources");
      for (const locator of [
        page.getByTestId("intake-more-sources"),
        page.getByTestId("intake-advanced"),
      ])
        if ((await locator.getAttribute("open")) === null)
          await locator.locator("summary").first().click();
      const sessions = page
        .getByTestId("intake-advanced")
        .locator("details")
        .filter({
          has: page.locator("summary", { hasText: /^Session sweep/ }),
        });
      if ((await sessions.getAttribute("open")) === null)
        await sessions.locator("summary").first().click();
    }
    try {
      await page.goto(base + "/?mock=1", { waitUntil: "domcontentloaded" });
      await page.locator(".home-page").waitFor();
      await openImport();
      const card = page
        .locator("section.zotero-import")
        .filter({ hasText: "Import a conversation" });
      await card
        .getByRole("button", { name: "Choose a file…", exact: true })
        .click();
      await card.getByTestId("import-secret-warning").waitFor();
      assert.match(await card.innerText(), /Imported 1 conversation/);
      checks++;
      assert.match(
        await card.getByTestId("import-secret-warning").innerText(),
        /1 conversation.*held back/,
      );
      checks++;
      await card
        .getByRole("button", {
          name: "Import my Claude Code sessions",
          exact: true,
        })
        .click();
      await card.getByRole("progressbar").waitFor();
      assert.equal(
        await card
          .getByRole("button", { name: "Importing…", exact: true })
          .isDisabled(),
        true,
      );
      checks++;
      await navigate("Home");
      await page.locator(".home-page").waitFor();
      await openImport();
      await card.getByRole("progressbar").waitFor();
      checks++;
      await page.waitForFunction(
        () => typeof window.finishImportSweep === "function",
      );
      assert.match(await card.getByTestId("import-progress").innerText(), /2 failed/);
      checks++;
      await page.evaluate(() => {
        window.holdImportSweep = false;
        window.finishImportSweep();
      });
      const failures = card.getByTestId("import-failures");
      await failures.waitFor();
      assert.match(
        await failures.locator("summary").innerText(),
        /^2 couldn’t be imported$/,
      );
      checks++;
      await failures.locator("summary").click();
      const paths = await failures.locator(".muted span").allInnerTexts();
      assert.equal(paths.length, 2);
      checks++;
      await failures
        .getByRole("button", { name: "Retry failed (2)", exact: true })
        .click();
      const alert = card.getByRole("alert");
      await alert.waitFor();
      assert.match(
        await alert.innerText(),
        /Synthetic retry transport failure/,
      );
      checks++;
      await failures
        .getByRole("button", { name: "Retry failed (2)", exact: true })
        .waitFor();
      checks++;
      await page.evaluate(() => {
        window.failImportRetry = false;
      });
      await failures
        .getByRole("button", { name: "Retry failed (2)", exact: true })
        .click();
      await failures.waitFor({ state: "detached" });
      await alert.waitFor({ state: "detached" });
      checks++;
      assert.deepEqual(await page.evaluate(() => window.importCalls), [
        { paths, dest: "sessions" },
        { paths, dest: "sessions" },
      ]);
      checks++;
      assert.match(await card.innerText(), /Imported 2 conversation/);
      checks++;
      assert.deepEqual(errors, []);
      checks++;
      await page.screenshot({ path: output + "/" + width + ".png" });
      console.log(
        "PASS " +
          width +
          "px import/quarantine/progress/failed retry/destination (mock IPC)",
      );
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
console.log(
  checks +
    " assertions passed; native parsers, receipts and disk writes are not exercised.",
);
