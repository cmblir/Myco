import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAP_EXCERPT_CHARS, MAP_MEMBER_LIMIT, MAP_SOURCE_BYTES, mapEvidencePrompt, readMapEvidence, recheckMapEvidence } from "./mapEvidence";
import { sha256 } from "./tidyRun";

const { readFile } = vi.hoisted(() => ({ readFile: vi.fn() }));
vi.mock("./ipc", () => ({ ipc: { readFile } }));

const current = () => undefined;
beforeEach(() => readFile.mockReset());

describe("map evidence boundaries", () => {
  it("keeps exact Unicode excerpts, full raw revisions and explicit partial coverage", async () => {
    const body = "🌱".repeat(MAP_EXCERPT_CHARS) + " omitted synthetic decision";
    const raw = `---\ntitle: Synthetic title\n---\n\n${body}`;
    readFile.mockResolvedValue({ raw });
    const evidence = await readMapEvidence("/v", ["wiki/한글.md"], current);
    expect(evidence).toEqual([{ path: "wiki/한글.md", link: "[[wiki/한글.md|한글]]", revision: await sha256(raw),
      excerpt: "🌱".repeat(MAP_EXCERPT_CHARS), sourceChars: Array.from(body).length, truncated: true }]);
    const prompt = mapEvidencePrompt(evidence, "Synthetic cluster");
    expect(prompt).toContain('"partialMemberCoverage":true');
    expect(prompt).not.toContain("omitted synthetic decision");
    expect(prompt).not.toContain("Synthetic title");
  });

  it.each([{ members: [] }, { members: Array.from({ length: MAP_MEMBER_LIMIT + 1 }, (_, i) => `wiki/page-${i}.md`) }])(
    "rejects an empty or oversized selection before reading sources: %j", async ({ members }) => {
      await expect(readMapEvidence("/v", members, current)).rejects.toMatchObject({ code: "incomplete" });
      expect(readFile).not.toHaveBeenCalled();
    },
  );

  it.each(["../outside.md", "wiki/../outside.md", "/outside.md", "wiki\\outside.md", "wiki/[unsafe].md", "wiki/a|b.md", "wiki/a#b.md", "C:/outside.md", "wiki/a\0.md", "wiki/a\n.md"])(
    "rejects an unsafe path before IPC: %j", async path => {
      await expect(readMapEvidence("/v", [path], current)).rejects.toMatchObject({ code: "validation_rejected" });
      expect(readFile).not.toHaveBeenCalled();
    },
  );

  it("rejects ambiguous selected citation targets before IPC", async () => {
    await expect(readMapEvidence("/v", ["wiki/a.md", "wiki/A.md"], current))
      .rejects.toMatchObject({ code: "validation_rejected" });
    expect(readFile).not.toHaveBeenCalled();
  });

  it("keeps distinct path citations when selected members share a basename", async () => {
    readFile.mockResolvedValue({ raw: "Synthetic source." });
    const evidence = await readMapEvidence("/v", ["wiki/a.md", "wiki/nested/a.md"], current);
    expect(evidence.map(member => member.link)).toEqual(["[[wiki/a.md|a]]", "[[wiki/nested/a.md|a]]"]);
  });

  it("rejects Unicode-equivalent selected paths before IPC", async () => {
    await expect(readMapEvidence("/v", ["wiki/한글.md", "wiki/한글.md".normalize("NFD")], current))
      .rejects.toMatchObject({ code: "validation_rejected" });
    expect(readFile).not.toHaveBeenCalled();
  });

  it.each([undefined, "synthetic\0source"])("rejects invalid source text: %j", async raw => {
    readFile.mockResolvedValue({ raw });
    await expect(readMapEvidence("/v", ["wiki/a.md"], current)).rejects.toMatchObject({ code: "validation_rejected" });
  });

  it("does not treat a title-only page as evidence", async () => {
    readFile.mockResolvedValue({ raw: "---\ntitle: Synthetic title\n---\n" });
    await expect(readMapEvidence("/v", ["wiki/a.md"], current)).rejects.toMatchObject({ code: "incomplete" });
  });

  it("rejects oversized UTF-8 sources instead of silently sampling them", async () => {
    readFile.mockResolvedValue({ raw: "한".repeat(Math.ceil(MAP_SOURCE_BYTES / 3)) });
    await expect(readMapEvidence("/v", ["wiki/a.md"], current)).rejects.toMatchObject({ code: "incomplete" });
  });

  it("accounts for escaped text in the serialized prompt budget", async () => {
    readFile.mockResolvedValue({ raw: "\t".repeat(MAP_EXCERPT_CHARS - 2) + "x" });
    const evidence = await readMapEvidence("/v", ["wiki/a.md"], current);
    const oversized = Array.from({ length: MAP_MEMBER_LIMIT }, (_, i) => ({
      ...evidence[0], path: `wiki/${"a".repeat(490)}-${i}.md`, excerpt: "\t".repeat(MAP_EXCERPT_CHARS),
    }));
    expect(() => mapEvidencePrompt(oversized, "Synthetic cluster")).toThrow("prompt budget");
  });

  it("rejects missing sources during the pre-publication freshness check", async () => {
    readFile.mockResolvedValueOnce({ raw: "Synthetic source." });
    const evidence = await readMapEvidence("/v", ["wiki/a.md"], current);
    readFile.mockRejectedValueOnce(new Error("ENOENT: no such file"));
    await expect(recheckMapEvidence("/v", evidence, current)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("rechecks the full raw revision even if only metadata outside the excerpt changed", async () => {
    const body = "Synthetic source.";
    readFile.mockResolvedValueOnce({ raw: `---\ntitle: Original\n---\n${body}` });
    const evidence = await readMapEvidence("/v", ["wiki/a.md"], current);
    readFile.mockResolvedValueOnce({ raw: `---\ntitle: Corrected\n---\n${body}` });
    await expect(recheckMapEvidence("/v", evidence, current)).rejects.toMatchObject({ code: "validation_rejected" });
  });

  it("checks session currency before dispatching a source read", async () => {
    await expect(readMapEvidence("/v", ["wiki/a.md"], () => { throw new Error("stale"); })).rejects.toThrow("stale");
    expect(readFile).not.toHaveBeenCalled();
  });
});
