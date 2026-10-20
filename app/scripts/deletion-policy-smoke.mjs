// Real settings controls with synthetic IPC; no personal vault or OS Trash.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const base = new URL(process.env.MYCO_TEST_URL ?? "http://127.0.0.1:5173");
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(base.hostname));
const output = process.env.MYCO_TEST_OUT ?? "/tmp/myco-deletion-policy";
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const report = [];
try {
  for (const width of [320, 375, 768, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem("myco.onboarded", "1");
      localStorage.setItem("myco-ui", JSON.stringify({ version: 3, state: {
        lang: "ko", theme: "dark", route: "settings", sidebarCollapsed: true,
      } }));
    });
    await page.goto(new URL("/?mock=1", base).href);
    await page.locator(".settings-navigation__advanced > summary").click();
    await page.locator("#settings-choice-distill").click();
    const toggle = page.getByTestId("permanent-delete-toggle");
    await toggle.waitFor();
    assert.equal(await toggle.getAttribute("aria-checked"), "false");
    const box = await toggle.boundingBox();
    assert.ok(box.width >= 44 && box.height >= 44);
    await page.evaluate(() => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      window.policyWrites = [];
      window.__TAURI_INTERNALS__.invoke = (command, args) => {
        if (command !== "set_settings") return invoke(command, args);
        window.policyWrites.push(args.value);
        return new Promise((resolve, reject) => {
          window.finishPolicy = () => invoke(command, args).then(resolve, reject);
          window.failPolicy = reject;
        });
      };
    });
    await toggle.click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    assert.ok((await dialog.innerText()).includes("복원할 수 없습니다"));
    assert.deepEqual(await page.evaluate(() => window.policyWrites), []);
    await dialog.getByRole("button", { name: "취소", exact: true }).click();
    assert.equal(await toggle.getAttribute("aria-checked"), "false");
    await toggle.focus();
    await page.keyboard.press("Space");
    await dialog.getByRole("button", { name: "즉시 영구 삭제", exact: true }).click();
    assert.equal(await toggle.isDisabled(), true);
    await page.evaluate(() => window.failPolicy(new Error("Synthetic policy save failure")));
    await page.waitForFunction(() => !document.querySelector('[data-testid="permanent-delete-toggle"]').disabled);
    assert.equal(await toggle.getAttribute("aria-checked"), "false");
    await page.getByRole("alert").filter({ hasText: "Synthetic policy save failure" }).first().waitFor();
    await toggle.click();
    await dialog.getByRole("button", { name: "즉시 영구 삭제", exact: true }).click();
    await page.evaluate(() => window.finishPolicy());
    await page.waitForFunction(() => !document.querySelector('[data-testid="permanent-delete-toggle"]').disabled);
    assert.equal(await toggle.getAttribute("aria-checked"), "true");
    assert.equal(await page.evaluate(async () => (await window.__TAURI_INTERNALS__.invoke("get_settings")).permanent_delete), true);
    await page.screenshot({ path: `${output}/enabled-${width}.png`, fullPage: true });
    await toggle.click();
    assert.equal(await dialog.count(), 0);
    await page.evaluate(() => window.finishPolicy());
    await page.waitForFunction(() => !document.querySelector('[data-testid="permanent-delete-toggle"]').disabled);
    assert.equal(await toggle.getAttribute("aria-checked"), "false");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    assert.deepEqual(errors, []);
    report.push({ width, checks: 14, errors });
    await page.close();
  }
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ checks: report.reduce((n, row) => n + row.checks, 0), report }, null, 2));
} finally {
  await browser.close();
}
