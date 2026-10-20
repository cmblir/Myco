// Mounted React races with synthetic IPC. No native grants, models or credentials.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";

const base = new URL(process.env.MYCO_TEST_URL ?? "http://127.0.0.1:5173");
const local = ["localhost", "127.0.0.1", "[::1]"];
assert.ok(local.includes(base.hostname), "Use a loopback Vite server");
const output = process.env.MYCO_IMAGE_TEST_OUTPUT;
if (output) await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const results = [];
let checks = 0;
const check = (condition, label) => {
  assert.ok(condition, label);
  checks++;
};
const settle = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );

async function fixture(wizard = false) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  const errors = [];
  const blocked = [];
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (
      !["http:", "https:"].includes(url.protocol) ||
      local.includes(url.hostname)
    )
      return route.continue();
    blocked.push(url.origin);
    return route.abort("blockedbyclient");
  });
  await page.addInitScript(() => {
    performance.setResourceTimingBufferSize(5000);
    window.__importAppModule = (path) => {
      const resource = performance
        .getEntriesByType("resource")
        .filter((entry) => new URL(entry.name).pathname === path)
        .at(-1);
      if (!resource) throw new Error(`Mounted module not found: ${path}`);
      return import(resource.name);
    };
    localStorage.setItem("myco.onboarded", "1");
    localStorage.setItem(
      "myco-ui",
      JSON.stringify({
        version: 3,
        state: { lang: "en", theme: "light", sidebarCollapsed: false },
      }),
    );
  });
  const url = new URL(base);
  url.search = "?mock=1&local=1&nowriter=1";
  await page.goto(url.toString());
  await page.locator(".home-page").waitFor();
  await page.evaluate(async (wizard) => {
    const { useVaultStore } = await window.__importAppModule(
      "/src/stores/vaultStore.ts",
    );
    const { useSettingsStore } = await window.__importAppModule(
      "/src/stores/settingsStore.ts",
    );
    const { useUIStore } = await window.__importAppModule(
      "/src/stores/uiStore.ts",
    );
    const { roleFixture, selectedRolesFixture } =
      await import("/src/lib/modelRoles.testSupport.ts");
    const invoke = window.__TAURI_INTERNALS__.invoke.bind(
      window.__TAURI_INTERNALS__,
    );
    const initial = await invoke("get_settings");
    const origin = await invoke("agent_vault_session");
    const roles = selectedRolesFixture({
      compilation: {
        providerId: "openai-api",
        modelId: "synthetic-supported-vision",
      },
    });
    const state = {
      origin,
      vault: useVaultStore,
      ui: useUIStore,
      settings: useSettingsStore,
      calls: [],
      origins: [],
      captures: [],
      pickers: [],
      images: [],
      cancels: [],
      holdOrigin: false,
      holdRole: false,
      rejectRole: false,
      closes: 0,
    };
    window.__imageFixture = state;
    useSettingsStore.setState({
      settings: {
        ...initial,
        model_roles: roles,
        role_authorization_revision: "b".repeat(64),
        query_provider: "openai-api",
        query_model: "synthetic-unrelated-ask",
        auto_import: false,
        auto_ingest: false,
        auto_reflect: false,
      },
    });
    window.__TAURI_INTERNALS__.invoke = (command, args = {}) => {
      state.calls.push(command);
      if (command === "agent_vault_session") {
        if (!state.holdOrigin)
          return Promise.resolve(structuredClone(state.origin));
        return new Promise((resolve, reject) =>
          state.origins.push({ resolve, reject }),
        );
      }
      if (command === "capture_model_role") {
        if (state.rejectRole)
          return Promise.reject(new Error("Synthetic role capture failed"));
        const grant = roleFixture(
          "compilation",
          "openai-api",
          "synthetic-supported-vision",
          args.origin,
        );
        const entry = { args: structuredClone(args), grant };
        state.captures.push(entry);
        if (!state.holdRole) return Promise.resolve(grant);
        return new Promise((resolve, reject) =>
          Object.assign(entry, { resolve, reject }),
        );
      }
      if (command === "plugin:dialog|open") {
        if (args.options?.directory)
          return Promise.resolve(state.origin.vaultPath);
        return new Promise((resolve, reject) =>
          state.pickers.push({ resolve, reject }),
        );
      }
      if (command === "describe_image")
        return new Promise((resolve, reject) =>
          state.images.push({
            args: structuredClone(args),
            resolve,
            reject,
          }),
        );
      if (command === "cancel_image_ingest") {
        state.cancels.push(structuredClone(args));
        return Promise.resolve(true);
      }
      return invoke(command, args);
    };
    if (!wizard) {
      useUIStore.getState().setRoute("ingest");
      return;
    }
    const { default: React } = await window.__importAppModule(
      "/node_modules/.vite/deps/react.js",
    );
    const { default: ReactDOM } = await window.__importAppModule(
      "/node_modules/.vite/deps/react-dom_client.js",
    );
    const { default: Wizard } = await window.__importAppModule(
      "/src/components/OnboardingWizard.tsx",
    );
    const { STRINGS } = await window.__importAppModule("/src/lib/i18n.ts");
    const host = document.createElement("div");
    host.id = "synthetic-onboarding-host";
    document.body.append(host);
    const root = ReactDOM.createRoot(host);
    state.close = () => {
      state.closes++;
      root.unmount();
      host.remove();
    };
    root.render(
      React.createElement(Wizard, { t: STRINGS.en, onClose: state.close }),
    );
  }, wizard);
  if (wizard) {
    await page.locator(".onboarding").waitFor();
    await page
      .locator(".onboarding")
      .getByRole("button", { name: "Choose a folder…", exact: true })
      .click();
    await page.locator(".ob-note").waitFor();
  } else await page.locator("#ingest-body").waitFor();
  await settle(page);
  return { context, page, errors, blocked, wizard };
}

async function scenario(name, run, wizard = false) {
  let f;
  const start = checks;
  try {
    f = await fixture(wizard);
    await run(f);
    check(f.errors.length === 0, `${name}: no page errors`);
    check(f.blocked.length === 0, `${name}: no external HTTP attempted`);
    results.push({ name, passed: true, checks: checks - start });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({
      name,
      passed: false,
      checks: checks - start,
      error: error.stack ?? String(error),
      pageErrors: f?.errors ?? [],
      blocked: f?.blocked ?? [],
    });
    console.error(`FAIL ${name}: ${error.message}`);
    if (f && output)
      await f.page.screenshot({ path: join(output, `${name}-failed.png`) });
  } finally {
    if (f) await f.context.close();
  }
}

const browse = ({ page, wizard }) =>
  (wizard ? page.locator(".onboarding") : page.locator(".sv-dz"))
    .getByRole("button", {
      name: wizard ? "Import from a file…" : "Browse files…",
      exact: true,
    })
    .click();
async function imagePending(f, name = "first") {
  await browse(f);
  await f.page.waitForFunction(
    () => window.__imageFixture.pickers.length === 1,
  );
  await f.page.evaluate(
    (name) =>
      window.__imageFixture.pickers[0].resolve(`/synthetic/${name}.png`),
    name,
  );
  await f.page.waitForFunction(() => window.__imageFixture.images.length === 1);
}

try {
  await scenario("capture-before-picker", async (f) => {
    await f.page.evaluate(() => {
      window.__imageFixture.holdOrigin = true;
      window.__imageFixture.holdRole = true;
    });
    await browse(f);
    await settle(f.page);
    const first = await f.page.evaluate(() => ({
      origins: window.__imageFixture.origins.length,
      pickers: window.__imageFixture.pickers.length,
    }));
    check(
      first.origins === 1 && first.pickers === 0,
      "Origin capture precedes the native picker",
    );
    await f.page.evaluate(() =>
      window.__imageFixture.origins[0].resolve(window.__imageFixture.origin),
    );
    await f.page.waitForFunction(
      () => window.__imageFixture.captures.length === 1,
    );
    check(
      (await f.page.evaluate(() => window.__imageFixture.pickers.length)) === 0,
      "Role capture also precedes the picker",
    );
    await f.page.evaluate(() =>
      window.__imageFixture.captures[0].resolve(
        window.__imageFixture.captures[0].grant,
      ),
    );
    await f.page.waitForFunction(
      () => window.__imageFixture.pickers.length === 1,
    );
    await f.page.evaluate(() =>
      window.__imageFixture.pickers[0].resolve("/synthetic/accepted.png"),
    );
    await f.page.waitForFunction(
      () => window.__imageFixture.images.length === 1,
    );
    const request = await f.page.evaluate(
      () => window.__imageFixture.images[0].args,
    );
    check(
      request.request?.roleSnapshot.role === "compilation" &&
        request.request.roleSnapshot.usage === "foreground",
      "Image dispatch has the captured Compilation foreground snapshot",
    );
    check(
      !("provider" in request) && !("model" in request),
      "Legacy Query fields do not dispatch",
    );
    await f.page.evaluate(() =>
      window.__imageFixture.images[0].resolve("Synthetic accepted source."),
    );
    await f.page.waitForFunction(
      () =>
        document.querySelector("#ingest-body").value ===
        "Synthetic accepted source.",
    );
    check(
      (await f.page.locator("#ingest-title").inputValue()) === "accepted",
      "Valid title and body are adopted together",
    );
  });

  await scenario("capture-failure-no-picker", async (f) => {
    await f.page.evaluate(() => {
      window.__imageFixture.rejectRole = true;
    });
    await browse(f);
    await settle(f.page);
    check(
      await f.page.evaluate(
        () =>
          window.__imageFixture.pickers.length === 0 &&
          window.__imageFixture.images.length === 0,
      ),
      "Failed capture opens no picker or image request",
    );
  });

  for (const wizard of [false, true])
    await scenario(
      `picker-reopen-${wizard ? "wizard" : "ingest"}`,
      async (f) => {
        await browse(f);
        await f.page.waitForFunction(
          () => window.__imageFixture.pickers.length === 1,
        );
        await f.page.evaluate(() => {
          const state = window.__imageFixture;
          state.vault.setState({ vaultToken: "synthetic-reopened-token" });
          state.origin = {
            ...state.origin,
            openingToken: "synthetic-reopened-opening",
          };
          state.pickers[0].resolve("/synthetic/stale.png");
        });
        await settle(f.page);
        check(
          (await f.page.evaluate(() => window.__imageFixture.images.length)) ===
            0,
          "A delayed picker cannot retarget a reopened vault",
        );
        check(
          (await f.page
            .locator(wizard ? ".ob-note" : "#ingest-body")
            .inputValue()) === "",
          "The current draft is preserved",
        );
      },
      wizard,
    );

  for (const wizard of [false, true])
    await scenario(
      `image-edit-${wizard ? "wizard" : "ingest"}`,
      async (f) => {
        await imagePending(f);
        await f.page
          .locator(wizard ? ".ob-note" : "#ingest-body")
          .fill("Synthetic user draft.");
        if (!wizard) await f.page.locator("#ingest-title").fill("Human title");
        await f.page.evaluate(() =>
          window.__imageFixture.images[0].resolve(
            "Synthetic stale image result.",
          ),
        );
        await settle(f.page);
        check(
          (await f.page
            .locator(wizard ? ".ob-note" : "#ingest-body")
            .inputValue()) === "Synthetic user draft.",
          "Late image output cannot overwrite a typed draft",
        );
        if (!wizard)
          check(
            (await f.page.locator("#ingest-title").inputValue()) ===
              "Human title",
            "Human title survives",
          );
        const wire = await f.page.evaluate(() => ({
          request: window.__imageFixture.images[0].args.request,
          cancels: window.__imageFixture.cancels,
        }));
        check(
          wire.cancels.some(
            (cancel) =>
              cancel.requestId === wire.request?.requestId &&
              cancel.origin.openingToken === wire.request?.origin.openingToken,
          ),
          "Draft editing cancels the exact native image request",
        );
      },
      wizard,
    );

  await scenario("replacement-request-preserved", async (f) => {
    await imagePending(f);
    await browse(f);
    await f.page.waitForFunction(
      () => window.__imageFixture.pickers.length === 2,
    );
    await f.page.evaluate(() =>
      window.__imageFixture.pickers[1].resolve("/synthetic/second.png"),
    );
    await f.page.waitForFunction(
      () => window.__imageFixture.images.length === 2,
    );
    await f.page.evaluate(() =>
      window.__imageFixture.images[0].reject(
        new Error("Synthetic stale transport error"),
      ),
    );
    await settle(f.page);
    check(
      !(await f.page.locator(".sv-dz").innerText()).includes(
        "Synthetic stale transport error",
      ),
      "Old errors cannot replace current loading state",
    );
    await f.page.evaluate(() =>
      window.__imageFixture.images[1].resolve(
        "Synthetic second accepted source.",
      ),
    );
    await f.page.waitForFunction(
      () =>
        document.querySelector("#ingest-body").value ===
        "Synthetic second accepted source.",
    );
    check(
      (await f.page.locator("#ingest-title").inputValue()) === "second",
      "The newer request owns the adopted title",
    );
    const wire = await f.page.evaluate(() => ({
      old: window.__imageFixture.images[0].args.request,
      current: window.__imageFixture.images[1].args.request,
      cancels: window.__imageFixture.cancels,
    }));
    check(
      wire.cancels.some((cancel) => cancel.requestId === wire.old?.requestId) &&
        !wire.cancels.some(
          (cancel) => cancel.requestId === wire.current?.requestId,
        ),
      "Replacing a request cancels only its predecessor",
    );
  });

  await scenario("drop-unmount", async (f) => {
    await f.page.evaluate(() =>
      window.__mycoMock.emit("tauri://drag-drop", {
        paths: ["/synthetic/dropped.png"],
        position: { x: 1, y: 1 },
      }),
    );
    await f.page.waitForFunction(
      () => window.__imageFixture.images.length === 1,
    );
    await f.page.evaluate(() =>
      window.__imageFixture.ui.getState().setRoute("overview"),
    );
    await f.page.locator(".home-page").waitFor();
    await f.page.evaluate(() =>
      window.__imageFixture.images[0].resolve(
        "Synthetic stale dropped source.",
      ),
    );
    await settle(f.page);
    const wire = await f.page.evaluate(() => ({
      request: window.__imageFixture.images[0].args.request,
      cancels: window.__imageFixture.cancels,
    }));
    check(
      wire.cancels.some(
        (cancel) => cancel.requestId === wire.request?.requestId,
      ),
      "Unmount cancels the owned drop request",
    );
    check(
      (await f.page.locator("#ingest-body").count()) === 0,
      "The old intake screen stays unmounted",
    );
  });

  await scenario(
    "wizard-back-late-result",
    async (f) => {
      await imagePending(f);
      await f.page
        .locator(".ob-actions")
        .getByRole("button", { name: "Back", exact: true })
        .click();
      await f.page.evaluate(() =>
        window.__imageFixture.images[0].resolve("Synthetic stale wizard text."),
      );
      await settle(f.page);
      await f.page
        .locator(".onboarding")
        .getByRole("button", { name: "Choose a folder…", exact: true })
        .click();
      await f.page.locator(".ob-note").waitFor();
      check(
        (await f.page.locator(".ob-note").inputValue()) === "",
        "Leaving and returning to the note step preserves the draft",
      );
    },
    true,
  );

  await scenario(
    "wizard-close-delayed-picker",
    async (f) => {
      await browse(f);
      await f.page.waitForFunction(
        () => window.__imageFixture.pickers.length === 1,
      );
      await f.page.locator(".ob-skip").click();
      await f.page.evaluate(() =>
        window.__imageFixture.pickers[0].resolve("/synthetic/closed.png"),
      );
      await settle(f.page);
      check(
        (await f.page.evaluate(() => window.__imageFixture.images.length)) ===
          0,
        "A closed wizard never starts extraction after a delayed picker",
      );
      check(
        (await f.page.locator(".onboarding").count()) === 0,
        "The wizard stays closed",
      );
    },
    true,
  );
} finally {
  await browser.close();
  if (output)
    await writeFile(
      join(output, "report.json"),
      JSON.stringify(
        {
          synthetic_ipc_only: true,
          checks,
          results,
        },
        null,
        2,
      ),
    );
}
console.log(
  JSON.stringify({
    checks,
    passed: results.filter((result) => result.passed).length,
    failed: results.filter((result) => !result.passed).length,
  }),
);
if (results.some((result) => !result.passed)) process.exitCode = 1;
