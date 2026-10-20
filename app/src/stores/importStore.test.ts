import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportOutcome, ImportProgress } from "../lib/ipc";

const {
  importPaths,
  importSessionSweep,
  importConversations,
  agentVaultSession,
  listen,
  off,
  refreshTree,
  vaultState,
} = vi.hoisted(() => ({
  importPaths: vi.fn(),
  importSessionSweep: vi.fn(),
  importConversations: vi.fn(),
  agentVaultSession: vi.fn(),
  listen: vi.fn(),
  off: vi.fn(),
  refreshTree: vi.fn(),
  vaultState: {
    currentVault: { path: "/synthetic", name: "Synthetic" },
    vaultToken: "synthetic-opening",
    isOpeningVault: false,
  },
}));
vi.mock("../lib/ipc", () => ({
  ipc: { importPaths, importSessionSweep, importConversations, agentVaultSession },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("./vaultStore", () => ({
  useVaultStore: { getState: () => ({ ...vaultState, refreshTree }) },
}));
import { useImportStore } from "./importStore";

const failures = [
  { path: "/synthetic/session-a.jsonl", error: "Synthetic parsing failure" },
];
const outcome: ImportOutcome = {
  source: "codex",
  imported: 1,
  skipped: 0,
  quarantined: [],
  failed: [],
};
beforeEach(() => {
  vi.clearAllMocks();
  listen.mockResolvedValue(off);
  refreshTree.mockResolvedValue(undefined);
  importPaths.mockResolvedValue(outcome);
  agentVaultSession.mockResolvedValue({ vaultPath: "/synthetic", openingToken: "native-opening" });
  vaultState.currentVault = { path: "/synthetic", name: "Synthetic" };
  vaultState.vaultToken = "synthetic-opening";
  vaultState.isOpeningVault = false;
  useImportStore.getState().reset();
  useImportStore.setState({
    stage: "done",
    failedItems: failures,
    failed: 1,
    lastDest: "sessions",
    lastVault: "/synthetic",
  });
});

describe("conversation import retry recovery", () => {
  it("accepts progress only for the exact native opening and import request", async () => {
    let finish!: (value: ImportOutcome) => void;
    importPaths.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const pending = useImportStore.getState().retryFailed();
    await vi.waitFor(() => expect(importPaths).toHaveBeenCalledOnce());
    const receive = listen.mock.calls[0][1] as (event: { payload: ImportProgress }) => void;
    const [,, origin, requestId] = importPaths.mock.calls[0];
    const progress = { done: 1, total: 4, file: "synthetic.jsonl", imported: 1, skipped: 0, failed: 0 };
    for (const metadata of [
      {},
      { origin, requestId: "another-import-in-the-same-opening" },
      { origin: { ...origin, openingToken: "old-opening" }, requestId },
    ]) {
      receive({ payload: { ...progress, ...metadata } });
      expect(useImportStore.getState().done).toBe(0);
    }
    receive({ payload: { ...progress, origin, requestId } });
    expect(useImportStore.getState().done).toBe(1);
    finish(outcome);
    await pending;
  });

  it("passes the captured native opening identity to the import command", async () => {
    await useImportStore.getState().retryFailed();
    expect(agentVaultSession).toHaveBeenCalledOnce();
    expect(importPaths).toHaveBeenCalledWith([failures[0].path], "sessions", {
      vaultPath: "/synthetic", openingToken: "native-opening",
    }, expect.any(String));
  });

  it("refuses a native opening for a different vault before importing old sources", async () => {
    agentVaultSession.mockResolvedValue({ vaultPath: "/synthetic-other", openingToken: "native-other" });
    await useImportStore.getState().retryFailed();
    expect(importPaths).not.toHaveBeenCalled();
  });

  it("refuses an old dispatch if the same vault reopens while native identity is read", async () => {
    let finish!: (value: { vaultPath: string; openingToken: string }) => void;
    agentVaultSession.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const pending = useImportStore.getState().retryFailed();
    await vi.waitFor(() => expect(agentVaultSession).toHaveBeenCalledOnce());
    vaultState.vaultToken = "synthetic-new-opening";
    finish({ vaultPath: "/synthetic", openingToken: "native-opening" });
    await pending;
    expect(importPaths).not.toHaveBeenCalled();
  });

  it("retains the retry queue and destination if the retry command fails", async () => {
    importPaths.mockRejectedValueOnce(
      new Error("Synthetic retry transport failure"),
    );
    await useImportStore.getState().retryFailed();
    expect(useImportStore.getState()).toMatchObject({
      stage: "error",
      failedItems: failures,
      failed: 1,
      lastDest: "sessions",
    });
    expect(useImportStore.getState().error).toContain(
      "Synthetic retry transport failure",
    );
    expect(refreshTree).not.toHaveBeenCalled();
    await useImportStore.getState().retryFailed();
    expect(importPaths).toHaveBeenNthCalledWith(
      2,
      [failures[0].path],
      "sessions",
      { vaultPath: "/synthetic", openingToken: "native-opening" },
      expect.any(String),
    );
    expect(useImportStore.getState()).toMatchObject({
      stage: "done",
      failedItems: [],
      failed: 0,
      imported: 1,
    });
    expect(off).toHaveBeenCalledTimes(2);
  });

  it("retains failed exports in their original inbox destination", async () => {
    useImportStore.setState({ lastDest: "_inbox" });
    importPaths.mockRejectedValueOnce(new Error("Synthetic retry failure"));
    await useImportStore.getState().retryFailed();
    await useImportStore.getState().retryFailed();
    expect(importPaths).toHaveBeenNthCalledWith(
      2,
      [failures[0].path],
      "_inbox",
      { vaultPath: "/synthetic", openingToken: "native-opening" },
      expect.any(String),
    );
  });

  it("does not start another import while a retry is running", async () => {
    let finish!: (value: ImportOutcome) => void;
    importPaths.mockReturnValue(
      new Promise<ImportOutcome>((resolve) => {
        finish = resolve;
      }),
    );
    const pending = useImportStore.getState().retryFailed();
    await vi.waitFor(() => expect(importPaths).toHaveBeenCalledTimes(1));
    await useImportStore.getState().retryFailed();
    await useImportStore.getState().sweep("codex");
    await useImportStore.getState().importFile("/synthetic/export.json");
    expect(importSessionSweep).not.toHaveBeenCalled();
    expect(importConversations).not.toHaveBeenCalled();
    expect(importPaths).toHaveBeenCalledTimes(1);
    finish(outcome);
    await pending;
  });

  it("keeps returned per-file failures after a partially successful retry", async () => {
    const remaining = [
      { path: failures[0].path, error: "Synthetic still invalid" },
    ];
    importPaths.mockResolvedValue({ ...outcome, failed: remaining });
    await useImportStore.getState().retryFailed();
    expect(useImportStore.getState()).toMatchObject({
      stage: "partial",
      failedItems: remaining,
      failed: 1,
      imported: 1,
    });
  });

  it("reports an entirely failed batch as an error with its retry sources", async () => {
    importPaths.mockResolvedValue({ ...outcome, imported: 0, failed: failures });
    await useImportStore.getState().retryFailed();
    expect(useImportStore.getState()).toMatchObject({ stage: "error", failedItems: failures });
    expect(useImportStore.getState().error).toContain(failures[0].error);
  });

  it("does not dispatch an old source after the vault changes during listener setup", async () => {
    let ready!: (value: typeof off) => void;
    listen.mockReturnValueOnce(new Promise<typeof off>(resolve => { ready = resolve; }));
    const pending = useImportStore.getState().retryFailed();
    vaultState.vaultToken = "synthetic-reopened";
    ready(off);
    await pending;
    expect(importPaths).not.toHaveBeenCalled();
    expect(off).toHaveBeenCalled();
  });

  it("discards old completion counts and tree refresh after a same-root reopening", async () => {
    let finish!: (value: ImportOutcome) => void;
    importPaths.mockReturnValueOnce(new Promise<ImportOutcome>(resolve => { finish = resolve; }));
    const pending = useImportStore.getState().retryFailed();
    await vi.waitFor(() => expect(importPaths).toHaveBeenCalledOnce());
    vaultState.vaultToken = "synthetic-reopened";
    finish(outcome);
    await pending;
    expect(useImportStore.getState().stage).not.toBe("done");
    expect(refreshTree).not.toHaveBeenCalled();
  });

  it("cannot replay an old retry queue into another vault", async () => {
    vaultState.currentVault = { path: "/synthetic-other", name: "Other" };
    await useImportStore.getState().retryFailed();
    expect(importPaths).not.toHaveBeenCalled();
  });
});
