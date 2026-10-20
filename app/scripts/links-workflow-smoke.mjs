// Synthetic browser IPC regression. Never opens or writes a real vault.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch();
let checks = 0;
try {
  for (const width of [375, 768, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem("myco.onboarded", "1");
      localStorage.setItem("myco-ui", JSON.stringify({ version: 3, state: { lang: "en", theme: "light" } }));
    });
    await page.goto("http://127.0.0.1:5173/?mock=1");
    await page.locator(".home-page").waitFor();
    await page.evaluate(async () => {
      const { useLinkSuggestStore } = await import("/src/stores/linkSuggestStore.ts");
      const root = "/myco/wiki/synthetic-";
      const sem = [
        { source: `${root}a.md`, target: `${root}b.md`, score: 0.9 },
        { source: `${root}a.md`, target: `${root}c.md`, score: 0.8 },
        { source: `${root}x.md`, target: `${root}y.md`, score: 0.7 },
      ];
      window.__linkFixture = { sem, reads: [], writes: [], failures: 1, files: {} };
      const original = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = async (command, args) => {
        const fixture = window.__linkFixture;
        if (command === "semantic_edges") return fixture.sem;
        if (command === "read_file" && args.path.startsWith(root)) {
          fixture.reads.push(args.path);
          return { path: args.path, raw: fixture.files[args.path] ?? "# synthetic note\n", content: "synthetic note", frontmatter: null };
        }
        if (command === "write_file_if_unchanged" && args.path.startsWith(root)) {
          if (args.path === `${root}x.md` && fixture.failures-- > 0) throw new Error("Synthetic disk failure");
          fixture.writes.push(args.path);
          fixture.files[args.path] = args.content;
          return null;
        }
        return original(command, args);
      };
      useLinkSuggestStore.setState({ sem, dismissed: new Set(), error: null });
    });
    await page.locator(".home-management-toggle").click();
    const card = page.locator(".link-suggestions");
    await card.getByRole("button", { name: "Accept all (3)", exact: true }).click();
    const retry = page.locator(".notice-stack").getByRole("button", { name: "Retry", exact: true });
    await retry.waitFor();
    await card.getByRole("button", { name: "Accept all (1)", exact: true }).waitFor();
    const partial = await page.evaluate(() => window.__linkFixture);
    assert.equal(partial.writes.length, 1);
    assert.equal(partial.reads.length, 2);
    assert.match(partial.files["/myco/wiki/synthetic-a.md"], /\[\[wiki\/synthetic-b\|synthetic-b\]\]/);
    assert.match(partial.files["/myco/wiki/synthetic-a.md"], /\[\[wiki\/synthetic-c\|synthetic-c\]\]/);
    await retry.click();
    await card.waitFor({ state: "detached" });
    const complete = await page.evaluate(async () => {
      const { useLinkSuggestStore } = await import("/src/stores/linkSuggestStore.ts");
      const { loadDismissed } = await import("/src/lib/linkSuggestions.ts");
      const { useNoticeStore } = await import("/src/stores/noticeStore.ts");
      return { writes: window.__linkFixture.writes, reads: window.__linkFixture.reads, count: loadDismissed().size, busy: useLinkSuggestStore.getState().busy, progress: useNoticeStore.getState().progress };
    });
    assert.equal(complete.writes.length, 2);
    assert.equal(complete.reads.length, 3);
    assert.equal(complete.count, 3);
    assert.equal(complete.busy, false);
    assert.equal(complete.progress, null);
    assert.deepEqual(errors, []);
    checks += 10;
    console.log(`PASS ${width}: grouped append, visible partial failure, remainder-only retry, persisted decisions, cleared progress`);
    await context.close();
  }
} finally {
  await browser.close();
}
console.log(`${checks} checks passed (synthetic browser IPC; not native disk validation)`);
