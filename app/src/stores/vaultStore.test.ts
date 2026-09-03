import { beforeEach, describe, expect, it, vi } from "vitest";
import { pendingDrafts, useVaultStore } from "./vaultStore";
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

function stubIpc(revision: number) {
  const buildLinkGraph = vi.fn().mockResolvedValue(ADJ);
  const vaultRevision = vi.fn().mockResolvedValue(revision);
  vi.spyOn(ipc, "buildLinkGraph").mockImplementation(buildLinkGraph);
  vi.spyOn(ipc, "vaultRevision").mockImplementation(vaultRevision);
  return { buildLinkGraph, vaultRevision };
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

  it("does not skip when the fingerprint matches but no graph is loaded", async () => {
    const { buildLinkGraph } = stubIpc(42);
    await useVaultStore.getState().refreshLinkGraph({ ifChanged: true });
    // A vault switch clears the graph; the baseline must not paper over that.
    useVaultStore.setState({ adjacency: null });
    await useVaultStore.getState().refreshLinkGraph({ ifChanged: true });
    expect(buildLinkGraph).toHaveBeenCalledTimes(2);
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
  });

  it("saveFile rebuilds the graph unless asked to skip", async () => {
    await useVaultStore.getState().saveFile(A, "x", { skipRefresh: true });
    expect(ipc.buildLinkGraph).not.toHaveBeenCalled();
    await useVaultStore.getState().saveFile(A, "x");
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

  it("movePaths leaves a pending draft of an unrelated note alone", async () => {
    vi.spyOn(ipc, "movePath").mockResolvedValue("/v/notes/a.md");
    const write = vi.spyOn(ipc, "writeFile").mockResolvedValue(null);
    pendingDrafts.set("/v/wiki/other.md", "x");
    await useVaultStore.getState().movePaths([A], "/v/notes");
    expect(write).not.toHaveBeenCalled();
    expect(pendingDrafts.get("/v/wiki/other.md")).toBe("x");
    pendingDrafts.clear();
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
