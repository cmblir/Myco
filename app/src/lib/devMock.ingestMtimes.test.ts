// The mock's writing agent (claude_run_stream) must leave wiki/ mtimes newer
// than a snapshot taken before it ran — even within the same wall-clock
// second. startIngest diffs file_mtimes around the run; with second-resolution
// clock stamps a fast mock run read as "no wiki pages changed" and ended at
// "error" whenever it did not cross a second boundary.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installTauriMock } from "./devMock";

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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("devMock claude_run_stream", () => {
  it("moves some wiki/ mtime past a same-second snapshot", async () => {
    installTauriMock();
    vi.spyOn(Date, "now").mockReturnValue(1_790_000_000_500);
    const wiki = (rows: [string, number][]) =>
      new Map(rows.filter(([p]) => p.includes("/wiki/")));
    const before = wiki(await invoke<[string, number][]>("file_mtimes", { root: "/myco" }));
    await invoke("claude_run_stream", { runId: "r1", prompt: "ingest", cwd: "/myco" });
    const after = wiki(await invoke<[string, number][]>("file_mtimes", { root: "/myco" }));
    const changed = [...after].filter(([p, m]) => m > (before.get(p) ?? 0));
    expect(changed.length).toBeGreaterThan(0);
  });
});

// The offline (extractive) ingest writes its pages with write_file and never
// calls claude_run_stream, so the same diff has to see those writes too.
describe("devMock write_file", () => {
  it("moves some wiki/ mtime past a same-second snapshot", async () => {
    installTauriMock();
    vi.spyOn(Date, "now").mockReturnValue(1_790_000_000_500);
    const wiki = (rows: [string, number][]) =>
      new Map(rows.filter(([p]) => p.includes("/wiki/")));
    const before = wiki(await invoke<[string, number][]>("file_mtimes", { root: "/myco" }));
    await invoke("write_file", { path: "/myco/wiki/source-smoke.md", content: "# Smoke\n" });
    const after = wiki(await invoke<[string, number][]>("file_mtimes", { root: "/myco" }));
    const changed = [...after].filter(([p, m]) => m > (before.get(p) ?? 0));
    expect(changed.length).toBeGreaterThan(0);
  });
});
