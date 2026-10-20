import { describe, expect, it, vi } from "vitest";
import { writeEvidenceNote } from "./evidenceWrite";
import { sha256 } from "./tidyRun";

vi.mock("./ipc", () => ({ ipc: {} }));

describe("writeEvidenceNote", () => {
  it("creates only from an absent file and distinguishes existing empty bytes", async () => {
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    const io = {
      readFile: vi.fn().mockRejectedValueOnce(missing).mockResolvedValueOnce({ raw: "" }),
      writeFileIfUnchanged: vi.fn().mockResolvedValue(undefined),
    };
    expect(await writeEvidenceNote(io, "/v/daily/day.md", current => ({
      content: current ?? "new note", result: current === null,
    }))).toBe(true);
    expect(io.writeFileIfUnchanged.mock.calls[0]).toEqual(["/v/daily/day.md", "new note", null]);
    await writeEvidenceNote(io, "/v/daily/day.md", current => ({ content: current + "evidence", result: false }));
    expect(io.writeFileIfUnchanged.mock.calls[1][2]).toBe(await sha256(""));
  });

  it("rebuilds from a user's changed note after a write conflict", async () => {
    let raw = "# Original\n";
    let writes = 0;
    const readFile = vi.fn(async () => ({ raw }));
    const writeFileIfUnchanged = vi.fn(async (_path: string, content: string, expected: string | null) => {
      if (++writes === 1) raw += "User edit\n";
      if (expected !== await sha256(raw)) throw new Error("write conflict: changed");
      raw = content;
    });
    const result = await writeEvidenceNote({ readFile, writeFileIfUnchanged }, "/v/daily/day.md", current => ({
      content: current + "Source evidence\n", result: current,
    }));
    expect(raw).toBe("# Original\nUser edit\nSource evidence\n");
    expect(result).toBe("# Original\nUser edit\n");
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it("allows two cooperating appends without losing either", async () => {
    let raw = "# Note\n";
    let revision = await sha256(raw);
    const io = {
      readFile: vi.fn(async () => ({ raw })),
      writeFileIfUnchanged: vi.fn(async (_path: string, content: string, expected: string | null) => {
        const nextRevision = await sha256(content);
        // Compare and publish synchronously: the native writer holds its lock.
        if (expected !== revision) throw "write conflict: changed";
        raw = content;
        revision = nextRevision;
      }),
    };
    await Promise.all(["A", "B"].map(label => writeEvidenceNote(io, "/v/daily/day.md", current => ({
      content: current + label + "\n", result: label,
    }))));
    expect(raw.match(/^A$/gm)).toHaveLength(1);
    expect(raw.match(/^B$/gm)).toHaveLength(1);
    expect(io.writeFileIfUnchanged).toHaveBeenCalledTimes(3);
  });

  it("does not treat permission or generic lookup failures as missing files", async () => {
    for (const error of [new Error("EACCES"), new Error("provider not found"), "not found"]) {
      const io = { readFile: vi.fn().mockRejectedValue(error), writeFileIfUnchanged: vi.fn() };
      const transform = vi.fn();
      await expect(writeEvidenceNote(io, "/v/note.md", transform)).rejects.toBe(error);
      expect(io.writeFileIfUnchanged).not.toHaveBeenCalled();
      expect(transform).not.toHaveBeenCalled();
    }
  });

  it("propagates non-conflict write errors without retry", async () => {
    const error = new Error("disk full");
    const io = {
      readFile: vi.fn().mockResolvedValue({ raw: "keep" }),
      writeFileIfUnchanged: vi.fn().mockRejectedValue(error),
    };
    await expect(writeEvidenceNote(io, "/v/note.md", current => ({ content: current + "append", result: null })))
      .rejects.toBe(error);
    expect(io.readFile).toHaveBeenCalledTimes(1);
  });

  it("limits repeated conflicts to three rebuilt attempts", async () => {
    const io = {
      readFile: vi.fn().mockResolvedValue({ raw: "keep" }),
      writeFileIfUnchanged: vi.fn().mockRejectedValue("write conflict: changing"),
    };
    const transform = vi.fn((current: string | null) => ({ content: current + "append", result: null }));
    await expect(writeEvidenceNote(io, "/v/note.md", transform)).rejects.toBe("write conflict: changing");
    expect(io.readFile).toHaveBeenCalledTimes(3);
    expect(transform).toHaveBeenCalledTimes(3);
  });
});
