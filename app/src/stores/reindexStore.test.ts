import { beforeEach, describe, expect, it, vi } from "vitest";
import { useReindexStore } from "./reindexStore";
import { useVaultStore } from "./vaultStore";
import { ipc } from "../lib/ipc";

// Reindex takes minutes, so it routinely outlives the Settings panel that starts
// it. While the state lived in the component, leaving Settings reset it to idle
// and re-enabled the button — a second click then ran a SECOND reindex against
// the same index. These tests pin the guard and the state machine.

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));

/** A reindex that does not resolve until we say so. */
function pendingReindex() {
  let release!: (n: number) => void;
  let fail!: (e: unknown) => void;
  const spy = vi.fn().mockReturnValue(
    new Promise<number>((res, rej) => {
      release = res;
      fail = rej;
    }),
  );
  vi.spyOn(ipc, "reindexEmbeddings").mockImplementation(spy);
  return { spy, release, fail };
}

describe("reindexStore", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    // restoreAllMocks clears the module mock's implementation too, so listen
    // would resolve to undefined and the store's unlisten would throw.
    const { listen } = await import("@tauri-apps/api/event");
    vi.mocked(listen).mockResolvedValue(() => undefined);
    useVaultStore.setState({ currentVault: { path: "/v", name: "v" } });
    useReindexStore.setState({ stage: "idle", done: 0, total: 0, page: "", indexed: 0, error: null });
  });

  it("refuses to start a second run while one is in flight", async () => {
    const { spy, release } = pendingReindex();
    void useReindexStore.getState().reindex();
    await vi.waitFor(() => expect(useReindexStore.getState().stage).toBe("loading-model"));

    // The click that used to start a duplicate run against the same index.
    await useReindexStore.getState().reindex();
    useReindexStore.setState({ stage: "indexing" });
    await useReindexStore.getState().reindex();
    expect(spy).toHaveBeenCalledTimes(1);

    release(42);
    await vi.waitFor(() => expect(useReindexStore.getState().stage).toBe("done"));
  });

  it("starts in loading-model — the run's first cost is the model", async () => {
    const { release } = pendingReindex();
    void useReindexStore.getState().reindex();
    await vi.waitFor(() => expect(useReindexStore.getState().stage).toBe("loading-model"));
    release(1);
  });

  it("reports the indexed count on success", async () => {
    vi.spyOn(ipc, "reindexEmbeddings").mockResolvedValue(51);
    await useReindexStore.getState().reindex();
    expect(useReindexStore.getState().stage).toBe("done");
    expect(useReindexStore.getState().indexed).toBe(51);
    expect(useReindexStore.getState().error).toBeNull();
  });

  it("surfaces a failure instead of hanging in a busy state", async () => {
    vi.spyOn(ipc, "reindexEmbeddings").mockRejectedValue(new Error("model missing"));
    await useReindexStore.getState().reindex();
    expect(useReindexStore.getState().stage).toBe("error");
    expect(useReindexStore.getState().error).toContain("model missing");
  });

  it("can run again after a failure", async () => {
    vi.spyOn(ipc, "reindexEmbeddings").mockRejectedValueOnce(new Error("boom"));
    await useReindexStore.getState().reindex();
    expect(useReindexStore.getState().stage).toBe("error");
    // error is not a running stage, so the guard must let a retry through.
    vi.spyOn(ipc, "reindexEmbeddings").mockResolvedValue(7);
    await useReindexStore.getState().reindex();
    expect(useReindexStore.getState().stage).toBe("done");
  });

  it("does nothing without an open vault", async () => {
    const spy = vi.spyOn(ipc, "reindexEmbeddings").mockResolvedValue(1);
    useVaultStore.setState({ currentVault: null });
    await useReindexStore.getState().reindex();
    expect(spy).not.toHaveBeenCalled();
    expect(useReindexStore.getState().stage).toBe("idle");
  });

  it("drops its listeners when the run ends", async () => {
    const off = vi.fn();
    const { listen } = await import("@tauri-apps/api/event");
    vi.mocked(listen).mockResolvedValue(off);
    vi.spyOn(ipc, "reindexEmbeddings").mockResolvedValue(3);
    await useReindexStore.getState().reindex();
    // One per event subscribed (local-model-load, reindex-progress); a listener
    // that outlives its run would double-count the next one's progress.
    expect(off).toHaveBeenCalledTimes(2);
  });
});
