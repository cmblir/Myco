// Real browser interactions with synthetic IPC; no native vault or model calls.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const base = process.env.MYCO_TEST_URL ?? "http://127.0.0.1:5173";
const local = ["127.0.0.1", "localhost", "[::1]"];
assert.ok(local.includes(new URL(base).hostname));
const output = process.env.MYCO_TEST_OUTPUT_DIR ?? "/tmp/myco-ask-lifecycle";
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
let checks = 0;
const timingObservations = [];

async function clockSnapshot(page) {
  return page.evaluate(() => ({
    startedAt: window.askQuery.getState().startedAt,
    busy: window.askQuery.getState().busy,
    monotonicNow: performance.now(),
    wallNow: Date.now(),
    timer: document.querySelector('.ask-turn [role="timer"]')?.textContent ?? null,
    activity: document.querySelector("button.activity-chip")?.getAttribute("title") ?? null,
    calls: window.askCalls.length,
    responses: window.askResponses.length,
  }));
}

function verifyClock(snapshot, startedAt, width, phase) {
  assert.equal(snapshot.busy, true, `${phase}: the original request remains pending`);
  assert.equal(snapshot.startedAt, startedAt, `${phase}: navigation and clock changes preserve the start`);
  assert.equal(snapshot.calls, 1, `${phase}: no replacement request`);
  assert.equal(snapshot.responses, 1, `${phase}: no replacement response`);
  const match = /^Elapsed (\d+):(\d{2})$/.exec(snapshot.timer ?? "");
  assert.ok(match, `${phase}: one elapsed timer is rendered`);
  const seconds = Number(match[1]) * 60 + Number(match[2]);
  const expected = Math.floor((snapshot.monotonicNow - startedAt) / 1000);
  // Allow interval/React commit phase lag, never a wall-clock-sized jump.
  assert.ok(seconds <= expected && expected - seconds <= 2, `${phase}: ${seconds}s displayed vs ${expected}s monotonic age`);
  timingObservations.push({ width, phase, ...snapshot, displayedSeconds: seconds });
  return seconds;
}

async function nextTimerTick(page, previousSeconds) {
  await page.waitForFunction(previous => {
    const text = document.querySelector('.ask-turn [role="timer"]')?.textContent ?? "";
    const match = /^Elapsed (\d+):(\d{2})$/.exec(text);
    return match && Number(match[1]) * 60 + Number(match[2]) > previous;
  }, previousSeconds);
}

try {
  for (const width of [375, 768, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
      const url = new URL(route.request().url());
      return local.includes(url.hostname) || !["http:", "https:"].includes(url.protocol)
        ? route.continue() : route.abort("blockedbyclient");
    });
    await page.addInitScript(() => {
      localStorage.setItem("myco.onboarded", "1");
      localStorage.setItem("myco-ui", JSON.stringify({ version: 3, state: { lang: "en", theme: "light" } }));
    });
    try {
      await page.goto(`${base}/?mock=1`);
      await page.locator(".home-page").waitFor();
      if (width <= 768) await page.locator(".phone-tabbar").getByRole("button", { name: "Ask", exact: true }).click();
      else await page.locator(".side-nav .nav-item").filter({ hasText: /^Ask$/ }).click();
      const input = page.locator(".ask-composer input.input");
      await input.waitFor();
      await page.evaluate(async () => {
        // Use the exact module URLs loaded by Vite, including HMR revisions.
        const store = async name => {
          const url = performance.getEntriesByType("resource").filter(entry => entry.name.includes(`/src/stores/${name}.ts`)).at(-1)?.name;
          if (!url) throw new Error(`Store module not loaded: ${name}`);
          return import(url);
        };
        window.askQuery = (await store("queryStore")).useQueryStore;
        window.askVault = (await store("vaultStore")).useVaultStore;
        const { roleFixture } = await import("/src/lib/modelRoles.testSupport.ts");
        const originalVault = window.askVault.getState().currentVault.path;
        window.__mycoMock.settings({ query_provider: "builtin-local", query_model: "extractive-retrieval" });
        await (await store("settingsStore")).useSettingsStore.getState().load();
        window.holdAsk = true;
        window.askCalls = [];
        window.askResponses = [];
        window.askCommandNames = [];
        const invoke = window.__TAURI_INTERNALS__.invoke;
        const result = text => ({ floor: 0.42, below_floor: [], hits: [{
          page: "wiki/synthetic-answer.md", stem: "synthetic-answer", section: 0,
          text, similarity: 0.8, score: 0.032, exact_match: true,
        }] });
        window.__TAURI_INTERNALS__.invoke = (command, args) => {
          window.askCommandNames.push(command);
          // Synthetic transport DTO only. The demo correctly refuses native grants;
          // this fixture exercises renderer admission without claiming native authority.
          if (command === "capture_model_role") {
            if (args.role !== "ask" || args.usage !== "foreground")
              return Promise.reject(new Error("Unexpected role request in Ask renderer fixture"));
            return Promise.resolve(roleFixture("ask", "builtin-local", "extractive-retrieval", args.origin));
          }
          // The preview's localStorage history is global; the native log is per vault.
          if (command === "ask_history_load" && args.vault !== originalVault) return Promise.resolve([]);
          if (command === "semantic_search") {
            window.askCalls.push(args);
            if (window.holdAsk) return new Promise(resolve => {
              window.askResponses.push(() => resolve(result("SYN-LATE must never replace the next answer.")));
            });
            return Promise.resolve(result("SYN-CURRENT is the confirmed synthetic answer."));
          }
          return invoke(command, args);
        };
      });
      await input.fill("Explain SYN-PENDING in the synthetic notes");
      await input.press("Enter");
      await page.waitForFunction(() => window.askResponses.length === 1);
      const timer = page.locator('.ask-turn [role="timer"]');
      assert.equal(await timer.count(), 1);
      const initial = await clockSnapshot(page);
      assert.ok(initial.startedAt >= 0 && initial.startedAt <= initial.monotonicNow);
      let displayed = verifyClock(initial, initial.startedAt, width, "pending start");
      await nextTimerTick(page, displayed);
      displayed = verifyClock(await clockSnapshot(page), initial.startedAt, width, "real interval tick");
      await page.evaluate(() => { window.askRealDateNow = Date.now; });
      try {
        for (const offset of [3_600_000, -3_600_000]) {
          await page.evaluate(offset => { Date.now = () => window.askRealDateNow() + offset; }, offset);
          await nextTimerTick(page, displayed);
          displayed = verifyClock(await clockSnapshot(page), initial.startedAt, width, `wall clock ${offset}`);
        }
      } finally {
        await page.evaluate(() => { Date.now = window.askRealDateNow; });
      }
      if (width === 1280) {
        const chip = page.getByRole("button", { name: "Background activity", exact: true });
        assert.equal(await chip.isVisible(), true);
        const collapsed = await clockSnapshot(page);
        const match = /(?:^| · )Ask (\d+):(\d{2})(?:$| · )/.exec(collapsed.activity ?? "");
        assert.ok(match, "The activity chip exposes the pending Ask age");
        const seconds = Number(match[1]) * 60 + Number(match[2]);
        assert.ok(Math.abs(seconds - (collapsed.monotonicNow - initial.startedAt) / 1000) <= 2);
        assert.equal(await chip.locator(".pill-label").innerText(), "Ask");
        const collapsedNumber = chip.locator(".activity-num");
        assert.equal(await collapsedNumber.isVisible(), true);
        const collapsedText = await collapsedNumber.innerText();
        assert.match(collapsedText, /^\d+:\d{2}$/);
        const [collapsedMinutes, collapsedRemainder] = collapsedText.split(":").map(Number);
        const collapsedAge = await page.evaluate(() => (performance.now() - window.askQuery.getState().startedAt) / 1000);
        assert.ok(Math.abs(collapsedMinutes * 60 + collapsedRemainder - collapsedAge) <= 2);
        await chip.click();
        const row = page.locator(".activity-pop .activity-row").filter({ hasText: "Explain SYN-PENDING in the synthetic notes" });
        assert.equal(await row.count(), 1);
        const detail = await row.locator(".activity-num").innerText();
        assert.match(detail, /^\d+:\d{2}$/);
        const [minutes, remainder] = detail.split(":").map(Number);
        const age = await page.evaluate(() => (performance.now() - window.askQuery.getState().startedAt) / 1000);
        assert.ok(Math.abs(minutes * 60 + remainder - age) <= 2);
        timingObservations.push({ width, phase: "collapsed and expanded activity", titleSeconds: seconds, collapsedText, collapsedAge, detail, age });
        await chip.click();
      }
      if (width <= 768) await page.locator(".phone-tabbar").getByRole("button", { name: "Home", exact: true }).click();
      else await page.locator(".side-nav .nav-item").filter({ has: page.locator(".ni-text").filter({ hasText: /^Home$/ }) }).click();
      await page.locator(".home-page").waitFor();
      assert.equal(await timer.count(), 0, "Ask unmounts on Home");
      const away = await clockSnapshot(page);
      assert.equal(away.startedAt, initial.startedAt);
      assert.equal(away.busy, true);
      assert.equal(away.calls, 1);
      assert.equal(away.responses, 1);
      await page.waitForFunction(start => performance.now() - start >= 1_100, away.monotonicNow);
      if (width <= 768) await page.locator(".phone-tabbar").getByRole("button", { name: "Ask", exact: true }).click();
      else await page.locator(".side-nav .nav-item").filter({ hasText: /^Ask$/ }).click();
      await input.waitFor();
      // Inspect the first returned state rather than polling until an interval repairs it.
      verifyClock(await clockSnapshot(page), initial.startedAt, width, "Home to Ask first render");
      await page.waitForFunction(() => {
        const pane = document.querySelector('.ask-turn [role="timer"]')?.closest(".route-fade");
        return pane && getComputedStyle(pane).opacity === "1";
      });
      await page.screenshot({ path: `${output}/ask-pending-${width}.png`, fullPage: true });
      const stop = page.getByRole("button", { name: "Stop answering", exact: true });
      assert.equal(await stop.isVisible(), true, "Local retrieval must expose Stop while pending");
      await stop.click();
      await page.waitForFunction(() => !window.askQuery.getState().busy && window.askQuery.getState().turns[0]?.stopped);
      assert.equal(await page.evaluate(() => window.askQuery.getState().startedAt), null);
      await timer.waitFor({ state: "detached" });
      timingObservations.push({ width, phase: "Stop resets elapsed", startedAt: null });
      assert.equal(await input.isEnabled(), true);
      assert.match(await page.locator(".ask-turn").first().innerText(), /Stopped/);
      await page.evaluate(() => { window.holdAsk = false; });
      await input.fill("Explain SYN-CURRENT in the synthetic notes");
      await input.press("Enter");
      await page.locator("#ask-turn-1-body").getByText(/SYN-CURRENT is the confirmed/).waitFor();
      assert.equal(await page.evaluate(() => window.askQuery.getState().startedAt), null);
      await timer.waitFor({ state: "detached" });
      timingObservations.push({ width, phase: "settle resets elapsed", startedAt: null });
      await page.evaluate(async () => {
        window.askResponses.shift()();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      assert.equal(await page.getByText("SYN-LATE must never replace the next answer.", { exact: true }).count(), 0);
      assert.deepEqual(await page.evaluate(() => window.askQuery.getState().turns.map(turn => ({ q: turn.q, stopped: !!turn.stopped }))), [
        { q: "Explain SYN-PENDING in the synthetic notes", stopped: true },
        { q: "Explain SYN-CURRENT in the synthetic notes", stopped: false },
      ]);
      await page.evaluate(() => { window.holdAsk = true; });
      await input.fill("Explain SYN-OLD-VAULT in the synthetic notes");
      await input.press("Enter");
      await page.waitForFunction(() => window.askResponses.length === 1);
      await page.evaluate(() => window.askVault.setState({ isOpeningVault: true }));
      assert.equal(await input.isDisabled(), true);
      assert.deepEqual(await page.evaluate(() => {
        const { turns, history, noteScope, busy } = window.askQuery.getState();
        return { turns, history, noteScope, busy };
      }), { turns: [], history: [], noteScope: null, busy: false });
      await page.evaluate(() => {
        const previous = window.askVault.getState().currentVault;
        window.askQuery.getState().setNoteScope({ path: `${previous.path}/wiki/synthetic-answer.md`, title: "Synthetic old scope" });
        // Simulate the native open-vault result, without opening an OS folder.
        window.askVault.setState({ currentVault: { ...previous, path: "/synthetic-next-vault", name: "Synthetic next vault" }, isOpeningVault: false });
      });
      const state = await page.evaluate(() => {
        const { turns, history, noteScope, busy } = window.askQuery.getState();
        return { turns, history, noteScope, busy };
      });
      assert.deepEqual(state, { turns: [], history: [], noteScope: null, busy: false });
      await page.evaluate(async () => {
        window.askResponses.shift()();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      assert.equal(await page.locator(".ask-turn").count(), 0);
      assert.equal(await input.isEnabled(), true);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      assert.deepEqual(errors, []);
      await page.screenshot({ path: `${output}/ask-lifecycle-${width}.png`, fullPage: true });
      checks += 12;
      console.log(`PASS ${width}: local Stop, next answer isolation and simulated vault change`);
    } catch (error) {
      const failure = await page.evaluate(() => ({
        commands: window.askCommandNames ?? [],
        calls: window.askCalls?.length ?? null,
        responses: window.askResponses?.length ?? null,
        query: window.askQuery ? {
          busy: window.askQuery.getState().busy,
          startedAt: window.askQuery.getState().startedAt,
          stage: window.askQuery.getState().stage,
          turns: window.askQuery.getState().turns,
        } : null,
      }));
      await writeFile(`${output}/failure-${width}.json`, JSON.stringify(failure, null, 2) + "\n");
      await page.screenshot({ path: `${output}/failure-${width}.png`, fullPage: true });
      throw error;
    } finally {
      await page.evaluate(() => { if (window.askRealDateNow) Date.now = window.askRealDateNow; });
      await page.close();
    }
  }
} finally { await browser.close(); }
console.log(`${checks} checks passed (synthetic IPC; vault change simulated through the live store)`);
await writeFile(`${output}/timing-observations.json`, JSON.stringify({ checks, timingObservations, nativeModelExecuted: false, nativeStopVerified: false }, null, 2) + "\n");
console.log(`${timingObservations.length} timing observations passed (real intervals/navigation; page-only wall-clock offsets)`);
