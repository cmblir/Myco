// Synthetic Ask staging and zero-dense lexical regressions. No native app,
// models or vault writes: the real UI consumes explicitly held mock IPC.
// Usage: node scripts/ask-stages-smoke.mjs [--headed]
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = new URL(process.env.MYCO_TEST_URL ?? "http://127.0.0.1:5173");
const loopback = ["127.0.0.1", "localhost", "[::1]"];
assert.ok(loopback.includes(base.hostname), "Use a loopback development server");
const browser = await chromium.launch({ headless: !process.argv.includes("--headed") });
const results = [];
const check = (n, ok, d = "") => results.push({ n, ok, d });

async function askAndWatch(mode) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const blockedResources = new Set();
  await context.route("**/*", (route) => {
    const target = new URL(route.request().url());
    if (loopback.includes(target.hostname) || !["http:", "https:"].includes(target.protocol)) return route.continue();
    blockedResources.add(target.href);
    return route.abort("blockedbyclient");
  });
  await context.addInitScript(() => {
    localStorage.setItem("myco.onboarded", "1");
    localStorage.setItem("myco-ui", JSON.stringify({ state: { lang: "en", theme: "light" }, version: 3 }));
    window.__importAppModule = (path) => {
      const entry = performance.getEntriesByType("resource").filter((resource) => new URL(resource.name).pathname === path).at(-1);
      if (!entry) throw new Error(`App module was not loaded: ${path}`);
      return import(entry.name);
    };
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    // Deliberate remote-resource isolation is a fixture result, not an app error.
    if (message.text().includes("ERR_BLOCKED_BY_CLIENT") && blockedResources.has(message.location().url)) return;
    errors.push(`${message.text()} (${message.location().url})`);
  });
  await page.goto(new URL("/?mock=1", base).toString());
  await page.locator(".side-nav .nav-item").first().waitFor();
  await page.waitForFunction(async () => {
    const { useVaultStore } = await window.__importAppModule("/src/stores/vaultStore.ts");
    return useVaultStore.getState().currentVault !== null && !useVaultStore.getState().isOpeningVault;
  });
  await page.evaluate((mode) => {
    window.__mycoMock.settings({ query_provider: "builtin-local", query_model: "extractive-retrieval" });
    window.__mycoMock.indexedPages(mode === "dense" ? 51 : 0);
  }, mode);
  await page.locator(".side-nav .nav-item", { hasText: /^Ask$/ }).first().click();
  await page.locator("input.input").first().waitFor();
  await page.evaluate((mode) => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__stageFixture = { mode, statusCalls: 0, searches: [], pending: false };
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      const fixture = window.__stageFixture;
      if (command === "embeddings_status") {
        fixture.statusCalls++;
        await new Promise((resolve) => { fixture.releaseStatus = resolve; });
      }
      if (command === "semantic_search") {
        fixture.searches.push(args);
        fixture.pending = true;
        await new Promise((resolve) => { fixture.releaseSearch = resolve; });
        try {
          if (mode === "failure") throw new Error("Synthetic lexical IPC failure");
          if (mode === "lexical") return { floor: 0.42, below_floor: [], hits: [{
            page: "wiki/synthetic-recall.md", stem: "synthetic-recall", section: 0,
            text: "SYN-4719 was accepted by the synthetic writer.", score: 0.02,
            similarity: null, exact_match: true,
          }] };
          if (mode === "unverified") return { floor: 0.42, below_floor: [], hits: [{
            page: "wiki/synthetic-noise.md", stem: "synthetic-noise", section: 0,
            text: "UNVERIFIED-DENSE-SYN must never become quoted evidence.", score: 0.02,
            similarity: 0.99, exact_match: false,
          }] };
          if (mode === "empty") return { floor: 0.42, below_floor: [], hits: [] };
          return await invoke(command, args);
        } finally {
          fixture.pending = false;
        }
      }
      return invoke(command, args);
    };
  }, mode);
  await page.locator("input.input").first().fill(mode === "lexical" ? "SYN-4719" : "what is attention?");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__stageFixture.statusCalls === 1);
  await page.waitForTimeout(100);
  const before = await page.locator(".thinking-galaxy").first().getAttribute("aria-label");
  check(`${mode}: waiting for index health does not claim a search`, before !== "searching the wiki…", String(before));
  await page.evaluate(() => window.__stageFixture.releaseStatus());
  await page.waitForFunction(() => window.__stageFixture.pending);
  await page.waitForTimeout(150);
  const during = await page.locator(".thinking-galaxy").first().getAttribute("aria-label");
  check(`${mode}: searching is shown during actual held retrieval IPC`, during === "searching the wiki…", String(during));
  check(`${mode}: the extractive path never claims model generation from pages`, !/answering from/.test(`${before} ${during}`));
  await page.evaluate(() => window.__stageFixture.releaseSearch());
  await page.waitForFunction(async () => !(await window.__importAppModule("/src/stores/queryStore.ts")).useQueryStore.getState().busy);
  await page.locator(".thinking-galaxy").waitFor({ state: "detached" });
  check(`${mode}: searching leaves when the IPC settles`, await page.locator(".thinking-galaxy").count() === 0);
  const snapshot = await page.evaluate(async () => ({
    turn: (await window.__importAppModule("/src/stores/queryStore.ts")).useQueryStore.getState().turns.at(-1),
    searches: window.__stageFixture.searches,
    statusCalls: window.__stageFixture.statusCalls,
    copy: (await window.__importAppModule("/src/lib/i18n.ts")).STRINGS.en,
  }));
  check(`${mode}: one question performs one health read and one scoped search`, snapshot.statusCalls === 1 && snapshot.searches.length === 1 && snapshot.searches[0].scope === "wiki");
  const details = page.locator(".ask-sources__toggle").first();
  if (await details.count()) await details.click();
  const answer = await page.locator(".workspace").innerText();
  check(`${mode}: no browser errors or unhandled rejection`, errors.length === 0, errors.join(" | "));
  console.log(JSON.stringify({ mode, deliberatelyBlockedRemoteResources: [...blockedResources] }));
  await context.close();
  return { ...snapshot, answer };
}

try {
  const dense = await askAndWatch("dense");
  check("current dense answers quote actual fixture notes rather than a model reply", /From your notes/.test(dense.answer) && !/local model reply/.test(dense.answer));
  check("dense relevance remains available in source details", /\d+%/.test(dense.answer));

  const lexical = await askAndWatch("lexical");
  check("zero dense pages still quote verified lexical evidence", lexical.turn.a.includes("> SYN-4719 was accepted by the synthetic writer.") && lexical.answer.includes("SYN-4719 was accepted"));
  check("the lexical answer preserves its exact source path", lexical.turn.a.includes("[[wiki/synthetic-recall|synthetic-recall]]"));
  check("lexical evidence has no invented dense cosine and does not abstain", lexical.turn.hits?.[0]?.similarity === null && lexical.turn.hits[0].exact_match === true && !lexical.turn.abstained);

  const unverified = await askAndWatch("unverified");
  check("zero dense rejects an unverified simulated high-cosine hit", unverified.turn.abstained === true && !unverified.turn.hits?.length);
  check("the rejected dense text never becomes an answer quote", !unverified.turn.a.includes("UNVERIFIED-DENSE-SYN"));
  check("rejected evidence remains visible as a near miss", unverified.turn.nearMisses?.some((hit) => hit.page === "wiki/synthetic-noise.md"));

  const empty = await askAndWatch("empty");
  check("zero dense and an empty lexical search abstain honestly", empty.turn.abstained === true && !empty.turn.hits?.length);
  check("empty lexical search is not an IPC error or a stale-index answer", empty.turn.a === empty.copy.q_extractive_empty && !empty.turn.retrievalFailed && !empty.turn.stale);

  const failure = await askAndWatch("failure");
  check("zero-dense lexical IPC failure is reported as failure", failure.turn.retrievalFailed === true && !failure.turn.hits?.length);
  check("a failed search never claims that the records contain nothing", failure.turn.a === failure.copy.q_extractive_failed && failure.turn.a !== failure.copy.q_extractive_empty);
} finally {
  await browser.close();
}
for (const result of results) console.log(`${result.ok ? "PASS" : "FAIL"} ${result.n}${result.d ? ` — ${result.d}` : ""}`);
const failed = results.filter((result) => !result.ok).length;
console.log(`${results.length - failed}/${results.length} passed (synthetic UI/IPC; no native model or vault)`);
process.exitCode = failed ? 1 : 0;
