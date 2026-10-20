import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AgentVaultSession } from "./ipc";
import type { RoleId, RoleUsage } from "./modelRoles";
import { roleFixture } from "./modelRoles.testSupport";
import { BUILTIN_CHAT_MODEL } from "./providers";

const complete = vi.fn();
vi.mock("./chat", () => ({ complete: (...a: unknown[]) => complete(...a) }));

const captureModelRole = vi.fn();
const readFile = vi.fn();
const writeFile = vi.fn();
const publishDistillNote = vi.fn();
const ORIGIN = { vaultPath: "/v", openingToken: "synthetic-opening" };
let openingSequence = 0;
const createFolder = vi.fn();
const listFiles = vi.fn();
const appendDistillManifest = vi.fn();
vi.mock("./ipc", () => ({
  ipc: {
    agentVaultSession: async () => ORIGIN,
    captureModelRole: (...a: unknown[]) => captureModelRole(...a),
    publishDistillNote: (...a: unknown[]) => publishDistillNote(...a),
    readFile: (...a: unknown[]) => readFile(...a),
    writeFile: (...a: unknown[]) => writeFile(...a),
    createFolder: (...a: unknown[]) => createFolder(...a),
    listFiles: (...a: unknown[]) => listFiles(...a),
    appendDistillManifest: (...a: unknown[]) => appendDistillManifest(...a),
  },
}));

import { draftMap } from "./maps";
import { sha256 } from "./tidyRun";

beforeEach(() => {
  ORIGIN.openingToken = `synthetic-opening-${++openingSequence}`;
  publishDistillNote.mockReset().mockImplementation(async (_origin, operationId: string, artifact: { key: string }, content: string) => {
    const path = `wiki/maps/${artifact.key}.md`;
    // Synthetic issuer storage hook; production never calls writeFile.
    await writeFile(`/v/${path}`, content);
    return { publicationId: "b".repeat(64), operationId, path, revision: await sha256(content), nativeCreated: true, state: "published",
      fileIdentity: { device: 1, inode: 2, changedSeconds: 3, changedNanoseconds: 4 } };
  });
  captureModelRole.mockReset().mockImplementation(async (origin: AgentVaultSession, role: RoleId, usage: RoleUsage) => {
    expect(origin).toEqual(ORIGIN);
    expect(role).toBe("organization");
    return roleFixture(role, "builtin-local", BUILTIN_CHAT_MODEL, origin, usage);
  });
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
  it("retains the written draft and retries its failed manifest without regenerating", async () => {
    complete.mockResolvedValue("synthetic body");
    readFile.mockRejectedValue(new Error("not found"));
    createFolder.mockResolvedValue("maps");
    writeFile.mockResolvedValue(null);
    appendDistillManifest.mockRejectedValueOnce(new Error("synthetic manifest unavailable"));
    await expect(draftMap("/v", "synthetic-pending-publication", ["wiki/x.md"], "llm-123"))
      .rejects.toMatchObject({ status: "pending", writtenPath: "wiki/maps/synthetic-pending-publication.md" });
    await expect(draftMap("/v", "synthetic-pending-publication", ["wiki/x.md"], "llm-456"))
      .resolves.toBe("wiki/maps/synthetic-pending-publication.md");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(appendDistillManifest).toHaveBeenCalledTimes(2);
    expect(appendDistillManifest.mock.calls[1][1]).toBe("llm-123");
    expect(appendDistillManifest.mock.calls[1][5]).toEqual([{ path: "wiki/maps/synthetic-pending-publication.md",
      revision: await sha256(writeFile.mock.calls[0][1]), created: true }]);
  });
  it("retains the issued capability when proposal finalization must be retried", async () => {
    complete.mockResolvedValue("synthetic body");
    readFile.mockRejectedValue(new Error("ENOENT: no such file or directory"));
    writeFile.mockResolvedValue(null);
    await draftMap("/v", "synthetic-finalization-retry", ["wiki/x.md"], "llm-123");
    await draftMap("/v", "synthetic-finalization-retry", ["wiki/x.md"], "llm-456");
    expect(complete).toHaveBeenCalledOnce();
    expect(publishDistillNote).toHaveBeenCalledOnce();
    expect(appendDistillManifest).toHaveBeenCalledTimes(2);
    expect(appendDistillManifest.mock.calls[1][1]).toBe("llm-123");
    expect(appendDistillManifest.mock.calls[1][6]).toEqual(["b".repeat(64)]);
  });
  it("writes frontmatter + the model's body to wiki/maps/<slug>.md", async () => {
    complete.mockResolvedValue("Overview paragraph.\n\n## Group\n- [[a]] — desc\n");
    readFile.mockRejectedValue(new Error("not found")); // no existing map, no collision
    createFolder.mockResolvedValue("maps");
    writeFile.mockResolvedValue(null);

    const rel = await draftMap("/v", "Attention Mechanisms", ["wiki/a.md", "wiki/b.md"]);

    expect(rel).toBe("wiki/maps/attention-mechanisms.md");
    expect(createFolder).not.toHaveBeenCalled();
    expect(publishDistillNote).toHaveBeenCalledOnce();
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
      ORIGIN,
      [{ path: "wiki/maps/topic.md", revision: await sha256(writeFile.mock.calls[0][1]), created: true }],
      ["b".repeat(64)],
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
      ORIGIN,
      [{ path: "wiki/maps/topic.md", revision: await sha256(writeFile.mock.calls[0][1]), created: true }],
      ["b".repeat(64)],
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

    await expect(draftMap("/v", "topic", ["wiki/x.md"])).rejects.toMatchObject({ status: "pending", code: "unavailable" });

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

  it("preserves an existing map and requires manual recovery without calling complete", async () => {
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

    await expect(draftMap("/v", "topic", ["wiki/x.md"])).rejects.toMatchObject({ status: "pending", code: "unavailable" });
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

    await expect(draftMap("/v", "new-label", ["wiki/old-label.md", "wiki/x.md"]))
      .rejects.toMatchObject({ status: "pending", code: "unavailable" });
    expect(publishDistillNote).not.toHaveBeenCalled();
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

  it("does not begin work when the originating session is already stale", async () => {
    complete.mockResolvedValue("synthetic body");
    readFile.mockRejectedValue(new Error("not found"));
    createFolder.mockResolvedValue("/v/wiki/maps");
    writeFile.mockResolvedValue(null);
    await expect(draftMap("/v", "topic", ["wiki/a.md"], "synthetic-manifest", () => false)).rejects.toThrow("Vault changed; topic map cancelled");
    expect(listFiles).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it.each(["lookup", "generation", "collision", "publish", "manifest"])("stops after a stale %s response without dispatching the next stage", async (stage) => {
    let isCurrent = true;
    let release!: () => void;
    complete.mockResolvedValue("synthetic body");
    readFile.mockRejectedValue(new Error("not found"));
    createFolder.mockResolvedValue("/v/wiki/maps");
    writeFile.mockResolvedValue(null);
    const delayed = <T,>(value: T) => new Promise<T>((resolve) => { release = () => resolve(value); });
    if (stage === "lookup") listFiles.mockImplementationOnce(() => delayed([]));
    if (stage === "generation") complete.mockImplementationOnce(() => delayed("synthetic body"));
    if (stage === "collision") readFile.mockImplementationOnce(() => new Promise((_resolve, reject) => { release = () => reject(new Error("not found")); }));
    if (stage === "publish") publishDistillNote.mockImplementationOnce(async (_origin, operationId, artifact, content) => delayed({ publicationId: "b".repeat(64), operationId, path: `wiki/maps/${artifact.key}.md`, revision: await sha256(content), nativeCreated: true, state: "published", fileIdentity: { device: 1, inode: 2, changedSeconds: 3, changedNanoseconds: 4 } }));
    if (stage === "manifest") appendDistillManifest.mockImplementationOnce(() => delayed(null));
    const pending = draftMap("/v", "topic", ["wiki/a.md"], "synthetic-manifest", () => isCurrent);
    const outcome = expect(pending).rejects.toThrow("Vault changed; topic map cancelled");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    isCurrent = false;
    release();
    await outcome;
    if (stage === "lookup") expect(complete).not.toHaveBeenCalled();
    if (stage === "lookup" || stage === "generation") expect(createFolder).not.toHaveBeenCalled();
    if (stage !== "manifest") expect(writeFile).not.toHaveBeenCalled();
    if (["lookup", "generation", "collision"].includes(stage)) expect(publishDistillNote).not.toHaveBeenCalled();
    if (stage !== "manifest") expect(appendDistillManifest).not.toHaveBeenCalled();
  });
});
