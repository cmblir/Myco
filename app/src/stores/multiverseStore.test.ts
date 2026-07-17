import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Adjacency, ProjectInfo } from "../lib/ipc";

// Mock the IPC layer so the store's async orchestration can be exercised in
// node without Tauri. Each test sets the mock behaviour it needs.
const listUniverses = vi.fn<() => Promise<ProjectInfo[]>>();
const buildUniverseGraph = vi.fn<(root: string) => Promise<Adjacency>>();
const setActiveProject = vi.fn<(slug: string) => Promise<unknown>>();

vi.mock("../lib/ipc", () => ({
  ipc: {
    listUniverses: () => listUniverses(),
    buildUniverseGraph: (root: string) => buildUniverseGraph(root),
    setActiveProject: (slug: string) => setActiveProject(slug),
  },
}));

import {
  deriveUniverses,
  useMultiverseStore,
} from "./multiverseStore";

function proj(over: Partial<ProjectInfo>): ProjectInfo {
  const slug = over.slug ?? "p";
  return {
    slug,
    title: slug.toUpperCase(),
    description: "",
    root: `/reg/projects/${slug}`, // per-slug root so buildUniverseGraph args differ
    noteCount: 0,
    created: "",
    lastUsed: "",
    independentVault: false,
    active: false,
    ...over,
  };
}

const emptyAdj = (): Adjacency => ({
  forward: {},
  backward: {},
  unresolved: {},
  tags: {},
});

beforeEach(() => {
  listUniverses.mockReset();
  buildUniverseGraph.mockReset();
  setActiveProject.mockReset();
  useMultiverseStore.getState().reset();
});

describe("deriveUniverses (pure)", () => {
  it("assigns a stable hue per slug and picks the active pointer", () => {
    const { universes, order, activeSlug } = deriveUniverses([
      proj({ slug: "alpha", active: false }),
      proj({ slug: "beta", active: true }),
    ]);
    expect(order).toEqual(["alpha", "beta"]);
    expect(activeSlug).toBe("beta");
    expect(universes.alpha.hue).toBe(deriveUniverses([proj({ slug: "alpha" })]).universes.alpha.hue);
    expect(universes.alpha.adjacency).toBeNull();
  });

  it("leaves activeSlug null when no project is active", () => {
    expect(deriveUniverses([proj({ slug: "x" })]).activeSlug).toBeNull();
  });
});

describe("loadProjects", () => {
  it("populates universes and marks the multiverse available", async () => {
    listUniverses.mockResolvedValue([proj({ slug: "a", active: true }), proj({ slug: "b" })]);
    await useMultiverseStore.getState().loadProjects();
    const s = useMultiverseStore.getState();
    expect(s.order).toEqual(["a", "b"]);
    expect(s.activeSlug).toBe("a");
    expect(s.available).toBe(true);
    expect(s.isLoading).toBe(false);
  });

  it("marks unavailable with no error when the registry is empty", async () => {
    listUniverses.mockResolvedValue([]);
    await useMultiverseStore.getState().loadProjects();
    const s = useMultiverseStore.getState();
    expect(s.available).toBe(false);
    expect(s.error).toBeNull();
  });

  it("preserves an already-built graph across a re-list", async () => {
    listUniverses.mockResolvedValue([proj({ slug: "a" })]);
    buildUniverseGraph.mockResolvedValue({ ...emptyAdj(), forward: { "/a": [] } });
    await useMultiverseStore.getState().loadProjects();
    await useMultiverseStore.getState().loadUniverse("a");
    expect(useMultiverseStore.getState().universes.a.adjacency).not.toBeNull();
    // Re-list (e.g. after a switch) must not blank the loaded graph.
    await useMultiverseStore.getState().loadProjects();
    expect(useMultiverseStore.getState().universes.a.adjacency).not.toBeNull();
  });
});

describe("loadUniverse / loadAll", () => {
  it("lazily builds one universe's graph", async () => {
    listUniverses.mockResolvedValue([proj({ slug: "a" }), proj({ slug: "b" })]);
    buildUniverseGraph.mockResolvedValue(emptyAdj());
    await useMultiverseStore.getState().loadProjects();
    await useMultiverseStore.getState().loadUniverse("a");
    expect(buildUniverseGraph).toHaveBeenCalledTimes(1);
    expect(buildUniverseGraph).toHaveBeenCalledWith("/reg/projects/a");
    expect(useMultiverseStore.getState().universes.a.adjacency).not.toBeNull();
    expect(useMultiverseStore.getState().universes.b.adjacency).toBeNull();
  });

  it("loadAll builds every universe's graph in parallel", async () => {
    listUniverses.mockResolvedValue([proj({ slug: "a" }), proj({ slug: "b" })]);
    buildUniverseGraph.mockResolvedValue(emptyAdj());
    await useMultiverseStore.getState().loadAll();
    expect(buildUniverseGraph).toHaveBeenCalledTimes(2);
    const s = useMultiverseStore.getState();
    expect(s.universes.a.adjacency).not.toBeNull();
    expect(s.universes.b.adjacency).not.toBeNull();
  });

  it("captures a per-universe build failure without blanking siblings", async () => {
    listUniverses.mockResolvedValue([proj({ slug: "a" }), proj({ slug: "b" })]);
    buildUniverseGraph.mockImplementation((root) =>
      root === "/reg/projects/a" ? Promise.reject(new Error("boom")) : Promise.resolve(emptyAdj()),
    );
    await useMultiverseStore.getState().loadAll();
    const s = useMultiverseStore.getState();
    expect(s.universes.a.error).toBe("boom");
    expect(s.universes.a.adjacency).toBeNull();
    expect(s.universes.b.adjacency).not.toBeNull();
  });

  it("ignores loadUniverse for an unknown slug", async () => {
    await useMultiverseStore.getState().loadUniverse("ghost");
    expect(buildUniverseGraph).not.toHaveBeenCalled();
  });

  // The scene keys off adjacency identity to decide whether to rebuild, so
  // identity has to mean "the content moved" — nothing else.
  it("keeps the adjacency object when a reload finds the same content", async () => {
    listUniverses.mockResolvedValue([proj({ slug: "a" })]);
    buildUniverseGraph.mockImplementation(() => Promise.resolve(emptyAdj()));

    await useMultiverseStore.getState().loadAll();
    const first = useMultiverseStore.getState().universes.a.adjacency;
    // Re-entering the multiverse reloads everything; nothing changed on disk.
    await useMultiverseStore.getState().loadAll();
    const second = useMultiverseStore.getState().universes.a.adjacency;

    expect(second).toBe(first);
  });

  it("replaces the adjacency object when a reload finds new content", async () => {
    listUniverses.mockResolvedValue([proj({ slug: "a" })]);
    buildUniverseGraph.mockImplementation(() => Promise.resolve(emptyAdj()));
    await useMultiverseStore.getState().loadAll();
    const first = useMultiverseStore.getState().universes.a.adjacency;

    // The user added a note while inside the vault.
    buildUniverseGraph.mockImplementation(() =>
      Promise.resolve({ ...emptyAdj(), forward: { "wiki/new.md": [] } }),
    );
    await useMultiverseStore.getState().loadAll();
    const second = useMultiverseStore.getState().universes.a.adjacency;

    expect(second).not.toBe(first);
    expect(second?.forward).toHaveProperty("wiki/new.md");
  });
});

describe("refreshUniverse", () => {
  it("only commits a changed graph (no churn on identical content)", async () => {
    listUniverses.mockResolvedValue([proj({ slug: "a" })]);
    const first = { ...emptyAdj(), forward: { "/a": ["/b"] } };
    buildUniverseGraph.mockResolvedValue(first);
    await useMultiverseStore.getState().loadAll();
    const before = useMultiverseStore.getState().universes.a.adjacency;
    // Same content again → the object reference must not change.
    buildUniverseGraph.mockResolvedValue({ ...emptyAdj(), forward: { "/a": ["/b"] } });
    await useMultiverseStore.getState().refreshUniverse("a");
    expect(useMultiverseStore.getState().universes.a.adjacency).toBe(before);
    // Changed content → commits a new object.
    buildUniverseGraph.mockResolvedValue({ ...emptyAdj(), forward: { "/a": ["/b", "/c"] } });
    await useMultiverseStore.getState().refreshUniverse("a");
    expect(useMultiverseStore.getState().universes.a.adjacency).not.toBe(before);
  });
});

describe("setActiveUniverse", () => {
  it("switches the active pointer via IPC and updates flags", async () => {
    listUniverses.mockResolvedValue([proj({ slug: "a", active: true }), proj({ slug: "b" })]);
    setActiveProject.mockResolvedValue({ path: "/reg/projects/b", name: "b" });
    await useMultiverseStore.getState().loadProjects();
    await useMultiverseStore.getState().setActiveUniverse("b");
    const s = useMultiverseStore.getState();
    expect(setActiveProject).toHaveBeenCalledTimes(1);
    expect(setActiveProject).toHaveBeenCalledWith("b");
    expect(s.activeSlug).toBe("b");
    expect(s.universes.b.info.active).toBe(true);
    expect(s.universes.a.info.active).toBe(false);
  });
});
