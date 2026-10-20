// The mock's capture_note writes the line it reports, as the real command
// does (commands.rs capture_note_at), so a ?mock=1 capture from Home or the
// notch shows up when today's note is opened — not "Sample note.".
import { beforeAll, describe, expect, it } from "vitest";
import { installTauriMock } from "./devMock";
import type { Captured } from "./dailyNote";
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

describe("devMock capture_note", () => {
  it("seeds today's note with its heading and appends one - HH:MM line per capture", async () => {
    installTauriMock();
    const { rel } = await invoke<Captured>("capture_note", { text: "buy  milk\nnow" });
    await invoke<Captured>("capture_note", { text: "second" });
    const day = /^daily\/(\d{4}-\d{2}-\d{2})\.md$/.exec(rel)?.[1];
    expect(day).toBeTruthy();
    const file = await invoke<FileContent>("read_file", { path: `/myco/${rel}` });
    // The real command trims the seed before appending, so no blank line
    // separates the heading from the first capture.
    expect(file.raw).toMatch(
      new RegExp(`^# ${day}\\n- \\d\\d:\\d\\d buy milk now\\n- \\d\\d:\\d\\d second\\n$`),
    );
  });

  it("tells open readers the line it appended, as the real command emits", async () => {
    installTauriMock();
    const seen: unknown[] = [];
    await invoke("plugin:event|listen", {
      event: "myco://daily-captured",
      handler: (e: { payload: unknown }) => seen.push(e.payload),
    });
    const written = await invoke<Captured>("capture_note", { text: "third  one" });
    const file = await invoke<FileContent>("read_file", { path: `/myco/${written.rel}` });
    expect(seen).toHaveLength(1);
    // The caller gets what open readers get: Open can then find the line.
    expect(seen[0]).toEqual(written);
    expect(written.line).toMatch(/^- \d\d:\d\d third one$/);
    expect(file.raw.endsWith(`\n${written.line}\n`)).toBe(true);
  });

  it("writes a quote's footnote definition once per note, as the real command does", async () => {
    installTauriMock();
    const args = { text: "Q [^src-mock-src]", source: "raw/mock-src.md" };
    const first = await invoke<Captured>("capture_note", args);
    const again = await invoke<Captured>("capture_note", args);
    expect(first.footnote).toBe("[^src-mock-src]: raw/mock-src.md");
    expect(again.footnote).toBeUndefined();
    const file = await invoke<FileContent>("read_file", { path: `/myco/${first.rel}` });
    expect(file.raw.split("[^src-mock-src]: ")).toHaveLength(2);
    expect(file.raw.endsWith(`${first.line}\n${again.line}\n\n${first.footnote}\n`)).toBe(true);
  });

  it("reads an unwritten daily note as missing, so openDailyNote can create it", async () => {
    installTauriMock();
    const path = "/myco/daily/2020-01-02.md";
    await expect(invoke("read_file", { path })).rejects.toThrow(/no such file/);
    await invoke("write_file", { path, content: "# 2020-01-02\n\n" });
    expect((await invoke<FileContent>("read_file", { path })).raw).toBe("# 2020-01-02\n\n");
  });
});
