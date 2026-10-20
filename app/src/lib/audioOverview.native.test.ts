import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  agentVaultSession: vi.fn(),
  captureModelRole: vi.fn(),
  audioOverviewBegin: vi.fn(),
  audioOverviewGenerate: vi.fn(),
  audioOverviewPublish: vi.fn(),
  audioOverviewCancel: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  createFolder: vi.fn(),
  complete: vi.fn(),
}));

vi.mock("./ipc", () => ({ ipc: mocks }));
vi.mock("./chat", () => ({ complete: mocks.complete }));

import { AudioOverviewError, generateScript, saveTranscript, type AudioScript } from "./audioOverview";
import { roleFixture } from "./modelRoles.testSupport";
import type { AgentVaultSession } from "./ipc";

interface JobContext {
  jobId: string;
  origin: AgentVaultSession;
}

interface DraftScript extends AudioScript {
  context: JobContext & { draftId: string };
  coverage: {
    selectedPages: string[];
    includedPages: string[];
    omittedPages: string[];
  };
}

interface Lifecycle {
  isCurrent: () => boolean;
  onJob: (context: JobContext) => void;
}

// This tests the forthcoming optional lifecycle contract through the existing
// public export; the RED uses a runtime assertion, not a missing API import.
const generateNative = generateScript as (
  vaultPath: string,
  pagePaths: string[],
  title: string,
  lifecycle?: Lifecycle,
) => Promise<DraftScript>;

const origin = { vaultPath: "/v", openingToken: "synthetic-audio-opening" };
const pages = ["/v/wiki/a.md", "/v/wiki/b.md"];
const job: JobContext = { jobId: "synthetic-audio-job", origin };
const draft: DraftScript = {
  title: "Synthetic audio",
  turns: [{ speaker: "A", text: "Selected source only.", cites: ["[[a]]"] }],
  sourcePages: [pages[0]],
  context: { ...job, draftId: "synthetic-audio-draft" },
  coverage: {
    selectedPages: pages,
    includedPages: [pages[0]],
    omittedPages: [pages[1]],
  },
};
const receipt = {
  ...draft.context,
  path: "/v/audio/synthetic-audio-2026-10-11.md",
  revision: "a".repeat(64),
  state: "persisted" as const,
  error: null,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settleMicrotasks() {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

function expectNoFrontendFallback() {
  expect(mocks.captureModelRole).not.toHaveBeenCalled();
  expect(mocks.readFile).not.toHaveBeenCalled();
  expect(mocks.complete).not.toHaveBeenCalled();
  expect(mocks.createFolder).not.toHaveBeenCalled();
  expect(mocks.writeFile).not.toHaveBeenCalled();
}

function expectOneCall(mock: ReturnType<typeof vi.fn>, ...args: unknown[]) {
  expect(mock).toHaveBeenCalledTimes(1);
  expect(mock).toHaveBeenCalledWith(...args);
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.agentVaultSession.mockResolvedValue(origin);
  mocks.captureModelRole.mockResolvedValue(roleFixture("audio", undefined, undefined, origin));
  mocks.audioOverviewBegin.mockResolvedValue(job);
  mocks.audioOverviewGenerate.mockResolvedValue(draft);
  mocks.audioOverviewPublish.mockResolvedValue(receipt);
  mocks.audioOverviewCancel.mockResolvedValue(true);
  // The legacy implementation succeeds with these fixtures. Native assertions
  // must therefore fail on the actual bypass, rather than an unrelated error.
  mocks.readFile.mockResolvedValue({ content: "Selected source only." });
  mocks.complete.mockResolvedValue(JSON.stringify(draft.turns));
  mocks.createFolder.mockResolvedValue(undefined);
  mocks.writeFile.mockResolvedValue(undefined);
});

describe("native-owned audio source, draft, and publication", () => {
  it("begins one native source job and generates only from its unchanged context", async () => {
    const selected = [...pages];
    const onJob = vi.fn();
    const result = await generateNative("/v", selected, draft.title, {
      isCurrent: () => true,
      onJob,
    });
    expectOneCall(mocks.audioOverviewBegin,
      origin,
      pages,
      draft.title,
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    );
    expectOneCall(onJob, job);
    expectOneCall(mocks.audioOverviewGenerate, job);
    expect(result).toEqual(draft);
    expectNoFrontendFallback();
  });

  it("does not read, generate, or write through a fallback when native begin refuses", async () => {
    mocks.audioOverviewBegin.mockRejectedValue(new Error("audio_source_unavailable"));
    await expect(generateNative("/v", pages, draft.title)).rejects.toThrow();
    expect(mocks.audioOverviewGenerate).not.toHaveBeenCalled();
    expect(mocks.audioOverviewPublish).not.toHaveBeenCalled();
    expectNoFrontendFallback();
  });

  it("keeps native model failure on the original job without another generation route", async () => {
    mocks.audioOverviewGenerate.mockRejectedValue(new Error("audio_generation_unavailable"));
    await expect(generateNative("/v", pages, draft.title)).rejects.toThrow();
    expect(mocks.audioOverviewBegin).toHaveBeenCalledTimes(1);
    expectOneCall(mocks.audioOverviewGenerate, job);
    expect(mocks.audioOverviewPublish).not.toHaveBeenCalled();
    expectNoFrontendFallback();
  });

  it("registers and cancels the exact late begin before generation when its owner was reset", async () => {
    const begin = deferred<JobContext>();
    const cancellation = deferred<boolean>();
    mocks.audioOverviewBegin.mockReturnValue(begin.promise);
    mocks.audioOverviewCancel.mockReturnValue(cancellation.promise);
    let current = true;
    const onJob = vi.fn();
    const pending = generateNative("/v", pages, draft.title, {
      isCurrent: () => current,
      onJob,
    });
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await settleMicrotasks();
    current = false;
    begin.resolve(job);
    await settleMicrotasks();
    expectOneCall(onJob, job);
    expectOneCall(mocks.audioOverviewCancel, job);
    expect(mocks.audioOverviewGenerate).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    cancellation.resolve(true);
    await expect(pending).rejects.toThrow();
    expect(mocks.audioOverviewPublish).not.toHaveBeenCalled();
    expectNoFrontendFallback();
  });

  it("also cancels a begin invalidated synchronously by registration", async () => {
    let current = true;
    await expect(generateNative("/v", pages, draft.title, {
      isCurrent: () => current,
      onJob: () => { current = false; },
    })).rejects.toThrow();
    expectOneCall(mocks.audioOverviewCancel, job);
    expect(mocks.audioOverviewGenerate).not.toHaveBeenCalled();
    expectNoFrontendFallback();
  });

  it("requires native draft context before publishing a caller-authored script", async () => {
    const forged: AudioScript = {
      title: draft.title,
      turns: draft.turns,
      sourcePages: pages,
    };
    await expect(saveTranscript("/v", forged, "2026-10-11T00:00:00.000Z")).rejects.toThrow();
    expect(mocks.audioOverviewPublish).not.toHaveBeenCalled();
    expectNoFrontendFallback();
  });

  it("publishes only the native draft capability and adopts a matching persisted receipt", async () => {
    const script = await generateNative("/v", pages, draft.title);
    const path = await saveTranscript("/v", script, "2026-10-11T00:00:00.000Z");
    expectOneCall(mocks.audioOverviewPublish, draft.context);
    expect(path).toBe(receipt.path);
    expectNoFrontendFallback();
  });

  it("keeps a partial publication out of the transcript success path", async () => {
    mocks.audioOverviewPublish.mockResolvedValue({
      ...receipt,
      state: "partial",
      error: "audio_publication_unconfirmed",
    });
    const script = await generateNative("/v", pages, draft.title);
    await expect(saveTranscript("/v", script, "2026-10-11T00:00:00.000Z")).rejects.toThrow();
    expectOneCall(mocks.audioOverviewPublish, draft.context);
    expectNoFrontendFallback();
  });

  it.each([
    { ...receipt, jobId: "different-job" },
    { ...receipt, draftId: "different-draft" },
    { ...receipt, origin: { ...origin, openingToken: "different-opening" } },
    { ...receipt, path: "/different-vault/audio/transcript.md" },
    { ...receipt, revision: "" },
  ])("refuses a persisted receipt that does not match its exact draft: %j", async (invalid) => {
    mocks.audioOverviewPublish.mockResolvedValue(invalid);
    const script = await generateNative("/v", pages, draft.title);
    await expect(saveTranscript("/v", script, "2026-10-11T00:00:00.000Z")).rejects.toThrow();
    expectNoFrontendFallback();
  });

  it.each(["generation", "stale"])(
    "preserves the primary %s failure when exact job cancellation also fails",
    async (primary) => {
      mocks.audioOverviewCancel.mockRejectedValue(new Error("synthetic private cancellation detail"));
      if (primary === "generation") {
        mocks.audioOverviewGenerate.mockRejectedValue(new Error("synthetic private provider detail"));
      }
      let current = true;
      const error = await generateNative("/v", pages, draft.title, {
        isCurrent: () => current,
        onJob: () => { if (primary === "stale") current = false; },
      }).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(AudioOverviewError);
      expect(error).toMatchObject({ code: primary, cancellationUnconfirmed: true });
      expect(String(error)).not.toContain("synthetic private");
      expectOneCall(mocks.audioOverviewCancel, job);
      expectNoFrontendFallback();
    },
  );

  it.each(["/v/audio/../transcript.md", "/v/../v/audio/transcript.md", "/v/audio/sub/transcript.md"])(
    "refuses a receipt path outside the exact audio filename boundary: %s",
    async (path) => {
      mocks.audioOverviewPublish.mockResolvedValue({ ...receipt, path });
      const script = await generateNative("/v", pages, draft.title);
      await expect(saveTranscript("/v", script, "2026-10-11T00:00:00.000Z")).rejects.toThrow();
      expectNoFrontendFallback();
    },
  );

  it("cancels a replaced run's late begin without cancelling or generating from its newer job", async () => {
    const begin = deferred<JobContext>();
    const newerJob = { ...job, jobId: "synthetic-newer-job" };
    const newerDraft = { ...draft, context: { ...newerJob, draftId: "synthetic-newer-draft" } };
    mocks.audioOverviewBegin.mockReturnValueOnce(begin.promise).mockResolvedValueOnce(newerJob);
    mocks.audioOverviewGenerate.mockResolvedValue(newerDraft);
    let oldCurrent = true;
    const oldRun = generateNative("/v", pages, draft.title, { isCurrent: () => oldCurrent, onJob: vi.fn() });
    const oldOutcome = oldRun.catch((error: unknown) => error);
    await settleMicrotasks();
    oldCurrent = false;
    const newer = await generateNative("/v", pages, draft.title, { isCurrent: () => true, onJob: vi.fn() });
    expect(newer.context).toEqual(newerDraft.context);
    begin.resolve(job);
    expect(await oldOutcome).toMatchObject({ code: "stale" });
    expectOneCall(mocks.audioOverviewCancel, job);
    expectOneCall(mocks.audioOverviewGenerate, newerJob);
    expectNoFrontendFallback();
  });

  it("treats a false cancellation acknowledgement as unconfirmed without replacing the primary failure", async () => {
    mocks.audioOverviewGenerate.mockRejectedValue(new Error("Synthetic private generation detail"));
    mocks.audioOverviewCancel.mockResolvedValue(false);
    const error = await generateNative("/v", pages, draft.title).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AudioOverviewError);
    expect(error).toMatchObject({ code: "generation", cancellationUnconfirmed: true });
    expect(String(error)).not.toContain("Synthetic private");
    expectOneCall(mocks.audioOverviewCancel, job);
    expectNoFrontendFallback();
  });
});
