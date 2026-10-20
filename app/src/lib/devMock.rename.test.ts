// The mock's rename_path lands on the name it was asked for, as the real
// command does (vault::rename_path), so a ?mock=1 rename opens that note —
// not a fixed `wiki/new.md` that reads "Sample note.".
import { beforeAll, describe, expect, it } from "vitest";
import { installTauriMock } from "./devMock";
import type { FileContent } from "./ipc";

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

describe("devMock rename_path", () => {
  it("returns the new name beside the old one and carries a written note along", async () => {
    installTauriMock();
    const from = "/myco/wiki/attention-mechanism.md";
    const before = await invoke<FileContent>("read_file", { path: from });
    const to = await invoke<string>("rename_path", { from, toName: "attention.md" });
    expect(to).toBe("/myco/wiki/attention.md");
    expect((await invoke<FileContent>("read_file", { path: to })).raw).toBe(before.raw);
  });
});
