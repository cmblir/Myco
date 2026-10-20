// ?mock=1 carries the mess Tidy exists for: opaque session summaries whose
// `## Related` links name transcript stems that resolve to nothing. The mock
// reads those links from the pages' current text, so a rewrite shows up in the
// graph the way it would against a real vault.
import { beforeAll, describe, expect, it } from "vitest";
import { installTauriMock } from "./devMock";
import type { Adjacency, FileContent } from "./ipc";

function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const w = window as unknown as {
    __TAURI_INTERNALS__: { invoke: (c: string, a: unknown) => Promise<T> };
  };
  return w.__TAURI_INTERNALS__.invoke(cmd, args);
}

beforeAll(() => {
  (globalThis as unknown as { window?: unknown }).window ??= globalThis;
});

const A = "claude-code-3f2a9c1e-7b4d-4e8a-9c21-5d6e7f8a9b0c";
const B = "codex-019e2b7c-4d1a-7c3e-9f5b-2a8d6c4e1f07";

describe("devMock Tidy fixtures", () => {
  it("dangles the summaries' transcript links, and resolves them once rewritten", async () => {
    installTauriMock();
    const summaryA = `/myco/wiki/source-${A}.md`;
    const before = await invoke<Adjacency>("build_link_graph");
    expect(before.unresolved[summaryA]).toEqual([B, expect.stringMatching(/^claude-code-/)]);

    const page = await invoke<FileContent>("read_file", { path: summaryA });
    const transcript = await invoke<FileContent>("read_file", {
      path: `/myco/sessions/2026-09/${A}.md`,
    });
    expect(transcript.raw).toContain("# 서버 띄워봐.");

    await invoke("write_file", {
      path: summaryA,
      content: page.raw.replace(`[[${B}]]`, `[[source-${B}]]`),
    });
    const after = await invoke<Adjacency>("build_link_graph");
    expect(after.unresolved[summaryA]).toHaveLength(1);
    expect(after.forward[summaryA]).toContain(`/myco/wiki/source-${B}.md`);
  });
});
