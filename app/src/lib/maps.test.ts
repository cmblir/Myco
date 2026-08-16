import { describe, expect, it, vi, beforeEach } from "vitest";

const complete = vi.fn();
vi.mock("./chat", () => ({ complete: (...a: unknown[]) => complete(...a) }));

const readFile = vi.fn();
const writeFile = vi.fn();
const createFolder = vi.fn();
const listFiles = vi.fn();
const appendDistillManifest = vi.fn();
vi.mock("./ipc", () => ({
  ipc: {
    readFile: (...a: unknown[]) => readFile(...a),
    writeFile: (...a: unknown[]) => writeFile(...a),
    createFolder: (...a: unknown[]) => createFolder(...a),
    listFiles: (...a: unknown[]) => listFiles(...a),
    appendDistillManifest: (...a: unknown[]) => appendDistillManifest(...a),
  },
}));

import { draftMap } from "./maps";

beforeEach(() => {
  complete.mockReset();
  readFile.mockReset();
  writeFile.mockReset();
  createFolder.mockReset();
  appendDistillManifest.mockReset().mockResolvedValue(null);
  // Default: no existing wiki/maps/ pages at all — the idempotency-check
  // tests below override this to exercise a hit.
  listFiles.mockReset().mockResolvedValue([]);
});

describe("draftMap", () => {
  it("writes frontmatter + the model's body to wiki/maps/<slug>.md", async () => {
    complete.mockResolvedValue("Overview paragraph.\n\n## Group\n- [[a]] — desc\n");
    readFile.mockRejectedValue(new Error("not found")); // no existing map, no collision
    createFolder.mockResolvedValue("maps");
    writeFile.mockResolvedValue(null);

    const rel = await draftMap("/v", "Attention Mechanisms", ["wiki/a.md", "wiki/b.md"]);

    expect(rel).toBe("wiki/maps/attention-mechanisms.md");
    expect(createFolder).toHaveBeenCalledWith("/v/wiki", "maps");
    expect(writeFile).toHaveBeenCalledTimes(1);
    const [path, content] = writeFile.mock.calls[0] as [string, string];
    expect(path).toBe("/v/wiki/maps/attention-mechanisms.md");
    expect(content).toContain("type: map");
    expect(content).toContain('cluster: "Attention Mechanisms"');
    expect(content).toContain("status: draft");
    expect(content).toContain("tags: [map]");
    expect(content).toContain("Overview paragraph.");

    // The model gets member STEMS (wikilinks resolve by stem, not full path).
    const userMsg = (
      complete.mock.calls[0][0] as { messages: { content: string }[] }
    ).messages[1].content;
    expect(userMsg).toContain("[[a]]");
    expect(userMsg).toContain("[[b]]");
    expect(userMsg).not.toContain("wiki/a.md");
  });

  it("records the drafted file in an llm-<ts> undo-manifest", async () => {
    complete.mockResolvedValue("body");
    readFile.mockRejectedValue(new Error("not found"));
    createFolder.mockResolvedValue("maps");
    writeFile.mockResolvedValue(null);

    await draftMap("/v", "topic", ["wiki/x.md"]);

    expect(appendDistillManifest).toHaveBeenCalledWith(
      "/v",
      expect.stringMatching(/^llm-\d+$/),
      [],
      ["wiki/maps/topic.md"],
    );
  });

  it("records under the caller's manifest id so one run's maps share one manifest", async () => {
    complete.mockResolvedValue("body");
    readFile.mockRejectedValue(new Error("not found"));
    createFolder.mockResolvedValue("maps");
    writeFile.mockResolvedValue(null);

    await draftMap("/v", "topic", ["wiki/x.md"], "llm-1699999999");

    expect(appendDistillManifest).toHaveBeenCalledWith(
      "/v",
      "llm-1699999999",
      [],
      ["wiki/maps/topic.md"],
    );
  });

  it("does not record a manifest entry when an existing map short-circuits the draft", async () => {
    listFiles.mockResolvedValue([
      {
        kind: "directory",
        name: "wiki",
        path: "/v/wiki",
        children: [
          {
            kind: "directory",
            name: "maps",
            path: "/v/wiki/maps",
            children: [{ kind: "file", name: "topic.md", path: "/v/wiki/maps/topic.md" }],
          },
        ],
      },
    ]);
    readFile.mockResolvedValue({ frontmatter: { cluster: "topic" } });

    await draftMap("/v", "topic", ["wiki/x.md"]);

    expect(appendDistillManifest).not.toHaveBeenCalled();
  });

  it("suffixes -2 on a filename collision", async () => {
    complete.mockResolvedValue("body");
    readFile.mockImplementation((path: string) =>
      path.endsWith("/wiki/maps/topic.md")
        ? Promise.resolve({})
        : Promise.reject(new Error("not found")),
    );
    createFolder.mockResolvedValue("maps");
    writeFile.mockResolvedValue(null);

    const rel = await draftMap("/v", "topic", ["wiki/x.md"]);

    expect(rel).toBe("wiki/maps/topic-2.md");
  });

  it("strips a model-emitted frontmatter fence before writing", async () => {
    complete.mockResolvedValue("---\ntitle: whatever\n---\n\nReal body starts here.\n");
    readFile.mockRejectedValue(new Error("not found"));
    createFolder.mockResolvedValue("maps");
    writeFile.mockResolvedValue(null);

    await draftMap("/v", "topic", ["wiki/x.md"]);

    const content = writeFile.mock.calls[0][1] as string;
    // Exactly one frontmatter fence in the written file — code's own, not
    // the model's (the model's got stripped).
    expect(content.match(/^---$/gm)?.length).toBe(2);
    expect(content).toContain("Real body starts here.");
    expect(content).not.toContain("title: whatever");
  });

  it("returns an existing map's path without calling complete when the cluster is already mapped", async () => {
    listFiles.mockResolvedValue([
      {
        kind: "directory",
        name: "wiki",
        path: "/v/wiki",
        children: [
          {
            kind: "directory",
            name: "maps",
            path: "/v/wiki/maps",
            children: [{ kind: "file", name: "topic.md", path: "/v/wiki/maps/topic.md" }],
          },
        ],
      },
    ]);
    readFile.mockResolvedValue({ frontmatter: { cluster: "topic" } });

    const rel = await draftMap("/v", "topic", ["wiki/x.md"]);

    expect(rel).toBe("wiki/maps/topic.md");
    expect(complete).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("finds an existing map by member-stem match when the cluster label drifted", async () => {
    listFiles.mockResolvedValue([
      {
        kind: "directory",
        name: "wiki",
        path: "/v/wiki",
        children: [
          {
            kind: "directory",
            name: "maps",
            path: "/v/wiki/maps",
            children: [{ kind: "file", name: "old-label.md", path: "/v/wiki/maps/old-label.md" }],
          },
        ],
      },
    ]);
    // The existing map's cluster: value is "old-label" — not the current
    // (drifted) label "new-label" — but "old-label" is still one of the
    // cluster's current members' stems (wiki/old-label.md).
    readFile.mockResolvedValue({ frontmatter: { cluster: "old-label" } });

    const rel = await draftMap("/v", "new-label", ["wiki/old-label.md", "wiki/x.md"]);

    expect(rel).toBe("wiki/maps/old-label.md");
    expect(complete).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("strips a hallucinated wikilink not in the member list and warns once", async () => {
    complete.mockResolvedValue(
      "Overview.\n\n- [[a]] — real member\n- [[not-a-member]] — hallucinated\n",
    );
    readFile.mockRejectedValue(new Error("not found"));
    createFolder.mockResolvedValue("maps");
    writeFile.mockResolvedValue(null);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await draftMap("/v", "topic", ["wiki/a.md", "wiki/b.md"]);

    const content = writeFile.mock.calls[0][1] as string;
    expect(content).toContain("[[a]]");
    expect(content).not.toContain("[[not-a-member]]");
    expect(content).toContain("hallucinated"); // display text kept as plain prose
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});
