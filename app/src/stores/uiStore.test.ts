import { beforeEach, describe, expect, it, vi } from "vitest";

// persist() resolves its storage when the module loads, so the in-memory
// localStorage has to exist before uiStore is imported.
const storage = vi.hoisted(() => {
  const m = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  });
  return m;
});
import { useUIStore } from "./uiStore";

describe("uiStore navigation history", () => {
  beforeEach(() => {
    useUIStore.setState({
      route: "overview",
      navHistory: { entries: ["overview"], idx: 0 },
      splitRoute: null,
    });
  });

  it("starts with the Favorites group expanded", () => {
    expect(useUIStore.getState().expandedFolders.__favorites).toBe(true);
  });

  it("setRoute pushes onto the history", () => {
    const s = useUIStore.getState();
    s.setRoute("query");
    s.setRoute("page:/v/a.md");
    expect(useUIStore.getState().navHistory).toEqual({
      entries: ["overview", "query", "page:/v/a.md"],
      idx: 2,
    });
  });

  it("goBack / goForward move the route along the stack and stop at the ends", () => {
    const s = useUIStore.getState();
    s.setRoute("query");
    s.setRoute("graph");
    s.goBack();
    expect(useUIStore.getState().route).toBe("query");
    s.goBack();
    s.goBack(); // nowhere to go
    expect(useUIStore.getState().route).toBe("overview");
    s.goForward();
    expect(useUIStore.getState().route).toBe("query");
    expect(useUIStore.getState().navHistory.entries).toEqual(["overview", "query", "graph"]);
  });

  it("replaceRoute swaps the current entry without growing the stack", () => {
    const s = useUIStore.getState();
    s.setRoute("page:/v/a.md");
    s.replaceRoute("page:/v/b.md");
    expect(useUIStore.getState().route).toBe("page:/v/b.md");
    expect(useUIStore.getState().navHistory).toEqual({
      entries: ["overview", "page:/v/b.md"],
      idx: 1,
    });
  });

  it("rehydrating a stale persisted stack falls back to the route alone and keeps Favorites open", async () => {
    storage.set(
      "myco-ui",
      JSON.stringify({
        state: {
          route: "graph",
          navHistory: { entries: ["overview", "query"], idx: 1 },
          expandedFolders: { "/v/wiki": true },
        },
        version: 3,
      }),
    );
    await useUIStore.persist.rehydrate();
    const s = useUIStore.getState();
    expect(s.route).toBe("graph");
    expect(s.navHistory).toEqual({ entries: ["graph"], idx: 0 });
    expect(s.expandedFolders).toEqual({ __favorites: true, "/v/wiki": true });
  });
});
