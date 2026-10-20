// Real Ingest UI with synthetic IPC/files only; no native inference or vault.
// Usage: MYCO_TEST_URL=http://127.0.0.1:5173 node scripts/local-transform-smoke.mjs
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = new URL(process.env.MYCO_TEST_URL ?? "http://127.0.0.1:5173");
const loopback = ["127.0.0.1", "localhost", "[::1]"];
assert.ok(loopback.includes(base.hostname), "Use a loopback development server");
const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok, detail });
const body = Array.from({ length: 12 }, (_, index) =>
  `**User:**\n\nSYN-LOCAL-${index} 검색 연결 개선을 제안했습니다. 실행 완료는 기록되지 않았으며, 이 문장은 합성 원문 검증을 위한 자료입니다.`,
).join("\n\n");
const browser = await chromium.launch();

async function fixture(mode) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const blocked = new Set();
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (loopback.includes(url.hostname) || !["http:", "https:"].includes(url.protocol)) return route.continue();
    blocked.add(url.hostname);
    return route.abort("blockedbyclient");
  });
  await context.addInitScript(() => {
    // Retain late route modules after the home page's resource fanout.
    performance.setResourceTimingBufferSize(2000);
    localStorage.setItem("myco.onboarded", "1");
    localStorage.setItem("myco-ui", JSON.stringify({ version: 3, state: { lang: "ko", theme: "light" } }));
    window.__importAppModule = path => {
      const entry = performance.getEntriesByType("resource")
        .filter(resource => new URL(resource.name).pathname === path).at(-1);
      if (!entry) throw new Error(`App module was not loaded: ${path}`);
      return import(entry.name);
    };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  const blockedFailures = new Set();
  const externalResponses = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("requestfailed", request => {
    const url = new URL(request.url());
    if (!loopback.includes(url.hostname) && request.failure()?.errorText.includes("ERR_BLOCKED_BY_CLIENT")) {
      blockedFailures.add(url.hostname);
    }
  });
  page.on("response", response => {
    const url = new URL(response.url());
    if (["http:", "https:"].includes(url.protocol) && !loopback.includes(url.hostname)) externalResponses.push(url.hostname);
  });
  await page.goto(new URL("/?mock=1", base).toString());
  await page.locator(".home-page").waitFor();
  await page.waitForFunction(async () => {
    const { useVaultStore } = await window.__importAppModule("/src/stores/vaultStore.ts");
    const state = useVaultStore.getState();
    return state.currentVault !== null && !state.isOpeningVault && state.adjacency !== null;
  });
  const labels = await page.evaluate(async () => {
    if (!window.__mycoMock || !window.__TAURI_INTERNALS__) throw new Error("Synthetic IPC mock is required");
    const { BUILTIN_FAST_CHAT_MODEL } = await window.__importAppModule("/src/lib/providers.ts");
    window.__mycoMock.settings({ query_provider: "builtin-local", query_model: "extractive-retrieval",
      ingest_provider: "builtin-local", ingest_model: BUILTIN_FAST_CHAT_MODEL, auto_ingest_enabled: false });
    const { useSettingsStore } = await window.__importAppModule("/src/stores/settingsStore.ts");
    await useSettingsStore.getState().load();
    const { STRINGS } = await window.__importAppModule("/src/lib/i18n.ts");
    return { nav: STRINGS.ko.nav_ingest, cancel: STRINGS.ko.ing_cancel,
      cancelled: STRINGS.ko.ing_cancelled, success: STRINGS.ko.ing_success_title,
      falseHint: STRINGS.ko.ing_extractive_hint, localHint: STRINGS.ko.ing_local_transform_hint,
      submit: STRINGS.ko.ing_run_local_transform };
  });
  await page.locator(".side-nav").getByRole("button", { name: labels.nav, exact: true }).click();
  await page.locator("#ingest-body").waitFor();
  await page.evaluate(async mode => {
    const { BUILTIN_FAST_CHAT_MODEL } = await window.__importAppModule("/src/lib/providers.ts");
    const { useVaultStore } = await window.__importAppModule("/src/stores/vaultStore.ts");
    const { useIngestStore } = await window.__importAppModule("/src/stores/ingestStore.ts");
    const { fingerprint } = await window.__importAppModule("/src/lib/sessionEvidence.ts");
    const root = useVaultStore.getState().currentVault.path;
    if (root !== "/myco") throw new Error("Use only the synthetic mock vault");
    const original = window.__TAURI_INTERNALS__.invoke;
    const files = new Map();
    for (const rel of ["wiki/index.md", "wiki/log.md"]) {
      files.set(`${root}/${rel}`, (await original("read_file", { path: `${root}/${rel}` })).raw);
    }
    const state = window.__transformFixture = { mode, root, model: BUILTIN_FAST_CHAT_MODEL, files,
      ingest: useIngestStore, trace: [], requests: [], cancelled: [], remote: [], released: false, settled: false };
    const digest = async raw => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)))]
      .map(byte => byte.toString(16).padStart(2, "0")).join("");
    const write = async (path, content, command) => {
      if (!path.startsWith(`${root}/`)) throw new Error("Synthetic write escaped the mock vault");
      if (path.includes("/raw/") && files.has(path)) throw new Error("Synthetic raw is immutable");
      files.set(path, content);
      state.trace.push({ command, path, content });
      return original("write_file", { path, content });
    };
    window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
      if (["claude_run", "claude_run_stream", "myco_pro_ingest", "agent_chat", "chat_complete", "local_query"].includes(command)) {
        state.remote.push(command);
        throw new Error("Synthetic local workflow must not invoke another provider");
      }
      if (command === "read_file" && files.has(args.path)) {
        const raw = files.get(args.path);
        return { path: args.path, raw, content: raw, frontmatter: null };
      }
      if (command === "read_file" && /\/wiki\/source-synthetic-local-/.test(args.path)) throw new Error("ENOENT: synthetic note is absent");
      if (command === "write_file") return write(args.path, args.content, command);
      if (command === "write_file_if_unchanged") {
        if (args.path.includes("/raw/")) throw new Error("Synthetic raw is immutable");
        const current = files.get(args.path) ?? null;
        if (args.expectedSha256 !== (current === null ? null : await digest(current))) throw new Error("write conflict: synthetic CAS failed");
        if (current !== (files.get(args.path) ?? null)) throw new Error("write conflict: synthetic file changed");
        return write(args.path, args.content, command);
      }
      if (command === "file_mtimes") return [...files.keys()].map(path => [path, 1]);
      if (command === "wikify_candidates") return [{ page: "wiki/embeddings.md", stem: "embeddings", score: 0.8 }];
      if (command === "local_transform") {
        const request = args.request;
        if (request.modelId !== state.model || request.expectedVault !== root || request.kind !== "ingest" || request.lang !== "ko") {
          throw new Error("Synthetic local transform used the wrong role/model/scope");
        }
        if (!request.sources.length || request.sources.length > 6) throw new Error("Synthetic excerpt budget exceeded");
        for (const source of request.sources) {
          const raw = files.get(`${root}/${source.page}`);
          if (!raw || fingerprint(raw) !== source.revision || !raw.includes(source.text) || source.text.length > 600) {
            throw new Error("Synthetic local transform received unverified saved raw");
          }
        }
        state.requests.push(request);
        const answer = "검색 연결 개선을 제안한 기록이며 실행 완료는 기록되지 않았습니다. " +
          `[[${request.sources[0].page.replace(/\.md$/, "")}]]`;
        const reply = { answer, model_id: state.model, used_sources: [request.sources[0].page], selected_chunks: 2 };
        if (mode === "held") return new Promise(resolve => {
          state.release = () => { state.released = true; resolve(reply); state.settled = true; };
        });
        return reply;
      }
      if (command === "cancel_local_synthesis") { state.cancelled.push(args.requestId); return true; }
      return original(command, args);
    };
  }, mode);
  return { context, page, labels, errors, blocked, blockedFailures, externalResponses };
}

try {
  for (const mode of ["success", "held"]) {
    const { context, page, labels, errors, blocked, blockedFailures, externalResponses } = await fixture(mode);
    const title = `Synthetic local ${mode}`;
    await page.locator("#ingest-title").fill(title);
    await page.locator("#ingest-body").fill(body);
    check(`${mode}: selected local generator does not claim zero model calls`,
      !(await page.locator(".intake-storage").innerText()).includes(labels.falseHint));
    check(`${mode}: selected local generator explains draft and quote preservation`,
      (await page.locator(".intake-storage").innerText()).includes(labels.localHint));
    await page.locator(".intake-submit").getByRole("button", { name: labels.submit, exact: true }).click();
    await page.waitForFunction(() => window.__transformFixture.requests.length === 1);
    const submitted = await page.evaluate(() => ({ request: window.__transformFixture.requests[0],
      model: window.__transformFixture.model, root: window.__transformFixture.root }));
    check(`${mode}: actual Ingest action passes selected 2B model`, submitted.model === "qwen3.5-2b-q4_k_m" && submitted.request.modelId === submitted.model);
    check(`${mode}: bounded original excerpts carry raw FNV8 revisions`, submitted.request.sources.length === 6 &&
      submitted.request.sources.every(source => /^raw\//.test(source.page) && /^[0-9a-f]{8}$/.test(source.revision) && source.text.length <= 600));
    if (mode === "held") {
      check("held: processing UI does not claim zero model calls",
        !(await page.locator(".intake-processing").innerText()).includes(labels.falseHint));
      await page.locator(".ingest-cancel").getByText(labels.cancel, { exact: true }).click();
      await page.waitForFunction(() => window.__transformFixture.ingest.getState().stage === "cancelled");
      await page.getByText(labels.cancelled, { exact: true }).first().waitFor();
      let state = await page.evaluate(() => ({ cancelled: window.__transformFixture.cancelled,
        paths: window.__transformFixture.trace.map(write => write.path), stage: window.__transformFixture.ingest.getState().stage }));
      check("held: Stop cancels exactly its native transform request", state.cancelled.length === 1 && state.cancelled[0] === submitted.request.requestId);
      check("held: Stop retains only the already-saved immutable original", state.paths.length === 1 && state.paths[0].includes("/raw/"));
      await page.evaluate(async () => { window.__transformFixture.release(); await new Promise(resolve => setTimeout(resolve, 0)); });
      state = await page.evaluate(() => ({ paths: window.__transformFixture.trace.map(write => write.path),
        stage: window.__transformFixture.ingest.getState().stage, settled: window.__transformFixture.settled }));
      check("held: late success cannot write wiki/catalog/log/report artifacts", state.settled && state.paths.length === 1 && state.stage === "cancelled");
      check("held: cancelled UI remains visible after late success", await page.getByText(labels.cancelled, { exact: true }).first().isVisible());
    } else {
      await page.waitForFunction(() => ["done", "error"].includes(window.__transformFixture.ingest.getState().stage));
      const saved = await page.evaluate(async () => {
        const state = window.__transformFixture;
        const { sourceEvidence, completedEvidenceSources } = await window.__importAppModule("/src/lib/sessionEvidence.ts");
        const request = state.requests[0];
        const raw = state.files.get(`${state.root}/${request.sources[0].page}`);
        const notePath = state.trace.find(write => write.path.includes("/wiki/source-synthetic-local-")).path;
        const note = state.files.get(notePath);
        const source = sourceEvidence(request.sources[0].page, raw, "2026-10-05");
        return { stage: state.ingest.getState().stage, raw, note, notePath, sourceChunks: source.chunks.length,
          fullCoverage: completedEvidenceSources([source], note).length === 1, model: state.model,
          report: state.trace.find(write => write.path.includes("/ingest-reports/"))?.content,
          paths: state.trace.map(write => write.path) };
      });
      check("success: real UI reaches done", saved.stage === "done", saved.stage);
      check("success: saved raw includes its heading and every original turn", saved.raw === `# ${title}\n\n${body}\n`);
      check("success: preview preserves mocked transform selected count and model ID", saved.note.includes(`전체 ${saved.sourceChunks}개 구절 중 2개`) && saved.note.includes(saved.model));
      check("success: low-confidence generated preview preserves uncertainty", saved.note.includes("confidence: low") && saved.note.includes("확인 필요") && saved.note.includes("실행 완료는 기록되지 않았습니다"));
      check("success: all original quotes and complete coverage survive", saved.fullCoverage &&
        body.split("\n\n").filter(line => line.startsWith("SYN-LOCAL-")).every(line => saved.note.includes(line)));
      check("success: deterministic related link remains", saved.note.includes("- [[embeddings]]"));
      check("success: report is truthful about the generated preview", saved.report?.includes(saved.model) && !saved.report.includes("모델 호출 없음"));
      check("success: raw is written once", saved.paths.filter(path => path.includes("/raw/")).length === 1);
      await page.getByText(labels.success, { exact: true }).first().waitFor();
      await page.evaluate(async path => {
        const { useUIStore } = await window.__importAppModule("/src/stores/uiStore.ts");
        useUIStore.getState().setRoute(`page:${path}`);
      }, saved.notePath);
      await page.getByText(/전체 \d+개 구절 중 2개로 만든 로컬 요약/).first().waitFor();
      check("success: the persisted low-confidence preview is rendered", await page.getByText(/전체 \d+개 구절 중 2개로 만든 로컬 요약/).first().isVisible());
    }
    const remote = await page.evaluate(() => window.__transformFixture.remote);
    check(`${mode}: no remote provider or legacy generation path runs`, remote.length === 0, remote.join(", "));
    check(`${mode}: external HTTP traffic is blocked before any response`, externalResponses.length === 0 &&
      [...blocked].every(host => blockedFailures.has(host)), [...blocked].join(", "));
    check(`${mode}: no uncaught browser error`, errors.length === 0, errors.join("; "));
    await context.close();
  }
} finally {
  await browser.close();
}

for (const result of results) console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name}${result.detail ? `: ${result.detail}` : ""}`);
const failed = results.filter(result => !result.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed (synthetic browser IPC; no native inference or real vault)`);
assert.equal(failed.length, 0, "Local transform browser regressions failed");
