// Real UI interactions with synthetic IPC only. No weights, native vault or network download.
// Usage: MYCO_TEST_URL=http://127.0.0.1:5173 node scripts/local-model-settings-smoke.mjs
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const base = new URL(process.env.MYCO_TEST_URL ?? "http://127.0.0.1:5173");
const loopback = ["127.0.0.1", "localhost", "[::1]"];
assert.ok(
  loopback.includes(base.hostname),
  "A loopback development server is required",
);
const output = "/tmp/myco-local-model-settings";
const mockFontStylesheet =
  "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&family=Noto+Sans+KR:wght@400;500;600;700&family=Noto+Sans+JP:wght@400;500;600;700&display=swap";
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
let checks = 0;
function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}

try {
  for (const { width, lang } of [
    ...[375, 768, 1280].map((width) => ({ width, lang: "en" })),
    { width: 375, lang: "ko" },
    { width: 375, lang: "ja" },
  ]) {
    const page = await browser.newPage({
      viewport: { width, height: 900 },
      reducedMotion: "reduce",
    });
    page.setDefaultTimeout(10000);
    const errors = [];
    const blockedRequests = [];
    const modules = new Map();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(`console: ${message.text()}`);
    });
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/src/stores/settingsStore.ts")
        modules.set("settingsStore", url.href);
      if (url.pathname === "/src/stores/localModelStore.ts")
        modules.set("localModelStore", url.href);
    });
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (
        loopback.includes(url.hostname) ||
        !["http:", "https:"].includes(url.protocol)
      )
        return route.continue();
      if (
        url.href === mockFontStylesheet &&
        route.request().resourceType() === "stylesheet"
      )
        // MOCK: serve the known index.html dependency without fetching fonts.
        // Screenshots use system fallback fonts; unrelated resource errors still fail.
        return route.fulfill({
          status: 200,
          contentType: "text/css",
          body: "",
        });
      blockedRequests.push(url.href);
      return route.abort("blockedbyclient");
    });
    await page.addInitScript((lang) => {
      localStorage.setItem("myco.onboarded", "1");
      localStorage.setItem(
        "myco-ui",
        JSON.stringify({
          version: 3,
          state: { lang, theme: "light", settingsTab: "model" },
        }),
      );
    }, lang);
    try {
      const url = new URL(base);
      url.search = "?mock=1&nowriter=1";
      await page.goto(url.toString());
      await page.locator(".home-page").waitFor();
      assert.ok(
        modules.has("settingsStore"),
        "The live settings store module must be observed",
      );
      await page.evaluate(async (settingsStoreUrl) => {
        if (!window.__mycoMock)
          throw new Error("Synthetic IPC mock is required");
        const original = window.__TAURI_INTERNALS__.invoke;
        window.__mycoMock.settings({
          query_provider: "anthropic-cli",
          query_model: "sonnet",
        });
        const settings = (await import(settingsStoreUrl)).useSettingsStore;
        await settings.getState().load();
        await settings.getState().syncOllama();
        const ready = {
          model_id: "qwen3.5-4b-q4_k_m",
          state: "ready",
          bytes: 2707513696,
        };
        const fastReady = {
          model_id: "qwen3.5-2b-q4_k_m",
          state: "ready",
          bytes: 1270808032,
        };
        const smoke = (window.__localModelSmoke = {
          ready,
          fastReady,
          status: { ...ready, state: "missing", bytes: 0 },
          fastStatus: { ...fastReady, state: "missing", bytes: 0 },
          holdStatus: true,
          statusWaiters: [],
          statusModels: [],
          downloads: 0,
          downloadModels: [],
          cancellations: 0,
          cancelModels: [],
          writes: 0,
          unlisteners: 0,
          pendingDownload: null,
          calls: [],
        });
        window.__TAURI_INTERNALS__.invoke = (command, args) => {
          smoke.calls.push(command);
          if (command === "local_chat_status") {
            if (![ready.model_id, fastReady.model_id].includes(args?.modelId))
              throw new Error("Status must identify a pinned model explicitly");
            smoke.statusModels.push(args.modelId);
            return smoke.holdStatus
              ? new Promise((resolve) =>
                  smoke.statusWaiters.push({ resolve, modelId: args.modelId }),
                )
              : Promise.resolve(
                  args.modelId === ready.model_id
                    ? smoke.status
                    : smoke.fastStatus,
                );
          }
          if (command === "download_local_chat_model") {
            if (![ready.model_id, fastReady.model_id].includes(args?.modelId))
              throw new Error(
                "Download must identify a pinned model explicitly",
              );
            smoke.downloads += 1;
            smoke.downloadModels.push(args.modelId);
            if (smoke.pendingDownload)
              throw new Error(
                "Only one synthetic download may own the native slot",
              );
            return new Promise((resolve, reject) => {
              smoke.pendingDownload = {
                modelId: args.modelId,
                resolve(status) {
                  smoke.pendingDownload = null;
                  resolve(status);
                },
                reject(error) {
                  smoke.pendingDownload = null;
                  reject(error);
                },
              };
            });
          }
          if (command === "cancel_local_chat_model_download") {
            smoke.cancellations += 1;
            smoke.cancelModels.push(smoke.pendingDownload?.modelId ?? null);
            return Promise.resolve(true); // Cleanup remains pending until the test settles download.
          }
          if (
            command === "plugin:event|unlisten" &&
            args.event === "local-chat-model-progress"
          )
            smoke.unlisteners += 1;
          if (command === "set_settings") smoke.writes += 1;
          return original(command, args);
        };
        smoke.initial = await original("get_settings");
      }, modules.get("settingsStore"));
      if (width <= 768) {
        await page.locator(".app.sidebar-collapsed").waitFor();
        await page
          .getByRole("button", {
            name: {
              en: "Toggle sidebar (⌘B)",
              ko: "사이드바 토글 (⌘B)",
              ja: "サイドバー切替 (⌘B)",
            }[lang],
            exact: true,
          })
          .click();
      }
      await page.waitForFunction(
        () =>
          Math.abs(
            document.querySelector(".sidebar").getBoundingClientRect().x,
          ) < 0.5,
      );
      const gear = page.locator(".side-head .side-gear");
      await gear.click();
      async function chooseTab(id) {
        const back = page.locator(".settings-back");
        if (await back.isVisible()) await back.click();
        await page.locator(`#settings-choice-${id}`).click();
      }
      await chooseTab("model");
      const card = page.locator('[data-srow="model_local_generation"]');
      const fastCard = page.locator(
        '[data-srow="model_local_generation_fast"]',
      );
      await card.waitFor();
      await fastCard.waitFor();
      const { c, fast, searchLabel } = await page.evaluate(async (lang) => {
        const { localModelCopy } = await import("/src/lib/localModelCopy.ts");
        const c = localModelCopy(lang);
        const fast = localModelCopy(lang, "qwen3.5-2b-q4_k_m");
        const t = (await import("/src/lib/i18n.ts")).STRINGS[lang];
        return { c, fast, searchLabel: t.s_search_ph };
      }, lang);
      const action = (name) => card.getByRole("button", { name, exact: true });
      const fastAction = (name) =>
        fastCard.getByRole("button", { name, exact: true });
      check(
        (await card.isVisible()) && (await fastCard.isVisible()),
        "Both pinned model cards are visible",
      );
      check(
        await fastCard.getByText(fast.checking, { exact: true }).isVisible(),
        "2B has its own checking state",
      );
      check(
        (await fastCard.innerText()).includes("1.27 GB") &&
          !(await fastCard.innerText()).includes("2.71 GB"),
        "2B shows its own artifact size",
      );
      for (const copy of [c, fast]) {
        check(
          /requiring review|확인 필요|要確認/.test(copy.lede) &&
            !/before saving|저장 전에|확인한 뒤 저장|保存前|確認してから保存/.test(
              copy.lede,
            ),
          "Draft copy describes reviewable saved output without inventing an approval step",
        );
        check(
          /organization|정리|整理/.test(copy.lede) &&
            /remote Ask|원격 Ask|リモートAsk/.test(copy.lede),
          "Copy explains local organization and preserved remote Ask settings",
        );
      }
      check(
        await card.getByText(c.checking, { exact: true }).isVisible(),
        "Checking state is visible",
      );
      check(
        await action(c.use).isDisabled(),
        "Generation cannot be selected while checking",
      );
      check(
        await page.evaluate(() => window.__localModelSmoke.downloads === 0),
        "Availability never downloads weights",
      );
      await page.evaluate(() => {
        const s = window.__localModelSmoke;
        s.holdStatus = false;
        for (const { resolve, modelId } of s.statusWaiters.splice(0))
          resolve(modelId === s.ready.model_id ? s.status : s.fastStatus);
      });
      await card.getByText(c.missing, { exact: true }).waitFor();
      await fastCard.getByText(fast.missing, { exact: true }).waitFor();
      check(
        await page.evaluate(() => {
          const s = window.__localModelSmoke;
          return (
            s.statusModels.includes(s.ready.model_id) &&
            s.statusModels.includes(s.fastReady.model_id)
          );
        }),
        "Both availability checks name the exact model IDs",
      );
      check(
        await page
          .locator('[data-srow="model_query"]')
          .getByText("anthropic-cli · sonnet", { exact: true })
          .isVisible(),
        "The actual query picker keeps the initial external provider",
      );
      check(
        await action(c.install).isEnabled(),
        "Missing weights expose explicit install",
      );
      check(
        await action(c.use).isDisabled(),
        "Missing weights cannot be selected for synthesis",
      );
      const search = page.getByRole("searchbox", {
        name: searchLabel,
        exact: true,
      });
      const back = page.locator(".settings-back");
      if (await back.isVisible()) await back.click();
      await search.fill("Qwen");
      check(
        await page.locator("#settings-choice-model").isVisible(),
        "Qwen search retains the model section",
      );
      await chooseTab("model");
      await card.getByRole("heading", { name: c.title, exact: true }).waitFor();
      check(
        await card.isVisible(),
        "Qwen settings search keeps the actual card reachable",
      );
      check(
        await fastCard.isVisible(),
        "Qwen search also keeps the 2B card reachable",
      );
      if (await back.isVisible()) await back.click();
      await search.fill("2B");
      check(
        await page.locator("#settings-choice-model").isVisible(),
        "2B search retains the model section",
      );
      await chooseTab("model");
      await fastCard
        .getByRole("heading", { name: fast.title, exact: true })
        .waitFor();
      check(
        (await fastCard.isVisible()) && (await card.count()) === 0,
        "2B search matches the registered 2B card and filters the 4B card",
      );
      if (await back.isVisible()) await back.click();
      await search.fill("");
      await chooseTab("model");

      async function geometry(label, target = card) {
        const result = await target.evaluate((card) => ({
          overflow: card.scrollWidth - card.clientWidth,
          documentOverflow: document.documentElement.scrollWidth - innerWidth,
          buttons: [...card.querySelectorAll("button")].map((button) => {
            const r = button.getBoundingClientRect();
            return {
              width: r.width,
              height: r.height,
              right: r.right,
              text: button.textContent,
            };
          }),
        }));
        check(
          result.overflow <= 1,
          `${label}: card has no horizontal overflow (${result.overflow}px)`,
        );
        check(
          result.documentOverflow <= 1,
          `${label}: page has no horizontal overflow (${result.documentOverflow}px)`,
        );
        check(
          result.buttons.every(
            (button) =>
              button.width >= 43.99 &&
              button.height >= 43.99 &&
              button.right <= width + 1,
          ),
          `${label}: buttons have 44px targets within the viewport: ${JSON.stringify(result.buttons)}`,
        );
      }
      await geometry("missing");
      await geometry("2B missing", fastCard);
      await page.screenshot({
        path: `${output}/${lang}-${width}-missing.png`,
        fullPage: true,
      });
      await action(c.install).focus();
      await page.keyboard.press("Tab");
      check(
        await action(c.check).evaluate(
          (button) => document.activeElement === button,
        ),
        "Keyboard reaches the next enabled action",
      );
      check(
        await action(c.check).evaluate(
          (button) =>
            button.matches(":focus-visible") &&
            getComputedStyle(button).outlineStyle !== "none",
        ),
        "Keyboard focus is visible",
      );
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        () => window.__localModelSmoke.downloads === 1,
      );
      await card.getByText(c.downloading, { exact: true }).waitFor();
      check(
        await action(c.cancel).isEnabled(),
        "A running download exposes cancellation",
      );
      check(
        (await fastAction(fast.install).isDisabled()) &&
          (await fastAction(fast.cancel).count()) === 0,
        "The 2B card cannot start or cancel the 4B download",
      );
      assert.ok(
        modules.has("localModelStore"),
        "The live local model store module must be observed",
      );
      await page.evaluate(async (storeUrl) => {
        const { useFastLocalModelStore } = await import(storeUrl);
        await useFastLocalModelStore.getState().download();
        await useFastLocalModelStore.getState().cancelDownload();
      }, modules.get("localModelStore"));
      check(
        await page.evaluate(
          () =>
            window.__localModelSmoke.downloads === 1 &&
            window.__localModelSmoke.cancellations === 0,
        ),
        "A nonowner's queued download and cancel cannot reach native IPC",
      );
      check(
        await page.evaluate(() => window.__localModelSmoke.writes === 0),
        "Install alone never selects an answer model",
      );
      await page.evaluate(() =>
        window.__mycoMock.emit("local-chat-model-progress", {
          downloaded: 1353756848,
          total: 2707513696,
          pct: 50,
        }),
      );
      const progress = card.getByRole("progressbar", {
        name: c.progress,
        exact: true,
      });
      await progress.waitFor();
      await page.waitForFunction(
        () =>
          document.querySelector(
            '[data-srow="model_local_generation"] progress',
          )?.value === 50,
      );
      await page.evaluate(() =>
        window.__mycoMock.emit("local-chat-model-progress", {
          downloaded: 1,
          total: 2707513696,
          pct: 0,
        }),
      );
      check(
        (await progress.getAttribute("value")) === "50",
        "Progress never regresses",
      );
      await page.evaluate(() =>
        window.__mycoMock.emit("local-chat-model-progress", {
          downloaded: 2707513696,
          total: 2707513696,
          pct: 100,
        }),
      );
      await card.getByText(c.verifying, { exact: true }).waitFor();
      check(
        await action(c.use).isDisabled(),
        "100% event cannot bypass verification",
      );
      await geometry("verifying");
      await page.screenshot({
        path: `${output}/${lang}-${width}-verifying.png`,
        fullPage: true,
      });
      await chooseTab("appearance");
      await chooseTab("model");
      await card.getByText(c.verifying, { exact: true }).waitFor();
      check(
        await page.evaluate(() => window.__localModelSmoke.downloads === 1),
        "Panel reentry preserves the single download",
      );
      await action(c.cancel).click();
      await card.getByText(c.cancelling, { exact: true }).waitFor();
      check(
        await action(c.cancel).isDisabled(),
        "Cancellation acknowledgement stays busy during cleanup",
      );
      check(
        (await action(c.install).count()) === 0,
        "Cleanup cannot start a second download",
      );
      await page.evaluate(() =>
        window.__localModelSmoke.pendingDownload.reject(
          new Error("local model download cancelled"),
        ),
      );
      await card.getByText(c.missing, { exact: true }).waitFor();
      await page.waitForFunction(
        () => window.__localModelSmoke.unlisteners >= 1,
      );
      check(
        await action(c.install).isEnabled(),
        "Explicit retry is available after cleanup",
      );
      check(
        await page.evaluate(() => window.__localModelSmoke.writes === 0),
        "Cancel also preserves provider selection",
      );

      await action(c.install).click();
      await page.waitForFunction(
        () => window.__localModelSmoke.downloads === 2,
      );
      await page.evaluate(() =>
        window.__localModelSmoke.pendingDownload.reject(
          new Error("synthetic verification failed"),
        ),
      );
      await card.getByText(c.error, { exact: true }).waitFor();
      check(
        await action(c.retry).isEnabled(),
        "Verification failure offers an explicit retry",
      );
      await card.getByText(c.details, { exact: true }).click();
      check(
        await card
          .getByText("Error: synthetic verification failed", { exact: true })
          .isVisible(),
        "Failure details are visible",
      );
      await action(c.retry).click();
      await page.waitForFunction(
        () => window.__localModelSmoke.downloads === 3,
      );
      await page.evaluate(() => {
        const s = window.__localModelSmoke;
        s.status = s.ready;
        s.pendingDownload.resolve(s.ready);
      });
      await card.getByText(c.ready, { exact: true }).waitFor();
      check(
        await action(c.use).isEnabled(),
        "Verified ready state enables explicit synthesis selection",
      );
      check(
        await page.evaluate(() => window.__localModelSmoke.writes === 0),
        "Ready does not automatically replace an external provider",
      );
      await action(c.use).focus();
      await page.keyboard.press("Enter");
      await action(c.selected).waitFor();
      const selected = await page.evaluate(async () =>
        window.__TAURI_INTERNALS__.invoke("get_settings"),
      );
      check(
        selected.query_provider === "builtin-local" &&
          selected.query_model === "qwen3.5-4b-q4_k_m",
        "Keyboard selection persists the Qwen Ask model",
      );
      const unchanged = await page.evaluate(
        () => window.__localModelSmoke.initial,
      );
      check(
        selected.ingest_provider === unchanged.ingest_provider &&
          selected.ingest_model === unchanged.ingest_model,
        "Ask selection preserves the ingest model",
      );
      check(
        JSON.stringify(selected.providers) ===
          JSON.stringify(unchanged.providers),
        "Ask selection preserves provider connection flags",
      );
      await geometry("ready");
      await page.screenshot({
        path: `${output}/${lang}-${width}-ready.png`,
        fullPage: true,
      });
      await action(c.quotes).click();
      await action(c.quotesSelected).waitFor();
      check(
        await page.evaluate(
          async () =>
            (await window.__TAURI_INTERNALS__.invoke("get_settings"))
              .query_model === "extractive-retrieval",
        ),
        "Quote-only selection restores lightweight answers",
      );
      check(
        await page.evaluate(
          () =>
            window.__localModelSmoke.downloads === 3 &&
            window.__localModelSmoke.cancellations === 1 &&
            !window.__localModelSmoke.calls.includes("local_synthesize"),
        ),
        "Only explicit installs download; settings never run inference",
      );

      await action(c.use).click();
      await action(c.selected).waitFor();
      await fastAction(fast.install).click();
      await page.waitForFunction(
        () => window.__localModelSmoke.downloads === 4,
      );
      await fastCard.getByText(fast.downloading, { exact: true }).waitFor();
      check(
        await page.evaluate(() => {
          const s = window.__localModelSmoke;
          return s.pendingDownload.modelId === s.fastReady.model_id;
        }),
        "The 2B install names the correct native artifact",
      );

      await page.evaluate(() => {
        const s = window.__localModelSmoke;
        s.status = { ...s.ready, state: "missing", bytes: 0 };
      });
      await action(c.check).click();
      await card.getByText(c.missing, { exact: true }).waitFor();
      check(
        (await action(c.install).isDisabled()) &&
          (await action(c.cancel).count()) === 0,
        "The 4B card cannot start or cancel a 2B download",
      );
      await page.evaluate(async (storeUrl) => {
        const { useLocalModelStore } = await import(storeUrl);
        await useLocalModelStore.getState().download();
        await useLocalModelStore.getState().cancelDownload();
      }, modules.get("localModelStore"));
      check(
        await page.evaluate(
          () =>
            window.__localModelSmoke.downloads === 4 &&
            window.__localModelSmoke.cancellations === 1,
        ),
        "A missing nonowner 4B store cannot acquire or cancel the active 2B slot",
      );

      await page.evaluate(() =>
        window.__mycoMock.emit("local-chat-model-progress", {
          downloaded: 1353756848,
          total: 2707513696,
          pct: 50,
        }),
      );
      const fastProgress = fastCard.getByRole("progressbar", {
        name: fast.progress,
        exact: true,
      });
      check(
        (await fastProgress.getAttribute("value")) === "0",
        "The 2B card rejects a 4B progress payload",
      );
      await page.evaluate(() =>
        window.__mycoMock.emit("local-chat-model-progress", {
          downloaded: 635404016,
          total: 1270808032,
          pct: 50,
        }),
      );
      await page.waitForFunction(
        () =>
          document.querySelector(
            '[data-srow="model_local_generation_fast"] progress',
          )?.value === 50,
      );
      check(
        (await fastProgress.getAttribute("value")) === "50",
        "The 2B card accepts progress for exactly 1270808032 bytes",
      );
      await fastAction(fast.cancel).click();
      await fastCard.getByText(fast.cancelling, { exact: true }).waitFor();
      check(
        await fastAction(fast.cancel).isDisabled(),
        "2B cancellation also waits for cleanup",
      );
      await page.evaluate(() =>
        window.__localModelSmoke.pendingDownload.reject(
          new Error("local model download cancelled"),
        ),
      );
      await fastCard.getByText(fast.missing, { exact: true }).waitFor();
      check(
        await page.evaluate(() => {
          const s = window.__localModelSmoke;
          return (
            s.cancellations === 2 &&
            JSON.stringify(s.cancelModels) ===
              JSON.stringify([s.ready.model_id, s.fastReady.model_id])
          );
        }),
        "Each native cancellation belongs only to its downloading model",
      );

      await page.evaluate(() => {
        const s = window.__localModelSmoke;
        s.status = s.ready;
      });
      await action(c.check).click();
      await card.getByText(c.ready, { exact: true }).waitFor();
      await fastAction(fast.install).click();
      await page.waitForFunction(
        () => window.__localModelSmoke.downloads === 5,
      );
      await page.evaluate(() => {
        const s = window.__localModelSmoke;
        s.pendingDownload.resolve(s.ready);
      });
      await fastCard.getByText(fast.error, { exact: true }).waitFor();
      check(
        (await fastAction(fast.use).isDisabled()) &&
          (await fastAction(fast.useForIngest).isDisabled()),
        "A 4B completion cannot make the 2B model selectable",
      );
      await page.evaluate(() => {
        const s = window.__localModelSmoke;
        s.fastStatus = { ...s.fastReady, bytes: s.ready.bytes };
      });
      await fastAction(fast.check).click();
      await fastCard.getByText(fast.error, { exact: true }).waitFor();
      check(
        await fastAction(fast.useForIngest).isDisabled(),
        "A 2B status with 4B bytes cannot enable ingest selection",
      );
      await page.evaluate(() => {
        const s = window.__localModelSmoke;
        s.fastStatus = s.fastReady;
      });
      await fastAction(fast.check).click();
      await fastCard.getByText(fast.ready, { exact: true }).waitFor();
      check(
        await fastAction(fast.useForIngest).isEnabled(),
        "Only an exact verified 2B status enables its explicit ingest choice",
      );

      const beforeIngest = await page.evaluate(() =>
        window.__TAURI_INTERNALS__.invoke("get_settings"),
      );
      check(
        beforeIngest.query_provider === "builtin-local" &&
          beforeIngest.query_model === "qwen3.5-4b-q4_k_m",
        "4B remains selected for Ask before the independent 2B ingest choice",
      );
      await fastAction(fast.useForIngest).click();
      await fastAction(fast.ingestSelected).waitFor();
      const afterIngest = await page.evaluate(() =>
        window.__TAURI_INTERNALS__.invoke("get_settings"),
      );
      check(
        afterIngest.ingest_provider === "builtin-local" &&
          afterIngest.ingest_model === "qwen3.5-2b-q4_k_m",
        "Selecting the 2B ingest button persists only that role's model",
      );
      check(
        afterIngest.query_provider === beforeIngest.query_provider &&
          afterIngest.query_model === beforeIngest.query_model,
        "Selecting 2B ingest preserves the selected 4B Ask model",
      );
      const otherSettings = ({ ingest_provider, ingest_model, ...other }) =>
        other;
      assert.deepEqual(
        otherSettings(afterIngest),
        otherSettings(beforeIngest),
        "Ingest selection preserves every other setting and effort preference",
      );
      checks += 1;
      check(
        (await action(c.selected).isDisabled()) &&
          (await fastAction(fast.use).isEnabled()),
        "The card selections show 4B Ask and 2B ingest independently",
      );
      await geometry("dual ready 4B");
      await geometry("dual ready 2B", fastCard);
      await page.screenshot({
        path: `${output}/${lang}-${width}-dual-ready.png`,
        fullPage: true,
      });
      await page.screenshot({
        path: `${output}/${lang}-${width}-dual-visible.png`,
        fullPage: false,
      });
      check(
        await page.evaluate(() => {
          const s = window.__localModelSmoke;
          return (
            s.downloads === 5 &&
            JSON.stringify(s.downloadModels) ===
              JSON.stringify([
                s.ready.model_id,
                s.ready.model_id,
                s.ready.model_id,
                s.fastReady.model_id,
                s.fastReady.model_id,
              ]) &&
            !s.calls.includes("local_synthesize") &&
            !s.calls.includes("local_query")
          );
        }),
        "All five downloads identify their intended model; settings do not invoke inference",
      );
      check(
        errors.length === 0,
        `No browser page errors: ${JSON.stringify(errors)}; intentionally blocked requests: ${JSON.stringify(blockedRequests)}`,
      );
      console.log(
        `PASS ${lang} ${width}: both model cards, exact artifacts, independent roles, download ownership, five states, search, keyboard and viewport`,
      );
    } catch (error) {
      await page.screenshot({
        path: `${output}/${lang}-${width}-failure.png`,
        fullPage: true,
      });
      throw error;
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
console.log(
  `${checks} checks passed (synthetic IPC, system fallback fonts, no native model/download/vault calls); screenshots: ${output}`,
);
