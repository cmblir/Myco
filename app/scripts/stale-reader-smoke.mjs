// Synthetic dev-mock browser checks; never opens a native or private vault.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const base = process.env.MYCO_TEST_URL ?? "http://127.0.0.1:5173";
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname), "Synthetic smoke requires a loopback URL");
const output = process.env.MYCO_TEST_OUT ?? "/tmp/myco-stale-reader";
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
let checks = 0;
const errors = [];
function check(condition, message) {
  assert.ok(condition, message);
  checks++;
  console.log(`PASS ${message}`);
}
async function fixture(width) {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  await page.addInitScript(() => {
    performance.setResourceTimingBufferSize(5000);
    window.__importAppModule = (path) => {
      const entry = performance.getEntriesByType("resource")
        .filter((resource) => new URL(resource.name).pathname === path).at(-1);
      if (!entry) throw new Error(`App module was not loaded: ${path}`);
      return import(entry.name);
    };
    localStorage.setItem("myco-ui", JSON.stringify({ version: 3, state: {
      lang: "ko", theme: "dark", editorMode: "source", sidebarCollapsed: false,
    } }));
  });
  await page.goto(`${base}/?mock=1`);
  await page.locator(".home-page").waitFor();
  await page.waitForFunction(async () => {
    const { useVaultStore } = await window.__importAppModule("/src/stores/vaultStore.ts");
    return useVaultStore.getState().currentVault !== null;
  });
  await page.evaluate(async () => {
    const { ipc } = await window.__importAppModule("/src/lib/ipc.ts");
    const { useVaultStore } = await window.__importAppModule("/src/stores/vaultStore.ts");
    const root = useVaultStore.getState().currentVault.path;
    window.__sessionPath = `${root}/sessions/2026-10/codex-synthetic.md`;
    window.__nextPath = `${root}/wiki/synthetic-current.md`;
    await ipc.writeFile(window.__sessionPath, "# Synthetic session\n\nOld synthetic content.\n");
    await ipc.writeFile(window.__nextPath, "# Synthetic current\n\nCurrent synthetic content.\n");
    await useVaultStore.getState().refreshTree();
  });
  return page;
}
try {
  for (const width of [375, 1280]) {
    for (const kind of ["missing", "permission"]) {
    for (const cached of [false, true]) {
      const page = await fixture(width);
      await page.evaluate(async ({ kind, cached }) => {
        const { useUIStore } = await window.__importAppModule("/src/stores/uiStore.ts");
        const { useVaultStore } = await window.__importAppModule("/src/stores/vaultStore.ts");
        const original = window.__TAURI_INTERNALS__.invoke;
        const path = window.__sessionPath;
        if (cached) await useVaultStore.getState().openFile(path);
        window.__TAURI_INTERNALS__.invoke = (command, args) => {
          if (command === "read_file" && args.path === path) return Promise.reject(new Error(
            kind === "missing" ? `canonicalize failed for ${path}: No such file or directory (os error 2)`
              : "read failed: Permission denied (os error 13)",
          ));
          return original(command, args);
        };
        useUIStore.getState().setRoute(`page:${path}`);
      }, { kind, cached });
      await page.locator(".rd-missing").waitFor();
      check(await page.getByRole("heading", { name: kind === "missing" ? "노트를 찾을 수 없습니다" : "노트를 열 수 없습니다", exact: true }).isVisible(), `${kind} ${width}: readable error heading`);
      check(await page.getByRole("button", { name: "노트 검색", exact: true }).isVisible(), `${kind} ${width}: search recovery available`);
      check(await page.getByRole("button", { name: "홈으로", exact: true }).isVisible(), `${kind} ${width}: Home recovery available`);
      check(await page.locator(".sb-error").count() === 0, `${kind} ${width}: no Sidebar raw read error`);
      check(await page.locator(".rd-skeleton").count() === 0, `${kind} ${width}: not stuck loading`);
      if (cached) {
        check(await page.locator(".cm-content").count() === 0, `${kind} ${width} cached: current failure takes priority`);
        check(await page.evaluate(async () => {
          const { useVaultStore } = await window.__importAppModule("/src/stores/vaultStore.ts");
          return useVaultStore.getState().activeFile?.path === window.__sessionPath;
        }), `${kind} ${width} cached: cached note remains intact`);
      }
      if (kind === "permission") check((await page.locator(".rd-missing").innerText()).includes("Permission denied"), `${kind} ${width}: actual IO failure is preserved`);
      await page.screenshot({ path: `${output}/${kind}-${width}${cached ? "-cached" : ""}.png`, fullPage: true });
      await page.getByRole("button", { name: "홈으로", exact: true }).click();
      await page.locator(".home-page").waitFor();
      check(await page.locator(".home-page").isVisible(), `${kind} ${width}: Home recovery works`);
      await page.close();
    }
    }
  }
  for (const result of ["success", "error"]) {
    const page = await fixture(1280);
    await page.evaluate(async () => {
      const { useUIStore } = await window.__importAppModule("/src/stores/uiStore.ts");
      const original = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = (command, args) => {
        if (command === "read_file" && args.path === window.__sessionPath) {
          window.__heldReadStarted = true;
          return new Promise((resolve, reject) => {
            window.__finishHeldRead = (result) => result === "success"
              ? original(command, args).then(resolve, reject)
              : reject(new Error(`canonicalize failed for ${args.path}: No such file or directory (os error 2)`));
          });
        }
        return original(command, args);
      };
      useUIStore.getState().setRoute(`page:${window.__sessionPath}`);
    });
    await page.waitForFunction(() => window.__heldReadStarted === true);
    await page.evaluate(async () => {
      const { useUIStore } = await window.__importAppModule("/src/stores/uiStore.ts");
      useUIStore.getState().setRoute(`page:${window.__nextPath}`);
    });
    await page.locator(".cm-content").waitFor();
    await page.evaluate((result) => window.__finishHeldRead(result), result);
    await page.waitForTimeout(100);
    check((await page.locator(".cm-content").innerText()).includes("Current synthetic content."), `late ${result}: current editor stays open`);
    check(await page.locator(".sb-error").count() === 0, `late ${result}: no stale Sidebar error`);
    check(await page.locator(".rd-skeleton, .rd-missing").count() === 0, `late ${result}: current Reader stays ready`);
    check(await page.evaluate(async () => {
      const { useVaultStore } = await window.__importAppModule("/src/stores/vaultStore.ts");
      return useVaultStore.getState().activeFile?.path === window.__nextPath;
    }), `late ${result}: active path stays current`);
    await page.screenshot({ path: `${output}/late-${result}.png`, fullPage: true });
    await page.close();
  }
  {
    const page = await fixture(1280);
    await page.evaluate(async () => {
      const { useVaultStore } = await window.__importAppModule("/src/stores/vaultStore.ts");
      const { useUIStore } = await window.__importAppModule("/src/stores/uiStore.ts");
      window.__root = useVaultStore.getState().currentVault.path;
      window.__failRead = true;
      window.__sessionReadCount = 0;
      const original = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = (command, args) => {
        if (command === "open_vault" && window.__holdOpen) {
          window.__heldOpenStarted = true;
          return new Promise((resolve, reject) => {
            window.__finishHeldOpen = () => original(command, args).then(resolve, reject);
          });
        }
        if (command === "read_file" && args.path === window.__sessionPath) {
          window.__sessionReadCount++;
          if (window.__failRead) return Promise.reject(new Error(`canonicalize failed for ${args.path}: No such file or directory (os error 2)`));
        }
        return original(command, args);
      };
      useUIStore.getState().setRoute(`page:${window.__sessionPath}`);
    });
    await page.locator(".rd-missing").waitFor();
    await page.evaluate(async () => {
      const { useVaultStore } = await window.__importAppModule("/src/stores/vaultStore.ts");
      window.__readsBeforeOpen = window.__sessionReadCount;
      window.__failRead = false;
      window.__holdOpen = true;
      window.__opening = useVaultStore.getState().openVault(window.__root);
    });
    await page.waitForFunction(() => window.__heldOpenStarted === true);
    check(await page.locator(".rd-missing").count() === 0, "same-vault reopening: previous session error is cleared");
    check(await page.evaluate(() => window.__sessionReadCount === window.__readsBeforeOpen), "same-vault reopening: file read waits for the native root");
    await page.evaluate(async () => {
      window.__finishHeldOpen();
      await window.__opening;
      window.__holdOpen = false;
    });
    await page.locator(".cm-content").waitFor();
    check((await page.locator(".cm-content").innerText()).includes("Old synthetic content."), "same-vault reopening: fresh read recovers the editor");
    check(await page.evaluate(() => window.__sessionReadCount === window.__readsBeforeOpen + 1), "same-vault reopening: one fresh reader request");
    await page.evaluate(async () => {
      const { useVaultStore } = await window.__importAppModule("/src/stores/vaultStore.ts");
      const { useUIStore } = await window.__importAppModule("/src/stores/uiStore.ts");
      useUIStore.getState().setRoute("overview");
      window.__failRead = true;
      useUIStore.getState().setRoute(`page:${window.__sessionPath}`);
      window.__opening = useVaultStore.getState().openVault(window.__root);
    });
    await page.locator(".rd-missing").waitFor();
    await page.evaluate(async () => {
      const { useVaultStore } = await window.__importAppModule("/src/stores/vaultStore.ts");
      useVaultStore.getState().reset();
    });
    await page.waitForFunction(() => !document.querySelector(".rd-missing"));
    check(await page.locator(".rd-missing").count() === 0, "vault reset: old read failure does not survive the token change");
    await page.evaluate(async () => {
      const { useVaultStore } = await window.__importAppModule("/src/stores/vaultStore.ts");
      window.__failRead = false;
      await useVaultStore.getState().openVault(window.__root);
    });
    await page.locator(".cm-content").waitFor();
    check((await page.locator(".cm-content").innerText()).includes("Old synthetic content."), "vault reset: opening again restores the same route");
    check(await page.locator(".sb-error").count() === 0, "vault session recovery: Sidebar remains clear");
    await page.close();
  }
  check(errors.length === 0, "no browser runtime exceptions");
  console.log(`${checks} checks passed. Screenshots: ${output}`);
} finally {
  await browser.close();
}
