import { beforeAll, describe, expect, it } from "vitest";
import { installTauriMock } from "./devMock";

function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const w = window as unknown as {
    __TAURI_INTERNALS__: { invoke: (c: string, a: unknown) => Promise<T> };
  };
  return w.__TAURI_INTERNALS__.invoke(cmd, args);
}

beforeAll(() => {
  (globalThis as unknown as { window?: unknown }).window ??= globalThis;
});

describe("devMock inbox archive confinement", () => {
  it("refuses raw originals, other notes and traversal", async () => {
    installTauriMock();
    for (const path of ["/myco/raw/source.md", "/myco/wiki/note.md", "/myco/_inbox/../raw/source.md"]) {
      await expect(invoke("archive_inbox_source", { path })).rejects.toThrow();
    }
  });

  it("archives a pending inbox source and removes only that tray entry", async () => {
    installTauriMock();
    const before = await invoke<{ rel: string }[]>("list_inbox_entries");
    expect(before.length).toBeGreaterThan(0);
    const rel = before[0].rel;
    expect(await invoke("archive_inbox_source", { path: `/myco/${rel}` })).toBe(
      `/myco/_inbox/.archived/${rel.split("/").pop()}`,
    );
    const after = await invoke<{ rel: string }[]>("list_inbox_entries");
    expect(after.map((entry) => entry.rel)).toEqual(before.slice(1).map((entry) => entry.rel));
  });
});
