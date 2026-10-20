import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { ipc } from "../lib/ipc";
import { pendingDrafts, useVaultStore } from "./vaultStore";
import { useUIStore } from "./uiStore";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

let serial = 0;
let path: string;
const original = "# Synthetic note\n\nOriginal\n";
const edited = "# Synthetic note\n\nEdited\n";
const latest = "# Synthetic note\n\nLatest\n";

// Legacy queue tests retain their original deferred read/write spies behind
// explicit synthetic editor DTOs. Native authority/CAS has separate regressions.
async function admitBaseline(target: string): Promise<void> {
  const active = useVaultStore.getState().activeFile;
  expect(await useVaultStore.getState().openFile(target)).toBeNull();
  useVaultStore.setState({ activeFile: active });
}

beforeEach(async () => {
  vi.restoreAllMocks();
  pendingDrafts.clear();
  path = `/save-test/wiki/note-${++serial}.md`;
  useVaultStore.setState({
    currentVault: { path: "/save-test", name: "Synthetic" },
    activeFile: { path, raw: original, content: original, frontmatter: null },
    adjacency: null,
    favorites: [],
    error: null,
  });
  useUIStore.setState({ route: `page:${path}`, navHistory: { entries: [`page:${path}`], idx: 0 } });
  vi.spyOn(ipc, "listFiles").mockResolvedValue([]);
  vi.spyOn(ipc, "buildLinkGraph").mockResolvedValue({ forward: {}, backward: {}, unresolved: {}, tags: {} });
  vi.spyOn(ipc, "recordPageOpen").mockResolvedValue(null);
  vi.spyOn(ipc, "readFile").mockImplementation(async (readPath) => ({ path: readPath, raw: original, content: original, frontmatter: null }));
  const origin = { vaultPath: "/save-test", openingToken: `synthetic-save-${serial}` };
  vi.spyOn(ipc, "agentVaultSession").mockResolvedValue(origin);
  // This legacy queue fixture exercises the explicitly unsupported-journal route.
  // Native-supported checkpoint/restart behavior has separate focused tests.
  vi.spyOn(ipc, "editorRecoverySupported").mockResolvedValue(false);
  vi.spyOn(ipc, "readEditorFile").mockImplementation(async (target) => {
    const file = await ipc.readFile(target);
    return { file, origin, revision: createHash("sha256").update(file.raw).digest("hex"), mockOnly: true as const };
  });
  vi.spyOn(ipc, "writeEditorFile").mockImplementation(async (target, content, _expected, captured) => {
    await ipc.writeFile(target, content);
    return { path: target, origin: captured, revision: createHash("sha256").update(content).digest("hex"), mockOnly: true as const };
  });
  await admitBaseline(path);
});

describe("editor save recovery", () => {
  it("records when a write lands, and a failed write leaves the last time alone", async () => {
    useVaultStore.setState({ lastSavedAt: null });
    vi.spyOn(ipc, "writeFile").mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("EROFS synthetic"));
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    expect(await useVaultStore.getState().saveFile(path, edited)).toBe(true);
    expect(useVaultStore.getState().lastSavedAt).toBe(1_700_000_000_000);
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_999_000);
    expect(await useVaultStore.getState().saveFile(path, latest)).toBe(false);
    expect(useVaultStore.getState().lastSavedAt).toBe(1_700_000_000_000);
  });

  it("reports failure and keeps the draft through a reopen until retry succeeds", async () => {
    const write = vi.spyOn(ipc, "writeFile").mockRejectedValueOnce(new Error("EROFS synthetic")).mockResolvedValue(null);
    pendingDrafts.set(path, edited);
    expect(await useVaultStore.getState().saveFile(path, edited)).toBe(false);
    expect(pendingDrafts.get(path)).toBe(edited);
    expect(useVaultStore.getState().activeFile?.raw).toBe(original);
    await useVaultStore.getState().openFile(path);
    expect(pendingDrafts.get(path)).toBe(edited);
    expect(await useVaultStore.getState().saveFile(path, edited)).toBe(true);
    expect(pendingDrafts.has(path)).toBe(false);
    expect(useVaultStore.getState().activeFile?.raw).toBe(edited);
    expect(write).toHaveBeenCalledTimes(2);
  });

  // The reader keys its save banner on the activeFile object: after an undo
  // back to the disk text, the confirmed write changes no `raw`, and a reader
  // reopened meanwhile (split closed) only learns the write landed from this.
  it("a confirmed write republishes the open note even when its text is unchanged", async () => {
    vi.spyOn(ipc, "writeFile").mockResolvedValue(null);
    pendingDrafts.set(path, original);
    const before = useVaultStore.getState().activeFile;
    expect(await useVaultStore.getState().saveFile(path, original)).toBe(true);
    expect(pendingDrafts.has(path)).toBe(false);
    expect(useVaultStore.getState().activeFile?.raw).toBe(original);
    expect(useVaultStore.getState().activeFile).not.toBe(before);
  });

  it("does not remove newer typing when an earlier write succeeds", async () => {
    const first = deferred<null>();
    const write = vi.spyOn(ipc, "writeFile").mockReturnValueOnce(first.promise).mockResolvedValue(null);
    pendingDrafts.set(path, edited);
    const saving = useVaultStore.getState().saveFile(path, edited);
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    pendingDrafts.set(path, latest);
    first.resolve(null);
    expect(await saving).toBe(true);
    expect(pendingDrafts.get(path)).toBe(latest);
    expect(await useVaultStore.getState().saveFile(path, latest)).toBe(true);
    expect(pendingDrafts.has(path)).toBe(false);
  });

  it("serializes writes to one note while another note can save", async () => {
    await admitBaseline(`${path}.other.md`);
    const first = deferred<null>();
    const write = vi.spyOn(ipc, "writeFile").mockReturnValueOnce(first.promise).mockResolvedValue(null);
    const earlier = useVaultStore.getState().saveFile(path, edited);
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    const newer = useVaultStore.getState().saveFile(path, latest);
    expect(await useVaultStore.getState().saveFile(`${path}.other.md`, "Other")).toBe(true);
    expect(write.mock.calls.map(([p]) => p)).toEqual([path, `${path}.other.md`]);
    first.resolve(null);
    expect(await earlier).toBe(true);
    expect(await newer).toBe(true);
    expect(write).toHaveBeenLastCalledWith(path, latest);
    expect(useVaultStore.getState().activeFile?.raw).toBe(latest);
  });

  it("a failed write does not prevent the queued newer save", async () => {
    const write = vi.spyOn(ipc, "writeFile").mockRejectedValueOnce(new Error("EIO synthetic")).mockResolvedValue(null);
    pendingDrafts.set(path, latest);
    const results = await Promise.all([
      useVaultStore.getState().saveFile(path, edited),
      useVaultStore.getState().saveFile(path, latest),
    ]);
    expect(results).toEqual([false, true]);
    expect(write).toHaveBeenCalledTimes(2);
    expect(pendingDrafts.has(path)).toBe(false);
    expect(useVaultStore.getState().error).toBeNull();
  });

  it("keeps undo to an earlier value while a different newer save is queued", async () => {
    const first = deferred<null>();
    const second = deferred<null>();
    let disk = original;
    const write = vi.spyOn(ipc, "writeFile")
      .mockImplementationOnce(async (_target, content) => {
        await first.promise;
        disk = content;
        return null;
      })
      .mockImplementationOnce(async (_target, content) => {
        await second.promise;
        disk = content;
        return null;
      })
      .mockImplementation(async (_target, content) => { disk = content; return null; });
    pendingDrafts.set(path, edited);
    const savingFirst = useVaultStore.getState().saveFile(path, edited);
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    pendingDrafts.set(path, latest);
    const savingSecond = useVaultStore.getState().saveFile(path, latest);
    // Undo to the first value while the second value still waits in the queue.
    pendingDrafts.set(path, edited);
    first.resolve(null);
    await savingFirst;
    expect(pendingDrafts.get(path)).toBe(edited);
    second.resolve(null);
    await savingSecond;
    expect(disk).toBe(latest);
    expect(pendingDrafts.get(path)).toBe(edited);
    expect(await useVaultStore.getState().saveFile(path, edited)).toBe(true);
    expect(disk).toBe(edited);
    expect(pendingDrafts.has(path)).toBe(false);
  });
});

describe("drafts during path changes", () => {
  it.each(["rename", "move"])("keeps the draft at its new path after a failed %s write", async (operation) => {
    const destination = path.replace("/wiki/", "/notes/");
    vi.spyOn(ipc, "renamePath").mockResolvedValue(destination);
    vi.spyOn(ipc, "movePath").mockResolvedValue(destination);
    vi.spyOn(ipc, "writeFile").mockRejectedValueOnce(new Error("EIO synthetic")).mockResolvedValue(null);
    pendingDrafts.set(path, edited);
    if (operation === "rename") await useVaultStore.getState().renamePath(path, "renamed.md");
    else await useVaultStore.getState().movePaths([path], "/save-test/notes");
    expect(pendingDrafts.has(path)).toBe(false);
    expect(pendingDrafts.get(destination)).toBe(edited);
    expect(useUIStore.getState().route).toBe(`page:${destination}`);
    expect(useVaultStore.getState().error).toBe("EIO synthetic");
    expect(await useVaultStore.getState().saveFile(destination, edited)).toBe(true);
    expect(pendingDrafts.has(destination)).toBe(false);
  });

  it("waits for an in-flight write before rename and sends later writes to the new path", async () => {
    const first = deferred<null>();
    const destination = path.replace("/wiki/", "/notes/");
    const write = vi.spyOn(ipc, "writeFile").mockReturnValueOnce(first.promise).mockResolvedValue(null);
    const rename = vi.spyOn(ipc, "renamePath").mockResolvedValue(destination);
    pendingDrafts.set(path, edited);
    const saving = useVaultStore.getState().saveFile(path, edited);
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    const renaming = useVaultStore.getState().renamePath(path, "renamed.md");
    pendingDrafts.set(path, latest);
    const newer = useVaultStore.getState().saveFile(path, latest);
    await Promise.resolve();
    expect(rename).not.toHaveBeenCalled();
    first.resolve(null);
    await Promise.all([saving, renaming, newer]);
    expect(write.mock.calls.filter(([p]) => p === path)).toHaveLength(1);
    expect(write).toHaveBeenLastCalledWith(destination, latest);
    expect(useVaultStore.getState().activeFile).toMatchObject({ path: destination, raw: latest });
    expect(pendingDrafts.size).toBe(0);
  });

  it("does not recreate a deleted note from a queued write", async () => {
    const first = deferred<null>();
    const write = vi.spyOn(ipc, "writeFile").mockReturnValueOnce(first.promise).mockResolvedValue(null);
    const remove = vi.spyOn(ipc, "deletePath").mockResolvedValue(null);
    pendingDrafts.set(path, edited);
    const saving = useVaultStore.getState().saveFile(path, edited);
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    const deleting = useVaultStore.getState().deletePath(path);
    pendingDrafts.set(path, latest);
    const newer = useVaultStore.getState().saveFile(path, latest);
    await Promise.resolve();
    expect(remove).not.toHaveBeenCalled();
    first.resolve(null);
    await Promise.all([saving, deleting, newer]);
    expect(remove).toHaveBeenCalledWith(path);
    expect(write).toHaveBeenCalledTimes(1);
    expect(pendingDrafts.has(path)).toBe(false);
    expect(useVaultStore.getState().activeFile).toBeNull();
  });

  it("keeps newer edits to a second note while a moved folder's first note is saving", async () => {
    const first = deferred<null>();
    const folder = `/save-test/folder-${serial}`;
    const destination = `${folder}-moved`;
    const firstPath = `${folder}/a.md`;
    const secondPath = `${folder}/sub/b.md`;
    const movedSecond = `${destination}/sub/b.md`;
    await admitBaseline(firstPath);
    await admitBaseline(secondPath);
    const disk = new Map<string, string>();
    const write = vi.spyOn(ipc, "writeFile").mockImplementation(async (target, content) => {
      if (target === `${destination}/a.md`) await first.promise;
      disk.set(target, content);
      return null;
    });
    vi.spyOn(ipc, "renamePath").mockResolvedValue(destination);
    pendingDrafts.set(firstPath, edited);
    pendingDrafts.set(secondPath, edited);
    const moving = useVaultStore.getState().renamePath(folder, "moved");
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith(`${destination}/a.md`, edited));
    pendingDrafts.set(movedSecond, latest);
    await useVaultStore.getState().saveFile(movedSecond, latest);
    first.resolve(null);
    await moving;
    expect(disk.get(movedSecond)).toBe(latest);
    expect(write.mock.calls.some(([target]) => target.startsWith(`${folder}/`))).toBe(false);
    expect(pendingDrafts.size).toBe(0);
  });

  it("cancels queued writes for descendants when deleting a folder", async () => {
    const first = deferred<null>();
    const folder = `/save-test/delete-${serial}`;
    const child = `${folder}/sub/note.md`;
    await admitBaseline(child);
    const write = vi.spyOn(ipc, "writeFile").mockReturnValueOnce(first.promise).mockResolvedValue(null);
    vi.spyOn(ipc, "deletePath").mockResolvedValue(null);
    pendingDrafts.set(child, edited);
    const saving = useVaultStore.getState().saveFile(child, edited);
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    const removing = useVaultStore.getState().deletePath(folder);
    pendingDrafts.set(child, latest);
    const queued = useVaultStore.getState().saveFile(child, latest);
    first.resolve(null);
    await Promise.all([saving, removing, queued]);
    expect(write).toHaveBeenCalledTimes(1);
    expect(pendingDrafts.has(child)).toBe(false);
  });

  it("lets a new note reuse the old name while the renamed note is still saving", async () => {
    const first = deferred<null>();
    const movedWrite = deferred<null>();
    const destination = path.replace("/wiki/", "/notes/");
    const disk = new Map<string, string>();
    const write = vi.spyOn(ipc, "writeFile").mockImplementation(async (target, content) => {
      if (content === edited) await first.promise;
      if (target === destination) await movedWrite.promise;
      disk.set(target, content);
      return null;
    });
    vi.spyOn(ipc, "renamePath").mockResolvedValue(destination);
    pendingDrafts.set(path, edited);
    const saving = useVaultStore.getState().saveFile(path, edited);
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    const renaming = useVaultStore.getState().renamePath(path, "renamed.md");
    pendingDrafts.set(path, latest);
    const queued = useVaultStore.getState().saveFile(path, latest);
    first.resolve(null);
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith(destination, latest));
    await admitBaseline(path);
    pendingDrafts.set(path, "A newly created note");
    await useVaultStore.getState().saveFile(path, "A newly created note");
    movedWrite.resolve(null);
    await Promise.all([saving, renaming, queued]);
    expect(disk.get(path)).toBe("A newly created note");
    expect(disk.get(destination)).toBe(latest);
  });

  it("unblocks queued saving and retains the draft when a rename is refused", async () => {
    const rename = deferred<string>();
    vi.spyOn(ipc, "renamePath").mockReturnValue(rename.promise);
    const write = vi.spyOn(ipc, "writeFile").mockResolvedValue(null);
    pendingDrafts.set(path, edited);
    const renaming = useVaultStore.getState().renamePath(path, "renamed.md");
    await vi.waitFor(() => expect(ipc.renamePath).toHaveBeenCalledTimes(1));
    const saving = useVaultStore.getState().saveFile(path, edited);
    await Promise.resolve();
    expect(write).not.toHaveBeenCalled();
    rename.reject(new Error("Rename refused"));
    expect(await renaming).toBeNull();
    expect(useUIStore.getState().route).toBe(`page:${path}`);
    expect(await saving).toBe(true);
    expect(write).toHaveBeenCalledWith(path, edited);
  });
});
