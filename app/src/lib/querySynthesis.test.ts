import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc, type ActivitySynthesisReceipt, type AskScope, type LocalSynthesisResult, type ScoredChunk } from "./ipc";
import { log } from "./log";
import { tryLocalSynthesis } from "./querySynthesis";
import { extractWikilinks } from "./askHistory";
import { useVaultStore } from "../stores/vaultStore";
import { queryDateRange } from "./timeQuery";
import { roleFixture } from "./modelRoles.testSupport";

const model = "qwen3.5-4b-q4_k_m";
const hit: ScoredChunk = { page: "wiki/synthetic.md", stem: "synthetic", section: 2,
  text: "Synthetic source evidence.", score: 0.03, similarity: 0.8 };
const result: LocalSynthesisResult = { answer: "Synthetic synthesis. [[wiki/synthetic|synthetic]]",
  model_id: model, used_sources: ["wiki/synthetic.md"],
  answerReceipt: { answerOriginalSpans: 1, automatedAnswerReviewInputRevision: "d".repeat(64) } };
const origin = { vaultPath: "/synthetic", openingToken: "synthetic-opening" };
const roleSnapshot = roleFixture("ask", "builtin-local", model, origin);
const options = { question: "Explain the synthetic evidence", lang: "en" as const,
  hits: [hit], expectedVault: "/synthetic", origin, roleSnapshot, scope: "wiki" as const };
const activityRange = { start: "2026-09-26", end: "2026-10-04" };
const activityReceipt: ActivitySynthesisReceipt = {
  activityPeriod: { ...activityRange, startEpoch: null, endEpoch: null }, scope: "wiki",
  eligibleOriginalSpans: 1, boundedWindows: 1, processedWindows: 1, omittedWindows: 0,
  originalPeriodCounts: { inPeriodSpans: 1, outsidePeriodSpans: 0, uncertainSpans: 0 },
  extractionBatches: 1, proposedClaims: 1, selectedClaims: 1, omittedClaims: 0, answerOriginalSpans: 1,
  answerPeriodCounts: { inPeriodSpans: 1, outsidePeriodSpans: 0, uncertainSpans: 0 },
  claimSourceAndStructureChecked: true, semanticReviewRequired: true, independentVerificationReceipts: 0, resolutionWindow: null,
  automatedClaimReviews: 1, automatedAnswerReviewInputRevision: "a".repeat(64),
  originalInputsIncomplete: false,
};

beforeEach(() => {
  vi.restoreAllMocks();
  useVaultStore.setState({ currentVault: null, adjacency: null, isOpeningVault: false });
  vi.spyOn(ipc, "agentVaultSession").mockResolvedValue(origin);
  vi.spyOn(ipc, "captureModelRole").mockResolvedValue(roleSnapshot);
  vi.spyOn(ipc, "localChatStatus").mockResolvedValue({ model_id: model, state: "ready", bytes: 2_707_513_696 });
  vi.spyOn(ipc, "localSynthesize").mockResolvedValue(result);
  vi.spyOn(ipc, "cancelLocalSynthesis").mockResolvedValue(true);
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
});
afterEach(() => vi.useRealTimers());

describe("ordinary generative failure boundary", () => {
  it.each(["generation_failed", "model_unavailable", "prompt_unavailable", "answer_rejected", "answer_incomplete"])(
    "preserves known native stage failure %s with private activity detail", async code => {
      vi.mocked(ipc.localSynthesize).mockResolvedValue({ ...result, answer: "", fallback_reason: code,
        activity_failure: { code, detail: "PRIVATE-SYNTHETIC-STAGE-DETAIL" } });
      const rejected = await tryLocalSynthesis(options).catch(error => error as Error);
      expect(rejected).toMatchObject({ name: "LocalSynthesisError", code });
      expect(String(rejected)).not.toContain("PRIVATE-SYNTHETIC-STAGE-DETAIL");
    },
  );

  it("keeps unknown native stage codes and details private", async () => {
    vi.mocked(ipc.localSynthesize).mockResolvedValue({ ...result, answer: "", fallback_reason: "PRIVATE-SYNTHETIC-CODE",
      activity_failure: { code: "PRIVATE-SYNTHETIC-CODE", detail: "PRIVATE-SYNTHETIC-STAGE-DETAIL" } });
    const rejected = await tryLocalSynthesis(options).catch(error => error as Error);
    expect(rejected).toMatchObject({ name: "LocalSynthesisError", code: "response_rejected" });
    expect(String(rejected)).not.toContain("PRIVATE-SYNTHETIC");
  });

  it("requests the shared ordinary reviewed draft budget", async () => {
    await expect(tryLocalSynthesis(options)).resolves.toEqual(result);
    expect(ipc.localSynthesize).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 768 }));
  });

  it("reserves null quote permission for explicit extractive selection without generation", async () => {
    await expect(tryLocalSynthesis({ ...options,
      roleSnapshot: roleFixture("ask", "builtin-local", "extractive-retrieval", origin) })).resolves.toBeNull();
    expect(ipc.localChatStatus).not.toHaveBeenCalled();
    expect(ipc.localSynthesize).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    { answerOriginalSpans: 0, automatedAnswerReviewInputRevision: "d".repeat(64) },
    { answerOriginalSpans: 1.5, automatedAnswerReviewInputRevision: "d".repeat(64) },
    { answerOriginalSpans: 1, automatedAnswerReviewInputRevision: "D".repeat(64) },
    { answerOriginalSpans: 1, automatedAnswerReviewInputRevision: "caller-claimed-review" },
  ])("rejects missing or malformed ordinary native review transport: %j", async answerReceipt => {
    vi.mocked(ipc.localSynthesize).mockResolvedValue({ ...result, answerReceipt });
    await expect(tryLocalSynthesis(options)).rejects.toMatchObject({
      name: "LocalSynthesisError", code: "response_rejected",
    });
  });

  it("does not reinterpret an unsupported selected generator as explicit quote mode", async () => {
    const selected = "unsupported-selected-local-model";
    await expect(tryLocalSynthesis({ ...options,
      roleSnapshot: roleFixture("ask", "builtin-local", selected, origin) })).rejects.toMatchObject({
      name: "LocalSynthesisError", code: "model_unavailable",
    });
    expect(ipc.localChatStatus).not.toHaveBeenCalled();
    expect(ipc.localSynthesize).not.toHaveBeenCalled();
  });

  it.each([
    { model_id: model, state: "missing" as const, bytes: 0 },
    { model_id: model, state: "error" as const, bytes: 0 },
    { model_id: model, state: "ready" as const, bytes: 0 },
    { model_id: "other-model", state: "ready" as const, bytes: 100 },
  ])("rejects unavailable selected generation instead of returning quote permission: %j", async status => {
    vi.mocked(ipc.localChatStatus).mockResolvedValue(status);
    await expect(tryLocalSynthesis(options)).rejects.toMatchObject({
      name: "LocalSynthesisError", code: "model_unavailable",
    });
    expect(ipc.localSynthesize).not.toHaveBeenCalled();
  });

  it.each(["status", "synthesis"] as const)("rejects %s transport failure without exposing private detail", async phase => {
    const failure = new Error("PRIVATE-SYNTHETIC-GENERATION-DETAIL");
    if (phase === "status") vi.mocked(ipc.localChatStatus).mockRejectedValue(failure);
    else vi.mocked(ipc.localSynthesize).mockRejectedValue(failure);
    const rejected = await tryLocalSynthesis(options).catch(error => error as Error);
    expect(rejected).toMatchObject({ name: "LocalSynthesisError", code: `${phase}_failed` });
    expect(String(rejected)).not.toContain("PRIVATE-SYNTHETIC-GENERATION-DETAIL");
  });

  it.each(["model_unavailable", "prompt_unavailable", "generation_failed", "answer_rejected",
    "answer_incomplete", "time_budget", "PRIVATE-SYNTHETIC-REASON"])(
    "rejects native %s without returning quote permission", async reason => {
      vi.mocked(ipc.localSynthesize).mockResolvedValue({ ...result, answer: "", fallback_reason: reason });
      const rejected = await tryLocalSynthesis(options).catch(error => error as Error);
      expect(rejected).toMatchObject({ name: "LocalSynthesisError",
        code: reason === "PRIVATE-SYNTHETIC-REASON" ? "response_rejected" : reason });
      expect(String(rejected)).not.toContain("PRIVATE-SYNTHETIC-REASON");
    },
  );

  it.each([
    ["missing reply", null],
    ["empty answer", { ...result, answer: "" }],
    ["non-text answer", { ...result, answer: 7 }],
    ["missing sources", { ...result, used_sources: [] }],
    ["non-array sources", { ...result, used_sources: "wiki/synthetic.md" }],
    ["wrong model", { ...result, model_id: "unexpected-model" }],
    ["outside source", { ...result, answer: "Outside. [[wiki/outside]]", used_sources: ["wiki/outside.md"] }],
    ["uncited source", { ...result, answer: "Uncited synthetic prose." }],
  ])("rejects malformed or unsupported %s without granting quote fallback", async (_label, reply) => {
    // Malformed native transport fixtures exercise runtime validation, not a model.
    vi.mocked(ipc.localSynthesize).mockResolvedValue(reply as unknown as LocalSynthesisResult);
    await expect(tryLocalSynthesis(options)).rejects.toMatchObject({
      name: "LocalSynthesisError", code: "response_rejected",
    });
  });
});

describe("native later-state evidence", () => {
  const capturedQueryEpoch = Math.floor(new Date("2026-10-07T12:00:00Z").getTime() / 1000);
  const resolution = { mode: "current_state" as const, asOfEpoch: capturedQueryEpoch, capturedQueryEpoch };
  const source = { citationPage: "wiki/synthetic-later.md", citationRevision: "a".repeat(64),
    title: "Synthetic later decision", stem: "synthetic-later", origin, scope: "wiki" as AskScope,
    lineage: [{ sourcePath: "raw/synthetic-later.md", sourceRevision: "b".repeat(64),
      spans: [{ id: "later-1", start: 0, end: 24, sha256: "c".repeat(64), speaker: "user",
        turnTime: "2026-10-06T12:00:00Z", recordTime: null, sourcePhase: null }] }] };
  const receipt = { ...activityReceipt,
    eligibleOriginalSpans: 2, boundedWindows: 2, processedWindows: 2, answerOriginalSpans: 2,
    originalPeriodCounts: { inPeriodSpans: 1, outsidePeriodSpans: 1, uncertainSpans: 0 },
    answerPeriodCounts: { inPeriodSpans: 1, outsidePeriodSpans: 1, uncertainSpans: 0 },
    activityPeriod: { ...activityReceipt.activityPeriod, ...queryDateRange(activityRange) },
    resolutionWindow: { ...resolution, startEpoch: queryDateRange(activityRange).startEpoch,
      endEpoch: capturedQueryEpoch + 1 },
    resolutionCoverage: { candidateChunks: 1, scannedPages: 1, admittedPages: 1, originalSpans: 1,
      processedWindows: 1, omittedWindows: 0, excludedAfterAsOfSpans: 0, undatedSpans: 0,
      readBytes: 24, incomplete: false, issues: [] as { citationPage: string; code: string }[] },
    additionalSources: [source] };
  const captured = { ...options, origin, activityOverview: true, range: activityRange, resolution };

  it("passes the captured later-state cutoff without silently dropping it", async () => {
    vi.mocked(ipc.localSynthesize).mockResolvedValue({ ...result, activity_receipt: activityReceipt });
    await tryLocalSynthesis(captured).catch(() => undefined);
    expect(ipc.localSynthesize).toHaveBeenCalledWith(expect.objectContaining({ resolution }));
  });

  it("accepts and labels a native-bound later source outside the initial hits", async () => {
    vi.mocked(ipc.localSynthesize).mockResolvedValue({ ...result,
      answer: "The synthetic request was later withdrawn. [[wiki/synthetic-later]]",
      used_sources: [source.citationPage], activity_receipt: receipt } as unknown as LocalSynthesisResult);
    await expect(tryLocalSynthesis(captured)).resolves.toMatchObject({
      answer: "The synthetic request was later withdrawn. [[wiki/synthetic-later|Synthetic later decision]]",
      used_sources: [source.citationPage],
    });
  });

  it("rejects an answer that omits the requested later-state receipt", async () => {
    vi.mocked(ipc.localSynthesize).mockResolvedValue({ ...result, activity_receipt: activityReceipt });
    await expect(tryLocalSynthesis(captured)).rejects.toMatchObject({
      name: "ActivitySynthesisError", code: "activity_receipt_invalid",
    });
  });

  it.each(["opening", "scope", "path", "revision", "span", "cutoff", "coverage", "issue"])(
    "rejects forged later-source %s declarations without expanding citations", async field => {
      const invalid = structuredClone(receipt);
      if (field === "opening") invalid.additionalSources[0].origin.openingToken = "other-opening";
      if (field === "scope") invalid.additionalSources[0].scope = "sessions";
      if (field === "path") invalid.additionalSources[0].citationPage = "../outside.md";
      if (field === "revision") invalid.additionalSources[0].lineage[0].sourceRevision = "caller-hash";
      if (field === "span") invalid.additionalSources[0].lineage[0].spans[0].id = "injected|citation";
      if (field === "cutoff") invalid.resolutionWindow.asOfEpoch++;
      if (field === "coverage") invalid.resolutionCoverage.processedWindows = 0;
      if (field === "issue") {
        invalid.resolutionCoverage.incomplete = true;
        invalid.resolutionCoverage.issues = [{ citationPage: "sessions/out-of-scope.md", code: "source_unavailable" }];
      }
      vi.mocked(ipc.localSynthesize).mockResolvedValue({ ...result,
        answer: "Synthetic later decision. [[wiki/synthetic-later]]", used_sources: [source.citationPage],
        activity_receipt: invalid } as unknown as LocalSynthesisResult);
      await expect(tryLocalSynthesis(captured)).rejects.toMatchObject({
        name: "ActivitySynthesisError", code: "activity_receipt_invalid",
      });
    },
  );

  it("keeps explicit path restrictions when a later source has a valid native origin", async () => {
    vi.mocked(ipc.localSynthesize).mockResolvedValue({ ...result,
      answer: "Synthetic later decision. [[wiki/synthetic-later]]", used_sources: [source.citationPage],
      activity_receipt: receipt } as unknown as LocalSynthesisResult);
    await expect(tryLocalSynthesis({ ...captured, paths: [hit.page] })).rejects.toMatchObject({
      name: "ActivitySynthesisError", code: "activity_receipt_invalid",
    });
  });

  it("does not authorize a citation absent from the native later-source declaration", async () => {
    vi.mocked(ipc.localSynthesize).mockResolvedValue({ ...result,
      answer: "Synthetic invented source. [[wiki/undeclared]]", used_sources: ["wiki/undeclared.md"],
      activity_receipt: receipt } as unknown as LocalSynthesisResult);
    await expect(tryLocalSynthesis(captured)).rejects.toMatchObject({
      name: "ActivitySynthesisError", code: "response_rejected",
    });
  });

  it("counts token windows separately from one longer original span", async () => {
    const windowed = structuredClone(receipt);
    windowed.boundedWindows = windowed.processedWindows = windowed.answerOriginalSpans = 3;
    windowed.answerPeriodCounts.outsidePeriodSpans = 2;
    windowed.resolutionCoverage.processedWindows = 2;
    windowed.additionalSources[0].lineage[0].spans.push({
      ...source.lineage[0].spans[0], id: "later-2", start: 24, end: 48,
    });
    vi.mocked(ipc.localSynthesize).mockResolvedValue({ ...result,
      answer: "Synthetic later decision. [[wiki/synthetic-later]]", used_sources: [source.citationPage],
      activity_receipt: windowed } as unknown as LocalSynthesisResult);
    await expect(tryLocalSynthesis(captured)).resolves.toMatchObject({ used_sources: [source.citationPage] });
  });

  it("accepts native later lineage retained after extraction omission for final review", async () => {
    const retained = structuredClone(receipt);
    retained.boundedWindows = retained.answerOriginalSpans = 3;
    retained.omittedWindows = 1;
    retained.answerPeriodCounts.outsidePeriodSpans = 2;
    retained.resolutionCoverage.omittedWindows = 1;
    retained.resolutionCoverage.incomplete = true;
    retained.resolutionCoverage.readBytes = 48;
    retained.additionalSources[0].lineage[0].spans.push({
      ...source.lineage[0].spans[0], id: "later-2", start: 24, end: 48,
    });
    vi.mocked(ipc.localSynthesize).mockResolvedValue({ ...result,
      answer: "The synthetic request was later withdrawn. [[wiki/synthetic-later]]",
      used_sources: [source.citationPage], activity_receipt: retained } as unknown as LocalSynthesisResult);
    await expect(tryLocalSynthesis(captured)).resolves.toMatchObject({
      answer: "The synthetic request was later withdrawn. [[wiki/synthetic-later|Synthetic later decision]]",
      used_sources: [source.citationPage], activity_receipt: retained,
    });
  });
});

describe("tryLocalSynthesis", () => {
  it.each(["review_rejected", "review_uncertain", "review_missing", "review_invalid",
    "review_not_fit", "review_unavailable", "review_stopped"])(
    "preserves native %s without accepting prose or falling back to quotes", async code => {
      for (const activityOverview of [false, true]) {
        vi.mocked(ipc.localSynthesize).mockResolvedValue({ ...result,
          fallback_reason: code,
          activity_failure: { code, detail: "PRIVATE-SYNTHETIC-REVIEW-DETAIL" } });
        const fallback = vi.fn();
        const failure = await tryLocalSynthesis({ ...options, activityOverview,
          ...(activityOverview ? { range: activityRange } : {}), onFallback: fallback }).catch(error => error);
        expect(failure).toMatchObject({ name: "ActivitySynthesisError", code });
        expect(String(failure)).not.toContain("PRIVATE-SYNTHETIC-REVIEW-DETAIL");
        expect(fallback).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["automatedClaimReviews", "automatedAnswerReviewInputRevision"])(
    "rejects an activity success without its native %s", async field => {
      const receipt = { ...activityReceipt } as unknown as Record<string, unknown>;
      delete receipt[field];
      vi.mocked(ipc.localSynthesize).mockResolvedValue({ ...result,
        activity_receipt: receipt as unknown as ActivitySynthesisReceipt });
      await expect(tryLocalSynthesis({ ...options, activityOverview: true, range: activityRange }))
        .rejects.toMatchObject({ name: "ActivitySynthesisError", code: "activity_receipt_invalid" });
    },
  );

  it("rejects activity synthesis without a native opening before model admission", async () => {
    await expect(tryLocalSynthesis({ ...options, origin: undefined, activityOverview: true,
      range: { start: "2026-10-01", end: "2026-10-04" } })).rejects.toMatchObject({
      name: "QueryAuthorizationError",
    });
    expect(ipc.localChatStatus).not.toHaveBeenCalled();
    expect(ipc.localSynthesize).not.toHaveBeenCalled();
  });

  it("preserves typed claim failure without publishing quotes or private native detail", async () => {
    vi.mocked(ipc.localSynthesize).mockResolvedValue({ ...result, answer: "", used_sources: [],
      fallback_reason: "activity_insufficient_evidence",
      activity_failure: { code: "activity_insufficient_evidence", detail: "PRIVATE-SYNTHETIC-CONTENT" } } as LocalSynthesisResult);
    const captured = { ...options, activityOverview: true, origin: { vaultPath: "/synthetic", openingToken: "synthetic-opening" },
      range: { start: "2026-10-01", end: "2026-10-04" } };
    const failure = await tryLocalSynthesis(captured).catch(error => error as Error);
    expect(failure).toMatchObject({ name: "ActivitySynthesisError", code: "activity_insufficient_evidence" });
    expect(String(failure)).not.toContain("PRIVATE-SYNTHETIC-CONTENT");
  });

  it("does not accept activity prose without app-computed claim coverage", async () => {
    const captured = { ...options, activityOverview: true, origin: { vaultPath: "/synthetic", openingToken: "synthetic-opening" },
      range: { start: "2026-10-01", end: "2026-10-04" } };
    await expect(tryLocalSynthesis(captured)).rejects.toMatchObject({ name: "ActivitySynthesisError", code: "activity_receipt_invalid" });
  });

  it("only sends retrieved evidence and the expected vault under a bounded request", async () => {
    const thinking = vi.fn();
    const fallback = vi.fn();
    await expect(tryLocalSynthesis({ ...options, onThinking: thinking, onFallback: fallback })).resolves.toEqual(result);
    expect(ipc.localSynthesize).toHaveBeenCalledWith({ requestId: expect.any(String),
      expectedVault: "/synthetic", origin, roleSnapshot, question: options.question, lang: "en", scope: "wiki", maxTokens: 768, modelId: model,
      hits: [{ page: hit.page, stem: hit.stem, section: hit.section, text: hit.text }] });
    expect(thinking).toHaveBeenCalledWith([]);
    expect(fallback).not.toHaveBeenCalled();
    expect(ipc.agentVaultSession).not.toHaveBeenCalled();
    expect(ipc.captureModelRole).not.toHaveBeenCalled();
  });

  it("passes a question-only follow-up topic separately from the original question", async () => {
    await expect(tryLocalSynthesis({ ...options, question: "그건 왜?", previousQuestion: options.question })).resolves.toEqual(result);
    expect(ipc.localSynthesize).toHaveBeenCalledWith(expect.objectContaining({
      question: "그건 왜?", previousQuestion: options.question, expectedVault: options.expectedVault, scope: options.scope,
    }));
  });

  it("sends date-grounded activity passages with their task and period without inventing similarity scores", async () => {
    const range = activityRange;
    const source = { page: hit.page, stem: hit.stem, section: hit.section, text: hit.text };
    const native = { ...result, activity_receipt: activityReceipt };
    vi.mocked(ipc.localSynthesize).mockResolvedValue(native);
    await expect(tryLocalSynthesis({ ...options, question: "내가 최근에 한 일들에 대해서 정리해줘", lang: "ko", hits: [source], range,
      origin, activityOverview: true })).resolves.toEqual(native);
    expect(ipc.localSynthesize).toHaveBeenCalledWith(expect.objectContaining({
      question: "내가 최근에 한 일들에 대해서 정리해줘", origin, activityOverview: true, range, scope: "wiki", hits: [source], maxTokens: 768,
    }));
  });

  it("accepts full native answer context including an unprocessed contrary window", async () => {
    const receipt = { ...activityReceipt, eligibleOriginalSpans: 3, boundedWindows: 3,
      processedWindows: 2, omittedWindows: 1, answerOriginalSpans: 3,
      originalPeriodCounts: { inPeriodSpans: 1, outsidePeriodSpans: 1, uncertainSpans: 1 },
      answerPeriodCounts: { inPeriodSpans: 1, outsidePeriodSpans: 1, uncertainSpans: 1 } };
    const native = { ...result, activity_receipt: receipt };
    vi.mocked(ipc.localSynthesize).mockResolvedValue(native);
    await expect(tryLocalSynthesis({ ...options, origin, activityOverview: true, range: activityRange }))
      .resolves.toEqual(native);
  });

  it.each(["originalPeriodCounts", "answerPeriodCounts"] as const)(
    "accepts uncertain or outside record dates without inventing an in-period event requirement: %s", async field => {
      for (const value of [{ inPeriodSpans: 0, outsidePeriodSpans: 0, uncertainSpans: 1 },
        { inPeriodSpans: 0, outsidePeriodSpans: 1, uncertainSpans: 0 }]) {
        const receipt = { ...activityReceipt, [field]: value };
        const native = { ...result, activity_receipt: receipt };
        vi.mocked(ipc.localSynthesize).mockResolvedValue(native);
        await expect(tryLocalSynthesis({ ...options, origin, activityOverview: true, range: activityRange }))
          .resolves.toEqual(native);
      }
    },
  );

  it.each(["originalPeriodCounts", "answerPeriodCounts"] as const)(
    "rejects missing, malformed or inconsistent native period counts: %s", async field => {
      const invalid = [undefined, null, [],
        { inPeriodSpans: -1, outsidePeriodSpans: 2, uncertainSpans: 0 },
        { inPeriodSpans: 0.5, outsidePeriodSpans: 0.5, uncertainSpans: 0 },
        { inPeriodSpans: Number.MAX_SAFE_INTEGER + 1, outsidePeriodSpans: 0, uncertainSpans: 0 },
        { inPeriodSpans: 0, outsidePeriodSpans: -1, uncertainSpans: 2 },
        { inPeriodSpans: 0, outsidePeriodSpans: 0, uncertainSpans: 1.5 },
        { inPeriodSpans: 1, outsidePeriodSpans: 0 },
        { inPeriodSpans: 0, outsidePeriodSpans: 0, uncertainSpans: 0 },
        { inPeriodSpans: 1, outsidePeriodSpans: 1, uncertainSpans: 0 }];
      for (const value of invalid) {
        const receipt = { ...activityReceipt, [field]: value } as unknown as ActivitySynthesisReceipt;
        vi.mocked(ipc.localSynthesize).mockResolvedValue({ ...result, activity_receipt: receipt });
        await expect(tryLocalSynthesis({ ...options, origin, activityOverview: true, range: activityRange }))
          .rejects.toMatchObject({ name: "ActivitySynthesisError", code: "activity_receipt_invalid" });
      }
    },
  );

  it.each(["overflow", "unsafe", "answer_exceeds_windows"] as const)(
    "rejects native context outside the bounded source packet: %s", async field => {
      const receipt = structuredClone(activityReceipt);
      if (field === "answer_exceeds_windows") {
        receipt.answerOriginalSpans = 2;
        receipt.answerPeriodCounts.inPeriodSpans = 2;
      } else {
        const windows = field === "overflow" ? 513 : Number.MAX_SAFE_INTEGER + 1;
        receipt.boundedWindows = receipt.processedWindows = receipt.answerOriginalSpans = windows;
        receipt.answerPeriodCounts.inPeriodSpans = windows;
      }
      vi.mocked(ipc.localSynthesize).mockResolvedValue({ ...result, activity_receipt: receipt });
      await expect(tryLocalSynthesis({ ...options, origin, activityOverview: true, range: activityRange }))
        .rejects.toMatchObject({ name: "ActivitySynthesisError", code: "activity_receipt_invalid" });
    },
  );

  it.each([
    { ...activityReceipt, scope: "sessions" as const },
    { ...activityReceipt, activityPeriod: { ...activityReceipt.activityPeriod, end: "2026-10-03" } },
    { ...activityReceipt, omittedWindows: 2 },
    { ...activityReceipt, proposedClaims: 2 },
    { ...activityReceipt, semanticReviewRequired: false },
    { ...activityReceipt, independentVerificationReceipts: 1 },
    { ...activityReceipt, automatedClaimReviews: 0 },
    { ...activityReceipt, automatedClaimReviews: 2 },
    { ...activityReceipt, automatedAnswerReviewInputRevision: "caller-asserted-review" },
  ])("rejects incompatible native activity coverage without semantic acceptance: %j", async receipt => {
    vi.mocked(ipc.localSynthesize).mockResolvedValue({ ...result, activity_receipt: receipt });
    await expect(tryLocalSynthesis({ ...options, origin, activityOverview: true, range: activityRange }))
      .rejects.toMatchObject({ name: "ActivitySynthesisError", code: "activity_receipt_invalid" });
  });

  it("shows a readable opaque-source alias without changing its verified path", async () => {
    const stem = "source-codex-12345678-0000-4000-8000-000000000000";
    const opaqueHit = { ...hit, page: `wiki/${stem}.md`, stem };
    const native = { ...result, answer: `합성 계획입니다.\n\n[[wiki/${stem}|${stem}]]`,
      used_sources: [opaqueHit.page] };
    vi.mocked(ipc.localSynthesize).mockResolvedValue(native);
    const response = await tryLocalSynthesis({ ...options, hits: [opaqueHit], lang: "ko" });
    expect(response).toEqual({ ...native,
      answer: `합성 계획입니다.\n\n[[wiki/${stem}|Codex · 12345678]]` });
    expect(extractWikilinks(response!.answer)).toEqual(extractWikilinks(native.answer));
  });

  it("matches labels by full path and keeps repeated citation targets intact", async () => {
    const first = { ...hit, page: "wiki/first/synthetic.md", stem: "First synthetic note" };
    const second = { ...hit, page: "wiki/second/synthetic.md", stem: "Second synthetic note" };
    const native = { ...result,
      answer: "Synthetic evidence. [[wiki/first/synthetic|synthetic]] [[wiki/second/synthetic.md|synthetic]] [[wiki/first/synthetic|synthetic]]",
      used_sources: [first.page, second.page] };
    vi.mocked(ipc.localSynthesize).mockResolvedValue(native);
    const response = await tryLocalSynthesis({ ...options, hits: [first, second] });
    expect(response).toEqual({ ...native,
      answer: "Synthetic evidence. [[wiki/first/synthetic|First synthetic note]] [[wiki/second/synthetic.md|Second synthetic note]] [[wiki/first/synthetic|First synthetic note]]" });
    expect(extractWikilinks(response!.answer)).toEqual(extractWikilinks(native.answer));
  });

  it("uses the organized session title from the same open vault for a citation", async () => {
    const stem = "session-codex-1234567890abcdef";
    const source = { ...hit, page: `wiki/sources/${stem}.md`, stem };
    const native = { ...result, answer: `Synthetic evidence. [[wiki/sources/${stem}|${stem}]]`,
      used_sources: [source.page] };
    vi.mocked(ipc.localSynthesize).mockResolvedValue(native);
    useVaultStore.setState({ currentVault: { path: options.expectedVault, name: "Synthetic vault" },
      adjacency: { forward: {}, backward: {}, unresolved: {}, tags: {},
        meta: { [`${options.expectedVault}/${source.page}`]: { title: "Synthetic reader and export" } } } });
    const response = await tryLocalSynthesis({ ...options, hits: [source] });
    expect(response?.answer).toBe(`Synthetic evidence. [[wiki/sources/${stem}|Synthetic reader and export]]`);
    expect(extractWikilinks(response!.answer)).toEqual(extractWikilinks(native.answer));
  });

  it.each([false, true])("does not borrow a title during a vault change (opening: %s)", async isOpeningVault => {
    useVaultStore.setState({ currentVault: { path: isOpeningVault ? options.expectedVault : "/other", name: "Other" },
      isOpeningVault, adjacency: { forward: {}, backward: {}, unresolved: {}, tags: {},
        meta: { [`${options.expectedVault}/${hit.page}`]: { title: "Unrelated title" } } } });
    await expect(tryLocalSynthesis(options)).resolves.toEqual(result);
  });

  it("uses a native activity title as a safe alias without sending it back as evidence", async () => {
    const source = { ...hit, title: "Synthetic [reader]|\n and export" };
    vi.mocked(ipc.localSynthesize).mockResolvedValue({ ...result, activity_receipt: activityReceipt });
    const response = await tryLocalSynthesis({ ...options, hits: [source], origin, range: activityRange, activityOverview: true });
    expect(response?.answer).toBe("Synthetic synthesis. [[wiki/synthetic|Synthetic reader and export]]");
    expect(ipc.localSynthesize).toHaveBeenCalledWith(expect.objectContaining({
      hits: [{ page: hit.page, stem: hit.stem, section: hit.section, text: hit.text }],
    }));
    expect(extractWikilinks(response!.answer)).toEqual(["wiki/synthetic"]);
  });

  it("keeps citation syntax characters out of a retrieved display label", async () => {
    const unsafeLabelHit = { ...hit, stem: "Synthetic [note]|\r\n label" };
    const response = await tryLocalSynthesis({ ...options, hits: [unsafeLabelHit] });
    expect(response).toEqual({ ...result,
      answer: "Synthetic synthesis. [[wiki/synthetic|Synthetic note label]]" });
    expect(extractWikilinks(response!.answer)).toEqual(["wiki/synthetic"]);
  });

  it("uses only the explicitly selected lightweight artifact for a local answer", async () => {
    const small = "qwen3.5-2b-q4_k_m";
    vi.mocked(ipc.localChatStatus).mockResolvedValue({ model_id: small, state: "ready", bytes: 1_270_808_032 });
    vi.mocked(ipc.localSynthesize).mockResolvedValue({ ...result, model_id: small });
    const selected = roleFixture("ask", "builtin-local", small, origin);
    await expect(tryLocalSynthesis({ ...options, modelId: small, roleSnapshot: selected })).resolves.toEqual({ ...result, model_id: small });
    expect(ipc.localChatStatus).toHaveBeenCalledWith(small);
    expect(ipc.localSynthesize).toHaveBeenCalledWith(expect.objectContaining({ modelId: small, roleSnapshot: selected, maxTokens: 768 }));
  });

  it("does not replace a missing selected artifact with another installed model", async () => {
    const small = "qwen3.5-2b-q4_k_m";
    await expect(tryLocalSynthesis({ ...options, modelId: small,
      roleSnapshot: roleFixture("ask", "builtin-local", small, origin) })).rejects.toMatchObject({
      name: "LocalSynthesisError", code: "model_unavailable",
    });
    expect(ipc.localSynthesize).not.toHaveBeenCalled();
    vi.mocked(ipc.localChatStatus).mockClear();
    await expect(tryLocalSynthesis({ ...options, modelId: "unverified-local-model" })).rejects.toMatchObject({
      name: "QueryAuthorizationError",
    });
    expect(ipc.localChatStatus).not.toHaveBeenCalled();
  });

  it("does not check or load a model when evidence is absent or blank", async () => {
    await expect(tryLocalSynthesis({ ...options, hits: [] })).resolves.toBeNull();
    await expect(tryLocalSynthesis({ ...options, hits: [{ ...hit, text: " " }] })).resolves.toBeNull();
    expect(ipc.localChatStatus).not.toHaveBeenCalled();
    expect(ipc.localSynthesize).not.toHaveBeenCalled();
  });

  it.each([
    { model_id: model, state: "missing" as const, bytes: 0 },
    { model_id: model, state: "ready" as const, bytes: 0 },
    { model_id: "other-model", state: "ready" as const, bytes: 100 },
  ])("rejects selected generation when status is not usable: %j", async status => {
    vi.mocked(ipc.localChatStatus).mockResolvedValue(status);
    const thinking = vi.fn();
    const fallback = vi.fn();
    await expect(tryLocalSynthesis({ ...options, onThinking: thinking, onFallback: fallback })).rejects.toMatchObject({
      name: "LocalSynthesisError", code: "model_unavailable",
    });
    expect(ipc.localSynthesize).not.toHaveBeenCalled();
    expect(thinking).not.toHaveBeenCalled();
    expect(fallback.mock.calls).toEqual([["model_unavailable"]]);
  });

  it("waits beyond the former status deadline and starts inference once readiness is verified", async () => {
    vi.useFakeTimers();
    let release!: (status: Awaited<ReturnType<typeof ipc.localChatStatus>>) => void;
    vi.mocked(ipc.localChatStatus).mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const thinking = vi.fn();
    const fallback = vi.fn();
    const pending = tryLocalSynthesis({ ...options, onThinking: thinking, onFallback: fallback });
    await vi.advanceTimersByTimeAsync(60000);
    expect(thinking).not.toHaveBeenCalled();
    expect(ipc.localSynthesize).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
    release({ model_id: model, state: "ready", bytes: 100 });
    await expect(pending).resolves.toEqual(result);
    expect(ipc.localChatStatus).toHaveBeenCalledTimes(1);
    expect(ipc.localSynthesize).toHaveBeenCalledTimes(1);
    expect(thinking).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
  });

  it.each(["status", "synthesis"])("reports a %s failure without logging its private payload", async phase => {
    const failure = new Error("PRIVATE-SYNTHETIC-CONTENT");
    if (phase === "status") vi.mocked(ipc.localChatStatus).mockRejectedValue(failure);
    else vi.mocked(ipc.localSynthesize).mockRejectedValue(failure);
    const fallback = vi.fn();
    await expect(tryLocalSynthesis({ ...options, onFallback: fallback })).rejects.toMatchObject({
      name: "LocalSynthesisError", code: `${phase}_failed`,
    });
    expect(log.warn).toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(log.warn).mock.calls)).not.toContain("PRIVATE-SYNTHETIC-CONTENT");
    expect(fallback.mock.calls).toEqual([[`${phase}_failed`]]);
    expect(JSON.stringify(fallback.mock.calls)).not.toContain("PRIVATE-SYNTHETIC-CONTENT");
  });

  it.each([
    ["model_unavailable", "model_unavailable"],
    ["prompt_unavailable", "prompt_unavailable"],
    ["generation_failed", "generation_failed"],
    ["answer_rejected", "answer_rejected"],
    ["answer_incomplete", "answer_incomplete"],
    ["time_budget", "time_budget"],
    ["PRIVATE-SYNTHETIC-REASON", "response_rejected"],
  ])("rejects with only a static failure code for native reason %s", async (reason, expected) => {
    vi.mocked(ipc.localSynthesize).mockResolvedValue({ ...result, answer: "", fallback_reason: reason });
    const fallback = vi.fn();
    await expect(tryLocalSynthesis({ ...options, onFallback: fallback })).rejects.toMatchObject({
      name: "LocalSynthesisError", code: expected,
    });
    expect(fallback.mock.calls).toEqual([[expected]]);
    expect(JSON.stringify(fallback.mock.calls)).not.toContain("PRIVATE-SYNTHETIC-REASON");
  });

  it.each([
    { ...result, answer: "" },
    { ...result, fallback_reason: "insufficient_grounding" },
    { ...result, fallback_reason: "model_unavailable" },
    { ...result, fallback_reason: "context_budget" },
    { ...result, fallback_reason: "answer_validation_failed" },
    { ...result, used_sources: [] },
    { ...result, used_sources: ["wiki/outside.md"] },
    { ...result, answer: "Uncited prose." },
    { ...result, answer: "Wrong source. [[wiki/outside|outside]]" },
    { ...result, model_id: "unexpected-model" },
  ])("rejects an ungrounded or declined response: %j", async response => {
    vi.mocked(ipc.localSynthesize).mockResolvedValue(response);
    const fallback = vi.fn();
    await expect(tryLocalSynthesis({ ...options, onFallback: fallback })).rejects.toMatchObject({
      name: "LocalSynthesisError", code: response.fallback_reason === "model_unavailable" ? "model_unavailable" : "response_rejected",
    });
    expect(fallback.mock.calls).toEqual([[
      response.fallback_reason === "model_unavailable" ? "model_unavailable" : "response_rejected"]]);
  });

  it.each(["source_verification_failed", "source_changed_during_generation"] as const)(
    "preserves %s so the caller cannot publish rejected source quotes", async reason => {
      vi.mocked(ipc.localSynthesize).mockResolvedValue({ answer: "", model_id: model,
        used_sources: [], fallback_reason: reason });
      const fallback = vi.fn();
      await expect(tryLocalSynthesis({ ...options, onFallback: fallback })).rejects.toMatchObject({
        name: "LocalSynthesisSourceError", reason,
      });
      expect(fallback).not.toHaveBeenCalled();
    },
  );

  it("stops a long pending status check without starting inference from its late readiness", async () => {
    vi.useFakeTimers();
    let release!: (status: Awaited<ReturnType<typeof ipc.localChatStatus>>) => void;
    vi.mocked(ipc.localChatStatus).mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const control = new AbortController();
    const fallback = vi.fn();
    const pending = tryLocalSynthesis({ ...options, signal: control.signal, onFallback: fallback });
    await vi.advanceTimersByTimeAsync(60000);
    control.abort();
    await expect(pending).rejects.toThrow("stopped");
    release({ model_id: model, state: "ready", bytes: 100 });
    await Promise.resolve();
    expect(ipc.localSynthesize).not.toHaveBeenCalled();
    expect(ipc.cancelLocalSynthesis).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });

  it("does not accept a claimed used source that the answer never cites", async () => {
    const second = { ...hit, page: "wiki/second.md", stem: "second" };
    vi.mocked(ipc.localSynthesize).mockResolvedValue({ ...result, used_sources: [hit.page, second.page] });
    await expect(tryLocalSynthesis({ ...options, hits: [hit, second] })).rejects.toMatchObject({
      name: "LocalSynthesisError", code: "response_rejected",
    });
  });

  it("cancels the exact in-flight native request and settles before its late result", async () => {
    let release!: (reply: LocalSynthesisResult) => void;
    vi.mocked(ipc.localSynthesize).mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const control = new AbortController();
    const fallback = vi.fn();
    const pending = tryLocalSynthesis({ ...options, signal: control.signal, onFallback: fallback });
    await vi.waitFor(() => expect(ipc.localSynthesize).toHaveBeenCalled());
    control.abort();
    await expect(pending).rejects.toThrow("stopped");
    expect(ipc.cancelLocalSynthesis).toHaveBeenCalledWith(vi.mocked(ipc.localSynthesize).mock.calls[0][0].requestId);
    release(result);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("checks cancellation again if the thinking-stage callback stops the run", async () => {
    const control = new AbortController();
    await expect(tryLocalSynthesis({ ...options, signal: control.signal, onThinking: () => control.abort() })).rejects.toThrow("stopped");
    expect(ipc.localSynthesize).not.toHaveBeenCalled();
  });
});
