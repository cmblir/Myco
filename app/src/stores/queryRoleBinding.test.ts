import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as chat from "../lib/chat";
import { ipc, type ActivitySynthesisReceipt, type AskScope, type LocalSynthesisRequest, type MycoSettings, type ScoredChunk } from "../lib/ipc";
import { STRINGS } from "../lib/i18n";
import { log } from "../lib/log";
import type { RoleSnapshot } from "../lib/modelRoles";
import { roleFixture, roleSettingsFixture, syntheticOrigin } from "../lib/modelRoles.testSupport";
import { BUILTIN_CHAT_MODEL, BUILTIN_EMBED_MODEL } from "../lib/providers";
import { tryLocalSynthesis } from "../lib/querySynthesis";
import { queryDateRange } from "../lib/timeQuery";
import { askCopy, useQueryStore } from "./queryStore";
import { useUIStore } from "./uiStore";
import { useVaultStore } from "./vaultStore";
import { useSettingsStore } from "./settingsStore";

// Synthetic IPC DTOs verify frontend routing and rejection, not native grants
// or semantic acceptance. No real model, provider, filesystem or account runs.
const origin = { ...syntheticOrigin };
const localGrant = roleFixture("ask", "builtin-local", BUILTIN_CHAT_MODEL, origin);
const range = { start: "2026-10-03", end: "2026-10-06" };
const hit: ScoredChunk = { page: "wiki/synthetic-prototype.md", stem: "synthetic-prototype", section: 0,
  text: "The synthetic prototype remains under review.", score: 0.9, similarity: 0.8, exact_match: true };
const localAnswer = "The synthetic prototype is under review. [[wiki/synthetic-prototype|synthetic-prototype]]";
const remoteAnswer = "Synthetic explicitly selected remote answer.";

function settings(legacyProvider: string, grant: RoleSnapshot): MycoSettings {
  const roles = roleSettingsFixture();
  roles.roles.ask = { ...roles.roles.ask, providerId: grant.routeSignature.providerId,
    modelId: grant.routeSignature.modelId,
    selection: grant.routeSignature.providerId === "builtin-local" ? "local-default" : "explicit-external" };
  return { query_provider: legacyProvider, query_model: grant.routeSignature.modelId,
    model_roles: roles, role_authorization_revision: grant.authorizationRevision } as MycoSettings;
}

function receipt(request: LocalSynthesisRequest): ActivitySynthesisReceipt {
  const selectedRange = request.range ?? range;
  const epochs = queryDateRange(selectedRange);
  const resolution = request.resolution;
  return { activityPeriod: { ...selectedRange, startEpoch: resolution ? epochs.startEpoch : null,
    endEpoch: resolution ? epochs.endEpoch : null }, scope: request.scope,
    eligibleOriginalSpans: 1, boundedWindows: 1, processedWindows: 1, omittedWindows: 0,
    originalPeriodCounts: { inPeriodSpans: 1, outsidePeriodSpans: 0, uncertainSpans: 0 },
    extractionBatches: 1, proposedClaims: 1, selectedClaims: 1, omittedClaims: 0, answerOriginalSpans: 1,
    answerPeriodCounts: { inPeriodSpans: 1, outsidePeriodSpans: 0, uncertainSpans: 0 },
    claimSourceAndStructureChecked: true, semanticReviewRequired: true, independentVerificationReceipts: 0,
    automatedClaimReviews: 1, automatedAnswerReviewInputRevision: "a".repeat(64),
    originalInputsIncomplete: false,
    resolutionWindow: resolution ? { ...resolution, startEpoch: epochs.startEpoch, endEpoch: resolution.asOfEpoch + 1 } : null,
    ...(resolution ? { resolutionCoverage: { candidateChunks: 0, scannedPages: 0, admittedPages: 0,
      originalSpans: 0, processedWindows: 0, omittedWindows: 0, excludedAfterAsOfSpans: 0, undatedSpans: 0,
      readBytes: 0, incomplete: false, issues: [] }, additionalSources: [] } : {}) };
}

function ask(question = "Explain the synthetic prototype", scope: AskScope = "wiki") {
  return useQueryStore.getState().ask(question, "en", askCopy(STRINGS.en), { scope });
}

function successfulHistory() {
  return vi.mocked(ipc.askHistoryAppend).mock.calls.map(([, record]) => record)
    .filter(record => record.a.trim() && !record.error && !record.stopped);
}

beforeEach(() => {
  vi.restoreAllMocks();
  useSettingsStore.setState({ settings: null, saving: false, loading: false });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 7, 12));
  useVaultStore.setState({ currentVault: { path: origin.vaultPath, name: "Synthetic vault" },
    adjacency: null, isOpeningVault: false });
  useUIStore.setState({ askScope: "wiki", isAskScopeExplicit: true });
  useQueryStore.getState().clear();
  useQueryStore.setState({ history: [], historyError: null, noteScope: null });
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
  vi.spyOn(ipc, "getSettings").mockResolvedValue(settings("builtin-local", localGrant));
  vi.spyOn(ipc, "agentVaultSession").mockResolvedValue(origin);
  vi.spyOn(ipc, "captureModelRole").mockResolvedValue(localGrant);
  vi.spyOn(ipc, "localChatStatus").mockResolvedValue({ model_id: BUILTIN_CHAT_MODEL, state: "ready", bytes: 100 });
  vi.spyOn(ipc, "localQueryPlan").mockResolvedValue({ ...range, model_id: BUILTIN_CHAT_MODEL });
  vi.spyOn(ipc, "activityRecall").mockResolvedValue({ hits: [hit], indexed_pages: 1, scanned_pages: 1,
    matched_chunks: 1, incomplete: false });
  vi.spyOn(ipc, "localSynthesize").mockImplementation(async request => ({ answer: localAnswer,
    model_id: BUILTIN_CHAT_MODEL, used_sources: [hit.page],
    answerReceipt: { answerOriginalSpans: 1, automatedAnswerReviewInputRevision: "d".repeat(64) },
    ...(request.activityOverview ? { activity_receipt: receipt(request) } : {}) }));
  vi.spyOn(ipc, "cancelLocalSynthesis").mockResolvedValue(true);
  vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({ indexed_pages: 1,
    model: `builtin-local:${BUILTIN_EMBED_MODEL}` } as Awaited<ReturnType<typeof ipc.embeddingsStatus>>);
  vi.spyOn(ipc, "semanticSearch").mockResolvedValue({ hits: [hit], floor: 0.42, below_floor: [] });
  vi.spyOn(ipc, "askHistoryAppend").mockResolvedValue(null);
  vi.spyOn(chat, "complete").mockResolvedValue(remoteAnswer);
});

afterEach(() => {
  useQueryStore.getState().clear();
  vi.useRealTimers();
});

describe("one native-issued Ask selection per question", () => {
  it("follows the local Ask grant despite a legacy external provider value", async () => {
    vi.mocked(ipc.getSettings).mockResolvedValue(settings("openai-api", localGrant));
    const turn = await ask();
    expect(ipc.localSynthesize).toHaveBeenCalledOnce();
    expect(chat.complete).not.toHaveBeenCalled();
    expect(turn).toMatchObject({ a: localAnswer, localModel: BUILTIN_CHAT_MODEL, extractive: false });
    expect(ipc.captureModelRole).toHaveBeenCalledTimes(1);
    expect(ipc.captureModelRole).toHaveBeenCalledWith(origin, "ask", "foreground");
  });

  it("passes the same captured grant and origin to ordinary local synthesis", async () => {
    const turn = await ask();
    expect(turn?.error).toBeUndefined();
    expect(ipc.localSynthesize).toHaveBeenCalledWith(expect.objectContaining({ origin, roleSnapshot: localGrant }));
    expect(ipc.captureModelRole).toHaveBeenCalledTimes(1);
    expect(ipc.captureModelRole).toHaveBeenCalledWith(origin, "ask", "foreground");
  });

  it("passes one grant through undated planning, recall and activity synthesis", async () => {
    const turn = await ask("Summarize my recent work", "all");
    expect(turn?.error).toBeUndefined();
    expect(ipc.localQueryPlan).toHaveBeenCalledWith(expect.objectContaining({ origin, roleSnapshot: localGrant }));
    expect(ipc.activityRecall).toHaveBeenCalledWith(expect.objectContaining({ origin, roleSnapshot: localGrant }));
    expect(ipc.localSynthesize).toHaveBeenCalledWith(expect.objectContaining({ origin, roleSnapshot: localGrant,
      activityOverview: true, range, scope: "all" }));
    expect(ipc.captureModelRole).toHaveBeenCalledTimes(1);
    expect(ipc.captureModelRole).toHaveBeenCalledWith(origin, "ask", "foreground");
    expect(chat.complete).not.toHaveBeenCalled();
  });

  it("follows an explicitly selected remote grant despite a legacy local value", async () => {
    const remote = roleFixture("ask", "openai-api", "synthetic-selected-remote", origin);
    vi.mocked(ipc.getSettings).mockResolvedValue(settings("builtin-local", remote));
    vi.mocked(ipc.captureModelRole).mockResolvedValue(remote);
    const turn = await ask();
    expect(chat.complete).toHaveBeenCalledOnce();
    expect(chat.complete).toHaveBeenCalledWith(expect.objectContaining({ origin, roleSnapshot: remote,
      featureRole: "ask", usage: "foreground" }));
    expect(ipc.localChatStatus).not.toHaveBeenCalled();
    expect(ipc.localQueryPlan).not.toHaveBeenCalled();
    expect(ipc.localSynthesize).not.toHaveBeenCalled();
    expect(ipc.captureModelRole).toHaveBeenCalledTimes(1);
    expect(ipc.captureModelRole).toHaveBeenCalledWith(origin, "ask", "foreground");
    expect(turn?.a).toBe(remoteAnswer);
  });

  it.each(["missing", "other-role", "automatic", "wrong-vault", "wrong-opening"] as const)(
    "rejects %s admission before checking or running a model", async invalid => {
      if (invalid === "missing") vi.mocked(ipc.captureModelRole).mockRejectedValue(new Error("snapshot_stale: synthetic grant missing"));
      else {
        const grant = invalid === "other-role" ? roleFixture("reflect", "builtin-local", BUILTIN_CHAT_MODEL, origin) :
          invalid === "automatic" ? roleFixture("ask", "builtin-local", BUILTIN_CHAT_MODEL, origin, "automatic") :
          roleFixture("ask", "builtin-local", BUILTIN_CHAT_MODEL,
            invalid === "wrong-vault" ? { ...origin, vaultPath: "/synthetic-other" } : { ...origin, openingToken: "synthetic-other-opening" });
        vi.mocked(ipc.captureModelRole).mockResolvedValue(grant);
      }
      const turn = await ask("Summarize my recent work", "all");
      expect(turn?.a).toBe("");
      expect(Boolean(turn?.error || turn?.stopped)).toBe(true);
      expect(ipc.localChatStatus).not.toHaveBeenCalled();
      expect(ipc.localQueryPlan).not.toHaveBeenCalled();
      expect(ipc.activityRecall).not.toHaveBeenCalled();
      expect(ipc.localSynthesize).not.toHaveBeenCalled();
      expect(chat.complete).not.toHaveBeenCalled();
      expect(successfulHistory()).toEqual([]);
    },
  );
});

describe("native Ask revocation is not an ordinary quote fallback", () => {
  it("propagates stale native synthesis rejection instead of returning null", async () => {
    vi.mocked(ipc.localSynthesize).mockRejectedValue(new Error("snapshot_stale: synthetic Ask grant revoked"));
    const options = { question: "Explain the synthetic prototype", lang: "en" as const, hits: [hit],
      expectedVault: origin.vaultPath, origin, scope: "wiki" as const, modelId: BUILTIN_CHAT_MODEL,
      roleSnapshot: localGrant };
    await expect(tryLocalSynthesis(options)).rejects.toBeInstanceOf(Error);
  });

  it("retains a failed turn and never records quotes as successful history", async () => {
    vi.mocked(ipc.localSynthesize).mockRejectedValue(new Error("snapshot_stale: synthetic Ask grant revoked"));
    const turn = await ask();
    expect(ipc.localSynthesize).toHaveBeenCalledOnce();
    expect(turn?.a).toBe("");
    expect(Boolean(turn?.error || turn?.stopped)).toBe(true);
    expect(turn?.extractive).not.toBe(true);
    expect(successfulHistory()).toEqual([]);
  });
});

describe("settings changes cannot accept late Ask results", () => {
  it("rejects admission while a model selection is being saved", async () => {
    useSettingsStore.setState({ settings: settings("builtin-local", localGrant), saving: true });
    const turn = await ask();
    expect(turn).toMatchObject({ a: "", error: STRINGS.en.q_model_selection_changed });
    expect(ipc.captureModelRole).not.toHaveBeenCalled();
    expect(ipc.localChatStatus).not.toHaveBeenCalled();
    expect(chat.complete).not.toHaveBeenCalled();
    expect(successfulHistory()).toEqual([]);
  });

  it("stops an owned local synthesis when a pending settings action starts", async () => {
    let release!: (value: Awaited<ReturnType<typeof ipc.localSynthesize>>) => void;
    vi.mocked(ipc.localSynthesize).mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = ask();
    await vi.waitFor(() => expect(ipc.localSynthesize).toHaveBeenCalledOnce());
    const request = vi.mocked(ipc.localSynthesize).mock.calls[0][0];
    useSettingsStore.setState({ saving: true });
    const turn = await pending;
    expect(turn).toMatchObject({ a: "", stopped: true, error: STRINGS.en.q_model_selection_changed });
    expect(ipc.cancelLocalSynthesis).toHaveBeenCalledWith(request.requestId);
    release({ answer: localAnswer, model_id: BUILTIN_CHAT_MODEL, used_sources: [hit.page],
      answerReceipt: { answerOriginalSpans: 1, automatedAnswerReviewInputRevision: "d".repeat(64) } });
    await Promise.resolve();
    expect(useQueryStore.getState().turns.at(-1)?.a).toBe("");
    expect(successfulHistory()).toEqual([]);
  });

  it("cancels period planning after native authorization revision changes", async () => {
    let release!: (value: Awaited<ReturnType<typeof ipc.localQueryPlan>>) => void;
    vi.mocked(ipc.localQueryPlan).mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = ask("Summarize my recent work", "all");
    await vi.waitFor(() => expect(ipc.localQueryPlan).toHaveBeenCalledOnce());
    const request = vi.mocked(ipc.localQueryPlan).mock.calls[0][0];
    const changedRevision = "d".repeat(64);
    expect(changedRevision).not.toBe(localGrant.authorizationRevision);
    useSettingsStore.setState({ settings: { ...settings("builtin-local", localGrant),
      role_authorization_revision: changedRevision } });
    expect(await pending).toMatchObject({ a: "", stopped: true });
    expect(ipc.cancelLocalSynthesis).toHaveBeenCalledWith(request.requestId);
    release({ ...range, model_id: BUILTIN_CHAT_MODEL });
    await Promise.resolve();
    expect(ipc.activityRecall).not.toHaveBeenCalled();
    expect(successfulHistory()).toEqual([]);
  });

  it("discards a late explicitly selected remote answer after revocation", async () => {
    const remote = roleFixture("ask", "openai-api", "synthetic-selected-remote", origin);
    vi.mocked(ipc.captureModelRole).mockResolvedValue(remote);
    let release!: (answer: string) => void;
    vi.mocked(chat.complete).mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = ask();
    await vi.waitFor(() => expect(chat.complete).toHaveBeenCalledOnce());
    const changedRevision = "d".repeat(64);
    expect(changedRevision).not.toBe(remote.authorizationRevision);
    useSettingsStore.setState({ settings: { ...settings("openai-api", remote),
      role_authorization_revision: changedRevision } });
    expect(await pending).toMatchObject({ a: "", stopped: true });
    expect(vi.mocked(chat.complete).mock.calls[0][0].signal?.aborted).toBe(true);
    release(remoteAnswer);
    await Promise.resolve();
    expect(useQueryStore.getState().turns.at(-1)?.a).toBe("");
    expect(successfulHistory()).toEqual([]);
  });

  it("keeps a matching settings hydration from revoking the admitted question", async () => {
    let release!: (value: Awaited<ReturnType<typeof ipc.localSynthesize>>) => void;
    vi.mocked(ipc.localSynthesize).mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = ask();
    await vi.waitFor(() => expect(ipc.localSynthesize).toHaveBeenCalledOnce());
    useSettingsStore.setState({ settings: settings("builtin-local", localGrant), loading: false });
    release({ answer: localAnswer, model_id: BUILTIN_CHAT_MODEL, used_sources: [hit.page],
      answerReceipt: { answerOriginalSpans: 1, automatedAnswerReviewInputRevision: "d".repeat(64) } });
    expect(await pending).toMatchObject({ a: localAnswer, extractive: false });
    expect(ipc.cancelLocalSynthesis).not.toHaveBeenCalled();
  });
});
