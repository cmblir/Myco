import { beforeEach, describe, expect, it, vi } from "vitest";

// persist() resolves its storage when uiStore loads, so the in-memory
// localStorage has to exist before the stores are imported (uiStore.test.ts).
vi.hoisted(() => {
  const m = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  });
});
import { askCopy, reasksOf, useQueryStore, type AskOpts, type ChatTurn } from "./queryStore";
import { useUIStore } from "./uiStore";
import { useVaultStore } from "./vaultStore";
import type { Captured } from "../lib/dailyNote";
import { ipc, type ActivityResolutionRequest, type ActivitySynthesisReceipt, type AskRecord, type AskScope, type LocalSynthesisResult, type MycoSettings } from "../lib/ipc";
import { STRINGS } from "../lib/i18n";
import { BUILTIN_EMBED_MODEL } from "../lib/providers";
import { queryDateRange } from "../lib/timeQuery";
import { roleFixture, syntheticOrigin } from "../lib/modelRoles.testSupport";
import { useSettingsStore } from "./settingsStore";

const copy = askCopy(STRINGS.en);
const ask = (q: string, opts?: AskOpts) => useQueryStore.getState().ask(q, "en", copy, opts);
const last = (): ChatTurn => useQueryStore.getState().turns.at(-1) as ChatTurn;
function syntheticActivityReceipt(range: { start: string; end: string }, scope: AskScope = "wiki", resolution?: ActivityResolutionRequest): ActivitySynthesisReceipt {
  const period = queryDateRange(range);
  return { activityPeriod: { ...range, startEpoch: resolution ? period.startEpoch : null, endEpoch: resolution ? period.endEpoch : null }, scope,
    eligibleOriginalSpans: 1, boundedWindows: 1, processedWindows: 1, omittedWindows: 0,
    originalPeriodCounts: { inPeriodSpans: 1, outsidePeriodSpans: 0, uncertainSpans: 0 },
    extractionBatches: 1, proposedClaims: 1, selectedClaims: 1, omittedClaims: 0, answerOriginalSpans: 1,
    answerPeriodCounts: { inPeriodSpans: 1, outsidePeriodSpans: 0, uncertainSpans: 0 },
    claimSourceAndStructureChecked: true, semanticReviewRequired: true, independentVerificationReceipts: 0,
    automatedClaimReviews: 1, automatedAnswerReviewInputRevision: "a".repeat(64),
    originalInputsIncomplete: false,
    resolutionWindow: resolution ? { ...resolution, startEpoch: period.startEpoch, endEpoch: resolution.asOfEpoch + 1 } : null,
    ...(resolution ? { resolutionCoverage: { candidateChunks: 0, scannedPages: 0, admittedPages: 0, originalSpans: 0,
      processedWindows: 0, omittedWindows: 0, excludedAfterAsOfSpans: 0, undatedSpans: 0,
      readBytes: 0, incomplete: false, issues: [] }, additionalSources: [] } : {}) };
}

it.each([
  ["en", "Scanned {scanned} pages · {sources} citation pages"],
  ["ko", "검색한 페이지 {scanned}개 · 인용 페이지 {sources}개"],
  ["ja", "{scanned}ページを検索 · 引用元{sources}ページ"],
] as const)("labels activity retrieval coverage as pages rather than reviewed records: %s", (lang, label) => {
  expect(STRINGS[lang].q_activity_coverage).toBe(label);
});

beforeEach(() => {
  useUIStore.setState({ isAskScopeExplicit: false });
  useSettingsStore.setState({ settings: null, saving: false, loading: false });
});

/** Synthetic native DTOs exercise frontend dispatch, not native authority. */
function stubAskRole(provider = "builtin-local", model = "extractive-retrieval") {
  vi.spyOn(ipc, "agentVaultSession").mockResolvedValue(syntheticOrigin);
  if (!vi.isMockFunction(ipc.askHistoryAppend)) vi.spyOn(ipc, "askHistoryAppend").mockResolvedValue(null);
  return vi.spyOn(ipc, "captureModelRole").mockResolvedValue(roleFixture("ask", provider, model));
}

/** The extractive path over a healthy index that finds nothing: the turn
 *  abstains, which is where "widen" and the period copy live. */
function stubExtractive() {
  stubAskRole();
  vi.spyOn(ipc, "getSettings").mockResolvedValue({
    query_provider: "builtin-local",
  } as MycoSettings);
  vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({
    indexed_pages: 3,
    model: `builtin-local:${BUILTIN_EMBED_MODEL}`,
  } as Awaited<ReturnType<typeof ipc.embeddingsStatus>>);
  vi.spyOn(ipc, "classifyIntent").mockResolvedValue(null as never);
  vi.spyOn(ipc, "temporalRecall").mockResolvedValue({
    events: [], indexed_pages: 3, scanned_pages: 3, matched_events: 0, incomplete: false,
  });
  return vi
    .spyOn(ipc, "semanticSearch")
    .mockResolvedValue({ hits: [], floor: 0.42, below_floor: [] });
}

/** The extractive path over a healthy index that quotes one note. */
function stubAnswer() {
  stubAskRole();
  vi.spyOn(ipc, "getSettings").mockResolvedValue({
    query_provider: "builtin-local",
  } as MycoSettings);
  vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({
    indexed_pages: 3,
    model: `builtin-local:${BUILTIN_EMBED_MODEL}`,
  } as Awaited<ReturnType<typeof ipc.embeddingsStatus>>);
  vi.spyOn(ipc, "semanticSearch").mockResolvedValue({
    hits: [
      {
        page: "wiki/attention-mechanism.md",
        stem: "attention-mechanism",
        section: 0,
        text: "# Attention\nattention body[^1]",
        score: 0.9,
        similarity: 0.7,
      },
    ],
    floor: 0.42,
    below_floor: [],
  });
}

describe("queryStore.ask scope", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useVaultStore.setState({ currentVault: { path: "/v", name: "v" } });
    useUIStore.setState({ askScope: "wiki" });
    useQueryStore.getState().clear();
  });

  it("never replaces yesterday's personal record with today's modified-file list", async () => {
    const search = stubExtractive();
    vi.spyOn(ipc, "classifyIntent").mockResolvedValue({ intent: "vault-files" } as never);
    const mtimes = vi.spyOn(ipc, "fileMtimes").mockResolvedValue([
      ["/v/sessions/2026-10/codex-SYNTHETIC.md", new Date(2026, 9, 4, 9).getTime() / 1000],
      ["/v/raw/conversations/2026-10/codex-SYNTHETIC.md", new Date(2026, 9, 4, 9).getTime() / 1000],
    ]);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 4, 12));
    try {
      await useQueryStore.getState().ask("어제한 일", "ko", askCopy(STRINGS.ko));
      expect(mtimes).not.toHaveBeenCalled();
      expect(search).not.toHaveBeenCalled();
      expect(ipc.temporalRecall).toHaveBeenCalledWith({ start: "2026-10-03", end: "2026-10-03" }, "all", undefined);
      expect(last().range).toEqual({ start: "2026-10-03", end: "2026-10-03" });
      expect(last().abstained).toBeUndefined();
      expect(last().a).toContain("이 기간에 해당하는 대화 원문을 찾지 못했습니다");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not treat a classifier's file-list guess as evidence for a personal decision", async () => {
    stubExtractive();
    vi.spyOn(ipc, "classifyIntent").mockResolvedValue({ intent: "vault-files" } as never);
    const mtimes = vi.spyOn(ipc, "fileMtimes").mockResolvedValue([["/v/wiki/example.md", 1]]);
    await useQueryStore.getState().ask("이전에 우리가 결정한 이유는 뭐야?", "ko", askCopy(STRINGS.ko));
    expect(mtimes).not.toHaveBeenCalled();
    expect(last().abstained).toBe(true);
  });

  it.each([
    ["git commit history yesterday", "wiki"],
    ["git commit history", "sessions"],
  ] as const)("does not answer %s in %s from an unrestricted git log or file mtimes", async (question, scope) => {
    const search = stubExtractive();
    const git = vi.spyOn(ipc, "gitLog").mockResolvedValue([]);
    const mtimes = vi.spyOn(ipc, "fileMtimes").mockResolvedValue([]);
    vi.spyOn(ipc, "classifyIntent").mockResolvedValue({ intent: "vault-files" } as never);
    await ask(question, { scope });
    expect(git).not.toHaveBeenCalled();
    expect(mtimes).not.toHaveBeenCalled();
    expect(search.mock.calls[0][5]).toBe(scope);
    if (question.includes("yesterday")) expect(last().range).toBeDefined();
  });

  it("filters explicit file activity by the requested day and scope with exact citations", async () => {
    stubExtractive();
    vi.spyOn(ipc, "classifyIntent").mockResolvedValue({ intent: "vault-files" } as never);
    vi.spyOn(ipc, "fileMtimes").mockResolvedValue([
      ["/v/wiki/one/shared.md", new Date(2026, 9, 3, 10).getTime() / 1000],
      ["/v/wiki/two/shared.md", new Date(2026, 9, 3, 11).getTime() / 1000],
      ["/v/wiki/today.md", new Date(2026, 9, 4, 10).getTime() / 1000],
      ["/v/sessions/2026-10/shared.md", new Date(2026, 9, 3, 12).getTime() / 1000],
    ]);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 4, 12));
    try {
      await ask("which notes were modified yesterday", { scope: "wiki" });
      expect(last().a).toContain("2026-10-03–2026-10-03");
      expect(last().a).toContain("[[wiki/one/shared|shared]]");
      expect(last().a).toContain("[[wiki/two/shared|shared]]");
      expect(last().a).not.toContain("today.md");
      expect(last().a).not.toContain("sessions/");
      expect(last().range).toEqual({ start: "2026-10-03", end: "2026-10-03" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("widen runs once over every scope and leaves the saved scope alone", async () => {
    const search = stubExtractive();
    await useQueryStore.getState().ask("zzqq", "en", copy, { scope: "all" });
    expect(search.mock.calls[0][5]).toBe("all");
    expect(useQueryStore.getState().turns.at(-1)?.scope).toBe("all");
    expect(useUIStore.getState().askScope).toBe("wiki");
  });

  it("without a scope, asks with the saved one", async () => {
    const search = stubExtractive();
    useUIStore.setState({ askScope: "sessions" });
    await useQueryStore.getState().ask("zzqq", "en", copy);
    expect(search.mock.calls[0][5]).toBe("sessions");
    expect(useQueryStore.getState().turns.at(-1)?.scope).toBe("sessions");
  });

  it("retrieves personal decisions across sessions without replacing them with git history", async () => {
    const search = stubExtractive();
    const git = vi.spyOn(ipc, "gitLog");
    await ask("What did we decide about the caching policy?");
    expect(search.mock.calls[0][5]).toBe("all");
    expect(search.mock.calls[0][6]).toEqual({ note: 1, map: 1, digest: 1, rollup: 1, session: 1, source: 1 });
    expect(last().scope).toBe("all");
    expect(useUIStore.getState().askScope).toBe("wiki");
    expect(git).not.toHaveBeenCalled();
  });

  it("honors an explicitly narrowed personal-history question", async () => {
    const search = stubExtractive();
    await ask("What did we decide about caching?", { scope: "wiki" });
    expect(search.mock.calls[0][5]).toBe("wiki");
  });

  it("keeps a user-selected wiki scope on a common caller after page navigation", async () => {
    const search = stubExtractive();
    useUIStore.getState().setAskScope("wiki");
    useUIStore.getState().setRoute("overview");
    useUIStore.getState().setRoute("query");
    // Spotlight/Home use the same entry point without page-local options.
    await ask("What did we decide about caching?");
    expect(search.mock.calls[0][5]).toBe("wiki");
    expect(last().scope).toBe("wiki");
  });

  it("keeps a rehydrated explicit wiki choice but lets a per-question scope override it", async () => {
    const search = stubExtractive();
    localStorage.setItem("myco-ui", JSON.stringify({ version: 3, state: {
      askScope: "wiki", isAskScopeExplicit: true,
    } }));
    await useUIStore.persist.rehydrate();
    await ask("What did we decide about caching?");
    expect(search.mock.calls[0][5]).toBe("wiki");
    await ask("What did we decide about caching?", { scope: "all" });
    expect(search.mock.calls[1][5]).toBe("all");
    expect(useUIStore.getState().askScope).toBe("wiki");
  });
});

describe("queryStore generic connections", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useVaultStore.setState({ currentVault: { path: "/v", name: "v" }, adjacency: {
      forward: { "/v/wiki/a.md": ["/v/wiki/b.md"], "/v/wiki/b.md": [] },
      backward: { "/v/wiki/b.md": ["/v/wiki/a.md"] }, unresolved: {},
      tags: { "/v/wiki/a.md": ["synthetic"], "/v/wiki/b.md": ["synthetic"] },
    } });
    useUIStore.setState({ askScope: "wiki" });
    useQueryStore.getState().clear();
  });

  it("answers a generic relationship question from existing links with citations", async () => {
    const search = stubExtractive();
    await useQueryStore.getState().ask("서로 연결되는 아이디어가 있어?", "ko", askCopy(STRINGS.ko));
    expect(last().a).toContain("기존 링크");
    expect(last().a).toContain("[[wiki/a|a]] → [[wiki/b|b]]");
    expect(last().a).toContain("공통 태그");
    expect(last().abstained).toBeUndefined();
    expect(search).not.toHaveBeenCalled();
  });

  it("keeps session capability limits and dated retrieval instead of pulling wiki links into them", async () => {
    const search = stubExtractive();
    await ask("Are there any connected ideas?", { scope: "sessions" });
    expect(last().scope).toBe("sessions");
    expect(last().abstained).toBe(true);
    expect(last().a).not.toContain("[[wiki/a");
    expect(last().abstainExplanation).toContain("conversation-only scope");
    await ask("Are there any connected ideas yesterday?");
    expect(last().range).toBeDefined();
    expect(search).toHaveBeenCalledOnce();
  });

  it.each(["extractive-retrieval", "qwen3.5-4b-q4_k_m"])("does not treat a session test plan containing the generic question as connection evidence with %s", async (model) => {
    const search = stubExtractive();
    stubAskRole("builtin-local", model);
    vi.mocked(ipc.getSettings).mockResolvedValue({ query_provider: "builtin-local", query_model: model } as MycoSettings);
    search.mockResolvedValue({ hits: [{ page: "sessions/2026-10/synthetic-test-plan.md", stem: "Synthetic test plan", section: 0,
      text: "**Assistant:**\n\n브라우저에서 '서로 연결되는 아이디어가 있어?' 질문과 UI를 검증할 계획입니다.",
      score: 0.8, similarity: 0.72, exact_match: true }], floor: 0.42, below_floor: [] });
    const status = vi.spyOn(ipc, "localChatStatus");
    const synthesize = vi.spyOn(ipc, "localSynthesize");
    const graph = vi.spyOn(ipc, "buildLinkGraph");
    const temporal = vi.mocked(ipc.temporalRecall);
    await useQueryStore.getState().ask("서로 연결되는 아이디어가 있어?", "ko", askCopy(STRINGS.ko), { scope: "sessions" });
    expect(last()).toMatchObject({ scope: "sessions", abstained: true });
    expect(last().abstainExplanation).toContain("범위 넓혀 다시 찾기");
    expect(last().a).not.toContain("브라우저");
    expect(last().hits).toBeUndefined();
    expect(last().trace).toBeUndefined();
    expect(reasksOf(last()).widen).toEqual({ scope: "all", ignoreRange: true });
    expect(ipc.embeddingsStatus).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    expect(synthesize).not.toHaveBeenCalled();
    expect(graph).not.toHaveBeenCalled();
    expect(temporal).not.toHaveBeenCalled();
  });

  it("keeps specific session relationship questions on scoped retrieval", async () => {
    const search = stubExtractive();
    await ask("How do caching and memory relate?", { scope: "sessions" });
    expect(search).toHaveBeenCalledOnce();
    expect(search.mock.calls[0][5]).toBe("sessions");
    expect(last().abstainExplanation).toBeUndefined();
  });

  it("preserves the period and widening choices on a dated session connection notice", async () => {
    const search = stubExtractive();
    await useQueryStore.getState().ask("어제 서로 연결되는 아이디어가 있어?", "ko", askCopy(STRINGS.ko), { scope: "sessions" });
    expect(last()).toMatchObject({ scope: "sessions", abstained: true, range: expect.any(Object) });
    expect(last().abstainExplanation).toContain("대화 기록 범위");
    expect(reasksOf(last()).widen).toEqual({ scope: "all", ignoreRange: false, range: last().range });
    expect(reasksOf(last()).dropRange).toEqual({ scope: "sessions", ignoreRange: true });
    expect(search).not.toHaveBeenCalled();
    expect(ipc.temporalRecall).not.toHaveBeenCalled();
  });
});

describe("queryStore local synthesis", () => {
  const model = "qwen3.5-4b-q4_k_m";
  const answer = "Synthetic synthesis. [[wiki/attention-mechanism|attention-mechanism]]";
  const synthesized = { answer, model_id: model, used_sources: ["wiki/attention-mechanism.md"],
    answerReceipt: { answerOriginalSpans: 1, automatedAnswerReviewInputRevision: "d".repeat(64) } };
  beforeEach(() => {
    vi.restoreAllMocks();
    useVaultStore.setState({ currentVault: { path: "/v", name: "Synthetic vault" }, adjacency: null, isOpeningVault: false });
    useUIStore.setState({ askScope: "wiki" });
    useQueryStore.getState().clear();
    useQueryStore.setState({ history: [], historyError: null, noteScope: null });
    stubAnswer();
    stubAskRole("builtin-local", model);
    vi.mocked(ipc.getSettings).mockResolvedValue({ query_provider: "builtin-local", query_model: model } as MycoSettings);
    vi.spyOn(ipc, "localChatStatus").mockResolvedValue({ model_id: model, state: "ready", bytes: 2_707_513_696 });
    vi.spyOn(ipc, "localSynthesize").mockResolvedValue(synthesized);
    vi.spyOn(ipc, "cancelLocalSynthesis").mockResolvedValue(true);
    vi.spyOn(ipc, "askHistoryAppend").mockResolvedValue(null);
  });

  it("shows and records verified local synthesis while retaining its retrieved sources", async () => {
    await ask("Explain attention");
    expect(ipc.localSynthesize).toHaveBeenCalledOnce();
    expect(ipc.localSynthesize).toHaveBeenCalledWith(expect.objectContaining({ origin: syntheticOrigin,
      roleSnapshot: roleFixture("ask", "builtin-local", model) }));
    expect(last()).toMatchObject({ a: answer, localModel: model, extractive: false, scope: "wiki" });
    expect(last().localFallback).toBeUndefined();
    expect(last().hits?.[0].page).toBe("wiki/attention-mechanism.md");
    expect(vi.mocked(ipc.askHistoryAppend).mock.calls[0][1]).toMatchObject({ a: answer, cited: ["wiki/attention-mechanism"] });
    expect(useQueryStore.getState().stage).toBeNull();
  });

  it("never checks or runs a chat model when the lightweight extractive option is selected", async () => {
    stubAskRole();
    vi.mocked(ipc.getSettings).mockResolvedValue({ query_provider: "builtin-local", query_model: "extractive-retrieval" } as MycoSettings);
    await ask("Explain attention");
    expect(ipc.localChatStatus).not.toHaveBeenCalled();
    expect(ipc.localSynthesize).not.toHaveBeenCalled();
    expect(last().extractive).toBe(true);
    expect(last().localFallback).toBeUndefined();
  });

  it.each(["missing", "error"] as const)("keeps an error outcome when the selected model is %s", async state => {
    vi.mocked(ipc.localChatStatus).mockResolvedValue({ model_id: model, state, bytes: 0 });
    await ask("Explain attention");
    expect(last()).toMatchObject({ a: "", error: copy.answerReviewFailed, activityFailure: "model_unavailable" });
    expect(last().extractive).toBeUndefined();
    expect(last().hits).toBeUndefined();
    expect(last().localModel).toBeUndefined();
    expect(ipc.localSynthesize).not.toHaveBeenCalled();
    expect(last().localFallback).toBeUndefined();
  });

  it("records a static generation failure without replacing it with source quotes", async () => {
    let release!: (reply: LocalSynthesisResult) => void;
    vi.mocked(ipc.localSynthesize).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = ask("Explain attention");
    await vi.waitFor(() => expect(useQueryStore.getState().stage?.kind).toBe("thinking"));
    expect(last().localFallback).toBeUndefined();
    release({ ...synthesized, answer: "", fallback_reason: "generation_failed" });
    await pending;
    expect(last()).toMatchObject({ a: "", error: copy.answerReviewFailed, activityFailure: "generation_failed" });
    expect(last().extractive).toBeUndefined();
    expect(last().hits).toBeUndefined();
    expect(last().localModel).toBeUndefined();
    await ask("Explain attention again");
    expect(last()).toMatchObject({ a: answer, localModel: model });
    expect(last().localFallback).toBeUndefined();
  });

  it("retries the failed local answer with its captured scope, note and period after midnight", async () => {
    vi.mocked(ipc.localSynthesize).mockResolvedValueOnce({ ...synthesized, answer: "", fallback_reason: "time_budget" });
    const question = "어제 attention 설명해줘";
    const note = { path: "/v/wiki/attention-mechanism.md", title: "Synthetic attention" };
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 7, 12));
    try {
      await useQueryStore.getState().ask(question, "ko", askCopy(STRINGS.ko), { scope: "wiki", note });
      const first = last();
      expect(first).toMatchObject({ a: "", error: STRINGS.ko.q_answer_review_failed, activityFailure: "time_budget" });
      expect(first.range).toEqual({ start: "2026-10-06", end: "2026-10-06" });
      vi.setSystemTime(new Date(2026, 9, 8, 12));
      await useQueryStore.getState().retry(0, "ko", askCopy(STRINGS.ko));
      expect(ipc.localSynthesize).toHaveBeenCalledTimes(2);
      expect(vi.mocked(ipc.semanticSearch).mock.calls[1][4]).toEqual(first.range);
      expect(vi.mocked(ipc.localSynthesize).mock.calls[1][0]).toMatchObject({
        question, scope: first.scope, paths: ["wiki/attention-mechanism.md"], range: first.range,
      });
      expect(last()).toMatchObject({ q: question, a: answer, localModel: model, note, range: first.range });
      expect(last().localFallback).toBeUndefined();
      expect(useQueryStore.getState().turns).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps synthesis failure and declined evidence as errors without original quote substitution", async () => {
    vi.mocked(ipc.localSynthesize).mockRejectedValueOnce(new Error("Synthetic inference failure"))
      .mockResolvedValueOnce({ ...synthesized, answer: "", fallback_reason: "insufficient_grounding" });
    await ask("Explain attention");
    expect(last()).toMatchObject({ a: "", error: copy.answerReviewFailed, activityFailure: "synthesis_failed" });
    expect(last().extractive).toBeUndefined();
    expect(last().hits).toBeUndefined();
    await ask("Explain attention again");
    expect(last()).toMatchObject({ a: "", error: copy.answerReviewFailed, activityFailure: "response_rejected" });
    expect(last().extractive).toBeUndefined();
    expect(last().hits).toBeUndefined();
    expect(last().localModel).toBeUndefined();
  });

  it.each([
    ["en", "The source passages changed or could not be verified. Retry to search the current notes."],
    ["ko", "원문이 바뀌었거나 확인할 수 없어 답변을 중단했어요. 다시 시도하여 현재 노트를 검색해 주세요."],
    ["ja", "原文が変わったか確認できなかったため、回答を停止しました。再試行して現在のノートを検索してください。"],
  ] as const)("never publishes rejected source quotes and gives a localized retry message in %s", async (lang, message) => {
    for (const reason of ["source_verification_failed", "source_changed_during_generation"] as const) {
      let release!: (reply: LocalSynthesisResult) => void;
      vi.mocked(ipc.localSynthesize).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
      const pending = useQueryStore.getState().ask("Explain attention", lang, askCopy(STRINGS[lang]));
      await vi.waitFor(() => expect(useQueryStore.getState().stage?.kind).toBe("thinking"));
      expect(last().a).toBe("");
      release({ answer: "", model_id: model, used_sources: [], fallback_reason: reason });
      await expect(pending).resolves.toMatchObject({ a: "", error: message });
      expect(last().hits).toBeUndefined();
      expect(last().localModel).toBeUndefined();
      expect(last().extractive).toBeUndefined();
      expect(last().localFallback).toBeUndefined();
      expect(useQueryStore.getState()).toMatchObject({ busy: false, stage: null });
      const record = vi.mocked(ipc.askHistoryAppend).mock.calls.at(-1)![1];
      expect(record).toMatchObject({ a: "", cited: [], error: message });
      expect(JSON.stringify(record)).not.toContain("attention body");
      expect(JSON.stringify(record)).not.toContain("wiki/attention-mechanism");
    }
    await useQueryStore.getState().retry(useQueryStore.getState().turns.length - 1, lang, askCopy(STRINGS[lang]));
    expect(last()).toMatchObject({ a: answer, localModel: model });
    expect(last().error).toBeUndefined();
  });

  it("ignores a late source-change refusal after Stop and allows a fresh question", async () => {
    let release!: (reply: LocalSynthesisResult) => void;
    vi.mocked(ipc.localSynthesize).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = ask("Explain attention");
    await vi.waitFor(() => expect(ipc.localSynthesize).toHaveBeenCalled());
    useQueryStore.getState().stop();
    await expect(pending).resolves.toMatchObject({ a: "", stopped: true });
    release({ answer: "", model_id: model, used_sources: [], fallback_reason: "source_changed_during_generation" });
    await Promise.resolve();
    expect(last().error).toBeUndefined();
    await ask("Explain attention again");
    expect(last()).toMatchObject({ a: answer, localModel: model });
    expect(last().error).toBeUndefined();
  });

  it("never uses generation to fill an evidence gap", async () => {
    vi.mocked(ipc.semanticSearch).mockResolvedValue({ hits: [], floor: 0.42, below_floor: [] });
    await ask("Explain attention");
    expect(last().abstained).toBe(true);
    expect(ipc.localChatStatus).not.toHaveBeenCalled();
    expect(ipc.localSynthesize).not.toHaveBeenCalled();
  });

  it("threads resolved scope, local date window and note paths to the native evidence verifier", async () => {
    await ask("Explain attention yesterday", { note: { path: "/v/wiki/attention-mechanism.md", title: "Synthetic attention" } });
    expect(ipc.localSynthesize).toHaveBeenCalledWith(expect.objectContaining({ expectedVault: "/v", scope: "all",
      range: expect.objectContaining({ start: expect.any(String), end: expect.any(String) }), paths: ["wiki/attention-mechanism.md"] }));
    expect(last().range).toBeDefined();
    expect(last().note?.path).toBe("/v/wiki/attention-mechanism.md");
  });

  it("preserves a follow-up's original question while supplying its cleaned question-only topic to synthesis", async () => {
    await ask("Explain attention yesterday");
    await ask("그건 왜?");
    const request = vi.mocked(ipc.localSynthesize).mock.calls.at(-1)![0];
    expect(request).toMatchObject({ question: "그건 왜?", previousQuestion: "Explain attention", scope: "wiki" });
    expect(request.range).toBeUndefined();
    expect(JSON.stringify(request)).not.toContain("Synthetic synthesis.");
    expect(vi.mocked(ipc.semanticSearch).mock.calls.at(-1)![0]).toBe("Explain attention 그건 왜?");
    expect(last()).toMatchObject({ q: "그건 왜?", followUp: true, localModel: model });
    expect(vi.mocked(ipc.askHistoryAppend).mock.calls.at(-1)![1].q).toBe("그건 왜?");
    await ask("그래서?");
    expect(vi.mocked(ipc.localSynthesize).mock.calls.at(-1)![0]).toMatchObject({ question: "그래서?", previousQuestion: "Explain attention" });
    await ask("Explain a different synthetic topic");
    expect(vi.mocked(ipc.localSynthesize).mock.calls.at(-1)![0].previousQuestion).toBeUndefined();
  });

  it("routes dated original conversations through activity claims with the selected generator", async () => {
    const temporal = vi.spyOn(ipc, "temporalRecall");
    const origin = { vaultPath: "/v", openingToken: "synthetic-opening" };
    vi.spyOn(ipc, "agentVaultSession").mockResolvedValue(origin);
    const range = { start: "2026-10-01", end: "2026-10-04" };
    const hits = [{ page: "sessions/synthetic.md", stem: "synthetic", section: 0,
      text: "[User @1790985600]\nA synthetic change was requested." }];
    vi.spyOn(ipc, "activityRecall").mockResolvedValue({ hits, indexed_pages: 1, scanned_pages: 1, matched_chunks: 1, incomplete: false });
    vi.mocked(ipc.localSynthesize).mockImplementation(async request => ({ answer: "The user requested a synthetic change; completion is unconfirmed. [[sessions/synthetic|synthetic]]",
      model_id: model, used_sources: ["sessions/synthetic.md"], activity_receipt: syntheticActivityReceipt(range, "all", request.resolution) }));
    await ask("What did I do yesterday", { range });
    expect(ipc.localSynthesize).toHaveBeenCalledWith(expect.objectContaining({ activityOverview: true, origin, range, hits }));
    expect(last()).toMatchObject({ localModel: model, extractive: false, range });
    expect(last().a).toContain("completion is unconfirmed");
    expect(temporal).not.toHaveBeenCalled();
  });

  it("preserves existing graph links without turning them into conceptual claims", async () => {
    useVaultStore.setState({ adjacency: { forward: { "/v/wiki/a.md": ["/v/wiki/b.md"], "/v/wiki/b.md": [] }, backward: {}, unresolved: {}, tags: {} } });
    await ask("Are there any connected ideas?");
    expect(last().a).toContain("[[wiki/a|a]] → [[wiki/b|b]]");
    expect(ipc.localSynthesize).not.toHaveBeenCalled();
  });

  it("reports model thinking only for the held native inference and cancels it on Stop", async () => {
    let release!: (reply: typeof synthesized) => void;
    vi.mocked(ipc.localSynthesize).mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = ask("Explain attention");
    await vi.waitFor(() => expect(ipc.localSynthesize).toHaveBeenCalled());
    expect(useQueryStore.getState().stage).toEqual({ kind: "thinking", stems: [] });
    useQueryStore.getState().stop();
    await expect(pending).resolves.toMatchObject({ stopped: true });
    expect(ipc.cancelLocalSynthesis).toHaveBeenCalledWith(vi.mocked(ipc.localSynthesize).mock.calls[0][0].requestId);
    release(synthesized);
    await Promise.resolve();
    expect(last().localModel).toBeUndefined();
    expect(last().a).toBe("");
    expect(last().localFallback).toBeUndefined();
  });

  it.each(["clear", "opening", "replacement"] as const)("cancels native synthesis and rejects its late answer on %s", async change => {
    let release!: (reply: typeof synthesized) => void;
    vi.mocked(ipc.localSynthesize).mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = ask("Explain attention");
    await vi.waitFor(() => expect(ipc.localSynthesize).toHaveBeenCalled());
    if (change === "clear") useQueryStore.getState().clear();
    else if (change === "opening") useVaultStore.setState({ isOpeningVault: true });
    else useVaultStore.setState({ currentVault: { path: "/other", name: "Synthetic other vault" } });
    expect(ipc.cancelLocalSynthesis).toHaveBeenCalledWith(vi.mocked(ipc.localSynthesize).mock.calls[0][0].requestId);
    release(synthesized);
    await pending;
    expect(useQueryStore.getState()).toMatchObject({ turns: [], busy: false, stage: null });
    expect(ipc.askHistoryAppend).not.toHaveBeenCalled();
  });
});

describe("ordinary generative failure boundary", () => {
  const model = "qwen3.5-4b-q4_k_m";
  const successful = { answer: "Synthetic answer. [[wiki/attention-mechanism|attention-mechanism]]",
    model_id: model, used_sources: ["wiki/attention-mechanism.md"],
    answerReceipt: { answerOriginalSpans: 1, automatedAnswerReviewInputRevision: "d".repeat(64) } };

  beforeEach(() => {
    vi.restoreAllMocks();
    useVaultStore.setState({ currentVault: { path: "/v", name: "Synthetic vault" }, adjacency: null, isOpeningVault: false });
    useUIStore.setState({ askScope: "wiki" });
    useQueryStore.getState().clear();
    useQueryStore.setState({ history: [], historyError: null, noteScope: null });
    stubAnswer();
    stubAskRole("builtin-local", model);
    vi.spyOn(ipc, "localChatStatus").mockResolvedValue({ model_id: model, state: "ready", bytes: 100 });
    vi.spyOn(ipc, "localSynthesize").mockResolvedValue(successful);
    vi.spyOn(ipc, "cancelLocalSynthesis").mockResolvedValue(true);
    vi.spyOn(ipc, "askHistoryAppend").mockResolvedValue(null);
  });

  it.each(["stale index", "status transport", "search transport"] as const)(
    "treats selected generation retrieval boundary %s as localized error history", async failure => {
      for (const lang of ["en", "ko", "ja"] as const) {
        if (failure === "stale index") {
          vi.mocked(ipc.embeddingsStatus).mockResolvedValue({ indexed_pages: 3, model: "builtin-local:retired-model" } as Awaited<ReturnType<typeof ipc.embeddingsStatus>>);
          vi.mocked(ipc.semanticSearch).mockResolvedValue({ hits: [], floor: 0.42, below_floor: [] });
        } else if (failure === "status transport") {
          vi.mocked(ipc.embeddingsStatus).mockRejectedValue(new Error("PRIVATE-SYNTHETIC-RETRIEVAL-DETAIL"));
        } else {
          vi.mocked(ipc.semanticSearch).mockRejectedValue(new Error("PRIVATE-SYNTHETIC-RETRIEVAL-DETAIL"));
        }
        const localized = askCopy(STRINGS[lang]);
        const message = failure === "stale index" ? localized.extractiveStale : localized.extractiveFailed;
        const code = failure === "stale index" ? "index_stale" : "retrieval_failed";
        await useQueryStore.getState().ask("Explain attention", lang, localized);
        expect(last()).toMatchObject({ a: "", error: message, activityFailure: code,
          ...(failure === "stale index" ? { stale: true } : { retrievalFailed: true }) });
        expect(last().abstained).toBeUndefined();
        expect(last().extractive).toBeUndefined();
        expect(last().hits).toBeUndefined();
        expect(ipc.localChatStatus).not.toHaveBeenCalled();
        expect(ipc.localSynthesize).not.toHaveBeenCalled();
        const record = vi.mocked(ipc.askHistoryAppend).mock.calls.at(-1)![1];
        expect(record).toMatchObject({ a: "", cited: [], error: message });
        expect(JSON.stringify(record)).not.toContain("PRIVATE-SYNTHETIC-RETRIEVAL-DETAIL");
      }
    },
  );

  it.each(["stale index", "status transport", "search transport"] as const)(
    "retries selected generation retrieval boundary %s with its captured period and note", async failure => {
      const range = { start: "2026-10-03", end: "2026-10-04" };
      const note = { path: "/v/wiki/attention-mechanism.md", title: "Synthetic attention" };
      if (failure === "stale index") {
        vi.mocked(ipc.embeddingsStatus).mockResolvedValueOnce({ indexed_pages: 3, model: "builtin-local:retired-model" } as Awaited<ReturnType<typeof ipc.embeddingsStatus>>);
        vi.mocked(ipc.semanticSearch).mockResolvedValueOnce({ hits: [], floor: 0.42, below_floor: [] });
      } else if (failure === "status transport") {
        vi.mocked(ipc.embeddingsStatus).mockRejectedValueOnce(new Error("Synthetic index transport failure"));
      } else {
        vi.mocked(ipc.semanticSearch).mockRejectedValueOnce(new Error("Synthetic search transport failure"));
      }
      await ask("Explain attention", { range, note, scope: "wiki" });
      expect(last()).toMatchObject({ a: "", error: expect.any(String), range, note });
      await useQueryStore.getState().retry(0, "en", copy);
      expect(last()).toMatchObject({ a: successful.answer, localModel: model, range, note });
      expect(last().error).toBeUndefined();
      expect(last().stale).toBeUndefined();
      expect(last().retrievalFailed).toBeUndefined();
      expect(vi.mocked(ipc.localSynthesize).mock.calls.at(-1)![0]).toMatchObject({ range, paths: ["wiki/attention-mechanism.md"] });
    },
  );

  it("keeps healthy no-hit selected generation as abstention without pretending retrieval failed", async () => {
    vi.mocked(ipc.semanticSearch).mockResolvedValue({ hits: [], floor: 0.42, below_floor: [] });
    await ask("Explain attention");
    expect(last()).toMatchObject({ abstained: true });
    expect(last().error).toBeUndefined();
    expect(last().stale).toBe(false);
    expect(last().retrievalFailed).toBe(false);
    expect(ipc.localChatStatus).not.toHaveBeenCalled();
    expect(ipc.localSynthesize).not.toHaveBeenCalled();
    expect(vi.mocked(ipc.askHistoryAppend).mock.calls.at(-1)![1]).toMatchObject({ a: "", cited: [], abstained: true });
  });

  it.each(["stale index", "status transport", "search transport"] as const)(
    "keeps explicit extractive retrieval boundary %s in its existing recovery mode", async failure => {
      stubAskRole();
      if (failure === "stale index") {
        vi.mocked(ipc.embeddingsStatus).mockResolvedValue({ indexed_pages: 3, model: "builtin-local:retired-model" } as Awaited<ReturnType<typeof ipc.embeddingsStatus>>);
        vi.mocked(ipc.semanticSearch).mockResolvedValue({ hits: [], floor: 0.42, below_floor: [] });
      } else if (failure === "status transport") {
        vi.mocked(ipc.embeddingsStatus).mockRejectedValue(new Error("Synthetic index transport failure"));
      } else {
        vi.mocked(ipc.semanticSearch).mockRejectedValue(new Error("Synthetic search transport failure"));
      }
      await ask("Explain attention");
      expect(last()).toMatchObject({ extractive: true, extractiveEmpty: true,
        a: failure === "stale index" ? copy.extractiveStale : copy.extractiveFailed });
      expect(last().error).toBeUndefined();
      expect(ipc.localChatStatus).not.toHaveBeenCalled();
      expect(ipc.localSynthesize).not.toHaveBeenCalled();
    },
  );

  it("uses verified lexical evidence when only the dense representation is stale", async () => {
    vi.mocked(ipc.embeddingsStatus).mockResolvedValue({ indexed_pages: 3, model: "builtin-local:retired-model" } as Awaited<ReturnType<typeof ipc.embeddingsStatus>>);
    vi.mocked(ipc.semanticSearch).mockResolvedValue({ hits: [{ page: "wiki/attention-mechanism.md", stem: "attention-mechanism",
      section: 0, text: "Synthetic exact lexical evidence.", score: 0.9, similarity: null, exact_match: true }], floor: 0.42, below_floor: [] });
    await ask("Explain attention");
    expect(last()).toMatchObject({ a: successful.answer, localModel: model, extractive: false });
    expect(last().error).toBeUndefined();
    expect(ipc.localSynthesize).toHaveBeenCalledOnce();
  });

  it.each(["generation_failed", "model_unavailable"])(
    "preserves known native stage failure %s in an ordinary error history", async code => {
      vi.mocked(ipc.localSynthesize).mockResolvedValue({ ...successful, answer: "", fallback_reason: code,
        activity_failure: { code, detail: "PRIVATE-SYNTHETIC-STAGE-DETAIL" } });
      await ask("Explain attention");
      expect(last()).toMatchObject({ a: "", error: copy.answerReviewFailed, activityFailure: code });
      const record = vi.mocked(ipc.askHistoryAppend).mock.calls.at(-1)![1];
      expect(record).toMatchObject({ a: "", cited: [], error: copy.answerReviewFailed });
      expect(JSON.stringify(record)).not.toContain("PRIVATE-SYNTHETIC-STAGE-DETAIL");
    },
  );

  it.each(["missing model", "failed model", "status transport", "synthesis transport", "prompt_unavailable",
    "generation_failed", "answer_rejected", "answer_incomplete", "time_budget", "missing reply", "empty answer",
    "non-text answer", "non-array sources", "wrong model", "outside citation", "missing review transport"])(
    "keeps selected generator %s as an empty error turn and error history", async failure => {
      if (failure === "missing model" || failure === "failed model") {
        vi.mocked(ipc.localChatStatus).mockResolvedValue({ model_id: model,
          state: failure === "missing model" ? "missing" : "error", bytes: 0 });
      } else if (failure === "status transport") {
        vi.mocked(ipc.localChatStatus).mockRejectedValue(new Error("PRIVATE-SYNTHETIC-GENERATION-DETAIL"));
      } else if (failure === "synthesis transport") {
        vi.mocked(ipc.localSynthesize).mockRejectedValue(new Error("PRIVATE-SYNTHETIC-GENERATION-DETAIL"));
      } else {
        const reply: unknown = failure === "missing reply" ? null :
          failure === "missing review transport" ? { ...successful, answerReceipt: undefined } :
          failure === "empty answer" ? { ...successful, answer: "" } :
            failure === "non-text answer" ? { ...successful, answer: 7 } :
              failure === "non-array sources" ? { ...successful, used_sources: "wiki/attention-mechanism.md" } :
                failure === "wrong model" ? { ...successful, model_id: "unexpected-model" } :
                  failure === "outside citation" ? { ...successful, answer: "Outside. [[wiki/outside]]",
                    used_sources: ["wiki/outside.md"] } :
                    { ...successful, answer: "", fallback_reason: failure };
        vi.mocked(ipc.localSynthesize).mockResolvedValue(reply as LocalSynthesisResult);
      }
      await ask("Explain attention");
      expect(last()).toMatchObject({ a: "", error: copy.answerReviewFailed });
      expect(last().activityFailure).toBe(
        failure === "missing model" || failure === "failed model" ? "model_unavailable" :
          failure === "status transport" ? "status_failed" :
            failure === "synthesis transport" ? "synthesis_failed" :
              ["prompt_unavailable", "generation_failed", "answer_rejected", "answer_incomplete", "time_budget"].includes(failure)
                ? failure : "response_rejected",
      );
      expect(last().hits).toBeUndefined();
      expect(last().extractive).toBeUndefined();
      expect(last().localModel).toBeUndefined();
      expect(useQueryStore.getState()).toMatchObject({ busy: false, stage: null });
      const record = vi.mocked(ipc.askHistoryAppend).mock.calls.at(-1)![1];
      expect(record).toMatchObject({ a: "", cited: [], error: copy.answerReviewFailed });
      expect(JSON.stringify(record)).not.toContain("attention body");
      expect(JSON.stringify(record)).not.toContain("PRIVATE-SYNTHETIC-GENERATION-DETAIL");
      expect(vi.mocked(ipc.askHistoryAppend).mock.calls.map(([, entry]) => entry)
        .filter(entry => entry.a.trim() && !entry.error && !entry.stopped)).toEqual([]);
    },
  );

  it("rejects an unsupported selected local generator before readiness or quote success", async () => {
    stubAskRole("builtin-local", "unsupported-selected-local-model");
    await ask("Explain attention");
    expect(last()).toMatchObject({ a: "", error: copy.answerReviewFailed, activityFailure: "model_unavailable" });
    expect(last().extractive).toBeUndefined();
    expect(last().hits).toBeUndefined();
    expect(ipc.localChatStatus).not.toHaveBeenCalled();
    expect(ipc.localSynthesize).not.toHaveBeenCalled();
    expect(vi.mocked(ipc.askHistoryAppend).mock.calls.at(-1)![1]).toMatchObject({ a: "", cited: [], error: copy.answerReviewFailed });
  });

  it.each(["source_verification_failed", "source_changed_during_generation", "review_rejected"])(
    "retains existing %s rejection rather than replacing it with generic generation failure", async reason => {
      vi.mocked(ipc.localSynthesize).mockResolvedValue({ ...successful, answer: "", used_sources: [], fallback_reason: reason });
      await ask("Explain attention");
      const message = reason === "review_rejected" ? copy.answerReviewFailed : copy.sourceChanged;
      expect(last()).toMatchObject({ a: "", error: message });
      expect(last().hits).toBeUndefined();
      expect(vi.mocked(ipc.askHistoryAppend).mock.calls.at(-1)![1]).toMatchObject({ a: "", cited: [], error: message });
    },
  );

  it("keeps explicit extractive selection as quote mode with no generation", async () => {
    stubAskRole();
    await ask("Explain attention");
    expect(last()).toMatchObject({ extractive: true });
    expect(last().a).toContain("attention body");
    expect(last().error).toBeUndefined();
    expect(ipc.localChatStatus).not.toHaveBeenCalled();
    expect(ipc.localSynthesize).not.toHaveBeenCalled();
    expect(vi.mocked(ipc.askHistoryAppend).mock.calls.at(-1)![1]).toMatchObject({
      a: expect.stringContaining("attention body"), cited: ["attention-mechanism"],
    });
  });
});

describe("queryStore.harvest (the recall-miss log)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useVaultStore.setState({ currentVault: { path: "/v", name: "v" } });
    useQueryStore.setState({ turns: [{ q: "attention", a: "> quote" }] });
  });

  it("marks the turn once the miss is logged — the button's receipt", async () => {
    const record = vi.spyOn(ipc, "recordRecallMiss").mockResolvedValue(undefined as never);
    await useQueryStore.getState().harvest(0);
    expect(record).toHaveBeenCalledWith("/v", "attention");
    expect(useQueryStore.getState().turns[0].harvested).toBe(true);
    // Logged once: a second press writes nothing.
    await useQueryStore.getState().harvest(0);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("rejects on a failed write so the page can say so, and stays retryable", async () => {
    vi.spyOn(ipc, "recordRecallMiss").mockRejectedValue(new Error("disk full"));
    await expect(useQueryStore.getState().harvest(0)).rejects.toThrow("disk full");
    expect(useQueryStore.getState().turns[0].harvested).toBeUndefined();
  });
});

// The abstain card's "write it down" (UX S30): the turn reads as written
// from the press on, so a second press, or a return to the page after Open,
// never writes the question twice.
describe("queryStore.note (write the question down)", () => {
  beforeEach(() => {
    useQueryStore.setState({ turns: [{ q: "주말 등산 코스 추천", a: "", abstained: true }] });
  });

  const WRITTEN = { rel: "daily/2026-10-02.md", line: "- 09:05 질문: 주말 등산 코스 추천" };

  it("hands the writer the question and marks the turn at once", async () => {
    let done: (c: Captured | null) => void = () => undefined;
    const write = vi.fn(() => new Promise<Captured | null>((r) => (done = r)));
    const first = useQueryStore.getState().note(0, write);
    expect(useQueryStore.getState().turns[0].noted).toBe(true);
    await useQueryStore.getState().note(0, write);
    done(WRITTEN);
    await first;
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("주말 등산 코스 추천");
    expect(useQueryStore.getState().turns[0].noted).toBe(true);
  });

  it("keeps where the question went, for the card's Open", async () => {
    expect(useQueryStore.getState().turns[0].notedIn).toBeUndefined();
    await useQueryStore.getState().note(0, () => Promise.resolve(WRITTEN));
    expect(useQueryStore.getState().turns[0].notedIn).toEqual(WRITTEN);
  });

  it("is live again when the write failed", async () => {
    await useQueryStore.getState().note(0, () => Promise.resolve(null));
    expect(useQueryStore.getState().turns[0].noted).toBe(false);
    expect(useQueryStore.getState().turns[0].notedIn).toBeUndefined();
  });
});

describe("queryStore.ask model-selected recent activity", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useVaultStore.setState({ currentVault: { path: "/v", name: "v" } });
    useUIStore.setState({ askScope: "wiki", isAskScopeExplicit: true });
    useQueryStore.getState().clear();
  });

  function ready() {
    stubAnswer();
    const model = "qwen3.5-4b-q4_k_m";
    stubAskRole("builtin-local", model);
    vi.mocked(ipc.getSettings).mockResolvedValue({ query_provider: "builtin-local", query_model: model } as MycoSettings);
    vi.spyOn(ipc, "localChatStatus").mockResolvedValue({ model_id: model, state: "ready", bytes: 100 });
    vi.spyOn(ipc, "askHistoryAppend").mockResolvedValue(null);
    vi.spyOn(ipc, "agentVaultSession").mockResolvedValue({ vaultPath: "/v", openingToken: "synthetic-opening" });
    return model;
  }

  // Focused Ask P2 regressions use synthetic IPC, not native/model-quality proof.
  it("keeps incomplete empty activity retryable without logging a successful answer", async () => {
    const model = ready();
    const range = { start: "2026-09-26", end: "2026-10-04" };
    const plan = vi.spyOn(ipc, "localQueryPlan").mockResolvedValue({ ...range, model_id: model });
    const recall = vi.spyOn(ipc, "activityRecall")
      .mockResolvedValueOnce({ hits: [], indexed_pages: 6, scanned_pages: 2, matched_chunks: 0, incomplete: true })
      .mockResolvedValue({ hits: [], indexed_pages: 6, scanned_pages: 6, matched_chunks: 0, incomplete: false });
    const synthesis = vi.spyOn(ipc, "localSynthesize");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 7, 12));
    try {
      await useQueryStore.getState().ask("내가 최근에 한 일들에 대해서 정리해줘", "ko", askCopy(STRINGS.ko));
      expect(last()).toMatchObject({ a: "", range, scope: "wiki", error: expect.any(String),
        activityCoverage: { scannedPages: 2, sources: 0, incomplete: true } });
      expect(last().error?.trim()).toBeTruthy();
      expect(last().activityReceipt).toBeUndefined();
      expect(last().localModel).toBeUndefined();
      const records = vi.mocked(ipc.askHistoryAppend).mock.calls.map(([, record]) => record);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ a: "", cited: [], error: last().error });
      expect(records.filter(record => record.a.trim() && !record.error && !record.stopped && !record.abstained)).toEqual([]);
      expect(synthesis).not.toHaveBeenCalled();

      await useQueryStore.getState().retry(0, "ko", askCopy(STRINGS.ko));
      expect(plan).toHaveBeenCalledOnce();
      expect(recall).toHaveBeenCalledTimes(2);
      expect(recall.mock.calls.map(([request]) => ({ range: request.range, scope: request.scope })))
        .toEqual([{ range, scope: "wiki" }, { range, scope: "wiki" }]);
      // Complete empty evidence remains the existing honest empty-result case.
      expect(last()).toMatchObject({ a: STRINGS.ko.q_range_empty, range,
        activityCoverage: { scannedPages: 6, sources: 0, incomplete: false } });
      expect(last().error).toBeUndefined();
      expect(synthesis).not.toHaveBeenCalled();
      expect(ipc.semanticSearch).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("exposes the planned activity period before a failed read and reuses it on retry", async () => {
    const model = ready();
    const range = { start: "2026-09-26", end: "2026-10-04" };
    const plan = vi.spyOn(ipc, "localQueryPlan").mockResolvedValue({ ...range, model_id: model });
    let rejectRead!: (error: Error) => void;
    const recall = vi.spyOn(ipc, "activityRecall")
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectRead = reject; }))
      .mockResolvedValue({ hits: [], indexed_pages: 6, scanned_pages: 6, matched_chunks: 0, incomplete: false });
    const synthesis = vi.spyOn(ipc, "localSynthesize");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 7, 12));
    const pending = useQueryStore.getState().ask("내가 앞으로 어떤 작업을 하는게 좋을까?", "ko", askCopy(STRINGS.ko));
    try {
      await vi.waitFor(() => expect(recall).toHaveBeenCalledOnce());
      expect(useQueryStore.getState()).toMatchObject({ busy: true, stage: { kind: "retrieving" } });
      expect(last()).toMatchObject({ a: "", range, scope: "wiki" });
      rejectRead(new Error("PRIVATE-SYNTHETIC-READ-FAILURE"));
      await pending;
      expect(last()).toMatchObject({ a: "", range, error: expect.any(String) });
      expect(last().error?.trim()).toBeTruthy();
      expect(last().error).not.toContain("PRIVATE-SYNTHETIC-READ-FAILURE");
      expect(useQueryStore.getState().busy).toBe(false);
      expect(ipc.askHistoryAppend).toHaveBeenCalledWith("/v", expect.objectContaining({ a: "", error: last().error }));

      await useQueryStore.getState().retry(0, "ko", askCopy(STRINGS.ko));
      expect(plan).toHaveBeenCalledOnce();
      expect(recall).toHaveBeenCalledTimes(2);
      expect(recall.mock.calls.map(([request]) => ({ range: request.range, scope: request.scope })))
        .toEqual([{ range, scope: "wiki" }, { range, scope: "wiki" }]);
      expect(last()).toMatchObject({ a: STRINGS.ko.q_range_empty, range });
      expect(last().error).toBeUndefined();
      expect(synthesis).not.toHaveBeenCalled();
      expect(ipc.semanticSearch).not.toHaveBeenCalled();
    } finally {
      useQueryStore.getState().stop();
      await pending;
      vi.useRealTimers();
    }
  });

  it("generates dated activity with the same captured scope and opening instead of a quote-only route", async () => {
    const model = ready();
    const temporal = vi.spyOn(ipc, "temporalRecall");
    const origin = { vaultPath: "/v", openingToken: "synthetic-opening" };
    vi.spyOn(ipc, "agentVaultSession").mockResolvedValue(origin);
    const hits = [{ page: "daily/2026-10-04.md", stem: "2026-10-04", section: 0, text: "A synthetic revision was reported complete." }];
    const recall = vi.spyOn(ipc, "activityRecall").mockResolvedValue({ hits, indexed_pages: 1, scanned_pages: 1, matched_chunks: 1, incomplete: false });
    const plan = vi.spyOn(ipc, "localQueryPlan");
    const range = { start: "2026-10-01", end: "2026-10-04" };
    const synthesis = vi.spyOn(ipc, "localSynthesize").mockImplementation(async request => ({ answer: "A synthetic revision was reported complete. [[daily/2026-10-04|2026-10-04]]",
      model_id: model, used_sources: ["daily/2026-10-04.md"], activity_receipt: syntheticActivityReceipt(range, "sessions", request.resolution) }));
    await useQueryStore.getState().ask("What did I do last week?", "en", copy, { range, scope: "sessions" });
    expect(recall).toHaveBeenCalledWith({ expectedVault: "/v", origin,
      roleSnapshot: roleFixture("ask", "builtin-local", model, origin), range, scope: "sessions" });
    expect(synthesis).toHaveBeenCalledWith(expect.objectContaining({ origin, activityOverview: true, range, scope: "sessions" }));
    expect(plan).not.toHaveBeenCalled();
    expect(temporal).not.toHaveBeenCalled();
    expect(ipc.semanticSearch).not.toHaveBeenCalled();
    expect(last()).toMatchObject({ localModel: model, extractive: false,
      activityReceipt: syntheticActivityReceipt(range, "sessions", synthesis.mock.calls[0][0].resolution) });
    expect(synthesis.mock.calls[0][0].resolution).toMatchObject({ mode: "historical_as_of", asOfEpoch: queryDateRange(range).endEpoch - 1 });
  });

  it.each(["내가 최근에 한 일들에 대해서 정리해줘", "내가 앞으로 어떤 작업을 하는게 좋을까?"])(
    "retrieves dated work for %s instead of similarity to generic work words", async question => {
    const model = ready();
    const range = { start: "2026-09-26", end: "2026-10-04" };
    const plan = vi.spyOn(ipc, "localQueryPlan").mockResolvedValue({ ...range, model_id: model });
    const hits = [{ page: "daily/2026-10-04.md", stem: "2026-10-04", section: 0,
      text: "The synthetic parser was fixed. A synthetic export change was requested, but no outcome was recorded." }];
    const recall = vi.spyOn(ipc, "activityRecall").mockResolvedValue({ hits,
      indexed_pages: 20, scanned_pages: 4, matched_chunks: 3, incomplete: true });
    const synthesize = vi.spyOn(ipc, "localSynthesize").mockImplementation(async (request) => request.activityOverview ? {
      answer: "합성 파서 수정이 보고됐고, 내보내기 변경은 요청됐지만 결과는 기록되지 않았습니다.\n\n[[daily/2026-10-04|2026-10-04]]",
      model_id: model, used_sources: ["daily/2026-10-04.md"], selected_chunks: 1,
      activity_receipt: syntheticActivityReceipt(range, "wiki", request.resolution),
    } : {
      answer: "The synthetic site has 113 entries.\n\n[[wiki/attention-mechanism|attention-mechanism]]",
      model_id: model, used_sources: ["wiki/attention-mechanism.md"], selected_chunks: 1,
      answerReceipt: { answerOriginalSpans: 1, automatedAnswerReviewInputRevision: "d".repeat(64) },
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 7, 12));
    try {
      await useQueryStore.getState().ask(question, "ko", askCopy(STRINGS.ko), { scope: "wiki" });
      expect(plan).toHaveBeenCalledOnce();
      expect(plan).toHaveBeenCalledWith(expect.objectContaining({ question, today: "2026-10-07", scope: "wiki", expectedVault: "/v" }));
      expect(recall).toHaveBeenCalledWith({ expectedVault: "/v", origin: syntheticOrigin,
        roleSnapshot: roleFixture("ask", "builtin-local", model), range, scope: "wiki" });
      expect(ipc.semanticSearch).not.toHaveBeenCalled();
      expect(synthesize).toHaveBeenCalledWith(expect.objectContaining({ activityOverview: true, range, scope: "wiki", hits }));
      const request = synthesize.mock.calls[0][0];
      const capturedQueryEpoch = Math.floor(new Date(2026, 9, 7, 12).getTime() / 1000);
      expect(request.resolution).toEqual({
        mode: question.includes("앞으로") ? "current_state" : "historical_as_of",
        asOfEpoch: question.includes("앞으로") ? capturedQueryEpoch : queryDateRange(range).endEpoch - 1,
        capturedQueryEpoch,
      });
      expect(last().range).toEqual(range);
      expect(last().localModel).toBe(model);
      expect(last().a).toContain("결과는 기록되지 않았습니다");
      expect(last().a).not.toContain("113");
      expect(last().trace).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });

  it("does not replace a failed model period with generic similarity retrieval", async () => {
    ready();
    vi.spyOn(ipc, "localQueryPlan").mockRejectedValue(new Error("SYNTHETIC_PRIVATE_PAYLOAD"));
    const recall = vi.spyOn(ipc, "activityRecall");
    const synthesize = vi.spyOn(ipc, "localSynthesize");
    await useQueryStore.getState().ask("내가 최근에 한 일들에 대해서 정리해줘", "ko", askCopy(STRINGS.ko));
    expect(last().error).toBe(STRINGS.ko.q_activity_failed);
    expect(last().error).not.toContain("SYNTHETIC_PRIVATE_PAYLOAD");
    expect(last().localFallback).toBeUndefined();
    expect(ipc.semanticSearch).not.toHaveBeenCalled();
    expect(recall).not.toHaveBeenCalled();
    expect(synthesize).not.toHaveBeenCalled();
  });

  it.each(["en", "ko", "ja"] as const)("keeps insufficient claims distinct from a successful activity summary in %s", async lang => {
    const model = ready();
    const range = { start: "2026-09-26", end: "2026-10-04" };
    vi.spyOn(ipc, "localQueryPlan").mockResolvedValue({ ...range, model_id: model });
    vi.spyOn(ipc, "activityRecall").mockResolvedValue({ hits: [{ page: "wiki/synthetic.md", stem: "Synthetic", section: 0,
      text: "Synthetic coordination notes, not supported personal work." }], indexed_pages: 1, scanned_pages: 1, matched_chunks: 1, incomplete: false });
    vi.spyOn(ipc, "localSynthesize").mockResolvedValue({ answer: "", model_id: model, used_sources: [], fallback_reason: "activity_insufficient_evidence",
      activity_failure: { code: "activity_insufficient_evidence", detail: "PRIVATE-SYNTHETIC-PAYLOAD" } });
    await useQueryStore.getState().ask("What should I work on next?", lang, askCopy(STRINGS[lang]));
    expect(last()).toMatchObject({ a: "", range, activityFailure: "activity_insufficient_evidence", error: STRINGS[lang].q_activity_insufficient_evidence });
    expect(last().extractive).toBeUndefined();
    expect(last().activityReceipt).toBeUndefined();
    expect(JSON.stringify(last())).not.toContain("PRIVATE-SYNTHETIC-PAYLOAD");
    expect(ipc.semanticSearch).not.toHaveBeenCalled();
  });

  it.each(["en", "ko", "ja"] as const)("keeps a failed answer review retryable without saving its rejected draft in %s", async lang => {
    const model = ready();
    const range = { start: "2026-09-26", end: "2026-10-04" };
    vi.spyOn(ipc, "localQueryPlan").mockResolvedValue({ ...range, model_id: model });
    vi.spyOn(ipc, "activityRecall").mockResolvedValue({ hits: [{ page: "wiki/synthetic.md", stem: "Synthetic", section: 0,
      text: "Synthetic source records." }], indexed_pages: 1, scanned_pages: 1, matched_chunks: 1, incomplete: false });
    vi.spyOn(ipc, "localSynthesize").mockResolvedValue({ answer: "Rejected synthetic draft", model_id: model,
      used_sources: ["wiki/synthetic.md"], fallback_reason: "review_rejected",
      activity_failure: { code: "review_rejected", detail: "PRIVATE-SYNTHETIC-REVIEW-DETAIL" } });
    await useQueryStore.getState().ask("What should I work on next?", lang, askCopy(STRINGS[lang]));
    expect(last()).toMatchObject({ a: "", range, activityFailure: "review_rejected", error: STRINGS[lang].q_answer_review_failed });
    expect(last().extractive).toBeUndefined();
    expect(last().activityReceipt).toBeUndefined();
    expect(last().localFallback).toBeUndefined();
    expect(JSON.stringify(last())).not.toContain("PRIVATE-SYNTHETIC-REVIEW-DETAIL");
    expect(ipc.askHistoryAppend).toHaveBeenCalledWith("/v", expect.objectContaining({
      a: "", cited: [], error: STRINGS[lang].q_answer_review_failed,
    }));
  });

  it("does not start an activity model from a late native origin after same-path reopening", async () => {
    ready();
    let release!: (origin: Awaited<ReturnType<typeof ipc.agentVaultSession>>) => void;
    vi.mocked(ipc.agentVaultSession).mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = useQueryStore.getState().ask("What should I work on next?", "en", copy);
    await vi.waitFor(() => expect(ipc.agentVaultSession).toHaveBeenCalledOnce());
    useVaultStore.setState({ vaultToken: "synthetic-replaced-opening" });
    release({ vaultPath: "/v", openingToken: "synthetic-opening" });
    await pending;
    expect(useQueryStore.getState().turns).toEqual([]);
    expect(ipc.localChatStatus).not.toHaveBeenCalled();
    expect(ipc.askHistoryAppend).not.toHaveBeenCalled();
  });

  it.each(["answer_incomplete", "prompt_unavailable", "answer_rejected"] as const)(
    "preserves %s after selecting the activity period without claiming the model was unready", async reason => {
      const model = ready();
      const range = { start: "2026-09-26", end: "2026-10-04" };
      vi.spyOn(ipc, "localQueryPlan").mockResolvedValue({ ...range, model_id: model });
      const hits = [{ page: "wiki/synthetic.md", stem: "Synthetic", section: 0, text: "Reported fixing a synthetic reader." }];
      vi.spyOn(ipc, "activityRecall").mockResolvedValue({ hits, indexed_pages: 20, scanned_pages: 4, matched_chunks: 1, incomplete: false });
      vi.spyOn(ipc, "localSynthesize").mockResolvedValue({ answer: "", model_id: model, used_sources: [], fallback_reason: reason });
      await useQueryStore.getState().ask("내가 최근에 한 일들에 대해서 정리해줘", "ko", askCopy(STRINGS.ko));
      expect(last()).toMatchObject({ a: "", range, localFallback: reason, error: STRINGS.ko.q_activity_summary_failed });
      expect(last().extractive).toBeUndefined();
      expect(ipc.semanticSearch).not.toHaveBeenCalled();
    },
  );

  it.each(["source_verification_failed", "source_changed_during_generation"] as const)(
    "keeps the source-change recovery copy for activity reason %s", async reason => {
      const model = ready();
      const range = { start: "2026-09-26", end: "2026-10-04" };
      vi.spyOn(ipc, "localQueryPlan").mockResolvedValue({ ...range, model_id: model });
      const hits = [{ page: "wiki/synthetic.md", stem: "Synthetic", section: 0, text: "Reported fixing a synthetic reader." }];
      vi.spyOn(ipc, "activityRecall").mockResolvedValue({ hits, indexed_pages: 20, scanned_pages: 4, matched_chunks: 1, incomplete: false });
      vi.spyOn(ipc, "localSynthesize").mockResolvedValue({ answer: "", model_id: model, used_sources: [], fallback_reason: reason });
      await useQueryStore.getState().ask("내가 최근에 한 일들에 대해서 정리해줘", "ko", askCopy(STRINGS.ko));
      expect(last()).toMatchObject({ a: "", range, error: STRINGS.ko.q_source_changed });
      expect(last().localFallback).toBeUndefined();
    },
  );

  it("retries a failed activity summary with the selected period and activity task", async () => {
    const model = ready();
    const range = { start: "2026-09-26", end: "2026-10-04" };
    const plan = vi.spyOn(ipc, "localQueryPlan").mockResolvedValue({ ...range, model_id: model });
    const hits = [{ page: "wiki/synthetic.md", stem: "Synthetic", section: 0, text: "Reported fixing a synthetic reader." }];
    vi.spyOn(ipc, "activityRecall").mockResolvedValue({ hits, indexed_pages: 20, scanned_pages: 4, matched_chunks: 1, incomplete: true });
    const synthesis = vi.spyOn(ipc, "localSynthesize").mockResolvedValueOnce({ answer: "", model_id: model, used_sources: [], fallback_reason: "answer_rejected" })
      .mockImplementation(async request => ({ answer: "합성 리더 수정이 보고됐습니다. [[wiki/synthetic|Synthetic]]", model_id: model, used_sources: ["wiki/synthetic.md"],
        activity_receipt: syntheticActivityReceipt(range, "wiki", request.resolution) }));
    await useQueryStore.getState().ask("내가 최근에 한 일들에 대해서 정리해줘", "ko", askCopy(STRINGS.ko));
    expect(last()).toMatchObject({ a: "", error: STRINGS.ko.q_activity_summary_failed, range, localFallback: "answer_rejected" });
    await useQueryStore.getState().retry(0, "ko", askCopy(STRINGS.ko));
    expect(plan).toHaveBeenCalledOnce();
    expect(synthesis).toHaveBeenCalledTimes(2);
    expect(synthesis).toHaveBeenLastCalledWith(expect.objectContaining({ range, activityOverview: true, scope: "wiki", hits }));
    expect(last().error).toBeUndefined();
    expect(last().localFallback).toBeUndefined();
    expect(last().a).toContain("합성 리더");
    expect(ipc.semanticSearch).not.toHaveBeenCalled();
  });

  it("stops the activity summary without surfacing a late fallback as an error", async () => {
    const model = ready();
    const range = { start: "2026-09-26", end: "2026-10-04" };
    vi.spyOn(ipc, "localQueryPlan").mockResolvedValue({ ...range, model_id: model });
    const hits = [{ page: "wiki/synthetic.md", stem: "Synthetic", section: 0, text: "Reported fixing a synthetic reader." }];
    vi.spyOn(ipc, "activityRecall").mockResolvedValue({ hits, indexed_pages: 20, scanned_pages: 4, matched_chunks: 1, incomplete: false });
    let release!: (reply: LocalSynthesisResult) => void;
    const synthesis = vi.spyOn(ipc, "localSynthesize").mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const activity = useQueryStore.getState().ask("내가 최근에 한 일들에 대해서 정리해줘", "ko", askCopy(STRINGS.ko));
    await vi.waitFor(() => expect(synthesis).toHaveBeenCalledOnce());
    useQueryStore.getState().stop();
    await activity;
    release({ answer: "", model_id: model, used_sources: [], fallback_reason: "answer_incomplete" });
    await Promise.resolve();
    expect(last()).toMatchObject({ a: "", range, stopped: true });
    expect(last().error).toBeUndefined();
    expect(last().localFallback).toBeUndefined();
  });

  it("stops the period planner immediately and ignores its late reply", async () => {
    const model = ready();
    let release!: (plan: Awaited<ReturnType<typeof ipc.localQueryPlan>>) => void;
    const plan = vi.spyOn(ipc, "localQueryPlan").mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const cancel = vi.spyOn(ipc, "cancelLocalSynthesis").mockResolvedValue(true);
    const recall = vi.spyOn(ipc, "activityRecall");
    const activity = useQueryStore.getState().ask("내가 최근에 한 일들에 대해서 정리해줘", "ko", askCopy(STRINGS.ko));
    await vi.waitFor(() => expect(plan).toHaveBeenCalledOnce());
    useQueryStore.getState().stop();
    await activity;
    expect(last()).toMatchObject({ stopped: true, a: "" });
    expect(useQueryStore.getState().busy).toBe(false);
    expect(cancel).toHaveBeenCalledWith(vi.mocked(ipc.localQueryPlan).mock.calls[0][0].requestId);
    release({ start: "2026-09-26", end: "2026-10-04", model_id: model });
    await Promise.resolve();
    expect(recall).not.toHaveBeenCalled();
    expect(last()).toMatchObject({ stopped: true, a: "" });
  });
});

describe("queryStore.ask period", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useVaultStore.setState({ currentVault: { path: "/v", name: "v" } });
    useUIStore.setState({ askScope: "wiki" });
    useQueryStore.getState().clear();
  });

  it("answers the reported recent-week wording with a status overview of synthetic dated records", async () => {
    const search = stubExtractive();
    const recall = vi.mocked(ipc.temporalRecall);
    recall.mockResolvedValue({ events: [
      { page: "sessions/synthetic-request.md", stem: "Synthetic request", section: 0, role: "User",
        text: "**User:**\n\n합성 배포 문제를 수정하고 배포해줘.", timestamp: new Date(2026, 9, 3, 9).getTime() / 1000 },
      { page: "sessions/synthetic-pending.md", stem: "Synthetic pending", section: 0, role: "Assistant",
        text: "**Assistant:**\n\nNeed your decision\n\n배포 방식 선택이 필요합니다.", timestamp: new Date(2026, 9, 3, 10).getTime() / 1000 },
      { page: "sessions/synthetic-running.md", stem: "Synthetic running", section: 0, role: "Assistant",
        text: "**Assistant:**\n\nRunning now\n\n합성 배포 문제를 조사하고 있습니다.", timestamp: new Date(2026, 9, 4, 9).getTime() / 1000 },
      { page: "sessions/synthetic-done.md", stem: "Synthetic done", section: 0, role: "Assistant",
        text: "**Assistant:**\n\n합성 파서 오류를 수정했습니다. 회귀 테스트 12개를 실행했습니다.", timestamp: new Date(2026, 9, 5, 9).getTime() / 1000 },
    ], indexed_pages: 4, scanned_pages: 4, matched_events: 4, incomplete: false });
    const synthesize = vi.spyOn(ipc, "localSynthesize");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 6, 12));
    try {
      await useQueryStore.getState().ask("최근 일주일동안 한일", "ko", askCopy(STRINGS.ko), { scope: "sessions" });
      expect(recall).toHaveBeenCalledWith({ start: "2026-09-30", end: "2026-10-06" }, "sessions", undefined);
      expect(last().a).toContain("### 수행·결과 보고");
      expect(last().a).toContain("### 진행·계획");
      expect(last().a).toContain("### 요청·결정 대기·완료 미확인");
      const performed = last().a.split("### 수행·결과 보고")[1].split("### 진행·계획")[0];
      expect(performed).toContain("합성 파서 오류를 수정했습니다");
      expect(performed).not.toContain("배포");
      expect(last().a).toContain("[[sessions/synthetic-done|Synthetic done]]");
      expect(last().range).toEqual({ start: "2026-09-30", end: "2026-10-06" });
      expect(search).not.toHaveBeenCalled();
      expect(synthesize).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["내가 어제 한 일들에 대해서 알려줘", "어제 내가 한 일을 알려줘"])("browses dated records for the Korean activity overview %s", async (question) => {
    const search = stubExtractive();
    const recall = vi.mocked(ipc.temporalRecall);
    recall.mockResolvedValue({ events: [{ page: "sessions/2025-01/synthetic-resumed.md", stem: "Synthetic resumed session", section: 3,
      text: "**Assistant:**\n\n합성 회귀 테스트 12개를 실행했습니다.", role: "Assistant", timestamp: new Date(2026, 9, 4, 9).getTime() / 1000 }],
      indexed_pages: 5, scanned_pages: 3, matched_events: 1, incomplete: true });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 5, 12));
    try {
      await useQueryStore.getState().ask(question, "ko", askCopy(STRINGS.ko), { scope: "sessions" });
      expect(recall).toHaveBeenCalledWith({ start: "2026-10-04", end: "2026-10-04" }, "sessions", undefined);
      expect(last().a).toContain("합성 회귀 테스트 12개를 실행했습니다.");
      expect(last().a).toContain("Assistant");
      expect(last().range).toEqual({ start: "2026-10-04", end: "2026-10-04" });
      expect(search).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends a complete empty dated overview without replacing it with a similar user request", async () => {
    stubAnswer();
    stubAskRole("builtin-local", "qwen3.5-4b-q4_k_m");
    vi.mocked(ipc.getSettings).mockResolvedValue({ query_provider: "builtin-local", query_model: "qwen3.5-4b-q4_k_m" } as MycoSettings);
    vi.mocked(ipc.semanticSearch).mockResolvedValue({ hits: [{ page: "sessions/synthetic-request.md", stem: "Synthetic request", section: 0,
      text: "**User:**\n\n내가 확인하면 되는 거 알려줘", score: 0.8, similarity: 0.43 }], floor: 0.42, below_floor: [] });
    vi.spyOn(ipc, "agentVaultSession").mockResolvedValue({ vaultPath: "/v", openingToken: "synthetic-opening" });
    const temporal = vi.spyOn(ipc, "temporalRecall");
    const recall = vi.spyOn(ipc, "activityRecall").mockResolvedValue({ hits: [], indexed_pages: 6, scanned_pages: 6, matched_chunks: 0, incomplete: false });
    const mtimes = vi.spyOn(ipc, "fileMtimes");
    const status = vi.spyOn(ipc, "localChatStatus").mockResolvedValue({ model_id: "qwen3.5-4b-q4_k_m", state: "ready", bytes: 100 });
    const synthesize = vi.spyOn(ipc, "localSynthesize");
    await ask("what did I do yesterday", { scope: "sessions" });
    expect(recall).toHaveBeenCalledOnce();
    expect(last().a).toBe(copy.rangeEmpty);
    expect(last()).toMatchObject({ activityCoverage: { scannedPages: 6, sources: 0, incomplete: false }, activityFailure: "activity_insufficient_evidence" });
    expect(last().a).not.toContain("내가 확인하면");
    expect(last().range).toBeDefined();
    expect(last().hits).toBeUndefined();
    expect(last().trace).toBeUndefined();
    expect(ipc.semanticSearch).not.toHaveBeenCalled();
    expect(mtimes).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledOnce();
    expect(temporal).not.toHaveBeenCalled();
    expect(synthesize).not.toHaveBeenCalled();
  });

  it("answers topic-free work recall from dated conversation evidence without a generic similarity query", async () => {
    const search = stubExtractive();
    const recall = vi.spyOn(ipc, "temporalRecall").mockResolvedValue({
      events: [{ page: "sessions/2026-09/shared.md", stem: "shared", section: 2,
        text: "**User:**\n\nInvestigate the synthetic caching issue.", role: "User", timestamp: 1790985600 }],
      indexed_pages: 4, scanned_pages: 4, matched_events: 1, incomplete: false,
    });
    const mtimes = vi.spyOn(ipc, "fileMtimes");
    await ask("what did I do yesterday", { scope: "sessions" });
    expect(recall).toHaveBeenCalledWith(expect.objectContaining({ start: expect.any(String) }), "sessions", undefined);
    expect(last()).toMatchObject({ scope: "sessions", range: expect.any(Object) });
    expect(last().a).toContain("[[sessions/2026-09/shared|shared]]");
    expect(last().a).toContain("### Requests / decisions pending / completion unconfirmed\n\n- Investigate the synthetic caching issue.");
    expect(last().a).toContain("No explicit performed-work or result report was found");
    expect(last().a).toContain("rather than verifying completed work");
    expect(search).not.toHaveBeenCalled();
    expect(mtimes).not.toHaveBeenCalled();
  });

  it.each(["어제 한 일 중 RAG 관련만 보여줘", "What did I do yesterday about embeddings?"])(
    "preserves the topic restriction instead of returning every dated event: %s", async (question) => {
      const search = stubExtractive();
      const recall = vi.spyOn(ipc, "temporalRecall");
      const lang = /[가-힣]/.test(question) ? "ko" : "en";
      await useQueryStore.getState().ask(question, lang, askCopy(STRINGS[lang]));
      expect(recall).not.toHaveBeenCalled();
      expect(search).toHaveBeenCalled();
      expect(search.mock.calls[0][0]).toMatch(/RAG|embeddings/);
      expect(last().range).toBeDefined();
    },
  );

  it("preserves incomplete temporal coverage instead of calling missing records no activity", async () => {
    const search = stubExtractive();
    vi.spyOn(ipc, "temporalRecall").mockResolvedValue({
      events: [], indexed_pages: 6, scanned_pages: 2, matched_events: 0, incomplete: true,
    });
    await ask("what did I do yesterday");
    expect(last().a).toContain("Checked 2 of 6");
    expect(last().a).toContain("do not establish that nothing happened");
    expect(last().abstained).toBeUndefined();
    expect(search).not.toHaveBeenCalled();
  });

  it("drops the late chronological result after Stop without overwriting a following answer", async () => {
    stubExtractive();
    let finish!: (result: Awaited<ReturnType<typeof ipc.temporalRecall>>) => void;
    const recall = vi.spyOn(ipc, "temporalRecall").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = ask("what did I do yesterday");
    await vi.waitFor(() => expect(recall).toHaveBeenCalled());
    useQueryStore.getState().stop();
    await expect(pending).resolves.toMatchObject({ stopped: true });
    await ask("zzqq");
    finish({ events: [], indexed_pages: 0, scanned_pages: 0, matched_events: 0, incomplete: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(last()).toMatchObject({ q: "zzqq", a: copy.extractiveEmpty });
  });

  it("keeps a note path restriction and does not use chronology after dropping the period", async () => {
    stubExtractive();
    const recall = vi.spyOn(ipc, "temporalRecall");
    const note = { path: "/v/wiki/a.md", title: "a" };
    await ask("what did I do yesterday", { note });
    expect(recall).toHaveBeenCalledWith(expect.any(Object), "all", expect.arrayContaining(["wiki/a.md"]));
    recall.mockClear();
    await ask("what did I do yesterday", { ignoreRange: true });
    expect(recall).not.toHaveBeenCalled();
  });

  it("a dated question searches that window and keeps it on the turn", async () => {
    const search = stubExtractive();
    await useQueryStore.getState().ask("last week zzqq", "en", copy);
    expect(search.mock.calls[0][0]).toBe("zzqq");
    expect(search.mock.calls[0][4]).toEqual(expect.objectContaining({ start: expect.any(String) }));
    expect(useQueryStore.getState().turns.at(-1)?.range).toBeDefined();
  });

  it("\"search again without the period\" keeps the words and drops the window", async () => {
    const search = stubExtractive();
    await useQueryStore.getState().ask("last week zzqq", "en", copy, { ignoreRange: true });
    expect(search.mock.calls[0][0]).toBe("zzqq");
    expect(search.mock.calls[0][4]).toBeUndefined();
    const turn = useQueryStore.getState().turns.at(-1);
    expect(turn?.q).toBe("last week zzqq");
    expect(turn?.range).toBeUndefined();
    expect(turn?.a).toBe(copy.extractiveEmpty);
  });

  it("drops even an explicitly captured period when ignoreRange is set", async () => {
    const search = stubExtractive();
    await ask("Explain attention yesterday", {
      ignoreRange: true, range: { start: "2026-10-06", end: "2026-10-06" },
    });
    expect(search.mock.calls[0][4]).toBeUndefined();
    expect(last().range).toBeUndefined();
  });

  it("widening a turn whose period was dropped keeps the period dropped", async () => {
    const search = stubExtractive();
    await ask("last week zzqq");
    await ask(last().q, reasksOf(last()).dropRange);
    expect(search.mock.calls[1][4]).toBeUndefined();
    // The re-asked turn has no period chip and a narrower scope, so its card
    // offers "widen" — which must not parse "last week" back out of q.
    await ask(last().q, reasksOf(last()).widen);
    expect(search.mock.calls[2][4]).toBeUndefined();
    expect(search.mock.calls[2][5]).toBe("all");
    expect(last().range).toBeUndefined();
    expect(last().a).toBe(copy.extractiveEmpty);
  });

  it("widens a dated abstention with its exact captured period after a week rollover", async () => {
    const search = stubExtractive();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 4, 12));
    try {
      await ask("last week zzqq");
      const dated = last();
      const range = { start: "2026-09-21", end: "2026-09-27" };
      expect(dated).toMatchObject({ range, scope: "wiki", abstained: true });
      vi.setSystemTime(new Date(2026, 9, 5, 12));
      await ask(dated.q, reasksOf(dated).widen);
      expect(search.mock.calls[1][4]).toEqual(range);
      expect(search.mock.calls[1][5]).toBe("all");
      expect(last()).toMatchObject({ q: dated.q, range, scope: "all", abstained: true });
      expect(reasksOf(last()).widen).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });

  it("a dated abstain widens over every scope with its period, or drops the period", async () => {
    const search = stubExtractive();
    await ask("last week zzqq");
    const dated = last();
    expect(reasksOf(dated).dropRange).toEqual({ scope: "wiki", ignoreRange: true });
    await ask(dated.q, reasksOf(dated).widen);
    expect(search.mock.calls[1][4]).toEqual(dated.range);
    expect(search.mock.calls[1][5]).toBe("all");
    // Every scope already: only the period is left to drop.
    expect(reasksOf(last()).widen).toBeUndefined();
    expect(reasksOf(last()).dropRange).toEqual({ scope: "all", ignoreRange: true });
  });
});

// "Ask this note" (UX S37): the question runs over the note and its one-hop
// links only, still extractive and still abstaining below the floor.
describe("queryStore.ask over one note", () => {
  const note = { path: "/v/wiki/a.md", title: "Note A" };
  beforeEach(() => {
    vi.restoreAllMocks();
    useVaultStore.setState({
      currentVault: { path: "/v", name: "v" },
      adjacency: {
        forward: { "/v/wiki/a.md": ["/v/wiki/b.md"] },
        backward: { "/v/wiki/a.md": ["/v/sessions/2026-09/s.md"] },
        unresolved: {},
        tags: {},
      },
    });
    useUIStore.setState({ askScope: "wiki" });
    useQueryStore.getState().clear();
  });

  it("searches only the note and its links, over every tier, and keeps the note on the turn", async () => {
    const search = stubExtractive();
    await ask("zzqq", { note });
    expect(search.mock.calls[0][5]).toBe("all");
    expect(search.mock.calls[0][7]).toEqual(["wiki/a.md", "wiki/b.md", "sessions/2026-09/s.md"]);
    expect(last().note).toEqual(note);
    // Nothing cleared the floor: the abstain card, not a quote.
    expect(last().abstained).toBe(true);
  });

  it("quotes the note verbatim when it answers", async () => {
    stubAnswer();
    await ask("attention", { note });
    expect(last().extractive).toBe(true);
    expect(last().hits?.[0].text).toBe("# Attention\nattention body[^1]");
  });

  it("a question without a note has no path filter, whatever the page shows", async () => {
    const search = stubExtractive();
    useQueryStore.getState().setNoteScope(note);
    await ask("zzqq");
    expect(search.mock.calls[0][7]).toBeUndefined();
    expect(last().note).toBeUndefined();
  });

  it("a provider answer is told to stay in the note's files and never gets the whole vault", async () => {
    const chat = stubProvider().mockImplementation(() => reply("ok"));
    await ask("what is attention", { note });
    expect(chat.mock.calls[0][0].messages[0].content).toContain(
      "Answer only from these vault files: wiki/a.md, wiki/b.md, sessions/2026-09/s.md.",
    );
    expect(ipc.readVaultContext).not.toHaveBeenCalled();
  });

  it("a scoped question that finds nothing abstains, never a whole-vault file list", async () => {
    stubExtractive();
    vi.spyOn(ipc, "classifyIntent").mockResolvedValue({ intent: "vault-files" } as never);
    const mtimes = vi.spyOn(ipc, "fileMtimes").mockResolvedValue([] as never);
    await ask("which notes did I change recently", { note });
    expect(last().abstained).toBe(true);
    expect(mtimes).not.toHaveBeenCalled();
  });

  it("a scoped activity question is not answered from the whole vault's git log", async () => {
    stubExtractive();
    const gitLog = vi.spyOn(ipc, "gitLog").mockResolvedValue([] as never);
    await ask("what did I do recently", { note });
    expect(gitLog).not.toHaveBeenCalled();
    expect(last().abstained).toBe(true);
  });

  it("widen leaves the note; dropping the period and retry keep it", async () => {
    stubExtractive();
    await ask("last week zzqq", { note });
    const turn = last();
    expect(reasksOf(turn).widen).toEqual({ scope: "all", ignoreRange: false, range: turn.range });
    expect(reasksOf(turn).dropRange).toMatchObject({ note });
    useQueryStore.setState((s) => ({ turns: [...s.turns.slice(0, -1), { ...turn, error: "x" }] }));
    const search = vi.spyOn(ipc, "semanticSearch");
    await useQueryStore.getState().retry(0, "en", copy);
    expect(search.mock.calls.at(-1)?.[7]).toEqual(["wiki/a.md", "wiki/b.md", "sessions/2026-09/s.md"]);
    expect(last().note).toEqual(note);
  });
});

// The question history (UX S36): every finished turn goes to the open vault's
// log as the page showed it, and comes back after a restart.
describe("queryStore history", () => {
  const logged: AskRecord[] = [];
  beforeEach(() => {
    vi.restoreAllMocks();
    logged.length = 0;
    useVaultStore.setState({ currentVault: { path: "/v", name: "v" } });
    useUIStore.setState({ askScope: "wiki" });
    useQueryStore.getState().clear();
    useQueryStore.setState({ history: [], historyError: null });
    vi.spyOn(ipc, "askHistoryAppend").mockImplementation((_vault, turn) => {
      logged.push(turn);
      return Promise.resolve(null);
    });
  });

  it("logs a finished turn as shown: question, scope, quoted lines, cited notes", async () => {
    stubAnswer();
    await ask("what is attention");
    await vi.waitFor(() => expect(logged).toHaveLength(1));
    expect(ipc.askHistoryAppend).toHaveBeenCalledWith("/v", logged[0]);
    expect(logged[0]).toEqual({
      at: expect.any(Number),
      q: "what is attention",
      scope: "wiki",
      a: "**[[wiki/attention-mechanism|attention-mechanism]]**\n\n> **Attention**\n> attention body",
      cited: ["attention-mechanism"],
    });
    // The list shows it at once, without re-reading the log.
    expect(useQueryStore.getState().history).toEqual(logged);
  });

  it("logs an abstained turn with its flag and nothing cited", async () => {
    stubExtractive();
    await ask("zzqq", { scope: "all" });
    await vi.waitFor(() => expect(logged).toHaveLength(1));
    expect(logged[0]).toMatchObject({ q: "zzqq", scope: "all", a: "", cited: [], abstained: true });
  });

  it("logs a note's turn with the note, not as a search over everything", async () => {
    stubExtractive();
    await ask("zzqq", { note: { path: "/v/wiki/a.md", title: "Note A" } });
    await vi.waitFor(() => expect(logged).toHaveLength(1));
    expect(logged[0]).toMatchObject({ q: "zzqq", note: { title: "Note A" }, abstained: true });
    expect(logged[0].scope).toBeUndefined();
  });

  it("brings the turns back when the store is made again", async () => {
    stubAnswer();
    await ask("what is attention");
    await vi.waitFor(() => expect(logged).toHaveLength(1));
    vi.resetModules();
    const fresh = (await import("./queryStore")).useQueryStore;
    const freshIpc = (await import("../lib/ipc")).ipc;
    (await import("./vaultStore")).useVaultStore.setState({ currentVault: { path: "/v", name: "v" } });
    const load = vi.spyOn(freshIpc, "askHistoryLoad").mockResolvedValue([...logged]);
    expect(fresh.getState().history).toEqual([]);
    await fresh.getState().loadHistory();
    expect(load).toHaveBeenCalledWith("/v");
    expect(fresh.getState().history).toEqual(logged);
  });

  it("says so when the log cannot be read", async () => {
    vi.spyOn(ipc, "askHistoryLoad").mockRejectedValue(new Error("EACCES"));
    await useQueryStore.getState().loadHistory();
    expect(useQueryStore.getState().historyError).toContain("EACCES");
    expect(useQueryStore.getState().history).toEqual([]);
  });
});

/** The provider path (Ollama) with no index: `chat` is the model call. */
function stubProvider() {
  stubAskRole("ollama", "llama3");
  vi.spyOn(ipc, "getSettings").mockResolvedValue({
    query_provider: "ollama",
    query_model: "llama3",
  } as MycoSettings);
  vi.spyOn(ipc, "getDistillConfig").mockRejectedValue(new Error("no config"));
  vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({
    indexed_pages: 0,
    model: "",
  } as Awaited<ReturnType<typeof ipc.embeddingsStatus>>);
  vi.spyOn(ipc, "readVaultContext").mockResolvedValue("");
  vi.spyOn(ipc, "semanticSearch").mockResolvedValue({ hits: [], floor: 0.42, below_floor: [] });
  return vi.spyOn(ipc, "chatComplete");
}
const reply = (content: string) =>
  Promise.resolve({ provider_id: "ollama", model: "llama3", content, usage: null });

// An error turn's [다시 시도] (UX S36): the same question, the same scope, in
// the failed turn's place.
describe("queryStore.retry", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useVaultStore.setState({ currentVault: { path: "/v", name: "v" } });
    useUIStore.setState({ askScope: "wiki" });
    useQueryStore.getState().clear();
    vi.spyOn(ipc, "askHistoryAppend").mockResolvedValue(null);
  });

  it("asks the failed question again with its scope, in its place", async () => {
    const chat = stubProvider()
      .mockRejectedValueOnce(new Error("ollama: connection refused"))
      .mockImplementationOnce(() => reply("the answer"));
    await ask("what is attention", { scope: "sessions" });
    expect(last().error).toContain("connection refused");
    // The saved segment moved meanwhile: the retry keeps the turn's own scope.
    useUIStore.setState({ askScope: "all" });
    await useQueryStore.getState().retry(0, "en", copy);
    expect(chat).toHaveBeenCalledTimes(2);
    expect(chat.mock.calls[1].slice(1)).toEqual([syntheticOrigin, roleFixture("ask", "ollama", "llama3")]);
    expect(chat.mock.calls[1][0].messages.at(-1)).toEqual({ role: "user", content: "what is attention" });
    const { turns } = useQueryStore.getState();
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ q: "what is attention", scope: "sessions", a: "the answer" });
    expect(turns[0].error).toBeUndefined();
  });

  it("a failed re-ask without its period retries without it", async () => {
    const chat = stubProvider()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockImplementationOnce(() => reply("ok"));
    await ask("last week zzqq", { scope: "wiki", ignoreRange: true });
    await useQueryStore.getState().retry(0, "en", copy);
    expect(chat.mock.calls[1][0].messages[0].content).not.toContain("Focus on sources dated");
  });

  // An earlier turn's retry would be asked after, and with, the turns that
  // came later ("it" would point at the later question) and land below them.
  it("does nothing for a failed turn that is no longer the last", async () => {
    const chat = stubProvider()
      .mockRejectedValueOnce(new Error("ollama: timeout"))
      .mockImplementation(() => reply("answer two"));
    await ask("one");
    await ask("two");
    await useQueryStore.getState().retry(0, "en", copy);
    expect(chat).toHaveBeenCalledTimes(2);
    expect(useQueryStore.getState().turns.map((t) => t.q)).toEqual(["one", "two"]);
    expect(useQueryStore.getState().turns[0].error).toContain("timeout");
  });

  it("does nothing for a turn that did not fail", async () => {
    const chat = stubProvider().mockImplementation(() => reply("fine"));
    await ask("q");
    await useQueryStore.getState().retry(0, "en", copy);
    expect(chat).toHaveBeenCalledTimes(1);
  });
});

// ■ (UX S36): a provider answer can be stopped; the turn stays as 멈춤 and
// the answer that arrives late is dropped.
describe("queryStore.stop", () => {
  const logged: AskRecord[] = [];
  beforeEach(() => {
    vi.restoreAllMocks();
    logged.length = 0;
    useVaultStore.setState({ currentVault: { path: "/v", name: "v" } });
    useUIStore.setState({ askScope: "wiki" });
    useQueryStore.getState().clear();
    vi.spyOn(ipc, "askHistoryAppend").mockImplementation((_vault, turn) => {
      logged.push(turn);
      return Promise.resolve(null);
    });
  });

  /** A model call that answers only when `answer` is called. */
  function pending(chat: ReturnType<typeof stubProvider>) {
    let answer: (content: string) => void = () => undefined;
    chat.mockImplementationOnce(
      () =>
        new Promise((r) => {
          answer = (content) => r({ provider_id: "ollama", model: "llama3", content, usage: null });
        }),
    );
    return (content: string) => answer(content);
  }

  it("leaves the turn stopped, frees the composer, and drops the late answer", async () => {
    const chat = stubProvider();
    const answer = pending(chat);
    const asking = ask("what is attention");
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(1));
    useQueryStore.getState().stop();
    expect(last()).toMatchObject({ q: "what is attention", a: "", stopped: true });
    expect(useQueryStore.getState().busy).toBe(false);
    answer("too late");
    await asking;
    expect(last().a).toBe("");
    expect(last().stopped).toBe(true);
    await vi.waitFor(() => expect(logged).toHaveLength(1));
    expect(logged[0]).toMatchObject({ q: "what is attention", a: "", stopped: true });
  });

  it("the stopped run's late finish leaves the next question alone", async () => {
    const chat = stubProvider();
    const first = pending(chat);
    const asking = ask("one");
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(1));
    useQueryStore.getState().stop();
    const second = pending(chat);
    const askingTwo = ask("two");
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
    first("late one");
    await asking;
    expect(useQueryStore.getState().busy).toBe(true);
    expect(last()).toMatchObject({ q: "two", a: "" });
    second("answer two");
    await askingTwo;
    expect(last().a).toBe("answer two");
    expect(useQueryStore.getState().turns.map((t) => t.stopped ?? false)).toEqual([true, false]);
  });

  it("ask() resolves with the turn it answered", async () => {
    stubProvider().mockImplementation(() => reply("the answer"));
    await expect(ask("what is attention")).resolves.toMatchObject({
      q: "what is attention",
      a: "the answer",
    });
  });

  // A caller waiting on ask() (the Spotlight) must hear about ■ at once, not
  // when the call it no longer wants comes back, and never read another
  // question's turn as its own.
  it("■ settles the ask at once with its own stopped turn", async () => {
    const chat = stubProvider();
    pending(chat); // never answered
    let settled: ChatTurn | undefined | "pending" = "pending";
    void ask("one").then((turn) => (settled = turn));
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(1));
    useQueryStore.getState().stop();
    await vi.waitFor(() => expect(settled).toMatchObject({ q: "one", stopped: true }));
  });

  it("rejects an unavailable CLI grant before spawning a run or writing successful history", async () => {
    stubAskRole();
    vi.mocked(ipc.captureModelRole).mockRejectedValue(new Error("connection_unavailable: synthetic external CLI boundary is unavailable"));
    vi.spyOn(ipc, "getSettings").mockResolvedValue({
      query_provider: "anthropic-cli",
      query_model: "",
    } as MycoSettings);
    vi.spyOn(ipc, "getDistillConfig").mockRejectedValue(new Error("no config"));
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({
      indexed_pages: 0,
      model: "",
    } as Awaited<ReturnType<typeof ipc.embeddingsStatus>>);
    const run = vi.spyOn(ipc, "claudeRunStream").mockImplementation(() => new Promise(() => undefined));
    const cancel = vi.spyOn(ipc, "claudeCancel").mockResolvedValue(true);
    const turn = await ask("what is attention");
    expect(turn).toMatchObject({ a: "", error: expect.any(String) });
    expect(run).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(ipc.embeddingsStatus).not.toHaveBeenCalled();
    expect(logged.filter(record => record.a.trim() && !record.error && !record.stopped)).toEqual([]);
  });

  it("a question stopped before the model is reached never reaches it", async () => {
    const chat = stubProvider();
    let release: () => void = () => undefined;
    vi.mocked(ipc.embeddingsStatus).mockImplementation(
      () => new Promise((resolve) => { release = () => resolve({ indexed_pages: 0, model: "" } as Awaited<ReturnType<typeof ipc.embeddingsStatus>>); }),
    );
    const asking = ask("q");
    await vi.waitFor(() => expect(ipc.embeddingsStatus).toHaveBeenCalled());
    useQueryStore.getState().stop();
    release();
    await asking;
    expect(chat).not.toHaveBeenCalled();
    expect(last().stopped).toBe(true);
    expect(last().error).toBeUndefined();
  });
});

describe("queryStore asynchronous ownership", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    stubAskRole();
    useVaultStore.setState({ currentVault: { path: "/v", name: "Synthetic vault" } });
    useQueryStore.getState().clear();
    useQueryStore.setState({ history: [], historyError: null, noteScope: null });
    vi.spyOn(ipc, "askHistoryAppend").mockResolvedValue(null);
  });

  it("clearing a running conversation cannot overwrite the next question", async () => {
    const chat = stubProvider();
    let finishOld!: (value: Awaited<ReturnType<typeof ipc.chatComplete>>) => void;
    chat.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
    const old = ask("old question");
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(1));
    useQueryStore.getState().clear();
    let finishNew!: (value: Awaited<ReturnType<typeof ipc.chatComplete>>) => void;
    chat.mockImplementationOnce(() => new Promise((resolve) => { finishNew = resolve; }));
    const current = ask("new question");
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
    finishOld(await reply("old answer"));
    await old;
    expect(useQueryStore.getState().busy).toBe(true);
    expect(last()).toMatchObject({ q: "new question", a: "" });
    finishNew(await reply("new answer"));
    await current;
    expect(last().a).toBe("new answer");
  });

  it("closing and reopening a vault clears conversation state and rejects its late answer", async () => {
    const chat = stubProvider();
    let finish!: (value: Awaited<ReturnType<typeof ipc.chatComplete>>) => void;
    chat.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    useQueryStore.setState({ noteScope: { path: "/v/wiki/a.md", title: "Synthetic note" } });
    const pending = ask("old question");
    await vi.waitFor(() => expect(chat).toHaveBeenCalled());
    useVaultStore.setState({ currentVault: null });
    useVaultStore.setState({ currentVault: { path: "/v", name: "Synthetic reopened vault" } });
    finish(await reply("old answer"));
    await pending;
    expect(useQueryStore.getState()).toMatchObject({ turns: [], history: [], noteScope: null, busy: false, stage: null });
    expect(ipc.askHistoryAppend).not.toHaveBeenCalled();
  });

  it("rejects a late answer when the same vault path receives a new opening token", async () => {
    const chat = stubProvider();
    let finish!: (value: Awaited<ReturnType<typeof ipc.chatComplete>>) => void;
    chat.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = ask("old synthetic question");
    await vi.waitFor(() => expect(chat).toHaveBeenCalled());
    useVaultStore.setState({ vaultToken: "synthetic-reopened-token" });
    finish(await reply("stale synthetic answer"));
    await pending;
    expect(useQueryStore.getState()).toMatchObject({ turns: [], history: [], noteScope: null, busy: false });
    expect(ipc.askHistoryAppend).not.toHaveBeenCalled();
  });

  it("a delayed history append cannot enter the replacement vault's list", async () => {
    let finish!: () => void;
    vi.mocked(ipc.askHistoryAppend).mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve(null); }));
    stubAnswer();
    await ask("what is attention");
    useVaultStore.setState({ currentVault: { path: "/other", name: "Synthetic other vault" } });
    const current: AskRecord[] = [{ at: 10, q: "current", a: "current answer", cited: [] }];
    useQueryStore.setState({ history: current });
    finish();
    await Promise.resolve();
    expect(useQueryStore.getState().history).toEqual(current);
  });

  it("a late history error cannot clear a replacement vault's successful history", async () => {
    let fail!: (error: Error) => void;
    vi.spyOn(ipc, "askHistoryLoad").mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
    const old = useQueryStore.getState().loadHistory();
    useVaultStore.setState({ currentVault: { path: "/other", name: "Synthetic other vault" } });
    const current: AskRecord[] = [{ at: 10, q: "current", a: "current answer", cited: [] }];
    vi.mocked(ipc.askHistoryLoad).mockResolvedValueOnce(current);
    await useQueryStore.getState().loadHistory();
    fail(new Error("Synthetic old history read failure"));
    await old;
    expect(useQueryStore.getState()).toMatchObject({ history: current, historyError: null });
  });

  it("only the latest history load can update the same vault", async () => {
    let finish!: (rows: AskRecord[]) => void;
    vi.spyOn(ipc, "askHistoryLoad").mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const old = useQueryStore.getState().loadHistory();
    const current: AskRecord[] = [{ at: 10, q: "current", a: "current answer", cited: [] }];
    vi.mocked(ipc.askHistoryLoad).mockResolvedValueOnce(current);
    await useQueryStore.getState().loadHistory();
    finish([]);
    await old;
    expect(useQueryStore.getState().history).toEqual(current);
  });

  it("a delayed question capture cannot mark a new conversation's turn", async () => {
    useQueryStore.setState({ turns: [{ q: "old question", a: "" }] });
    let finish!: (written: Captured) => void;
    const pending = useQueryStore.getState().note(0, () => new Promise((resolve) => { finish = resolve; }));
    useQueryStore.getState().clear();
    useQueryStore.setState({ turns: [{ q: "new question", a: "" }] });
    finish({ rel: "daily/synthetic.md", line: "Synthetic captured question" });
    await pending;
    expect(last()).toEqual({ q: "new question", a: "" });
  });

  it("deduplicates a pending recall-miss write and does not mark a replacement turn", async () => {
    useQueryStore.setState({ turns: [{ q: "old question", a: "" }] });
    let finish!: () => void;
    const write = vi.spyOn(ipc, "recordRecallMiss").mockResolvedValue(null)
      .mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve(null); }));
    const pending = useQueryStore.getState().harvest(0);
    void useQueryStore.getState().harvest(0);
    useQueryStore.getState().clear();
    useQueryStore.setState({ turns: [{ q: "new question", a: "" }] });
    finish();
    await pending;
    expect(write).toHaveBeenCalledTimes(1);
    expect(last()).toEqual({ q: "new question", a: "" });
  });

  it("stopping an offline retrieval settles immediately without its late result", async () => {
    const search = stubExtractive();
    let finish!: (value: Awaited<ReturnType<typeof ipc.semanticSearch>>) => void;
    search.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    let result: ChatTurn | undefined | "pending" = "pending";
    const pending = ask("synthetic query").then((turn) => { result = turn; });
    await vi.waitFor(() => expect(search).toHaveBeenCalled());
    useQueryStore.getState().stop();
    await vi.waitFor(() => expect(result).toMatchObject({ stopped: true }), { timeout: 150 });
    finish({ hits: [], floor: 0.42, below_floor: [] });
    await pending;
  });

  it.each([null, { rel: "daily/synthetic.md", line: "Synthetic captured question" }])(
    "preserves capture completion when harvest patches the same turn (%j)",
    async (receipt) => {
      useQueryStore.setState({ turns: [{ q: "synthetic question", a: "" }] });
      vi.spyOn(ipc, "recordRecallMiss").mockResolvedValue(null);
      let finish!: (written: Captured | null) => void;
      const pending = useQueryStore.getState().note(0, () => new Promise((resolve) => { finish = resolve; }));
      await useQueryStore.getState().harvest(0);
      finish(receipt);
      await pending;
      expect(last()).toMatchObject({ harvested: true, noted: receipt !== null });
      expect(last().notedIn).toEqual(receipt ?? undefined);
    },
  );

  it("keeps a pending harvest deduplicated when capture patches the same turn", async () => {
    useQueryStore.setState({ turns: [{ q: "synthetic question", a: "" }] });
    let finish!: () => void;
    const write = vi.spyOn(ipc, "recordRecallMiss").mockResolvedValue(null)
      .mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve(null); }));
    const pending = useQueryStore.getState().harvest(0);
    await useQueryStore.getState().note(0, async () => null);
    await useQueryStore.getState().harvest(0);
    finish();
    await pending;
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("stopping a pending activity read settles immediately", async () => {
    const git = vi.spyOn(ipc, "gitLog").mockImplementation(() => new Promise(() => undefined));
    let result: ChatTurn | undefined | "pending" = "pending";
    void ask("Recent commits").then((turn) => { result = turn; });
    await vi.waitFor(() => expect(git).toHaveBeenCalled());
    useQueryStore.getState().stop();
    await vi.waitFor(() => expect(result).toMatchObject({ stopped: true }), { timeout: 150 });
  });

  it("stopping pending intent classification settles immediately", async () => {
    stubExtractive().mockResolvedValue({ hits: [], floor: 0.42, below_floor: [] });
    const intent = vi.spyOn(ipc, "classifyIntent").mockImplementation(() => new Promise(() => undefined));
    let result: ChatTurn | undefined | "pending" = "pending";
    void ask("which notes were modified yesterday").then((turn) => { result = turn; });
    await vi.waitFor(() => expect(intent).toHaveBeenCalled());
    useQueryStore.getState().stop();
    await vi.waitFor(() => expect(result).toMatchObject({ stopped: true }), { timeout: 150 });
  });

  it("an activity read failure is an error rather than an empty git history", async () => {
    vi.spyOn(ipc, "gitLog").mockRejectedValue(new Error("Synthetic history read failure"));
    await expect(ask("Recent commits")).resolves.toMatchObject({ a: "", error: "Error: Synthetic history read failure" });
  });

  it("a vault opening clears pending questions before its native root can change", async () => {
    const chat = stubProvider();
    chat.mockImplementationOnce(() => new Promise(() => undefined));
    void ask("old question");
    await vi.waitFor(() => expect(chat).toHaveBeenCalled());
    useVaultStore.setState({ isOpeningVault: true });
    try {
      expect(useQueryStore.getState()).toMatchObject({ turns: [], history: [], busy: false });
      await expect(ask("question during vault transition")).resolves.toBeUndefined();
      expect(chat).toHaveBeenCalledTimes(1);
    } finally { useVaultStore.setState({ isOpeningVault: false }); }
  });
});
