// Mounted React model settings with synthetic IPC only. No native grants or inference.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";

const base = new URL(process.env.MYCO_TEST_URL ?? "http://127.0.0.1:5173");
const loopback = ["localhost", "127.0.0.1", "[::1]"];
assert.ok(loopback.includes(base.hostname), "Model selection smoke requires loopback Vite");
const output = process.env.MYCO_MODEL_TEST_OUTPUT;
if (output) await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const results = [];
let checks = 0;
const check = (value, label) => { assert.ok(value, label); checks++; console.log(`PASS ${label}`); };
async function settleUI(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function fixture(width, provider = "openai-api") {
  const context = await browser.newContext({ viewport: { width, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  const blocked = [];
  page.on("pageerror", error => errors.push(error.stack ?? error.message));
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (!["http:", "https:"].includes(url.protocol) || loopback.includes(url.hostname)) return route.continue();
    blocked.push({ origin: url.origin, pathname: url.pathname });
    return route.abort("blockedbyclient");
  });
  await page.addInitScript(() => {
    performance.setResourceTimingBufferSize(5000);
    const modules = new Map();
    window.__importAppModule = path => {
      if (modules.has(path)) return modules.get(path);
      const resource = performance.getEntriesByType("resource")
        .filter(entry => new URL(entry.name).pathname === path).at(-1);
      if (!resource) throw new Error(`Mounted module not found: ${path}`);
      const loaded = import(resource.name);
      modules.set(path, loaded);
      return loaded;
    };
    localStorage.setItem("myco.onboarded", "1");
    localStorage.setItem("myco-ui", JSON.stringify({ version: 3, state: {
      lang: "en", theme: "light", sidebarCollapsed: false,
    } }));
  });
  const url = new URL(base);
  url.search = "?mock=1&local=1&nowriter=1";
  await page.goto(url.toString());
  await page.locator(".home-page").waitFor();
  await page.evaluate(async selectedProvider => {
    const { useSettingsStore } = await window.__importAppModule("/src/stores/settingsStore.ts");
    const { useUIStore } = await window.__importAppModule("/src/stores/uiStore.ts");
    const { selectedRolesFixture } = await import("/src/lib/modelRoles.testSupport.ts");
    const invoke = window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__);
    const initial = await invoke("get_settings");
    const roles = selectedRolesFixture({ reflect: {
      providerId: selectedProvider, modelId: "synthetic-existing-model", effort: "(default)",
    } });
    roles.roles.reflect.automaticExternalAllowed = true;
    let persisted = { ...initial, model_roles: roles, role_authorization_revision: "a".repeat(64),
      providers: { ...initial.providers, builtin_local: true, openai_api: true, anthropic_api: true,
        anthropic_cli: false, codex_cli: false, gemini_cli: false, google_api: false, openrouter: true, ollama: false },
      auto_import: false, auto_ingest: false, auto_reflect: false };
    const selections = [];
    const catalogs = [];
    const controls = [];
    const state = { selections, catalogs, controls, holdSelections: false, persisted: () => structuredClone(persisted),
      settingsStore: useSettingsStore, initialRoles: structuredClone(roles.roles) };
    const saveSelection = request => {
      if (request.expectedAuthorizationRevision !== persisted.role_authorization_revision)
        throw new Error("Synthetic role revision changed; reload before selecting");
      const current = persisted.model_roles.roles[request.role];
      const roles = { ...persisted.model_roles.roles, [request.role]: { ...current,
        providerId: request.providerId, modelId: request.modelId, effort: request.effort,
        selection: request.providerId === "builtin-local" ? "explicit-local" : "explicit-external",
        automaticExternalAllowed: false } };
      persisted = { ...persisted, model_roles: { ...persisted.model_roles, roles },
        role_authorization_revision: persisted.role_authorization_revision === "a".repeat(64) ? "b".repeat(64) : "c".repeat(64) };
      return structuredClone(persisted);
    };
    window.__TAURI_INTERNALS__.invoke = (command, args) => {
      if (command === "get_settings") return Promise.resolve(structuredClone(persisted));
      if (command === "ollama_status") return Promise.resolve({ daemon_running: false, models: [] });
      if (command === "select_model_role") {
        const request = structuredClone(args.request);
        selections.push(request);
        if (!state.holdSelections) return Promise.resolve().then(() => saveSelection(request));
        return new Promise((resolve, reject) => controls.push({
          accept: () => { try { resolve(saveSelection(request)); } catch (error) { reject(error); } },
          reject: () => reject(new Error("Synthetic selection failure")),
        }));
      }
      if (command === "list_provider_models") return new Promise((resolve, reject) => catalogs.push({
        provider: args.providerId, resolve, reject,
      }));
      return invoke(command, args);
    };
    window.__modelFixture = state;
    useSettingsStore.setState({ settings: structuredClone(persisted), loading: false, saving: false,
      saved: false, error: null });
    useUIStore.getState().setSettingsTab("model");
    useUIStore.getState().setRoute("settings");
  }, provider);
  // Phone Settings hides the detail until its advanced section is opened.
  const row = page.locator('[data-srow="model_reflect"]');
  await row.waitFor({ state: "attached" });
  const modelChoice = page.locator("#settings-choice-model");
  if (!await row.isVisible()) {
    if (!await modelChoice.isVisible()) {
      const disclosure = page.locator(".settings-navigation__advanced summary");
      assert.equal(await disclosure.count(), 1, "One advanced settings disclosure");
      await disclosure.click();
    }
    await modelChoice.click();
  }
  await row.waitFor();
  await settleUI(page);
  return { context, page, row, errors, blocked };
}

async function scenario(name, run, width = 1280, provider) {
  let f;
  try {
    f = await fixture(width, provider);
    const before = checks;
    await run(f);
    check(f.errors.length === 0, `${name}: no page errors`);
    check(f.blocked.length === 0, `${name}: no external HTTP attempted`);
    results.push({ name, passed: true, checks: checks - before });
  } catch (error) {
    const record = { name, passed: false, error: error.stack ?? String(error),
      pageErrors: f?.errors ?? [], blocked: f?.blocked ?? [] };
    if (f) {
      record.row = await f.row.ariaSnapshot();
      record.state = await f.page.evaluate(() => ({
        selections: window.__modelFixture.selections,
        pendingCatalogs: window.__modelFixture.catalogs.map(entry => entry.provider),
        saving: window.__modelFixture.settingsStore.getState().saving,
      }));
      if (output) await f.row.screenshot({ path: join(output, `${name}-failed.png`) });
    }
    results.push(record);
    console.error(`FAIL ${name}: ${error.message}`);
  } finally {
    if (f) await f.context.close();
  }
}

try {
  for (const width of [375, 768, 1280]) await scenario(`custom-${width}`, async ({ page, row }) => {
    const input = row.getByPlaceholder("model id", { exact: true });
    check(await input.count() === 1, `${width}: custom input is unique`);
    await page.evaluate(() => { window.__modelFixture.holdSelections = true; });
    await input.press("ControlOrMeta+A");
    await input.pressSequentially("synthetic-new-model", { delay: 5 });
    const typing = await page.evaluate(() => window.__modelFixture.selections.length);
    check(typing === 0 && await input.inputValue() === "synthetic-new-model",
      `${width}: typing preserves the full draft without persistence (actual requests ${typing})`);
    await page.evaluate(() => window.__modelFixture.catalogs.at(-1).resolve(["synthetic-existing-model", "synthetic-catalog-model"]));
    await settleUI(page);
    check(await input.inputValue() === "synthetic-new-model", `${width}: catalog arrival preserves custom draft`);
    const apply = row.getByRole("button", { name: "Apply model", exact: true });
    check(await apply.count() === 1 && await apply.isEnabled(), `${width}: explicit apply available`);
    if (output) await row.screenshot({ path: join(output, `custom-${width}-draft.png`) });
    // Keyboard submission and click retry exercise the same explicit commit.
    await input.press("Enter");
    const pending = await page.evaluate(() => ({ calls: window.__modelFixture.selections,
      persisted: window.__modelFixture.persisted(), saving: window.__modelFixture.settingsStore.getState().saving }));
    check(pending.calls.length === 1 && pending.calls[0].modelId === "synthetic-new-model" &&
      pending.calls[0].expectedAuthorizationRevision === "a".repeat(64) && pending.calls[0].role === "reflect",
      `${width}: one full-string request bound to observed role revision`);
    check(pending.saving && pending.persisted.model_roles.roles.reflect.modelId === "synthetic-existing-model" &&
      !await input.isEnabled() && !await apply.isEnabled(), `${width}: held save preserves persisted choice and disables edits`);
    await page.evaluate(() => window.__modelFixture.controls[0].reject());
    await page.getByRole("alert").filter({ hasText: /^Synthetic selection failure$/ }).waitFor();
    check(await input.inputValue() === "synthetic-new-model" && await apply.isEnabled(), `${width}: failed save keeps retryable draft`);
    await apply.click();
    await page.evaluate(() => window.__modelFixture.controls[1].accept());
    await page.waitForFunction(() => !window.__modelFixture.settingsStore.getState().saving);
    const saved = await page.evaluate(() => ({ calls: window.__modelFixture.selections,
      settings: window.__modelFixture.settingsStore.getState().settings, initialRoles: window.__modelFixture.initialRoles }));
    check(saved.calls.length === 2 && saved.calls.every(call => call.expectedAuthorizationRevision === "a".repeat(64)),
      `${width}: failed commit retry retains current observed revision`);
    check(saved.settings.model_roles.roles.reflect.modelId === "synthetic-new-model" &&
      saved.settings.model_roles.roles.reflect.automaticExternalAllowed === false, `${width}: successful selection resets automatic permission`);
    for (const [role, choice] of Object.entries(saved.initialRoles)) if (role !== "reflect")
      assert.deepEqual(saved.settings.model_roles.roles[role], choice);
    check(true, `${width}: all other role selections unchanged`);
    check(!await apply.isEnabled(), `${width}: unchanged saved draft cannot be reapplied`);
  }, width);

  for (const outcome of ["success", "error"]) await scenario(`catalog-static-${outcome}`, async ({ page, row }) => {
    const selects = row.locator(".model-select__row select");
    check(await selects.count() === 2, `${outcome}: provider/model controls identified`);
    await selects.nth(0).selectOption("anthropic-api");
    await page.waitForFunction(() => !window.__modelFixture.settingsStore.getState().saving);
    await settleUI(page);
    const loadingAfterSwitch = await row.getByText("fetching model list…", { exact: true }).count();
    await page.evaluate(result => {
      for (const old of window.__modelFixture.catalogs.filter(entry => entry.provider === "openai-api")) {
        if (result === "success") old.resolve(["SYNTHETIC-OLD-CATALOG"]);
        else old.reject(new Error("SYNTHETIC-OLD-CATALOG-ERROR"));
      }
    }, outcome);
    await settleUI(page);
    const state = await selects.nth(1).locator("option").allTextContents();
    check(state.includes("claude-sonnet-4-6") && !state.includes("SYNTHETIC-OLD-CATALOG"), `${outcome}: stale result cannot replace current catalog`);
    check(await row.getByText("Error: SYNTHETIC-OLD-CATALOG-ERROR", { exact: true }).count() === 0,
      `${outcome}: stale failure is not current-provider error`);
    check(loadingAfterSwitch === 0, `${outcome}: switching to static provider clears old fetching state`);
    check(await page.evaluate(() => window.__modelFixture.selections.length) === 1, `${outcome}: catalog settlement never selects a model`);
  });

  await scenario("catalog-live-switch", async ({ page, row }) => {
    const selects = row.locator(".model-select__row select");
    check(await selects.count() === 2, "live switch: provider/model controls identified");
    await selects.nth(0).selectOption("openrouter");
    await page.waitForFunction(() => window.__modelFixture.catalogs.some(entry => entry.provider === "openrouter"));
    await page.evaluate(() => window.__modelFixture.catalogs.filter(entry => entry.provider === "openai-api")
      .forEach(entry => entry.resolve(["SYNTHETIC-OLD-CATALOG"])));
    await settleUI(page);
    check(await row.getByText("fetching model list…", { exact: true }).count() === 1,
      "live switch: old settlement cannot clear newer pending loading");
    check(!(await selects.nth(1).locator("option").allTextContents()).includes("SYNTHETIC-OLD-CATALOG"),
      "live switch: old catalog not adopted");
    await page.evaluate(() => window.__modelFixture.catalogs.find(entry => entry.provider === "openrouter").resolve(["SYNTHETIC-NEW-CATALOG"]));
    await settleUI(page);
    check((await selects.nth(1).locator("option").allTextContents()).includes("SYNTHETIC-NEW-CATALOG") &&
      await row.getByText("fetching model list…", { exact: true }).count() === 0, "live switch: only current catalog settles loading");
  });
} finally {
  await browser.close();
  const report = { scope: "Real Chromium/React, synthetic settings transport; no native authorization, model, installed or egress acceptance",
    checks, results, failed: results.filter(result => !result.passed).length };
  if (output) await writeFile(join(output, "result.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  if (report.failed) process.exitCode = 1;
}
