// Browser IPC regressions only. Native confinement is tested separately.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = new URL(process.env.MYCO_TEST_URL ?? "http://127.0.0.1:5173");
const loopback = ["127.0.0.1", "localhost", "[::1]"];
assert.ok(loopback.includes(base.hostname), "Use a loopback development server");
const browser = await chromium.launch();
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; console.log(`PASS ${message}`); };

try {
  for (const scenario of ["none", "write", "switch", "board-none", "board-write", "board-switch"]) {
    const isBoard = scenario.startsWith("board-");
    const fault = scenario.replace(/^board-/, "");
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      return loopback.includes(url.hostname) || !["http:", "https:"].includes(url.protocol)
        ? route.continue() : route.abort("blockedbyclient");
    });
    await page.addInitScript(() => {
      localStorage.setItem("myco.onboarded", "1");
      localStorage.setItem("myco-ui", JSON.stringify({ version: 3, state: { lang: "en", theme: "light" } }));
    });
    const url = new URL(base);
    url.search = "?mock=1&local=1&nowriter=1";
    await page.goto(url.toString());
    await page.locator(".home-management-toggle").waitFor();
    await page.evaluate(async (fault) => {
      if (!window.__mycoMock || !window.__TAURI_INTERNALS__) throw new Error("Synthetic IPC mock is required");
      const { useVaultStore } = await import("/src/stores/vaultStore.ts");
      const original = window.__TAURI_INTERNALS__.invoke;
      window.__layoutFixture = { fault, calls: [], writes: [] };
      window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
        if (cmd !== "save_dashboard") return original(cmd, args);
        const activeRoot = useVaultStore.getState().currentVault?.path;
        window.__layoutFixture.calls.push({ ...args, activeRoot, expanded: document.querySelector(".home-management-toggle")?.getAttribute("aria-expanded") });
        if (args.vaultPath && args.vaultPath !== activeRoot) throw new Error("active vault changed");
        if (fault === "write") throw new Error("Synthetic layout write failed");
        const path = `${activeRoot}/.myco/dashboards/${args.name}.json`;
        await original("write_file", { path, content: args.content });
        window.__layoutFixture.writes.push(path);
      };
    }, fault);
    await page.locator(".home-management-toggle").click();
    if (isBoard) {
      await page.locator(".board-range").getByRole("button", { name: "7d", exact: true }).click();
    } else {
      await page.getByRole("button", { name: "Arrange blocks", exact: true }).click();
      await page.locator(".ovl-grip[data-grip='pulse']").press("ArrowDown");
    }
    if (fault === "switch") {
      await page.evaluate(async () => {
        const { useVaultStore } = await import("/src/stores/vaultStore.ts");
        const vault = useVaultStore.getState().currentVault;
        useVaultStore.setState({ currentVault: { ...vault, path: "/synthetic/vault-b" }, fileTree: [], adjacency: null });
      });
    } else {
      await page.locator(".home-management-toggle").click();
    }
    await page.waitForFunction(() => window.__layoutFixture.calls.length > 0);
    const fixture = await page.evaluate(() => window.__layoutFixture);
    check(fixture.calls[0].vaultPath === "/myco", `${scenario}: pending save carries the captured vault`);
    if (fault === "none") {
      check(fixture.calls[0].expanded === "false", `${scenario}: save completes after tools close`);
      await page.waitForFunction(() => window.__layoutFixture.writes.length === 1).catch(async (error) => {
        console.log(await page.evaluate(() => ({ fixture: window.__layoutFixture, notices: document.querySelector(".notice-stack")?.textContent })));
        throw error;
      });
      const saved = await page.evaluate(async (isBoard) => {
        const name = isBoard ? "overview" : "overview-layout";
        return JSON.parse((await window.__TAURI_INTERNALS__.invoke("read_file", { path: `/myco/.myco/dashboards/${name}.json` })).raw);
      }, isBoard);
      check(isBoard ? saved.range === "7d" : saved.items.slice(0, 2).map((item) => item.id).join(",") === "harvest,pulse", `${scenario}: the closing edit is persisted`);
    } else {
      await page.getByText(isBoard ? "Could not save the Home board" : "Could not save the Home layout", { exact: true }).waitFor();
      check(fixture.writes.length === 0, `${scenario}: failure writes no dashboard into another vault`);
      check(await page.locator(".notice.is-warn").filter({ hasText: fault === "switch" ? "active vault changed" : "Synthetic layout write failed" }).count() === 1, `${scenario}: failure remains visible after unmount`);
    }
    check(errors.length === 0, `${scenario}: no browser error or unhandled rejection`);
    await context.close();
  }
  console.log(`${checks} checks passed (synthetic IPC)`);
} finally {
  await browser.close();
}
