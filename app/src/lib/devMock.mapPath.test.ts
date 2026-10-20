// ?mock=1 read_file under wiki/maps/: maps.ts freeMapPath probes
// wiki/maps/<slug>[-N].md until a read misses. The blanket "Sample note."
// fallback never missed, so approving a topic map with a writer set spun
// that loop forever and hung the page.
import { beforeAll, describe, expect, it } from "vitest";
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

describe("devMock wiki/maps reads", () => {
  it("misses an unwritten map and finds it once written", async () => {
    installTauriMock();
    const path = "/myco/wiki/maps/attention-mechanism-2.md";
    await expect(invoke("read_file", { path })).rejects.toThrow();
    await invoke("write_file", { path, content: "# Map\n" });
    await expect(invoke<{ raw: string }>("read_file", { path })).resolves.toMatchObject({
      raw: "# Map\n",
    });
  });
});
