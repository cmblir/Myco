// The refresh is a whole-vault vector query, and the Overview's activity chip
// used to fire it on every link-graph rebuild — twenty times during a harvest
// run. The store's own guard is object identity; these pin that a repeated
// rebuild of the SAME graph costs one query, and that a genuinely new graph
// costs one more.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import { useLinkSuggestStore } from "./linkSuggestStore";
import { useVaultStore } from "./vaultStore";
import type { VaultMeta } from "../lib/ipc";

describe("linkSuggestStore.refresh", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useLinkSuggestStore.setState({ sem: null });
    useVaultStore.setState({ currentVault: { path: "/v" } as VaultMeta });
  });

  it("queries once per distinct adjacency object", async () => {
    const spy = vi.spyOn(ipc, "semanticEdges").mockResolvedValue([]);
    const graph = { forward: {} };
    const store = useLinkSuggestStore.getState();
    await store.refresh(graph);
    await store.refresh(graph);
    await store.refresh(graph);
    expect(spy).toHaveBeenCalledTimes(1);
    await store.refresh({ forward: {} });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("keeps the previous edges when the query fails", async () => {
    vi.spyOn(ipc, "semanticEdges").mockResolvedValue([
      { source: "/v/a.md", target: "/v/b.md", score: 0.9 },
    ]);
    await useLinkSuggestStore.getState().refresh({ forward: { a: [] } });
    expect(useLinkSuggestStore.getState().sem).toHaveLength(1);
    vi.spyOn(ipc, "semanticEdges").mockRejectedValue(new Error("index cold"));
    await useLinkSuggestStore.getState().refresh({ forward: { b: [] } });
    expect(useLinkSuggestStore.getState().sem).toHaveLength(1);
  });

  it("does not publish an old vault's pending response after a switch", async () => {
    let answer!: (edges: { source: string; target: string; score: number }[]) => void;
    vi.spyOn(ipc, "semanticEdges").mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }))
      .mockResolvedValueOnce([]);
    const old = useLinkSuggestStore.getState().refresh({ forward: {} });
    useVaultStore.setState({ currentVault: { path: "/new" } as VaultMeta });
    await useLinkSuggestStore.getState().refresh({ forward: {} });
    answer([{ source: "/v/a.md", target: "/v/b.md", score: 1 }]);
    await old;
    expect(useLinkSuggestStore.getState().sem).toEqual([]);
  });

  it("can retry the same graph after a transient failure", async () => {
    const spy = vi.spyOn(ipc, "semanticEdges").mockRejectedValueOnce(new Error("index busy"))
      .mockResolvedValueOnce([]);
    const graph = { forward: {} };
    await useLinkSuggestStore.getState().refresh(graph);
    await useLinkSuggestStore.getState().refresh(graph);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(useLinkSuggestStore.getState().sem).toEqual([]);
  });

  it("clears the previous vault's names immediately, even before refresh", () => {
    useLinkSuggestStore.setState({ sem: [{ source: "/v/a.md", target: "/v/b.md", score: 1 }] });
    useVaultStore.setState({ currentVault: { path: "/new" } as VaultMeta });
    expect(useLinkSuggestStore.getState().sem).toBeNull();
  });

  it("rejects a late semantic response after reopening the same path", async () => {
    useVaultStore.setState({ vaultToken: "link-open-1" });
    let answer!: (edges: { source: string; target: string; score: number }[]) => void;
    vi.spyOn(ipc, "semanticEdges").mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    const pending = useLinkSuggestStore.getState().refresh({ forward: {} });
    useVaultStore.setState({ vaultToken: "link-open-2" });
    answer([{ source: "/v/a.md", target: "/v/b.md", score: 1 }]);
    await pending;
    expect(useLinkSuggestStore.getState().sem).toBeNull();
  });
});
