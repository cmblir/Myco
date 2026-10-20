// Strict browser workflow evidence against the existing in-memory IPC mock.
// Native files, credentials, models, microphone, and account sync are not tested.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const base = process.env.MYCO_TEST_URL ?? "http://127.0.0.1:5173";
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname), "Use a loopback development server");
const output = process.env.MYCO_SCREENSHOTS ?? "/tmp/myco-desktop-feature-audit";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: !process.argv.includes("--headed") });
const results = [];
async function verify(name, body) {
  const started = performance.now();
  try {
    await body();
    results.push({ name, status: "passed", seconds: (performance.now() - started) / 1000 });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, status: "failed", seconds: (performance.now() - started) / 1000, error: String(error.stack ?? error) });
    console.error(`FAIL ${name}: ${error.message}`);
  }
}
async function openPage({ failProvenanceRead = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !["http:", "https:"].includes(url.protocol)
      ? route.continue() : route.abort("blockedbyclient");
  });
  await page.addInitScript(({ failProvenanceRead }) => {
    window.__importAppModule = (path) => {
      const entry = performance.getEntriesByType("resource").filter(resource => new URL(resource.name).pathname === path).at(-1);
      if (!entry) throw new Error(`App module was not loaded: ${path}`);
      return import(entry.name);
    };
    localStorage.setItem("myco.onboarded", "1");
    localStorage.setItem("myco-ui", JSON.stringify({ version: 3, state: { lang: "en", theme: "light", sidebarCollapsed: false } }));
    window.failStudyRead = false;
    window.failInboxRead = false;
    window.failProvenanceRead = failProvenanceRead;
    let internals;
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true, get: () => internals,
      set: (value) => {
        const invoke = value.invoke;
        value.invoke = (command, args) => {
          if (command === "read_file" && window.failStudyRead && args?.path.includes("/cards/"))
            return Promise.reject(new Error("Synthetic Study read failure"));
          if (command === "list_inbox_entries" && window.failInboxRead)
            return Promise.reject(new Error("Synthetic inbox read failure"));
          if (command === "scan_provenance" && window.failProvenanceRead)
            return Promise.reject(new Error("Synthetic provenance scan failure"));
          return invoke(command, args);
        };
        internals = value;
      },
    });
  }, { failProvenanceRead });
  await page.goto(`${base}/?mock=1`, { waitUntil: "domcontentloaded" });
  await page.locator(".side-nav").waitFor();
  try {
    await page.locator(".home-page").waitFor();
  } catch (error) {
    console.error(JSON.stringify({ errors, text: await page.locator("body").innerText() }));
    await page.close();
    throw error;
  }
  return { page, errors };
}

try {
  const { page, errors } = await openPage();
  const routes = [
    ["overview", "Home"], ["query", "Ask"], ["ingest", "Add sources"],
    ["feedback", "Review suggestions"], ["graph", "Graph"], ["tasks", "Tasks"],
    ["study", "Study"], ["history", "History"], ["provenance", "Provenance"],
  ];
  for (const [route, label] of routes) {
    await verify(`mock route ${route} through named navigation`, async () => {
      if (["study", "history", "provenance"].includes(route)) {
        const more = page.locator(".side-nav").getByRole("button", { name: /^More tools/ });
        if (await more.getAttribute("aria-expanded") === "false") await more.click();
      }
      const target = page.locator(".side-nav .nav-item").filter({ has: page.locator(".ni-text", { hasText: new RegExp(`^${label}$`) }) });
      await target.click();
      assert.equal(await target.getAttribute("aria-current"), "page");
      const titleElement = page.locator(".route-fade .u-page__title, .route-fade .page-title").first();
      await (route === "graph" ? page.locator(".graph-canvas") : titleElement).waitFor();
      if (route !== "graph") {
        const title = await titleElement.innerText();
        const expected = route === "query" ? "Ask" : route === "feedback" ? "Harvest box" : label;
        assert.ok(title.includes(expected), `Expected ${route} title, received ${title}`);
      }
      assert.deepEqual(errors, []);
      await page.screenshot({ path: `${output}/${route}.png` });
    });
  }
  await verify("mock settings opens through named button", async () => {
    await page.locator(".side-head").getByRole("button", { name: "Settings", exact: true }).click();
    await page.locator(".settings-navigation").waitFor();
    assert.equal(await page.locator(".route-fade h1").innerText(), "Settings");
  });
  await page.close();

  await verify("Provenance scan failure is visible and retry restores coverage rows (mock IPC)", async () => {
    const { page, errors } = await openPage({ failProvenanceRead: true });
    try {
      await page.locator(".side-nav").getByRole("button", { name: /^More tools/ }).click();
      await page.locator(".side-nav .nav-item").filter({ has: page.locator(".ni-text", { hasText: /^Provenance$/ }) }).click();
      const alert = page.locator(".route-fade").getByRole("alert");
      await alert.waitFor();
      assert.ok((await alert.innerText()).includes("Synthetic provenance scan failure"));
      assert.equal(await page.locator(".prov-row").count(), 0);
      await page.evaluate(() => { window.failProvenanceRead = false; });
      await alert.getByRole("button", { name: "Retry", exact: true }).click();
      await alert.waitFor({ state: "detached" });
      await page.locator(".prov-row").first().waitFor();
      assert.ok(await page.locator(".prov-row").count() > 0);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  await verify("Inbox read failure is visible and retry restores pending sources (mock IPC)", async () => {
    const { page, errors } = await openPage();
    const sources = page.locator(".side-nav .nav-item").filter({ has: page.locator(".ni-text", { hasText: /^Add sources$/ }) });
    const home = page.locator(".side-nav .nav-item").filter({ has: page.locator(".ni-text", { hasText: /^Home$/ }) });
    async function openInbox() {
      await sources.click();
      await page.getByTestId("intake-more-sources").locator("summary").first().click();
      await page.locator(".sv-chan-list summary").filter({ hasText: "_inbox queue" }).click();
    }
    try {
      await openInbox();
      const pending = page.getByTestId("inbox-pending");
      await pending.waitFor();
      const before = await pending.innerText();
      await home.click();
      await page.evaluate(() => { window.failInboxRead = true; });
      await openInbox();
      const alert = page.locator(".sv-chan-list").getByRole("alert");
      await alert.waitFor();
      assert.ok((await alert.innerText()).includes("Synthetic inbox read failure"));
      assert.equal(await pending.count(), 0);
      await page.evaluate(() => { window.failInboxRead = false; });
      await alert.getByRole("button", { name: "Retry", exact: true }).click();
      await alert.waitFor({ state: "detached" });
      await pending.waitFor();
      assert.equal(await pending.innerText(), before);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  await verify("Study read failure is visible and retry restores deck counts (mock IPC)", async () => {
    const { page, errors } = await openPage();
    try {
      await page.locator(".side-nav").getByRole("button", { name: /^More tools/ }).click();
      await page.locator(".side-nav .nav-item").filter({ hasText: /^Study/ }).click();
      await page.locator(".deck-row").first().waitFor();
      const before = await page.locator(".deck-row").allInnerTexts();
      await page.evaluate(() => { window.failStudyRead = true; });
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await page.locator('[data-testid="study-load-error"]').waitFor();
      assert.equal(await page.locator(".deck-row").count(), 0);
      await page.evaluate(() => { window.failStudyRead = false; });
      await page.locator('[data-testid="study-load-error"]').getByRole("button").click();
      await page.locator('[data-testid="study-load-error"]').waitFor({ state: "detached" });
      await page.locator(".deck-row").first().waitFor();
      assert.deepEqual(await page.locator(".deck-row").allInnerTexts(), before);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
  await verify("Session queue has truthful states, bounded rows and keyboard controls (mock IPC)", async () => {
    const { page, errors } = await openPage();
    try {
      await page.evaluate(() => {
        if (!window.__mycoMock || !window.__TAURI_INTERNALS__) throw new Error("Synthetic IPC mock is required");
        const invoke = window.__TAURI_INTERNALS__.invoke;
        const fixture = window.__sessionQueueFixture = { phase: "ready", trace: [], release: null,
          view: { pendingTotal: 8, items: ["pending", "partial", "failed"].map((state, index) => ({
            key: "codex:synthetic", rawPath: "raw/conversations/codex/synthetic.md", sourceRevision: "a".repeat(64),
            title: `Synthetic ${index} ${"long-title".repeat(24)}`, srcSlug: "src-synthetic", summaryPath: null,
            compileJobId: "synthetic-duplicate-id", compilationState: state,
            compilationReason: index === 0 ? "compiler_runtime_revalidation_required" : "processing_failed",
          })) } };
        window.__TAURI_INTERNALS__.invoke = (command, args) => {
          fixture.trace.push({ command, args });
          if (command !== "list_wikify_pending") return invoke(command, args);
          if (fixture.phase === "error") return Promise.reject(new Error("Synthetic queue read failure"));
          if (fixture.phase === "loading") return new Promise(resolve => { fixture.release = resolve; });
          return Promise.resolve(fixture.phase === "empty" ? { pendingTotal: 0, items: [] } : fixture.view);
        };
      });
      await page.locator(".side-nav .nav-item").filter({ has: page.locator(".ni-text", { hasText: /^Add sources$/ }) }).click();
      const more = page.getByTestId("intake-more-sources").locator("summary").first();
      await more.focus(); await more.press("Enter");
      const advanced = page.getByTestId("intake-advanced").locator("summary").first();
      await advanced.focus(); await advanced.press("Enter");
      const queue = page.getByTestId("session-compile-queue");
      const channel = page.locator(".sv-ch-li > details").filter({ has: queue }).locator("summary").first();
      await channel.focus(); await channel.press("Enter");
      await queue.waitFor();
      const rows = queue.getByTestId("session-compile-queue-row");
      await rows.first().waitFor();
      assert.equal(await rows.count(), 3, "Do not merge duplicate durable IDs");
      assert.ok((await queue.innerText()).includes("8 unfinished work items · showing 3"));
      assert.ok((await queue.innerText()).includes("Partially completed"));
      assert.ok((await queue.innerText()).includes("Could not finish"));
      const details = rows.first().locator("summary");
      await details.focus(); await details.press("Enter");
      await rows.first().getByText("compiler_runtime_revalidation_required", { exact: true }).waitFor();
      const refresh = queue.getByRole("button", { name: "Refresh list", exact: true });
      await channel.focus();
      let reachedRefresh = false;
      for (let step = 0; step < 16 && !reachedRefresh; step++) {
        await page.keyboard.press("Tab");
        reachedRefresh = await refresh.evaluate(element => element === document.activeElement);
      }
      assert.ok(reachedRefresh, "Tab reaches Refresh without activating a model");
      assert.ok(await refresh.evaluate(element => {
        const style = getComputedStyle(element);
        return style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0;
      }), "Keyboard focus is visible");
      await page.keyboard.press("Tab");
      assert.ok(await details.evaluate(element => element === document.activeElement), "Tab reaches the first reason disclosure");
      for (const width of [320, 375, 768, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        assert.ok(await queue.evaluate(element => {
          const box = element.getBoundingClientRect();
          return element.scrollWidth <= element.clientWidth + 1 && box.left >= -1 &&
            box.right <= innerWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1;
        }), `${width}: queue and document fit the viewport`);
        const box = await refresh.boundingBox();
        assert.ok(box && box.width >= 44 && box.height >= 44, `${width}: refresh has a 44px target`);
        await queue.screenshot({ path: `${output}/session-queue-${width}.png` });
      }
      await page.evaluate(() => { window.__sessionQueueFixture.phase = "error"; });
      await refresh.focus(); await refresh.press("Enter");
      await queue.getByRole("alert").waitFor();
      assert.ok((await queue.innerText()).includes("Synthetic queue read failure"));
      assert.equal(await rows.count(), 0, "Read errors must not retain prior rows");
      await queue.screenshot({ path: `${output}/session-queue-error.png` });
      await page.evaluate(() => { window.__sessionQueueFixture.phase = "empty"; });
      await refresh.press("Enter");
      await queue.getByText("No unfinished session organization work.", { exact: true }).waitFor();
      await page.evaluate(() => { window.__sessionQueueFixture.phase = "loading"; });
      await refresh.press("Enter");
      await page.waitForFunction(() => window.__sessionQueueFixture.release !== null);
      await page.waitForFunction(() => document.querySelector('[data-testid="session-compile-queue"]')?.getAttribute("aria-busy") === "true");
      assert.equal(await refresh.isDisabled(), true);
      assert.equal(await queue.getAttribute("aria-busy"), "true");
      assert.equal(await rows.count(), 0, "Loading cannot imply completed work");
      await queue.screenshot({ path: `${output}/session-queue-loading.png` });
      await page.evaluate(() => { const fixture = window.__sessionQueueFixture; fixture.phase = "ready"; fixture.release(fixture.view); });
      await rows.first().waitFor();
      await page.evaluate(() => {
        const fixture = window.__sessionQueueFixture;
        fixture.view = { ...fixture.view, items: fixture.view.items.map(item => ({ ...item, title: `Synthetic ${item.compilationState} session` })) };
      });
      await refresh.click();
      await rows.first().getByText("Synthetic pending session", { exact: true }).waitFor();
      await queue.screenshot({ path: `${output}/session-queue-ready.png` });
      // Mounted React/Zustand with synthetic IPC; no import command, model or native authority is tested.
      {
        await page.evaluate(async () => {
          if (typeof window.__importAppModule !== "function") throw new Error("Loaded Vite module resolver is required");
          const [{ useVaultStore }, { useImportStore }, { useIngestStore }, { useSettingsStore }] = await Promise.all([
            window.__importAppModule("/src/stores/vaultStore.ts"),
            window.__importAppModule("/src/stores/importStore.ts"),
            window.__importAppModule("/src/stores/ingestStore.ts"),
            window.__importAppModule("/src/stores/settingsStore.ts"),
          ]);
          if (useSettingsStore.getState().settings?.auto_ingest_enabled !== false) throw new Error("Synthetic queue checks require automatic ingest disabled");
          const active = useVaultStore.getState();
          if (active.currentVault?.path !== "/myco" || active.isOpeningVault) throw new Error("Synthetic vault must be ready");
          const fixture = window.__sessionQueueFixture;
          const invoke = window.__TAURI_INTERNALS__.invoke;
          const panel = document.querySelector('[data-testid="session-compile-queue"]');
          const imports = useImportStore.getState();
          const boundary = window.__queueMountedBoundary = {
            invoke, panel, vault: useVaultStore, imports: useImportStore, ingest: useIngestStore,
            savedImport: { stage: imports.stage, imported: imports.imported },
            savedIngest: { stage: useIngestStore.getState().stage },
            commands: [], transitions: [], lists: [], origins: [], holdList: false, holdOrigin: false,
            refreshClicks: 0, view: fixture.view,
          };
          boundary.viewFor = title => ({ pendingTotal: 1, items: [{ ...fixture.view.items[0], title }] });
          boundary.flush = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          boundary.clickListener = event => {
            if (event.target.closest?.("button") === panel.querySelector("button")) boundary.refreshClicks++;
          };
          panel.addEventListener("click", boundary.clickListener);
          window.__TAURI_INTERNALS__.invoke = (command, args) => {
            boundary.commands.push({ command, args });
            if (command === "list_wikify_pending") {
              // Intercepted list calls still belong in the enclosing scaffold's complete trace.
              fixture.trace.push({ command, args });
              if (boundary.holdList) {
                boundary.holdList = false;
                return new Promise((resolve, reject) => boundary.lists.push({ args, resolve, reject, settled: false }));
              }
              return Promise.resolve(boundary.view);
            }
            if (command === "agent_vault_session" && boundary.holdOrigin) {
              boundary.holdOrigin = false;
              // Capture the actual mock opening before delaying delivery to the mounted helper.
              return invoke(command, args).then(origin => new Promise(resolve => boundary.origins.push({ origin, resolve, settled: false })));
            }
            return invoke(command, args);
          };
        });
        const expectQueueSnapshot = async title => {
          await queue.getByText(title, { exact: true }).waitFor();
          assert.equal(await rows.count(), 1, `${title}: fresh observation has exactly one row`);
          assert.equal(await queue.getAttribute("aria-busy"), "false");
          assert.equal(await queue.getByRole("alert").count(), 0);
        };
        const expectQueueLoading = async () => {
          // The transport can register its deferred reply before React commits loading.
          await page.waitForFunction(() => document.querySelector('[data-testid="session-compile-queue"]')?.getAttribute("aria-busy") === "true");
          assert.equal(await refresh.isDisabled(), true);
          assert.equal(await rows.count(), 0);
        };
        try {
          // State-only sweep completion must refresh even when automatic ingestion is disabled.
          // This is deliberately RED until the queue container observes useImportStore.stage.
          await page.evaluate(async () => {
            const boundary = window.__queueMountedBoundary;
            boundary.transitions.push("import:sweeping");
            boundary.imports.setState({ stage: "sweeping" });
            await boundary.flush();
            boundary.view = boundary.viewFor("Synthetic sweep completed");
            boundary.transitions.push("import:done");
            boundary.imports.setState({ stage: "done", imported: 1 });
          });
          await expectQueueSnapshot("Synthetic sweep completed");
          assert.ok((await queue.innerText()).includes("1 unfinished work items · showing 1"));
          assert.equal(await page.evaluate(() => window.__queueMountedBoundary.refreshClicks), 0, "Sweep completion rereads without Refresh");

          for (const { driver, late } of [{ driver: "import", late: "success" }, { driver: "ingest", late: "failure" }]) {
            const heldIndex = await page.evaluate(driver => {
              const boundary = window.__queueMountedBoundary;
              const index = boundary.lists.length;
              boundary.holdList = true;
              boundary.transitions.push(`${driver}:started`);
              (driver === "import" ? boundary.imports : boundary.ingest).setState({ stage: driver === "import" ? "sweeping" : "writing-raw" });
              return index;
            }, driver);
            await page.waitForFunction(index => window.__queueMountedBoundary.lists.length > index, heldIndex);
            await expectQueueLoading();
            const title = `Synthetic current ${driver} ${late}`;
            await page.evaluate(({ driver, title }) => {
              const boundary = window.__queueMountedBoundary;
              boundary.view = boundary.viewFor(title);
              boundary.transitions.push(`${driver}:done`);
              (driver === "import" ? boundary.imports : boundary.ingest).setState({ stage: "done" });
            }, { driver, title });
            await expectQueueSnapshot(title);
            await page.evaluate(async ({ heldIndex, late }) => {
              const boundary = window.__queueMountedBoundary;
              const held = boundary.lists[heldIndex];
              held.settled = true;
              if (late === "success") held.resolve(boundary.viewFor("Synthetic obsolete success"));
              else held.reject(new Error("Synthetic obsolete queue failure"));
              await boundary.flush();
            }, { heldIndex, late });
            await expectQueueSnapshot(title);
            assert.ok(!(await queue.innerText()).includes("Synthetic obsolete"), `${driver}/${late}: actual effect cleanup suppresses the older reply`);
          }

          const reopenIndex = await page.evaluate(() => {
            const boundary = window.__queueMountedBoundary;
            boundary.holdList = true;
            return boundary.lists.length;
          });
          await refresh.click();
          await page.waitForFunction(index => window.__queueMountedBoundary.lists.length > index, reopenIndex);
          await expectQueueLoading();
          const reopen = await page.evaluate(async () => {
            const boundary = window.__queueMountedBoundary;
            const before = boundary.vault.getState();
            const beforeNative = await window.__TAURI_INTERNALS__.invoke("agent_vault_session");
            boundary.view = boundary.viewFor("Synthetic fresh same-path opening");
            // Use the real store action and existing open_vault mock, not direct token assignment.
            await before.openVault("/myco");
            const after = boundary.vault.getState();
            const afterNative = await window.__TAURI_INTERNALS__.invoke("agent_vault_session");
            return { beforePath: before.currentVault?.path, afterPath: after.currentVault?.path,
              beforeUi: before.vaultToken, afterUi: after.vaultToken, beforeNative, afterNative,
              isOpeningVault: after.isOpeningVault, error: after.error };
          });
          assert.equal(reopen.beforePath, "/myco"); assert.equal(reopen.afterPath, "/myco");
          assert.notEqual(reopen.beforeUi, reopen.afterUi, "Real same-path open changes the UI opening");
          assert.notEqual(reopen.beforeNative.openingToken, reopen.afterNative.openingToken, "Existing mock open changes the native opening");
          assert.equal(reopen.isOpeningVault, false); assert.equal(reopen.error, null);
          await expectQueueSnapshot("Synthetic fresh same-path opening");
          const obsoleteOrigin = await page.evaluate(async index => {
            const boundary = window.__queueMountedBoundary;
            const held = boundary.lists[index];
            held.settled = true;
            held.resolve(boundary.viewFor("Synthetic obsolete previous opening"));
            await boundary.flush();
            return held.args.origin;
          }, reopenIndex);
          assert.equal(obsoleteOrigin.openingToken, reopen.beforeNative.openingToken);
          await expectQueueSnapshot("Synthetic fresh same-path opening");

          const originIndex = await page.evaluate(() => {
            const boundary = window.__queueMountedBoundary;
            boundary.holdOrigin = true;
            return boundary.origins.length;
          });
          await refresh.click();
          await page.waitForFunction(index => window.__queueMountedBoundary.origins.length > index, originIndex);
          await expectQueueLoading();
          await page.locator(".side-nav .nav-item").filter({ has: page.locator(".ni-text", { hasText: /^Home$/ }) }).click();
          await page.locator(".home-page").waitFor();
          assert.equal(await page.getByTestId("session-compile-queue").count(), 0, "Navigation unmounts the queue");
          const listCountBeforeLateOrigin = await page.evaluate(async () => {
            const boundary = window.__queueMountedBoundary;
            await boundary.flush();
            return boundary.commands.filter(item => item.command === "list_wikify_pending").length;
          });
          await page.evaluate(async index => {
            const boundary = window.__queueMountedBoundary;
            const held = boundary.origins[index];
            held.settled = true;
            held.resolve(held.origin);
            await boundary.flush();
          }, originIndex);
          const mountedTrace = await page.evaluate(() => {
            const boundary = window.__queueMountedBoundary;
            return { commands: boundary.commands, transitions: boundary.transitions,
              pendingLists: boundary.lists.filter(item => !item.settled).length,
              pendingOrigins: boundary.origins.filter(item => !item.settled).length };
          });
          assert.equal(mountedTrace.commands.filter(item => item.command === "list_wikify_pending").length,
            listCountBeforeLateOrigin, "Late origin after actual unmount cannot launch queue listing");
          assert.equal(mountedTrace.pendingLists, 0); assert.equal(mountedTrace.pendingOrigins, 0);
          assert.ok(!mountedTrace.commands.some(item => /^(session_compile_(begin|step|stop|publish)|wikify_complete_source|cancel_local_synthesis|download_local_chat_model|local_synthesize|chat_complete)$/.test(item.command)),
            "Mounted observation and cleanup dispatch no execution, Stop, cancellation or model requests");
          assert.deepEqual(errors, []);
          await writeFile(`${output}/session-queue-mounted.json`, JSON.stringify({ mockOnly: true, reopen,
            listCountBeforeLateOrigin, ...mountedTrace }, null, 2));
        } finally {
          await page.evaluate(async () => {
            const boundary = window.__queueMountedBoundary;
            window.__TAURI_INTERNALS__.invoke = boundary.invoke;
            boundary.panel.removeEventListener("click", boundary.clickListener);
            // Settle every transport even on RED failure; this is observation cleanup, never native Stop.
            for (const held of boundary.lists) if (!held.settled) { held.settled = true; held.reject(new Error("Synthetic mounted-check cleanup")); }
            for (const held of boundary.origins) if (!held.settled) { held.settled = true; held.resolve(held.origin); }
            boundary.imports.setState(boundary.savedImport);
            boundary.ingest.setState(boundary.savedIngest);
            await boundary.flush();
          });
        }
      }
      const trace = await page.evaluate(() => window.__sessionQueueFixture.trace);
      const reads = trace.filter(item => item.command === "list_wikify_pending");
      assert.ok(reads.length >= 4);
      assert.ok(reads.every(item => item.args.limit === 3 && item.args.expectedVault === item.args.origin.vaultPath && item.args.origin.openingToken));
      assert.ok(!trace.some(item => /^(session_compile_(begin|step|stop|publish)|wikify_complete_source|download_local_chat_model|local_synthesize|cancel_local_synthesis|chat_complete)$/.test(item.command)));
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

} finally {
  await browser.close();
  await writeFile(`${output}/report.json`, JSON.stringify({ mock_only: true, results }, null, 2));
}
process.exitCode = results.some((result) => result.status === "failed") ? 1 : 0;
