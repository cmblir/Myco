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
import { followUIStore, useUIStore } from "./uiStore";

describe("uiStore navigation history", () => {
  beforeEach(() => {
    useUIStore.setState({
      route: "overview",
      navHistory: { entries: ["overview"], idx: 0 },
      splitRoute: null,
      focusTarget: null,
      settingsTab: "appearance",
    });
  });

  it("starts with the Favorites group expanded", () => {
    expect(useUIStore.getState().expandedFolders.__favorites).toBe(true);
  });

  it("distinguishes the default Ask scope from an explicit same-value choice", () => {
    expect(useUIStore.getInitialState()).toMatchObject({ askScope: "wiki", isAskScopeExplicit: false });
    useUIStore.getState().setAskScope("wiki");
    expect(useUIStore.getState()).toMatchObject({ askScope: "wiki", isAskScopeExplicit: true });
    const saved = JSON.parse(storage.get("myco-ui")!);
    expect(saved.state.isAskScopeExplicit).toBe(true);
    expect(saved.state.askScope).toBe("wiki");
  });

  it("rehydrates an explicit Ask scope without inferring intent from a legacy wiki value", async () => {
    storage.set("myco-ui", JSON.stringify({ version: 3, state: {
      askScope: "wiki", isAskScopeExplicit: true,
    } }));
    await useUIStore.persist.rehydrate();
    expect(useUIStore.getState()).toMatchObject({ askScope: "wiki", isAskScopeExplicit: true });
    storage.set("myco-ui", JSON.stringify({ version: 3, state: { askScope: "wiki" } }));
    await useUIStore.persist.rehydrate();
    expect(useUIStore.getState()).toMatchObject({ askScope: "wiki", isAskScopeExplicit: false });
  });

  it("starts with Recently edited open, and a store saved before it keeps it open", async () => {
    expect(useUIStore.getInitialState().expandedFolders.__recent).toBe(true);
    storage.set("myco-ui", JSON.stringify({ state: { expandedFolders: { "/v/a": true } }, version: 3 }));
    await useUIStore.persist.rehydrate();
    expect(useUIStore.getState().expandedFolders.__recent).toBe(true);
  });

  it("keeps Recently edited shut once the user closed it", async () => {
    storage.set("myco-ui", JSON.stringify({ state: { expandedFolders: { __recent: false } }, version: 3 }));
    await useUIStore.persist.rehydrate();
    expect(useUIStore.getState().expandedFolders.__recent).toBe(false);
  });

  it("starts with AI-made study cards off: cards quote the note unless opted in", () => {
    expect(useUIStore.getInitialState().aiCards).toBe(false);
  });

  it("starts reviews with two grade buttons: the four-grade mode is opt-in", () => {
    expect(useUIStore.getInitialState().fineGrades).toBe(false);
  });

  it("starts with note info closed so new users can focus on writing", () => {
    expect(useUIStore.getInitialState().outlineOpen).toBe(false);
  });

  it.each([true, false])("preserves the saved note info preference: %s", async (outlineOpen) => {
    storage.set(
      "myco-ui",
      JSON.stringify({ state: { outlineOpen }, version: 3 }),
    );
    await useUIStore.persist.rehydrate();
    expect(useUIStore.getState().outlineOpen).toBe(outlineOpen);
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

  it("focusSection bumps the nonce on a repeat click and restarts per id", () => {
    const s = useUIStore.getState();
    s.focusSection("links");
    expect(useUIStore.getState().focusTarget).toEqual({ id: "links", nonce: 1 });
    // A repeat click while already on the page must re-fire the anchor's
    // effect — same id, new nonce.
    s.focusSection("links");
    expect(useUIStore.getState().focusTarget).toEqual({ id: "links", nonce: 2 });
    s.focusSection("reflect");
    expect(useUIStore.getState().focusTarget).toEqual({ id: "reflect", nonce: 1 });
    s.clearFocusTarget();
    expect(useUIStore.getState().focusTarget).toBeNull();
  });

  it("expandFolders opens every listed folder and leaves the rest as they were", () => {
    useUIStore.setState({ expandedFolders: { __favorites: true, "/v/a": false, "/v/z": false } });
    useUIStore.getState().expandFolders(["/v/a", "/v/a/b"]);
    expect(useUIStore.getState().expandedFolders).toEqual({
      __favorites: true,
      "/v/a": true,
      "/v/a/b": true,
      "/v/z": false,
    });
  });

  it("remembers a folded workspace group across a relaunch (UX S43)", async () => {
    storage.set(
      "myco-ui",
      JSON.stringify({ state: { expandedFolders: { __workspace: false } }, version: 3 }),
    );
    await useUIStore.persist.rehydrate();
    expect(useUIStore.getState().expandedFolders.__workspace).toBe(false);
    useUIStore.getState().toggleFolder("__workspace");
    expect(useUIStore.getState().expandedFolders.__workspace).toBe(true);
  });

  // UX S43: the Workspace group has no seeded state, so the sidebar can pick
  // its default from the window height; the first click stores the opposite
  // of what was shown.
  it("toggleFolder flips from the shown default when nothing is stored", () => {
    useUIStore.setState({ expandedFolders: {} });
    useUIStore.getState().toggleFolder("__workspace", true);
    expect(useUIStore.getState().expandedFolders.__workspace).toBe(false);
    useUIStore.getState().toggleFolder("/v/a");
    expect(useUIStore.getState().expandedFolders["/v/a"]).toBe(true);
  });

  it("settingsTab defaults to the appearance tab and the setter deep-links", () => {
    // UX S22: Settings opens on what most people change (theme, text size).
    expect(useUIStore.getInitialState().settingsTab).toBe("appearance");
    useUIStore.getState().setSettingsTab("mcp");
    expect(useUIStore.getState().settingsTab).toBe("mcp");
  });

  it("rehydrating a stale persisted stack falls back to the route alone and keeps both groups open and leaves Workspace to the window", async () => {
    storage.set(
      "myco-ui",
      JSON.stringify({
        state: {
          route: "graph",
          navHistory: { entries: ["overview", "query"], idx: 1 },
          expandedFolders: { "/v/wiki": true },
          focusTarget: { id: "links", nonce: 4 },
        },
        version: 3,
      }),
    );
    await useUIStore.persist.rehydrate();
    const s = useUIStore.getState();
    expect(s.route).toBe("graph");
    expect(s.navHistory).toEqual({ entries: ["graph"], idx: 0 });
    expect(s.expandedFolders).toEqual({
      __favorites: true,
      __recent: true,
      "/v/wiki": true,
    });
    // Transient: a click from a past session must not scroll+flash on launch.
    expect(s.focusTarget).toBeNull();
  });

  it.each(["views", "tags", "schedules"])(
    "a store that closed on the removed %s route rehydrates onto overview",
    async (route) => {
      storage.set(
        "myco-ui",
        JSON.stringify({
          state: { route, navHistory: { entries: [route], idx: 0 }, splitRoute: route },
          version: 3,
        }),
      );
      await useUIStore.persist.rehydrate();
      const s = useUIStore.getState();
      expect(s.route).toBe("overview");
      expect(s.navHistory).toEqual({ entries: ["overview"], idx: 0 });
      expect(s.splitRoute).toBeNull();
    },
  );

  it("text size follows the system by default and a bad persisted value falls back to it", async () => {
    expect(useUIStore.getInitialState().textSize).toBe("system");
    storage.set("myco-ui", JSON.stringify({ state: { textSize: "huge" }, version: 3 }));
    await useUIStore.persist.rehydrate();
    expect(useUIStore.getState().textSize).toBe("system");
    storage.set("myco-ui", JSON.stringify({ state: { textSize: "large" }, version: 3 }));
    await useUIStore.persist.rehydrate();
    expect(useUIStore.getState().textSize).toBe("large");
  });

  // S22: Settings opens on Theme every launch, even for a store that persisted
  // the old "model" default or a deep-linked tab from an earlier session.
  it("rehydrates a persisted settings tab and changed-only filter back to the defaults", async () => {
    storage.set(
      "myco-ui",
      JSON.stringify({
        state: { route: "settings", settingsTab: "model", settingsChangedOnly: true },
        version: 3,
      }),
    );
    await useUIStore.persist.rehydrate();
    expect(useUIStore.getState().settingsTab).toBe("appearance");
    expect(useUIStore.getState().settingsChangedOnly).toBe(false);
  });

  it('rehydrates a persisted editorMode "split" (mode removed) as "live"', async () => {
    storage.set(
      "myco-ui",
      JSON.stringify({ state: { editorMode: "split" }, version: 3 }),
    );
    await useUIStore.persist.rehydrate();
    expect(useUIStore.getState().editorMode).toBe("live");
  });

  // One editor (spec 2026-10-01): the Read view is gone, so a device that
  // closed on it opens notes in Live. The source view is still a choice.
  it('rehydrates the removed Read view (editorMode "preview") as "live", and keeps "source"', async () => {
    storage.set(
      "myco-ui",
      JSON.stringify({ state: { editorMode: "preview" }, version: 3 }),
    );
    await useUIStore.persist.rehydrate();
    expect(useUIStore.getState().editorMode).toBe("live");
    storage.set(
      "myco-ui",
      JSON.stringify({ state: { editorMode: "source" }, version: 3 }),
    );
    await useUIStore.persist.rehydrate();
    expect(useUIStore.getState().editorMode).toBe("source");
  });
});

// The notch is its own webview with its own copy of this store; Settings
// writes in the main window. Without a follow, turning the mascot off reached
// the notch only after a relaunch (the window is retained, never reloaded).
describe("followUIStore", () => {
  it("re-reads the store when another window saves it", async () => {
    useUIStore.setState({ mascotEnabled: true, lang: "ko" });
    const win = new EventTarget();
    const stop = followUIStore(win);
    storage.set(
      "myco-ui",
      JSON.stringify({ state: { mascotEnabled: false, lang: "en" }, version: 3 }),
    );
    win.dispatchEvent(Object.assign(new Event("storage"), { key: "myco-ui" }));
    await vi.waitFor(() => expect(useUIStore.getState().mascotEnabled).toBe(false));
    expect(useUIStore.getState().lang).toBe("en");
    stop();
  });

  it("ignores other keys and stops listening once stopped", async () => {
    useUIStore.setState({ mascotEnabled: true });
    storage.set("myco-ui", JSON.stringify({ state: { mascotEnabled: false }, version: 3 }));
    const win = new EventTarget();
    const stop = followUIStore(win);
    win.dispatchEvent(Object.assign(new Event("storage"), { key: "myco.onboarded" }));
    stop();
    win.dispatchEvent(Object.assign(new Event("storage"), { key: "myco-ui" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(useUIStore.getState().mascotEnabled).toBe(true);
  });
});

describe("uiStore note info and the sidebar", () => {
  beforeEach(() => {
    useUIStore.setState({ sidebarCollapsed: false, outlineOpen: false, sidebarFoldedByRail: false });
  });

  it("gives the sidebar back when note info closes after folding it", () => {
    const s = useUIStore.getState();
    s.foldSidebarForRail();
    s.toggleOutline();
    expect(useUIStore.getState()).toMatchObject({ sidebarCollapsed: true, outlineOpen: true });
    useUIStore.getState().toggleOutline();
    expect(useUIStore.getState()).toMatchObject({ sidebarCollapsed: false, outlineOpen: false });
  });

  it("leaves a sidebar the user folded themselves folded", () => {
    useUIStore.setState({ sidebarCollapsed: true });
    const s = useUIStore.getState();
    s.toggleOutline();
    s.toggleOutline();
    expect(useUIStore.getState().sidebarCollapsed).toBe(true);
  });

  it("forgets the fold once the user moves the sidebar while note info is open", () => {
    const s = useUIStore.getState();
    s.foldSidebarForRail();
    s.toggleOutline();
    s.toggleSidebar(); // reopened by hand
    s.toggleSidebar(); // and folded again by hand
    useUIStore.getState().toggleOutline();
    expect(useUIStore.getState().sidebarCollapsed).toBe(true);
  });
});
