// Form behavior with synthetic IPC. No native vault or model is exercised.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = new URL(process.env.MYCO_TEST_URL ?? "http://127.0.0.1:5173");
const loopback = ["127.0.0.1", "localhost", "[::1]"];
assert.ok(loopback.includes(base.hostname), "Use a loopback development server");
const browser = await chromium.launch();
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; console.log(`PASS ${message}`); };

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
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
  base.search = "?mock=1&local=1&nowriter=1";
  await page.goto(base.toString());
  await page.locator(".home-management-toggle").waitFor();
  const navigate = async (route) => {
    await page.evaluate(async (route) => {
      if (!window.__mycoMock) throw new Error("Synthetic IPC is required");
      const { useUIStore } = await import("/src/stores/uiStore.ts");
      useUIStore.getState().setRoute(route);
    }, route);
    if (route === "ingest") await page.locator("#ingest-body").waitFor();
    else await page.locator("#ingest-body").waitFor({ state: "detached" });
  };
  await navigate("ingest");
  await page.locator("#ingest-title").fill("Synthetic source A");
  await page.locator("#ingest-body").fill("Synthetic text preserved across navigation and restart.");
  for (const route of ["query", "settings", "page:/myco/wiki/transformer-architecture.md"]) {
    await navigate(route);
    await navigate("ingest");
    check(await page.locator("#ingest-title").inputValue() === "Synthetic source A", `${route}: title retained`);
    check(await page.locator("#ingest-body").inputValue() === "Synthetic text preserved across navigation and restart.", `${route}: body retained`);
  }
  await page.reload();
  await page.locator(".sidebar").waitFor();
  await navigate("ingest");
  check(await page.locator("#ingest-body").inputValue() === "Synthetic text preserved across navigation and restart.", "fresh renderer restores durable draft");

  await page.evaluate(async () => {
    const { useVaultStore } = await import("/src/stores/vaultStore.ts");
    window.ingestOriginalVault = useVaultStore.getState().currentVault;
    useVaultStore.setState({ currentVault: { ...window.ingestOriginalVault, path: "/synthetic/vault-b" }, vaultToken: crypto.randomUUID() });
  });
  await page.waitForFunction(() => document.querySelector("#ingest-body")?.value === "");
  await page.locator("#ingest-body").fill("Separate synthetic B draft");
  await page.evaluate(async () => {
    const { useVaultStore } = await import("/src/stores/vaultStore.ts");
    useVaultStore.setState({ currentVault: window.ingestOriginalVault, vaultToken: crypto.randomUUID() });
  });
  await page.waitForFunction(() => document.querySelector("#ingest-title")?.value === "Synthetic source A");
  check(await page.locator("#ingest-body").inputValue() === "Synthetic text preserved across navigation and restart.", "vault switch restores only the originating draft");

  await page.evaluate(() => {
    window.ingestOriginalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("myco.ingestDraft.")) throw new DOMException("Synthetic quota failure", "QuotaExceededError");
      return window.ingestOriginalSetItem.call(this, key, value);
    };
  });
  await page.locator("#ingest-body").fill("Keep synthetic text despite quota failure");
  await page.locator('[data-testid="ingest-draft-storage-error"]').waitFor();
  await navigate("query");
  await navigate("ingest");
  check(await page.locator("#ingest-body").inputValue() === "Keep synthetic text despite quota failure", "quota failure preserves in-memory input across navigation");
  await page.evaluate(() => { Storage.prototype.setItem = window.ingestOriginalSetItem; });
  await page.getByRole("button", { name: "Retry draft storage", exact: true }).click();
  await page.locator('[data-testid="ingest-draft-storage-error"]').waitFor({ state: "detached" });
  await page.reload();
  await page.locator(".sidebar").waitFor();
  await navigate("ingest");
  check(await page.locator("#ingest-body").inputValue() === "Keep synthetic text despite quota failure", "retry persists input for the next renderer");
  await page.locator(".intake-submit").getByRole("button", { name: "Clear text", exact: true }).click();
  check(await page.locator("#ingest-body").inputValue() === "", "explicit discard clears the current draft");
  for (const outcome of ["success", "partial", "failed", "newer"]) {
    await page.evaluate(async (outcome) => {
      const { useIngestStore } = await import("/src/stores/ingestStore.ts");
      useIngestStore.getState().reset();
      useIngestStore.setState({ startIngest: async () => {
        const runId = crypto.randomUUID();
        useIngestStore.setState({ runId, stage: "writing-raw", workflowStatus: null, vaultPath: "/myco" });
        await new Promise((resolve) => {
          window.finishIngestDraftFixture = () => {
            useIngestStore.setState({ runId, stage: outcome === "failed" ? "error" : "done",
              workflowStatus: outcome === "newer" ? "success" : outcome });
            resolve();
          };
        });
      } });
    }, outcome);
    await page.locator("#ingest-body").fill(`Synthetic submitted ${outcome} source`);
    await page.locator(".intake-submit .btn-primary").click();
    await navigate("query");
    await page.evaluate(async (outcome) => {
      if (outcome === "newer") {
        const { useIngestDraftStore } = await import("/src/stores/ingestDraftStore.ts");
        useIngestDraftStore.getState().edit("/myco", { body: "Newer synthetic source" });
      }
      window.finishIngestDraftFixture();
    }, outcome);
    await navigate("ingest");
    const expected = outcome === "success" ? "" : outcome === "newer" ? "Newer synthetic source" : `Synthetic submitted ${outcome} source`;
    check(await page.locator("#ingest-body").inputValue() === expected, `${outcome}: background completion clears only its successful unchanged draft`);
  }
  check(errors.length === 0, `no browser errors: ${errors.join("; ")}`);
  console.log(`${checks} checks passed (synthetic IPC only)`);
} finally {
  await browser.close();
}
