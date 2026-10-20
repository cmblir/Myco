import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileNode, VaultMeta } from "../lib/ipc";
import { serializeDeck, type Card } from "../lib/cards";

const { readFile, searchVault, vaultState } = vi.hoisted(() => ({
  readFile: vi.fn(),
  searchVault: vi.fn(),
  vaultState: {
    currentVault: null as VaultMeta | null,
    vaultToken: "synthetic-opening-a",
    isOpeningVault: false,
    fileTree: [] as FileNode[],
    resolveWikilink: (_stem: string): string | null => null,
  },
}));
vi.mock("../lib/ipc", () => ({ ipc: { readFile, searchVault } }));
vi.mock("./vaultStore", () => ({ useVaultStore: { getState: () => vaultState } }));

import { useStudyStore } from "./studyStore";

const grounded: Card = { front: "Synthetic question", back: "Synthetic answer", sourceRef: "[[note]]", state: null };
const file = (path: string, raw: string) => ({ path, raw, content: raw, frontmatter: null });
function openVault(root: string): void {
  vaultState.currentVault = { path: root, name: root.split("/").pop() ?? "vault" };
  vaultState.vaultToken = `synthetic-opening:${root}`;
  vaultState.isOpeningVault = false;
  vaultState.fileTree = [{ kind: "directory", name: "cards", path: `${root}/cards`, children: [
    { kind: "file", name: "deck.md", path: `${root}/cards/deck.md` },
  ] }];
  vaultState.resolveWikilink = () => `${root}/note.md`;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  readFile.mockReset();
  searchVault.mockReset().mockResolvedValue([]);
  openVault("/synthetic/a");
  readFile.mockImplementation((path: string) => Promise.resolve(file(path,
    path.includes("/cards/") ? serializeDeck([grounded]) : "Synthetic answer")));
  useStudyStore.setState({ decks: [], dueTotal: 0, loading: false, error: null, loadedPath: null });
});

describe("Study refresh retains its original vault opening", () => {
  function replaceOpening(transition: string): void {
    if (transition === "same-path-reopen") {
      vaultState.vaultToken = "synthetic-opening-b";
    } else {
      vaultState.isOpeningVault = true;
    }
  }

  it("does not read decks or sources while a vault opening is pending", async () => {
    vaultState.isOpeningVault = true;

    await useStudyStore.getState().refresh();

    expect(readFile).not.toHaveBeenCalled();
    expect(searchVault).not.toHaveBeenCalled();
    expect(useStudyStore.getState()).toMatchObject({
      decks: [], dueTotal: 0, loadedPath: null, error: null, loading: false,
    });
  });

  it.each(["same-path-reopen", "opening-started"])(
    "%s during a deck read prevents grounding reads and adopting the old result",
    async (transition) => {
      const pending = deferred<ReturnType<typeof file>>();
      readFile.mockReturnValueOnce(pending.promise);
      const run = useStudyStore.getState().refresh();

      replaceOpening(transition);
      pending.resolve(file("/synthetic/a/cards/deck.md", serializeDeck([grounded])));
      await run;

      expect(readFile).toHaveBeenCalledTimes(1);
      expect(searchVault).not.toHaveBeenCalled();
      expect(useStudyStore.getState()).toMatchObject({
        decks: [], dueTotal: 0, loadedPath: null, error: null, loading: false,
      });
    },
  );

  it.each(["same-path-reopen", "opening-started"])(
    "%s during a source read prevents adopting the old grounded count",
    async (transition) => {
      const pending = deferred<ReturnType<typeof file>>();
      readFile.mockImplementation((path: string) => path.includes("/cards/")
        ? Promise.resolve(file(path, serializeDeck([grounded])))
        : pending.promise);
      const run = useStudyStore.getState().refresh();
      await vi.waitFor(() => expect(readFile).toHaveBeenCalledTimes(2));

      replaceOpening(transition);
      pending.resolve(file("/synthetic/a/note.md", "Synthetic answer"));
      await run;

      expect(useStudyStore.getState()).toMatchObject({
        decks: [], dueTotal: 0, loadedPath: null, error: null, loading: false,
      });
    },
  );

  it("ignores an old opening's late grounding read failure", async () => {
    const pending = deferred<ReturnType<typeof file>>();
    readFile.mockImplementation((path: string) => path.includes("/cards/")
      ? Promise.resolve(file(path, serializeDeck([grounded])))
      : pending.promise);
    const run = useStudyStore.getState().refresh();
    await vi.waitFor(() => expect(readFile).toHaveBeenCalledTimes(2));

    replaceOpening("same-path-reopen");
    pending.reject(new Error("Synthetic previous-opening source failure"));
    await run;

    expect(useStudyStore.getState()).toMatchObject({
      decks: [], dueTotal: 0, loadedPath: null, error: null, loading: false,
    });
  });

  it("does not read citation search hits after the originating opening is replaced", async () => {
    const pending = deferred<{ path: string }[]>();
    readFile.mockResolvedValueOnce(file("/synthetic/a/cards/deck.md",
      serializeDeck([{ ...grounded, sourceRef: "[^src-synthetic]" }])));
    searchVault.mockReturnValueOnce(pending.promise);
    const run = useStudyStore.getState().refresh();
    await vi.waitFor(() => expect(searchVault).toHaveBeenCalledOnce());

    replaceOpening("same-path-reopen");
    pending.resolve([{ path: "/synthetic/a/wiki/citing-note.md" }]);
    await run;

    expect(readFile).toHaveBeenCalledTimes(1);
    expect(useStudyStore.getState()).toMatchObject({
      decks: [], dueTotal: 0, loadedPath: null, error: null, loading: false,
    });
  });

  it("an old opening settling cannot clear the newer opening's pending refresh", async () => {
    const oldDeck = deferred<ReturnType<typeof file>>();
    const newDeck = deferred<ReturnType<typeof file>>();
    readFile.mockReturnValueOnce(oldDeck.promise).mockReturnValueOnce(newDeck.promise);
    const oldRun = useStudyStore.getState().refresh();
    replaceOpening("same-path-reopen");
    const newRun = useStudyStore.getState().refresh();

    oldDeck.resolve(file("/synthetic/a/cards/deck.md", serializeDeck([grounded])));
    await oldRun;

    expect(readFile).toHaveBeenCalledTimes(2);
    expect(useStudyStore.getState()).toMatchObject({
      decks: [], dueTotal: 0, loadedPath: null, error: null, loading: true,
    });

    newDeck.resolve(file("/synthetic/a/cards/deck.md", serializeDeck([grounded])));
    await newRun;

    expect(useStudyStore.getState()).toMatchObject({
      dueTotal: 1, loadedPath: "/synthetic/a", error: null, loading: false,
    });
  });
});

describe("Study refresh recovery and vault ownership", () => {
  it("reports an unreadable deck instead of treating it as an empty successful scan", async () => {
    readFile.mockRejectedValue(new Error("Synthetic deck read failure"));
    await useStudyStore.getState().refresh();
    expect(useStudyStore.getState().error).toContain("Synthetic deck read failure");
    expect(useStudyStore.getState().dueTotal).toBe(0);
    expect(useStudyStore.getState().loading).toBe(false);
  });

  it("reports failed grounding reads instead of labelling the source as ungrounded", async () => {
    readFile.mockImplementation((path: string) => path.includes("/cards/")
      ? Promise.resolve(file(path, serializeDeck([grounded])))
      : Promise.reject(new Error("Synthetic source read failure")));
    await useStudyStore.getState().refresh();
    expect(useStudyStore.getState().error).toContain("Synthetic source read failure");
    expect(useStudyStore.getState().decks).toEqual([]);
  });

  it("clears the error on a successful retry and restores the grounded due count", async () => {
    readFile.mockRejectedValueOnce(new Error("Synthetic transient failure"));
    await useStudyStore.getState().refresh();
    expect(useStudyStore.getState().error).toBeTruthy();
    await useStudyStore.getState().refresh();
    expect(useStudyStore.getState()).toMatchObject({ error: null, dueTotal: 1, loadedPath: "/synthetic/a", loading: false });
  });

  it("rejects a late refresh from a vault that has been replaced", async () => {
    const old = deferred<ReturnType<typeof file>>();
    readFile.mockImplementation((path: string) => path === "/synthetic/a/cards/deck.md"
      ? old.promise : Promise.resolve(file(path, path.includes("/cards/") ? serializeDeck([grounded]) : "Synthetic answer")));
    const previous = useStudyStore.getState().refresh();
    openVault("/synthetic/b");
    await useStudyStore.getState().refresh();
    old.resolve(file("/synthetic/a/cards/deck.md", serializeDeck([grounded, { ...grounded, front: "Old extra question" }])));
    await previous;
    expect(useStudyStore.getState()).toMatchObject({ loadedPath: "/synthetic/b", dueTotal: 1, loading: false });
    expect(useStudyStore.getState().decks[0].path).toBe("/synthetic/b/cards/deck.md");
  });

  it("keeps the latest refresh when an earlier scan of the same vault finishes later", async () => {
    const old = deferred<ReturnType<typeof file>>();
    readFile.mockReturnValueOnce(old.promise);
    const previous = useStudyStore.getState().refresh();
    await useStudyStore.getState().refresh();
    old.resolve(file("/synthetic/a/cards/deck.md", serializeDeck([grounded, { ...grounded, front: "Old extra question" }])));
    await previous;
    expect(useStudyStore.getState()).toMatchObject({ dueTotal: 1, loadedPath: "/synthetic/a", error: null, loading: false });
  });

  it("clears counts when no vault is open and ignores the previous pending result", async () => {
    const old = deferred<ReturnType<typeof file>>();
    readFile.mockReturnValueOnce(old.promise);
    const previous = useStudyStore.getState().refresh();
    vaultState.currentVault = null;
    vaultState.fileTree = [];
    await useStudyStore.getState().refresh();
    old.resolve(file("/synthetic/a/cards/deck.md", serializeDeck([grounded])));
    await previous;
    expect(useStudyStore.getState()).toMatchObject({ decks: [], dueTotal: 0, loading: false, error: null, loadedPath: null });
  });
});
