// Progressive disclosure and primary actions, against the in-memory dev vault.
// Usage: node scripts/intake-smoke.mjs (Vite on 127.0.0.1:5173)
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const browser = await chromium.launch({ headless: true });
const checks = [];
const check = (name, passed) => {
  checks.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"} ${name}`);
};
await mkdir("/tmp/myco-intake-review", { recursive: true });

try {
  for (const width of [375, 768, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem("myco.onboarded", "1");
      localStorage.setItem("myco-ui", JSON.stringify({ state: { lang: "ko", theme: "light", route: "ingest" }, version: 3 }));
    });
    await page.goto("http://127.0.0.1:5173/?mock=1", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-testid=sieve]");
    const moreSources = page.locator("[data-testid=intake-more-sources]");
    check(`${width}: extra sources start collapsed`, await moreSources.getAttribute("open") === null);
    check(`${width}: no empty processing rail or tallies`, await page.locator(".sv-rail, .sv-nums, .sv-rows").count() === 0);
    check(`${width}: text area has a connected label`, await page.locator("label[for=ingest-body]").count() === 1);
    check(`${width}: submit starts disabled`, await page.locator(".intake-submit .btn-primary").isDisabled());
    await moreSources.locator(":scope > summary").focus();
    await page.keyboard.press("Space");
    check(`${width}: extra sources open with keyboard`, await moreSources.getAttribute("open") !== null);
    await moreSources.locator(":scope > summary").click();
    await page.screenshot({ path: `/tmp/myco-intake-review/ingest-${width}.png`, fullPage: true });
    check(`${width}: no horizontal page overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));

    if (width === 1280) {
      await page.evaluate(async () => {
        window.__mycoMock.settings({ ingest_provider: "builtin-local", ingest_model: "extractive-ingest" });
        const { useSettingsStore } = await import("/src/stores/settingsStore.ts");
        await useSettingsStore.getState().load();
      });
      await page.locator("#ingest-title").fill("Intake smoke source");
      await page.locator("#ingest-body").fill("Attention connects a query to relevant keys and values. Multi-head attention learns several relationships in parallel. Residual connections retain earlier representations so a transformer can build increasingly useful contextual features across its layers. Positional information helps the network distinguish ordering because attention alone treats its inputs as a set. The encoder builds contextual representations from the source sequence, while the decoder uses those representations to predict a target sequence. During training, the model compares its predictions with reference text and adjusts its parameters to reduce the error. These mechanisms work together to make long-range relationships easier to represent. This source provides concrete concepts and relationships for the notes.");
      check(`${width}: source text enables submit`, await page.locator(".intake-submit .btn-primary").isEnabled());
      await page.locator(".intake-submit .btn-primary").click();
      await page.getByText("자료 추가 완료", { exact: true }).waitFor({ timeout: 15000 });
      check(`${width}: source submission completes`, await page.getByText("자료 추가 완료", { exact: true }).isVisible());
      check(`${width}: results preserve visible processing feedback`, await page.locator(".intake-results").isVisible());
    }

    await page.evaluate(async () => {
      window.__mycoMock.settings({ query_provider: "builtin-local", query_model: "extractive-retrieval" });
      const { useSettingsStore } = await import("/src/stores/settingsStore.ts");
      await useSettingsStore.getState().load();
      const { useUIStore } = await import("/src/stores/uiStore.ts");
      useUIStore.getState().setRoute("query");
    });
    await page.waitForSelector(".ask-composer");
    check(`${width}: answer options start collapsed`, await page.locator("[data-testid=ask-options]").getAttribute("open") === null);
    const example = page.locator(".ask-examples button").first();
    const exampleText = (await example.innerText()).trim();
    await example.click();
    check(`${width}: example only drafts a question`, await page.locator(".ask-composer input").inputValue() === exampleText && await page.locator(".ask-turn").count() === 0);
    check(`${width}: example focuses question input`, await page.locator(".ask-composer input").evaluate((element) => element === document.activeElement));
    await page.screenshot({ path: `/tmp/myco-intake-review/ask-${width}.png`, fullPage: true });
    check(`${width}: Ask has no horizontal page overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));

    if (width === 1280) {
      await page.locator(".ask-composer input").fill("what is attention?");
      await page.locator(".ask-composer__input .btn-primary").click();
      await page.waitForSelector(".ask-sources", { timeout: 15000 });
      check(`${width}: answer keeps readable source links`, await page.locator(".ask-sources .ask-lrow").count() > 0);
      check(`${width}: source arithmetic starts hidden`, await page.locator(".ask-sources .ask-lmath").count() === 0);
      await page.locator(".ask-sources__toggle").click();
      check(`${width}: source arithmetic remains available`, await page.locator(".ask-sources .ask-lmath").first().isVisible());
      await page.locator(".ask-sources__toggle").click();
      const trace = page.locator(".ask-search-details");
      check(`${width}: retrieval trace starts collapsed`, await trace.getAttribute("open") === null);
      await trace.locator(":scope > summary").click();
      check(`${width}: retrieval trace remains available`, await trace.locator(".ask-tracebar").isVisible());
      await page.locator(".ask-sources .ask-lrow").first().click();
      await page.waitForFunction(async () => (await import("/src/stores/uiStore.ts")).useUIStore.getState().route.startsWith("page:"));
      check(`${width}: source still opens its note`, true);
    }
    check(`${width}: no page errors`, errors.length === 0);
    if (errors.length) console.error(errors);
    await page.close();
  }
} finally {
  await browser.close();
}
const failures = checks.filter((entry) => !entry.passed);
console.log(`${checks.length - failures.length}/${checks.length} checks passed`);
process.exitCode = failures.length ? 1 : 0;
