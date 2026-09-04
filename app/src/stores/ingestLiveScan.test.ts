// The mid-run rescan is self-paced and rev-gated. Its own file because the
// scan loop keeps module-level timer state: a run in the big ingestStore suite
// leaves a pending real timer that would suppress the scan here.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));
vi.mock("./vaultStore", () => ({ useVaultStore: { getState: () => ({}) } }));
vi.mock("../lib/chat", () => ({ complete: vi.fn() }));
vi.mock("../lib/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ipc } from "../lib/ipc";
import { applyStreamEvent, useIngestStore } from "./ingestStore";

describe("live link-graph rescan", () => {
  const ADJ = (rev: number) => ({
    forward: {},
    backward: {},
    unresolved: {},
    tags: {},
    rev,
  });
  const write = () =>
    applyStreamEvent({
      kind: "tool",
      tool: "Write",
      detail: "/v/wiki/a.md",
    } as never);

  beforeEach(() => {
    vi.restoreAllMocks();
    useIngestStore.setState({
      stage: "claude",
      runId: "rev-run",
      vaultPath: "/v",
      liveAdjacency: null,
    });
  });

  it("only writes liveAdjacency when the graph rev changed", async () => {
    vi.useFakeTimers();
    const graph = vi.spyOn(ipc, "buildLinkGraph").mockResolvedValue(ADJ(7));

    write();
    await vi.advanceTimersByTimeAsync(2100);
    expect(graph).toHaveBeenCalledTimes(1);
    expect(useIngestStore.getState().liveAdjacency).not.toBeNull();

    // Same rev — the scan still runs, but the store must be left alone.
    useIngestStore.setState({ liveAdjacency: null });
    write();
    await vi.advanceTimersByTimeAsync(2100);
    expect(graph).toHaveBeenCalledTimes(2);
    expect(useIngestStore.getState().liveAdjacency).toBeNull();

    graph.mockResolvedValue(ADJ(8));
    write();
    await vi.advanceTimersByTimeAsync(2100);
    expect(useIngestStore.getState().liveAdjacency).toEqual(ADJ(8));
    vi.useRealTimers();
  });

  it("queues at most one follow-up scan for a burst of writes", async () => {
    vi.useFakeTimers();
    const graph = vi.spyOn(ipc, "buildLinkGraph").mockResolvedValue(ADJ(9));

    for (let i = 0; i < 5; i++) write();
    await vi.advanceTimersByTimeAsync(2100);
    expect(graph).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(graph).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
