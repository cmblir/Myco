import { describe, expect, it, vi, beforeEach } from "vitest";

const complete = vi.fn();
vi.mock("./chat", () => ({ complete: (...a: unknown[]) => complete(...a) }));

const readFile = vi.fn();
const writeFile = vi.fn();
const createFolder = vi.fn();
vi.mock("./ipc", () => ({
  ipc: {
    readFile: (...a: unknown[]) => readFile(...a),
    writeFile: (...a: unknown[]) => writeFile(...a),
    createFolder: (...a: unknown[]) => createFolder(...a),
  },
}));

import { draftMap } from "./maps";

beforeEach(() => {
  complete.mockReset();
  readFile.mockReset();
  writeFile.mockReset();
  createFolder.mockReset();
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
});
