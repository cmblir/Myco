import { registerModelContextBudget } from "../lib/modelContextBudget";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { recordOf, askCopy, reasksOf, useQueryStore, type AskOpts, type ChatTurn } from "./queryStore";
import { useUIStore } from "./uiStore";
import { useVaultStore } from "./vaultStore";
import type { Captured } from "../lib/dailyNote";
import { ipc, type ActivityResolutionRequest, type ActivitySynthesisReceipt, type AskRecord, type AskScope, type LocalSynthesisResult, type MycoSettings } from "../lib/ipc";
import { STRINGS } from "../lib/i18n";
import { BUILTIN_EMBED_MODEL } from "../lib/providers";
import { queryDateRange } from "../lib/timeQuery";
import { roleFixture, syntheticOrigin } from "../lib/modelRoles.testSupport";
import { useSettingsStore } from "./settingsStore";
import { ModelEvidenceAbstention } from "../lib/answerCitation";
import { buildExplainQuestion, buildGuidedQuestion, guidedQuestionPrompt, type GuidedQuestionSelection } from "../lib/guidedQuestion";

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
    const period = last().range;
    await ask("그건 왜?");
    const request = vi.mocked(ipc.localSynthesize).mock.calls.at(-1)![0];
    expect(request).toMatchObject({ question: "그건 왜?", previousQuestion: "Explain attention", scope: "wiki" });
    expect(request.range).toEqual(period);
    expect(JSON.stringify(request)).not.toContain("Synthetic synthesis.");
    expect(vi.mocked(ipc.semanticSearch).mock.calls.at(-1)![0]).toBe("Explain attention 그건 왜?");
    expect(last()).toMatchObject({ q: "그건 왜?", followUp: true, localModel: model, range: period });
    expect(vi.mocked(ipc.askHistoryAppend).mock.calls.at(-1)![1].q).toBe("그건 왜?");
    await ask("그래서?");
    expect(vi.mocked(ipc.localSynthesize).mock.calls.at(-1)![0]).toMatchObject({ question: "그래서?", previousQuestion: "Explain attention" });
    await ask("Explain a different synthetic topic");
    expect(vi.mocked(ipc.localSynthesize).mock.calls.at(-1)![0].previousQuestion).toBeUndefined();
  });

  it("uses a new explicit period on a follow-up without reusing the old one", async () => {
    await ask("Explain attention yesterday");
    await useQueryStore.getState().ask("그건 오늘은 어때?", "ko", askCopy(STRINGS.ko));
    expect(last().range).not.toEqual(useQueryStore.getState().turns[0].range);
    expect(last().range?.end).toBe(last().range?.start);
    expect(vi.mocked(ipc.localSynthesize).mock.calls.at(-1)![0].range).toEqual(last().range);
  });

  it("does not carry the old question or period after an explicit scope change", async () => {
    await ask("Explain attention yesterday");
    useUIStore.setState({ askScope: "sessions", isAskScopeExplicit: true });
    await ask("그건 왜?");
    expect(last().scope).toBe("sessions");
    expect(last().range).toBeUndefined();
    expect(last().followUp).toBeUndefined();
    expect(vi.mocked(ipc.localSynthesize).mock.calls.at(-1)![0].previousQuestion).toBeUndefined();
  });

  it("does not carry question context or dates between different selected notes", async () => {
    await ask("Explain attention yesterday", { note: { path: "/v/wiki/attention-mechanism.md", title: "First" } });
    await ask("그건 왜?", { note: { path: "/v/wiki/other.md", title: "Other" } });
    expect(last().followUp).toBeUndefined();
    expect(last().range).toBeUndefined();
    expect(vi.mocked(ipc.semanticSearch).mock.calls.at(-1)![7]).toEqual(["wiki/other.md"]);
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
      execution: { version: 1, selected: { providerId: "builtin-local", modelId: "extractive-retrieval" }, answerKind: "extractive", calls: [] },
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

/** The provider path (Ollama) with verified lexical evidence: `chat` is the model call. */
function stubProvider() {
  stubAskRole("ollama", "llama3");
  vi.spyOn(ipc, "getSettings").mockResolvedValue({
    query_provider: "ollama",
    query_model: "llama3",
  } as MycoSettings);
  vi.spyOn(ipc, "getDistillConfig").mockRejectedValue(new Error("no config"));
  vi.spyOn(ipc, "modelContextBudget").mockResolvedValue(null);
  vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({
    indexed_pages: 0,
    model: "",
  } as Awaited<ReturnType<typeof ipc.embeddingsStatus>>);
  vi.spyOn(ipc, "readVaultContext").mockResolvedValue("");
  vi.spyOn(ipc, "semanticSearch").mockResolvedValue({ hits: [{ page: "wiki/a.md", stem: "a", section: 0, text: "Synthetic source for provider lifecycle tests", score: 0.1, similarity: null, exact_match: true }], floor: 0.42, below_floor: [] });
  return vi.spyOn(ipc, "chatComplete");
}
const reply = (content: string) =>
  Promise.resolve({ provider_id: "ollama", model: "llama3", content, usage: null });

describe("explicit selected-question provider integration", () => {
  const choice: GuidedQuestionSelection = {
    version: 1, intent: "decision", subject: "Synthetic observatory schedule", asOf: "2026-10-15",
  };
  // Synthetic native DTO carries original metadata; an untyped hit is no longer
  // eligible evidence for an explicitly historical question.
  function stubSelectedProvider() {
    const chat = stubProvider();
    const hit = {page:"wiki/a.md",stem:"a",section:0,text:"Synthetic source for provider lifecycle tests",score:0.1,similarity:null,exact_match:true};
    vi.mocked(ipc.semanticSearch).mockResolvedValue({hits:[hit],floor:0.42,below_floor:[],related_context:{passages:[{
      ...hit,source_revision:"a".repeat(64),role:"assistant",message_id:"fictional-decision",timestamp:Date.parse("2026-10-10T00:00:00Z")/1000,
      relation:"accepted_original",anchor_page:hit.page,anchor_section:hit.section,
    }],source_groups:{},scanned_pages:1,incomplete:false}});
    return chat;
  }
  const body = "## 결정\nFictional schedule choice. [[wiki/a|a]]\n## 당시 이유\nRecorded constraints. [[wiki/a|a]]\n## 이후 변경\nUnconfirmed.\n## 근거\n[[wiki/a|a]]";
  beforeEach(() => {
    vi.restoreAllMocks();
    useVaultStore.setState({ currentVault: { path: "/v", name: "Synthetic vault" }, isOpeningVault: false, adjacency: null });
    useUIStore.setState({ askScope: "sessions", isAskScopeExplicit: true });
    useQueryStore.getState().clear();
    useQueryStore.setState({ history: [], historyError: null, noteScope: null });
  });

  it("uses the explicit subject and output contract, preserves scope, and does not turn cutoff into one-day retrieval", async () => {
    const chat = stubSelectedProvider().mockImplementation(() => reply(body));
    useQueryStore.setState({turns:[{q:"An unrelated fictional gardening question",a:"Old answer"}]});
    const q = buildGuidedQuestion(choice, "ko");
    await useQueryStore.getState().ask(q, "ko", askCopy(STRINGS.ko), {guidedQuestion:choice});
    expect(ipc.semanticSearch).toHaveBeenCalledOnce();
    expect(vi.mocked(ipc.semanticSearch).mock.calls[0][0]).toBe(choice.subject);
    expect(vi.mocked(ipc.semanticSearch).mock.calls[0][4]).toBeUndefined();
    expect(vi.mocked(ipc.semanticSearch).mock.calls[0][5]).toBe("sessions");
    expect(vi.mocked(ipc.semanticSearch).mock.calls[0][9]).toBe(choice.intent);
    expect(chat.mock.calls[0][0].messages[0].content).toContain(guidedQuestionPrompt(choice));
    expect(chat.mock.calls[0][0].messages.at(-1)).toEqual({role:"user",content:q});
    expect(chat.mock.calls[0][0].messages).toHaveLength(2);
    expect(JSON.stringify(chat.mock.calls[0][0].messages)).not.toContain("unrelated fictional gardening");
    expect(JSON.stringify(chat.mock.calls[0][0].messages)).not.toContain("Old answer");
    expect(last()).toMatchObject({q,a:body,guidedQuestion:choice,scope:"sessions"});
    expect(last().range).toBeUndefined();
    expect(recordOf(last(), 1).searchContext?.guidedQuestion).toEqual(choice);
    expect(recordOf(last(), 1).searchContext?.range).toBeUndefined();
  });

  it("retains task, target, cutoff and note restriction through retry and saved-history reload", async () => {
    const chat = stubSelectedProvider().mockRejectedValueOnce(new Error("Synthetic temporary failure")).mockImplementation(() => reply(body));
    const saved: AskRecord[] = [];
    vi.mocked(ipc.askHistoryAppend).mockImplementation(async (_vault, record) => {
      saved.push(JSON.parse(JSON.stringify(record)) as AskRecord); return null;
    });
    vi.spyOn(ipc, "askHistoryLoad").mockImplementation(async () => JSON.parse(JSON.stringify(saved)) as AskRecord[]);
    const note = {path:"/v/wiki/a.md",title:"Synthetic source"};
    const q = buildGuidedQuestion(choice, "ko");
    await useQueryStore.getState().ask(q, "ko", askCopy(STRINGS.ko), {guidedQuestion:choice,note});
    expect(last().error).toContain("Synthetic temporary failure");
    useUIStore.setState({askScope:"wiki"});
    await useQueryStore.getState().retry(0,"ko",askCopy(STRINGS.ko));
    expect(last()).toMatchObject({a:body,guidedQuestion:choice,note});
    expect(last().error).toBeUndefined();
    expect(vi.mocked(ipc.semanticSearch).mock.calls.map(call=>call[0])).toEqual([choice.subject,choice.subject]);
    expect(vi.mocked(ipc.semanticSearch).mock.calls.map(call=>call[4])).toEqual([undefined,undefined]);
    expect(vi.mocked(ipc.semanticSearch).mock.calls.at(-1)?.[7]).toEqual(["wiki/a.md"]);
    expect(chat.mock.calls.at(-1)?.[0].messages[0].content).toContain(guidedQuestionPrompt(choice));
    await vi.waitFor(()=>expect(saved).toHaveLength(2));
    expect(saved[1]).toMatchObject({q,a:body,searchContext:{guidedQuestion:choice},note:{title:note.title}});
    const generationCalls=chat.mock.calls.length;
    useQueryStore.setState({history:[]});
    await useQueryStore.getState().loadHistory();
    expect(useQueryStore.getState().history[1]).toEqual(saved[1]);
    expect(chat).toHaveBeenCalledTimes(generationCalls);
  });

  it("keeps the selected task on widening without inventing a date window", () => {
    const widening = reasksOf({q:buildGuidedQuestion(choice),a:"",abstained:true,scope:"wiki",guidedQuestion:choice}).widen;
    expect(widening).toMatchObject({scope:"all",guidedQuestion:choice});
    expect(widening?.range).toBeUndefined();
  });

  it("keeps a date inside the explicitly selected subject from becoming a one-day source filter", async () => {
    stubSelectedProvider().mockImplementation(() => reply(body));
    const datedSubject: GuidedQuestionSelection={version:1,intent:"decision",subject:"2026년 9월 8일 가상 관측소 회의"};
    await useQueryStore.getState().ask(buildGuidedQuestion(datedSubject),"ko",askCopy(STRINGS.ko),{guidedQuestion:datedSubject});
    expect(vi.mocked(ipc.semanticSearch).mock.calls[0][0]).toBe(datedSubject.subject);
    expect(vi.mocked(ipc.semanticSearch).mock.calls[0][4]).toBeUndefined();
    expect(last().range).toBeUndefined();
  });

  it("still honors an intentionally supplied source-date window independently of the historical cutoff", async () => {
    stubSelectedProvider().mockImplementation(() => reply(body));
    const range={start:"2026-10-01",end:"2026-10-10"};
    await useQueryStore.getState().ask(buildGuidedQuestion(choice),"ko",askCopy(STRINGS.ko),{guidedQuestion:choice,range});
    expect(vi.mocked(ipc.semanticSearch).mock.calls[0][4]).toEqual(range);
    expect(last().range).toEqual(range);
    expect(recordOf(last(),1).searchContext).toMatchObject({guidedQuestion:choice,range});
  });

  it("records an uncited selected factual response as failure instead of displaying it", async () => {
    stubSelectedProvider().mockImplementation(()=>reply("A fictional task was completed without any citation."));
    await useQueryStore.getState().ask(buildGuidedQuestion(choice),"ko",askCopy(STRINGS.ko),{guidedQuestion:choice});
    expect(last().a).toBe("");
    expect(last().error).toBe(askCopy(STRINGS.ko).answerReviewFailed);
    expect(recordOf(last(),1)).toMatchObject({a:"",cited:[],error:askCopy(STRINGS.ko).answerReviewFailed});
  });
});

describe("selected-provider date-grounded activity", () => {
  const model = "myco-trained-kanana15-r10-1200-local";
  const grant = roleFixture("ask", "ollama", model);
  const source = { page: "sessions/synthetic-work.md", stem: "Synthetic work", section: 2,
    text: "[user | 2026-10-06] Please review the prototype.\n[assistant | 2026-10-06] The prototype is still under review; it has not been deployed." };
  const generated = "The prototype remained under review; deployment was not completed. [[sessions/synthetic-work|Synthetic work]]";
  const koAsk = (question: string, opts?: AskOpts) => useQueryStore.getState().ask(question, "ko", askCopy(STRINGS.ko), opts);

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 7, 12));
    useVaultStore.setState({ currentVault: { path: "/v", name: "v" }, adjacency: null, isOpeningVault: false });
    useUIStore.setState({ askScope: "wiki", isAskScopeExplicit: false });
    useQueryStore.getState().clear();
    stubProvider().mockResolvedValue({ provider_id: "ollama", model, content: generated, usage: null });
    vi.mocked(ipc.captureModelRole).mockResolvedValue(grant);
    vi.spyOn(ipc, "localChatStatus");
    vi.spyOn(ipc, "localQueryPlan");
    vi.spyOn(ipc, "localSynthesize");
    vi.spyOn(ipc, "activityRecall").mockResolvedValue({ hits: [source], indexed_pages: 8,
      scanned_pages: 5, matched_chunks: 1, incomplete: false });
    vi.spyOn(ipc, "askHistoryAppend").mockResolvedValue(null);
  });
  afterEach(() => { useQueryStore.getState().clear(); vi.useRealTimers(); });

  it("asks which period to review for the actual short Korean question without claiming missing notes", async () => {
    useUIStore.setState({ isAskScopeExplicit: true });
    const turn = await koAsk("최근에 한일");
    expect(turn).toMatchObject({ scope: "wiki", needsClarification: true, activityPeriodNeeded: true,
      activityQuestion: "최근에 한일" });
    expect(turn?.a).toContain("어느 기간");
    expect(turn?.a).not.toContain("찾지 못");
    expect(ipc.activityRecall).not.toHaveBeenCalled();
    expect(ipc.semanticSearch).not.toHaveBeenCalled();
    expect(ipc.chatComplete).not.toHaveBeenCalled();
    expect(ipc.localChatStatus).not.toHaveBeenCalled();
    expect(ipc.localQueryPlan).not.toHaveBeenCalled();
    expect(ipc.localSynthesize).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(ipc.askHistoryAppend).toHaveBeenCalled());
    expect(vi.mocked(ipc.askHistoryAppend).mock.calls.at(-1)?.[1]).toMatchObject({ q: "최근에 한일", a: turn!.a });
  });

  it("collects dated records and generates with the same selected grant instead of doing a similarity search", async () => {
    const turn = await koAsk("2026년 10월 6일 한일", { scope: "sessions" });
    expect(ipc.activityRecall).toHaveBeenCalledWith({ expectedVault: "/v", origin: syntheticOrigin, roleSnapshot: grant,
      range: { start: "2026-10-06", end: "2026-10-06" }, scope: "sessions" });
    expect(ipc.chatComplete).toHaveBeenCalledOnce();
    const [request, origin, snapshot] = vi.mocked(ipc.chatComplete).mock.calls[0];
    expect(request).toMatchObject({ provider_id: "ollama", model });
    expect(origin).toEqual(syntheticOrigin);
    expect(snapshot).toEqual(grant);
    expect(request.messages[0].content).toContain(source.text);
    expect(request.messages[0].content).toContain("2026-10-06..2026-10-06");
    expect(ipc.semanticSearch).not.toHaveBeenCalled();
    expect(ipc.embeddingsStatus).not.toHaveBeenCalled();
    expect(ipc.localChatStatus).not.toHaveBeenCalled();
    expect(ipc.localQueryPlan).not.toHaveBeenCalled();
    expect(ipc.localSynthesize).not.toHaveBeenCalled();
    expect(turn).toMatchObject({ a: generated, scope: "sessions", activityCoverage: { scannedPages: 5, sources: 1, incomplete: false } });
    expect(turn?.localModel).toBeUndefined();
    expect(turn?.extractive).not.toBe(true);
    await vi.waitFor(() => expect(ipc.askHistoryAppend).toHaveBeenCalled());
    expect(vi.mocked(ipc.askHistoryAppend).mock.calls.at(-1)?.[1].a).toBe(generated);
  });

  it("connects a period-only reply to the original question while retaining the default all-record recall scope", async () => {
    await koAsk("최근에 한일");
    const turn = await koAsk("이번 주");
    expect(turn).toMatchObject({ q: "이번 주", activityQuestion: "최근에 한일", a: generated, scope: "all",
      range: { start: "2026-10-05", end: "2026-10-07" } });
    expect(ipc.activityRecall).toHaveBeenCalledWith(expect.objectContaining({
      range: { start: "2026-10-05", end: "2026-10-07" }, scope: "all", roleSnapshot: grant }));
    const request = vi.mocked(ipc.chatComplete).mock.calls[0][0];
    expect(request.messages[0].content).toContain("최근에 한일");
    expect(request.messages.at(-1)?.content).toBe("이번 주");
    expect(useUIStore.getState().askScope).toBe("wiki");
    expect(ipc.localQueryPlan).not.toHaveBeenCalled();
  });

  it("keeps an explicit wiki scope and selected-note path restriction on dated activity reads", async () => {
    useUIStore.setState({ askScope: "wiki", isAskScopeExplicit: true });
    vi.mocked(ipc.activityRecall).mockResolvedValue({ hits: [], indexed_pages: 8, scanned_pages: 1,
      matched_chunks: 0, incomplete: false });
    await koAsk("최근에 한일");
    await koAsk("어제");
    expect(ipc.activityRecall).toHaveBeenLastCalledWith(expect.objectContaining({ scope: "wiki" }));
    useQueryStore.getState().clear();
    await koAsk("2026년 10월 6일 한 일", { note: { path: "/v/wiki/selected.md", title: "Selected note" } });
    expect(ipc.activityRecall).toHaveBeenLastCalledWith(expect.objectContaining({ scope: "all", paths: ["wiki/selected.md"] }));
    expect(ipc.chatComplete).not.toHaveBeenCalled();
    expect(last().activityCoverage).toMatchObject({ scannedPages: 1, sources: 0 });
  });

  it("retains the captured period and original activity question when retrying a failed period reply", async () => {
    vi.mocked(ipc.chatComplete).mockRejectedValueOnce(new Error("temporary selected-provider failure"));
    await koAsk("최근에 한일");
    await koAsk("이번 주");
    expect(last().error).toContain("temporary selected-provider failure");
    useUIStore.setState({ askScope: "sessions", isAskScopeExplicit: true });
    vi.setSystemTime(new Date(2026, 9, 14, 12));
    await useQueryStore.getState().retry(1, "ko", askCopy(STRINGS.ko));
    expect(ipc.activityRecall).toHaveBeenLastCalledWith(expect.objectContaining({ scope: "all",
      range: { start: "2026-10-05", end: "2026-10-07" } }));
    expect(last()).toMatchObject({ a: generated, activityQuestion: "최근에 한일" });
    expect(ipc.localQueryPlan).not.toHaveBeenCalled();
  });

  it("keeps an incomplete native scan visible to the selected generator and in the delivered coverage", async () => {
    vi.mocked(ipc.activityRecall).mockResolvedValue({ hits: [source], indexed_pages: 8,
      scanned_pages: 5, matched_chunks: 1, incomplete: true });
    await koAsk("2026년 10월 6일 한일");
    expect(vi.mocked(ipc.chatComplete).mock.calls[0][0].messages[0].content).toContain("Not all original records could be read");
    expect(last().activityCoverage).toMatchObject({ incomplete: true });
  });

  it("never changes a stale native read into quoted success or a different model call", async () => {
    vi.mocked(ipc.activityRecall).mockRejectedValue(new Error("snapshot_stale: synthetic selection changed"));
    const turn = await koAsk("2026년 10월 6일 한일");
    expect(turn).toMatchObject({ a: "", error: STRINGS.ko.q_model_selection_changed });
    expect(ipc.chatComplete).not.toHaveBeenCalled();
    expect(ipc.semanticSearch).not.toHaveBeenCalled();
    expect(ipc.localSynthesize).not.toHaveBeenCalled();
  });

  it("ignores dated evidence that arrives after Stop without starting provider generation", async () => {
    let release!: (result: Awaited<ReturnType<typeof ipc.activityRecall>>) => void;
    vi.mocked(ipc.activityRecall).mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const activity = koAsk("2026년 10월 6일 한일");
    await vi.waitFor(() => expect(ipc.activityRecall).toHaveBeenCalledOnce());
    useQueryStore.getState().stop();
    await activity;
    release({ hits: [source], indexed_pages: 8, scanned_pages: 5, matched_chunks: 1, incomplete: false });
    await Promise.resolve();
    expect(last()).toMatchObject({ stopped: true, a: "" });
    expect(ipc.chatComplete).not.toHaveBeenCalled();
  });
});

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


describe("HTTP Ask evidence boundary", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useVaultStore.setState({ currentVault: { path: "/v", name: "v" } });
    useQueryStore.getState().clear();
  });
  it("does not replay another scope's answer into a constrained provider request", async () => {
    const chat = stubProvider().mockImplementation(() => reply("Grounded response"));
    useUIStore.setState({ askScope: "sessions", isAskScopeExplicit: true });
    useQueryStore.setState({ turns: [
      { q: "Prior wiki question", a: "OUTSIDE_SCOPE_PRIOR_ANSWER", scope: "wiki" },
      { q: "Legacy unknown scope", a: "UNKNOWN_SCOPE_PRIOR_ANSWER" },
    ] });
    await ask("Explain the synthetic session");
    const prompt = JSON.stringify(chat.mock.calls[0][0].messages);
    expect(prompt).not.toContain("OUTSIDE_SCOPE_PRIOR_ANSWER");
    expect(prompt).not.toContain("UNKNOWN_SCOPE_PRIOR_ANSWER");
    expect(prompt).not.toContain("Prior wiki question");
    expect(last().scope).toBe("sessions");
  });

  it("does not replay an outside-period answer into an explicitly dated request", async () => {
    const chat = stubProvider().mockImplementation(() => reply("Grounded response"));
    useUIStore.setState({ askScope: "wiki", isAskScopeExplicit: true });
    useQueryStore.setState({ turns: [{ q: "Old topic", a: "OUTSIDE_PERIOD_PRIOR_ANSWER", scope: "wiki",
      range: { start: "2026-09-01", end: "2026-09-01" } }] });
    await ask("Explain the synthetic session on 2026-10-01");
    expect(JSON.stringify(chat.mock.calls[0][0].messages)).not.toContain("OUTSIDE_PERIOD_PRIOR_ANSWER");
    expect(last().range).toEqual({ start: "2026-10-01", end: "2026-10-01" });
  });
  it("shows and persists model abstention without claiming search failure or a useful answer", async () => {
    stubProvider().mockRejectedValueOnce(new ModelEvidenceAbstention());
    const saved: AskRecord[] = [];
    vi.mocked(ipc.askHistoryAppend).mockImplementation(async (_vault, record) => {
      saved.push(JSON.parse(JSON.stringify(record)) as AskRecord); return null;
    });
    vi.spyOn(ipc, "askHistoryLoad").mockImplementation(async () => saved);
    await ask("Explain the synthetic record");
    expect(last()).toMatchObject({abstained: true, abstainExplanation: copy.modelEvidenceInsufficient, retrievalFailed: false});
    expect(last().error).toBeUndefined();
    await vi.waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toMatchObject({a: "", cited: [], abstained: true, abstainReason: "model_evidence"});
    expect(saved[0].error).toBeUndefined();
    useQueryStore.setState({history: []});
    await useQueryStore.getState().loadHistory();
    expect(useQueryStore.getState().history[0]).toEqual(saved[0]);
  });
  it("keeps the failed turn's question as recall context but excludes its rejected answer", async () => {
    const chat = stubProvider().mockImplementation(() => reply("A grounded answer"));
    const topic = "Atlas 프로젝트의 저장 방식 결정 이유는?";
    useQueryStore.setState({ turns: [{ q: topic, a: "REJECTED_PRIVATE_DRAFT", error: "citation rejected" }] });
    await ask("직전 결정 질문에서 이야기한 발언을 다시 찾아줘.");
    expect(vi.mocked(ipc.semanticSearch).mock.calls[0][0]).toContain(topic);
    expect(last().followUp).toBe(true);
    expect(chat.mock.calls[0][0].messages[0].content).toContain(topic);
    expect(JSON.stringify(chat.mock.calls[0][0].messages)).not.toContain("REJECTED_PRIVATE_DRAFT");
  });

  it("preserves a clarification when saved history is loaded again", async () => {
    const chat = stubProvider();
    const saved: AskRecord[] = [];
    vi.mocked(ipc.askHistoryAppend).mockImplementation(async (_vault, record) => {
      saved.push(JSON.parse(JSON.stringify(record)) as AskRecord);
      return null;
    });
    vi.spyOn(ipc, "askHistoryLoad").mockImplementation(async () => saved);
    await ask("전에 이야기한 그 내용 찾아줘.");
    await vi.waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].a).toBe(copy.recallTopicNeeded);
    expect(saved[0].abstained).toBeUndefined();
    useQueryStore.setState({ history: [] });
    await useQueryStore.getState().loadHistory();
    expect(useQueryStore.getState().history[0]).toEqual(saved[0]);
    expect(ipc.semanticSearch).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
  });

  it("asks for a missing topic without searching or generating, then accepts a concrete reply", async () => {
    const chat = stubProvider().mockImplementation(() => reply("Grounded response"));
    await ask("전에 이야기한 그 내용 찾아줘.");
    expect(last()).toMatchObject({ needsClarification: true, a: copy.recallTopicNeeded });
    expect(last().followUp).toBeUndefined();
    expect(ipc.semanticSearch).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
    expect(reasksOf(last())).toEqual({});
    await ask("Atlas deployment decision");
    expect(ipc.semanticSearch).toHaveBeenCalledTimes(1);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(last().needsClarification).toBeUndefined();
  });

  it.each(["empty", "failed", "stale"])(
    "does not call the generator for %s retrieval, even after a previous answer",
    async (mode) => {
      const chat = stubProvider().mockImplementation(() =>
        reply("Earlier answer"),
      );
      await ask("initial question");
      expect(chat).toHaveBeenCalledTimes(1);
      chat.mockClear();
      const near = {
        page: "wiki/candidate.md",
        stem: "candidate",
        similarity: null,
        tier: "note" as const,
        score_final: 0.01,
      };
      vi.mocked(ipc.semanticSearch).mockResolvedValue({
        hits: [],
        below_floor: [near],
        floor: 0.42,
      });
      if (mode === "failed")
        vi.mocked(ipc.semanticSearch).mockRejectedValue(
          new Error("PRIVATE FAILURE"),
        );
      if (mode === "stale")
        vi.mocked(ipc.embeddingsStatus).mockResolvedValue({
          indexed_pages: 3,
          model: "builtin-local:retired",
        });
      await ask("follow-up question");
      expect(chat).not.toHaveBeenCalled();
      expect(last().abstained).toBe(true);
      expect(last().retrievalFailed).toBe(mode === "failed");
      expect(last().stale).toBe(mode === "stale");
      expect(last().a).not.toContain("PRIVATE FAILURE");
      expect(ipc.readVaultContext).not.toHaveBeenCalled();
      if (mode !== "failed") expect(last().nearMisses).toEqual([near]);
    },
  );
});


it("persists delivered originals without changing answer text and excludes unsuccessful turns", () => {
  const citationEvidence = {version: 1 as const, sources: [{path:"raw/record.md", revision:"a".repeat(64), spans:[{id:"s1",start:0,end:6,text:"원문",sha256:"b".repeat(64),speaker:"user",turnTime:null}]}]};
  const turn = {q:"Question",a:"Original answer [[raw/record]]",citationEvidence};
  const saved=recordOf(turn,100);
  expect(saved.a).toBe(turn.a);
  expect(saved.citationEvidence).toEqual(citationEvidence);
  expect(saved.citationEvidence).not.toBe(citationEvidence);
  for(const failed of [{error:"bad"},{stopped:true},{abstained:true}])
    expect(recordOf({...turn,...failed},101).citationEvidence).toBeUndefined();
});


it("persists passage omissions within a cited page through the actual packing callback and history reload",async()=>{
 vi.restoreAllMocks();useVaultStore.setState({currentVault:{path:"/v",name:"v"},isOpeningVault:false,adjacency:null});
 useQueryStore.getState().clear();useUIStore.setState({askScope:"sessions",isAskScopeExplicit:true});
 const answer="검토는 진행 중입니다. [[sessions/work|Work]]";
 const chat=stubProvider().mockImplementation(()=>reply(answer));
 const first={page:"sessions/work.md",stem:"Work",section:0,text:"Included: review is still open."};
 const omitted={...first,section:1,text:"OMIT_WHOLE_PASSAGE: additional qualifying record."};
 vi.spyOn(ipc,"activityRecall").mockResolvedValue({hits:[first,omitted],indexed_pages:1,scanned_pages:1,matched_chunks:2,incomplete:false});
 const saved:AskRecord[]=[];
 vi.mocked(ipc.askHistoryAppend).mockImplementation(async(_vault,record)=>{saved.push(JSON.parse(JSON.stringify(record)) as AskRecord);return null;});
 vi.spyOn(ipc,"askHistoryLoad").mockImplementation(async()=>JSON.parse(JSON.stringify(saved)) as AskRecord[]);
 const dispose=registerModelContextBudget("ollama","llama3",{contextTokens:4096,outputTokens:768,
  countMessages:async messages=>messages.some(m=>m.content.includes("OMIT_WHOLE_PASSAGE"))?4000:1000});
 try{
  const turn=await useQueryStore.getState().ask("2026년 10월 6일 한 일","ko",askCopy(STRINGS.ko),{scope:"sessions"});
  expect(turn).toMatchObject({a:answer,activityCoverage:{scannedPages:1,sources:1,incomplete:true},
   searchContext:{packing:{selectedPassages:1,omittedPassages:1,omittedOnIncludedPages:1}}});
  expect(chat).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(chat.mock.calls[0][0].messages)).not.toContain("OMIT_WHOLE_PASSAGE");
  await vi.waitFor(()=>expect(saved).toHaveLength(1));
  expect(saved[0]).toMatchObject({a:answer,scope:"sessions",searchContext:{version:1,range:{start:"2026-10-06",end:"2026-10-06"},
   activityCoverage:{scannedPages:1,sources:1,incomplete:true},packing:{selectedPassages:1,omittedPassages:1,omittedOnIncludedPages:1}}});
  expect(JSON.stringify(saved[0])).not.toContain("OMIT_WHOLE_PASSAGE");
  useQueryStore.setState({history:[]});await useQueryStore.getState().loadHistory();
  expect(useQueryStore.getState().history).toEqual(saved);
  expect(chat).toHaveBeenCalledTimes(1);
 }finally{dispose();useQueryStore.getState().clear();}
});
it("stores true-only applied period semantics, original activity question and immutable note paths outside answer text",()=>{
 const paths=["wiki/selected.md","wiki/linked.md"];
 const turn:ChatTurn={q:"이번 주",a:"Saved answer",scope:"all",note:{path:"/v/wiki/selected.md",title:"Selected"},
  range:{start:"2026-10-05",end:"2026-10-07"},activityQuestion:"최근에 한 일",searchContext:{version:1,paths}};
 const saved=recordOf(turn,100);paths.push("wiki/changed-later.md");
 expect(saved.searchContext).toMatchObject({paths:["wiki/selected.md","wiki/linked.md"],range:turn.range,activityQuestion:"최근에 한 일"});
 expect(saved.a).toBe(turn.a);expect(saved.searchContext?.rangeIgnored).toBeUndefined();
 const ignored=recordOf({...turn,ignoreRange:true},101);
 expect(ignored.searchContext?.rangeIgnored).toBe(true);expect(ignored.searchContext?.range).toBeUndefined();
 const clarification=recordOf({q:"최근에 한 일",a:"Which period?",abstained:true,needsClarification:true,activityPeriodNeeded:true,activityQuestion:"최근에 한 일"},102);
 expect(clarification).toMatchObject({a:"Which period?",searchContext:{periodClarification:true,activityQuestion:"최근에 한 일"}});
 expect(clarification.abstained).toBeUndefined();
});

describe("Ask model execution survives history without changing the prompt",()=>{
 beforeEach(()=>{
  vi.restoreAllMocks();useQueryStore.getState().clear();
  useVaultStore.setState({currentVault:{path:"/v",name:"v"},isOpeningVault:false,adjacency:null});
  useUIStore.setState({askScope:"all",isAskScopeExplicit:true});
 });
 it("saves requested and reported identities separately, and reopens them without another call",async()=>{
  const body="Synthetic answer [[wiki/a]]";
  const chat=stubProvider().mockResolvedValue({provider_id:"ollama",model:"llama3",reported_model:"server-reported",content:body,usage:null});
  const saved:AskRecord[]=[];
  vi.mocked(ipc.askHistoryAppend).mockImplementation(async(_vault,record)=>{saved.push(JSON.parse(JSON.stringify(record)));return null;});
  vi.spyOn(ipc,"askHistoryLoad").mockImplementation(async()=>JSON.parse(JSON.stringify(saved)));
  await ask("synthetic factual question");
  expect(last().a).toBe(body);
  expect(last().execution).toMatchObject({selected:{providerId:"ollama",modelId:"llama3"},answerKind:"model_response",calls:[{
   purpose:"answer",requested:{providerId:"ollama",modelId:"llama3"},state:"response_received",identity:{modelId:"server-reported",source:"provider_response"}}]});
  await vi.waitFor(()=>expect(saved).toHaveLength(1));
  expect(saved[0].a).toBe(body);expect(saved[0].execution).toEqual(last().execution);
  useQueryStore.setState({history:[]});await useQueryStore.getState().loadHistory();
  expect(useQueryStore.getState().history[0].execution).toEqual(saved[0].execution);
  expect(chat).toHaveBeenCalledTimes(1);
  await ask("another synthetic factual question");
  const replay=JSON.stringify(chat.mock.calls[1][0].messages);
  expect(replay).toContain(body);expect(replay).not.toContain("server-reported");expect(replay).not.toContain("provider_response");
 });
 it("never promotes the request echo into a reported model",async()=>{
  stubProvider().mockImplementation(()=>reply("Answer [[wiki/a]]"));
  await ask("synthetic factual question");
  expect(last().execution?.calls[0]).toMatchObject({state:"response_received",requested:{modelId:"llama3"}});
  expect(last().execution?.calls[0].identity).toBeUndefined();
 });
 it.each([false,true])("preserves the answer or error when optional route metadata is invalid (failure=%s)",async failure=>{
  const chat=stubProvider();
  vi.mocked(ipc.captureModelRole).mockResolvedValue(roleFixture("ask","ollama","legacy\nmodel"));
  if (failure) chat.mockRejectedValue(new Error("synthetic rejection"));
  else chat.mockResolvedValue({provider_id:"ollama",model:"legacy\nmodel",content:"Answer [[wiki/a]]",usage:null});
  const saved:AskRecord[]=[];
  vi.mocked(ipc.askHistoryAppend).mockImplementation(async(_vault,record)=>{saved.push(record);return null;});
  await expect(ask("synthetic factual question")).resolves.toBeDefined();
  expect(last().execution).toBeUndefined();
  if (failure) expect(last().error).toContain("synthetic rejection");
  else expect(last().a).toBe("Answer [[wiki/a]]");
  await vi.waitFor(()=>expect(saved).toHaveLength(1));
  expect(saved[0].execution).toBeUndefined();
  expect(saved[0].a).toBe(last().a);expect(saved[0].error).toBe(last().error);
  expect(useQueryStore.getState().busy).toBe(false);
 });
 it("records a period clarification as application text without a generation command",async()=>{
  const chat=stubProvider();
  await useQueryStore.getState().ask("최근에 한일","ko",askCopy(STRINGS.ko));
  expect(last().needsClarification).toBe(true);
  expect(last().execution).toMatchObject({answerKind:"clarification",calls:[],selected:{providerId:"ollama",modelId:"llama3"}});
  expect(chat).not.toHaveBeenCalled();
  expect(recordOf(last(),1).a).toBe(last().a);
 });
 it("records quote-only answers and pre-dispatch empty evidence without claiming generation",async()=>{
  stubAnswer();await ask("attention mechanism");
  expect(last().execution).toMatchObject({answerKind:"extractive",calls:[]});
  useQueryStore.getState().clear();
  const chat=stubProvider();vi.mocked(ipc.semanticSearch).mockResolvedValue({hits:[],floor:0.42,below_floor:[]});
  await ask("unavailable synthetic fact");
  expect(last().execution).toMatchObject({answerKind:"none",calls:[]});expect(chat).not.toHaveBeenCalled();
 });
 it("retains a received identity when citation review rejects the returned answer",async()=>{
  stubProvider().mockResolvedValue({provider_id:"ollama",model:"llama3",reported_model:"reported",content:"Unsupported [[outside/not-supplied]]",usage:null});
  await ask("synthetic factual question");
  expect(last().error).toBe(copy.answerReviewFailed);
  expect(last().execution).toMatchObject({answerKind:"none",calls:[{state:"response_received",identity:{modelId:"reported"}}]});
 });
 it("marks a rejected generation command failed without claiming a remote model ran",async()=>{
  stubProvider().mockRejectedValue(new Error("synthetic native rejection"));await ask("synthetic factual question");
  expect(last().error).toContain("synthetic native rejection");
  expect(last().execution).toMatchObject({answerKind:"none",calls:[{state:"failed"}]});
  expect(last().execution?.calls[0].identity).toBeUndefined();
 });
 it("keeps cancelled metadata immutable when an old reply arrives during the next question",async()=>{
  const chat=stubProvider();let finish!:(value:Awaited<ReturnType<typeof ipc.chatComplete>>)=>void;
  chat.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const first=ask("first synthetic question");await vi.waitFor(()=>expect(chat).toHaveBeenCalledTimes(1));
  useQueryStore.getState().stop();await first;
  const stopped=recordOf(last(),1);
  expect(stopped.execution).toMatchObject({answerKind:"none",calls:[{state:"cancelled"}]});
  chat.mockResolvedValue({provider_id:"ollama",model:"llama3",reported_model:"second",content:"Second [[wiki/a]]",usage:null});
  await ask("second synthetic question");
  finish({provider_id:"ollama",model:"llama3",reported_model:"late-first",content:"Late [[wiki/a]]",usage:null});
  await Promise.resolve();await Promise.resolve();
  expect(stopped.execution?.calls[0].state).toBe("cancelled");
  expect(last().execution?.calls[0].identity?.modelId).toBe("second");
  expect(JSON.stringify(last().execution)).not.toContain("late-first");
 });
 it("leaves a legacy turn's execution unknown instead of using today's selection",()=>{
  expect(recordOf({q:"legacy",a:"old answer"},1).execution).toBeUndefined();
 });
});

// Slice 1 of the workstream upgrade: synthetic facts, not a real vault.
describe("queryStore.ask workstream facts", () => {
  const at = (iso: string): number => Date.parse(iso) / 1000;
  const ledger = "codex:c0ffee01-0000-7000-8000-000000000001";
  const facts = {
    version: 4, last_record_epoch: at("2026-11-07T12:00:00Z"), unassigned: 0,
    workstreams: { prj_lumen: { title: "Lumen", title_source: "readme", page: "wiki/workstreams/prj_lumen.md",
      first_epoch: at("2026-11-07T10:00:00Z"), last_epoch: at("2026-11-07T12:00:00Z"), conversations: 1, roots: 1,
      summary: "A synthetic reminder app.",
      open_items: [{ epoch: at("2026-11-07T12:00:00Z"), text: "Retry the synthetic sync", conversation: ledger }] } },
    conversations: { [ledger]: { automated: false, fp: "0123456789abcdef", vendor: "codex", id: "c0ffee01-0000-7000-8000-000000000001",
      raw: "raw/conversations/codex/codex-c0ffee01-synthetic.md", first_epoch: at("2026-11-07T10:00:00Z"),
      last_epoch: at("2026-11-07T12:00:00Z"), key: "prj_lumen", cwd_source: "state", root: ledger, subagent: false,
      request: "Add synthetic reminders", report: { epoch: at("2026-11-07T12:00:00Z"), text: "Implemented the synthetic scheduler." },
      parent_report: null } },
  };
  const factsFile = (raw: string) => vi.spyOn(ipc, "readFile")
    .mockResolvedValue({ path: "/v/.myco/workstreams.json", raw, content: raw, frontmatter: null });
  const koAsk = (question: string) => useQueryStore.getState().ask(question, "ko", askCopy(STRINGS.ko));

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-08T12:00:00Z"));
    useVaultStore.setState({ currentVault: { path: "/v", name: "v" }, adjacency: null, isOpeningVault: false });
    useUIStore.setState({ askScope: "wiki", isAskScopeExplicit: false });
    useQueryStore.getState().clear();
    stubProvider();
    vi.spyOn(ipc, "askHistoryAppend").mockResolvedValue(null);
  });
  afterEach(() => { useQueryStore.getState().clear(); vi.useRealTimers(); });

  it.each(["그럼 Beta 남은 작업은?", "What about the remaining work in Beta?"])(
    "does not let a named different project inherit the previous selection: %s", async question => {
      const model = "qwen3.5-4b-q4_k_m";
      stubAskRole("builtin-local",model);
      vi.spyOn(ipc,"localChatStatus").mockResolvedValue({model_id:model,state:"ready",bytes:100});
      const source = structuredClone(facts);
      Object.assign(source.workstreams,{beta:{...source.workstreams.prj_lumen,title:"Beta",page:"wiki/workstreams/beta.md",open_items:[]}});
      Object.assign(source.conversations,{"codex:beta":{...source.conversations[ledger],id:"beta",key:"beta",root:"codex:beta",
        raw:"raw/conversations/codex/beta.md"}});
      vi.spyOn(ipc,"readFile").mockImplementation(async path => {
        const raw = JSON.stringify(path.endsWith("ledger.json") ? {entries:{[ledger]:"0123456789abcdef","codex:beta":"0123456789abcdef"},
          locations:{[`sessions:${ledger}`]:"sessions/alpha.md","sessions:codex:beta":"sessions/beta.md"}} : source);
        return {path,raw,content:raw,frontmatter:null};
      });
      const recall = vi.spyOn(ipc,"activityRecall").mockImplementation(async request => ({
        hits:request.paths!.map(page => ({page,stem:page,section:0,text:"A synthetic project request."})),
        indexed_pages:2,scanned_pages:1,matched_chunks:1,incomplete:false,
      }));
      const synthesis = vi.spyOn(ipc,"localSynthesize").mockImplementation(async request => ({
        answer:`A task was requested. [[${request.paths![0].replace(/\.md$/,"")}|source]]`,model_id:model,used_sources:request.paths!,
        activity_receipt:syntheticActivityReceipt(request.range!,request.scope,request.resolution),
      }));
      const choice: GuidedQuestionSelection = {version:1,intent:"remaining",subject:"Lumen",asOf:"2026-11-07"};
      await ask(buildGuidedQuestion(choice,"en"),{guidedQuestion:choice});
      expect(last().projectSelection?.key).toBe("prj_lumen");
      await ask(question);
      expect(last().needsClarification).toBe(true);
      expect(recall).toHaveBeenCalledTimes(1);
      expect(synthesis).toHaveBeenCalledTimes(1);
      await ask("How far along is Beta now?");
      expect(recall).toHaveBeenCalledTimes(2);
      expect(recall.mock.calls[1][0]).toMatchObject({paths:["sessions/beta.md"],range:{start:"2026-11-07",end:"2026-11-08"}});
      expect(last().projectSelection?.key).toBe("beta");
      expect(synthesis.mock.calls[1][0].resolution?.mode).toBe("current_state");
      expect(ipc.semanticSearch).not.toHaveBeenCalled();
    });

  it.each([
    ["retry", false, false], ["follow-up", false, false],
    ["retry", true, false], ["follow-up", true, false],
    ["retry", false, true], ["follow-up", false, true],
    ["retry", true, true], ["follow-up", true, true],
  ] as const)("refreshes derived project paths on %s while retaining explicit paths %s and historical cutoff %s", async (resume, restricted, historical) => {
    const model = "qwen3.5-4b-q4_k_m";
    stubAskRole("builtin-local", model);
    vi.spyOn(ipc,"localChatStatus").mockResolvedValue({model_id:model,state:"ready",bytes:100});
    const source = structuredClone(facts);
    const projection = "sessions/alpha.md";
    const reopened = "sessions/reopened.md";
    const reopeningId = "codex:reopened";
    const locations: Record<string,string> = {[`sessions:${ledger}`]:projection};
    vi.spyOn(ipc,"readFile").mockImplementation(async path => {
      const raw = JSON.stringify(path.endsWith("ledger.json") ? {
        entries:Object.fromEntries(Object.entries(source.conversations).map(([id, conversation]) => [id,conversation.fp])), locations,
      } : source);
      return {path,raw,content:raw,frontmatter:null};
    });
    const recall = vi.spyOn(ipc,"activityRecall").mockResolvedValue({hits:[{page:projection,stem:"Alpha",section:0,
      text:"The synthetic export work was requested."}],indexed_pages:2,scanned_pages:1,matched_chunks:1,incomplete:false});
    let rejectFirst = resume === "retry";
    const synthesis = vi.spyOn(ipc,"localSynthesize").mockImplementation(async request => {
      if (rejectFirst) { rejectFirst = false; throw new Error("synthetic first-attempt failure"); }
      return {answer:"The work was requested. [[sessions/alpha|source]]",model_id:model,used_sources:[projection],
        activity_receipt:syntheticActivityReceipt(request.range!,request.scope,request.resolution)};
    });
    const choice: GuidedQuestionSelection = {version:1,intent:"remaining",subject:"Lumen",
      ...(historical ? {asOf:"2026-11-07"} : {})};
    await ask(buildGuidedQuestion(choice,"en"),{guidedQuestion:choice,scope:"all",
      ...(restricted ? {paths:[projection]} : {}),
      ...(historical ? {range:{start:"2026-11-07",end:"2026-11-07"}} : {})});
    const first = last();
    expect(first.searchContext?.paths).toEqual([projection]);
    expect(first.projectSelection).toEqual({key:"prj_lumen",
      ...(restricted ? {explicitPaths:[projection]} : {}),
      ...(historical ? {explicitRange:{start:"2026-11-07",end:"2026-11-07"}} : {})});
    expect(Boolean(first.error)).toBe(resume === "retry");
    const priorTurn = JSON.stringify(first);
    const priorRecord = recordOf(first,1);
    const priorRecordBytes = JSON.stringify(priorRecord);
    const oldResolution = synthesis.mock.calls[0][0].resolution;
    const recordedAt = historical ? "2026-11-07T11:00:00Z" : "2026-11-09T09:00:00Z";
    Object.assign(source.conversations,{[reopeningId]:{...source.conversations[ledger],id:"reopened",root:reopeningId,
      raw:"raw/conversations/codex/reopened.md",first_epoch:at(recordedAt),last_epoch:at(recordedAt),
      request:"Reopen the synthetic export work; acceptance is failing."}});
    locations[`sessions:${reopeningId}`] = reopened;
    source.workstreams.prj_lumen.conversations = 2;
    source.workstreams.prj_lumen.roots = 2;
    source.workstreams.prj_lumen.last_epoch = at("2026-11-09T09:00:00Z");
    source.last_record_epoch = at("2026-11-09T09:00:00Z");
    // A reused display name must not move the question to a different project.
    source.workstreams.prj_lumen.title = "Renamed original project";
    Object.assign(source.workstreams,{other_lumen:{...source.workstreams.prj_lumen,title:"Lumen",
      page:"wiki/workstreams/other_lumen.md",open_items:[]}});
    Object.assign(source.conversations,{"codex:unrelated":{...source.conversations[ledger],id:"unrelated",
      root:"codex:unrelated",key:"other_lumen",raw:"raw/conversations/codex/unrelated.md"}});
    locations["sessions:codex:unrelated"] = "sessions/unrelated.md";
    if (historical) {
      Object.assign(source.conversations,{"codex:future":{...source.conversations[ledger],id:"future",root:"codex:future",
        raw:"raw/conversations/codex/future.md",first_epoch:at("2026-11-09T09:00:00Z"),last_epoch:at("2026-11-09T09:00:00Z")}});
      locations["sessions:codex:future"] = "sessions/future.md";
    }
    vi.setSystemTime(new Date("2026-11-09T12:00:00Z"));
    if (resume === "retry") await useQueryStore.getState().retry(0,"en",copy);
    else await ask("why?");
    const expectedPaths = restricted ? [projection] : [projection,reopened];
    const expectedRange = {start:"2026-11-07",end:historical ? "2026-11-07" : "2026-11-09"};
    expect(recall).toHaveBeenCalledTimes(2);
    expect(recall.mock.calls[1][0]).toMatchObject({paths:expectedPaths,range:expectedRange,scope:"all"});
    expect(synthesis.mock.calls[1][0]).toMatchObject({paths:expectedPaths,range:expectedRange,scope:"all",
      resolution:{mode:historical ? "historical_as_of" : "current_state",
        asOfEpoch:historical ? oldResolution!.asOfEpoch : at("2026-11-09T12:00:00Z")}});
    expect(last()).toMatchObject({searchContext:{paths:expectedPaths},activityCoverage:{incomplete:false}});
    expect(last().error).toBeUndefined();
    expect(JSON.stringify(first)).toBe(priorTurn);
    expect(JSON.stringify(priorRecord)).toBe(priorRecordBytes);
    expect(priorRecord.searchContext?.paths).toEqual([projection]);
    expect(ipc.semanticSearch).not.toHaveBeenCalled();
    if (resume === "follow-up" && !restricted && !historical) {
      Reflect.deleteProperty(source.workstreams,"prj_lumen");
      Reflect.deleteProperty(source.conversations,ledger);
      Reflect.deleteProperty(source.conversations,reopeningId);
      await ask("why?");
      expect(last().needsClarification).toBe(true);
      expect(last().a).toContain("exact project name");
      expect(recall).toHaveBeenCalledTimes(2);
      expect(ipc.semanticSearch).not.toHaveBeenCalled();
    }
  });

  it.each([[undefined,false,undefined], ["2026-11-01",false,undefined], [undefined,true,undefined], [undefined,false,"all"]] as const)(
    "resolves project state from original evidence with cutoff %s, incomplete candidates %s, scope %s", async (asOf,incomplete,selectedScope) => {
    const scope = selectedScope ?? "sessions";
    const model = "qwen3.5-4b-q4_k_m";
    stubAskRole("builtin-local", model);
    vi.spyOn(ipc,"localChatStatus").mockResolvedValue({model_id:model,state:"ready",bytes:100});
    const source = structuredClone(facts);
    source.workstreams.prj_lumen.first_epoch = at("2026-11-01T09:00:00Z");
    source.conversations[ledger].first_epoch = at("2026-11-01T09:00:00Z");
    if (incomplete) Object.assign(source.conversations, {[`${ledger}-missing`]:{
      ...source.conversations[ledger],id:`${source.conversations[ledger].id}-missing`,root:`${ledger}-missing`,
      raw:"raw/conversations/codex/codex-missing-0123456789abcdef.md",
    }});
    const projection = "sessions/2026-11/alpha.md";
    vi.spyOn(ipc,"readFile").mockImplementation(async path => {
      const raw = JSON.stringify(path.endsWith("ledger.json") ? {
        entries:{[ledger]:source.conversations[ledger].fp}, locations:{[`sessions:${ledger}`]:projection},
      } : source);
      return {path,raw,content:raw,frontmatter:null};
    });
    const recall = vi.spyOn(ipc,"activityRecall").mockResolvedValue({hits:[{page:projection,stem:"Alpha",section:0,
      text:"Please implement the synthetic export test. I plan to write it; it has not run."}],
      indexed_pages:2,scanned_pages:1,matched_chunks:1,incomplete:false});
    const synthesis = vi.spyOn(ipc,"localSynthesize").mockImplementation(async request => ({
      answer:`${asOf ? "The work was requested and planned." : "Completion was reported, then the user reopened the work."} [[sessions/2026-11/alpha|source]]`,
      model_id:model,used_sources:[projection],activity_receipt:syntheticActivityReceipt(request.range!,request.scope,request.resolution),
    }));
    const choice: GuidedQuestionSelection = {version:1,intent:"remaining",subject:"Lumen",...(asOf ? {asOf} : {})};
    await useQueryStore.getState().ask(buildGuidedQuestion(choice,"en"),"en",copy,{guidedQuestion:choice,
      ...(selectedScope ? {scope:selectedScope,paths:[projection,"sessions/unrelated.md"]} : {})});
    expect(recall).toHaveBeenCalledWith(expect.objectContaining({scope,paths:[projection],
      range:{start:"2026-11-01",end:asOf ?? "2026-11-08"}}));
    expect(synthesis).toHaveBeenCalledWith(expect.objectContaining({activityOverview:true,scope,paths:[projection],
      resolution:expect.objectContaining({mode:asOf ? "historical_as_of" : "current_state"})}));
    expect(last().a).not.toContain("Retry the synthetic sync");
    expect(last()).toMatchObject({scope,extractive:false,activityReceipt:expect.any(Object),
      searchContext:{paths:[projection]},activityCoverage:{incomplete}});
    if (incomplete) expect(last().a).toContain("the full current state remains unconfirmed");
    expect(ipc.semanticSearch).not.toHaveBeenCalled();
    await ask("why?");
    expect(recall).toHaveBeenCalledTimes(2);
    expect(synthesis.mock.calls[1][0]).toMatchObject({paths:[projection],scope,
      range:{start:"2026-11-01",end:asOf ?? "2026-11-08"},
      resolution:{mode:asOf ? "historical_as_of" : "current_state"}});
    expect(synthesis.mock.calls[1][0].question).toContain("Lumen");
    expect(last().error).toBeUndefined();
    const reply = await synthesis.mock.results[1].value;
    synthesis.mockImplementationOnce(async request => {
      source.conversations[ledger].fp = "changed-during-generation";
      return {...reply,activity_receipt:syntheticActivityReceipt(request.range!,request.scope,request.resolution)};
    });
    await ask("why?");
    expect(last()).toMatchObject({a:"",error:copy.sourceChanged});
    expect(last().activityReceipt).toBeUndefined();
    if (incomplete) {
      source.conversations[ledger].fp = "0123456789abcdef";
      recall.mockResolvedValueOnce({hits:[],indexed_pages:2,scanned_pages:1,matched_chunks:0,incomplete:false});
      const calls = synthesis.mock.calls.length;
      await ask("why?");
      expect(last()).toMatchObject({a:"",error:copy.activityIncomplete,activityCoverage:{incomplete:true}});
      expect(synthesis).toHaveBeenCalledTimes(calls);
    }
  });

  it.each([
    ["내가 최근에 한 일이 뭐야?", "**[[wiki/workstreams/prj_lumen|Lumen]]** 대화 1건, 세션 1개"],
  ])("answers %s from the facts file before any model or role check", async (question, expected) => {
    const read = factsFile(JSON.stringify(facts));
    const turn = await koAsk(question);
    expect(read).toHaveBeenCalledWith("/v/.myco/workstreams.json");
    expect(turn?.a).toContain(expected);
    expect(turn?.a).toContain("Implemented the synthetic scheduler.\\\n  요청: Add synthetic reminders " +
      "[[raw/conversations/codex/codex-c0ffee01-synthetic|원문]]");
    expect(turn).toMatchObject({ execution: { answerKind: "application", calls: [] } });
    expect(turn?.error).toBeUndefined();
    expect(turn?.needsClarification).toBeUndefined();
    expect(ipc.agentVaultSession).not.toHaveBeenCalled();
    expect(ipc.captureModelRole).not.toHaveBeenCalled();
    expect(ipc.chatComplete).not.toHaveBeenCalled();
    expect(ipc.semanticSearch).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(ipc.askHistoryAppend).toHaveBeenCalled());
    expect(vi.mocked(ipc.askHistoryAppend).mock.calls.at(-1)?.[1]).toMatchObject({ q: question, a: turn!.a });
  });

  it.each(["Lumen 지금 어디까지 했어?", "내가 최근에 한 일이 뭐야?"])(
    "keeps an explicitly selected wiki scope for %s", async (question) => {
      const read = factsFile(JSON.stringify(facts));
      useUIStore.setState({ askScope: "wiki", isAskScopeExplicit: true });
      const turn = await koAsk(question);
      expect(read).not.toHaveBeenCalled();
      expect(turn?.scope).toBe("wiki");
      expect(turn?.a).not.toContain("Implemented the synthetic scheduler");
    },
  );

  it("keeps the explicitly selected all scope in the answer and saved history", async () => {
    factsFile(JSON.stringify(facts));
    useUIStore.setState({ askScope: "all", isAskScopeExplicit: true });
    const turn = await koAsk("Lumen 지금 어디까지 했어?");
    expect(turn?.scope).toBe("all");
    await vi.waitFor(() => expect(ipc.askHistoryAppend).toHaveBeenCalled());
    expect(vi.mocked(ipc.askHistoryAppend).mock.calls.at(-1)?.[1].scope).toBe("all");
  });

  it("does not replace an empty recent period with older project reports", async () => {
    factsFile(JSON.stringify(facts));
    vi.setSystemTime(new Date("2026-12-08T12:00:00Z"));
    const turn = await koAsk("내가 최근에 한 일이 뭐야?");
    expect(turn?.a).toContain("프로젝트로 묶인 대화가 없습니다");
    expect(turn?.a).not.toContain("Implemented the synthetic scheduler");
    expect(turn?.a).not.toContain("wiki/workstreams/prj_lumen");
    expect(ipc.captureModelRole).not.toHaveBeenCalled();
  });

  it("drops a workstream answer when its vault changes during the read", async () => {
    let release!: (file: Awaited<ReturnType<typeof ipc.readFile>>) => void;
    vi.spyOn(ipc, "readFile").mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = koAsk("Lumen 지금 어디까지 했어?");
    await vi.waitFor(() => expect(ipc.readFile).toHaveBeenCalledOnce());
    useVaultStore.setState({ currentVault: { path: "/other", name: "other" } });
    release({ path: "/v/.myco/workstreams.json", raw: JSON.stringify(facts), content: "", frontmatter: null });
    await pending;
    expect(useQueryStore.getState().turns.every(turn => !turn.a.includes("Implemented the synthetic scheduler"))).toBe(true);
    expect(ipc.askHistoryAppend).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", () => vi.spyOn(ipc, "readFile")
      .mockRejectedValue("canonicalize failed for /v/.myco/workstreams.json: No such file or directory (os error 2)"), null],
    ["missing on Windows", () => vi.spyOn(ipc, "readFile").mockRejectedValue(
      "canonicalize failed for C:\\v\\.myco\\workstreams.json: The system cannot find the path specified. (os error 3)"), null],
    ["invalid", () => factsFile("{\"version\":3}"), "query.workstreams_invalid"],
    ["version 2, written before a program's sessions were told apart", () =>
      factsFile(JSON.stringify({ ...facts, version: 2 })), "query.workstreams_invalid"],
    ["version 3, written before summaries and open items", () =>
      factsFile(JSON.stringify({ ...facts, version: 3 })), "query.workstreams_invalid"],
    ["unreadable", () => vi.spyOn(ipc, "readFile").mockRejectedValue("read failed: Permission denied (os error 13)"),
      "query.workstreams_unavailable"],
  ] as const)("keeps the existing activity path when the facts file is %s", async (_, stub, warning) => {
    stub();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const turn = await koAsk("최근에 한일");
    expect(turn).toMatchObject({ needsClarification: true, activityPeriodNeeded: true, activityQuestion: "최근에 한일" });
    expect(ipc.captureModelRole).toHaveBeenCalledOnce();
    const warned = warn.mock.calls.map(([line]) => String(line)).filter((line) => line.includes("query.workstreams_"));
    expect(warned.map((line) => JSON.parse(line).event)).toEqual(warning ? [warning] : []);
  });

  it("drops a facts read that finishes after Stop", async () => {
    let release!: (file: Awaited<ReturnType<typeof ipc.readFile>>) => void;
    vi.spyOn(ipc, "readFile").mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = koAsk("Lumen 지금 어디까지 했어?");
    await vi.waitFor(() => expect(ipc.readFile).toHaveBeenCalledOnce());
    useQueryStore.getState().stop();
    await pending;
    release({ path: "/v/.myco/workstreams.json", raw: JSON.stringify(facts), content: "", frontmatter: null });
    await Promise.resolve();
    expect(last()).toMatchObject({ stopped: true, a: "" });
    expect(useQueryStore.getState().busy).toBe(false);
    expect(ipc.captureModelRole).not.toHaveBeenCalled();
  });

  it("does not turn project hints without current source projections into a progress answer", async () => {
    const read = factsFile(JSON.stringify(facts));
    const choice: GuidedQuestionSelection = { version: 1, intent: "progress", subject: "Lumen" };
    const turn = await useQueryStore.getState().ask(buildGuidedQuestion(choice, "ko"), "ko", askCopy(STRINGS.ko),
      { guidedQuestion: choice });
    expect(read).toHaveBeenCalledWith("/v/.myco/workstreams.json");
    expect(turn?.a).not.toContain("Implemented the synthetic scheduler");
    expect(turn).toMatchObject({ guidedQuestion: choice, scope: "sessions", abstained:true,
      activityFailure:"activity_insufficient_evidence",activityCoverage:{incomplete:true} });
    expect(ipc.captureModelRole).not.toHaveBeenCalled();
    expect(ipc.chatComplete).not.toHaveBeenCalled();
  });

  it("does not present old open items as current remaining work without source projections", async () => {
    factsFile(JSON.stringify(facts));
    const choice: GuidedQuestionSelection = { version: 1, intent: "remaining", subject: "Lumen" };
    const turn = await useQueryStore.getState().ask(buildGuidedQuestion(choice, "ko"), "ko", askCopy(STRINGS.ko),
      { guidedQuestion: choice });
    expect(turn?.a).not.toContain("Retry the synthetic sync");
    expect(turn).toMatchObject({ guidedQuestion: choice, scope: "sessions", abstained:true,
      activityFailure:"activity_insufficient_evidence" });
    expect(ipc.captureModelRole).not.toHaveBeenCalled();
  });

  it("answers the explain chip's typed question from the facts file", async () => {
    factsFile(JSON.stringify(facts));
    const turn = await koAsk(buildExplainQuestion("Lumen", "ko"));
    expect(turn?.a).toContain("[[wiki/workstreams/prj_lumen|Lumen]] 프로젝트\n\n- **README** A synthetic reminder app.\n");
    expect(turn?.guidedQuestion).toBeUndefined();
    expect(ipc.captureModelRole).not.toHaveBeenCalled();
  });

  it.each([
    ["another intent", { version: 1, intent: "decision", subject: "Lumen" }],
  ] as const)("keeps the guided route for %s", async (_, choice) => {
    const read = factsFile(JSON.stringify(facts));
    await useQueryStore.getState().ask(buildGuidedQuestion(choice, "ko"), "ko", askCopy(STRINGS.ko),
      { guidedQuestion: choice });
    expect(read).not.toHaveBeenCalled();
    expect(ipc.captureModelRole).toHaveBeenCalledOnce();
  });

  it("requires a project selection for a long topic that only mentions a project", async () => {
    factsFile(JSON.stringify(facts));
    const choice: GuidedQuestionSelection = { version: 1, intent: "progress", subject: "Lumen reminder scheduler retry window" };
    const turn = await useQueryStore.getState().ask(buildGuidedQuestion(choice, "ko"), "ko", askCopy(STRINGS.ko),
      { guidedQuestion: choice });
    expect(turn).toMatchObject({needsClarification:true});
    expect(ipc.captureModelRole).not.toHaveBeenCalled();
    expect(turn?.a).not.toContain("wiki/workstreams/");
  });

  it("asks for an exact project when the name is unknown without searching unrelated records", async () => {
    factsFile(JSON.stringify(facts));
    const recall = vi.spyOn(ipc,"activityRecall");
    const turn = await koAsk("Orbit 지금 어디까지 했어?");
    expect(turn).toMatchObject({needsClarification:true});
    expect(ipc.captureModelRole).not.toHaveBeenCalled();
    expect(ipc.semanticSearch).not.toHaveBeenCalled();
    expect(recall).not.toHaveBeenCalled();
    expect(turn?.a).not.toContain("wiki/workstreams/");
  });

  it("does not turn an ambiguous project name into an unrestricted guided search", async () => {
    factsFile(JSON.stringify({...facts,workstreams:{...facts.workstreams,
      other_lumen:{...facts.workstreams.prj_lumen,page:"wiki/workstreams/other_lumen.md",open_items:[]}},
      conversations:{...facts.conversations,"codex:other":{...facts.conversations[ledger],id:"other",key:"other_lumen",
        root:"codex:other",raw:"raw/conversations/codex/codex-other-0123456789abcdef.md"}}}));
    const recall = vi.spyOn(ipc,"activityRecall");
    const choice: GuidedQuestionSelection = {version:1,intent:"remaining",subject:"Lumen"};
    const turn = await ask(buildGuidedQuestion(choice,"en"),{guidedQuestion:choice});
    expect(turn).toMatchObject({needsClarification:true});
    expect(turn?.a).toContain("exact project name");
    expect(ipc.captureModelRole).not.toHaveBeenCalled();
    expect(ipc.semanticSearch).not.toHaveBeenCalled();
    expect(recall).not.toHaveBeenCalled();
    expect(ipc.chatComplete).not.toHaveBeenCalled();
  });

  it("keeps invalid project facts an explicit incomplete error without broadening retrieval", async () => {
    factsFile('{"version":3}');
    const recall = vi.spyOn(ipc,"activityRecall");
    const turn = await koAsk("Lumen 지금 어디까지 했어?");
    expect(turn).toMatchObject({a:"",error:STRINGS.ko.q_activity_incomplete});
    expect(ipc.captureModelRole).not.toHaveBeenCalled();
    expect(ipc.semanticSearch).not.toHaveBeenCalled();
    expect(recall).not.toHaveBeenCalled();
    expect(ipc.chatComplete).not.toHaveBeenCalled();
  });

  it("does not read the facts file for other questions or over one note", async () => {
    const read = factsFile(JSON.stringify(facts));
    await koAsk("Lumen에 대해서 설명해줘");
    const scoped = await useQueryStore.getState().ask("Lumen 지금 어디까지 했어?", "ko", askCopy(STRINGS.ko),
      { note: { path: "/v/wiki/selected.md", title: "Selected note" } });
    expect(read).not.toHaveBeenCalled();
    expect(scoped?.note).toMatchObject({ title: "Selected note" });
    expect(ipc.captureModelRole).toHaveBeenCalledTimes(2);
  });
});
