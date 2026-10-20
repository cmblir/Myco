// Synthetic browser IPC regression; never opens or mutates a native vault.
// Usage: MYCO_TEST_URL=http://127.0.0.1:5173 node scripts/harvest-workflow-smoke.mjs
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = new URL(process.env.MYCO_TEST_URL ?? "http://127.0.0.1:5173");
const loopback = ["127.0.0.1", "localhost", "[::1]"];
assert.ok(loopback.includes(base.hostname), "Use a loopback development server");
const browser = await chromium.launch();
try {
  for (const fault of ["none", "archive", "held"]) {
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
      localStorage.setItem("myco-ui", JSON.stringify({ version: 3, state: { lang: "ko", theme: "light" } }));
    });
    const url = new URL(base);
    url.search = "?mock=1&local=1&nowriter=1";
    await page.goto(url.toString());
    await page.locator(".home-page").waitFor();
    await page.evaluate(async (fault) => {
      if (!window.__mycoMock || !window.__TAURI_INTERNALS__) throw new Error("Synthetic IPC mock is required");
      const original = window.__TAURI_INTERNALS__.invoke;
      const queue = await original("harvest_candidates", { limit: 20, vaultPath: "/myco" });
      const target = `/myco/_inbox/${queue.items[0].path.split("/").pop()}`;
      const before = window.__mycoMock.inbox();
      window.__harvestFixture = { fault, target, attempts: 0, trace: [], before, selected: queue.items.length };
      window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
        const fixture = window.__harvestFixture;
        if (cmd === "archive_inbox_source" && args.path === target && fixture.fault === "archive" && fixture.attempts++ === 0) {
          throw new Error("Synthetic archive failure");
        }
        if (cmd === "scan_text_secrets" && fixture.fault === "held" && String(args.text).includes(queue.items[0].title)) {
          return { secrets: [{ kind: "synthetic-policy-fixture" }], pii: [] };
        }
        const value = await original(cmd, args);
        if (["harvest_run", "write_file", "write_file_if_unchanged", "archive_inbox_source"].includes(cmd)) {
          fixture.trace.push({ cmd, path: args.path, completeHarvest: args.completeHarvest });
        }
        return value;
      };
    }, fault);
    await page.locator(".home-management-toggle").click();
    const card = page.getByTestId("harvest-queue");
    await card.waitFor();
    async function run() {
      await card.getByRole("button", { name: /^\d+개 수확$/, exact: true }).click();
      await card.getByRole("button", { name: "실행", exact: true }).click();
      await card.getByRole("group", { name: "실행 계획 — 아직 아무것도 만들지 않았습니다", exact: true })
        .waitFor({ state: "detached", timeout: 60000 });
    }
    await run();
    const first = await page.evaluate(async () => ({
      ...window.__harvestFixture,
      inbox: window.__mycoMock.inbox(),
      pending: (await window.__TAURI_INTERNALS__.invoke("harvest_candidates", { limit: 20, vaultPath: "/myco" })).items.length,
    }));
    const completed = first.trace.filter((entry) => entry.cmd === "archive_inbox_source" && entry.completeHarvest === true);
    assert.ok(first.selected > 1, "Use multiple selected fixture sources");
    assert.equal(completed.length, first.selected - (fault === "none" ? 0 : 1));
    assert.equal(first.pending, fault === "none" ? 0 : 1);
    for (const unrelated of first.before) assert.ok(first.inbox.includes(unrelated));
    if (fault !== "none") {
      assert.ok(first.inbox.includes(first.target), "Failed/held copy must remain retryable");
      assert.equal(await card.getByRole("button", { name: "1개 수확", exact: true }).count(), 1);
      assert.equal(await page.locator(".notice-stack .notice.is-ok").count(), 0, "Partial work cannot show a success notice");
      if (fault === "held") {
        const rawPath = first.target.replace("/_inbox/", "/raw/");
        assert.ok(!first.trace.some((entry) => entry.cmd === "write_file" && entry.path === rawPath), "Held source cannot enter immutable raw");
      }
      await page.evaluate(() => { window.__harvestFixture.fault = "none"; });
      await run();
    }
    const coverage = await page.evaluate(async () => {
      // Pure evidence helpers have no store instance; do not import UI stores.
      const { sourceEvidence, completedEvidenceSources } = await import("/src/lib/sessionEvidence.ts");
      const paths = [...new Set(window.__harvestFixture.trace.filter((entry) => entry.cmd === "write_file_if_unchanged" && entry.path?.includes("/wiki/source-")).map((entry) => entry.path))];
      const checks = [];
      for (const path of paths) {
        const note = await window.__TAURI_INTERNALS__.invoke("read_file", { path });
        const rawRel = note.raw.match(/"source":"([^"]+)"/)[1];
        const source = await window.__TAURI_INTERNALS__.invoke("read_file", { path: `/myco/${rawRel}` });
        const body = source.raw.slice(source.raw.indexOf("\n\n") + 2).trim();
        const evidence = sourceEvidence(rawRel, body, "2026-10-04");
        checks.push({ chunks: evidence.chunks.length, complete: completedEvidenceSources([evidence], note.raw).length === 1 });
      }
      const pending = await window.__TAURI_INTERNALS__.invoke("harvest_candidates", { limit: 20, vaultPath: "/myco" });
      return { checks, pending: pending.items.length, inbox: window.__mycoMock.inbox(), selected: window.__harvestFixture.selected };
    });
    assert.equal(coverage.checks.length, coverage.selected);
    assert.ok(coverage.checks.every((check) => check.complete), "All chunks, including long tails, must have valid evidence receipts");
    assert.ok(Math.max(...coverage.checks.map((check) => check.chunks)) > 48, "Exercise more than one evidence batch");
    assert.equal(coverage.pending, 0);
    assert.deepEqual(coverage.inbox, first.before);
    assert.deepEqual(errors, []);
    console.log(`PASS ${fault}: ${coverage.selected} sources / ${coverage.checks.reduce((sum, check) => sum + check.chunks, 0)} chunks; exact selection, full coverage, retry and unrelated inbox preservation (mock IPC)`);
    await context.close();
  }
} finally {
  await browser.close();
}
