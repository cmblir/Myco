import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

// Delayed synthetic IPC writes exercise real controls without a native app or vault.
const base = process.env.MYCO_TEST_URL ?? "http://127.0.0.1:5173";
const output = process.env.MYCO_SCREENSHOTS ?? "/tmp/myco-settings-save";
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext();
context.setDefaultTimeout(90000);
context.setDefaultNavigationTimeout(90000);
const report = [];
try {
  for (const width of [320, 375, 768, 1280]) {
    const page = await context.newPage();
    await page.setViewportSize({ width, height: 900 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
      localStorage.setItem("myco.onboarded", "1");
      localStorage.setItem("myco-ui", JSON.stringify({ version: 3, state: {
        lang: "ko", theme: "dark", route: "settings", settingsTab: "appearance", sidebarCollapsed: true,
      } }));
    });
    await page.goto(`${base}/?mock=1`);
    await page.locator("#settings-choice-appearance").click();
    const tray = page.getByTestId("tray-resident-toggle");
    const notch = page.getByTestId("notch-toggle");
    await tray.waitFor();
    const hit = await tray.boundingBox();
    assert.ok(hit.width >= 44 && hit.height >= 44);
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(await tray.locator(".notch-settings-toggle__thumb").evaluate((el) => getComputedStyle(el).transitionDuration), "0s");
    await tray.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    assert.equal(await tray.evaluate((el) => getComputedStyle(el).outlineStyle), "solid");
    const initialTray = await tray.getAttribute("aria-checked");
    const initialNotch = await notch.getAttribute("aria-checked");
    await page.evaluate(() => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      window.settingsCalls = [];
      window.__TAURI_INTERNALS__.invoke = (command, args) => {
        if (!["set_settings", "update_notch_enabled"].includes(command)) return invoke(command, args);
        window.settingsCalls.push(command);
        return new Promise((resolve, reject) => {
          window.settingsFinish = () => invoke(command, args).then(resolve, reject);
          window.settingsFail = reject;
        });
      };
    });
    await tray.click();
    await page.getByRole("status").filter({ hasText: "변경 사항 저장 중" }).waitFor();
    await notch.click();
    assert.equal(await notch.isDisabled(), true);
    assert.deepEqual(await page.evaluate(() => window.settingsCalls), ["set_settings"]);
    await page.evaluate(() => window.settingsFail(new Error("Synthetic settings write failure")));
    await page.getByRole("alert").filter({ hasText: "이전 값으로 되돌렸어요" }).waitFor();
    assert.equal(await tray.getAttribute("aria-checked"), initialTray);
    assert.notEqual(await notch.getAttribute("aria-checked"), initialNotch);
    assert.deepEqual(await page.evaluate(() => window.settingsCalls), ["set_settings", "update_notch_enabled"]);
    await page.evaluate(() => window.settingsFinish());
    await page.waitForFunction(() => !document.querySelector('[data-testid="notch-toggle"]').disabled);
    await page.screenshot({ path: `${output}/error-${width}.png`, fullPage: true });
    await tray.click();
    await page.evaluate(() => window.settingsFinish());
    await page.getByRole("status").filter({ hasText: "변경 사항 저장됨" }).waitFor();
    assert.equal(await page.getByRole("alert").filter({ hasText: "Synthetic settings write failure" }).count(), 0);
    const disk = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("get_settings"));
    assert.equal(String(disk.tray_resident), await tray.getAttribute("aria-checked"));
    assert.equal(String(disk.notch_enabled), await notch.getAttribute("aria-checked"));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `${output}/saved-${width}.png`, fullPage: true });
    report.push({ width, checks: 15, errors });
    await page.close();
  }

  const providers = await context.newPage();
  await providers.setViewportSize({ width: 1280, height: 900 });
  await providers.addInitScript(() => localStorage.setItem("myco-ui", JSON.stringify({ version: 3, state: {
    lang: "ko", route: "settings", settingsTab: "providers", sidebarCollapsed: true,
  } })));
  await providers.goto(`${base}/?mock=1`);
  // Settings tabs are session-only; the persisted providers tab is ignored.
  await providers.locator(".settings-navigation__advanced > summary").click();
  await providers.locator("#settings-choice-providers").click();
  const providerRow = providers.locator('[data-srow="provider_anthropic-cli"]');
  const disconnect = providerRow.getByRole("switch");
  await disconnect.waitFor();
  assert.equal(await disconnect.getAttribute("aria-checked"), "true");
  await providers.evaluate(() => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.providerSettings = null;
    window.__TAURI_INTERNALS__.invoke = (command, args) => {
      const result = invoke(command, args);
      if (command !== "set_settings") return result;
      return result.then((value) => {
        window.providerSettings = args.value;
        return value;
      });
    };
  });
  await disconnect.click();
  await providerRow.locator('[role="switch"][aria-checked="false"][aria-busy="false"]').waitFor();
  await providers.waitForFunction(() => {
    const settings = window.providerSettings;
    if (!settings) return false;
    return settings.query_provider === "builtin-local" && settings.ingest_provider === "builtin-local";
  });
  const settings = await providers.evaluate(() => window.__TAURI_INTERNALS__.invoke("get_settings"));
  assert.equal(settings.providers.anthropic_cli, false);
  assert.equal(settings.query_model, "extractive-retrieval");
  assert.equal(settings.ingest_model, "extractive-ingest");
  assert.equal(settings.query_effort, "(default)");
  assert.equal(settings.ingest_effort, "(default)");
  report.push({ scenario: "disconnect-selected-provider", checks: 6 });
  await providers.close();

  const regressionFailures = [];
  async function providerScenario(name, run) {
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.stack ?? error.message));
    try {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.addInitScript(() => {
        performance.setResourceTimingBufferSize(5000);
        localStorage.setItem("myco-ui", JSON.stringify({ version: 3, state: {
          lang: "ko", route: "settings", sidebarCollapsed: true,
        } }));
      });
      await page.goto(`${base}/?mock=1`);
      await page.locator(".settings-navigation__advanced > summary").click();
      await run(page);
      assert.deepEqual(errors, []);
      report.push({ scenario: name, errors });
    } catch (error) {
      regressionFailures.push(error);
      report.push({ scenario: name, error: error.stack ?? String(error), errors });
    } finally {
      await page.close();
    }
  }

  await providerScenario("api-disconnect-persist-failure-keeps-key-and-retries", async page => {
    await page.evaluate(async () => {
      const resource = performance.getEntriesByType("resource")
        .filter(entry => new URL(entry.name).pathname === "/src/stores/settingsStore.ts").at(-1);
      if (!resource) throw new Error("Mounted settings store module not found");
      const { useSettingsStore } = await import(resource.name);
      const { selectedRolesFixture } = await import("/src/lib/modelRoles.testSupport.ts");
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const initial = await invoke("get_settings");
      const roles = selectedRolesFixture({ reflect: {
        providerId: "openai-api", modelId: "synthetic-retained-model", effort: "(default)",
      } });
      roles.roles.reflect.automaticExternalAllowed = true;
      await invoke("set_settings", { value: {
        ...initial, providers: { ...initial.providers, openai_api: true },
        query_provider: "openai-api", query_model: "synthetic-retained-query",
        model_roles: roles, role_authorization_revision: "a".repeat(64),
      } });
      await useSettingsStore.getState().load();
      const fixture = window.providerApiDisconnect = {
        before: structuredClone(useSettingsStore.getState().settings),
        keyPresent: true, deleteFailure: false, holdWrites: true, requests: [], commands: [], external: [],
      };
      window.__TAURI_INTERNALS__.invoke = (command, args) => {
        if (["capture_model_role", "select_model_role", "set_role_automatic_use", "chat_complete",
          "claude_run", "agent_run", "myco_pro_ingest", "list_provider_models"].includes(command)) {
          fixture.external.push(command);
          return Promise.reject(new Error("Unexpected model operation in connection test"));
        }
        if (command === "delete_provider_key") {
          fixture.commands.push(command);
          assertProviderId(args.providerId);
          if (fixture.deleteFailure) return Promise.reject(new Error("Synthetic provider key deletion failure"));
          fixture.keyPresent = false;
          return Promise.resolve(null);
        }
        if (command === "set_settings") {
          fixture.commands.push(command);
          if (fixture.holdWrites) return new Promise((resolve, reject) => fixture.requests.push({
            reject, finish: () => invoke(command, args).then(resolve, reject),
          }));
        }
        return invoke(command, args);
      };
      function assertProviderId(id) {
        if (id !== "openai-api") throw new Error("Unexpected provider key deletion");
      }
    });
    await page.locator("#settings-choice-providers").click();
    const row = page.locator('[data-srow="provider_openai-api"]');
    const toggle = row.getByRole("switch");
    await row.locator('[role="switch"][aria-checked="true"]').waitFor();
    await toggle.click();
    await page.waitForFunction(() => window.providerApiDisconnect.requests.length === 1);
    assert.equal(await toggle.isDisabled(), true);
    assert.deepEqual(await page.evaluate(() => window.providerApiDisconnect.commands), ["set_settings"]);
    assert.equal(await page.evaluate(() => window.providerApiDisconnect.keyPresent), true);
    await page.evaluate(() => window.providerApiDisconnect.requests[0].reject(new Error("Synthetic provider flag write failure")));
    await row.locator('[role="switch"][aria-checked="true"][aria-busy="false"]').waitFor();
    await page.locator(".settings-save--error").filter({ hasText: "Synthetic provider flag write failure" }).waitFor();
    const failed = await page.evaluate(async () => ({
      fixture: { ...window.providerApiDisconnect, requests: undefined },
      after: await window.__TAURI_INTERNALS__.invoke("get_settings"),
    }));
    assert.equal(failed.fixture.keyPresent, true);
    assert.deepEqual(failed.fixture.commands, ["set_settings"]);
    assert.deepEqual(failed.after.model_roles, failed.fixture.before.model_roles);
    assert.equal(failed.after.query_model, "synthetic-retained-query");
    await toggle.click();
    await page.waitForFunction(() => window.providerApiDisconnect.requests.length === 2);
    await page.evaluate(() => {
      window.providerApiDisconnect.holdWrites = false;
      window.providerApiDisconnect.requests[1].finish();
    });
    await row.locator('[role="switch"][aria-checked="false"][aria-busy="false"]').waitFor();
    const saved = await page.evaluate(async () => ({
      fixture: { ...window.providerApiDisconnect, requests: undefined },
      after: await window.__TAURI_INTERNALS__.invoke("get_settings"),
    }));
    assert.equal(saved.fixture.keyPresent, false);
    assert.deepEqual(saved.fixture.commands.slice(0, 3), ["set_settings", "set_settings", "delete_provider_key"]);
    assert.equal(saved.after.providers.openai_api, false);
    assert.equal(saved.after.query_provider, "builtin-local");
    assert.deepEqual(saved.after.model_roles, saved.fixture.before.model_roles);
    assert.equal(saved.after.role_authorization_revision, saved.fixture.before.role_authorization_revision);
    assert.deepEqual(saved.fixture.external, []);
    assert.equal(await page.locator(".settings-save--error").count(), 0);

    // The later keychain failure keeps the provider disabled and can retry
    // deletion from its row after every transient warning has been dismissed.
    await page.evaluate(async () => {
      const resource = performance.getEntriesByType("resource")
        .filter(entry => new URL(entry.name).pathname === "/src/stores/settingsStore.ts").at(-1);
      const { useSettingsStore } = await import(resource.name);
      const fixture = window.providerApiDisconnect;
      await window.__TAURI_INTERNALS__.invoke("set_settings", { value: fixture.before });
      await useSettingsStore.getState().load();
      fixture.keyPresent = true;
      fixture.deleteFailure = true;
      fixture.commands = [];
    });
    await row.locator('[role="switch"][aria-checked="true"]').waitFor();
    await toggle.click();
    await row.locator('[role="switch"][aria-checked="false"][aria-busy="false"]').waitFor();
    const retryDelete = row.getByRole("alert").filter({ hasText: "Synthetic provider key deletion failure" })
      .getByRole("button", { name: "해제", exact: true });
    await retryDelete.waitFor();
    while (await page.locator(".notice:not(.is-out) .notice-close").count()) {
      await page.locator(".notice:not(.is-out) .notice-close").first().click();
    }
    await page.waitForFunction(() => document.querySelectorAll(".notice-stack .notice").length === 0);
    await page.setViewportSize({ width: 320, height: 900 });
    assert.equal(await retryDelete.isVisible(), true);
    assert.equal(await retryDelete.isEnabled(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await row.screenshot({ path: `${output}/provider-disconnect-error-320.png` });
    const retryHit = await retryDelete.boundingBox();
    assert.ok(retryHit.width >= 44 && retryHit.height >= 44);
    assert.equal(await page.evaluate(() => window.providerApiDisconnect.keyPresent), true);
    const disabled = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("get_settings"));
    assert.equal(disabled.providers.openai_api, false);
    await page.evaluate(() => { window.providerApiDisconnect.deleteFailure = false; });
    await retryDelete.focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => !window.providerApiDisconnect.keyPresent);
    await row.locator('[role="switch"][aria-checked="false"][aria-busy="false"]').waitFor();
    const recovered = await page.evaluate(async () => ({
      commands: window.providerApiDisconnect.commands, external: window.providerApiDisconnect.external,
      after: await window.__TAURI_INTERNALS__.invoke("get_settings"), before: window.providerApiDisconnect.before,
    }));
    assert.deepEqual(recovered.commands.slice(0, 4), ["set_settings", "delete_provider_key", "set_settings", "delete_provider_key"]);
    assert.equal(recovered.after.providers.openai_api, false);
    assert.deepEqual(recovered.after.model_roles, recovered.before.model_roles);
    assert.equal(recovered.after.role_authorization_revision, recovered.before.role_authorization_revision);
    assert.deepEqual(recovered.external, []);
    assert.equal(await row.getByRole("alert").count(), 0);
  });

  await providerScenario("ollama-status-failure-retry", async page => {
    await page.evaluate(() => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const status = {
        binary_installed: false, binary_path: null, version: null,
        daemon_running: false, endpoint: "http://localhost:11434", models: [], error: null,
      };
      window.providerOllamaRequests = [];
      window.providerOllamaReady = false;
      window.providerOllamaStatus = status;
      window.__TAURI_INTERNALS__.invoke = (command, args) => {
        if (command !== "ollama_status") return invoke(command, args);
        // Successful refresh may also trigger syncOllama; do not count it as a retry.
        if (window.providerOllamaReady) return Promise.resolve(structuredClone(status));
        return new Promise((resolve, reject) => window.providerOllamaRequests.push({ resolve, reject }));
      };
    });
    await page.locator("#settings-choice-providers").click();
    const row = page.locator('[data-srow="provider_ollama"]');
    await row.getByText("Ollama 확인 중…", { exact: true }).waitFor();
    await page.waitForFunction(() => window.providerOllamaRequests.length > 0);
    await page.evaluate(() => window.providerOllamaRequests.at(-1).reject(new Error("Synthetic Ollama status failure")));
    await row.getByRole("alert").filter({ hasText: "Synthetic Ollama status failure" }).waitFor({ timeout: 5000 });
    const retry = row.getByRole("button", { name: "다시 확인", exact: true });
    assert.equal(await retry.isEnabled(), true);
    const beforeRetry = await page.evaluate(() => window.providerOllamaRequests.length);
    await retry.click();
    await page.waitForFunction(previous => window.providerOllamaRequests.length > previous, beforeRetry);
    assert.equal(await retry.isDisabled(), true);
    await row.getByText("Ollama 확인 중…", { exact: true }).waitFor();
    await page.evaluate(() => {
      window.providerOllamaReady = true;
      window.providerOllamaRequests.at(-1).resolve(structuredClone(window.providerOllamaStatus));
    });
    await row.getByText("Ollama가 설치되어 있지 않습니다", { exact: true }).waitFor();
    assert.equal(await row.getByRole("alert").count(), 0);
    assert.equal(await row.getByText("Ollama 확인 중…", { exact: true }).count(), 0);
  });

  await providerScenario("disconnected-looking-cli-rechecks-installation", async page => {
    await page.evaluate(async () => {
      const resource = performance.getEntriesByType("resource")
        .filter(entry => new URL(entry.name).pathname === "/src/stores/settingsStore.ts").at(-1);
      if (!resource) throw new Error("Mounted settings store module not found");
      const { useSettingsStore } = await import(resource.name);
      const { selectedRolesFixture } = await import("/src/lib/modelRoles.testSupport.ts");
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const initial = await invoke("get_settings");
      const roles = selectedRolesFixture({ reflect: {
        providerId: "codex-cli", modelId: "synthetic-retained-model", effort: "(default)",
      } });
      roles.roles.reflect.automaticExternalAllowed = true;
      await invoke("set_settings", { value: {
        ...initial, model_roles: roles, role_authorization_revision: "a".repeat(64),
        providers: { ...initial.providers, anthropic_cli: true },
      } });
      await useSettingsStore.getState().load();
      window.providerCliBefore = structuredClone(useSettingsStore.getState().settings);
      window.providerCliInstalled = false;
      window.providerCliRequests = [];
      window.providerCliWrites = [];
      window.providerRoleCommands = [];
      window.__TAURI_INTERNALS__.invoke = (command, args) => {
        if (command === "claude_check") {
          if (!window.providerCliInstalled) return Promise.resolve({ installed: false, version: null, path: null });
          return new Promise((resolve, reject) => window.providerCliRequests.push({ resolve, reject }));
        }
        if (command === "set_settings") window.providerCliWrites.push(structuredClone(args.value));
        if (["select_model_role", "set_role_automatic_use"].includes(command)) window.providerRoleCommands.push(command);
        return invoke(command, args);
      };
    });
    const retainedRole = await page.evaluate(() => window.providerCliBefore.model_roles?.roles?.reflect);
    assert.equal(retainedRole?.providerId, "codex-cli");
    assert.equal(retainedRole?.modelId, "synthetic-retained-model");
    assert.equal(retainedRole?.automaticExternalAllowed, true);
    await page.locator("#settings-choice-providers").click();
    const row = page.locator('[data-srow="provider_anthropic-cli"]');
    const toggle = row.getByRole("switch");
    await row.locator('[role="switch"][aria-checked="false"]').waitFor();
    await row.getByText("CLI 설치 안 됨", { exact: false }).waitFor();
    assert.equal(await page.evaluate(() => window.providerCliBefore.providers.anthropic_cli), true);
    await page.evaluate(() => { window.providerCliInstalled = true; });
    await toggle.click();
    assert.ok(await page.evaluate(() => window.providerCliRequests.length > 0), "Turning on a disconnected-looking CLI must recheck installation");
    assert.equal(await toggle.isDisabled(), true);
    assert.equal(await toggle.getAttribute("aria-busy"), "true");
    assert.equal(await page.evaluate(() => window.providerCliWrites.some(value => value.providers.anthropic_cli === false)), false);
    await page.evaluate(() => window.providerCliRequests.at(-1).resolve({
      installed: true, version: "synthetic-cli 1.0.0", path: "/synthetic/claude",
    }));
    await row.locator('[role="switch"][aria-checked="true"][aria-busy="false"]').waitFor();
    assert.equal(await toggle.isEnabled(), true);
    assert.equal(await row.getByText("CLI 설치 안 됨", { exact: false }).count(), 0);
    const unchanged = await page.evaluate(async () => ({
      before: window.providerCliBefore,
      after: await window.__TAURI_INTERNALS__.invoke("get_settings"),
      roleCommands: window.providerRoleCommands,
      disconnected: window.providerCliWrites.some(value => value.providers.anthropic_cli === false),
    }));
    assert.equal(unchanged.after.providers.anthropic_cli, true);
    assert.equal(unchanged.disconnected, false);
    assert.deepEqual(unchanged.after.model_roles, unchanged.before.model_roles);
    assert.deepEqual(unchanged.roleCommands, []);
    assert.deepEqual(
      [unchanged.after.query_provider, unchanged.after.query_model, unchanged.after.ingest_provider, unchanged.after.ingest_model],
      [unchanged.before.query_provider, unchanged.before.query_model, unchanged.before.ingest_provider, unchanged.before.ingest_model],
    );
  });

  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (regressionFailures.length) throw new AggregateError(regressionFailures, "Provider connection regressions failed");
} finally {
  await browser.close();
}
