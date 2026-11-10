import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAP_EXCERPT_CHARS, MAP_MEMBER_LIMIT, MAP_SOURCE_BYTES, mapEvidencePrompt, withMapEvidence } from "./mapEvidence";
import { roleFixture } from "./modelRoles.testSupport";
import { sha256 } from "./tidyRun";

const { source, capture, check, release } = vi.hoisted(() => ({ source: vi.fn(), capture: vi.fn(), check: vi.fn(), release: vi.fn() }));
vi.mock("./ipc", () => ({ ipc: { captureMapSources: capture, checkMapSources: check, releaseMapSources: release } }));
const origin = { vaultPath: "/v", openingToken: "synthetic-evidence" };
const role = roleFixture("organization", "builtin-local", "synthetic", origin);
const current = () => undefined;
const readMapEvidence = (_vault: string, members: string[], assertCurrent: () => void) =>
  withMapEvidence(origin, role, members, assertCurrent, async evidence => evidence);
beforeEach(() => {
  source.mockReset(); check.mockReset().mockResolvedValue(undefined); release.mockReset().mockResolvedValue(undefined);
  capture.mockReset().mockImplementation(async (_origin, _role, paths: string[]) => ({
    snapshotId: "c".repeat(64), origin, members: await Promise.all(paths.map(async path => {
      const { raw } = await source(path);
      return { path, raw, revision: typeof raw === "string" ? await sha256(raw) : "invalid" };
    })),
  }));
});

describe("map evidence boundaries", () => {
  it("keeps exact Unicode excerpts, full raw revisions and explicit partial coverage", async () => {
    const body = "🌱".repeat(MAP_EXCERPT_CHARS) + " omitted synthetic decision";
    const raw = `---\ntitle: Synthetic title\n---\n\n${body}`;
    source.mockResolvedValue({ raw });
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
      expect(capture).not.toHaveBeenCalled();
    },
  );

  it.each(["../outside.md", "wiki/../outside.md", "/outside.md", "wiki\\outside.md", "wiki/[unsafe].md", "wiki/a|b.md", "wiki/a#b.md", "C:/outside.md", "wiki/a\0.md", "wiki/a\n.md", "wiki/CON.md", "wiki/LPT1.md", "wiki/folder /a.md", "wiki/folder./a.md", "wiki/a?.md", "wiki/a\".md"])(
    "rejects an unsafe path before IPC: %j", async path => {
      await expect(readMapEvidence("/v", [path], current)).rejects.toMatchObject({ code: "validation_rejected" });
      expect(capture).not.toHaveBeenCalled();
    },
  );

  it("rejects ambiguous selected citation targets before IPC", async () => {
    await expect(readMapEvidence("/v", ["wiki/a.md", "wiki/A.md"], current))
      .rejects.toMatchObject({ code: "validation_rejected" });
    expect(capture).not.toHaveBeenCalled();
  });

  it("keeps distinct path citations when selected members share a basename", async () => {
    source.mockResolvedValue({ raw: "Synthetic source." });
    const evidence = await readMapEvidence("/v", ["wiki/a.md", "wiki/nested/a.md"], current);
    expect(evidence.map(member => member.link)).toEqual(["[[wiki/a.md|a]]", "[[wiki/nested/a.md|a]]"]);
  });

  it("rejects Unicode-equivalent selected paths before IPC", async () => {
    await expect(readMapEvidence("/v", ["wiki/한글.md", "wiki/한글.md".normalize("NFD")], current))
      .rejects.toMatchObject({ code: "validation_rejected" });
    expect(capture).not.toHaveBeenCalled();
  });

  it.each([undefined, "synthetic\0source"])("rejects invalid source text: %j", async raw => {
    source.mockResolvedValue({ raw });
    await expect(readMapEvidence("/v", ["wiki/a.md"], current)).rejects.toMatchObject({ code: "validation_rejected" });
  });

  it("does not treat a title-only page as evidence", async () => {
    source.mockResolvedValue({ raw: "---\ntitle: Synthetic title\n---\n" });
    await expect(readMapEvidence("/v", ["wiki/a.md"], current)).rejects.toMatchObject({ code: "incomplete" });
  });

  it("rejects oversized UTF-8 sources instead of silently sampling them", async () => {
    source.mockResolvedValue({ raw: "한".repeat(Math.ceil(MAP_SOURCE_BYTES / 3)) });
    await expect(readMapEvidence("/v", ["wiki/a.md"], current)).rejects.toMatchObject({ code: "incomplete" });
  });

  it("accounts for escaped text in the serialized prompt budget", async () => {
    source.mockResolvedValue({ raw: "\t".repeat(MAP_EXCERPT_CHARS - 2) + "x" });
    const evidence = await readMapEvidence("/v", ["wiki/a.md"], current);
    const oversized = Array.from({ length: MAP_MEMBER_LIMIT }, (_, i) => ({
      ...evidence[0], path: `wiki/${"a".repeat(490)}-${i}.md`, excerpt: "\t".repeat(MAP_EXCERPT_CHARS),
    }));
    expect(() => mapEvidencePrompt(oversized, "Synthetic cluster")).toThrow("prompt budget");
  });

  it("releases invalid native receipts and rejects a different opening", async () => {
    capture.mockResolvedValue({ snapshotId: "c".repeat(64), origin: { ...origin, openingToken: "other" }, members: [] });
    await expect(readMapEvidence("/v", ["wiki/a.md"], current)).rejects.toMatchObject({ code: "validation_rejected" });
    expect(release).toHaveBeenCalledWith(origin, "c".repeat(64));
  });

  it("rejects an altered native revision and releases its grant", async () => {
    capture.mockResolvedValue({ snapshotId: "c".repeat(64), origin, members: [{ path: "wiki/a.md", raw: "Synthetic source.", revision: "f".repeat(64) }] });
    await expect(readMapEvidence("/v", ["wiki/a.md"], current)).rejects.toMatchObject({ code: "validation_rejected" });
    expect(release).toHaveBeenCalledOnce();
  });

  it("surfaces cleanup failure together with the original generation failure", async () => {
    source.mockResolvedValue({ raw: "Synthetic source." });
    const generation = new Error("synthetic generation failure");
    const cleanup = new Error("synthetic cleanup failure");
    release.mockRejectedValue(cleanup);
    await expect(withMapEvidence(origin, role, ["wiki/a.md"], current, async () => { throw generation; }))
      .rejects.toMatchObject({ errors: [generation, cleanup] });
  });

  it("checks session currency before dispatching a source read", async () => {
    await expect(readMapEvidence("/v", ["wiki/a.md"], () => { throw new Error("stale"); })).rejects.toThrow("stale");
    expect(capture).not.toHaveBeenCalled();
  });
});
