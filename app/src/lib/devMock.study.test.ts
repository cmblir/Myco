// ?mock=1 study data (spec 2026-09-29): a grounded deck quoted from a rich
// concept note, a junk deck of model prose that Study must flag, and a
// move_path that really moves a deck into cards/archive/.
import { beforeAll, describe, expect, it } from "vitest";
import { installTauriMock } from "./devMock";
import { summarizeDecks } from "./cardStore";
import type { FileContent, FileNode } from "./ipc";

function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const w = window as unknown as {
    __TAURI_INTERNALS__: { invoke: (c: string, a: unknown) => Promise<T> };
  };
  return w.__TAURI_INTERNALS__.invoke(cmd, args);
}

// installTauriMock writes onto `window`; node has none (see
// devMock.archiveCompress.test.ts for why this is not jsdom).
beforeAll(() => {
  (globalThis as unknown as { window?: unknown }).window ??= globalThis;
});

const readNote = async (stem: string): Promise<string | null> =>
  (await invoke<FileContent>("read_file", { path: `/myco/wiki/${stem}.md` })).raw;

const cardsDir = (tree: FileNode[]) =>
  tree.find((n) => n.kind === "directory" && n.name === "cards") as Extract<
    FileNode,
    { kind: "directory" }
  >;

describe("devMock study decks", () => {
  it("seeds a grounded deck and a junk deck Study flags", async () => {
    installTauriMock();
    const tree = await invoke<FileNode[]>("list_files", { root: "/myco" });
    const byName = new Map(
      (await summarizeDecks(tree, "2026-09-29", readNote)).map((d) => [d.name, d]),
    );
    expect(byName.get("attention-mechanism")?.ungrounded).toBe(0);
    expect(byName.get("attention-mechanism")?.due).toBeGreaterThan(0);
    const junk = byName.get("2026-07-12")!;
    expect(junk.ungrounded).toBe(junk.total);
  });

  it("moves a deck into cards/archive/, where the deck list no longer sees it", async () => {
    installTauriMock();
    const to = await invoke<string>("move_path", {
      from: "/myco/cards/2026-07-12.md",
      toDir: "/myco/cards/archive",
    });
    expect(to).toBe("/myco/cards/archive/2026-07-12.md");
    const cards = cardsDir(await invoke<FileNode[]>("list_files", { root: "/myco" }));
    const names = cards.children.map((c) => c.name);
    expect(names).not.toContain("2026-07-12.md");
    const archive = cards.children.find((c) => c.name === "archive");
    expect(archive?.kind === "directory" && archive.children.map((c) => c.name)).toEqual([
      "2026-07-12.md",
    ]);
    const moved = await invoke<FileContent>("read_file", { path: to });
    expect(moved.raw).toContain(" ?? ");
  });
});
