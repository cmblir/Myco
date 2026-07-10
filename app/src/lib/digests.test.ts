import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Schedule } from "./ipc";

const complete = vi.fn();
vi.mock("./chat", () => ({ complete: (...a: unknown[]) => complete(...a) }));
const gitLog = vi.fn();
const writeFile = vi.fn();
const createFolder = vi.fn();
vi.mock("./ipc", () => ({
  ipc: {
    gitLog: (...a: unknown[]) => gitLog(...a),
    writeFile: (...a: unknown[]) => writeFile(...a),
    createFolder: (...a: unknown[]) => createFolder(...a),
  },
}));

import { buildPrompt, formatDigest, runDigest, digestSlug } from "./digests";

const sched = (over: Partial<Schedule> = {}): Schedule => ({
  id: "s1",
  title: "Weekly Review",
  kind: "query",
  prompt: "What are the open questions?",
  cadence: "weekly:1",
  output_dir: "digests",
  provider: "anthropic-cli",
  model: "sonnet",
  notify: false,
  last_run: null,
  enabled: true,
  ...over,
});

beforeEach(() => {
  complete.mockReset();
  gitLog.mockReset();
  writeFile.mockReset();
  createFolder.mockReset();
});

describe("buildPrompt", () => {
  it("query kind uses the raw prompt", async () => {
    expect(await buildPrompt("/v", sched())).toBe("What are the open questions?");
  });
  it("changed kind folds in git log", async () => {
    gitLog.mockResolvedValue([
      { hash: "a", date: "2026-07-01", subject: "ingest: x", created: 3, modified: 1 },
    ]);
    const p = await buildPrompt("/v", sched({ kind: "changed" }));
    expect(p).toContain("what changed");
    expect(p).toContain("ingest: x");
  });
  it("changed kind tolerates missing git", async () => {
    gitLog.mockRejectedValue(new Error("no git"));
    const p = await buildPrompt("/v", sched({ kind: "changed" }));
    expect(p).toContain("no git history");
  });
  it("topic kind embeds the topic", async () => {
    const p = await buildPrompt("/v", sched({ kind: "topic", prompt: "scaling laws" }));
    expect(p).toContain("scaling laws");
  });
});

describe("formatDigest", () => {
  it("emits frontmatter + heading + body", () => {
    const md = formatDigest(sched(), "The body.", "2026-07-10T09:00:00Z");
    expect(md).toContain("kind: query");
    expect(md).toContain("schedule: s1");
    expect(md).toContain("# Weekly Review");
    expect(md).toContain("The body.");
  });
});

describe("digestSlug", () => {
  it("slugifies", () => {
    expect(digestSlug("Weekly Review!")).toBe("weekly-review");
    expect(digestSlug("")).toBe("digest");
  });
});

describe("runDigest", () => {
  it("generates and writes digests/<date>-<slug>.md", async () => {
    complete.mockResolvedValue("Digest body [[attention-mechanism]].");
    createFolder.mockResolvedValue("digests");
    writeFile.mockResolvedValue(null);
    const path = await runDigest("/v", sched(), "2026-07-10T09:00:00Z");
    expect(path).toBe("/v/digests/2026-07-10-weekly-review.md");
    expect(writeFile).toHaveBeenCalledWith(
      "/v/digests/2026-07-10-weekly-review.md",
      expect.stringContaining("Digest body"),
    );
  });
});
