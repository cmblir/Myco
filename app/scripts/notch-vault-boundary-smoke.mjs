// Real secondary-window senders and App broker; storage and native IPC are
// entirely synthetic. Native cache validation has separate Rust regressions.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = new URL(process.env.MYCO_TEST_URL ?? "http://127.0.0.1:5173");
const loopback = ["127.0.0.1", "localhost", "[::1]"];
assert.ok(loopback.includes(base.hostname), "Use a loopback development server");
const browser = await chromium.launch();
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; console.log(`PASS ${message}`); };
try {
  for (const surface of ["notch", "tray"]) {
    for (const scenario of ["different-vault", "reopened", "opening", "success", "read-failure"]) {
      if (surface === "notch" && scenario === "read-failure") continue;
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await context.route("**/*", (route) => {
        const target = new URL(route.request().url());
        return loopback.includes(target.hostname) || !["http:", "https:"].includes(target.protocol)
          ? route.continue() : route.abort("blockedbyclient");
      });
      await context.addInitScript(() => {
        // Match the app's served HMR URL instead of instantiating another store.
        window.__importAppModule = (path) => {
          const entry = performance.getEntriesByType("resource").filter((resource) => new URL(resource.name).pathname === path).at(-1);
          if (!entry) throw new Error(`App module was not loaded: ${path}`);
          return import(entry.name);
        };
        localStorage.setItem("myco.onboarded", "1");
        localStorage.setItem("myco-ui", JSON.stringify({ version: 3, state: { lang: "en", mascotEnabled: true } }));
      });
      const writer = await context.newPage();
      const view = await context.newPage();
      const errors = [];
      writer.on("pageerror", (error) => errors.push(error.message));
      view.on("pageerror", (error) => errors.push(error.message));
      await writer.exposeBinding("__deliverBoundaryReply", async (_source, reply) => {
        await view.evaluate((reply) => window.__mycoMock.emit("myco://tray-action-result", reply), reply);
      });
      await writer.goto(new URL("/?mock=1&local=1&nowriter=1", base).toString());
      await writer.locator(".home-page").waitFor();
      await writer.waitForFunction(async () => {
        const { useVaultStore } = await window.__importAppModule("/src/stores/vaultStore.ts");
        return useVaultStore.getState().currentVault?.path === "/myco" && !useVaultStore.getState().isOpeningVault;
      });
      await writer.evaluate(async (scenario) => {
        if (!window.__mycoMock || !window.__TAURI_INTERNALS__) throw new Error("Synthetic IPC mock is required");
        const { useVaultStore } = await window.__importAppModule("/src/stores/vaultStore.ts");
        const path = "/synthetic-b/work/feedback/shared-proposal.md";
        window.__boundaryFixture = { path, effects: [], replies: [], holdRead: scenario === "read-failure", raw: "---\ntype: distill-proposal\naction: admit-cluster\nstatus: pending\ncreated: 2026-10-04\npayload: {\"files\":[]}\n---\n# Synthetic proposal\n" };
        const invoke = window.__TAURI_INTERNALS__.invoke;
        window.__TAURI_INTERNALS__.invoke = async (command, args) => {
          const fixture = window.__boundaryFixture;
          if (command === "read_file" && args.path === path) {
            if (fixture.holdRead) { fixture.holdRead = false; await new Promise((_resolve, reject) => { fixture.rejectRead = () => reject(new Error("Synthetic read failure")); }); }
            return { path, raw: fixture.raw, content: fixture.raw, frontmatter: null };
          }
          if (command === "write_file" && args.path === path) { fixture.effects.push({ command, path }); fixture.raw = args.content; return null; }
          if (command === "apply_distill_proposal" && args.vault === "/synthetic-b") { fixture.effects.push({ command, vault: args.vault, path: args.path }); return "synthetic admission completed"; }
          if (command === "list_files" && args.path === "/synthetic-b") return [];
          if (command === "plugin:event|emit" && args.event === "myco://tray-action-result") { fixture.replies.push(args.payload); await window.__deliverBoundaryReply(args.payload); }
          return invoke(command, args);
        };
        useVaultStore.setState({ currentVault: { path: "/synthetic-b", name: "Synthetic B" }, vaultToken: "scope-b-current", isOpeningVault: scenario === "opening" });
      }, scenario);
      await view.exposeBinding("__deliverBoundaryAction", async (_source, request) => {
        await writer.evaluate((request) => window.__mycoMock.emit("myco://tray-action", request), request);
      });
      await view.setViewportSize({ width: 420, height: surface === "tray" ? 720 : 280 });
      await view.goto(new URL(`/?mock=1&window=${surface}`, base).toString(), { waitUntil: "networkidle" });
      await view.locator(surface === "notch" ? ".notch" : ".tray-panel").waitFor();
      if (surface === "notch") {
        check(await view.locator(".notch-mascot, .notch-mark, .notch-mark-n, .notch-cap, .notch-winged, .notch-body").count() === 0,
          `notch/${scenario}: waiting decisions draw no collapsed avatar, badge, wing, cap or card`);
        const hotspot = await view.locator(".notch").evaluate((element) => {
          const box = element.getBoundingClientRect();
          const css = getComputedStyle(element);
          const hit = document.elementFromPoint(box.x + box.width / 2, box.bottom - 5);
          return { width: box.width, height: box.height, background: css.backgroundColor,
            image: css.backgroundImage, shadow: css.boxShadow,
            interactive: css.pointerEvents !== "none" && hit !== null && element.contains(hit) };
        });
        check(hotspot.width === 204 && hotspot.height === 51 && hotspot.background === "rgba(0, 0, 0, 0)" && hotspot.image === "none" && hotspot.shadow === "none" && hotspot.interactive,
          `notch/${scenario}: transparent cutout-sized hotspot remains interactive`);
      }
      await view.evaluate(async ({ surface, scenario }) => {
        const invoke = window.__TAURI_INTERNALS__.invoke;
        const snapshot = await invoke("get_tray_status");
        const scope = scenario === "different-vault"
          ? { vaultPath: "/synthetic-a", vaultToken: "scope-a" }
          : { vaultPath: "/synthetic-b", vaultToken: scenario === "reopened" ? "scope-b-previous" : "scope-b-current" };
        snapshot.panel.actionScope = scope;
        snapshot.panel.labels = { ...snapshot.panel.labels, nowEyebrow: "Awaiting approval", toastApproved: "{name} approved", actionPending: "Waiting for writer", actionFailed: "Writer did not complete" };
        snapshot.proposals = [{ path: "work/feedback/shared-proposal.md", label: "Synthetic proposal", sub: "Synthetic evidence only" }];
        snapshot.proposalApprove = "Approve";
        snapshot.proposalReject = "Dismiss";
        snapshot.panel.agenda = { total: 1, rows: [{
          id: "work/feedback/shared-proposal.md", label: "Synthetic proposal", sub: "Synthetic evidence only",
          primaryLabel: "Approve", primaryAction: "proposal-approve:work/feedback/shared-proposal.md",
          secondaryLabel: "Dismiss", secondaryAction: "proposal-reject:work/feedback/shared-proposal.md",
        }] };
        window.__boundaryView = { snapshot, requests: [] };
        window.__TAURI_INTERNALS__.invoke = async (command, args) => {
          if ((command === "plugin:event|emit" && args.event === "myco://tray-action") || command === "tray_panel_action") {
            const request = command === "tray_panel_action" ? { action: args.action, scope: args.scope, requestId: args.requestId } : args.payload;
            window.__boundaryView.requests.push(request);
            await window.__deliverBoundaryAction(request);
            if (command === "tray_panel_action") return null;
          }
          return invoke(command, args);
        };
        window.__mycoMock.emit("myco://tray-status", snapshot);
      }, { surface, scenario });
      if (surface === "notch") await view.hover(".notch");
      const approve = view.getByRole("button", { name: surface === "notch" ? "Approve — Synthetic proposal" : "Approve", exact: true });
      await approve.waitFor();
      await approve.click();
      if (scenario === "read-failure") {
        await writer.waitForFunction(() => typeof window.__boundaryFixture.rejectRead === "function");
        check(await approve.isDisabled(), "tray: pending writer disables duplicate approval");
        check(await view.getByRole("status").filter({ hasText: "Waiting for writer" }).count() === 1, "tray: pending status never claims completion");
        await view.evaluate(() => window.__mycoMock.emit("myco://tray-action-result", { requestId: "unrelated-reply", ok: true }));
        await view.waitForTimeout(100);
        check(await approve.isDisabled() && await view.locator(".tray-toast").count() === 0, "tray: unrelated success cannot hide or toast a pending proposal");
        await writer.evaluate(() => window.__boundaryFixture.rejectRead());
      }
      await writer.waitForFunction(() => window.__boundaryFixture.replies.length > 0);
      const result = await writer.evaluate(async () => {
        const { useVaultStore } = await window.__importAppModule("/src/stores/vaultStore.ts");
        const { useDistillStore } = await window.__importAppModule("/src/stores/distillStore.ts");
        const { currentVault, vaultToken, isOpeningVault } = useVaultStore.getState();
        return { ...window.__boundaryFixture, active: { path: currentVault?.path, vaultToken, isOpeningVault }, error: useDistillStore.getState().error };
      });
      const request = await view.evaluate(() => window.__boundaryView.requests[0]);
      const success = scenario === "success";
      console.log(JSON.stringify({ surface, scenario, scope: request.scope, active: result.active, error: result.error, effects: result.effects, replies: result.replies, rawStatus: result.raw.match(/status: (\w+)/)?.[1] }));
      check(request.scope?.vaultToken === (scenario === "reopened" ? "scope-b-previous" : scenario === "different-vault" ? "scope-a" : "scope-b-current"), `${surface}/${scenario}: sender retains rendered source scope`);
      check(result.effects.length === (success ? 2 : 0), `${surface}/${scenario}: only current successfully processed intent writes/applies`);
      check(result.replies.at(-1).ok === success, `${surface}/${scenario}: actual App broker acknowledgement matches execution`);
      if (!success) check(/status: pending/.test(result.raw), `${surface}/${scenario}: rejected intent preserves the proposal`);
      if (surface === "notch" && scenario === "reopened") {
        await writer.evaluate(() => window.__mycoMock.emit("myco://tray-action", { action: "proposal-approve:work/feedback/shared-proposal.md", requestId: "synthetic-unscoped" }));
        await writer.waitForFunction(() => window.__boundaryFixture.replies.some((reply) => reply.requestId === "synthetic-unscoped"));
        const unscoped = await writer.evaluate(() => ({ effects: window.__boundaryFixture.effects.length, reply: window.__boundaryFixture.replies.at(-1) }));
        check(unscoped.effects === 0 && unscoped.reply.ok === false, "App broker: legacy unscoped mutation fails closed with a negative matching acknowledgement");
      }
      if (surface === "notch" && success) {
        await writer.evaluate(() => {
          window.__boundaryFixture.effects = [];
          window.__boundaryFixture.replies = [];
          window.__boundaryFixture.raw = window.__boundaryFixture.raw.replace("status: approved", "status: pending");
          window.__mycoMock.emit("myco://tray-action", { action: "proposal-approve:work/feedback/shared-proposal.md", scope: { vaultPath: "/synthetic-b", vaultToken: "scope-b-current" } });
        });
        await writer.waitForFunction(() => window.__boundaryFixture.effects.length === 2);
        check(await writer.evaluate(() => window.__boundaryFixture.replies.length === 0), "App broker: current scoped native envelope executes without requiring an acknowledgement id");
      }
      if (surface === "tray") {
        await view.waitForFunction(() => !document.querySelector(".tray-now button")?.disabled);
        check(await view.locator(".tray-now:not(.is-gone)").count() === 1, `tray/${scenario}: unchanged authoritative proposal stays visible`);
        if (!success) {
          check(await view.getByRole("status").filter({ hasText: "Writer did not complete" }).count() === 1, `tray/${scenario}: rejection remains visible and retryable`);
          check(await view.locator(".tray-toast").count() === 0, `tray/${scenario}: rejected action emits no approval toast`);
        }
        if (scenario === "read-failure") {
          await approve.click();
          await writer.waitForFunction(() => window.__boundaryFixture.replies.length === 2);
          const retry = await writer.evaluate(() => window.__boundaryFixture);
          check(retry.replies[1].ok === true && retry.effects.length === 2, "tray: retry invokes the same proposal once after a real writer failure");
          await view.locator(".tray-toast").waitFor();
          check(await view.locator(".tray-now").count() === 1, "tray: even confirmed success waits for authoritative source removal");
        }
        // A status listener updates its latest ref before React commits: the
        // previous DOM handler must not capture that newer scope as its origin.
        const before = await view.evaluate(() => window.__boundaryView.requests.length);
        await view.evaluate(() => {
          const oldButton = document.querySelector(".tray-now button");
          const fixture = window.__boundaryView;
          fixture.snapshot = { ...fixture.snapshot, panel: { ...fixture.snapshot.panel, actionScope: { vaultPath: "/synthetic-c", vaultToken: "scope-c" } } };
          window.__mycoMock.emit("myco://tray-status", fixture.snapshot);
          oldButton.click();
        });
        await view.waitForTimeout(100);
        check(await view.evaluate(() => window.__boundaryView.requests.length) === before, `tray/${scenario}: old rendered click cannot adopt a new listener scope`);
        await view.waitForTimeout(350);
        check(await view.locator(".tray-toast").count() === 0, `tray/${scenario}: old approval timers do not paint in the next vault`);
      }
      check(errors.length === 0, `${surface}/${scenario}: no browser error or unhandled rejection`);
      await context.close();
    }
  }
  console.log(`${checks} checks passed (synthetic webviews/IPC, not native writes)`);
} finally {
  await browser.close();
}
