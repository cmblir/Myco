import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";

const base = process.env.MYCO_TEST_URL ?? "http://127.0.0.1:5173";
const output = process.env.MYCO_SCREENSHOTS ?? "/tmp/myco-vault-startup";
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const report = [];
try {
  for (const width of [375, 768, 1280]) {
    for (const scenario of ["saved", "saved-denied", "first-denied"]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      page.setDefaultTimeout(90000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.addInitScript(({ scenario }) => {
        localStorage.setItem("myco.onboarded", "1");
        localStorage.setItem("myco-ui", JSON.stringify({ version: 3, state: { lang: "ko", theme: "dark", route: "overview", sidebarCollapsed: true } }));
        if (scenario !== "first-denied") localStorage.setItem("myco.lastVaultPath", "/synthetic/external-notes");
        window.vaultCalls = [];
        window.vaultDenied = scenario !== "saved";
        let internals;
        Object.defineProperty(window, "__TAURI_INTERNALS__", {
          configurable: true,
          get: () => internals,
          set: (value) => {
            const invoke = value.invoke;
            value.invoke = (command, args) => {
              if (command === "ensure_default_vault" || command === "open_vault") {
                window.vaultCalls.push({ command, path: args?.path });
                if (window.vaultDenied) return Promise.reject(new Error("Synthetic folder access denied"));
              }
              // The production command returns the selected root; the generic
              // graph fixture otherwise canonicalizes every request to its demo.
              if (command === "open_vault") {
                return invoke(command, args).then((meta) => ({ ...meta, path: args.path }));
              }
              return invoke(command, args);
            };
            internals = value;
          },
        });
      }, { scenario });
      await page.goto(`${base}/?mock=1`, { timeout: 90000 });
      if (scenario !== "saved") {
        const recovery = page.getByRole("region", { name: "볼트 폴더를 열지 못했어요" });
        await recovery.waitFor();
        const retry = recovery.getByRole("button", { name: "다시 시도" });
        const size = await retry.boundingBox();
        assert.ok(size.height >= 44);
        await recovery.getByText("오류 상세", { exact: true }).click();
        await recovery.getByText("Synthetic folder access denied", { exact: true }).waitFor();
        if (scenario === "saved-denied") {
          assert.equal(await page.evaluate(() => localStorage.getItem("myco.lastVaultPath")), "/synthetic/external-notes");
          assert.deepEqual(await page.evaluate(() => window.vaultCalls), [{ command: "open_vault", path: "/synthetic/external-notes" }]);
        }
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({ path: `${output}/${scenario}-${width}.png`, fullPage: true });
        await page.evaluate(() => { window.vaultDenied = false; });
        await retry.click();
        await recovery.waitFor({ state: "detached" });
      }
      // Playwright polls synchronous truthiness: an async predicate's Promise
      // is truthy even when it eventually resolves to false. Load the module
      // once, then poll the store without returning a Promise.
      await page.evaluate(async () => {
        const { useVaultStore } = await import("/src/stores/vaultStore.ts");
        window.getStartupVault = () => useVaultStore.getState().currentVault;
      });
      await page.waitForFunction(() => !!window.getStartupVault());
      const calls = await page.evaluate(() => window.vaultCalls);
      if (scenario !== "first-denied") assert.equal(calls.filter((call) => call.command === "ensure_default_vault").length, 0);
      if (scenario === "saved") assert.equal(calls.filter((call) => call.command === "open_vault").length, 1);
      if (scenario === "saved-denied") assert.deepEqual(calls, [
        { command: "open_vault", path: "/synthetic/external-notes" },
        { command: "open_vault", path: "/synthetic/external-notes" },
      ]);
      if (scenario === "first-denied") {
        assert.equal(calls.filter((call) => call.command === "ensure_default_vault").length, 2);
        assert.equal(calls.filter((call) => call.command === "open_vault").length, 1);
      } else {
        assert.equal(await page.evaluate(() => window.getStartupVault().path), "/synthetic/external-notes");
        assert.equal(await page.evaluate(() => localStorage.getItem("myco.lastVaultPath")), "/synthetic/external-notes");
      }
      assert.deepEqual(errors, []);
      report.push({ width, scenario, calls, errors });
      await page.close();
    }
  }
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  console.log(`${report.length} startup and recovery scenarios passed; ${output}`);
} finally { await browser.close(); }
