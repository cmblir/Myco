// Real Ask UI with synthetic retrieval, local-model IPC and clipboard capture.
// No native inference, model download, private vault or OS clipboard is used.
// Usage: MYCO_TEST_URL=http://127.0.0.1:5173 node scripts/ask-local-synthesis-smoke.mjs
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const base = new URL(process.env.MYCO_TEST_URL ?? "http://127.0.0.1:5173");
const loopback = ["127.0.0.1", "localhost", "[::1]"];
assert.ok(loopback.includes(base.hostname), "Use a loopback development server");
const output = "/tmp/myco-ask-local-synthesis";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: !process.argv.includes("--headed") });
const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok, detail });
const model = "qwen3.5-4b-q4_k_m";
const answer = "SYN-GENERATED 캐시는 반복 요청의 결과를 재사용합니다. [[wiki/synthetic-cache|synthetic-cache]]";
const stamp = new Date("2026-10-03T09:20:00+09:00").getTime() / 1000;
const followUpOnly = process.argv.includes("--follow-up");
const freshnessOnly = process.argv.includes("--freshness");
const fallbackOnly = process.argv.includes("--fallback");
const incompleteOnly = process.argv.includes("--incomplete");

async function verifyFallbacks(page, prefix) {
  for (const lang of ["ko", "en", "ja"]) {
    const strings = await page.evaluate(async lang => (await import("/src/lib/i18n.ts")).STRINGS[lang], lang);
    for (const [mode, reason, key] of [
      ["missing", "model_unavailable", "q_local_fallback_unavailable"],
      ["native-prompt_unavailable", "prompt_unavailable", "q_local_fallback_prompt"],
      ["native-time_budget", "time_budget", "q_local_fallback_timeout"],
      ["native-generation_failed", "generation_failed", "q_local_fallback_failed"],
      ["native-answer_rejected", "answer_rejected", "q_local_fallback_rejected"],
      ["native-answer_incomplete", "answer_incomplete", "q_local_fallback_incomplete"],
      ["malformed", "response_rejected", "q_local_fallback_rejected"],
      ["status-error", "status_failed", "q_local_fallback_failed"],
      ["synthesis-error", "synthesis_failed", "q_local_fallback_failed"],
      ["native-SYN-UNKNOWN-RAW-CODE", "response_rejected", "q_local_fallback_rejected"],
    ]) {
      if (incompleteOnly && reason !== "answer_incomplete") continue;
      await page.evaluate(({ lang, mode }) => {
        const f = window.__synthesisFixture;
        f.ui.setState({ lang });
        f.query.getState().clear();
        f.mode = mode;
      }, { lang, mode });
      const question = `합성 캐시 fallback ${mode.replace("SYN-UNKNOWN-RAW-CODE", "unknown")} 검증`;
      const turn = await ask(page, question);
      const rendered = page.locator(".ask-turn").last();
      const notice = rendered.getByTestId("ask-local-fallback");
      const text = await rendered.innerText();
      check(`${prefix}/${lang}/${mode}: completed fallback explains source quotes before their body`, turn.localFallback === reason && turn.extractive && !turn.localModel && await notice.count() === 1 && (await notice.innerText()).includes(strings[key]) && text.indexOf(strings[key]) < text.indexOf("SYN-SOURCE") && !text.includes("SYN-UNKNOWN-RAW-CODE") && !text.includes(model));
      check(`${prefix}/${lang}/${mode}: fallback notice and quotes fit the viewport`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      const retry = notice.getByRole("button", { name: strings.q_retry, exact: true });
      check(`${prefix}/${lang}/${mode}: completed fallback offers the existing retry`, await retry.count() === 1 && await retry.isEnabled());
      if (mode !== (incompleteOnly ? "native-answer_incomplete" : "missing") || await retry.count() === 0) continue;
      await page.evaluate(() => window.__synthesisFixture.query.setState({ busy: true }));
      check(`${prefix}/${lang}: retry is disabled while another request owns the store`, await retry.isDisabled());
      await page.evaluate(() => { const f = window.__synthesisFixture; f.query.setState({ busy: false }); f.beforeOpening = f.query.getState().turns; f.vault.setState({ isOpeningVault: true }); });
      check(`${prefix}/${lang}: opening a vault removes the obsolete fallback and retry`, await retry.count() === 0 && await page.evaluate(() => window.__synthesisFixture.query.getState().turns.length === 0));
      await page.evaluate(() => { const f = window.__synthesisFixture; f.vault.setState({ isOpeningVault: false }); f.query.setState({ turns: f.beforeOpening }); delete f.beforeOpening; });
      if (lang === "ko") await page.screenshot({ path: `${output}/fallback-${prefix}.png` });
      const before = await page.evaluate(() => {
        const f = window.__synthesisFixture;
        f.mode = "ready";
        return { turns: f.query.getState().turns.length, searches: f.searches.length, search: f.searches.at(-1) };
      });
      await advanceClock(page);
      await retry.focus();
      await retry.press("Enter");
      await page.waitForFunction(answer => !window.__synthesisFixture.query.getState().busy && window.__synthesisFixture.query.getState().turns.at(-1)?.a === answer, answer);
      check(`${prefix}/${lang}: keyboard retry preserves question and resolved search boundaries`, await page.evaluate(({ before, question }) => {
        const f = window.__synthesisFixture, turn = f.query.getState().turns.at(-1), search = f.searches.at(-1);
        return f.query.getState().turns.length === before.turns && f.searches.length === before.searches + 1 && turn.q === question && turn.scope === "wiki" && search.query === before.search.query && search.scope === before.search.scope && JSON.stringify(search.paths) === JSON.stringify(before.search.paths) && JSON.stringify(search.range) === JSON.stringify(before.search.range);
      }, { before, question }));
      check(`${prefix}/${lang}: successful retry clears the fallback notice and original quotes`, await page.evaluate(model => {
        const turn = window.__synthesisFixture.query.getState().turns.at(-1);
        return turn.localModel === model && !turn.localFallback && !turn.extractive;
      }, model) && await notice.count() === 0 && !(await rendered.innerText()).includes("SYN-SOURCE"));
    }
  }
  await page.evaluate(() => { const f = window.__synthesisFixture; f.ui.setState({ lang: "ko" }); f.query.getState().clear(); f.mode = "ready"; });
  await ask(page, "합성 캐시 정상 답변 검증");
  check(`${prefix}: generated answer has no fallback notice or retry`, await page.locator(".ask-turn").last().getByTestId("ask-local-fallback").count() === 0 && await page.locator(".ask-turn").last().getByRole("button", { name: "다시 시도", exact: true }).count() === 0);
  await page.evaluate(async () => {
    window.__mycoMock.settings({ query_provider: "builtin-local", query_model: "extractive-retrieval" });
    await window.__synthesisFixture.settings.getState().load();
  });
  const quoteOnly = await ask(page, "합성 캐시 원문 인용 검증");
  check(`${prefix}: selecting retrieval only keeps quotes without a synthesis failure notice or retry`, quoteOnly.extractive && !quoteOnly.localFallback && await page.locator(".ask-turn").last().getByTestId("ask-local-fallback").count() === 0 && await page.locator(".ask-turn").last().getByRole("button", { name: "다시 시도", exact: true }).count() === 0);
  await page.evaluate(async model => {
    window.__mycoMock.settings({ query_provider: "builtin-local", query_model: model });
    await window.__synthesisFixture.settings.getState().load();
    window.__synthesisFixture.query.getState().clear();
  }, model);
  if (incompleteOnly) return;
  await page.evaluate(() => { const f = window.__synthesisFixture; f.opaqueSources = true; f.mode = "native-generation_failed"; });
  await ask(page, "합성 캐시 출처 표시 이름 검증");
  const sourceTurn = page.locator(".ask-turn").last();
  const aria = await sourceTurn.locator(".ask-cite").first().getAttribute("aria-label");
  check(`${prefix}: source citation announces a readable label while retaining its path`, aria.includes("Codex · 00000001") && !aria.includes("1111-2222-3333") && await page.evaluate(() => window.__synthesisFixture.query.getState().turns.at(-1).hits[0].page === "wiki/source-codex-00000001-1111-2222-3333-444444444444.md"));
  await sourceTurn.getByRole("button", { name: /검토했지만 인용하지 않음 · 1/ }).click();
  const uncited = sourceTurn.getByRole("button", { name: /^Codex · 00000006/ });
  check(`${prefix}: reviewed-only source uses a readable label with its full path tooltip`, await uncited.count() === 1 && await uncited.getAttribute("title") === "wiki/source-codex-00000006-1111-2222-3333-444444444444.md" && !(await uncited.innerText()).includes("1111-2222-3333"));
  await page.evaluate(() => { const f = window.__synthesisFixture; f.opaqueSources = false; f.mode = "ready"; f.query.getState().clear(); });
}

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

async function advanceClock(page) {
  const tick = await page.evaluate(() => ++window.__synthesisFixture.clockStep);
  await page.clock.setFixedTime(new Date(new Date("2026-10-04T12:00:00+09:00").getTime() + tick * 1000));
}

async function submit(page, question) {
  await advanceClock(page);
  const input = page.locator(".ask-composer input.input");
  await input.fill(question);
  await input.press("Enter");
}

async function ask(page, question) {
  const previous = await page.evaluate(() => window.__synthesisFixture.query.getState().turns.length);
  await submit(page, question);
  await page.waitForFunction(({ previous, question }) => {
    const state = window.__synthesisFixture.query.getState();
    return !state.busy && state.turns.length > previous && state.turns.at(-1)?.q === question;
  }, { previous, question });
  return page.evaluate(() => window.__synthesisFixture.query.getState().turns.at(-1));
}

async function verifyQuestionContext(page, prefix) {
  await ask(page, "어제 합성 캐시 설명해줘");
  const turn = await ask(page, "그건 왜?");
  const state = await page.evaluate(() => {
    const f = window.__synthesisFixture;
    return { request: f.requests.at(-1), search: f.searches.at(-1), record: f.appended.at(-1)?.turn };
  });
  check(`${prefix}: follow-up keeps its original visible question`, turn.q === "그건 왜?" && turn.followUp && (await page.locator(".ask-turn").last().innerText()).includes("그건 왜?"));
  check(`${prefix}: synthesis and retrieval share the question-only topic`, state.request.question === "그건 왜?" && state.request.previousQuestion === "합성 캐시 설명해줘" && state.search.query === "합성 캐시 설명해줘 그건 왜?" && state.request.scope === "wiki" && state.request.hits.length === 1);
  check(`${prefix}: generated answers never become follow-up context`, !JSON.stringify(state.request).includes("SYN-GENERATED") && !("previousAnswer" in state.request));
  check(`${prefix}: follow-up does not inherit the previous date window`, !state.request.range && !state.search.range && !state.request.previousQuestion.includes("어제"));
  check(`${prefix}: history keeps the original follow-up and verified answer`, state.record.q === "그건 왜?" && state.record.a === answer && turn.localModel === model);
  if (prefix === "1280") await page.screenshot({ path: `${output}/followup-1280.png`, fullPage: true });
  await ask(page, "합성 검색 설명해줘");
  check(`${prefix}: a new standalone topic has no previous-question context`, await page.evaluate(() => window.__synthesisFixture.requests.at(-1).previousQuestion === undefined));
}

async function verifySourceRefusals(page, prefix) {
  for (const [lang, retryLabel, copyLabel, message] of [
    ["ko", "다시 시도", "답변 복사", "원문이 바뀌었거나 확인할 수 없어 답변을 중단했어요. 다시 시도하여 현재 노트를 검색해 주세요."],
    ["en", "Retry", "Copy answer", "The source passages changed or could not be verified. Retry to search the current notes."],
    ["ja", "再試行", "回答をコピー", "原文が変わったか確認できなかったため、回答を停止しました。再試行して現在のノートを検索してください。"],
  ]) {
    await page.evaluate(lang => {
      const f = window.__synthesisFixture;
      f.ui.setState({ lang });
      f.query.getState().clear();
    }, lang);
    for (const reason of ["source_verification_failed", "source_changed_during_generation"]) {
      const before = await page.evaluate(reason => {
        const f = window.__synthesisFixture;
        f.mode = `held-${reason}`;
        return { clipboard: f.clipboard.length, records: f.appended.length };
      }, reason);
      await submit(page, `합성 캐시 원문 검증 ${reason}`);
      await page.waitForFunction(() => window.__synthesisFixture.releases.length === 1);
      const pending = page.locator(".ask-turn").last();
      check(`${prefix}/${lang}/${reason}: pending source verification does not publish old quotes`, !(await pending.innerText()).includes("SYN-SOURCE") && await pending.getByRole("button", { name: copyLabel, exact: true }).count() === 0 && await page.evaluate(before => window.__synthesisFixture.appended.length === before.records, before));
      await page.evaluate(() => window.__synthesisFixture.releases.shift()());
      await page.waitForFunction(() => !window.__synthesisFixture.query.getState().busy);
      const rendered = page.locator(".ask-turn").last();
      const text = await rendered.innerText();
      const retry = rendered.getByRole("button", { name: retryLabel, exact: true });
      check(`${prefix}/${lang}/${reason}: localized refusal and keyboard retry are visible`, await rendered.getByText(message, { exact: true }).isVisible() && await retry.isVisible() && await retry.isEnabled());
      check(`${prefix}/${lang}/${reason}: rejected source and model provenance are absent`, !text.includes("SYN-SOURCE") && !text.includes("SYN-GENERATED") && !text.includes(model) && await rendered.locator('a[data-link="wiki/synthetic-cache"]').count() === 0 && await page.evaluate(message => {
        const turn = window.__synthesisFixture.query.getState().turns.at(-1);
        return turn.a === "" && turn.error === message && !turn.hits && !turn.localModel;
      }, message));
      check(`${prefix}/${lang}/${reason}: source refusal never renders a quote fallback notice`, await rendered.getByTestId("ask-local-fallback").count() === 0);
      check(`${prefix}/${lang}/${reason}: rejected answer cannot be copied or saved as evidence`, await rendered.getByRole("button", { name: copyLabel, exact: true }).count() === 0 && await page.evaluate(({ before, message }) => {
        const f = window.__synthesisFixture, record = f.appended.at(-1)?.turn;
        return f.clipboard.length === before.clipboard && f.appended.length === before.records + 1 && record.a === "" && record.error === message && record.cited.length === 0 && !JSON.stringify(record).includes("SYN-SOURCE") && !JSON.stringify(record).includes("wiki/synthetic-cache");
      }, { before, message }));
      check(`${prefix}/${lang}/${reason}: refusal fits the viewport`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await retry.evaluate(button => button.scrollIntoView({ block: "center", behavior: "instant" }));
      check(`${prefix}/${lang}/${reason}: retry is reachable by scrolling above the sticky composer`, await retry.evaluate(button => {
        const box = button.getBoundingClientRect();
        return box.top >= 0 && box.bottom <= innerHeight && button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      }));
      if (lang === "ko" && reason === "source_changed_during_generation") await page.screenshot({ path: `${output}/source-changed-${prefix}.png` });
      const counts = await page.evaluate(() => {
        const f = window.__synthesisFixture;
        f.mode = "ready";
        return { turns: f.query.getState().turns.length, requests: f.requests.length, searches: f.searches.length };
      });
      await advanceClock(page);
      await retry.focus();
      await retry.press("Enter");
      await page.waitForFunction(answer => {
        const state = window.__synthesisFixture.query.getState();
        return !state.busy && state.turns.at(-1)?.a === answer;
      }, answer);
      check(`${prefix}/${lang}/${reason}: keyboard retry retrieves fresh evidence and replaces the failed turn`, await page.evaluate(({ counts, answer, model, lang }) => {
        const f = window.__synthesisFixture, turn = f.query.getState().turns.at(-1), request = f.requests.at(-1);
        return f.query.getState().turns.length === counts.turns && f.searches.length === counts.searches + 1 && f.requests.length === counts.requests + 1 && request.lang === lang && turn.a === answer && turn.localModel === model && !turn.error && f.appended.at(-1)?.turn.a === answer;
      }, { counts, answer, model, lang }) && (await page.locator(".ask-turn").last().innerText()).includes("SYN-GENERATED"));
    }
  }
  await page.evaluate(() => {
    const f = window.__synthesisFixture;
    f.ui.setState({ lang: "ko" });
    f.query.getState().clear();
  });
}

async function fixturePage(width) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, timezoneId: "Asia/Seoul" });
  const blocked = new Set();
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (loopback.includes(url.hostname) || !["http:", "https:"].includes(url.protocol)) return route.continue();
    blocked.add(url.href);
    return route.abort("blockedbyclient");
  });
  await context.addInitScript(() => {
    localStorage.setItem("myco.onboarded", "1");
    localStorage.setItem("myco-ui", JSON.stringify({ version: 3, state: { lang: "ko", theme: "light", askScope: "wiki", isAskScopeExplicit: true } }));
    window.__importAppModule = path => {
      const entry = performance.getEntriesByType("resource").filter(resource => new URL(resource.name).pathname === path).at(-1);
      if (!entry) throw new Error(`App module was not loaded: ${path}`);
      return import(entry.name);
    };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
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
  await page.evaluate(model => {
    window.__mycoMock.settings({ query_provider: "builtin-local", query_model: model });
    window.__mycoMock.indexedPages(30);
  }, model);
  if (width <= 768) await page.locator(".phone-tabbar").getByRole("button", { name: "질문", exact: true }).click();
  else await page.locator(".side-nav .nav-item").filter({ hasText: /^질문$/ }).click();
  await page.locator(".ask-composer input.input").waitFor();
  await page.evaluate(async ({ model, answer, stamp }) => {
    const query = (await window.__importAppModule("/src/stores/queryStore.ts")).useQueryStore;
    const vault = (await window.__importAppModule("/src/stores/vaultStore.ts")).useVaultStore;
    const ui = (await window.__importAppModule("/src/stores/uiStore.ts")).useUIStore;
    const settings = (await window.__importAppModule("/src/stores/settingsStore.ts")).useSettingsStore;
    await settings.getState().load();
    query.getState().clear();
    const root = vault.getState().currentVault.path;
    const a = `${root}/wiki/synthetic-cache.md`, b = `${root}/wiki/synthetic-retrieval.md`;
    vault.setState({ adjacency: {
      forward: { [a]: [b], [b]: [] }, backward: { [b]: [a] }, unresolved: {}, unread: [],
      tags: { [a]: ["synthetic-topic"], [b]: ["synthetic-topic"] },
      meta: { [a]: { title: "합성 캐시" }, [b]: { title: "합성 검색" } },
    } });
    const fixture = window.__synthesisFixture = {
      query, vault, ui, settings, root, mode: "ready", opaqueSources: false, clockStep: 0, searches: [], requests: [],
      cancels: [], releases: [], statuses: 0, temporal: [], appended: [], clipboard: [], forbidden: [],
    };
    // MOCK clipboard: inspect what the real copy button writes without using
    // the user's OS clipboard or reading any prior clipboard contents.
    Object.defineProperty(navigator, "clipboard", { configurable: true,
      value: { writeText: text => { fixture.clipboard.push(text); return Promise.resolve(); } },
    });
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const response = text => ({ answer: text, model_id: model, used_sources: ["wiki/synthetic-cache.md"] });
    window.__TAURI_INTERNALS__.invoke = (command, args = {}) => {
      if (command === "ask_history_load") return Promise.resolve([]);
      if (command === "ask_history_append") { fixture.appended.push(args); return Promise.resolve(); }
      if (command === "semantic_search") {
        fixture.searches.push(args);
        const hits = fixture.opaqueSources ? Array.from({ length: 6 }, (_, index) => {
          const stem = `source-codex-${String(index + 1).padStart(8, "0")}-1111-2222-3333-444444444444`;
          return { page: `wiki/${stem}.md`, stem, section: 0, text: `SYN-SOURCE original passage ${index + 1}.`, similarity: 0.8, score: 0.03 - index * 0.001 };
        }) : [{
          page: "wiki/synthetic-cache.md", stem: "synthetic-cache", section: 0,
          text: "# 합성 캐시\nSYN-SOURCE 캐시는 반복 요청의 결과를 재사용합니다.",
          similarity: null, exact_match: true, score: 0.03,
        }];
        return Promise.resolve({ floor: 0.42, below_floor: [], hits: fixture.mode === "empty" ? [] : hits });
      }
      if (command === "local_chat_status") {
        fixture.statuses++;
        if (fixture.mode === "status-error") return Promise.reject(new Error("Synthetic status IPC failure"));
        return Promise.resolve({ model_id: model, state: fixture.mode === "missing" ? "missing" : fixture.mode === "state-error" ? "error" : "ready", bytes: fixture.mode === "missing" ? 0 : 2707513696 });
      }
      if (command === "local_synthesize") {
        fixture.requests.push(args.request);
        const refusedSource = ["source_verification_failed", "source_changed_during_generation"].find(reason => fixture.mode === `held-${reason}`);
        if (refusedSource) return new Promise(resolve => fixture.releases.push(() => resolve({ answer: "", model_id: model, used_sources: [], fallback_reason: refusedSource })));
        if (fixture.mode === "held") return new Promise(resolve => fixture.releases.push(() => resolve(response("SYN-LATE must never replace the next answer. [[wiki/synthetic-cache]]"))));
        if (fixture.mode === "synthesis-error") return Promise.reject(new Error("Synthetic synthesis IPC failure"));
        if (fixture.mode === "malformed") return Promise.resolve(response("SYN-INVALID unsupported citation. [[wiki/outside-evidence]]"));
        if (fixture.mode.startsWith("native-")) return Promise.resolve({ answer: "", model_id: model, used_sources: [], fallback_reason: fixture.mode.slice("native-".length) });
        return Promise.resolve(response(answer));
      }
      if (command === "cancel_local_synthesis") { fixture.cancels.push(args.requestId); return Promise.resolve(true); }
      if (command === "temporal_recall") {
        fixture.temporal.push(args);
        return Promise.resolve({ indexed_pages: 30, scanned_pages: 10, matched_events: 1, incomplete: false,
          events: [{ page: "sessions/2026-10-03/synthetic-thread.md", stem: "synthetic-thread", section: 0,
            role: "user", timestamp: stamp, text: "SYN-DATED 사용자가 캐시 검증을 요청했습니다." }],
        });
      }
      if (["local_query", "chat_complete", "claude_run", "claude_run_stream", "agent_run", "download_local_chat_model"].includes(command)) {
        fixture.forbidden.push(command);
        return Promise.reject(new Error("Synthetic Ask fixture must not invoke this command"));
      }
      return invoke(command, args);
    };
  }, { model, answer, stamp });
  await page.clock.setFixedTime(new Date("2026-10-04T12:00:00+09:00"));
  return { page, context, errors, blocked };
}

try {
  for (const width of followUpOnly ? [1280] : [375, 768, 1280]) {
    const { page, context, errors, blocked } = await fixturePage(width);
    try {
      if (fallbackOnly || incompleteOnly) {
        await verifyFallbacks(page, String(width));
        if (!incompleteOnly) await verifySourceRefusals(page, String(width));
        check(`${width}: fallback diagnostics never download or invoke an external generator`, await page.evaluate(() => window.__synthesisFixture.forbidden.length === 0));
        check(`${width}: fallback diagnostics have no browser errors or unhandled rejection`, errors.length === 0, errors.join(" | "));
        continue;
      }
      if (freshnessOnly) {
        await verifySourceRefusals(page, String(width));
        check(`${width}: source freshness never invokes a download or external generator`, await page.evaluate(() => window.__synthesisFixture.forbidden.length === 0));
        check(`${width}: source freshness has no browser errors or unhandled rejection`, errors.length === 0, errors.join(" | "));
        continue;
      }
      if (followUpOnly) {
        await verifyQuestionContext(page, String(width));
        check("focused follow-up: no unexpected generation or download commands", await page.evaluate(() => window.__synthesisFixture.forbidden.length === 0));
        check("focused follow-up: no browser errors or unhandled rejection", errors.length === 0, errors.join(" | "));
        continue;
      }
      const turn = await ask(page, "합성 캐시 설명해줘");
      const rendered = page.locator(".ask-turn").last();
      const text = await rendered.innerText();
      check(`${width}: the generated body is rendered without source-quote replacement`, turn.a === answer && text.includes("SYN-GENERATED") && !text.includes("SYN-SOURCE") && await rendered.locator(".ask-split").count() === 0);
      check(`${width}: provenance identifies the actual local model`, turn.localModel === model && turn.extractive === false && text.includes(model) && text.includes("내 컴퓨터"));
      check(`${width}: verified relative citations remain clickable`, await rendered.locator('a[data-link="wiki/synthetic-cache"]').count() === 1);
      const request = await page.evaluate(() => window.__synthesisFixture.requests.at(-1));
      check(`${width}: local request contains only scoped retrieved passages`, request.expectedVault === await page.evaluate(() => window.__synthesisFixture.root) && request.scope === "wiki" && request.hits.length === 1 && request.hits[0].page === "wiki/synthetic-cache.md" && request.hits[0].text.includes("SYN-SOURCE") && request.maxTokens === 192 && request.modelId === model);
      const copy = rendered.getByRole("button", { name: "답변 복사", exact: true });
      await copy.focus();
      await copy.press("Enter");
      await page.waitForFunction(() => window.__synthesisFixture.clipboard.length === 1);
      check(`${width}: keyboard copy writes the generated markdown and citation`, await page.evaluate(answer => window.__synthesisFixture.clipboard[0] === answer, answer));
      check(`${width}: recorded history preserves synthesis instead of raw quotes`, await page.evaluate(answer => window.__synthesisFixture.appended.at(-1)?.turn.a === answer, answer));
      const options = page.getByTestId("ask-options");
      await options.locator("summary").focus();
      await options.locator("summary").press("Enter");
      check(`${width}: Qwen options identify the selected model without claiming quotes only`, (await options.innerText()).includes(model) && !(await options.innerText()).includes("모델 미사용"));
      check(`${width}: Qwen options explain local retrieval and optional synthesis`, (await options.innerText()).includes("E5") && (await options.innerText()).includes("Qwen") && (await options.innerText()).includes("종합"));
      await options.locator("summary").press("Enter");
      check(`${width}: generated Ask fits the viewport`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      if (width !== 768) await page.screenshot({ path: `${output}/generated-${width}.png`, fullPage: true });
      await verifyQuestionContext(page, String(width));
      await verifySourceRefusals(page, String(width));
      await verifyFallbacks(page, String(width));

      await page.evaluate(() => { window.__synthesisFixture.mode = "held"; });
      await submit(page, "합성 캐시 중단 검증");
      await page.waitForFunction(() => window.__synthesisFixture.releases.length === 1);
      const pendingId = await page.evaluate(() => window.__synthesisFixture.requests.at(-1).requestId);
      const label = await page.locator(".thinking-galaxy").getAttribute("aria-label");
      check(`${width}: actual synthesis reports thinking without a guessed source count`, await page.evaluate(() => {
        const stage = window.__synthesisFixture.query.getState().stage;
        return stage?.kind === "thinking" && stage.stems.length === 0;
      }) && label === "답변 작성 중…");
      const stop = page.getByRole("button", { name: "답 멈추기", exact: true });
      await stop.focus();
      await stop.press("Enter");
      await page.waitForFunction(() => !window.__synthesisFixture.query.getState().busy);
      check(`${width}: Stop cancels the exact request and frees the composer`, await page.evaluate(id => window.__synthesisFixture.cancels.at(-1) === id && window.__synthesisFixture.query.getState().turns.at(-1).stopped, pendingId) && await page.locator(".ask-composer input.input").isEnabled());
      check(`${width}: user cancellation never renders a quote fallback notice`, await page.locator(".ask-turn").last().getByTestId("ask-local-fallback").count() === 0);
      await page.evaluate(() => { window.__synthesisFixture.mode = "ready"; });
      await ask(page, "합성 캐시 다음 답 검증");
      await page.evaluate(async () => {
        window.__synthesisFixture.releases.shift()();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      check(`${width}: late cancelled synthesis cannot replace the next answer or history`, await page.evaluate(answer => {
        const f = window.__synthesisFixture;
        return f.query.getState().turns.at(-1).a === answer && !f.query.getState().turns.some(turn => turn.a.includes("SYN-LATE")) && !f.appended.some(entry => entry.turn.a.includes("SYN-LATE"));
      }, answer));

      if (width === 1280) {
        for (const mode of ["missing", "state-error", "status-error", "synthesis-error", "malformed", "empty"]) {
          const counts = await page.evaluate(mode => {
            const f = window.__synthesisFixture;
            f.mode = mode;
            return { requests: f.requests.length, statuses: f.statuses };
          }, mode);
          const fallback = await ask(page, `합성 캐시 ${mode} 검증`);
          const body = await page.locator(".ask-turn").last().innerText();
          check(`${mode}: failed or missing synthesis keeps honest retrieval output`, !fallback.localModel && !fallback.error && (mode === "empty" ? fallback.abstained && !fallback.hits?.length : fallback.extractive && body.includes("SYN-SOURCE")) && !body.includes("SYN-INVALID") && !body.includes("SYN-GENERATED"));
          check(`${mode}: no unnecessary model request or status read`, await page.evaluate(({ mode, counts }) => {
            const f = window.__synthesisFixture;
            return f.requests.length === counts.requests + (["synthesis-error", "malformed"].includes(mode) ? 1 : 0) && f.statuses === counts.statuses + (mode === "empty" ? 0 : 1);
          }, { mode, counts }));
        }

        await page.evaluate(() => { window.__synthesisFixture.mode = "ready"; });
        check("dated scope is selected with keyboard", await chooseScope(page, "대화 기록"));
        const before = await page.evaluate(() => ({ requests: window.__synthesisFixture.requests.length, statuses: window.__synthesisFixture.statuses, searches: window.__synthesisFixture.searches.length }));
        const dated = await ask(page, "어제한 일");
        const datedText = await page.locator(".ask-turn").last().innerText();
        check("dated records preserve scope, source role and original timestamp", dated.scope === "sessions" && datedText.includes("범위 · 대화 기록") && datedText.includes("user") && dated.a.includes("SYN-DATED") && dated.a.includes("[[sessions/2026-10-03/synthetic-thread|synthetic-thread]]") && await page.evaluate(stamp => window.__synthesisFixture.temporal.at(-1).range.startEpoch === stamp - 33600, stamp));
        check("dated records bypass the selected generator and semantic search", await page.evaluate(before => { const f = window.__synthesisFixture; return f.requests.length === before.requests && f.statuses === before.statuses && f.searches.length === before.searches; }, before) && !dated.localModel);
        await chooseScope(page, "내 노트");
        const connected = await ask(page, "서로 연결되는 아이디어가 있어?");
        check("existing-link overview preserves its evidence route", connected.scope === "wiki" && connected.a.includes("[[wiki/synthetic-cache|합성 캐시]]") && connected.a.includes("[[wiki/synthetic-retrieval|합성 검색]]") && connected.a.includes("기존 링크") && !connected.localModel);
        check("existing-link overview bypasses the selected generator", await page.evaluate(before => { const f = window.__synthesisFixture; return f.requests.length === before.requests && f.statuses === before.statuses && f.searches.length === before.searches; }, before));

        await chooseScope(page, "모든 자료");
        await page.evaluate(() => { const f = window.__synthesisFixture; f.query.getState().setNoteScope({ path: `${f.root}/wiki/synthetic-cache.md`, title: "합성 캐시" }); });
        await ask(page, "어제 합성 캐시 설명해줘");
        check("synthesis carries resolved all/note/date boundaries without widening", await page.evaluate(() => {
          const f = window.__synthesisFixture, r = f.requests.at(-1), search = f.searches.at(-1);
          const expected = ["wiki/synthetic-cache.md", "wiki/synthetic-retrieval.md"];
          return r.scope === "all" && r.range.start === "2026-10-03" && r.range.end === "2026-10-03" && Number.isFinite(r.range.startEpoch) && r.range.endEpoch === r.range.startEpoch + 86400 && JSON.stringify(r.paths) === JSON.stringify(expected) && search.scope === r.scope && JSON.stringify(search.paths) === JSON.stringify(r.paths);
        }));

        await page.evaluate(() => { const f = window.__synthesisFixture; f.query.getState().setNoteScope(null); f.mode = "held"; });
        await submit(page, "합성 캐시 초기화 검증");
        await page.waitForFunction(() => window.__synthesisFixture.releases.length === 1);
        const clearId = await page.evaluate(() => window.__synthesisFixture.requests.at(-1).requestId);
        await page.evaluate(() => window.__synthesisFixture.query.getState().clear());
        check("clearing a pending answer cancels its exact native request", await page.evaluate(id => window.__synthesisFixture.cancels.at(-1) === id && !window.__synthesisFixture.query.getState().busy, clearId) && await page.locator(".ask-turn").count() === 0);
        await page.evaluate(() => { window.__synthesisFixture.mode = "ready"; });
        await ask(page, "합성 캐시 새 대화 검증");
        await page.evaluate(async () => { window.__synthesisFixture.releases.shift()(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
        check("late cleared synthesis cannot repopulate the conversation", await page.evaluate(answer => { const turns = window.__synthesisFixture.query.getState().turns; return turns.length === 1 && turns[0].a === answer && !turns[0].a.includes("SYN-LATE"); }, answer));
      }
      check(`${width}: no unexpected generation or download commands`, await page.evaluate(() => window.__synthesisFixture.forbidden.length === 0));
      check(`${width}: no browser errors or unhandled rejection`, errors.length === 0, errors.join(" | "));
      console.log(JSON.stringify({ width, deliberatelyBlockedRemoteResources: [...blocked] }));
    } finally { await context.close(); }
  }
} catch (error) {
  check("browser smoke completed", false, error.stack ?? String(error));
} finally { await browser.close(); }
for (const result of results) console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name}${result.detail ? ` — ${result.detail}` : ""}`);
const failed = results.filter(result => !result.ok).length;
console.log(`${results.length - failed}/${results.length} passed (synthetic UI/IPC and clipboard; no native inference or model download)`);
console.log(fallbackOnly || incompleteOnly ? `Screenshots: ${output}/fallback-375.png, fallback-768.png and fallback-1280.png` : freshnessOnly ? `Screenshots: ${output}/source-changed-375.png, source-changed-768.png and source-changed-1280.png` : followUpOnly ? `Screenshot: ${output}/followup-1280.png` : `Screenshots: ${output}/generated-375.png and ${output}/generated-1280.png`);
process.exitCode = failed ? 1 : 0;
