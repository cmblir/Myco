// UI regression with synthetic IPC evidence. Does not open a real vault or
// measure embedding quality; the native E5 evaluation covers retrieval itself.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const output = "/tmp/myco-knowledge-ui";
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
let checks = 0;
try {
  for (const width of [375, 768, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, timezoneId: "Asia/Seoul" });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem("myco.onboarded", "1");
      localStorage.setItem("myco-ui", JSON.stringify({ version: 3, state: { lang: "en", theme: "light" } }));
    });
    await page.goto("http://127.0.0.1:5173/?mock=1");
    await page.locator(".home-page").waitFor();
    await page.evaluate(() => {
      window.__mycoMock.settings({ query_provider: "builtin-local", query_model: "extractive-retrieval" });
      window.__recallCalls = [];
      window.__recallFileReads = [];
      const original = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = (command, args) => {
        if (command === "semantic_search") {
          window.__recallCalls.push(args);
          return Promise.resolve({ floor: 0.42, below_floor: [], hits: [{
            page: "raw/conversations/claude/synthetic-r1.md", stem: "synthetic-r1", section: 3,
            text: "On 2026-09-17 we decided to use SYN-4719. This is the recorded decision; execution is not confirmed.",
            similarity: 0.65, score: 0.032, score_rrf: 0.032, exact_match: true,
          }] });
        }
        if (command === "read_file") {
          window.__recallFileReads.push(args.path);
          if (args.path.endsWith("/raw/conversations/claude/synthetic-r1.md")) return Promise.resolve({
            path: args.path, raw: "# Synthetic source\n\nSYN-4719 was proposed on 2026-09-17.",
            content: "SYN-4719 was proposed on 2026-09-17.", frontmatter: null,
          });
        }
        return original(command, args);
      };
    });
    const askNav = width <= 768 ? page.locator(".phone-tabbar") : page.locator(".side-nav");
    // Both navigation surfaces expose the same accessible Ask label.
    const ask = askNav.getByRole("button", { name: "Ask", exact: true });
    if (await ask.count()) await ask.click();
    else await page.locator(".side-nav .nav-item").filter({ hasText: /^Ask$/ }).click();
    const input = page.locator(".ask-composer input.input");
    await input.fill("From 2026-09-01 to 2026-09-30, what did we decide about SYN-4719?");
    await input.press("Enter");
    const quote = page.locator("#ask-turn-0-body").getByText(/On 2026-09-17 we decided to use SYN-4719/);
    await quote.waitFor();
    const calls = await page.evaluate(() => window.__recallCalls);
    assert.equal(calls.at(-1).scope, "all");
    assert.deepEqual(calls.at(-1).range, {
      start: "2026-09-01", end: "2026-09-30",
      startEpoch: Date.parse("2026-09-01T00:00:00+09:00") / 1000,
      endEpoch: Date.parse("2026-10-01T00:00:00+09:00") / 1000,
    });
    assert.ok(Object.values(calls.at(-1).tierWeights).every(weight => weight === 1));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `${output}/recall-${width}.png`, fullPage: true });
    await page.locator("details.ask-scope summary").click();
    await page.locator(".ask-scope__menu button").filter({ hasText: "My notes" }).click();
    await input.fill("What did we decide about SYN-4719?");
    await input.press("Enter");
    await page.locator("#ask-turn-1-body").getByText(/On 2026-09-17 we decided/).waitFor();
    assert.equal((await page.evaluate(() => window.__recallCalls)).at(-1).scope, "wiki");
    await page.locator(".ask-turn .ask-cite").first().click();
    await page.waitForFunction(() => window.__recallFileReads.some(path => path.endsWith("/raw/conversations/claude/synthetic-r1.md")));
    await input.waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("myco-ui")).state.isAskScopeExplicit), true);
    // Re-mount Ask after opening a source: the selected wiki restriction is
    // persisted, rather than held in this page's old component instance.
    if (await ask.count()) await ask.click();
    else await page.locator(".side-nav .nav-item").filter({ hasText: /^Ask$/ }).click();
    await input.fill("What did we decide about SYN-4719?");
    await input.press("Enter");
    await page.locator("#ask-turn-2-body").getByText(/On 2026-09-17 we decided/).waitFor();
    assert.equal((await page.evaluate(() => window.__recallCalls)).at(-1).scope, "wiki");
    console.log(`PASS ${width}: personal history uses all tiers, keeps dates/source paths and preserves explicit scope across navigation`);
    checks += 9;
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(`${checks} checks passed (synthetic UI fixture)`);
