// Transport doubles verify observation ownership, never native/model acceptance.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentVaultSession } from "./ipc";
const { agentVaultSession, listWikifyPending } = vi.hoisted(() => ({
  agentVaultSession: vi.fn(),
  listWikifyPending: vi.fn(),
}));
vi.mock("./ipc", () => ({ ipc: { agentVaultSession, listWikifyPending } }));
const active = {
  currentVault: { path: "/synthetic-queue" } as { path: string } | null,
  vaultToken: "synthetic-ui-1",
  isOpeningVault: false,
};
vi.mock("../stores/vaultStore", () => ({
  useVaultStore: { getState: () => active },
}));
import {
  queueReadForOpening,
  readSessionCompileQueue,
  type SessionQueueRead,
  type SessionQueueView,
} from "./sessionCompileQueue";

const ROOT = "/synthetic-queue";
const TOKEN = "synthetic-ui-1";
const ORIGIN: AgentVaultSession = {
  vaultPath: ROOT,
  openingToken: "synthetic-native-1",
};
const VIEW: SessionQueueView = {
  pendingTotal: 8,
  items: [
    {
      key: "codex:synthetic",
      rawPath: "raw/conversations/codex/synthetic.md",
      sourceRevision: "a".repeat(64),
      title: "Synthetic partial",
      srcSlug: "src-synthetic",
      summaryPath: null,
      compileJobId: "synthetic-duplicate-id",
      compilationState: "partial",
      compilationReason: "synthetic-partial-reason",
    },
    {
      key: "codex:synthetic",
      rawPath: "raw/conversations/codex/synthetic.md",
      sourceRevision: "a".repeat(64),
      title: "Synthetic failed",
      srcSlug: "src-synthetic",
      summaryPath: null,
      compileJobId: "synthetic-duplicate-id",
      compilationState: "failed",
      compilationReason: "processing_failed",
    },
    {
      key: "codex:synthetic",
      rawPath: "raw/conversations/codex/synthetic.md",
      sourceRevision: "a".repeat(64),
      title: "Synthetic pending",
      srcSlug: "src-synthetic",
      summaryPath: null,
      compileJobId: "synthetic-duplicate-id",
      compilationState: "pending",
      compilationReason: "compiler_runtime_revalidation_required",
    },
  ],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function observe() {
  const states: SessionQueueRead[] = [];
  const request = readSessionCompileQueue(ROOT, TOKEN, (state) =>
    states.push(state),
  );
  return { states, ...request };
}
beforeEach(() => {
  vi.clearAllMocks();
  active.currentVault = { path: ROOT };
  active.vaultToken = TOKEN;
  active.isOpeningVault = false;
  agentVaultSession.mockResolvedValue(ORIGIN);
  listWikifyPending.mockResolvedValue(VIEW);
});

describe("read-only native session queue observation", () => {
  it("captures native origin and requests three rows without changing or merging them", async () => {
    const read = observe();
    await read.finished;
    expect(agentVaultSession).toHaveBeenCalledTimes(1);
    expect(listWikifyPending).toHaveBeenCalledTimes(1);
    expect(listWikifyPending).toHaveBeenCalledWith(ROOT, ORIGIN, 3);
    expect(read.states).toEqual([
      { phase: "loading", vaultPath: ROOT, vaultToken: TOKEN },
      {
        phase: "ready",
        vaultPath: ROOT,
        vaultToken: TOKEN,
        origin: ORIGIN,
        view: VIEW,
      },
    ]);
    expect(VIEW.items[0].compilationState).toBe("partial");
    expect(VIEW.items[1].compilationState).toBe("failed");
  });
  it("makes no IPC call while the selected opening is inactive", async () => {
    for (const state of [
      { currentVault: null, vaultToken: TOKEN, isOpeningVault: false },
      { currentVault: { path: ROOT }, vaultToken: "", isOpeningVault: false },
      { currentVault: { path: ROOT }, vaultToken: TOKEN, isOpeningVault: true },
    ]) {
      Object.assign(active, state);
      const read = observe();
      await read.finished;
      expect(read.states).toEqual([]);
    }
    expect(agentVaultSession).not.toHaveBeenCalled();
    expect(listWikifyPending).not.toHaveBeenCalled();
  });
  it("does not invoke the listing after a same-path reopen during origin capture", async () => {
    const origin = deferred<AgentVaultSession>();
    agentVaultSession.mockReturnValue(origin.promise);
    const read = observe();
    active.vaultToken = "synthetic-ui-2";
    origin.resolve(ORIGIN);
    await read.finished;
    expect(listWikifyPending).not.toHaveBeenCalled();
    expect(read.states.map((state) => state.phase)).toEqual(["loading"]);
  });
  it("reports foreign or empty native openings without calling listing", async () => {
    for (const origin of [
      { ...ORIGIN, vaultPath: "/synthetic-other" },
      { ...ORIGIN, openingToken: "" },
    ]) {
      agentVaultSession.mockResolvedValue(origin);
      const read = observe();
      await read.finished;
      expect(read.states.at(-1)?.phase).toBe("error");
    }
    expect(listWikifyPending).not.toHaveBeenCalled();
  });
  it.each(["success", "failure"] as const)(
    "suppresses late %s after opening replacement",
    async (result) => {
      for (const changed of ["same-path", "other-path", "opening"] as const) {
        active.currentVault = { path: ROOT };
        active.vaultToken = TOKEN;
        active.isOpeningVault = false;
        const pending = deferred<SessionQueueView>();
        listWikifyPending.mockReturnValue(pending.promise);
        const read = observe();
        await Promise.resolve();
        if (changed === "same-path") active.vaultToken = "synthetic-ui-2";
        if (changed === "other-path")
          active.currentVault = { path: "/synthetic-other" };
        if (changed === "opening") active.isOpeningVault = true;
        if (result === "success") pending.resolve(VIEW);
        else pending.reject(new Error("Synthetic stale failure"));
        await read.finished;
        expect(read.states.map((state) => state.phase)).toEqual(["loading"]);
      }
    },
  );
  it("cancels an earlier refresh so it cannot overwrite a newer response", async () => {
    const pending = deferred<SessionQueueView>();
    listWikifyPending.mockReturnValueOnce(pending.promise);
    const first = observe();
    await Promise.resolve();
    first.cancel();
    const next = observe();
    await next.finished;
    pending.resolve({ pendingTotal: 0, items: [] });
    await first.finished;
    expect(first.states.map((state) => state.phase)).toEqual(["loading"]);
    expect(next.states.at(-1)).toMatchObject({ phase: "ready", view: VIEW });
  });
  it("keeps a current failure visible and a new refresh can recover", async () => {
    listWikifyPending.mockRejectedValueOnce(
      new Error("Synthetic queue read failure"),
    );
    const failed = observe();
    await failed.finished;
    expect(failed.states.at(-1)).toMatchObject({
      phase: "error",
      error: "Error: Synthetic queue read failure",
    });
    const retry = observe();
    await retry.finished;
    expect(retry.states.at(-1)).toMatchObject({ phase: "ready", view: VIEW });
  });
  it("rejects impossible counts and over-limit rows instead of silently trimming", async () => {
    for (const view of [
      { pendingTotal: -1, items: [] },
      { pendingTotal: 0, items: VIEW.items },
      { pendingTotal: 0.5, items: [] },
      { pendingTotal: 4, items: [...VIEW.items, ...VIEW.items] },
      { pendingTotal: 8, items: VIEW.items.slice(0, 2) },
    ]) {
      listWikifyPending.mockResolvedValue(view);
      const read = observe();
      await read.finished;
      expect(read.states.at(-1)?.phase).toBe("error");
    }
  });
  it.each([
    ["null response", null],
    ["missing array", { pendingTotal: 0, items: null }],
    ["null row", { pendingTotal: 1, items: [null] }],
    ["sparse row", { pendingTotal: 1, items: new Array(1) }],
    [
      "missing state",
      {
        pendingTotal: 1,
        items: [{ ...VIEW.items[0], compilationState: undefined }],
      },
    ],
    [
      "unknown state",
      {
        pendingTotal: 1,
        items: [{ ...VIEW.items[0], compilationState: "success" }],
      },
    ],
    [
      "bad source revision",
      {
        pendingTotal: 1,
        items: [{ ...VIEW.items[0], sourceRevision: "changed" }],
      },
    ],
    [
      "bad title",
      { pendingTotal: 1, items: [{ ...VIEW.items[0], title: {} }] },
    ],
    [
      "bad reason",
      { pendingTotal: 1, items: [{ ...VIEW.items[0], compilationReason: {} }] },
    ],
    [
      "bad optional path",
      { pendingTotal: 1, items: [{ ...VIEW.items[0], summaryPath: 7 }] },
    ],
    [
      "missing nullable job",
      {
        pendingTotal: 1,
        items: [{ ...VIEW.items[0], compileJobId: undefined }],
      },
    ],
  ])(
    "rejects %s instead of creating a pending or empty observation",
    async (_name, view) => {
      listWikifyPending.mockResolvedValue(view);
      const read = observe();
      await read.finished;
      expect(read.states.map((state) => state.phase)).toEqual([
        "loading",
        "error",
      ]);
    },
  );
  it("suppresses an earlier refresh error after a later refresh succeeds", async () => {
    const pending = deferred<SessionQueueView>();
    listWikifyPending.mockReturnValueOnce(pending.promise);
    const first = observe();
    await Promise.resolve();
    first.cancel();
    const next = observe();
    await next.finished;
    pending.reject(new Error("Synthetic superseded refresh error"));
    await first.finished;
    expect(first.states.map((state) => state.phase)).toEqual(["loading"]);
    expect(next.states.at(-1)).toMatchObject({ phase: "ready", view: VIEW });
  });
  it("hides every captured phase for an expired opening, including a prior error", () => {
    const states: SessionQueueRead[] = [
      { phase: "loading", vaultPath: ROOT, vaultToken: TOKEN },
      {
        phase: "error",
        vaultPath: ROOT,
        vaultToken: TOKEN,
        error: "Synthetic failure",
      },
      {
        phase: "ready",
        vaultPath: ROOT,
        vaultToken: TOKEN,
        origin: ORIGIN,
        view: VIEW,
      },
    ];
    for (const read of states) {
      expect(queueReadForOpening(read, ROOT, TOKEN, false)).toBe(read);
      expect(queueReadForOpening(read, ROOT, "synthetic-ui-2", false)).toEqual({
        phase: "idle",
      });
      expect(
        queueReadForOpening(read, "/synthetic-other", TOKEN, false),
      ).toEqual({ phase: "idle" });
      expect(queueReadForOpening(read, ROOT, TOKEN, true)).toEqual({
        phase: "idle",
      });
    }
  });
});
