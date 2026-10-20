// Actual Reader/CodeMirror/dialog UI against synthetic browser IPC only.
// Start Vite, then run this script. No native vault, inference or OS clipboard.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";

const base = new URL(process.env.MYCO_TEST_URL ?? "http://127.0.0.1:5173");
const loopback = ["localhost", "127.0.0.1", "[::1]"];
assert.ok(loopback.includes(base.hostname), "Editor recovery smoke requires loopback Vite");
const original = "---\ntitle: Synthetic recovery\n---\n\n# Synthetic recovery\n\nOriginal A.\n";
const draft = "---\ntitle: Synthetic recovery\n---\n\n# Synthetic recovery\n\nUnsaved draft A.\n";
const external = "---\ntitle: Synthetic recovery\n---\n\n# Synthetic recovery\n\nExternal edit B.\n";
const newer = "---\ntitle: Synthetic recovery\n---\n\n# Synthetic recovery\n\nNewer draft C.\n";
const other = "# Other synthetic recovery note\n\nOther note stays current.\n";
const labels = {
  copy: "초안 복사", reload: "초안을 버리고 다시 읽기", cancel: "취소",
  title: "초안을 버리고 파일을 다시 읽을까요?", loading: "다시 읽는 중…",
  adopted: "최신 파일을 다시 읽었습니다. 복사한 초안에서 필요한 내용을 직접 붙여넣어 병합하세요.",
  copied: "초안을 복사했습니다", copyFailed: "초안을 복사하지 못했습니다",
  baselineCopy: "편집을 시작한 원문 복사", baseline: "편집을 시작한 원문",
  recoveryDraft: "복구할 로컬 초안", retryRead: "파일 다시 읽기",
};
const sha = (raw) => createHash("sha256").update(raw).digest("hex");
const screenshotDir = process.env.MYCO_EDITOR_SCREENSHOT_DIR;
if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
const browser = await chromium.launch();
let checks = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks++;
  console.log(`PASS ${message}`);
};

// Playwright's installed waitForFunction polls Promise truthiness, not its result.
// This deadline bounds only browser QA; it does not change any product timeout.
async function waitForAsyncPredicate(page, predicate, arg, label) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    let timer;
    const remaining = deadline - Date.now();
    const result = await Promise.race([
      page.evaluate(predicate, arg),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Browser QA predicate timed out: ${label}`)), remaining);
      }),
    ]).finally(() => clearTimeout(timer));
    if (result === true) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))));
  }
  throw new Error(`Browser QA predicate timed out: ${label}`);
}

async function fixture(width = 1280) {
  const context = await browser.newContext({ viewport: { width, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  const consoleEvents = [];
  const blocked = [];
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  page.on("console", (entry) => {
    if (consoleEvents.length < 40) consoleEvents.push({ type: entry.type(), text: entry.text().slice(0, 500) });
  });
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (!["http:", "https:"].includes(url.protocol) || loopback.includes(url.hostname)) return route.continue();
    blocked.push({ origin: url.origin, pathname: url.pathname });
    return route.abort("blockedbyclient");
  });
  await page.addInitScript(() => {
    performance.setResourceTimingBufferSize(5000);
    // Observe the installed synthetic invoke before React boot without changing
    // its arguments, return value, settlement or native opening authority.
    const bootCalls = [];
    let callId = 0;
    let droppedCalls = 0;
    const recordCall = (entry) => {
      if (bootCalls.length < 160) bootCalls.push({ ...entry, ms: Math.round(performance.now()) });
      else droppedCalls++;
    };
    let internals = window.__TAURI_INTERNALS__;
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      get: () => internals,
      set(value) {
        internals = value;
        if (!value || typeof value.invoke !== "function") return;
        const invoke = value.invoke;
        value.invoke = function (...args) {
          const id = ++callId;
          const command = typeof args[0] === "string" ? args[0] : "<non-string command>";
          recordCall({ id, command, phase: "started" });
          let result;
          try {
            result = Reflect.apply(invoke, this, args);
          } catch (error) {
            recordCall({ id, command, phase: "rejected-sync", errorType: error?.name ?? typeof error });
            throw error;
          }
          void Promise.resolve(result).then(
            (settled) => recordCall({ id, command, phase: "settled",
              resultType: settled === null ? "null" : Array.isArray(settled) ? "array" : typeof settled }),
            (error) => recordCall({ id, command, phase: "rejected", errorType: error?.name ?? typeof error }),
          );
          return result;
        };
      },
    });
    // Keep one mounted module identity throughout readiness and every fixture action.
    // A later resource lookup must not select another HMR store instance.
    const modules = new Map();
    const moduleUrls = {};
    window.__recoveryRealm = Math.random().toString(36);
    window.__importAppModule = (path) => {
      if (modules.has(path)) return modules.get(path);
      const resource = performance.getEntriesByType("resource")
        .filter((entry) => new URL(entry.name).pathname === path).at(-1);
      if (!resource) throw new Error(`Mounted module not found: ${path}`);
      const loaded = import(resource.name);
      modules.set(path, loaded);
      moduleUrls[path] = resource.name;
      return loaded;
    };
    window.__recoveryDiagnostic = async () => {
      const ready = window.__recoveryReadinessStore?.getState();
      let origin;
      let timer;
      try {
        origin = await Promise.race([
          window.__TAURI_INTERNALS__?.invoke("agent_vault_session"),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("Synthetic opening diagnostic timed out")), 1000);
          }),
        ]);
      } catch (error) {
        origin = { error: String(error) };
      } finally {
        clearTimeout(timer);
      }
      const paths = ["/src/stores/vaultStore.ts", "/src/stores/uiStore.ts", "/src/lib/devMock.ts"];
      return {
        realm: window.__recoveryRealm,
        ready: ready ? { root: ready.currentVault?.path ?? null, token: ready.vaultToken,
          loading: ready.isLoading, opening: ready.isOpeningVault } : null,
        mock: Boolean(window.__mycoMock), origin: origin ?? null,
        selectedModuleUrls: { ...moduleUrls }, cachedModulePaths: [...modules.keys()],
        observedModuleUrls: Object.fromEntries(paths.map((path) => [path,
          performance.getEntriesByType("resource")
            .filter((entry) => new URL(entry.name).pathname === path).slice(-3).map((entry) => entry.name)])),
        readiness: window.__recoveryReadiness ?? null,
        beforeUIImport: window.__recoveryBeforeUIImport ?? null,
        afterUIImport: window.__recoveryAfterUIImport ?? null,
        bootCalls: [...bootCalls], droppedCalls,
      };
    };
    localStorage.setItem("myco.onboarded", "1");
    localStorage.setItem("myco-ui", JSON.stringify({ version: 3, state: {
      lang: "ko", theme: "dark", editorMode: "source", sidebarCollapsed: true,
    } }));
  });
  const url = new URL(base);
  url.search = "?mock=1&local=1&nowriter=1";
  await page.goto(url.toString());
  await page.locator(".home-page").waitFor();
  try {
    await waitForAsyncPredicate(page, async () => {
      if (!window.__mycoMock || !window.__TAURI_INTERNALS__) return false;
      const { useVaultStore } = await window.__importAppModule("/src/stores/vaultStore.ts");
      window.__recoveryReadinessStore = useVaultStore;
      const before = useVaultStore.getState();
      window.__recoveryReadiness = { realm: window.__recoveryRealm, root: before.currentVault?.path ?? null,
        token: before.vaultToken, loading: before.isLoading, opening: before.isOpeningVault };
      if (before.currentVault?.path !== "/myco" || before.isOpeningVault || before.isLoading) return false;
      const origin = await window.__TAURI_INTERNALS__.invoke("agent_vault_session");
      const after = useVaultStore.getState();
      return origin.vaultPath === "/myco" && typeof origin.openingToken === "string" && origin.openingToken.length > 0 &&
        after.currentVault?.path === "/myco" && after.vaultToken === before.vaultToken &&
        !after.isOpeningVault && !after.isLoading;
    }, undefined, "completed synthetic /myco opening");
  } catch (error) {
    let diagnostic;
    try {
      diagnostic = await page.evaluate(() => window.__recoveryDiagnostic());
    } catch (diagnosticError) {
      throw new AggregateError([error, diagnosticError], "Synthetic editor readiness and diagnostics failed");
    }
    throw new Error(`Synthetic editor readiness failed: ${JSON.stringify({ ...diagnostic,
      console: consoleEvents, pageerrors: errors.slice(0, 20) })}`, { cause: error });
  }
  await page.evaluate(async ({ original, other }) => {
    if (!window.__mycoMock || !window.__TAURI_INTERNALS__) throw new Error("Browser synthetic IPC is required");
    const { useVaultStore } = await window.__importAppModule("/src/stores/vaultStore.ts");
    const beforeUI = useVaultStore.getState();
    window.__recoveryBeforeUIImport = { realm: window.__recoveryRealm,
      sameReadinessStore: window.__recoveryReadinessStore === useVaultStore,
      root: beforeUI.currentVault?.path ?? null, token: beforeUI.vaultToken,
      loading: beforeUI.isLoading, opening: beforeUI.isOpeningVault };
    const { useUIStore } = await window.__importAppModule("/src/stores/uiStore.ts");
    const ready = useVaultStore.getState();
    window.__recoveryAfterUIImport = { realm: window.__recoveryRealm,
      sameReadinessStore: window.__recoveryReadinessStore === useVaultStore,
      root: ready.currentVault?.path ?? null, token: ready.vaultToken,
      loading: ready.isLoading, opening: ready.isOpeningVault };
    const root = ready.currentVault?.path;
    if (root !== "/myco" || ready.isOpeningVault || ready.isLoading) {
      throw new Error(`Synthetic editor fixture requires the completed /myco opening: ${JSON.stringify(await window.__recoveryDiagnostic())}`);
    }
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const f = window.__recoveryFixture = {
      root, path: `${root}/wiki/synthetic-editor-recovery.md`,
      otherPath: `${root}/wiki/synthetic-editor-recovery-other.md`,
      rawPath: `${root}/raw/synthetic-editor-recovery-source.md`,
      calls: [], clipboard: [], clipboardMode: "ok", holdRead: false,
      failRead: false, holdReadBeforeInvoke: false,
      readFailure: "Synthetic read failed: No such file or directory (os error 2)",
      readStarted: false, releaseRead: null, releaseClipboard: null,
      invoke,
    };
    await invoke("write_file", { path: f.path, content: original });
    await invoke("write_file", { path: f.otherPath, content: other });
    await invoke("write_file", { path: f.rawPath, content: original });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      // Inspect only text written by this fixture. Never access the OS clipboard.
      writeText(text) {
        f.clipboard.push(text);
        if (f.clipboardMode === "fail") return Promise.reject(new Error("Synthetic clipboard denied"));
        if (f.clipboardMode === "hold") return new Promise((resolve, reject) => {
          f.releaseClipboard = (success) => success ? resolve() : reject(new Error("Synthetic late clipboard denied"));
        });
        return Promise.resolve();
      },
    } });
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (["read_editor_file", "write_editor_file", "stage_editor_draft", "read_editor_draft", "retire_editor_draft"].includes(command)) {
        f.calls.push({ command, ...args });
      }
      // These failures never forward to a successful native-like read, so the
      // fixture does not secretly register a receipt for an unavailable file.
      if (command === "read_editor_file" && args.path === f.path && f.holdReadBeforeInvoke) {
        f.readStarted = true;
        return new Promise((resolve, reject) => {
          f.releaseRead = (success) => success
            ? invoke(command, args).then(resolve, reject)
            : reject(new Error(f.readFailure));
        });
      }
      if (command === "read_editor_file" && args.path === f.path && f.failRead) {
        throw new Error(f.readFailure);
      }
      if (command === "read_editor_file" && args.path === f.path && f.holdRead) {
        const snapshot = await invoke(command, args);
        f.readStarted = true;
        return new Promise((resolve, reject) => {
          f.releaseRead = (success) => success ? resolve(snapshot) : reject(new Error("Synthetic recovery read failed"));
        });
      }
      return invoke(command, args);
    };
    useUIStore.getState().setRoute(`page:${f.path}`);
  }, { original, other });
  await page.locator(".cm-content").waitFor();
  return { page, context, errors, blocked };
}

async function text(page) {
  return page.locator(".cm-content .cm-line").evaluateAll((lines) => lines.map((line) => line.textContent).join("\n"));
}
async function edit(page, raw) {
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(raw);
  await waitForAsyncPredicate(page, async (raw) => {
    const { pendingDrafts } = await window.__importAppModule("/src/stores/vaultStore.ts");
    return pendingDrafts.get(window.__recoveryFixture.path) === raw;
  }, raw, "current pending editor draft");
}
async function state(page) {
  return page.evaluate(async () => {
    const f = window.__recoveryFixture;
    const { useVaultStore, pendingDrafts } = await window.__importAppModule("/src/stores/vaultStore.ts");
    const s = useVaultStore.getState();
    return { draft: pendingDrafts.get(f.path), raw: (await f.invoke("read_file", { path: f.path })).raw,
      active: s.activeFile, calls: f.calls, clipboard: f.clipboard, vaultToken: s.vaultToken };
  });
}
async function conflict(page) {
  await edit(page, draft);
  await page.evaluate(async (external) => {
    const f = window.__recoveryFixture;
    await f.invoke("write_file", { path: f.path, content: external });
  }, external);
  await page.keyboard.press("ControlOrMeta+s");
  await page.locator(".reader-save-error").waitFor();
  const s = await state(page);
  check(s.raw === external && s.draft === draft, "CAS conflict preserves external B and draft A");
  await page.evaluate(() => { window.__recoveryFixture.calls = []; });
}
async function confirmReload(page) {
  await page.getByRole("button", { name: labels.reload, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: labels.title, exact: true });
  await dialog.waitFor();
  await dialog.getByRole("button", { name: labels.reload, exact: true }).click();
}
async function settleRead(page, success = true) {
  await page.evaluate((success) => window.__recoveryFixture.releaseRead(success), success);
  await page.waitForFunction((loading) => ![...document.querySelectorAll("button")].some((button) => button.textContent.trim() === loading), labels.loading);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function finish(f, name) {
  check(f.errors.length === 0, `${name}: no browser exception or unhandled rejection`);
  check(f.blocked.length === 0, `${name}: no unexpected external HTTP request attempted`);
  await f.context.close();
}

// These scenarios deliberately retain real mock stage acknowledgements. They
// exercise mounted UI, not a native filesystem or fresh-JS durability claim.
async function acknowledgedConflict(page) {
  await conflict(page);
  const checkpoint = await page.evaluate(async () => {
    const f = window.__recoveryFixture;
    const origin = await f.invoke("agent_vault_session");
    return f.invoke("read_editor_draft", { path: f.path, origin });
  });
  check(checkpoint?.baselineRaw === original && checkpoint?.draftRaw === draft &&
    /^[a-f0-9]{32}$/.test(checkpoint.revision), "unavailable note: real mock stage ACK retains exact full A/D and nonce");
  return checkpoint;
}
async function navigate(page, key) {
  await page.evaluate(async (key) => {
    const { useUIStore } = await window.__importAppModule("/src/stores/uiStore.ts");
    useUIStore.getState().setRoute(`page:${window.__recoveryFixture[key]}`);
  }, key);
}
async function openUnavailable(page) {
  await navigate(page, "otherPath");
  await page.waitForFunction(() => document.querySelector(".cm-content")?.textContent.includes("Other note stays current."));
  await page.evaluate(() => { window.__recoveryFixture.failRead = true; });
  await navigate(page, "path");
  await page.locator(".rd-missing").waitFor();
}
async function recoveryObservation(page) {
  return page.evaluate(async () => {
    const f = window.__recoveryFixture;
    const { useVaultStore, pendingDrafts, getEditorRecoveryBaseline } = await window.__importAppModule("/src/stores/vaultStore.ts");
    const origin = await f.invoke("agent_vault_session");
    const checkpoint = await f.invoke("read_editor_draft", { path: f.path, origin });
    const disk = await f.invoke("read_file", { path: f.path });
    return {
      pending: pendingDrafts.get(f.path), baseline: getEditorRecoveryBaseline(f.path), checkpoint,
      disk: disk.raw, activePath: useVaultStore.getState().activeFile?.path ?? null,
      calls: f.calls.map((call) => ({ ...call })), clipboard: [...f.clipboard],
      errorViews: document.querySelectorAll(".rd-missing").length,
      skeletons: document.querySelectorAll(".rd-skeleton").length,
      editors: document.querySelectorAll(".cm-content").length,
      disclosures: [...document.querySelectorAll("details.reader-recovery-source")].map((node) => ({
        label: node.querySelector("summary")?.textContent, raw: node.querySelector("pre")?.textContent,
      })),
      recoveryMessages: [...document.querySelectorAll(".reader-recovery-message")].map((node) => node.textContent),
      buttons: [...document.querySelectorAll(".reader-recovery button")].map((node) => ({
        text: node.textContent.trim(), disabled: node.disabled,
      })),
    };
  });
}
const unavailableResults = [];
async function unavailableScenario(name, run) {
  const f = await fixture();
  let failure;
  try {
    await run(f);
  } catch (error) {
    failure = error;
  }
  let observation;
  try {
    observation = await recoveryObservation(f.page);
  } catch (error) {
    failure = failure ? new AggregateError([failure, error], "Scenario and observation both failed") : error;
  }
  try {
    await finish(f, name);
  } catch (error) {
    failure = failure ? new AggregateError([failure, error], "Scenario and teardown both failed") : error;
    await f.context.close();
  }
  const result = { name, passed: !failure, error: failure?.stack ?? null, observation };
  unavailableResults.push(result);
  console.log(`UNAVAILABLE_SCENARIO ${JSON.stringify(result)}`);
}

try {
  for (const width of [320, 375, 768, 1280]) {
    const f = await fixture(width);
    await conflict(f.page);
    const viewport = f.page.viewportSize();
    for (const name of [labels.copy, labels.baselineCopy, labels.reload]) {
      const box = await f.page.getByRole("button", { name, exact: true }).boundingBox();
      check(box !== null && box.height >= 44, `${width}: ${name} recovery button is at least 44px tall`);
      check(box !== null && viewport !== null && box.x >= 0 && box.y >= 0 &&
        box.x + box.width <= viewport.width && box.y + box.height <= viewport.height,
      `${width}: ${name} recovery button is contained in the viewport`);
    }
    const baselineDetails = f.page.locator("details.reader-recovery-source")
      .filter({ has: f.page.locator("summary", { hasText: labels.baseline }) });
    check(await baselineDetails.locator("pre").textContent() === original,
      `${width}: complete original A includes its frontmatter in the recovery disclosure`);
    check(await baselineDetails.getAttribute("open") === null,
      `${width}: original A remains a closed read-only disclosure until requested`);
    await f.page.getByRole("button", { name: labels.baselineCopy, exact: true }).click();
    check(await f.page.evaluate((original) => window.__recoveryFixture.clipboard.at(-1) === original, original),
      `${width}: original copy writes exact full A to the synthetic clipboard`);
    if (screenshotDir && [320, 1280].includes(width)) {
      await f.page.screenshot({ path: join(screenshotDir, `editor-recovery-${width}-conflict.png`), fullPage: true });
    }
    await f.page.getByRole("button", { name: labels.reload, exact: true }).click();
    const dialog = f.page.getByRole("dialog", { name: labels.title, exact: true });
    await dialog.waitFor();
    await f.page.waitForFunction((cancel) => document.activeElement?.closest("[role='dialog']") && document.activeElement.textContent.trim() === cancel, labels.cancel);
    check(await dialog.getByRole("button", { name: labels.cancel, exact: true }).evaluate((button) => button === document.activeElement), `${width}: destructive confirm focuses Cancel`);
    await dialog.getByRole("button", { name: labels.cancel, exact: true }).click();
    const cancelled = await state(f.page);
    check(cancelled.calls.length === 0 && cancelled.draft === draft && cancelled.raw === external, `${width}: actual Cancel reads/writes/discards nothing`);
    await confirmReload(f.page);
    await f.page.getByText(labels.adopted, { exact: true }).waitFor();
    const adopted = await state(f.page);
    check(await text(f.page) === external, `${width}: accepted native read reseeds actual CodeMirror at the same path`);
    check(adopted.draft === undefined && adopted.active.raw === external && adopted.calls.every((call) => call.command !== "write_editor_file"), `${width}: adoption clears only the confirmed draft and writes no file`);
    if (screenshotDir && [320, 1280].includes(width)) {
      await f.page.screenshot({ path: join(screenshotDir, `editor-recovery-${width}-adopted.png`), fullPage: true });
    }
    await edit(f.page, newer);
    await f.page.keyboard.press("ControlOrMeta+s");
    await waitForAsyncPredicate(f.page, async (newer) => (await window.__recoveryFixture.invoke("read_file", { path: window.__recoveryFixture.path })).raw === newer, newer, "manual merge persisted raw");
    const saved = await state(f.page);
    check(saved.calls.filter((call) => call.command === "write_editor_file").at(-1).expectedSha256 === sha(external), `${width}: manual merge saves against adopted B revision`);
    await finish(f, `cancel/adopt/merge ${width}`);
  }
  for (const change of ["read-failure", "typing", "typing-roundtrip", "navigation", "navigation-roundtrip", "reopen"]) {
    const f = await fixture();
    await conflict(f.page);
    await f.page.evaluate(() => { window.__recoveryFixture.holdRead = true; });
    await confirmReload(f.page);
    await f.page.waitForFunction(() => window.__recoveryFixture.readStarted);
    check((await state(f.page)).draft === draft && await text(f.page) === draft, `${change}: read starts with draft intact`);
    if (change.startsWith("typing")) {
      await edit(f.page, newer);
      if (change === "typing-roundtrip") await edit(f.page, draft);
    } else if (change === "navigation") {
      await f.page.evaluate(async () => {
        const { useUIStore } = await window.__importAppModule("/src/stores/uiStore.ts");
        useUIStore.getState().setRoute(`page:${window.__recoveryFixture.otherPath}`);
      });
      await f.page.waitForFunction(() => document.querySelector(".cm-content")?.textContent.includes("Other note stays current."));
    } else if (change === "navigation-roundtrip") {
      await f.page.evaluate(async () => {
        const { useUIStore } = await window.__importAppModule("/src/stores/uiStore.ts");
        useUIStore.getState().setRoute(`page:${window.__recoveryFixture.otherPath}`);
      });
      await f.page.waitForFunction(() => document.querySelector(".cm-content")?.textContent.includes("Other note stays current."));
      await f.page.evaluate(async () => {
        const { useUIStore } = await window.__importAppModule("/src/stores/uiStore.ts");
        // The original recovery stays held; admit only the new visit's read.
        window.__recoveryFixture.holdRead = false;
        useUIStore.getState().setRoute(`page:${window.__recoveryFixture.path}`);
      });
      await f.page.waitForFunction(() => document.querySelector(".cm-content")?.textContent.includes("Unsaved draft A."));
    } else if (change === "reopen") {
      await f.page.evaluate(async () => {
        const { useVaultStore } = await window.__importAppModule("/src/stores/vaultStore.ts");
        window.__recoveryFixture.holdRead = false;
        await useVaultStore.getState().openVault(window.__recoveryFixture.root);
      });
      await f.page.locator(".cm-content").waitFor();
    }
    await settleRead(f.page, change !== "read-failure");
    const s = await state(f.page);
    check(s.raw === external && s.draft === (change === "typing" ? newer : draft), `${change}: refused adoption preserves original file and latest draft`);
    check(await f.page.getByText(labels.adopted, { exact: true }).count() === 0, `${change}: no false read-adoption success`);
    check(await text(f.page) === (change === "navigation" ? other : change === "typing" ? newer : draft), `${change}: old read cannot overwrite the actual current editor`);
    await finish(f, change);
  }
  for (const result of ["ok", "fail", "late-ok", "late-fail"]) {
    const f = await fixture();
    await conflict(f.page);
    await f.page.evaluate((result) => { window.__recoveryFixture.clipboardMode = result.startsWith("late-") ? "hold" : result; }, result);
    await f.page.getByRole("button", { name: labels.copy, exact: true }).click();
    await f.page.waitForFunction(() => window.__recoveryFixture.clipboard.length === 1);
    if (result.startsWith("late-")) {
      await f.page.evaluate(async (result) => {
        const { useUIStore } = await window.__importAppModule("/src/stores/uiStore.ts");
        useUIStore.getState().setRoute(`page:${window.__recoveryFixture.otherPath}`);
        window.__recoveryFixture.releaseClipboard(result === "late-ok");
      }, result);
      await f.page.waitForFunction(() => document.querySelector(".cm-content")?.textContent.includes("Other note stays current."));
      await f.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      check(await f.page.getByText(labels.copied, { exact: true }).count() === 0 && await f.page.getByText(labels.copyFailed, { exact: true }).count() === 0, `${result}: delayed clipboard result cannot claim success/failure for the new reader`);
    } else {
      await f.page.getByText(result === "ok" ? labels.copied : labels.copyFailed, { exact: true }).waitFor();
    }
    const s = await state(f.page);
    check(s.clipboard[0] === draft && s.draft === draft && s.raw === external, `${result}: copy targets captured full raw draft and preserves both texts`);
    await finish(f, `clipboard ${result}`);
  }
  {
    const f = await fixture();
    await f.page.evaluate(async () => {
      const { useUIStore } = await window.__importAppModule("/src/stores/uiStore.ts");
      useUIStore.getState().setRoute(`page:${window.__recoveryFixture.rawPath}`);
    });
    await f.page.getByText("가져온 원본 파일은 읽기만 가능합니다. 문장을 고르면 출처와 함께 오늘의 노트에 옮길 수 있어요.", { exact: true }).waitFor();
    check(await f.page.locator(".cm-content").count() === 0 && await f.page.getByRole("button", { name: labels.reload, exact: true }).count() === 0, "raw: original is read-only with no destructive recovery control");
    check((await state(f.page)).calls.every((call) => call.command !== "write_editor_file"), "raw: reading original dispatches no editor write");
    await finish(f, "raw read-only");
  }
  console.log(`BASELINE_COMPLETE ${JSON.stringify({ checks, syntheticBrowserOnly: true })}`);

  await unavailableScenario("failed-read A/D copy and no automatic mutation", async (f) => {
    const checkpoint = await acknowledgedConflict(f.page);
    await openUnavailable(f.page);
    const before = await recoveryObservation(f.page);
    console.log(`UNAVAILABLE_BEFORE_ASSERT ${JSON.stringify({ name: "failed-read A/D copy", observation: before })}`);
    check(before.pending === draft && before.baseline === original && before.disk === external &&
      JSON.stringify(before.checkpoint) === JSON.stringify(checkpoint), "failed read retains exact acknowledged A/D and external B");
    check(before.editors === 0 && before.errorViews === 1, "failed read remains an actual error view with no editable document");
    check(before.disclosures.some((entry) => entry.label === labels.recoveryDraft && entry.raw === draft),
      "failed read exposes exact full D as a read-only disclosure");
    check(before.disclosures.some((entry) => entry.label === labels.baseline && entry.raw === original),
      "failed read exposes exact full A as a read-only disclosure");
    check(await f.page.getByRole("button", { name: labels.reload, exact: true }).count() === 0,
      "failed read offers no destructive discard/reload action");
    await f.page.getByRole("button", { name: labels.copy, exact: true }).click();
    await f.page.getByRole("button", { name: labels.baselineCopy, exact: true }).click();
    await f.page.evaluate(() => { window.__recoveryFixture.calls = []; });
    // Observe beyond the product's existing 2s autosave delay; this is QA only.
    await f.page.waitForTimeout(2300);
    await navigate(f.page, "otherPath");
    await f.page.waitForFunction(() => document.querySelector(".cm-content")?.textContent.includes("Other note stays current."));
    const after = await recoveryObservation(f.page);
    check(after.clipboard.at(-2) === draft && after.clipboard.at(-1) === original,
      "failed read copies only captured full D and A to the synthetic clipboard");
    check(!after.calls.some((call) => ["stage_editor_draft", "write_editor_file", "retire_editor_draft"].includes(call.command)) &&
      after.pending === draft && after.disk === external && JSON.stringify(after.checkpoint) === JSON.stringify(checkpoint),
    "failed read copy/idle/unmount never stages, saves, retires or overwrites");
  });

  await unavailableScenario("retry missing then genuine read success without automatic save", async (f) => {
    const checkpoint = await acknowledgedConflict(f.page);
    await openUnavailable(f.page);
    const retry = f.page.getByRole("button", { name: labels.retryRead, exact: true });
    check(await retry.count() === 1, "unavailable note has a real read-only file retry control");
    await retry.click();
    await f.page.locator(".rd-missing").waitFor();
    await f.page.evaluate(() => { window.__recoveryFixture.failRead = false; window.__recoveryFixture.calls = []; });
    await retry.click();
    await f.page.locator(".cm-content").waitFor();
    await f.page.waitForTimeout(2300);
    const after = await recoveryObservation(f.page);
    check(await text(f.page) === draft && after.pending === draft && after.baseline === original && after.disk === external,
      "genuine successful read seeds D while preserving full A and disk B");
    check(JSON.stringify(after.checkpoint) === JSON.stringify(checkpoint) &&
      !after.calls.some((call) => ["stage_editor_draft", "write_editor_file", "retire_editor_draft"].includes(call.command)),
    "retry and idle do not automatically stage, save, rebase or retire recovery data");
  });

  await unavailableScenario("late failed read cannot affect a different keyed reader", async (f) => {
    const checkpoint = await acknowledgedConflict(f.page);
    await openUnavailable(f.page);
    await f.page.evaluate(() => {
      window.__recoveryFixture.holdReadBeforeInvoke = true;
      window.__recoveryFixture.readStarted = false;
    });
    await f.page.getByRole("button", { name: labels.retryRead, exact: true }).click();
    await f.page.waitForFunction(() => window.__recoveryFixture.readStarted);
    await navigate(f.page, "otherPath");
    await f.page.waitForFunction(() => document.querySelector(".cm-content")?.textContent.includes("Other note stays current."));
    await f.page.evaluate(() => { window.__recoveryFixture.releaseRead(false); });
    await f.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const after = await recoveryObservation(f.page);
    check(await text(f.page) === other && after.errorViews === 0 && after.recoveryMessages.length === 0,
      "late old-reader failure does not set error or feedback on current B");
    check(after.pending === draft && after.baseline === original && after.disk === external &&
      JSON.stringify(after.checkpoint) === JSON.stringify(checkpoint), "late old-reader failure retains A/D/nonce and external B");
    check(after.buttons.every((button) => !button.disabled), "late old-reader completion leaves current controls usable");
  });

  await unavailableScenario("same-vault cross-pane stale-null must retain a failed read", async (f) => {
    const checkpoint = await acknowledgedConflict(f.page);
    await f.page.evaluate(async () => {
      const { useUIStore } = await window.__importAppModule("/src/stores/uiStore.ts");
      useUIStore.getState().setSplitRoute("overview");
    });
    await f.page.locator(".workspace-split").waitFor();
    await f.page.waitForFunction(() => document.querySelector(".cm-content")?.textContent.includes("Unsaved draft A."));
    await openUnavailable(f.page);
    await f.page.evaluate(() => {
      window.__recoveryFixture.holdReadBeforeInvoke = true;
      window.__recoveryFixture.readStarted = false;
    });
    await f.page.getByRole("button", { name: labels.retryRead, exact: true }).click();
    await f.page.waitForFunction(() => window.__recoveryFixture.readStarted);
    // Navigation setup may legitimately checkpoint the unchanged draft again.
    // Bind this observation to the actual ACK at the start of the held read.
    const heldCheckpoint = (await recoveryObservation(f.page)).checkpoint;
    await f.page.evaluate(async () => {
      const { useUIStore } = await window.__importAppModule("/src/stores/uiStore.ts");
      useUIStore.getState().setSplitRoute(`page:${window.__recoveryFixture.otherPath}`);
    });
    await f.page.waitForFunction(() => document.querySelector(".workspace-pane--secondary .cm-content")?.textContent.includes("Other note stays current."));
    await f.page.evaluate(() => { window.__recoveryFixture.releaseRead(false); });
    await f.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const after = await recoveryObservation(f.page);
    const primaryError = await f.page.locator(".workspace-pane:not(.workspace-pane--secondary) .rd-missing").count();
    const primarySkeleton = await f.page.locator(".workspace-pane:not(.workspace-pane--secondary) .rd-skeleton").count();
    console.log(`CROSS_PANE_OBSERVATION ${JSON.stringify({ primaryError, primarySkeleton, observation: after })}`);
    check(primaryError === 1 && primarySkeleton === 0,
      "superseded failed A read must remain an error, not a false-success loading skeleton");
    check(after.pending === draft && after.baseline === original && after.disk === external &&
      JSON.stringify(after.checkpoint) === JSON.stringify(heldCheckpoint) &&
      heldCheckpoint.baselineRaw === checkpoint.baselineRaw && heldCheckpoint.draftRaw === checkpoint.draftRaw,
    "cross-pane read preserves its actual acknowledged A/D/nonce and external B");
    const secondary = f.page.locator(".workspace-pane--secondary .cm-content");
    const secondaryRaw = await secondary.locator(".cm-line").evaluateAll((lines) => lines.map((line) => line.textContent).join("\n"));
    console.log(`SECONDARY_TEXT_OBSERVATION ${JSON.stringify({ innerText: await secondary.innerText(), lineRaw: secondaryRaw, expectedFullRaw: other })}`);
    check(secondaryRaw === other,
      "secondary B stays current after A failure");
  });

  console.log(`UNAVAILABLE_COMPLETE ${JSON.stringify({ checks, scenarios: unavailableResults.map(({ name, passed }) => ({ name, passed })) })}`);
  const failures = unavailableResults.filter((result) => !result.passed);
  if (failures.length) throw new AggregateError(failures.map((result) => new Error(`${result.name}: ${result.error}`)),
    `${failures.length} unavailable-note browser regression scenario(s) failed`);
  console.log(`${checks} checks passed (synthetic browser UI/IPC/clipboard only; no native, model, installed or product zero-egress acceptance)`);
} finally {
  await browser.close();
}
