import { beforeAll, describe, expect, it, vi } from "vitest";
import { emitClipSaved, installTauriMock } from "./devMock";

function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const w = window as unknown as {
    __TAURI_INTERNALS__: { invoke: (c: string, a: unknown) => Promise<T> };
  };
  return w.__TAURI_INTERNALS__.invoke(cmd, args);
}

beforeAll(() => {
  (globalThis as unknown as { window?: unknown }).window ??= globalThis;
  installTauriMock();
});

describe("devMock mutation confinement", () => {
  const protectedSources = [
    "/myco", "/myco/", "/myco/wiki/..", "/myco/raw", "/myco/raw/source.md",
    "/myco/raw/archive/old.md", "/myco/wiki/../raw/source.md",
  ];

  it("refuses deleting the vault root or any raw original", async () => {
    for (const path of protectedSources) await expect(invoke("delete_path", { path })).rejects.toThrow();
  });

  it("rejects an entire trash batch before removing a valid inbox entry", async () => {
    // The mock derives mtimes from the clock; a second boundary is not a mutation.
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_790_000_000_500);
    try {
      emitClipSaved("synthetic-mutation-trash");
      const before = await invoke<{ rel: string }[]>("list_inbox_entries");
      for (const protectedPath of protectedSources) {
        await expect(invoke("trash_paths", { paths: ["/myco/_inbox/synthetic-mutation-trash.md", protectedPath] }))
          .rejects.toThrow();
        expect(await invoke("list_inbox_entries")).toEqual(before);
      }
    } finally {
      clock.mockRestore();
    }
  });

  it("refuses renaming a protected source without altering its contents", async () => {
    await invoke("write_file", { path: "/myco/raw/synthetic-mutation.md", content: "immutable synthetic original" });
    for (const from of protectedSources) await expect(invoke("rename_path", { from, toName: "renamed.md" })).rejects.toThrow();
    await expect(invoke("rename_path", { from: "/myco/raw/synthetic-mutation.md", toName: "renamed.md" })).rejects.toThrow();
    expect((await invoke<{ raw: string }>("read_file", { path: "/myco/raw/synthetic-mutation.md" })).raw)
      .toBe("immutable synthetic original");
  });

  it("refuses moving the vault root or raw originals", async () => {
    for (const from of protectedSources) await expect(invoke("move_path", { from, toDir: "/myco/wiki" })).rejects.toThrow();
  });

  it("refuses a raw destination but permits the vault root as a destination", async () => {
    const from = "/myco/wiki/synthetic-mutation-move.md";
    for (const toDir of ["/myco/raw", "/myco/raw/archive", "/myco/wiki/../raw"]) {
      await expect(invoke("move_path", { from, toDir })).rejects.toThrow();
    }
    expect(await invoke("move_path", { from, toDir: "/myco" })).toBe("/myco/synthetic-mutation-move.md");
  });

  it("allows ordinary root-level notes and a raw-looking folder name", async () => {
    expect(await invoke("rename_path", { from: "/myco/synthetic-note.md", toName: "renamed-note.md" }))
      .toBe("/myco/renamed-note.md");
    expect(await invoke("move_path", { from: "/myco/synthetic-note.md", toDir: "/myco/wiki" }))
      .toBe("/myco/wiki/synthetic-note.md");
    await expect(invoke("delete_path", { path: "/myco/rawish/synthetic-note.md" })).resolves.toBeNull();
  });
});
