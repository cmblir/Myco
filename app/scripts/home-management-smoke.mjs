// Synthetic browser regressions and measurements; never uses a private vault.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = new URL(process.env.MYCO_TEST_URL ?? "http://127.0.0.1:5173");
const loopback = ["127.0.0.1", "localhost", "[::1]"];
assert.ok(loopback.includes(base.hostname), "Use a loopback development server");
const browser = await chromium.launch();
const failures = [];
let checks = 0;
function check(value, message) {
  checks++;
  if (!value) failures.push(message);
  console.log(`${value ? "PASS" : "FAIL"} ${message}`);
}

function installAppModuleResolver() {
  // Vite may mount a timestamped HMR URL. A bare import can create another
  // Zustand store, and the default resource buffer is too small for this app.
  performance.setResourceTimingBufferSize(8192);
  window.__importAppModule = (path) => {
    if (!window.__mycoMock || !window.__TAURI_INTERNALS__) throw new Error("Synthetic IPC mock is required");
    const entry = performance.getEntriesByType("resource")
      .filter((resource) => new URL(resource.name).pathname === path).at(-1);
    if (!entry) throw new Error(`App module was not loaded: ${path}`);
    return import(entry.name);
  };
}

try {
  for (const width of [375, 768, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    await page.addInitScript(installAppModuleResolver);
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
      const request = window.requestAnimationFrame;
      window.__homeFrameCount = 0;
      window.requestAnimationFrame = (callback) => request.call(window, (at) => {
        window.__homeFrameCount++;
        callback(at);
      });
    });
    const url = new URL(base);
    url.search = "?mock=1&local=1&nowriter=1";
    await page.goto(url.toString());
    const toggle = page.locator(".home-management-toggle");
    await toggle.waitFor();
    const content = page.locator(".home-management-content");
    check(await toggle.getAttribute("aria-expanded") === "false", `${width}: ordinary Home starts folded`);
    check(await content.evaluate((el) => el.hidden && getComputedStyle(el).display === "none"), `${width}: folded content has no paint`);
    check(await content.evaluate((el) => el.childElementCount === 0), `${width}: initial tools do not mount`);
    check(await page.locator(".home-page .vp-canvas").count() === 0, `${width}: greeting has no graph canvas`);

    // A non-default persisted arrangement must reload after the subtree is
    // released. All writes below go to the browser's synthetic IPC store.
    await page.evaluate(async () => {
      if (!window.__mycoMock || !window.__TAURI_INTERNALS__) throw new Error("Synthetic IPC mock is required");
      const { defaultOverviewLayout, boardRel, OVERVIEW_LAYOUT } = await window.__importAppModule("/src/lib/board.ts");
      const { ipc } = await window.__importAppModule("/src/lib/ipc.ts");
      const layout = defaultOverviewLayout();
      layout.items.reverse();
      layout.items.find((item) => item.id === "pulse").span = 6;
      await ipc.writeFile(`/myco/${boardRel(OVERVIEW_LAYOUT)}`, JSON.stringify(layout));
      window.__homeExpectedLayout = layout.items.map((item) => `${item.id}:${item.span}`);
    });

    await toggle.press("Enter");
    await page.locator(".home-management-tools").waitFor();
    check(await toggle.getAttribute("aria-expanded") === "true", `${width}: keyboard opens tools`);
    check(await content.locator(".vp-figure").count() === 3, `${width}: statistics retain three figures`);
    check(await content.locator(".vp-day").count() === 7, `${width}: statistics retain seven day controls`);
    check(await content.locator(".vp-canvas").count() === 0, `${width}: statistics have no graph canvas`);
    await page.waitForFunction(() => document.querySelector("[data-block='pulse']")?.getAttribute("data-span") === "6");
    const arrangement = () => content.locator("[data-block]").evaluateAll((els) => els.map((el) => `${el.getAttribute("data-block")}:${el.getAttribute("data-span")}`));
    const expected = await page.evaluate(() => window.__homeExpectedLayout);
    check(JSON.stringify(await arrangement()) === JSON.stringify(expected), `${width}: existing user arrangement is retained`);

    await toggle.click();
    check(await content.evaluate((el) => el.hidden && el.childElementCount === 0), `${width}: folding unmounts management widgets`);
    check(await page.locator(".home-management-tools, .home-management-content .board").count() === 0, `${width}: folded board and editing hooks are absent`);

    // An ordinary background graph update and completed harvest may update
    // counts, but neither is an instruction to open the management disclosure.
    await page.evaluate(async () => {
      const { useVaultStore } = await window.__importAppModule("/src/stores/vaultStore.ts");
      const { useHarvestStore } = await window.__importAppModule("/src/stores/harvestStore.ts");
      const adjacency = useVaultStore.getState().adjacency;
      useVaultStore.setState({ adjacency: adjacency ? { ...adjacency } : null });
      useHarvestStore.getState().startRun(20);
      useHarvestStore.getState().endRun(true);
    });
    check(await toggle.getAttribute("aria-expanded") === "false", `${width}: background refresh and harvest completion keep tools folded`);

    const session = await context.newCDPSession(page);
    await session.send("Performance.enable");
    const metrics = async () => new Map((await session.send("Performance.getMetrics")).metrics.map((item) => [item.name, item.value]));
    const before = await metrics();
    const frames = await page.evaluate(() => window.__homeFrameCount);
    await page.waitForTimeout(1000);
    const after = await metrics();
    console.log(JSON.stringify({ width, foldedIdleMs: {
      task: (after.get("TaskDuration") - before.get("TaskDuration")) * 1000,
      script: (after.get("ScriptDuration") - before.get("ScriptDuration")) * 1000,
    }, rafCallbacks: await page.evaluate(() => window.__homeFrameCount) - frames }));

    await page.evaluate(async () => {
      const { useUIStore } = await window.__importAppModule("/src/stores/uiStore.ts");
      useUIStore.getState().focusSection("reflect");
    });
    await page.waitForFunction(() => document.activeElement?.matches(".home-management-content section[tabindex='-1']"));
    check(await toggle.getAttribute("aria-expanded") === "true", `${width}: an explicit section jump reveals its destination`);
    check(await page.evaluate(() => Boolean(document.activeElement?.closest(".home-management-content"))), `${width}: section jump retains keyboard focus`);
    await page.waitForFunction(() => document.querySelector("[data-block='pulse']")?.getAttribute("data-span") === "6");
    check(JSON.stringify(await arrangement()) === JSON.stringify(expected), `${width}: reopening restores saved arrangement`);
    await toggle.click();
    check(await content.evaluate((el) => el.childElementCount === 0), `${width}: closing a targeted section unmounts it`);

    // These are all registered management anchors and all production jump
    // destinations. Make both review items explicit in the synthetic graph.
    await page.evaluate(async () => {
      const { useVaultStore } = await window.__importAppModule("/src/stores/vaultStore.ts");
      const original = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = (cmd, args) => cmd === "semantic_edges"
        ? Promise.resolve([{ source: "/myco/wiki/focus-fixture.md", target: "/myco/wiki/focus-target-fixture.md", score: 0.95 }])
        : original(cmd, args);
      const adjacency = useVaultStore.getState().adjacency;
      if (!adjacency) throw new Error("Synthetic graph is required");
      useVaultStore.setState({ adjacency: { ...adjacency, meta: {
        ...adjacency.meta,
        "/myco/wiki/focus-fixture.md": { title: "Synthetic focus fixture", status: "disputed" },
      } } });
      const { useLinkSuggestStore } = await window.__importAppModule("/src/stores/linkSuggestStore.ts");
      await useLinkSuggestStore.getState().refresh(useVaultStore.getState().adjacency);
    });
    for (const [target, selector] of [["links", ".link-suggestions"], ["contradictions", ".home-contra"]]) {
      await page.evaluate(async (target) => {
        const { useUIStore } = await window.__importAppModule("/src/stores/uiStore.ts");
        useUIStore.getState().focusSection(target);
      }, target);
      await page.waitForFunction((selector) => document.activeElement?.matches(selector), selector);
      check(await toggle.getAttribute("aria-expanded") === "true", `${width}: ${target} section jump opens and focuses its anchor`);
      await toggle.click();
      check(await content.evaluate((el) => el.childElementCount === 0), `${width}: closing ${target} releases the subtree`);
    }
    await page.evaluate(async () => {
      const { useUIStore } = await window.__importAppModule("/src/stores/uiStore.ts");
      useUIStore.getState().focusSection("unrelated-home-fixture");
    });
    await page.waitForFunction(async () => (await window.__importAppModule("/src/stores/uiStore.ts")).useUIStore.getState().focusTarget === null);
    check(await toggle.getAttribute("aria-expanded") === "false", `${width}: an unrelated focus target keeps management folded`);
    check(await page.locator(".home-page").evaluate((el) => el.scrollWidth <= el.clientWidth + 1), `${width}: Home fits the viewport`);
    check(errors.length === 0, `${width}: no browser errors`);
    await context.close();
  }

  // Hold the real UI's synthetic harvest copy request, then fold the tools.
  // This measures input during asynchronous waiting, not native I/O or model
  // inference. Rejecting the held request avoids even mock source writes.
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(installAppModuleResolver);
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
  await page.locator(".home-management-toggle").click();
  const card = page.getByTestId("harvest-queue");
  await card.waitFor();
  await page.evaluate(() => {
    if (!window.__mycoMock || !window.__TAURI_INTERNALS__) throw new Error("Synthetic IPC mock is required");
    const original = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = (cmd, args) => cmd === "harvest_run"
      ? new Promise((_, reject) => {
        window.__homeHarvestPending = true;
        window.__releaseHomeHarvest = () => reject(new Error("Synthetic held harvest released"));
      }) : original(cmd, args);
  });
  await card.getByRole("button", { name: /^Harvest \d+$/, exact: true }).click();
  await card.getByRole("button", { name: "Run", exact: true }).click();
  await page.waitForFunction(() => window.__homeHarvestPending === true);
  await page.locator(".home-management-toggle").click();
  check(await page.locator(".home-management-content").evaluate((el) => el.childElementCount === 0), "pending harvest: tools unmount while the shared run continues");
  const field = page.locator(".home-ask__input");
  await field.focus();
  await field.evaluate((el) => el.addEventListener("input", (event) => {
    const at = performance.now();
    window.__homeInputTiming = { processingMs: at - event.timeStamp };
    requestAnimationFrame(() => { window.__homeInputTiming.nextFrameMs = performance.now() - at; });
  }, { once: true }));
  await page.keyboard.insertText("Synthetic note while harvest waits");
  await page.waitForFunction(() => window.__homeInputTiming?.nextFrameMs !== undefined);
  check(await field.inputValue() === "Synthetic note while harvest waits", "pending harvest: Home input remains usable");
  console.log(JSON.stringify({ pendingSyntheticHarvestInput: await page.evaluate(() => window.__homeInputTiming) }));
  await page.evaluate(async () => {
    const { useUIStore } = await window.__importAppModule("/src/stores/uiStore.ts");
    useUIStore.getState().setRoute("query");
  });
  await page.locator(".home-page").waitFor({ state: "detached" });
  check(await page.evaluate(async () => (await window.__importAppModule("/src/stores/harvestStore.ts")).useHarvestStore.getState().run.phase !== null), "pending harvest: navigation preserves the shared run owner");
  await page.waitForTimeout(1000);
  check(await page.evaluate(() => window.__homeHarvestPending === true), "pending harvest: input test ran before the copy request settled");
  await page.evaluate(() => window.__releaseHomeHarvest());
  await page.waitForFunction(async () => (await window.__importAppModule("/src/stores/harvestStore.ts")).useHarvestStore.getState().run.phase === null);
  await page.evaluate(async () => (await window.__importAppModule("/src/stores/uiStore.ts")).useUIStore.getState().setRoute("overview"));
  await page.locator(".home-management-toggle").waitFor();
  check(await page.locator(".home-management-toggle").getAttribute("aria-expanded") === "false", "pending harvest: completion keeps management folded");
  check(errors.length === 0, "pending harvest: no browser errors after unmount and failure");
  await page.evaluate(async () => {
    const { useUIStore } = await window.__importAppModule("/src/stores/uiStore.ts");
    useUIStore.getState().setSettingsTab("appearance");
    useUIStore.getState().setRoute("settings");
  });
  await page.locator("#settings-panel").waitFor();
  check(await page.locator(".ov-theme-grid, .ov-theme-sw").count() === 0, "settings: orphan Home background previews are absent");
  check(await page.getByRole("heading", { name: "Overview background", exact: true }).count() === 0, "settings: no ineffective Home background setting is advertised");
  check(await page.getByRole("heading", { name: "Appearance", exact: true }).count() > 0, "settings: existing Appearance controls remain available");
  await context.close();
  assert.deepEqual(failures, [], failures.join("\n"));
  console.log(`${checks} checks passed (synthetic IPC; no native performance claim)`);
} finally {
  await browser.close();
}
