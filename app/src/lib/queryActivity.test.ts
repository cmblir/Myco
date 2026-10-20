import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc, type ActivityRecallResult, type LocalQueryPlan } from "./ipc";
import { isNextWorkOverview, isUndatedActivityOverview, retrieveActivity } from "./queryActivity";
import { roleFixture } from "./modelRoles.testSupport";

const modelId = "qwen3.5-4b-q4_k_m";
const range = { start: "2026-09-21", end: "2026-10-07" };
const plan: LocalQueryPlan = { ...range, model_id: modelId };
const evidence: ActivityRecallResult = {
  hits: [{ page: "sessions/synthetic.md", stem: "Synthetic session", section: 1,
    text: "Synthetic completed work recorded on 2026-10-06." }],
  indexed_pages: 18, scanned_pages: 18, matched_chunks: 1, incomplete: false,
};
const origin = { vaultPath: "/synthetic", openingToken: "synthetic-opening" };
const roleSnapshot = roleFixture("ask", "builtin-local", modelId, origin);
const options = { question: "내가 최근에 한 일들에 대해서 정리해줘", lang: "ko" as const,
  modelId, expectedVault: "/synthetic", origin, roleSnapshot, scope: "all" as const };

beforeEach(() => {
  vi.restoreAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 7, 12));
  vi.spyOn(ipc, "agentVaultSession").mockResolvedValue(origin);
  vi.spyOn(ipc, "captureModelRole").mockResolvedValue(roleSnapshot);
  vi.spyOn(ipc, "localChatStatus").mockResolvedValue({ model_id: modelId, state: "ready", bytes: 100 });
  vi.spyOn(ipc, "localQueryPlan").mockResolvedValue(plan);
  vi.spyOn(ipc, "activityRecall").mockResolvedValue(evidence);
  vi.spyOn(ipc, "cancelLocalSynthesis").mockResolvedValue(true);
});
afterEach(() => vi.useRealTimers());

describe("isUndatedActivityOverview", () => {
  it.each([
    "내가 최근에 한 일들에 대해서 정리해줘", "최근 내가 한 일을 정리해줘",
    "요즘 한 일들에 대해 알려줘", "최근에 뭐했지?", "우리가 요즘 한 일을 보여줘",
  ])("routes the topic-free Korean overview %s", question => {
    expect(isUndatedActivityOverview(question, "ko")).toBe(true);
  });

  it.each(["What did I do recently?", "What have we done lately?", "Summarize my recent work"])(
    "routes the topic-free English overview %s", question => {
      expect(isUndatedActivityOverview(question, "en")).toBe(true);
    },
  );

  it.each([
    "내가 어제 한 일들에 대해서 정리해줘", "최근 일주일동안 한일", "2026-10-06 한 일",
    "내가 최근에 한 일 중 임베딩 관련만 보여줘", "최근 트랜스포머 연구 동향",
    "내가 최근에 한 일들에 대해서 RAG 위주로 알려줘", '"최근에 한 일"이라는 문자열을 검색해줘',
    "최근 수정한 파일", "최근 git commit history", "최근 할 일 정리해줘", "한 일을 정리해줘",
  ])("keeps dated, literal, qualified and metadata routes for %s", question => {
    expect(isUndatedActivityOverview(question, "ko")).toBe(false);
  });

  it.each(["What did I do recently about embeddings?", "What did I do last week?",
    'Search for "what did I do recently"', "Summarize recent file changes", "recent git history"])(
    "does not erase the subject or explicit date in %s", question => {
      expect(isUndatedActivityOverview(question, "en")).toBe(false);
    },
  );
});

describe("isNextWorkOverview", () => {
  it.each(["내가 앞으로 어떤 작업을 하는게 좋을까?", "다음에 어떤 작업부터 하면 좋을까요?",
    "내가 어떤 것들을 하면 좋을까? 앞으로", "What should I work on next?", "Which task should I do first?",
    "次にどんな作業をすればいいですか？"])("reviews work history for %s", question => {
    expect(isNextWorkOverview(question)).toBe(true);
  });

  it.each(["내가 앞으로 하기로 한 작업은 무엇이었어?", '"내가 앞으로 어떤 작업을 하는게 좋을까?"',
    "내가 앞으로 어떤 작업을 하는게 좋을까? 임베딩 관련만", "어떤 작업을 하는게 좋을까라고 물었을 때 답변은?",
    "What should I work on next for synthetic exports?", "What did I say I should work on next?",
    "次にすると決めた作業は何でしたか？"])("preserves the quoted or qualified question %s", question => {
    expect(isNextWorkOverview(question)).toBe(false);
  });
});

describe("retrieveActivity", () => {
  it.each(["read-failure", "stopped-before-plan"] as const)(
    "exposes only a live validated selected period before retrieval: %s", async phase => {
      const onRangeSelected = vi.fn();
      const controller = new AbortController();
      let rejectRead!: (error: Error) => void;
      let releasePlan!: (reply: LocalQueryPlan) => void;
      if (phase === "read-failure") {
        vi.mocked(ipc.activityRecall).mockImplementationOnce(() => new Promise((_, reject) => { rejectRead = reject; }));
      } else {
        vi.mocked(ipc.localQueryPlan).mockImplementationOnce(() => new Promise(resolve => { releasePlan = resolve; }));
      }
      // Observe rejection explicitly so cleanup can settle a held synthetic IPC.
      const observed = retrieveActivity({ ...options, signal: controller.signal, onRangeSelected })
        .then(reply => ({ kind: "reply" as const, reply }),
          (error: unknown) => ({ kind: "error" as const, error }));
      try {
        await vi.advanceTimersByTimeAsync(0);
        if (phase === "read-failure") {
          expect(ipc.activityRecall).toHaveBeenCalledOnce();
          expect(onRangeSelected).toHaveBeenCalledOnce();
          expect(onRangeSelected).toHaveBeenCalledWith(range);
          expect(onRangeSelected.mock.invocationCallOrder[0])
            .toBeLessThan(vi.mocked(ipc.activityRecall).mock.invocationCallOrder[0]);
          rejectRead(new Error("PRIVATE-SYNTHETIC-READ-FAILURE"));
        } else {
          expect(ipc.localQueryPlan).toHaveBeenCalledOnce();
          controller.abort();
        }
        const result = await observed;
        expect(result.kind).toBe("error");
        if (result.kind !== "error") throw new Error("Synthetic activity unexpectedly completed");
        expect(result.error).toBeInstanceOf(Error);
        expect((result.error as Error).message).toBe(phase === "read-failure" ? "activity retrieval failed" : "stopped");
        if (phase === "stopped-before-plan") {
          releasePlan(plan);
          await vi.advanceTimersByTimeAsync(0);
          expect(onRangeSelected).not.toHaveBeenCalled();
          expect(ipc.activityRecall).not.toHaveBeenCalled();
        } else {
          expect(onRangeSelected).toHaveBeenCalledOnce();
          expect(ipc.cancelLocalSynthesis).not.toHaveBeenCalled();
        }
      } finally {
        controller.abort();
        await observed;
      }
    },
  );

  it("carries one captured native opening through planning and recall", async () => {
    const captured = { ...options, origin, queryTime: new Date(2026, 9, 6, 23, 59) };
    vi.mocked(ipc.localQueryPlan).mockResolvedValue({ ...range, end: "2026-10-06", model_id: modelId });
    await retrieveActivity(captured);
    expect(ipc.localQueryPlan).toHaveBeenCalledWith(expect.objectContaining({ origin, roleSnapshot, today: "2026-10-06" }));
    expect(ipc.activityRecall).toHaveBeenCalledWith(expect.objectContaining({ origin, roleSnapshot }));
    expect(ipc.agentVaultSession).not.toHaveBeenCalled();
    expect(ipc.captureModelRole).not.toHaveBeenCalled();
  });

  it("rejects an absent or different native opening before touching a model", async () => {
    for (const captured of [{ ...options, origin: undefined }, { ...options, origin: { ...origin, vaultPath: "/other" } }]) {
      await expect(retrieveActivity(captured)).rejects.toMatchObject({ name: "QueryAuthorizationError" });
    }
    expect(ipc.localChatStatus).not.toHaveBeenCalled();
    expect(ipc.localQueryPlan).not.toHaveBeenCalled();
    expect(ipc.activityRecall).not.toHaveBeenCalled();
  });

  it("uses the model-selected period and complete passages without similarity scores", async () => {
    const thinking = vi.fn();
    const retrieving = vi.fn();
    await expect(retrieveActivity({ ...options, paths: ["sessions/synthetic.md"],
      onThinking: thinking, onRetrieving: retrieving })).resolves.toEqual({ ...evidence, range });
    expect(ipc.localQueryPlan).toHaveBeenCalledWith({ requestId: expect.any(String),
      question: options.question, today: "2026-10-07", modelId, expectedVault: "/synthetic", origin, roleSnapshot, scope: "all",
      paths: ["sessions/synthetic.md"] });
    expect(ipc.activityRecall).toHaveBeenCalledWith({ expectedVault: "/synthetic", origin, roleSnapshot, range,
      scope: "all", paths: ["sessions/synthetic.md"] });
    expect(thinking).toHaveBeenCalledTimes(1);
    expect(retrieving).toHaveBeenCalledTimes(1);
    expect(thinking.mock.invocationCallOrder[0]).toBeLessThan(retrieving.mock.invocationCallOrder[0]);
  });

  it("reuses the captured retry period without planning it again, while verifying the selected model", async () => {
    const captured = { start: "2026-10-01", end: "2026-10-05" };
    await expect(retrieveActivity({ ...options, range: captured })).resolves.toEqual({ ...evidence, range: captured });
    expect(ipc.localChatStatus).toHaveBeenCalledWith(modelId);
    expect(ipc.localQueryPlan).not.toHaveBeenCalled();
    expect(ipc.activityRecall).toHaveBeenCalledWith({ expectedVault: "/synthetic", origin, roleSnapshot, range: captured, scope: "all" });
  });

  it("preserves incomplete coverage and accepts genuinely empty dated evidence", async () => {
    const empty = { ...evidence, hits: [], matched_chunks: 0, incomplete: true };
    vi.mocked(ipc.activityRecall).mockResolvedValue(empty);
    await expect(retrieveActivity(options)).resolves.toEqual({ ...empty, range });
  });

  it("rejects an unsupported model before any native request", async () => {
    await expect(retrieveActivity({ ...options, modelId: "unverified-model" })).rejects.toThrow();
    expect(ipc.localChatStatus).not.toHaveBeenCalled();
    expect(ipc.localQueryPlan).not.toHaveBeenCalled();
    expect(ipc.activityRecall).not.toHaveBeenCalled();
  });

  it.each([
    { model_id: modelId, state: "missing" as const, bytes: 0 },
    { model_id: modelId, state: "ready" as const, bytes: 0 },
    { model_id: modelId, state: "ready" as const, bytes: Number.NaN },
    { model_id: modelId, state: "ready" as const, bytes: Number.POSITIVE_INFINITY },
    { model_id: "wrong-model", state: "ready" as const, bytes: 100 },
  ])("refuses to plan or retrieve with an unready artifact: %j", async status => {
    vi.mocked(ipc.localChatStatus).mockResolvedValue(status);
    await expect(retrieveActivity(options)).rejects.toThrow();
    expect(ipc.localQueryPlan).not.toHaveBeenCalled();
    expect(ipc.activityRecall).not.toHaveBeenCalled();
  });

  it.each([
    { ...plan, start: "2026-02-30" }, { ...plan, end: "2026-10-08" },
    { ...plan, start: "2026-10-07", end: "2026-09-21" }, { ...plan, start: "" },
    { ...plan, model_id: "wrong-model" },
  ])("rejects an invalid period instead of falling back to seven days: %j", async invalid => {
    vi.mocked(ipc.localQueryPlan).mockResolvedValue(invalid);
    await expect(retrieveActivity(options)).rejects.toThrow();
    expect(ipc.activityRecall).not.toHaveBeenCalled();
    expect(ipc.localQueryPlan).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ...evidence, hits: Array.from({ length: 13 }, () => evidence.hits[0]) },
    { ...evidence, indexed_pages: -1 }, { ...evidence, scanned_pages: Number.NaN },
    { ...evidence, matched_chunks: 0.5 },
    { ...evidence, hits: [{ ...evidence.hits[0], page: "../outside.md" }] },
    { ...evidence, hits: [{ ...evidence.hits[0], page: "/absolute/synthetic.md" }] },
    { ...evidence, hits: [{ ...evidence.hits[0], page: "sessions/[[synthetic]].md" }] },
    { ...evidence, hits: [{ ...evidence.hits[0], section: -1 }] },
    { ...evidence, hits: [{ ...evidence.hits[0], text: " " }] },
    { ...evidence, hits: [{ ...evidence.hits[0], title: "x".repeat(257) }] },
  ])("rejects malformed evidence at the frontend boundary: %j", async invalid => {
    vi.mocked(ipc.activityRecall).mockResolvedValue(invalid);
    await expect(retrieveActivity(options)).rejects.toThrow("activity evidence is invalid");
  });

  it.each(["status", "plan", "recall"])("does not publish a private native %s rejection", async phase => {
    const failure = new Error("PRIVATE-SYNTHETIC-NATIVE-PAYLOAD");
    if (phase === "status") vi.mocked(ipc.localChatStatus).mockRejectedValue(failure);
    else if (phase === "plan") vi.mocked(ipc.localQueryPlan).mockRejectedValue(failure);
    else vi.mocked(ipc.activityRecall).mockRejectedValue(failure);
    await expect(retrieveActivity(options)).rejects.not.toThrow("PRIVATE-SYNTHETIC-NATIVE-PAYLOAD");
  });

  it.each(["status", "plan"])("has no automatic %s deadline", async phase => {
    let release!: () => void;
    if (phase === "status") vi.mocked(ipc.localChatStatus).mockImplementation(() => new Promise(resolve => {
      release = () => resolve({ model_id: modelId, state: "ready", bytes: 100 });
    }));
    else vi.mocked(ipc.localQueryPlan).mockImplementation(() => new Promise(resolve => {
      release = () => resolve(plan);
    }));
    const settled = vi.fn();
    const pending = retrieveActivity(options).finally(settled);
    await vi.advanceTimersByTimeAsync(180000);
    expect(settled).not.toHaveBeenCalled();
    expect(ipc.activityRecall).not.toHaveBeenCalled();
    release();
    await expect(pending).resolves.toEqual({ ...evidence, range });
    expect(ipc.localQueryPlan).toHaveBeenCalledTimes(1);
    expect(ipc.activityRecall).toHaveBeenCalledTimes(1);
  });

  it("ignores late readiness after Stop without starting the planner", async () => {
    let release!: (status: Awaited<ReturnType<typeof ipc.localChatStatus>>) => void;
    vi.mocked(ipc.localChatStatus).mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const controller = new AbortController();
    const pending = retrieveActivity({ ...options, signal: controller.signal });
    const rejection = expect(pending).rejects.toThrow("stopped");
    controller.abort();
    await rejection;
    release({ model_id: modelId, state: "ready", bytes: 100 });
    await vi.advanceTimersByTimeAsync(0);
    expect(ipc.localQueryPlan).not.toHaveBeenCalled();
    expect(ipc.activityRecall).not.toHaveBeenCalled();
    expect(ipc.cancelLocalSynthesis).not.toHaveBeenCalled();
  });

  it("cancels only the exact pending plan and ignores its late completion", async () => {
    let release!: (reply: LocalQueryPlan) => void;
    vi.mocked(ipc.localQueryPlan).mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const controller = new AbortController();
    const pending = retrieveActivity({ ...options, signal: controller.signal });
    const rejection = expect(pending).rejects.toThrow("stopped");
    await vi.advanceTimersByTimeAsync(0);
    const request = vi.mocked(ipc.localQueryPlan).mock.calls[0][0];
    controller.abort();
    await rejection;
    expect(ipc.cancelLocalSynthesis).toHaveBeenCalledTimes(1);
    expect(ipc.cancelLocalSynthesis).toHaveBeenCalledWith(request.requestId);
    release(plan);
    await vi.advanceTimersByTimeAsync(0);
    expect(ipc.activityRecall).not.toHaveBeenCalled();
  });

  it("ignores late recall evidence after Stop without cancelling a completed plan", async () => {
    let release!: (reply: ActivityRecallResult) => void;
    vi.mocked(ipc.activityRecall).mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const controller = new AbortController();
    const pending = retrieveActivity({ ...options, signal: controller.signal });
    const rejection = expect(pending).rejects.toThrow("stopped");
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await rejection;
    expect(ipc.cancelLocalSynthesis).not.toHaveBeenCalled();
    release(evidence);
    await vi.advanceTimersByTimeAsync(0);
    expect(ipc.localQueryPlan).toHaveBeenCalledTimes(1);
  });

  it("does not touch native services when already stopped", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(retrieveActivity({ ...options, signal: controller.signal })).rejects.toThrow("stopped");
    expect(ipc.localChatStatus).not.toHaveBeenCalled();
    expect(ipc.localQueryPlan).not.toHaveBeenCalled();
    expect(ipc.activityRecall).not.toHaveBeenCalled();
  });

  it("ignores late readiness after Stop without starting a plan", async () => {
    let release!: () => void;
    vi.mocked(ipc.localChatStatus).mockImplementation(() => new Promise(resolve => {
      release = () => resolve({ model_id: modelId, state: "ready", bytes: 100 });
    }));
    const controller = new AbortController();
    const pending = retrieveActivity({ ...options, signal: controller.signal });
    const rejection = expect(pending).rejects.toThrow("stopped");
    await vi.advanceTimersByTimeAsync(180000);
    controller.abort();
    await rejection;
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(ipc.localQueryPlan).not.toHaveBeenCalled();
    expect(ipc.activityRecall).not.toHaveBeenCalled();
    expect(ipc.cancelLocalSynthesis).not.toHaveBeenCalled();
  });

  it("checks Stop again before native retrieval when the phase callback aborts", async () => {
    const controller = new AbortController();
    await expect(retrieveActivity({ ...options, signal: controller.signal,
      onRetrieving: () => controller.abort() })).rejects.toThrow("stopped");
    expect(ipc.activityRecall).not.toHaveBeenCalled();
  });

  it.each(["status", "plan", "recall"])(
    "replaces an unknown native %s failure with a static error", async phase => {
      const failure = new Error("PRIVATE-SYNTHETIC-PAYLOAD");
      if (phase === "status") vi.mocked(ipc.localChatStatus).mockRejectedValue(failure);
      else if (phase === "plan") vi.mocked(ipc.localQueryPlan).mockRejectedValue(failure);
      else vi.mocked(ipc.activityRecall).mockRejectedValue(failure);
      const rejection = await retrieveActivity(options).catch(error => error as Error);
      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).message).not.toContain("PRIVATE-SYNTHETIC-PAYLOAD");
    },
  );
});
