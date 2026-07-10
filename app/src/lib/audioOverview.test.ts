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

import {
  assemblePages,
  formatTranscript,
  generateScript,
  overviewSlug,
  saveTranscript,
  toTurns,
} from "./audioOverview";

beforeEach(() => {
  complete.mockReset();
  readFile.mockReset();
  writeFile.mockReset();
  createFolder.mockReset();
});

describe("toTurns", () => {
  it("keeps valid turns and normalizes speaker + cites", () => {
    const turns = toTurns([
      { speaker: "A", text: "hello", cites: ["[[a]]"] },
      { speaker: "b", text: "hi there" },
      { speaker: "A", text: "" }, // dropped: empty text
      "junk", // dropped
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toEqual({ speaker: "A", text: "hello", cites: ["[[a]]"] });
    expect(turns[1]).toEqual({ speaker: "B", text: "hi there", cites: [] });
  });
});

describe("assemblePages", () => {
  it("concatenates page bodies with citeable headers, bounded by budget", async () => {
    readFile.mockImplementation((p: string) =>
      Promise.resolve({ path: p, raw: "", content: `body of ${p}`, frontmatter: null }),
    );
    const ctx = await assemblePages(["/v/wiki/a.md", "/v/wiki/b.md"], 10_000);
    expect(ctx).toContain("[[a]]");
    expect(ctx).toContain("body of /v/wiki/a.md");
    expect(ctx).toContain("[[b]]");
  });

  it("stops once the budget is exceeded (keeps at least one page)", async () => {
    readFile.mockImplementation((p: string) =>
      Promise.resolve({ path: p, raw: "", content: "x".repeat(50), frontmatter: null }),
    );
    const ctx = await assemblePages(["/v/wiki/a.md", "/v/wiki/b.md"], 20);
    expect(ctx).toContain("[[a]]");
    expect(ctx).not.toContain("[[b]]");
  });
});

describe("formatTranscript", () => {
  it("renders sources and speaker-tagged turns with cites", () => {
    const md = formatTranscript(
      {
        title: "Attention",
        sourcePages: ["/v/wiki/attention.md"],
        turns: [
          { speaker: "A", text: "What is attention?", cites: [] },
          { speaker: "B", text: "A weighted sum.", cites: ["[[attention]]"] },
        ],
      },
      "2026-07-10 09:00",
    );
    expect(md).toContain("# Audio Overview — Attention");
    expect(md).toContain("- [[attention]]"); // source list
    expect(md).toContain("**Host:** What is attention?");
    expect(md).toContain("**Guest:** A weighted sum. [[attention]]");
  });
});

describe("overviewSlug", () => {
  it("slugifies titles", () => {
    expect(overviewSlug("Attention & Scaling!")).toBe("attention-scaling");
    expect(overviewSlug("")).toBe("overview");
  });
});

describe("generateScript", () => {
  it("parses a dialogue JSON array into a script", async () => {
    readFile.mockResolvedValue({ path: "p", raw: "", content: "notes", frontmatter: null });
    complete.mockResolvedValue(
      JSON.stringify([
        { speaker: "A", text: "Intro", cites: ["[[a]]"] },
        { speaker: "B", text: "Detail", cites: [] },
      ]),
    );
    const script = await generateScript("/v", ["/v/wiki/a.md"], "Topic");
    expect(script.title).toBe("Topic");
    expect(script.turns).toHaveLength(2);
    expect(script.sourcePages).toEqual(["/v/wiki/a.md"]);
  });

  it("falls back to a single narrator turn when JSON never parses", async () => {
    readFile.mockResolvedValue({ path: "p", raw: "", content: "notes", frontmatter: null });
    complete.mockResolvedValue("Sorry, here is a plain summary of the notes.");
    const script = await generateScript("/v", ["/v/wiki/a.md"], "Topic");
    expect(script.turns).toHaveLength(1);
    expect(script.turns[0].speaker).toBe("A");
    expect(complete).toHaveBeenCalledTimes(2); // retried once first
  });
});

describe("saveTranscript", () => {
  it("writes audio/<slug>-<date>.md and returns its path", async () => {
    createFolder.mockResolvedValue("audio");
    writeFile.mockResolvedValue(null);
    const path = await saveTranscript(
      "/v",
      { title: "My Topic", sourcePages: [], turns: [{ speaker: "A", text: "hi", cites: [] }] },
      "2026-07-10 09:30",
    );
    expect(path).toBe("/v/audio/my-topic-2026-07-10.md");
    expect(writeFile).toHaveBeenCalledWith(
      "/v/audio/my-topic-2026-07-10.md",
      expect.stringContaining("**Host:** hi"),
    );
  });
});
