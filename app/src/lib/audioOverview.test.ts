import { describe, expect, it, vi, beforeEach } from "vitest";

const complete = vi.fn();
vi.mock("./chat", () => ({ complete: (...a: unknown[]) => complete(...a) }));
const readFile = vi.fn();
const writeFile = vi.fn();
const createFolder = vi.fn();
const agentVaultSession = vi.fn();
const captureModelRole = vi.fn();
const localChatStatus = vi.fn();
const localQuery = vi.fn();
const chatComplete = vi.fn();
const embeddingsStatus = vi.fn();
const semanticSearch = vi.fn();
const readVaultContext = vi.fn();
const audioOverviewBegin = vi.fn();
const audioOverviewGenerate = vi.fn();
const audioOverviewPublish = vi.fn();
const audioOverviewCancel = vi.fn();
vi.mock("./ipc", () => ({
  ipc: {
    readFile: (...a: unknown[]) => readFile(...a),
    writeFile: (...a: unknown[]) => writeFile(...a),
    createFolder: (...a: unknown[]) => createFolder(...a),
    agentVaultSession: (...a: unknown[]) => agentVaultSession(...a),
    captureModelRole: (...a: unknown[]) => captureModelRole(...a),
    localChatStatus: (...a: unknown[]) => localChatStatus(...a),
    localQuery: (...a: unknown[]) => localQuery(...a),
    chatComplete: (...a: unknown[]) => chatComplete(...a),
    embeddingsStatus: (...a: unknown[]) => embeddingsStatus(...a),
    semanticSearch: (...a: unknown[]) => semanticSearch(...a),
    readVaultContext: (...a: unknown[]) => readVaultContext(...a),
    audioOverviewBegin: (...a: unknown[]) => audioOverviewBegin(...a),
    audioOverviewGenerate: (...a: unknown[]) => audioOverviewGenerate(...a),
    audioOverviewPublish: (...a: unknown[]) => audioOverviewPublish(...a),
    audioOverviewCancel: (...a: unknown[]) => audioOverviewCancel(...a),
  },
}));
import { roleFixture } from "./modelRoles.testSupport";
import type { AudioOverviewDraft } from "./ipc";

const origin = { vaultPath: "/v", openingToken: "synthetic-audio-opening" };
const snapshot = roleFixture("audio", undefined, undefined, origin);
const job = { jobId: "synthetic-audio-job", origin };

function nativeDraft(title = "Topic", pages = ["/v/wiki/a.md"]): AudioOverviewDraft {
  return {
    title,
    turns: [
      { speaker: "A", text: "Intro", cites: ["[[a]]"] },
      { speaker: "B", text: "Detail", cites: [] },
    ],
    sourcePages: pages,
    context: { ...job, draftId: "synthetic-audio-draft" },
    coverage: {
      selectedPages: pages, includedPages: pages, omittedPages: [],
      includedBodyRanges: pages.map((path) => ({ path, startByte: 0, endByte: 1 })),
      budgetBytes: 24_000, includedBodiesOnly: true,
    },
  };
}

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
  agentVaultSession.mockReset().mockResolvedValue(origin);
  captureModelRole.mockReset().mockResolvedValue(snapshot);
  localChatStatus.mockReset().mockResolvedValue({ state: "ready" });
  localQuery.mockReset();
  chatComplete.mockReset();
  embeddingsStatus
    .mockReset()
    .mockResolvedValue({ indexed_pages: 0, model: "" });
  semanticSearch
    .mockReset()
    .mockResolvedValue({ hits: [], below_floor: [], floor: 0.42 });
  readVaultContext.mockReset().mockResolvedValue("unselected synthetic note");
  audioOverviewBegin.mockReset().mockResolvedValue(job);
  audioOverviewGenerate.mockReset().mockImplementation(async () =>
    nativeDraft(audioOverviewBegin.mock.calls[0][2], audioOverviewBegin.mock.calls[0][1]));
  audioOverviewPublish.mockReset().mockResolvedValue({
    ...nativeDraft().context,
    path: "/v/audio/my-topic-2026-07-10.md",
    revision: "a".repeat(64),
    state: "persisted",
    error: null,
  });
  audioOverviewCancel.mockReset().mockResolvedValue(true);
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
  it("propagates a selected-page read failure after an earlier page was read", async () => {
    const failure = new Error("synthetic_source_unavailable");
    readFile
      .mockResolvedValueOnce({ content: "first selected source" })
      .mockRejectedValueOnce(failure);
    await expect(assemblePages(["/v/wiki/a.md", "/v/wiki/b.md"])).rejects.toBe(
      failure,
    );
  });

  it.each([
    { pagePaths: [] },
    { pagePaths: ["/v/wiki/a.md"] },
    { pagePaths: ["/v/wiki/a.md", "/v/wiki/b.md"] },
  ])(
    "rejects a selection with no non-empty source bodies: %j",
    async ({ pagePaths }) => {
      readFile.mockResolvedValue({ content: " \n\t " });
      await expect(assemblePages(pagePaths)).rejects.toThrow(
        "non-empty source",
      );
    },
  );

  it("concatenates page bodies with citeable headers, bounded by budget", async () => {
    readFile.mockImplementation((p: string) =>
      Promise.resolve({
        path: p,
        raw: "",
        content: `body of ${p}`,
        frontmatter: null,
      }),
    );
    const ctx = await assemblePages(["/v/wiki/a.md", "/v/wiki/b.md"], 10_000);
    expect(ctx).toContain("[[a]]");
    expect(ctx).toContain("body of /v/wiki/a.md");
    expect(ctx).toContain("[[b]]");
  });

  it("stops once the budget is exceeded (keeps at least one page)", async () => {
    readFile.mockImplementation((p: string) =>
      Promise.resolve({
        path: p,
        raw: "",
        content: "x".repeat(50),
        frontmatter: null,
      }),
    );
    const ctx = await assemblePages(
      ["/v/wiki/a.md", "/v/wiki/b.md", "/v/wiki/c.md"],
      20,
    );
    expect(ctx).toContain("[[a]]");
    expect(ctx).not.toContain("[[b]]");
    expect(ctx).not.toContain("[[c]]");
    expect(readFile.mock.calls.map(([path]) => path)).toEqual([
      "/v/wiki/a.md",
      "/v/wiki/b.md",
    ]);
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
  it("binds one native opening and source job before generation; native owns role capture and repair", async () => {
    const pagePaths = ["/v/wiki/a.md"];
    await generateScript("/v", pagePaths, "Synthetic topic");
    expect(agentVaultSession).toHaveBeenCalledTimes(1);
    expect(audioOverviewBegin).toHaveBeenCalledWith(origin, pagePaths, "Synthetic topic", expect.any(String));
    expect(audioOverviewBegin).toHaveBeenCalledTimes(1);
    expect(audioOverviewGenerate).toHaveBeenCalledWith(job);
    expect(audioOverviewGenerate).toHaveBeenCalledTimes(1);
    expect(captureModelRole).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it.each([
    { ...origin, vaultPath: "/other-synthetic" },
    { ...origin, openingToken: "" },
  ])(
    "refuses an invalid native opening before reading or generating",
    async (invalidOrigin) => {
      agentVaultSession.mockResolvedValue(invalidOrigin);
      await expect(
        generateScript("/v", ["/v/wiki/a.md"], "Topic"),
      ).rejects.toThrow("active vault changed");
      expect(audioOverviewBegin).not.toHaveBeenCalled();
      expect(audioOverviewGenerate).not.toHaveBeenCalled();
      expect(captureModelRole).not.toHaveBeenCalled();
      expect(readFile).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
    },
  );

  it("keeps the admitted page list when the caller changes its array during native begin", async () => {
    const pagePaths = ["/v/wiki/a.md"];
    audioOverviewBegin.mockImplementation(async () => {
      pagePaths.push("/v/wiki/unselected.md");
      return job;
    });
    const script = await generateScript("/v", pagePaths, "Topic");
    expect(script.sourcePages).toEqual(["/v/wiki/a.md"]);
    expect(audioOverviewBegin.mock.calls[0][1]).toEqual(script.sourcePages);
    expect(readFile).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("surfaces a rejected admission before reading source pages", async () => {
    audioOverviewBegin.mockRejectedValue(new Error("role_selection_unavailable"));
    await expect(
      generateScript("/v", ["/v/wiki/a.md"], "Topic"),
    ).rejects.toThrow("source admission failed");
    expect(audioOverviewGenerate).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("keeps the original native job when opening or selected route changes during generation", async () => {
    audioOverviewGenerate.mockImplementation(async () => {
      agentVaultSession.mockResolvedValue({ ...origin, openingToken: "new-opening" });
      captureModelRole.mockResolvedValue(roleFixture("audio", "openai", "unselected-external", origin));
      return nativeDraft();
    });
    await generateScript("/v", ["/v/wiki/a.md"], "Topic");
    expect(agentVaultSession).toHaveBeenCalledTimes(1);
    expect(audioOverviewBegin).toHaveBeenCalledTimes(1);
    expect(audioOverviewGenerate).toHaveBeenCalledWith(job);
    expect(captureModelRole).not.toHaveBeenCalled();
    expect(localQuery).not.toHaveBeenCalled();
    expect(embeddingsStatus).not.toHaveBeenCalled();
    expect(semanticSearch).not.toHaveBeenCalled();
    expect(readVaultContext).not.toHaveBeenCalled();
    expect(chatComplete).not.toHaveBeenCalled();
  });

  it.each(["vault_session_stale", "role_snapshot_revoked"])(
    "surfaces native %s after repair without recapturing or a narrator fallback",
    async (failure) => {
      // The private native executor now owns both attempts and their grant.
      audioOverviewGenerate.mockRejectedValue(new Error(failure));
      await expect(
        generateScript("/v", ["/v/wiki/a.md"], "Topic"),
      ).rejects.toThrow("valid audio dialogue");
      expect(agentVaultSession).toHaveBeenCalledTimes(1);
      expect(audioOverviewBegin).toHaveBeenCalledTimes(1);
      expect(audioOverviewGenerate).toHaveBeenCalledTimes(1);
      expect(audioOverviewGenerate).toHaveBeenCalledWith(job);
      expect(audioOverviewCancel).toHaveBeenCalledWith(job);
      expect(captureModelRole).not.toHaveBeenCalled();
      expect(localQuery).not.toHaveBeenCalled();
      expect(chatComplete).not.toHaveBeenCalled();
    },
  );

  it("accepts the validated native dialogue with its included sources", async () => {
    const script = await generateScript("/v", ["/v/wiki/a.md"], "Topic");
    expect(script.title).toBe("Topic");
    expect(script.turns).toHaveLength(2);
    expect(script.sourcePages).toEqual(["/v/wiki/a.md"]);
  });

  // Raw prose, [] and unusable items cannot satisfy the script's JSON contract.
  it.each([
    ["non-JSON prose", "Synthetic unvalidated narrator prose."],
    ["empty array", "[]"],
    ["no usable turns", '[{"speaker":"A","text":""},"junk",null]'],
  ])(
    "rejects a native %s payload instead of returning a narrator success",
    async (_label, reply) => {
      audioOverviewGenerate.mockResolvedValue(reply);
      await expect(
        generateScript("/v", ["/v/wiki/a.md"], "Topic"),
      ).rejects.toThrow("valid audio dialogue");
      expect(audioOverviewGenerate).toHaveBeenCalledTimes(1);
      expect(audioOverviewCancel).toHaveBeenCalledWith(job);
      expect(complete).not.toHaveBeenCalled();
      expect(agentVaultSession).toHaveBeenCalledTimes(1);
      expect(captureModelRole).not.toHaveBeenCalled();
      expect(readFile).not.toHaveBeenCalled();
      expect(writeFile).not.toHaveBeenCalled();
    },
  );

  it.each(["first selected source", "second selected source"])(
    "does not generate when reading the %s fails",
    async (_failedSource) => {
      const failure = new Error("synthetic_source_unavailable");
      audioOverviewBegin.mockRejectedValue(failure);
      complete.mockResolvedValue(
        '[{"speaker":"A","text":"Invented without the sources"}]',
      );
      await expect(
        generateScript("/v", ["/v/wiki/a.md", "/v/wiki/b.md"], "Topic"),
      ).rejects.toThrow("source admission failed");
      expect(audioOverviewGenerate).not.toHaveBeenCalled();
      expect(readFile).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      expect(writeFile).not.toHaveBeenCalled();
    },
  );

  it.each([
    { pagePaths: [] },
    { pagePaths: ["/v/wiki/a.md"] },
    { pagePaths: ["/v/wiki/a.md", "/v/wiki/b.md"] },
  ])(
    "does not admit invented model output for an empty source selection: %j",
    async ({ pagePaths }) => {
      audioOverviewBegin.mockRejectedValue(new Error("No non-empty source pages are available"));
      complete.mockResolvedValue(
        '[{"speaker":"A","text":"Invented without source text"}]',
      );
      await expect(generateScript("/v", pagePaths, "Topic")).rejects.toThrow(
        "source admission failed",
      );
      expect(audioOverviewGenerate).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      expect(writeFile).not.toHaveBeenCalled();
    },
  );
});

describe("saveTranscript", () => {
  it("publishes the held native draft and returns its begin-bound path", async () => {
    const path = await saveTranscript(
      "/v",
      nativeDraft("My Topic"),
      "2026-07-10 09:30",
    );
    expect(path).toBe("/v/audio/my-topic-2026-07-10.md");
    expect(audioOverviewPublish).toHaveBeenCalledWith(nativeDraft().context);
    expect(createFolder).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });
});
