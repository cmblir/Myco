// Grounded synthetic deck review, FSRS persistence, extractive quiz and card preview.
// No native disk, account or model calls are exercised.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
const base = process.env.MYCO_TEST_URL ?? "http://127.0.0.1:5173";
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname));
const output = process.env.MYCO_SCREENSHOTS ?? "/tmp/myco-study-workflows";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: !process.argv.includes("--headed"),
});
let checks = 0;
const deckPath = "/myco/cards/attention-mechanism.md";
try {
  for (const width of [375, 768, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/*", (r) => {
      const u = new URL(r.request().url());
      return ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) ||
        !["http:", "https:"].includes(u.protocol)
        ? r.continue()
        : r.abort("blockedbyclient");
    });
    await page.addInitScript(() => {
      localStorage.setItem("myco.onboarded", "1");
      localStorage.setItem(
        "myco-ui",
        JSON.stringify({
          version: 3,
          state: { lang: "en", theme: "light", aiCards: false },
        }),
      );
    });
    const read = () =>
      page.evaluate(
        async (path) =>
          (await window.__TAURI_INTERNALS__.invoke("read_file", { path })).raw,
        deckPath,
      );
    async function navigateStudy() {
      if (await page.locator(".app.sidebar-collapsed").count())
        await page.getByTitle(/^Toggle sidebar/).click();
      const more = page
        .locator(".side-nav")
        .getByRole("button", { name: /^More tools/ });
      if ((await more.getAttribute("aria-expanded")) === "false")
        await more.click();
      await page
        .locator(".side-nav .nav-item")
        .filter({ has: page.locator(".ni-text", { hasText: /^Study$/ }) })
        .click();
      await page.locator(".deck-row").first().waitFor();
    }
    try {
      await page.goto(base + "/?mock=1", { waitUntil: "domcontentloaded" });
      await page.locator(".home-page").waitFor();
      await navigateStudy();
      const deck = page
        .locator(".deck-row")
        .filter({
          has: page.locator(".deck-row__name", {
            hasText: /^attention-mechanism$/,
          }),
        });
      assert.match(await deck.innerText(), /2 cards\n2 due/);
      checks++;
      assert.match(
        await page.locator(".route-fade").innerText(),
        /2 review cards are due/,
      );
      checks++;
      const before = await read();
      const originalFronts = before
        .split("\n")
        .filter((line) => line.includes(" ?? "));
      assert.equal(originalFronts.length, 2);
      checks++;
      await page
        .getByRole("button", { name: "Start review", exact: true })
        .click();
      await page.locator(".study-card").waitFor();
      for (let i = 0; i < 2; i++) {
        assert.match(
          await page.locator(".route-fade").innerText(),
          new RegExp(i + 1 + " / 2"),
        );
        checks++;
        await page.locator(".study-flip").click();
        await page.locator(".study-back").waitFor();
        assert.match(await page.locator(".study-card").innerText(), /Source:/);
        checks++;
        await page.getByRole("button", { name: /^Remembered/ }).click();
      }
      await page.locator(".study-done").waitFor();
      checks++;
      await page.waitForFunction(async (path) => {
        const raw = (
          await window.__TAURI_INTERNALS__.invoke("read_file", { path })
        ).raw;
        return (
          [
            ...raw.matchAll(
              /<!--SR:!([^|]+)\|[^|]+\|[^|]+\|(\d+)\|[^|]+\|([^|]+)\|/g,
            ),
          ].filter((match) => Number(match[2]) === 2).length === 2
        );
      }, deckPath);
      const persisted = await read();
      assert.deepEqual(
        persisted.split("\n").filter((line) => line.includes(" ?? ")),
        originalFronts,
      );
      checks++;
      const state = [
        ...persisted.matchAll(
          /<!--SR:!([^|]+)\|[^|]+\|[^|]+\|(\d+)\|[^|]+\|([^|]+)\|/g,
        ),
      ];
      assert.equal(state.length, 2);
      checks++;
      const today = await page.evaluate(() => {
        const d = new Date();
        return [
          d.getFullYear(),
          String(d.getMonth() + 1).padStart(2, "0"),
          String(d.getDate()).padStart(2, "0"),
        ].join("-");
      });
      assert.ok(state.every((match) => match[1] > today && match[3] === today));
      checks++;
      await page
        .getByRole("button", { name: "All decks", exact: true })
        .click();
      await deck.waitFor();
      assert.match(await deck.innerText(), /All caught up/);
      checks++;
      assert.equal(
        await page
          .getByRole("button", { name: "Start review", exact: true })
          .count(),
        0,
      );
      checks++;
      await deck.locator(".deck-row__open").click();
      await page.getByRole("button", { name: "Quiz", exact: true }).click();
      await page
        .getByRole("button", { name: "Generate quiz", exact: true })
        .click();
      await page.locator(".quiz-choice").first().waitFor();
      assert.ok((await page.locator(".quiz-choice").count()) >= 3);
      checks++;
      await page.locator(".quiz-choice").first().click();
      assert.match(
        await page.locator(".route-fade").innerText(),
        /Correct|Not quite/,
      );
      checks++;
      assert.equal(
        await page.locator(".quiz-choice:not(:disabled)").count(),
        0,
      );
      checks++;
      await page.locator(".study-src-link").click();
      await page.locator(".reader-head").waitFor();
      await page.getByRole("button", { name: "More", exact: true }).click();
      await page
        .getByRole("menuitem", { name: "Make cards", exact: true })
        .click();
      const preview = page.getByRole("dialog", { name: "Cards from this note", exact: true });
      await preview.waitFor();
      assert.match(await preview.innerText(), /Cards from this note/);
      checks++;
      assert.ok((await preview.locator(".card-preview .is-dupe").count()) >= 2);
      checks++;
      const selected = await preview
        .getByRole("checkbox", { checked: true })
        .count();
      assert.ok(selected > 0);
      checks++;
      await preview.getByRole("button", { name: "Save", exact: true }).click();
      await preview.waitFor({ state: "detached" });
      await page.waitForFunction(() =>
        /\d+ cards added/.test(
          document.querySelector(".reader")?.textContent ??
            document.body.textContent,
        ),
      );
      const expanded = await read();
      assert.equal(
        expanded.split("\n").filter((line) => line.includes(" ?? ")).length,
        2 + selected,
      );
      checks++;
      assert.ok(state.every((match) => expanded.includes(match[0])));
      checks++;
      await page.getByRole("button", { name: "More", exact: true }).click();
      await page
        .getByRole("menuitem", { name: "Make cards", exact: true })
        .click();
      await page.waitForFunction(() =>
        document.body.textContent.includes("already"),
      );
      assert.equal(await page.getByRole("dialog", { name: "Cards from this note", exact: true }).count(), 0);
      checks++;
      assert.equal(await read(), expanded);
      checks++;
      await navigateStudy();
      assert.match(await deck.innerText(), new RegExp(selected + " due"));
      checks++;
      assert.deepEqual(errors, []);
      checks++;
      await page.screenshot({ path: output + "/" + width + ".png" });
      console.log(
        "PASS " +
          width +
          "px grounded review/FSRS/revisit/quiz/card preview/dedup (mock IPC)",
      );
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
console.log(
  checks +
    " assertions passed; model and native filesystem behavior are not exercised.",
);
