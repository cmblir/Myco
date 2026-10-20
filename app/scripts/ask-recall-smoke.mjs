// Real Ask UI with synthetic dated records and graph IPC. No native vault,
// embedding, generator or model download is exercised by this browser check.
// Usage: MYCO_TEST_URL=http://127.0.0.1:5173 node scripts/ask-recall-smoke.mjs
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const base = new URL(process.env.MYCO_TEST_URL ?? "http://127.0.0.1:5173");
const loopback = ["127.0.0.1", "localhost", "[::1]"];
assert.ok(loopback.includes(base.hostname), "Use a loopback development server");
const output = process.env.MYCO_TEST_OUT ?? "/tmp/myco-ask-recall";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: !process.argv.includes("--headed") });
const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok, detail });
const personal = "어제한 일";
const connected = "서로 연결되는 아이디어가 있어?";
const day = "2026-10-03";
const stamp = new Date("2026-10-03T09:20:00+09:00").getTime() / 1000;

async function chooseScope(page, label) {
  const summary = page.locator(".ask-scope summary");
  await summary.focus();
  await summary.press("Enter");
  const choice = page.locator(".ask-scope__menu").getByRole("button", { name: new RegExp(`^${label}`) });
  await choice.waitFor({ state: "visible" });
  await choice.focus();
  await choice.press("Enter");
  return page.evaluate(() => document.activeElement?.matches(".ask-scope summary") === true);
}

async function submit(page, question) {
  const tick = await page.evaluate(() => ++window.__recallFixture.clockStep);
  await page.clock.setFixedTime(new Date(new Date("2026-10-04T12:00:00+09:00").getTime() + tick * 1000));
  const input = page.locator(".ask-composer input.input");
  await input.fill(question);
  await input.press("Enter");
}

async function ask(page, question) {
  const previous = await page.evaluate(() => window.__recallFixture.query.getState().turns.length);
  await submit(page, question);
  await page.waitForFunction(({ previous, question }) => {
    const { turns, busy } = window.__recallFixture.query.getState();
    return turns.length > previous && turns.at(-1)?.q === question && !busy;
  }, { previous, question });
  return page.evaluate(() => ({
    turn: window.__recallFixture.query.getState().turns.at(-1),
    temporal: window.__recallFixture.temporal,
    searches: window.__recallFixture.searches,
    graphCalls: window.__recallFixture.graphCalls,
    metadataCalls: window.__recallFixture.metadataCalls,
    modelCalls: window.__recallFixture.modelCalls,
  }));
}

async function fixturePage(width) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, timezoneId: "Asia/Seoul" });
  const blocked = new Set();
  await context.route("**/*", route => {
    const target = new URL(route.request().url());
    if (loopback.includes(target.hostname) || !["http:", "https:"].includes(target.protocol)) return route.continue();
    blocked.add(target.href);
    return route.abort("blockedbyclient");
  });
  await context.addInitScript(() => {
    performance.setResourceTimingBufferSize(5000);
    localStorage.setItem("myco.onboarded", "1");
    localStorage.setItem("myco-ui", JSON.stringify({ version: 3, state: { lang: "ko", theme: "light", askScope: "wiki", isAskScopeExplicit: false } }));
    window.__importAppModule = path => {
      const entry = performance.getEntriesByType("resource").filter(resource => new URL(resource.name).pathname === path).at(-1);
      if (!entry) throw new Error(`App module was not loaded: ${path}`);
      return import(entry.name);
    };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(90000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() !== "error") return;
    if (message.text().includes("ERR_BLOCKED_BY_CLIENT") && blocked.has(message.location().url)) return;
    errors.push(`${message.text()} (${message.location().url})`);
  });
  await page.goto(new URL("/?mock=1", base).toString());
  await page.locator(".home-page").waitFor();
  await page.waitForFunction(async () => {
    const { useVaultStore } = await window.__importAppModule("/src/stores/vaultStore.ts");
    const state = useVaultStore.getState();
    return state.currentVault !== null && state.adjacency !== null && !state.isOpeningVault;
  });
  await page.evaluate(() => {
    window.__mycoMock.settings({ query_provider: "builtin-local", query_model: "extractive-retrieval" });
    window.__mycoMock.indexedPages(30);
  });
  if (width <= 768) await page.locator(".phone-tabbar").getByRole("button", { name: "질문", exact: true }).click();
  else await page.locator(".side-nav .nav-item").filter({ hasText: /^질문$/ }).click();
  await page.locator(".ask-composer input.input").waitFor();
  await page.evaluate(async ({ stamp }) => {
    const query = (await window.__importAppModule("/src/stores/queryStore.ts")).useQueryStore;
    const vault = (await window.__importAppModule("/src/stores/vaultStore.ts")).useVaultStore;
    await (await window.__importAppModule("/src/stores/settingsStore.ts")).useSettingsStore.getState().load();
    const root = vault.getState().currentVault.path;
    const a = `${root}/wiki/synthetic-cache.md`, b = `${root}/wiki/synthetic-retrieval.md`;
    const unread = `${root}/wiki/synthetic-unread.md`;
    const graph = {
      forward: { [a]: [b, unread, `${root}/wiki/synthetic-missing.md`], [b]: [a], [unread]: [a] },
      backward: { [a]: [b], [b]: [a] }, unresolved: {},
      tags: { [a]: ["synthetic-topic"], [b]: ["synthetic-topic"], [unread]: ["synthetic-topic"] },
      meta: { [a]: { title: "합성 캐시" }, [b]: { title: "합성 검색" } }, unread: [unread],
    };
    vault.setState({ adjacency: graph });
    query.getState().clear();
    const events = [
      { page: "sessions/2026-10-03/synthetic-thread.md", stem: "synthetic-thread", section: 0, role: "user", timestamp: stamp, text: "SYN-YESTERDAY 사용자가 검색 검증을 요청했습니다." },
      { page: "sessions/2026-10-03/synthetic-thread.md", stem: "synthetic-thread", section: 1, role: "assistant", timestamp: stamp + 4200, text: "SYN-YESTERDAY 도우미가 검증 계획을 말했습니다." },
    ];
    const activityEvents = [
      { page: "sessions/synthetic-request.md", stem: "Synthetic request", section: 0, role: "User", timestamp: stamp,
        text: "**User:**\n\nSYN-REQUEST 합성 배포 문제를 수정하고 배포해줘." },
      { page: "sessions/synthetic-pending.md", stem: "Synthetic pending", section: 0, role: "Assistant", timestamp: stamp + 100,
        text: "**Assistant:**\n\nNeed your decision\n\nSYN-PENDING 배포 방식 선택이 필요합니다." },
      { page: "sessions/synthetic-running.md", stem: "Synthetic running", section: 0, role: "Assistant", timestamp: stamp + 200,
        text: "**Assistant:**\n\nRunning now\n\nSYN-RUNNING 합성 배포 문제를 조사하고 있습니다." },
      { page: "sessions/synthetic-done.md", stem: "Synthetic done", section: 0, role: "Assistant", timestamp: stamp + 300,
        text: "**Assistant:**\n\nSYN-PERFORMED 합성 파서 오류를 수정했습니다. 회귀 테스트 12개를 실행했습니다." },
    ];
    const fixture = window.__recallFixture = {
      query, vault, graph, mode: "dated", clockStep: 0, releases: [], temporal: [], searches: [],
      graphCalls: 0, metadataCalls: [], modelCalls: [],
    };
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = (command, args = {}) => {
      if (command === "ask_history_load") return Promise.resolve([]);
      if (command === "temporal_recall") {
        fixture.temporal.push(args);
        const result = { events, indexed_pages: 30, scanned_pages: 12, matched_events: 3, incomplete: true };
        if (fixture.mode.startsWith("activity")) {
          const selected = fixture.mode === "activity-unconfirmed" ? activityEvents.slice(0, 3) : activityEvents;
          return Promise.resolve({ ...result, events: selected, matched_events: selected.length, incomplete: false });
        }
        if (fixture.mode === "held") return new Promise(resolve => fixture.releases.push(() => resolve({ ...result,
          events: [{ ...events[0], text: "SYN-LATE-CHRONO must never replace a later answer." }],
        })));
        if (fixture.mode === "incomplete-empty") return Promise.resolve({ ...result, events: [], matched_events: 0 });
        if (fixture.mode === "empty") return Promise.resolve({ ...result, events: [], matched_events: 0, incomplete: false });
        return Promise.resolve(result);
      }
      if (command === "semantic_search") {
        fixture.searches.push(args);
        if (fixture.mode === "echo") return Promise.resolve({ floor: 0.42, below_floor: [], hits: [{
          page: "sessions/2026-10-03/synthetic-test-plan.md", stem: "Synthetic test plan", section: 0,
          text: "SYN-ECHO-PLAN 브라우저에서 '서로 연결되는 아이디어가 있어?' 질문을 검증할 계획입니다.",
          score: 0.8, similarity: 0.72, exact_match: true,
        }] });
        return Promise.resolve({ floor: 0.42, below_floor: [], hits: [] });
      }
      if (command === "build_link_graph") { fixture.graphCalls++; return Promise.resolve(graph); }
      if (["file_mtimes", "git_log", "classify_intent"].includes(command)) {
        fixture.metadataCalls.push(command);
        if (command === "file_mtimes") return Promise.resolve([[`${root}/wiki/SYN-WRONG-MTIME.md`, stamp]]);
        if (command === "git_log") return Promise.resolve([]);
        return Promise.resolve({ intent: "vault-files" });
      }
      if (["local_chat_status", "local_synthesize", "local_query", "claude_run", "claude_run_stream", "agent_run", "chat_complete", "embed_local_texts"].includes(command)) {
        fixture.modelCalls.push(command);
        return Promise.reject(new Error("Synthetic fixture must not invoke generation"));
      }
      return invoke(command, args);
    };
  }, { stamp });
  // Playwright's clock replaces Performance too; resolve live module URLs first.
  await page.clock.setFixedTime(new Date("2026-10-04T12:00:00+09:00"));
  return { page, context, errors, blocked };
}

try {
  for (const width of [375, 768, 1280]) {
    const { page, context, errors, blocked } = await fixturePage(width);
    try {
      check(`${width}: scope is selected with keyboard and returns focus`, await chooseScope(page, "대화 기록"));
      const dated = await ask(page, personal);
      const datedText = await page.locator(".ask-turn").last().innerText();
      check(`${width}: exact personal prompt uses dated session IPC`, dated.temporal.length === 1 && dated.temporal[0].scope === "sessions" && dated.searches.length === 0);
      check(`${width}: local yesterday is serialized without changing dates`, dated.temporal[0].range.start === day && dated.temporal[0].range.end === day && dated.temporal[0].range.startEpoch === stamp - 33600 && dated.temporal[0].range.endEpoch === stamp - 33600 + 86400);
      check(`${width}: the applied conversation and date chips are visible`, datedText.includes("범위 · 대화 기록") && datedText.includes(`기간: ${day} – ${day}`));
      const clocks = await page.evaluate(stamp => [stamp, stamp + 4200].map(at => new Intl.DateTimeFormat("ko", { dateStyle: "short", timeStyle: "short" }).format(new Date(at * 1000))), stamp);
      check(`${width}: original timestamps, roles and exact citations are retained`, clocks.every(clock => datedText.includes(clock)) && datedText.includes("user") && datedText.includes("assistant") && dated.turn.a.includes("[[sessions/2026-10-03/synthetic-thread|synthetic-thread]]"));
      check(`${width}: original excerpts do not claim completed work`, datedText.includes("SYN-YESTERDAY") && datedText.includes("실제 작업 완료를 확인한 결과는 아닙니다"));
      check(`${width}: incomplete coverage and displayed counts are visible`, datedText.includes("30개 중 12개") && datedText.includes("3개 중 2개") && datedText.includes("확인 범위가 제한"));
      check(`${width}: history recall never substitutes modified-file metadata`, dated.metadataCalls.length === 0 && !datedText.includes("SYN-WRONG-MTIME"));
      check(`${width}: rendered event citation links keep the relative path`, await page.locator('.ask-turn').last().locator('a[data-link="sessions/2026-10-03/synthetic-thread"]').count() === 2);
      if (width === 375) await page.screenshot({ path: `${output}/dated-375.png`, fullPage: true });

      check(`${width}: wiki scope is selected with keyboard`, await chooseScope(page, "내 노트"));
      const linked = await ask(page, connected);
      const linkedText = await page.locator(".ask-turn").last().innerText();
      check(`${width}: exact connection prompt uses the cached readable graph`, linked.turn.scope === "wiki" && linked.graphCalls === 0 && linked.searches.length === 0 && linked.temporal.length === 1);
      check(`${width}: the visible wiki chip and existing-link evidence agree`, linkedText.includes("범위 · 내 노트") && linkedText.includes("기존 링크") && linkedText.includes("합성 캐시") && linkedText.includes("합성 검색"));
      check(`${width}: shared tags have exact relative note citations`, linkedText.includes("#synthetic-topic") && linked.turn.a.includes("[[wiki/synthetic-cache|합성 캐시]]") && linked.turn.a.includes("[[wiki/synthetic-retrieval|합성 검색]]"));
      check(`${width}: graph evidence excludes unread and dangling notes`, !/synthetic-unread|synthetic-missing/.test(linked.turn.a) && (linked.turn.a.match(/ → /g)?.length ?? 0) === 1);
      check(`${width}: bounded graph coverage is stated without generated claims`, linkedText.includes("기존 링크 최대 5쌍") && linkedText.includes("공통 태그 최대 3개") && !/새로운 관계를 발견|SYN-WRONG-MTIME/.test(linkedText));
      check(`${width}: both answers use no generation IPC`, linked.modelCalls.length === 0);
      check(`${width}: Ask fits the viewport`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      if (width === 1280) await page.screenshot({ path: `${output}/connections-1280.png`, fullPage: true });

      await chooseScope(page, "대화 기록");
      await page.evaluate(() => { window.__recallFixture.mode = "activity"; });
      const activity = await ask(page, "최근 일주일동안 한일");
      const activityText = await page.locator(".ask-turn").last().innerText();
      const performed = activity.turn.a.split("### 수행·결과 보고\n\n")[1]?.split("\n\n### ")[0] ?? "";
      const progress = activity.turn.a.split("### 진행·계획\n\n")[1]?.split("\n\n### ")[0] ?? "";
      const unconfirmed = activity.turn.a.split("### 요청·결정 대기·완료 미확인\n\n")[1] ?? "";
      check(`${width}: reported exact recent-week question reaches production chronology route`, activity.turn.q === "최근 일주일동안 한일" && activity.temporal.at(-1).range.start === "2026-09-28" && activity.temporal.at(-1).range.end === "2026-10-04" && activity.temporal.at(-1).scope === "sessions" && activity.searches.length === linked.searches.length);
      check(`${width}: performed reports exclude requests, decisions pending and running tasks`, performed.includes("SYN-PERFORMED") && !/SYN-REQUEST|SYN-PENDING|SYN-RUNNING/.test(performed));
      check(`${width}: progress and unconfirmed work remain visibly separate`, progress.includes("SYN-RUNNING") && unconfirmed.includes("SYN-REQUEST") && unconfirmed.includes("SYN-PENDING") && activityText.includes("진행·계획") && activityText.includes("요청·결정 대기·완료 미확인"));
      check(`${width}: assistant statements stay source reports with original citations`, activityText.includes("대화에서 보고한 내용") && activityText.includes("실제 작업 완료를 확인한 결과는 아닙니다") && performed.includes("· Assistant · [[sessions/synthetic-done|Synthetic done]]") && unconfirmed.includes("· User · [[sessions/synthetic-request|Synthetic request]]"));
      check(`${width}: overview replaces raw role/status boilerplate and fits the viewport`, !/\*\*User:\*\*|\*\*Assistant:\*\*|Need your decision|Running now/.test(activity.turn.a) && activity.turn.a.length < 2500 && await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      check(`${width}: status overview does not change model or metadata routing`, activity.modelCalls.length === 0 && activity.metadataCalls.length === 0);
      await page.locator(".ask-turn").last().screenshot({ path: `${output}/activity-${width}.png` });
      await writeFile(`${output}/activity-${width}.md`, activity.turn.a);
      await page.evaluate(() => { window.__recallFixture.mode = "activity-unconfirmed"; });
      const unknown = await ask(page, "최근 일주일동안 한일");
      check(`${width}: requests/plans alone explicitly leave completed work unconfirmed`, unknown.turn.a.includes("명확한 수행·결과 보고를 찾지 못해") && !unknown.turn.a.includes("### 수행·결과 보고") && !unknown.turn.a.includes("SYN-PERFORMED") && unknown.searches.length === activity.searches.length && unknown.modelCalls.length === 0);
      await page.evaluate(() => { window.__recallFixture.mode = "dated"; });

      if (width === 1280) {
        await chooseScope(page, "대화 기록");
        await page.evaluate(() => { window.__recallFixture.mode = "echo"; });
        const scoped = await ask(page, connected);
        const scopedText = await page.locator(".ask-turn").last().innerText();
        check("explicit conversations: generic discovery bypasses search and never widens to graph", scoped.turn.scope === "sessions" && scoped.turn.abstained && scoped.searches.length === linked.searches.length && scoped.graphCalls === 0 && scoped.modelCalls.length === 0 && !scoped.turn.a.includes("[[wiki/"));
        check("explicit conversations: the UI explains the capability and offered widening without quoting a test plan", scopedText.includes("범위 · 대화 기록") && scopedText.includes("범위 넓혀 다시 찾기") && scopedText.includes("기존 링크·공통 태그") && !/SYN-ECHO-PLAN|포함되어 있지|합성 캐시/.test(scopedText));

        await page.evaluate(() => { window.__recallFixture.mode = "incomplete-empty"; });
        const incomplete = await ask(page, personal);
        const incompleteText = await page.locator(".ask-turn").last().innerText();
        check("empty incomplete chronology: missing excerpts do not establish absence", !incomplete.turn.abstained && incompleteText.includes("아무 일도 없었다는 뜻은 아닙니다") && incompleteText.includes("원문을 찾지 못했습니다"));
        check("empty incomplete chronology: no modified-file or lexical replacement", incomplete.metadataCalls.length === 0 && incomplete.searches.length === scoped.searches.length);

        await page.evaluate(() => { window.__recallFixture.mode = "empty"; });
        const empty = await ask(page, personal);
        check("empty complete chronology: explicit empty dated evidence never falls back to similarity search", empty.searches.length === incomplete.searches.length && empty.temporal.at(-1).scope === "sessions" && empty.temporal.at(-1).range.start === day && empty.temporal.at(-1).range.end === day && empty.metadataCalls.length === 0 && empty.turn.a.includes("이 기간에 해당하는 대화 원문을 찾지 못했습니다") && !empty.turn.a.includes("SYN-WRONG-MTIME"));

        await chooseScope(page, "내 노트");
        const beforePeriod = empty.searches.length;
        const period = await ask(page, "어제 서로 연결되는 아이디어가 있어?");
        check("dated connections: the timeless graph does not establish period evidence", period.searches.length === beforePeriod + 1 && period.searches.at(-1).scope === "wiki" && period.searches.at(-1).range.start === day && !period.turn.a.includes("[[wiki/synthetic-cache"));
        await page.evaluate(() => { window.__recallFixture.vault.setState({ adjacency: null }); });
        const freshGraph = await ask(page, connected);
        check("missing cached graph: the public graph IPC supplies the same cited evidence", freshGraph.graphCalls === 1 && freshGraph.turn.a.includes("[[wiki/synthetic-cache|합성 캐시]]"));

        await chooseScope(page, "대화 기록");
        await page.evaluate(() => { window.__recallFixture.mode = "held"; });
        const input = page.locator(".ask-composer input.input");
        await submit(page, personal);
        await page.waitForFunction(() => window.__recallFixture.releases.length === 1);
        const stop = page.getByRole("button", { name: "답 멈추기", exact: true });
        await stop.focus();
        await stop.press("Enter");
        await page.waitForFunction(() => !window.__recallFixture.query.getState().busy);
        check("held chronology: keyboard Stop immediately frees the composer", await input.isEnabled() && await page.locator(".ask-turn").last().getByText("멈춤", { exact: true }).isVisible());
        await page.evaluate(() => { window.__recallFixture.mode = "dated"; });
        await ask(page, personal);
        await page.evaluate(async () => {
          window.__recallFixture.releases.shift()();
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        });
        check("late stopped chronology cannot replace the next answer", !(await page.locator(".workspace").innerText()).includes("SYN-LATE-CHRONO") && (await page.locator(".ask-turn").last().innerText()).includes("SYN-YESTERDAY"));

        await page.evaluate(() => { window.__recallFixture.mode = "held"; });
        await submit(page, personal);
        await page.waitForFunction(() => window.__recallFixture.releases.length === 1);
        await page.evaluate(() => window.__recallFixture.vault.setState({ isOpeningVault: true }));
        check("simulated vault switch: pending chronology is cleared while opening", await input.isDisabled() && await page.locator(".ask-turn").count() === 0);
        await page.evaluate(async () => {
          const fixture = window.__recallFixture;
          const previous = fixture.vault.getState().currentVault;
          fixture.vault.setState({ currentVault: { ...previous, path: "/synthetic-next-vault", name: "Synthetic next vault" }, adjacency: null, isOpeningVault: false });
          fixture.releases.shift()();
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        });
        const isolated = await page.evaluate(() => {
          const { turns, history, noteScope, busy } = window.__recallFixture.query.getState();
          return turns.length === 0 && history.length === 0 && noteScope === null && !busy;
        });
        check("simulated vault switch: late chronology never repopulates the new vault", isolated && await page.locator(".ask-turn").count() === 0 && await input.isEnabled());
      }
      check(`${width}: no browser errors or unhandled rejection`, errors.length === 0, errors.join(" | "));
      console.log(JSON.stringify({ width, syntheticTemporalCalls: await page.evaluate(() => window.__recallFixture.temporal.length), deliberatelyBlockedRemoteResources: [...blocked] }));
    } finally { await context.close(); }
  }
} catch (error) {
  check("browser smoke completed", false, error.stack ?? String(error));
} finally { await browser.close(); }

for (const result of results) console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name}${result.detail ? ` — ${result.detail}` : ""}`);
const failed = results.filter(result => !result.ok).length;
console.log(`${results.length - failed}/${results.length} passed (synthetic UI/IPC; no native model or vault; vault switch simulated)`);
console.log(`Screenshots: ${output}/dated-375.png and ${output}/connections-1280.png`);
await writeFile(`${output}/report.json`, JSON.stringify({ results, passed: results.length - failed, failed,
  boundary: "Synthetic original transcript IPC; production React, queryStore and deterministic activity formatter; no native model, vault or completion verification" }, null, 2));
process.exitCode = failed ? 1 : 0;
