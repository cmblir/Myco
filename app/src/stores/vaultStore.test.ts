import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

// uiStore's persisted storage is captured on import; keep this suite
// independent from Node's optional Web Storage implementation.
vi.hoisted(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  });
});

import {
  flushPendingDrafts,
  movePathFollowing,
  pendingDrafts,
  useVaultStore,
} from "./vaultStore";
import { useUIStore } from "./uiStore";
import { ipc } from "../lib/ipc";

// The background poll asks for a link-graph refresh every few seconds to catch
// edits made outside the app. Answering that with a full rebuild means reading
// and parsing every note — measured at 305 ms on a 10k-note vault — almost
// always to conclude nothing happened. These tests pin the two halves of the
// bargain: the poll skips on an unmoved fingerprint, and a local write never
// skips (mtime+len cannot see an edit that keeps both, e.g. [[a]] -> [[b]]
// within one mtime tick).

const ADJ = { forward: {}, backward: {}, unresolved: {}, tags: {} };
const VAULT = { path: "/v", name: "v" };

beforeEach(async () => {
  vi.spyOn(ipc, "closeVault").mockResolvedValue();
  await useVaultStore.getState().reset();
  pendingDrafts.clear();
});

// These legacy graph/queue fixtures delegate their deferred spies through
// explicit synthetic editor receipts. Native CAS is tested independently.
function stubEditorIpc(): void {
  // Keep deferred graph/path fixtures on the explicit legacy capability route.
  vi.spyOn(ipc, "editorRecoverySupported").mockResolvedValue(false);
  vi.spyOn(ipc, "agentVaultSession").mockImplementation(async () => {
    const state = useVaultStore.getState();
    return { vaultPath: state.currentVault!.path, openingToken: `synthetic-${state.vaultToken}` };
  });
  vi.spyOn(ipc, "readEditorFile").mockImplementation(async (path, origin) => {
    const file = await ipc.readFile(path);
    return { file, origin, revision: createHash("sha256").update(file.raw).digest("hex"), mockOnly: true as const };
  });
  vi.spyOn(ipc, "writeEditorFile").mockImplementation(async (path, content, _expected, origin) => {
    await ipc.writeFile(path, content);
    return { path, origin, revision: createHash("sha256").update(content).digest("hex"), mockOnly: true as const };
  });
}

async function admitBaseline(path: string): Promise<void> {
  const active = useVaultStore.getState().activeFile;
  expect(await useVaultStore.getState().openFile(path)).toBeNull();
  useVaultStore.setState({ activeFile: active });
}

function stubIpc(revision: number) {
  const buildLinkGraph = vi.fn().mockResolvedValue(ADJ);
  const vaultRevision = vi.fn().mockResolvedValue(revision);
  const listFiles = vi.fn().mockResolvedValue([]);
  vi.spyOn(ipc, "buildLinkGraph").mockImplementation(buildLinkGraph);
  vi.spyOn(ipc, "vaultRevision").mockImplementation(vaultRevision);
  vi.spyOn(ipc, "listFiles").mockImplementation(listFiles);
  return { buildLinkGraph, vaultRevision, listFiles };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("refreshLinkGraph", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useVaultStore.setState({ currentVault: VAULT, adjacency: null, error: null });
  });

  it("polls with the fingerprint and skips the rebuild when it has not moved", async () => {
    const { buildLinkGraph, vaultRevision } = stubIpc(42);
    // First poll: no baseline yet, so it must build.
    await useVaultStore.getState().refreshLinkGraph({ ifChanged: true });
    expect(buildLinkGraph).toHaveBeenCalledTimes(1);

    // Steady state: same fingerprint, so no rebuild — the whole point.
    await useVaultStore.getState().refreshLinkGraph({ ifChanged: true });
    await useVaultStore.getState().refreshLinkGraph({ ifChanged: true });
    expect(buildLinkGraph).toHaveBeenCalledTimes(1);
    expect(vaultRevision).toHaveBeenCalledTimes(3);
  });

  it("rebuilds when the fingerprint moves", async () => {
    const { buildLinkGraph } = stubIpc(42);
    await useVaultStore.getState().refreshLinkGraph({ ifChanged: true });
    expect(buildLinkGraph).toHaveBeenCalledTimes(1);

    vi.spyOn(ipc, "vaultRevision").mockResolvedValue(43);
    await useVaultStore.getState().refreshLinkGraph({ ifChanged: true });
    expect(buildLinkGraph).toHaveBeenCalledTimes(2);
  });

  it("re-reads the file tree only when the fingerprint moves", async () => {
    const { listFiles } = stubIpc(42);
    // The tree used to be re-read unguarded on every tick (list_files 56 ms /
    // 2.2 MB at 12k files, then stringified twice to learn nothing changed).
    await useVaultStore.getState().refreshLinkGraph({ ifChanged: true });
    expect(listFiles).toHaveBeenCalledTimes(1);

    await useVaultStore.getState().refreshLinkGraph({ ifChanged: true });
    await useVaultStore.getState().refreshLinkGraph({ ifChanged: true });
    expect(listFiles).toHaveBeenCalledTimes(1);

    vi.spyOn(ipc, "vaultRevision").mockResolvedValue(43);
    await useVaultStore.getState().refreshLinkGraph({ ifChanged: true });
    expect(listFiles).toHaveBeenCalledTimes(2);

    // A caller that just wrote refreshes the tree itself; the forced path must
    // not read it a second time.
    await useVaultStore.getState().refreshLinkGraph();
    expect(listFiles).toHaveBeenCalledTimes(2);
  });

  it("always rebuilds for a caller that just wrote", async () => {
    const { buildLinkGraph, vaultRevision } = stubIpc(42);
    // Seed a baseline via the poll...
    await useVaultStore.getState().refreshLinkGraph({ ifChanged: true });
    // ...then a local write. The fingerprint is unchanged in this stub, which
    // is the exact case the forced path exists for: a same-length edit inside
    // one mtime tick. It must still rebuild.
    await useVaultStore.getState().refreshLinkGraph();
    expect(buildLinkGraph).toHaveBeenCalledTimes(2);
    expect(vaultRevision).toHaveBeenCalledTimes(1); // never consulted when forced
  });

  it("does not let a forced rebuild leave the poll trusting a stale baseline", async () => {
    const { buildLinkGraph } = stubIpc(42);
    await useVaultStore.getState().refreshLinkGraph({ ifChanged: true }); // build 1
    await useVaultStore.getState().refreshLinkGraph(); // build 2, forced
    // The next poll must re-establish the baseline rather than skip on the one
    // the forced rebuild invalidated.
    await useVaultStore.getState().refreshLinkGraph({ ifChanged: true }); // build 3
    expect(buildLinkGraph).toHaveBeenCalledTimes(3);
    // And then settle back into skipping.
    await useVaultStore.getState().refreshLinkGraph({ ifChanged: true });
    expect(buildLinkGraph).toHaveBeenCalledTimes(3);
  });

  it("does not skip on a matching fingerprint from a different vault", async () => {
    const { buildLinkGraph } = stubIpc(42);
    await useVaultStore.getState().refreshLinkGraph({ ifChanged: true });
    expect(buildLinkGraph).toHaveBeenCalledTimes(1);

    // Two vaults can hash to the same value only by coincidence, but the
    // baseline is paired with its vault precisely so that coincidence — or an
    // empty vault — cannot serve one vault's graph for another.
    useVaultStore.setState({ currentVault: { path: "/other", name: "other" }, adjacency: null });
    await useVaultStore.getState().refreshLinkGraph({ ifChanged: true });
    expect(buildLinkGraph).toHaveBeenCalledTimes(2);
  });

  it("publishes the fingerprint when it moves, so an open reader re-reads its backlinks", async () => {
    // A prose edit elsewhere keeps the graph identical (sameJSON keeps the old
    // adjacency), so the fingerprint is the only signal that content moved.
    stubIpc(42);
    useVaultStore.setState({ revision: null });
    await useVaultStore.getState().refreshLinkGraph({ ifChanged: true });
    expect(useVaultStore.getState().revision).toBe(42);
    vi.spyOn(ipc, "vaultRevision").mockResolvedValue(43);
    await useVaultStore.getState().refreshLinkGraph({ ifChanged: true });
    expect(useVaultStore.getState().revision).toBe(43);
  });

  it("does not skip when the fingerprint matches but no graph is loaded", async () => {
    const { buildLinkGraph } = stubIpc(42);
    await useVaultStore.getState().refreshLinkGraph({ ifChanged: true });
    // A vault switch clears the graph; the baseline must not paper over that.
    useVaultStore.setState({ adjacency: null });
    await useVaultStore.getState().refreshLinkGraph({ ifChanged: true });
    expect(buildLinkGraph).toHaveBeenCalledTimes(2);
  });

  it.each(["revision", "tree", "graph"] as const)("joins periodic refreshes while the %s read is held", async (phase) => {
    const { buildLinkGraph, vaultRevision, listFiles } = stubIpc(142);
    useVaultStore.setState({ vaultToken: `synthetic-held-${phase}`, fileTree: [] });
    const revision = deferred<number>();
    const tree = deferred<Awaited<ReturnType<typeof ipc.listFiles>>>();
    const graph = deferred<Awaited<ReturnType<typeof ipc.buildLinkGraph>>>();
    if (phase === "revision") vaultRevision.mockReturnValue(revision.promise);
    if (phase === "tree") listFiles.mockReturnValue(tree.promise);
    if (phase === "graph") buildLinkGraph.mockReturnValue(graph.promise);
    const first = useVaultStore.getState().refreshLinkGraph({ ifChanged: true });
    await vi.waitFor(() => expect(phase === "revision" ? vaultRevision : phase === "tree" ? listFiles : buildLinkGraph).toHaveBeenCalled());
    const duplicate = useVaultStore.getState().refreshLinkGraph({ ifChanged: true });
    await Promise.resolve();
    const during = { revisions: vaultRevision.mock.calls.length, trees: listFiles.mock.calls.length, graphs: buildLinkGraph.mock.calls.length };
    revision.resolve(142);
    tree.resolve([]);
    graph.resolve(ADJ);
    await Promise.all([first, duplicate]);
    expect(during.revisions).toBe(1);
    if (phase !== "revision") {
      expect(during.trees).toBe(1);
      expect(during.graphs).toBe(1);
    }
    expect(useVaultStore.getState().adjacency).toEqual(ADJ);
  });

  it("unlocks a failed periodic read and rebuilds on the retry", async () => {
    const { buildLinkGraph, vaultRevision } = stubIpc(143);
    useVaultStore.setState({ vaultToken: "synthetic-failed-poll", adjacency: ADJ });
    buildLinkGraph.mockRejectedValueOnce(new Error("Synthetic graph read failed"));
    await useVaultStore.getState().refreshLinkGraph({ ifChanged: true });
    expect(useVaultStore.getState().error).toBe("Synthetic graph read failed");
    await useVaultStore.getState().refreshLinkGraph({ ifChanged: true });
    expect(vaultRevision).toHaveBeenCalledTimes(2);
    expect(buildLinkGraph).toHaveBeenCalledTimes(2);
  });

  it("keeps a failed graph's flight occupied until its tree read settles", async () => {
    const { buildLinkGraph, vaultRevision, listFiles } = stubIpc(144);
    useVaultStore.setState({ vaultToken: "synthetic-failed-held-tree" });
    const tree = deferred<Awaited<ReturnType<typeof ipc.listFiles>>>();
    listFiles.mockReturnValue(tree.promise);
    buildLinkGraph.mockRejectedValueOnce(new Error("Synthetic graph read failed"));
    const first = useVaultStore.getState().refreshLinkGraph({ ifChanged: true });
    await vi.waitFor(() => expect(buildLinkGraph).toHaveBeenCalled());
    const duplicate = useVaultStore.getState().refreshLinkGraph({ ifChanged: true });
    const during = vaultRevision.mock.calls.length;
    tree.resolve([]);
    await Promise.all([first, duplicate]);
    expect(during).toBe(1);
    await useVaultStore.getState().refreshLinkGraph({ ifChanged: true });
    expect(vaultRevision).toHaveBeenCalledTimes(2);
  });

  it("lets another vault refresh while the old vault's read is held", async () => {
    const { buildLinkGraph } = stubIpc(145);
    useVaultStore.setState({ vaultToken: "synthetic-flight-a" });
    const old = deferred<Awaited<ReturnType<typeof ipc.buildLinkGraph>>>();
    buildLinkGraph.mockImplementation((path: string) => path === VAULT.path ? old.promise : Promise.resolve(ADJ));
    const first = useVaultStore.getState().refreshLinkGraph({ ifChanged: true });
    await vi.waitFor(() => expect(buildLinkGraph).toHaveBeenCalledWith(VAULT.path));
    useVaultStore.setState({ currentVault: { path: "/synthetic/other", name: "Other" }, vaultToken: "synthetic-flight-b", adjacency: null, error: null });
    await useVaultStore.getState().refreshLinkGraph({ ifChanged: true });
    old.reject(new Error("Synthetic old vault failure"));
    await first;
    expect(buildLinkGraph).toHaveBeenCalledTimes(2);
    expect(useVaultStore.getState()).toMatchObject({ adjacency: ADJ, error: null });
  });

  it("drops late reads from an earlier session after A to B to A", async () => {
    const { vaultRevision, listFiles, buildLinkGraph } = stubIpc(146);
    useVaultStore.setState({ vaultToken: "synthetic-session-a-old", revision: null });
    const old = deferred<number>();
    vaultRevision.mockReturnValueOnce(old.promise);
    const first = useVaultStore.getState().refreshLinkGraph({ ifChanged: true });
    useVaultStore.setState({ currentVault: { path: "/synthetic/other", name: "Other" }, vaultToken: "synthetic-session-b" });
    useVaultStore.setState({ currentVault: VAULT, vaultToken: "synthetic-session-a-new", adjacency: null });
    old.resolve(146);
    await first;
    expect(listFiles).not.toHaveBeenCalled();
    expect(buildLinkGraph).not.toHaveBeenCalled();
    expect(useVaultStore.getState()).toMatchObject({ adjacency: null, revision: null, error: null });
  });

  it("does not let an old session's held tree overwrite a reopened root", async () => {
    const { listFiles } = stubIpc(147);
    useVaultStore.setState({ vaultToken: "synthetic-tree-a-old", fileTree: [] });
    const old = deferred<Awaited<ReturnType<typeof ipc.listFiles>>>();
    listFiles.mockReturnValueOnce(old.promise);
    const first = useVaultStore.getState().refreshLinkGraph({ ifChanged: true });
    await vi.waitFor(() => expect(listFiles).toHaveBeenCalled());
    useVaultStore.setState({ vaultToken: "synthetic-tree-a-new", fileTree: [], adjacency: null });
    await useVaultStore.getState().refreshLinkGraph({ ifChanged: true });
    old.resolve([{ kind: "file", name: "old.md", path: "/v/wiki/old.md" }]);
    await first;
    await Promise.resolve();
    expect(useVaultStore.getState().fileTree).toEqual([]);
  });

  it("keeps latest-started forced refreshes and joins their periodic follower", async () => {
    const { buildLinkGraph, vaultRevision } = stubIpc(148);
    useVaultStore.setState({ vaultToken: "synthetic-forced-flight" });
    const old = deferred<Awaited<ReturnType<typeof ipc.buildLinkGraph>>>();
    const latest = deferred<Awaited<ReturnType<typeof ipc.buildLinkGraph>>>();
    buildLinkGraph.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    const first = useVaultStore.getState().refreshLinkGraph();
    const second = useVaultStore.getState().refreshLinkGraph();
    const poll = useVaultStore.getState().refreshLinkGraph({ ifChanged: true });
    const during = vaultRevision.mock.calls.length;
    const changed = { ...ADJ, tags: { "/v/wiki/new.md": ["synthetic"] } };
    latest.resolve(changed);
    await second;
    old.resolve(ADJ);
    await Promise.all([first, poll]);
    expect(during).toBe(0);
    expect(buildLinkGraph).toHaveBeenCalledTimes(2);
    expect(useVaultStore.getState().adjacency).toEqual(changed);
  });

  it("does not release a held periodic read when a newer forced refresh finishes", async () => {
    const { buildLinkGraph, vaultRevision } = stubIpc(150);
    useVaultStore.setState({ vaultToken: "synthetic-poll-before-forced" });
    const held = deferred<Awaited<ReturnType<typeof ipc.buildLinkGraph>>>();
    buildLinkGraph.mockReturnValueOnce(held.promise);
    const first = useVaultStore.getState().refreshLinkGraph({ ifChanged: true });
    await vi.waitFor(() => expect(buildLinkGraph).toHaveBeenCalled());
    await useVaultStore.getState().refreshLinkGraph();
    const follower = useVaultStore.getState().refreshLinkGraph({ ifChanged: true });
    const during = vaultRevision.mock.calls.length;
    held.resolve(ADJ);
    await Promise.all([first, follower]);
    expect(during).toBe(1);
    expect(buildLinkGraph).toHaveBeenCalledTimes(2);
  });

  it("does not start periodic reads during the native vault opening phase", async () => {
    const { buildLinkGraph, vaultRevision, listFiles } = stubIpc(149);
    useVaultStore.setState({ vaultToken: "synthetic-opening-poll", isOpeningVault: true });
    try {
      await useVaultStore.getState().refreshLinkGraph({ ifChanged: true });
      expect(vaultRevision).not.toHaveBeenCalled();
      expect(listFiles).not.toHaveBeenCalled();
      expect(buildLinkGraph).not.toHaveBeenCalled();
    } finally {
      useVaultStore.setState({ isOpeningVault: false });
    }
  });
});

describe("saveFile link-graph rebuilds", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useVaultStore.setState({ currentVault: VAULT, activeFile: null, adjacency: null, error: null });
    vi.spyOn(ipc, "writeFile").mockResolvedValue(null as never);
    vi.spyOn(ipc, "listFiles").mockResolvedValue([]);
    vi.spyOn(ipc, "vaultRevision").mockResolvedValue(1);
    vi.spyOn(ipc, "readFile").mockImplementation(async (path) => ({ path, raw: "", content: "", frontmatter: null }));
    vi.spyOn(ipc, "recordPageOpen").mockResolvedValue(null);
    stubEditorIpc();
  });

  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it("skips the rebuild when a save leaves the same wikilinks and tags", async () => {
    const P = "/v/wiki/guard-same.md";
    await admitBaseline(P);
    const build = vi.spyOn(ipc, "buildLinkGraph").mockResolvedValue(ADJ);
    // The first edit changes the admitted empty note's graph key.
    await useVaultStore.getState().saveFile(P, "---\ntags: [a]\n---\nsee [[b]]\n");
    await flush();
    expect(build).toHaveBeenCalledTimes(1);
    // Prose typing — 2s autosave, over and over. Same links, same tags.
    await useVaultStore.getState().saveFile(P, "---\ntags: [a]\n---\nsee [[b]] now\n");
    await useVaultStore.getState().saveFile(P, "---\ntags: [a]\n---\nsee [[b]] now!\n");
    await flush();
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("rebuilds when a wikilink or a tag changes", async () => {
    const P = "/v/wiki/guard-moved.md";
    await admitBaseline(P);
    const build = vi.spyOn(ipc, "buildLinkGraph").mockResolvedValue(ADJ);
    await useVaultStore.getState().saveFile(P, "see [[b]]\n");
    await flush();
    expect(build).toHaveBeenCalledTimes(1);
    // [[b]] -> [[c]] keeps the same length and can land inside one mtime tick,
    // which is exactly what the poll's fingerprint cannot see.
    await useVaultStore.getState().saveFile(P, "see [[c]]\n");
    await flush();
    expect(build).toHaveBeenCalledTimes(2);
    // Frontmatter tags feed the same graph payload (adjacency.tags).
    await useVaultStore.getState().saveFile(P, "---\ntags: [x]\n---\nsee [[c]]\n");
    await flush();
    expect(build).toHaveBeenCalledTimes(3);
  });

  it("still honours skipRefresh for bulk writers", async () => {
    const P = "/v/wiki/guard-skip.md";
    await admitBaseline(P);
    const build = vi.spyOn(ipc, "buildLinkGraph").mockResolvedValue(ADJ);
    await useVaultStore.getState().saveFile(P, "see [[b]]\n", { skipRefresh: true });
    await flush();
    expect(build).not.toHaveBeenCalled();
  });
});

describe("openWikilink (resolve or create)", () => {
  const tree = [
    { kind: "file" as const, name: "attention.md", path: "/v/wiki/attention.md" },
  ];
  beforeEach(() => {
    vi.restoreAllMocks();
    useVaultStore.setState({ currentVault: VAULT, fileTree: tree, adjacency: null, error: null });
    vi.spyOn(ipc, "buildLinkGraph").mockResolvedValue(ADJ);
    vi.spyOn(ipc, "vaultRevision").mockResolvedValue(1);
    vi.spyOn(ipc, "listFiles").mockResolvedValue(tree as never);
  });

  it("returns the existing page for a resolved link, creating nothing", async () => {
    const create = vi.spyOn(ipc, "createFile");
    const p = await useVaultStore.getState().openWikilink("attention");
    expect(p).toBe("/v/wiki/attention.md");
    expect(create).not.toHaveBeenCalled();
  });

  it("creates the note in wiki/ for an unresolved link and returns its path", async () => {
    vi.spyOn(ipc, "createFolder").mockResolvedValue("/v/wiki" as never);
    const create = vi.spyOn(ipc, "createFile").mockResolvedValue("/v/wiki/new-idea.md");
    const p = await useVaultStore.getState().openWikilink("new idea");
    // wiki/ ensured, file created from the sanitized target, path returned.
    expect(create).toHaveBeenCalledWith("/v/wiki", "new idea.md");
    expect(p).toBe("/v/wiki/new-idea.md");
  });

  it("honours an explicit contextDir (next to the current file)", async () => {
    const create = vi.spyOn(ipc, "createFile").mockResolvedValue("/v/wiki/sub/x.md");
    await useVaultStore.getState().openWikilink("x", "/v/wiki/sub");
    expect(create).toHaveBeenCalledWith("/v/wiki/sub", "x.md");
  });

  it("returns null when there is no open vault", async () => {
    useVaultStore.setState({ currentVault: null });
    expect(await useVaultStore.getState().openWikilink("x")).toBeNull();
  });
});

describe("saveFile / patchPages", () => {
  const A = "/v/wiki/a.md";
  const B = "/v/wiki/b.md";
  const files: Record<string, string> = {
    [A]: "---\ntype: concept\ntags:\n  - x\n---\nA\n",
    [B]: "---\ntype: entity\n---\nB\n",
  };
  beforeEach(() => {
    vi.restoreAllMocks();
    useVaultStore.setState({ currentVault: VAULT, adjacency: null, activeFile: null, error: null });
    vi.spyOn(ipc, "buildLinkGraph").mockResolvedValue(ADJ);
    vi.spyOn(ipc, "writeFile").mockResolvedValue(null);
    vi.spyOn(ipc, "readFile").mockImplementation(async (p) => ({
      path: p,
      raw: files[p],
      content: "",
      frontmatter: null,
    }));
    vi.spyOn(ipc, "recordPageOpen").mockResolvedValue(null);
    stubEditorIpc();
  });

  it("saveFile rebuilds the graph unless asked to skip", async () => {
    await admitBaseline(A);
    await useVaultStore.getState().saveFile(A, "x", { skipRefresh: true });
    expect(ipc.buildLinkGraph).not.toHaveBeenCalled();
    // A save that MOVES the graph (a new wikilink) rebuilds; an identical
    // re-save no longer does — see "saveFile link-graph rebuilds" above.
    await useVaultStore.getState().saveFile(A, "x [[new]]");
    expect(ipc.buildLinkGraph).toHaveBeenCalledTimes(1);
  });

  it("patchPages writes only the pages the patch changes, then refreshes once", async () => {
    useVaultStore.setState({
      activeFile: { path: A, raw: files[A], content: "", frontmatter: null },
    });
    await useVaultStore.getState().patchPages([A, B], () => ({ type: "entity" }));
    const patched = "---\ntype: entity\ntags:\n  - x\n---\nA\n";
    expect(ipc.writeFile).toHaveBeenCalledTimes(1);
    expect(ipc.writeFile).toHaveBeenCalledWith(A, patched);
    expect(ipc.buildLinkGraph).toHaveBeenCalledTimes(1);
    // The open note's baseline follows, so the reader can re-seed a clean draft.
    expect(useVaultStore.getState().activeFile?.raw).toBe(patched);
    expect(useVaultStore.getState().error).toBeNull();
  });

  it("patchPages stops at the first unreadable page and reports it", async () => {
    vi.spyOn(ipc, "readFile").mockRejectedValue(new Error("EACCES"));
    await useVaultStore.getState().patchPages([A, B], () => ({ type: "entity" }));
    expect(ipc.readFile).toHaveBeenCalledTimes(1);
    expect(ipc.writeFile).not.toHaveBeenCalled();
    expect(useVaultStore.getState().error).toBe("EACCES");
  });

  it("patchPages stops at the first failed write and skips the graph rebuild", async () => {
    vi.spyOn(ipc, "writeFile").mockRejectedValueOnce(new Error("EROFS"));
    await useVaultStore.getState().patchPages([A, B], () => ({ type: "x" }));
    expect(ipc.readFile).toHaveBeenCalledTimes(1);
    expect(ipc.writeFile).toHaveBeenCalledTimes(1);
    expect(useVaultStore.getState().error).toBe("EROFS");
    // Nothing landed on disk, so the link graph has nothing to pick up.
    expect(ipc.buildLinkGraph).not.toHaveBeenCalled();
  });
});

describe("deletePath / movePaths / favorites", () => {
  const A = "/v/wiki/a.md";
  beforeEach(() => {
    vi.restoreAllMocks();
    useVaultStore.setState({
      currentVault: VAULT,
      fileTree: [],
      adjacency: null,
      activeFile: null,
      favorites: [],
      error: null,
    });
    useUIStore.setState({ route: "overview", navHistory: { entries: ["overview"], idx: 0 } });
    vi.spyOn(ipc, "buildLinkGraph").mockResolvedValue(ADJ);
    vi.spyOn(ipc, "listFiles").mockResolvedValue([]);
    vi.spyOn(ipc, "readFile").mockImplementation(async (path) => ({ path, raw: "old", content: "old", frontmatter: null }));
    vi.spyOn(ipc, "recordPageOpen").mockResolvedValue(null);
    stubEditorIpc();
  });

  it("deletePath with a list deletes each, refreshes once and drops an open file under a deleted folder", async () => {
    const del = vi.spyOn(ipc, "deletePath").mockResolvedValue(null);
    useVaultStore.setState({
      activeFile: { path: "/v/wiki/sub/x.md", raw: "", content: "", frontmatter: null },
    });
    await useVaultStore.getState().deletePath([A, "/v/wiki/sub"]);
    expect(del).toHaveBeenCalledTimes(2);
    expect(del).toHaveBeenNthCalledWith(1, A);
    expect(del).toHaveBeenNthCalledWith(2, "/v/wiki/sub");
    expect(ipc.listFiles).toHaveBeenCalledTimes(1);
    expect(useVaultStore.getState().activeFile).toBeNull();
  });

  it("deletePath skips paths under a listed folder and still refreshes when a delete fails", async () => {
    const del = vi
      .spyOn(ipc, "deletePath")
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("EPERM"));
    await useVaultStore
      .getState()
      .deletePath(["/v/wiki/sub", "/v/wiki/sub/x.md", A]);
    expect(del).toHaveBeenCalledTimes(2);
    expect(del).toHaveBeenNthCalledWith(1, "/v/wiki/sub");
    expect(del).toHaveBeenNthCalledWith(2, A);
    expect(useVaultStore.getState().error).toBe("EPERM");
    expect(ipc.listFiles).toHaveBeenCalledTimes(1);
  });

  it("movePaths skips non-movable paths, follows the open note and replaces the route without a history entry", async () => {
    const move = vi
      .spyOn(ipc, "movePath")
      .mockImplementation(async (from, toDir) => `${toDir}/${from.split("/").pop()}`);
    useVaultStore.setState({
      activeFile: { path: A, raw: "", content: "", frontmatter: null },
      favorites: ["wiki/a.md", "wiki/b.md"],
    });
    useUIStore.setState({
      route: `page:${A}`,
      navHistory: { entries: ["overview", `page:${A}`], idx: 1 },
    });
    vi.spyOn(ipc, "saveFavorites").mockResolvedValue(null);
    // /v/notes/c.md already lives in the destination; /v/notes is the destination itself.
    await useVaultStore.getState().movePaths([A, "/v/notes/c.md", "/v/notes"], "/v/notes");
    expect(move).toHaveBeenCalledTimes(1);
    expect(move).toHaveBeenCalledWith(A, "/v/notes");
    expect(useVaultStore.getState().activeFile?.path).toBe("/v/notes/a.md");
    const ui = useUIStore.getState();
    expect(ui.route).toBe("page:/v/notes/a.md");
    expect(ui.navHistory).toEqual({ entries: ["overview", "page:/v/notes/a.md"], idx: 1 });
    expect(useVaultStore.getState().favorites).toEqual(["notes/a.md", "wiki/b.md"]);
    expect(ipc.saveFavorites).toHaveBeenCalledWith(["notes/a.md", "wiki/b.md"]);
    expect(ipc.listFiles).toHaveBeenCalledTimes(1);
  });

  it("renamePath carries a pending draft to the new path: one write, none to the old path", async () => {
    await admitBaseline(A);
    vi.spyOn(ipc, "renamePath").mockResolvedValue("/v/wiki/b.md");
    const write = vi.spyOn(ipc, "writeFile").mockResolvedValue(null);
    useVaultStore.setState({
      activeFile: { path: A, raw: "old", content: "old", frontmatter: null },
    });
    useUIStore.setState({ route: `page:${A}`, navHistory: { entries: [`page:${A}`], idx: 0 } });
    // The reader's autosave debounce is pending with unsaved keystrokes.
    pendingDrafts.set(A, "old + typed");
    expect(await useVaultStore.getState().renamePath(A, "b.md")).toBe("/v/wiki/b.md");
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("/v/wiki/b.md", "old + typed");
    // Consumed: the unmounting reader's flush has nothing left to write to A.
    expect(pendingDrafts.has(A)).toBe(false);
    // The remounted reader seeds from activeFile.raw, so the draft must be there.
    expect(useVaultStore.getState().activeFile).toMatchObject({ path: "/v/wiki/b.md", raw: "old + typed" });
    expect(useUIStore.getState().route).toBe("page:/v/wiki/b.md");
  });

  it("deletePath drops the pending draft so the reader cannot resurrect the file", async () => {
    vi.spyOn(ipc, "deletePath").mockResolvedValue(null);
    pendingDrafts.set(A, "typed");
    pendingDrafts.set("/v/wiki/other.md", "x");
    await useVaultStore.getState().deletePath(A);
    expect(pendingDrafts.has(A)).toBe(false);
    expect(pendingDrafts.get("/v/wiki/other.md")).toBe("x");
    pendingDrafts.clear();
  });

  it("movePaths leaves a pending draft of an unrelated note alone", async () => {
    vi.spyOn(ipc, "movePath").mockResolvedValue("/v/notes/a.md");
    const write = vi.spyOn(ipc, "writeFile").mockResolvedValue(null);
    pendingDrafts.set("/v/wiki/other.md", "x");
    await useVaultStore.getState().movePaths([A], "/v/notes");
    expect(write).not.toHaveBeenCalled();
    expect(pendingDrafts.get("/v/wiki/other.md")).toBe("x");
    pendingDrafts.clear();
  });

  it("movePathFollowing carries the draft, route and favorites of one page, refreshing nothing", async () => {
    await admitBaseline(A);
    // Tidy's "gather session summaries" moves pages one by one and refreshes
    // once at the end; each move must still follow the page like the sidebar's.
    const to = "/v/wiki/sessions/2026-09/a.md";
    vi.spyOn(ipc, "movePath").mockResolvedValue(to);
    const write = vi.spyOn(ipc, "writeFile").mockResolvedValue(null);
    vi.spyOn(ipc, "saveFavorites").mockResolvedValue(null);
    useVaultStore.setState({
      activeFile: { path: A, raw: "old", content: "old", frontmatter: null },
      favorites: ["wiki/a.md"],
    });
    useUIStore.setState({ route: `page:${A}`, navHistory: { entries: [`page:${A}`], idx: 0 } });
    pendingDrafts.set(A, "old + typed");
    expect(await movePathFollowing(A, "/v/wiki/sessions/2026-09")).toBe(to);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(to, "old + typed");
    expect(pendingDrafts.has(A)).toBe(false);
    expect(useVaultStore.getState().favorites).toEqual(["wiki/sessions/2026-09/a.md"]);
    expect(useUIStore.getState().route).toBe(`page:${to}`);
    expect(ipc.listFiles).not.toHaveBeenCalled();
    // A refusal is the caller's to report, not swallowed into `error`.
    vi.spyOn(ipc, "movePath").mockRejectedValueOnce(new Error("destination exists"));
    await expect(movePathFollowing("/v/wiki/b.md", "/v/notes")).rejects.toThrow(
      "destination exists",
    );
    expect(useVaultStore.getState().error).toBeNull();
    pendingDrafts.clear();
  });

  it("flushPendingDrafts writes every pending draft now, so its timer stands down", async () => {
    await admitBaseline(A);
    await admitBaseline("/v/wiki/other.md");
    const write = vi.spyOn(ipc, "writeFile").mockResolvedValue(null);
    pendingDrafts.set(A, "typed");
    pendingDrafts.set("/v/wiki/other.md", "x");
    await flushPendingDrafts();
    expect(write).toHaveBeenCalledWith(A, "typed");
    expect(write).toHaveBeenCalledWith("/v/wiki/other.md", "x");
    expect(pendingDrafts.size).toBe(0);
  });

  it("movePaths continues past a refused move and surfaces the error", async () => {
    vi.spyOn(ipc, "movePath")
      .mockRejectedValueOnce(new Error("destination exists"))
      .mockResolvedValueOnce("/v/notes/b.md");
    await useVaultStore.getState().movePaths([A, "/v/wiki/b.md"], "/v/notes");
    expect(ipc.movePath).toHaveBeenCalledTimes(2);
    expect(useVaultStore.getState().error).toBe("destination exists");
  });

  it("toggleFavorite adds then removes, saving vault-relative paths", async () => {
    const save = vi.spyOn(ipc, "saveFavorites").mockResolvedValue(null);
    await useVaultStore.getState().toggleFavorite(A);
    expect(useVaultStore.getState().favorites).toEqual(["wiki/a.md"]);
    expect(save).toHaveBeenLastCalledWith(["wiki/a.md"]);
    await useVaultStore.getState().toggleFavorite("/v/wiki/b.md");
    expect(save).toHaveBeenLastCalledWith(["wiki/a.md", "wiki/b.md"]);
    await useVaultStore.getState().toggleFavorite(A);
    expect(useVaultStore.getState().favorites).toEqual(["wiki/b.md"]);
    expect(save).toHaveBeenLastCalledWith(["wiki/b.md"]);
  });

  it("toggleFavorite reverts and reports when the save fails", async () => {
    vi.spyOn(ipc, "saveFavorites").mockRejectedValue(new Error("EROFS"));
    await useVaultStore.getState().toggleFavorite(A);
    expect(useVaultStore.getState().favorites).toEqual([]);
    expect(useVaultStore.getState().error).toBe("EROFS");
  });

  it("openVault reads favorites best-effort: corrupt JSON and non-strings are dropped", async () => {
    vi.spyOn(ipc, "openVault").mockResolvedValue(VAULT);
    const read = vi.spyOn(ipc, "readFile").mockResolvedValue({
      path: "/v/.myco/favorites.json",
      raw: "{not json",
      content: "",
      frontmatter: null,
    });
    await useVaultStore.getState().openVault("/v");
    expect(read).toHaveBeenCalledWith("/v/.myco/favorites.json");
    expect(useVaultStore.getState().favorites).toEqual([]);
    expect(useVaultStore.getState().error).toBeNull();

    read.mockResolvedValue({
      path: "/v/.myco/favorites.json",
      raw: '["wiki/a.md", 3, null]',
      content: "",
      frontmatter: null,
    });
    await useVaultStore.getState().openVault("/v");
    expect(useVaultStore.getState().favorites).toEqual(["wiki/a.md"]);
  });
});

describe("resolveWikilink", () => {
  // A deck is saved as cards/<stem>.md, the note's own name: a [[stem]] link
  // (and a card's source link) must still open the note, never the deck.
  it("skips cards/ so a deck never stands in for the note it is named after", () => {
    useVaultStore.setState({
      currentVault: VAULT,
      fileTree: [
        {
          kind: "directory",
          name: "cards",
          path: "/v/cards",
          children: [{ kind: "file", name: "attention.md", path: "/v/cards/attention.md" }],
        },
        {
          kind: "directory",
          name: "wiki",
          path: "/v/wiki",
          children: [{ kind: "file", name: "attention.md", path: "/v/wiki/attention.md" }],
        },
      ],
    });
    expect(useVaultStore.getState().resolveWikilink("attention")).toBe("/v/wiki/attention.md");
  });
});

describe("file reading ownership", () => {
  const path = "/v/sessions/2026-10/codex-synthetic.md";
  const nextPath = "/v/wiki/synthetic-current.md";
  const file = (at: string) => ({ path: at, raw: "Synthetic note", content: "Synthetic note", frontmatter: null });
  const missing = `canonicalize failed for ${path}: No such file or directory (os error 2)`;

  beforeEach(() => {
    vi.restoreAllMocks();
    pendingDrafts.clear();
    useVaultStore.setState({ currentVault: VAULT });
    useUIStore.setState({ route: "overview", navHistory: { entries: ["overview"], idx: 0 }, splitRoute: null });
    vi.spyOn(ipc, "recordPageOpen").mockResolvedValue(null);
    vi.spyOn(ipc, "listFiles").mockResolvedValue([]);
    vi.spyOn(ipc, "buildLinkGraph").mockResolvedValue(ADJ);
    stubEditorIpc();
  });

  it.each(["success", "error"] as const)("ignores an older session read's %s after another note opens", async (result) => {
    const older = deferred<ReturnType<typeof file>>();
    vi.spyOn(ipc, "readFile").mockReturnValueOnce(older.promise).mockResolvedValueOnce(file(nextPath));
    const reading = useVaultStore.getState().openFile(path);
    await vi.waitFor(() => expect(ipc.readFile).toHaveBeenCalledTimes(1));
    await useVaultStore.getState().openFile(nextPath);
    if (result === "success") older.resolve(file(path));
    else older.reject(new Error(missing));
    expect(await reading).toBeUndefined();
    expect(useVaultStore.getState()).toMatchObject({ activeFile: file(nextPath), error: null, isLoading: false });
    expect(ipc.recordPageOpen).toHaveBeenCalledTimes(1);
    expect(ipc.recordPageOpen).toHaveBeenCalledWith(VAULT.path, "wiki/synthetic-current.md");
  });

  it("does not let an older failure finish the next note's loading state", async () => {
    const older = deferred<ReturnType<typeof file>>();
    const newer = deferred<ReturnType<typeof file>>();
    vi.spyOn(ipc, "readFile").mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const first = useVaultStore.getState().openFile(path);
    await vi.waitFor(() => expect(ipc.readFile).toHaveBeenCalledTimes(1));
    const second = useVaultStore.getState().openFile(nextPath);
    await vi.waitFor(() => expect(ipc.readFile).toHaveBeenCalledTimes(2));
    older.reject(new Error(missing));
    await first;
    expect(useVaultStore.getState()).toMatchObject({ activeFile: null, error: null, isLoading: true });
    newer.resolve(file(nextPath));
    await second;
    expect(useVaultStore.getState().activeFile?.path).toBe(nextPath);
  });

  it.each(["success", "error"] as const)("invalidates a held session read's %s when its folder is deleted", async (result) => {
    const older = deferred<ReturnType<typeof file>>();
    vi.spyOn(ipc, "readFile").mockReturnValueOnce(older.promise);
    vi.spyOn(ipc, "deletePath").mockResolvedValue(null);
    const reading = useVaultStore.getState().openFile(path);
    await vi.waitFor(() => expect(ipc.readFile).toHaveBeenCalledTimes(1));
    await useVaultStore.getState().deletePath("/v/sessions/2026-10");
    if (result === "success") older.resolve(file(path));
    else older.reject(new Error(missing));
    expect(await reading).toBeUndefined();
    expect(useVaultStore.getState()).toMatchObject({ activeFile: null, error: null, isLoading: false });
    expect(ipc.recordPageOpen).not.toHaveBeenCalled();
  });

  it.each(["success", "error"] as const)("invalidates a held session read's %s when its folder moves", async (result) => {
    const moved = "/v/sessions/archive/2026-10";
    const movedPath = `${moved}/codex-synthetic.md`;
    const older = deferred<ReturnType<typeof file>>();
    vi.spyOn(ipc, "readFile").mockReturnValueOnce(older.promise);
    vi.spyOn(ipc, "movePath").mockResolvedValue(moved);
    useVaultStore.setState({ activeFile: file(path) });
    useUIStore.getState().setRoute(`page:${path}`);
    const reading = useVaultStore.getState().openFile(path);
    await vi.waitFor(() => expect(ipc.readFile).toHaveBeenCalledTimes(1));
    await movePathFollowing("/v/sessions/2026-10", "/v/sessions/archive");
    if (result === "success") older.resolve(file(path));
    else older.reject(new Error(missing));
    expect(await reading).toBeUndefined();
    expect(useVaultStore.getState()).toMatchObject({ activeFile: file(movedPath), error: null, isLoading: false });
    expect(useUIStore.getState().route).toBe(`page:${movedPath}`);
    expect(ipc.recordPageOpen).not.toHaveBeenCalled();
  });

  it("keeps a pending read valid when an unrelated folder is deleted", async () => {
    const current = deferred<ReturnType<typeof file>>();
    vi.spyOn(ipc, "readFile").mockReturnValueOnce(current.promise);
    vi.spyOn(ipc, "deletePath").mockResolvedValue(null);
    const reading = useVaultStore.getState().openFile(nextPath);
    await vi.waitFor(() => expect(ipc.readFile).toHaveBeenCalledTimes(1));
    await useVaultStore.getState().deletePath("/v/sessions/2026-10");
    expect(useVaultStore.getState().isLoading).toBe(true);
    current.resolve(file(nextPath));
    expect(await reading).toBeNull();
    expect(useVaultStore.getState().activeFile?.path).toBe(nextPath);
  });

  it.each(["delete", "move"] as const)("keeps a pending read valid when its folder's %s fails", async (change) => {
    const current = deferred<ReturnType<typeof file>>();
    vi.spyOn(ipc, "readFile").mockReturnValueOnce(current.promise);
    const reading = useVaultStore.getState().openFile(path);
    await vi.waitFor(() => expect(ipc.readFile).toHaveBeenCalledTimes(1));
    const refusal = new Error("Synthetic path change refused");
    if (change === "delete") {
      vi.spyOn(ipc, "deletePath").mockRejectedValueOnce(refusal);
      await useVaultStore.getState().deletePath("/v/sessions/2026-10");
      expect(useVaultStore.getState().error).toBe(refusal.message);
    } else {
      vi.spyOn(ipc, "movePath").mockRejectedValueOnce(refusal);
      await expect(movePathFollowing("/v/sessions/2026-10", "/v/sessions/archive")).rejects.toBe(refusal);
    }
    expect(useVaultStore.getState().isLoading).toBe(true);
    current.resolve(file(path));
    expect(await reading).toBeNull();
    expect(useVaultStore.getState().activeFile?.path).toBe(path);
    expect(ipc.recordPageOpen).toHaveBeenCalledWith(VAULT.path, "sessions/2026-10/codex-synthetic.md");
  });

  it.each([missing, "read failed: Permission denied (os error 13)"])("returns a current read error to its reader instead of the sidebar: %s", async (message) => {
    vi.spyOn(ipc, "readFile").mockRejectedValueOnce(new Error(message));
    expect(await useVaultStore.getState().openFile(path)).toBe(message);
    expect(useVaultStore.getState()).toMatchObject({ activeFile: null, error: null, isLoading: false });
  });
});

describe("vault opening ownership", () => {
  const next = { path: "/synthetic/next", name: "Synthetic next" };

  beforeEach(() => {
    vi.restoreAllMocks();
    useVaultStore.setState({
      currentVault: VAULT,
      fileTree: [{ kind: "file", name: "old.md", path: "/v/wiki/old.md" }],
      activeFile: { path: "/v/wiki/old.md", raw: "old", content: "old", frontmatter: null },
      adjacency: ADJ,
      favorites: ["wiki/old.md"],
      revision: 42,
      lastSavedAt: 42,
    });
    vi.spyOn(ipc, "openVault").mockResolvedValue(next);
    vi.spyOn(ipc, "listFiles").mockResolvedValue([]);
    vi.spyOn(ipc, "buildLinkGraph").mockResolvedValue(ADJ);
    vi.spyOn(ipc, "readFile").mockResolvedValue({
      path: `${next.path}/.myco/favorites.json`, raw: "[]", content: "[]", frontmatter: null,
    });
    stubEditorIpc();
  });

  it("invalidates panel requests before the native open returns", async () => {
    const previous = useVaultStore.getState().vaultToken;
    let finish!: (meta: typeof next) => void;
    vi.mocked(ipc.openVault).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = useVaultStore.getState().openVault(next.path);
    const token = useVaultStore.getState().vaultToken;
    finish(next);
    await pending;
    expect(token).toEqual(expect.any(String));
    expect(token).not.toBe(previous);
    expect(useVaultStore.getState().vaultToken).toBe(token);
  });

  it("does not reuse a panel session when the same vault is reopened", async () => {
    const previous = useVaultStore.getState().vaultToken;
    await useVaultStore.getState().openVault(next.path);
    const middle = useVaultStore.getState().vaultToken;
    vi.mocked(ipc.openVault).mockResolvedValueOnce(VAULT);
    await useVaultStore.getState().openVault(VAULT.path);
    expect(new Set([previous, middle, useVaultStore.getState().vaultToken]).size).toBe(3);
    expect(useVaultStore.getState().currentVault).toEqual(VAULT);
  });

  it("keeps failed opens from reviving the previous panel session", async () => {
    const previous = useVaultStore.getState().vaultToken;
    vi.mocked(ipc.openVault).mockRejectedValueOnce(new Error("Synthetic open failure"));
    await useVaultStore.getState().openVault(next.path);
    expect(useVaultStore.getState().vaultToken).not.toBe(previous);
    expect(useVaultStore.getState().currentVault).toEqual(VAULT);
  });

  it("keeps the reset token when an earlier opening completes", async () => {
    let finish!: (meta: typeof next) => void;
    vi.mocked(ipc.openVault).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = useVaultStore.getState().openVault(next.path);
    const openingToken = useVaultStore.getState().vaultToken;
    useVaultStore.getState().reset();
    const resetToken = useVaultStore.getState().vaultToken;
    finish(next);
    await pending;
    expect(resetToken).not.toBe(openingToken);
    expect(useVaultStore.getState().vaultToken).toBe(resetToken);
    expect(useVaultStore.getState().currentVault).toBeNull();
  });

  it("marks the native opening phase before its IPC returns", async () => {
    let finish!: (meta: typeof next) => void;
    vi.mocked(ipc.openVault).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = useVaultStore.getState().openVault(next.path);
    const during = useVaultStore.getState();
    finish(next);
    await pending;
    expect(during.isOpeningVault).toBe(true);
    expect(during.currentVault).toEqual(VAULT);
    expect(useVaultStore.getState().isOpeningVault).toBe(false);
  });

  it("publishes the native root before waiting for its tree and drops old derived state", async () => {
    let finish!: (tree: Awaited<ReturnType<typeof ipc.listFiles>>) => void;
    vi.mocked(ipc.listFiles).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = useVaultStore.getState().openVault(next.path);
    await vi.waitFor(() => expect(ipc.listFiles).toHaveBeenCalled());
    const during = useVaultStore.getState();
    finish([]);
    await pending;
    expect(during).toMatchObject({
      currentVault: next, fileTree: [], activeFile: null, adjacency: null,
      favorites: [], revision: null, lastSavedAt: null, isOpeningVault: true,
    });
  });

  it.each(["listFiles", "buildLinkGraph"] as const)("keeps the accepted native root when %s fails", async (method) => {
    vi.mocked(ipc[method]).mockRejectedValueOnce(new Error("Synthetic follow-up failure"));
    await useVaultStore.getState().openVault(next.path);
    expect(useVaultStore.getState()).toMatchObject({
      currentVault: next, fileTree: [], activeFile: null, adjacency: null,
      isOpeningVault: false, isLoading: false, error: "Synthetic follow-up failure",
    });
  });

  it("keeps the previous root when native opening is rejected", async () => {
    vi.mocked(ipc.openVault).mockRejectedValueOnce(new Error("Synthetic permission denied"));
    await useVaultStore.getState().openVault(next.path);
    expect(useVaultStore.getState()).toMatchObject({
      currentVault: VAULT, isOpeningVault: false, isLoading: false, error: "Synthetic permission denied",
    });
    expect(ipc.listFiles).not.toHaveBeenCalled();
  });

  it("does not let an older tree read finish the latest opening phase", async () => {
    const first = { path: "/synthetic/first", name: "Synthetic first" };
    let finishTree!: (tree: Awaited<ReturnType<typeof ipc.listFiles>>) => void;
    let finishOpen!: (meta: typeof next) => void;
    vi.mocked(ipc.openVault).mockResolvedValueOnce(first)
      .mockImplementationOnce(() => new Promise((resolve) => { finishOpen = resolve; }));
    vi.mocked(ipc.listFiles).mockImplementationOnce(() => new Promise((resolve) => { finishTree = resolve; }));
    const older = useVaultStore.getState().openVault(first.path);
    await vi.waitFor(() => expect(ipc.listFiles).toHaveBeenCalled());
    const latest = useVaultStore.getState().openVault(next.path);
    finishTree([]);
    await older;
    const during = useVaultStore.getState();
    finishOpen(next);
    await latest;
    expect(during.isOpeningVault).toBe(true);
    expect(during.currentVault).toEqual(first);
    expect(useVaultStore.getState()).toMatchObject({ currentVault: next, isOpeningVault: false });
  });

  it("does not reopen a reset vault when an earlier tree read completes", async () => {
    let finish!: (tree: Awaited<ReturnType<typeof ipc.listFiles>>) => void;
    vi.mocked(ipc.listFiles).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = useVaultStore.getState().openVault(next.path);
    await vi.waitFor(() => expect(ipc.listFiles).toHaveBeenCalled());
    useVaultStore.getState().reset();
    finish([]);
    await pending;
    expect(useVaultStore.getState()).toMatchObject({ currentVault: null, isOpeningVault: false, isLoading: false });
  });

  it("keeps ordinary file loading separate from vault opening", async () => {
    let finish!: (file: Awaited<ReturnType<typeof ipc.readFile>>) => void;
    vi.mocked(ipc.readFile).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    vi.spyOn(ipc, "recordPageOpen").mockResolvedValue(null);
    const pending = useVaultStore.getState().openFile("/v/wiki/note.md");
    const during = useVaultStore.getState();
    await vi.waitFor(() => expect(finish).toEqual(expect.any(Function)));
    finish({ path: "/v/wiki/note.md", raw: "note", content: "note", frontmatter: null });
    await pending;
    expect(during.isLoading).toBe(true);
    expect(during.isOpeningVault).toBe(false);
  });

  it.each(["success", "error"] as const)("drops a previous vault's late file-read %s during opening", async (result) => {
    let finishRead!: (file: Awaited<ReturnType<typeof ipc.readFile>>) => void;
    let failRead!: (error: Error) => void;
    let failTree!: (error: Error) => void;
    vi.mocked(ipc.readFile).mockImplementationOnce(() => new Promise((resolve, reject) => {
      finishRead = resolve;
      failRead = reject;
    }));
    vi.mocked(ipc.listFiles).mockImplementationOnce(() => new Promise((_, reject) => { failTree = reject; }));
    const opened = vi.spyOn(ipc, "recordPageOpen").mockResolvedValue(null);
    const reading = useVaultStore.getState().openFile("/v/wiki/old.md");
    await vi.waitFor(() => expect(finishRead).toEqual(expect.any(Function)));
    const opening = useVaultStore.getState().openVault(next.path);
    await vi.waitFor(() => expect(ipc.listFiles).toHaveBeenCalled());
    if (result === "success") {
      finishRead({ path: "/v/wiki/old.md", raw: "old", content: "old", frontmatter: null });
    } else {
      failRead(new Error("Synthetic previous read failure"));
    }
    await reading;
    const during = useVaultStore.getState();
    failTree(new Error("Synthetic current tree failure"));
    await opening;
    expect(during).toMatchObject({
      currentVault: next, activeFile: null, isOpeningVault: true, isLoading: true, error: null,
    });
    expect(useVaultStore.getState()).toMatchObject({
      currentVault: next, activeFile: null, isOpeningVault: false, isLoading: false,
      error: "Synthetic current tree failure",
    });
    expect(opened).not.toHaveBeenCalled();
  });
});

describe("native vault transition ordering", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(ipc, "closeVault").mockResolvedValue();
    vi.spyOn(ipc, "listFiles").mockResolvedValue([]);
    vi.spyOn(ipc, "buildLinkGraph").mockResolvedValue(ADJ);
    vi.spyOn(ipc, "readFile").mockResolvedValue({ path: "/synthetic/.myco/favorites.json", raw: "[]", content: "[]", frontmatter: null });
  });

  it("invalidates native work when the frontend closes its vault", async () => {
    useVaultStore.setState({ currentVault: VAULT });
    useVaultStore.getState().reset();
    await Promise.resolve();
    expect(ipc.closeVault).toHaveBeenCalledTimes(1);
    expect(useVaultStore.getState().currentVault).toBeNull();
  });

  it("finishes an old open and closes it before dispatching a new open", async () => {
    const old = deferred<typeof VAULT>();
    const close = deferred<void>();
    const opens = vi.spyOn(ipc, "openVault")
      .mockImplementationOnce(() => old.promise)
      .mockResolvedValueOnce({ path: "/synthetic/next", name: "next" });
    vi.mocked(ipc.closeVault).mockImplementationOnce(() => close.promise);
    const previous = useVaultStore.getState().openVault(VAULT.path);
    useVaultStore.getState().reset();
    const latest = useVaultStore.getState().openVault("/synthetic/next");
    try {
      expect(opens).toHaveBeenCalledTimes(1);
      old.resolve(VAULT);
      await previous;
      await Promise.resolve();
      expect(opens).toHaveBeenCalledTimes(1);
      expect(ipc.closeVault).toHaveBeenCalledTimes(1);
    } finally {
      old.resolve(VAULT);
      close.resolve();
      await Promise.all([previous, latest]);
    }
    expect(opens).toHaveBeenNthCalledWith(2, "/synthetic/next");
    expect(useVaultStore.getState().currentVault?.path).toBe("/synthetic/next");
  });
});
