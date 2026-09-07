// The refresh is a whole-vault vector query, and the Overview's activity chip
// used to fire it on every link-graph rebuild — twenty times during a harvest
// run. The store's own guard is object identity; these pin that a repeated
// rebuild of the SAME graph costs one query, and that a genuinely new graph
// costs one more.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import { useLinkSuggestStore } from "./linkSuggestStore";

describe("linkSuggestStore.refresh", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useLinkSuggestStore.setState({ sem: null });
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
      { source: "a", target: "b", score: 0.9 },
    ]);
    await useLinkSuggestStore.getState().refresh({ forward: { a: [] } });
    expect(useLinkSuggestStore.getState().sem).toHaveLength(1);
    vi.spyOn(ipc, "semanticEdges").mockRejectedValue(new Error("index cold"));
    await useLinkSuggestStore.getState().refresh({ forward: { b: [] } });
    expect(useLinkSuggestStore.getState().sem).toHaveLength(1);
  });
});
