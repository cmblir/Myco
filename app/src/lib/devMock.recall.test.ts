// The mock's semantic_search carries each hit's real chunk text (the note's
// own body), so a `/recall` quote inserted in ?mock=1 shows what the backend
// would quote — not a placeholder that proves nothing.
import { beforeAll, describe, expect, it } from "vitest";
import { installTauriMock } from "./devMock";
import type { FileContent, SemanticSearchResult } from "./ipc";

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

describe("devMock semantic_search", () => {
  it("returns a wiki hit's own chunk text, as read_file has it", async () => {
    installTauriMock();
    const r = await invoke<SemanticSearchResult>("semantic_search", {
      query: "attention",
      k: 4,
      scope: "wiki",
    });
    const hit = r.hits.find((h) => h.page.startsWith("wiki/"));
    expect(hit).toBeTruthy();
    const file = await invoke<FileContent>("read_file", {
      path: `/myco/${hit?.page}`,
    });
    expect(hit?.text).not.toMatch(/^passage from/);
    expect(file.raw).toContain(hit?.text);
  });

  it("keeps only the pages a note scope names, near-misses included", async () => {
    installTauriMock();
    const all = await invoke<SemanticSearchResult>("semantic_search", { query: "attention", k: 8, scope: "all" });
    const page = all.hits[0].page;
    const r = await invoke<SemanticSearchResult>("semantic_search", {
      query: "attention",
      k: 8,
      scope: "all",
      paths: [page],
    });
    expect(r.hits.map((h) => h.page)).toEqual([page]);
    const none = await invoke<SemanticSearchResult>("semantic_search", { query: "zzqq", k: 8, paths: [page] });
    expect(none.hits).toEqual([]);
    expect(none.below_floor.every((m) => m.page === page)).toBe(true);
  });
});
